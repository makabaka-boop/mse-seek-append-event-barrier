/*
 * coordinator.js — 单 SourceBuffer 的分片追加/删除串行协调器。
 *
 * 只处理固定清单（manifest）与单个视频 SourceBuffer；不管音频、编码切换、
 * DASH/MP4 解析。浏览器与 Node（测试）共用，全部外部依赖通过 opts 注入：
 *
 *   createCoordinator({
 *     manifest,                  // { segments: [{seq, start, end}, ...] }（秒）
 *     loadSegment(seq, signal),  // => Promise<opaque data>，必须响应 abort
 *     getBuffered(),             // => [{start, end}, ...] 真实 buffered 区间
 *     getCurrentTime(),          // => 秒（配额清理时界定“旧播放区间”）
 *     keepBehindSec,             // 配额清理 horizon：currentTime - keepBehindSec
 *     lookahead,                 // ensure() 默认向前调度段数（默认 3）
 *     onSegmentState(seq, state),// fetching/queued/appending/appended/evicted/cancelled/failed
 *     onError({seq, stage, message}),  // stage: fetch/append/append-retry/remove
 *     onLog(msg),
 *   })
 *
 * 不变式：
 *  1. 任一时刻至多一个原生操作在飞（current != null ⇔ 已调用 appendBuffer/remove
 *     且未收到对应 updateend）；下一个原生操作只能由上一个的 updateend 驱动。
 *  2. 追加被 abort() 取消后，该原生操作仍会抛出 abort+updateend 一对事件——它们
 *     只归属被取消的那个 op，绝不能被当成下一个追加的成功。
 *  3. remove 在飞时跳播不得调用 abort() 冒充已清理；remove 只能等真实 updateend。
 *  4. 片段序号的“已完成”标记（appendedSeqs）只在其对应 op 真正成功的 updateend
 *     分支里更新；被取消/过期 epoch 的 updateend 无权触碰。
 *  5. 配额错误：同一追加至多清理一次旧播放区间并重试一次；再失败则上报
 *     {seq, stage}。
 *  6. stop()/换 session 后 epoch 递增、监听器移除，旧事件彻底失效。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MseCoordinator = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const EPS = 1e-3;
  const DEFAULT_LOOKAHEAD = 3;

  function createCoordinator(opts) {
    const manifest = opts.manifest;
    const loadSegment = opts.loadSegment;
    const getBuffered = opts.getBuffered || (() => []);
    const getCurrentTime = opts.getCurrentTime || (() => 0);
    const keepBehindSec = opts.keepBehindSec != null ? opts.keepBehindSec : 2;
    const lookahead = opts.lookahead || DEFAULT_LOOKAHEAD;
    const onSegmentState = opts.onSegmentState || (() => {});
    const onError = opts.onError || (() => {});
    const onLog = opts.onLog || (() => {});

    let session = null; // {id, active, sb, hUpdateEnd, hAbort, hError}
    let sessionSeq = 0;
    let epoch = 0;            // seekTo/stop/startSession 时递增，使旧 op/旧事件失效
    let queue = [];           // 待执行原生 op（append 数据已就绪 / remove）
    let current = null;       // 在飞原生 op
    let fetchQueue = [];      // 待请求片段序号
    let fetching = null;      // {seq, controller, epoch}
    let planned = new Set();  // 已调度未定论的序号（去重用）
    let appendedSeqs = new Set(); // “已完成”账本：只能被真实成功更新
    let states = new Map();   // seq -> 最近上报状态（去重连续重复）
    let idleWaiters = [];
    let playheadSeq = 1;      // 当前播放位置所在段（seekTo/notifyTime 维护）
    let pendingSeekCleanup = null; // 待做的跳播清理：{seq}，等串行锁释放后按最新 buffered 判定

    const maxSeq = manifest.segments.length;
    const segBySeq = (seq) => manifest.segments[seq - 1];
    const log = (m) => onLog(m);

    function setState(seq, state) {
      if (states.get(seq) === state) return;
      states.set(seq, state);
      onSegmentState(seq, state);
    }

    function isIdle() {
      return !fetching && fetchQueue.length === 0 && queue.length === 0 && !current;
    }
    function maybeIdle() {
      if (isIdle() && idleWaiters.length) {
        const w = idleWaiters;
        idleWaiters = [];
        for (const resolve of w) resolve();
      }
    }

    function seqForTime(t) {
      for (const s of manifest.segments) {
        if (t >= s.start - EPS && t < s.end - EPS) return s.seq;
      }
      return t < 0 ? 1 : maxSeq;
    }

    function seqsIntersecting(start, end) {
      const out = [];
      for (const s of manifest.segments) {
        if (s.start < end - EPS && s.end > start + EPS) out.push(s.seq);
      }
      return out;
    }

    // ---- 原生 op 串行泵 ----------------------------------------------------

    function enqueueRemove(start, end, reason) {
      const op = {
        kind: 'remove', start, end, reason,
        clearSeqs: seqsIntersecting(start, end),
        epoch, cancelled: false,
      };
      queue.push(op);
      log(`enqueue remove [${start.toFixed(3)},${end.toFixed(3)}) (${reason})` +
          (op.clearSeqs.length ? ` 将清除完成标记: ${op.clearSeqs.join(',')}` : ''));
    }

    // 跳播清理：目标段区间之外的旧数据一律清除。必须在串行锁空闲、能拿到
    // 最新 buffered 时判定——被取消追加的残余数据要到其 updateend 才落定。
    // 清除 op 插到队首，保证“先处理旧数据，再接续目标段”。
    function maybeSeekCleanup() {
      if (!pendingSeekCleanup || !session || !session.active) return;
      if (current) return; // 原生 op 在飞：等其 updateend 后再按最新 buffered 判定
      const target = segBySeq(pendingSeekCleanup.seq);
      pendingSeekCleanup = null;
      const removes = [];
      for (const r of getBuffered()) {
        const intersectsTarget = r.start < target.end - EPS && r.end > target.start + EPS;
        if (!intersectsTarget) {
          removes.push({
            kind: 'remove', start: r.start, end: r.end, reason: 'seek-stale',
            clearSeqs: seqsIntersecting(r.start, r.end),
            epoch, cancelled: false,
          });
        }
      }
      if (removes.length) {
        queue.unshift(...removes);
        for (const op of removes) {
          log(`跳播清理旧数据 [${op.start.toFixed(3)},${op.end.toFixed(3)})` +
              (op.clearSeqs.length ? ` 将清除完成标记: ${op.clearSeqs.join(',')}` : ''));
        }
      }
    }

    function pump() {
      if (!session || !session.active) return;
      while (!current && queue.length) {
        const op = queue.shift();
        if (op.epoch !== epoch) { // 过期 op：丢弃，不得触碰完成标记
          log(`丢弃过期 op ${op.kind} seq=${op.seq} (op.epoch=${op.epoch}, epoch=${epoch})`);
          continue;
        }
        startOp(op); // 同步抛错（含配额）在内部处理，可能把 op 重新排队
      }
      maybeIdle();
    }

    function startOp(op) {
      const sb = session.sb;
      current = op;
      try {
        if (op.kind === 'append') {
          setState(op.seq, 'appending');
          log(`appendBuffer seq=${op.seq}${op.evicted ? '（配额重试）' : ''}`);
          sb.appendBuffer(op.data);
        } else {
          log(`remove [${op.start.toFixed(3)},${op.end.toFixed(3)}) (${op.reason})`);
          sb.remove(op.start, op.end);
        }
      } catch (err) {
        current = null;
        onSyncError(op, err);
      }
    }

    function isQuotaError(err) {
      return err && (err.name === 'QuotaExceededError' || err.code === 22);
    }

    // 配额清理：只清一次“旧播放区间”（currentTime - keepBehindSec 之前）
    function computeEvictRange() {
      const horizon = getCurrentTime() - keepBehindSec;
      for (const r of getBuffered()) {
        if (r.start < horizon - EPS) {
          return { start: r.start, end: Math.min(r.end, horizon) };
        }
      }
      return null;
    }

    function onSyncError(op, err) {
      if (op.kind === 'append' && isQuotaError(err) && !op.evicted) {
        op.evicted = true; // 至多清理一次、重试一次
        const range = computeEvictRange();
        if (range) {
          log(`seq=${op.seq} 追加配额不足 → 清理旧播放区间 [${range.start.toFixed(3)},${range.end.toFixed(3)}) 后重试一次`);
          const rm = {
            kind: 'remove', start: range.start, end: range.end, reason: 'quota-evict',
            clearSeqs: seqsIntersecting(range.start, range.end),
            epoch, cancelled: false,
          };
          queue.unshift(rm, op); // 同一协调器内串行：先 remove，再重试 append
          setState(op.seq, 'queued');
          return;
        }
        log(`seq=${op.seq} 配额不足但无可清理的旧播放区间`);
      }
      failOp(op, err);
    }

    function failOp(op, err) {
      const stage = op.kind === 'append' ? (op.evicted ? 'append-retry' : 'append') : 'remove';
      const message = String((err && err.message) || err);
      log(`op 失败 seq=${op.seq} stage=${stage}: ${message}`);
      if (op.kind === 'append') {
        planned.delete(op.seq);
        setState(op.seq, 'failed');
      }
      onError({ seq: op.seq, stage, message });
    }

    // ---- SourceBuffer 事件（按 session 绑定，过期 session 直接失效） ----

    function makeHandlers(s) {
      return {
        hUpdateEnd() {
          if (!s.active || session !== s) return; // 旧 session 事件彻底失效
          const op = current;
          current = null;
          if (!op) {
            log('收到无归属的 updateend（忽略）');
            pump();
            return;
          }
          if (op.kind === 'remove') {
            // remove 的物理生效与 epoch 无关：真实提交才更新账本；
            // 被取消/过期的 remove 不会走到这里（remove 不可 abort，只会真实完成）。
            for (const seq of op.clearSeqs) {
              appendedSeqs.delete(seq);
              planned.delete(seq);
              setState(seq, 'evicted');
            }
            log(`remove [${op.start.toFixed(3)},${op.end.toFixed(3)}) 提交` +
                (op.clearSeqs.length ? `，完成标记已清除: ${op.clearSeqs.join(',')}` : ''));
            if (op.clearSeqs.includes(playheadSeq)) {
              log('清理区间覆盖当前播放位置所需段 → 重新调度');
              ensure(playheadSeq, lookahead);
            }
            maybeSeekCleanup();
            pump();
            return;
          }
          if (op.epoch !== epoch || op.cancelled) {
            // abort() 之后的 updateend / 过期 op 的 updateend：是被取消追加的残骸，
            // 不是任何追加的成功，无权更新完成标记
            log(`消化已取消/过期追加的 updateend（seq=${op.seq}, op.epoch=${op.epoch}, epoch=${epoch}）——不计成功`);
            setState(op.seq, 'cancelled');
            maybeSeekCleanup();
            pump();
            return;
          }
          // 真正成功：唯有这里允许给片段序号置完成标记
          appendedSeqs.add(op.seq);
          planned.delete(op.seq);
          setState(op.seq, 'appended');
          log(`seq=${op.seq} 追加提交，完成标记已更新`);
          maybeSeekCleanup();
          pump();
        },
        hAbort() {
          if (!s.active || session !== s) return;
          // abort 事件只是取消流程的中间态；结论由随后的 updateend 给出
          log(`收到 abort 事件（属于被取消的 ${current ? current.kind + ' seq=' + current.seq : '未知 op'}）`);
        },
        hError() {
          if (!s.active || session !== s) return;
          const op = current;
          current = null;
          if (op) failOp(op, new Error('SourceBuffer error 事件'));
          pump();
        },
      };
    }

    // ---- 取数泵（与原生 op 泵分离；一次一个请求，可受控延迟由 loadSegment 实现） ----

    function pumpFetch() {
      if (!session || !session.active) return;
      while (!fetching && fetchQueue.length) {
        const seq = fetchQueue.shift();
        if (appendedSeqs.has(seq)) { planned.delete(seq); continue; }
        const controller = new AbortController();
        const f = { seq, controller, epoch };
        fetching = f;
        setState(seq, 'fetching');
        log(`请求片段 seq=${seq}`);
        Promise.resolve()
          .then(() => loadSegment(seq, controller.signal))
          .then(
            (data) => onFetchDone(f, data),
            (err) => onFetchFail(f, err),
          );
      }
      maybeIdle();
    }

    function onFetchDone(f, data) {
      if (fetching === f) fetching = null;
      if (!session || !session.active || f.epoch !== epoch) {
        log(`丢弃过期请求结果 seq=${f.seq}（f.epoch=${f.epoch}, epoch=${epoch}）`);
        pumpFetch();
        return;
      }
      if (appendedSeqs.has(f.seq)) {
        planned.delete(f.seq);
        pumpFetch();
        return;
      }
      queue.push({ kind: 'append', seq: f.seq, data, epoch: f.epoch, evicted: false, cancelled: false });
      setState(f.seq, 'queued');
      log(`seq=${f.seq} 数据就绪，已入追加队列`);
      pumpFetch();
      pump();
    }

    function onFetchFail(f, err) {
      if (fetching === f) fetching = null;
      const aborted = f.controller.signal.aborted || (err && err.name === 'AbortError');
      if (aborted) {
        log(`请求被撤销 seq=${f.seq}`);
      } else if (session && session.active && f.epoch === epoch) {
        planned.delete(f.seq);
        setState(f.seq, 'failed');
        onError({ seq: f.seq, stage: 'fetch', message: String((err && err.message) || err) });
      }
      pumpFetch();
      maybeIdle();
    }

    // ---- 公共 API ----------------------------------------------------------

    function startSession(sb) {
      if (session) stop();
      epoch++;
      sessionSeq++;
      const s = { id: sessionSeq, active: true, sb };
      Object.assign(s, makeHandlers(s));
      session = s;
      planned.clear();
      appendedSeqs.clear();
      queue.length = 0;
      fetchQueue.length = 0;
      current = null;
      fetching = null;
      playheadSeq = 1;
      pendingSeekCleanup = null;
      try { sb.timestampOffset = 0; } catch (_) { /* 片段自带绝对时间戳 */ }
      try { sb.appendMode = 'segments'; } catch (_) { /* 旧实现无 appendMode */ }
      sb.addEventListener('updateend', s.hUpdateEnd);
      sb.addEventListener('abort', s.hAbort);
      sb.addEventListener('error', s.hError);
      log(`session ${s.id} 开始（epoch=${epoch}），timestampOffset=0，片段自带绝对时间戳`);
      maybeIdle();
      return s.id;
    }

    function stop() {
      if (!session) return;
      const s = session;
      log(`stop()：session ${s.id} 拆除，旧事件失效`);
      epoch++;
      fetchQueue.length = 0;
      if (fetching) { fetching.controller.abort(); fetching = null; }
      queue.length = 0;
      // 仅追加可 abort；remove 在飞也只能等它自己的事件，但 session 已死，事件无人接收
      if (current && current.kind === 'append' && s.sb && s.sb.updating) {
        try { s.sb.abort(); } catch (_) { /* 拆除期忽略 */ }
      }
      current = null;
      session = null;
      s.active = false;
      pendingSeekCleanup = null;
      if (s.sb) {
        s.sb.removeEventListener('updateend', s.hUpdateEnd);
        s.sb.removeEventListener('abort', s.hAbort);
        s.sb.removeEventListener('error', s.hError);
      }
      planned.clear();
      appendedSeqs.clear();
      maybeIdle();
    }

    function appendInit(data) {
      if (!session || !session.active) return;
      queue.push({ kind: 'append', seq: 0, isInit: true, data, epoch, evicted: false, cancelled: false });
      log('初始化段已入追加队列');
      pump();
    }

    function ensure(fromSeq, count) {
      if (!session || !session.active) return;
      const n = count || lookahead;
      const to = Math.min(fromSeq + n - 1, maxSeq);
      for (let seq = fromSeq; seq <= to; seq++) {
        if (appendedSeqs.has(seq) || planned.has(seq)) continue;
        planned.add(seq);
        fetchQueue.push(seq);
        setState(seq, 'queued');
      }
      pumpFetch();
    }

    function notifyTime(t) {
      if (!session || !session.active) return;
      playheadSeq = seqForTime(t);
      ensure(playheadSeq, lookahead);
    }

    function seekTo(time) {
      if (!session || !session.active) return;
      epoch++;
      const targetSeq = seqForTime(time);
      playheadSeq = targetSeq;
      log(`seekTo(${time.toFixed(3)}) → 目标段 seq=${targetSeq}，epoch=${epoch}`);

      // 1) 撤销旧请求与排队片段
      fetchQueue.length = 0;
      if (fetching) {
        log(`撤销在飞请求 seq=${fetching.seq}`);
        fetching.controller.abort();
        fetching = null;
      }
      for (const op of queue) {
        if (op.kind === 'append') setState(op.seq, 'cancelled');
      }
      queue.length = 0;
      for (const seq of planned) setState(seq, 'cancelled');
      planned.clear();

      // 2) 在飞原生操作：追加可 abort（其 abort/updateend 仍归它自己）；
      //    remove 在飞时不得用 abort 冒充已清理，只能等真实 updateend。
      if (current) {
        if (current.kind === 'append') {
          current.cancelled = true;
          if (session.sb.updating) {
            log(`abort() 取消在飞追加 seq=${current.seq}（其 abort/updateend 仍归该 op 消化）`);
            session.sb.abort();
          }
        } else {
          log(`remove [${current.start.toFixed(3)},${current.end.toFixed(3)}) 在飞——不 abort，等待真实 updateend`);
        }
      }

      // 3) 已进入 SourceBuffer 的旧数据：等串行锁空闲后按最新 buffered 清除，
      //    然后才接续目标段（remove 排在目标段追加之前）
      pendingSeekCleanup = { seq: targetSeq };
      maybeSeekCleanup();

      // 4) 接续目标段
      ensure(targetSeq, lookahead);
      pump();
    }

    function whenIdle() {
      return new Promise((resolve) => {
        if (isIdle()) resolve();
        else idleWaiters.push(resolve);
      });
    }

    function snapshot() {
      return {
        epoch,
        session: session ? session.id : null,
        current: current ? { kind: current.kind, seq: current.seq, epoch: current.epoch, cancelled: !!current.cancelled } : null,
        queue: queue.map((op) => ({ kind: op.kind, seq: op.seq, epoch: op.epoch })),
        fetching: fetching ? fetching.seq : null,
        fetchQueue: fetchQueue.slice(),
        planned: [...planned].sort((a, b) => a - b),
        appended: [...appendedSeqs].sort((a, b) => a - b),
      };
    }

    return {
      startSession, stop, appendInit, ensure, notifyTime, seekTo, whenIdle,
      requestRemove: (start, end, reason) => { enqueueRemove(start, end, reason || 'external'); pump(); },
      isAppended: (seq) => appendedSeqs.has(seq),
      getEpoch: () => epoch,
      snapshot,
    };
  }

  return { createCoordinator, EPS };
});
