'use strict';
/*
 * coordinator.test.js — 用事件顺序可控的 SourceBuffer 替身验证：
 * 追加/删除串行、追加取消后 abort+updateend 的归属、remove 在飞时跳播、
 * 配额单次清理重试、停止重建后旧事件失效、完成标记只随真实成功更新。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const MseCoordinator = require('../public/coordinator.js');
const { MockSourceBuffer } = require('./mock-sourcebuffer.js');

const MANIFEST = {
  segments: [1, 2, 3, 4, 5, 6].map((i) => ({ seq: i, start: i - 1, end: i })),
};

const tick = () => new Promise((r) => setTimeout(r, 0));

function makeHarness(opts = {}) {
  const mock = new MockSourceBuffer({ mode: opts.mode || 'manual' });
  const h = {
    mock,
    log: [],
    errors: [],
    segStates: [],
    pendingFetches: [],
    now: opts.now != null ? opts.now : 0,
  };
  h.dataFor = (seq) => ({ seq, range: [seq - 1, seq] });
  h.coord = MseCoordinator.createCoordinator({
    manifest: MANIFEST,
    keepBehindSec: 2,
    lookahead: 3,
    getBuffered: () => mock.bufferedRanges,
    getCurrentTime: () => h.now,
    loadSegment: (seq, signal) =>
      new Promise((resolve, reject) => h.pendingFetches.push({ seq, signal, resolve, reject })),
    onSegmentState: (seq, state) => h.segStates.push([seq, state]),
    onError: (e) => h.errors.push(e),
    onLog: (m) => h.log.push(m),
  });
  h.resolveFetch = (seq) => {
    const i = h.pendingFetches.findIndex((f) => f.seq === seq);
    assert.ok(i >= 0, `没有 seq=${seq} 的在飞请求`);
    const [f] = h.pendingFetches.splice(i, 1);
    f.resolve(h.dataFor(seq));
  };
  h.statesFor = (seq) => h.segStates.filter(([s]) => s === seq).map(([, st]) => st);
  h.callsOf = (name) => mock.calls.filter((c) => c[0] === name);
  return h;
}

/** 驱动所有在飞请求与原生 op 直至协调器空闲。 */
async function settleAll(h) {
  for (let i = 0; i < 80; i++) {
    await tick(); // 先让微任务（请求启动/完成回调）落地再判断
    if (h.pendingFetches.length) { h.resolveFetch(h.pendingFetches[0].seq); continue; }
    if (h.mock.updating) { h.mock.completePending(); continue; }
    break;
  }
  await Promise.race([
    h.coord.whenIdle(),
    new Promise((_, rej) => setTimeout(() => rej(new Error('settleAll 超时：协调器未空闲')), 3000)),
  ]);
}

test('追加与 remove 经同一协调器串行执行', async () => {
  const h = makeHarness();
  h.coord.startSession(h.mock);
  h.coord.ensure(1, 1);
  await tick();
  h.resolveFetch(1);
  await tick();
  assert.deepEqual(h.callsOf('appendBuffer'), [['appendBuffer', 1]]);
  assert.equal(h.mock.updating, true);

  h.coord.requestRemove(5, 6, 'test');
  assert.equal(h.callsOf('remove').length, 0, 'append 在飞时 remove 不得开始');

  h.mock.completePending(); // append seq1 的 updateend
  await tick();
  assert.deepEqual(h.callsOf('remove'), [['remove', 5, 6]], 'updateend 后才串行启动 remove');
  h.mock.completePending();
  await h.coord.whenIdle();
  assert.ok(h.coord.isAppended(1));
  assert.deepEqual(h.errors, []);
});

test('被取消追加的 abort/updateend 不会误报为下一片段成功', async () => {
  const h = makeHarness();
  h.coord.startSession(h.mock);
  h.coord.ensure(1, 2);
  await tick();
  h.resolveFetch(1);
  await tick();
  assert.deepEqual(h.callsOf('appendBuffer'), [['appendBuffer', 1]]);

  h.coord.seekTo(4.0); // 目标段 seq=5
  assert.deepEqual(h.callsOf('abort'), [['abort']], '在飞追加应被 abort');
  assert.equal(h.callsOf('appendBuffer').length, 1, '旧 op 事件未消化前不得开始新追加');
  assert.equal(h.callsOf('remove').length, 0, '无旧 buffered 数据时不应有 remove');

  // 被撤销的旧请求迟到完成：必须被丢弃
  h.resolveFetch(2);
  await tick();
  assert.equal(h.callsOf('appendBuffer').length, 1, '过期请求结果不得入队');

  // 被取消追加的 abort+updateend 现在到达：只能结算 seq1，不能算 seq5 成功
  h.mock.completePending();
  await tick();
  assert.deepEqual(h.mock.fired.slice(0, 2), ['abort', 'updateend']);
  assert.ok(!h.coord.isAppended(1), '被取消的追加不得置完成标记');
  assert.ok(h.statesFor(1).includes('cancelled'));
  assert.ok(!h.statesFor(1).includes('appended'));

  // 目标段接续
  h.resolveFetch(5);
  await tick();
  assert.deepEqual(h.callsOf('appendBuffer'), [['appendBuffer', 1], ['appendBuffer', 5]]);
  assert.ok(!h.coord.isAppended(5), 'seq5 的真实 updateend 未到，不得置完成标记');
  h.mock.completePending();
  await tick();
  assert.ok(h.coord.isAppended(5), '真实成功后才更新完成标记');

  await settleAll(h);
  assert.deepEqual(h.errors, []);
});

test('remove 在飞时跳播不得用 abort 冒充已清理', async () => {
  const h = makeHarness();
  h.coord.startSession(h.mock);
  h.coord.ensure(1, 2);
  await settleAll(h);
  assert.deepEqual(h.mock.bufferedRanges, [{ start: 0, end: 2 }]);

  h.coord.requestRemove(0, 1, 'test');
  assert.deepEqual(h.callsOf('remove'), [['remove', 0, 1]]);
  assert.equal(h.mock.updating, true);

  h.coord.seekTo(4.0);
  assert.equal(h.callsOf('abort').length, 0, 'remove 在飞时不得 abort');
  assert.equal(h.callsOf('appendBuffer').length, 2, 'remove 未完成前不得开始新追加');

  h.mock.completePending(); // remove [0,1) 真实提交
  await tick();
  assert.ok(h.statesFor(1).includes('evicted'), 'remove 真实成功后才清除完成标记');
  assert.ok(!h.coord.isAppended(1));

  await settleAll(h);
  const removeCalls = h.callsOf('remove');
  assert.deepEqual(removeCalls[0], ['remove', 0, 1]);
  assert.deepEqual(removeCalls[1], ['remove', 1, 2], '跳播应清除剩余旧数据');
  assert.ok(h.coord.isAppended(5) && h.coord.isAppended(6), '旧数据处理后接续目标段');
  assert.deepEqual(h.mock.bufferedRanges, [{ start: 4, end: 6 }]);
  assert.deepEqual(h.errors, []);
});

test('配额错误：清理一次旧播放区间后重试成功', async () => {
  const h = makeHarness({ now: 5 });
  h.coord.startSession(h.mock);
  h.coord.ensure(1, 4);
  await settleAll(h);
  assert.deepEqual(h.mock.bufferedRanges, [{ start: 0, end: 4 }]);

  h.coord.notifyTime(4.5); // 播放头进入段5 → 调度 5、6
  await tick();
  h.mock.quotaThrowsLeft = 1;
  h.resolveFetch(5);
  await tick();
  assert.deepEqual(h.callsOf('remove'), [['remove', 0, 3]], '配额后应清理旧播放区间（播放头 5 - keepBehind 2）');
  h.mock.completePending(); // remove 提交
  await tick();
  assert.deepEqual(h.callsOf('appendBuffer').at(-1), ['appendBuffer', 5], '清理后重试同一追加');
  h.mock.completePending(); // 重试成功
  await tick();
  assert.ok(h.coord.isAppended(5));
  assert.ok(h.statesFor(1).includes('evicted') && h.statesFor(3).includes('evicted'));
  assert.ok(h.coord.isAppended(4), '清理范围外的段不受影响');

  h.resolveFetch(6); // 后续段不再受配额影响
  await settleAll(h);
  assert.ok(h.coord.isAppended(6));
  assert.deepEqual(h.errors, []);
});

test('配额重试仍失败：只清理一次，上报具体段与阶段', async () => {
  const h = makeHarness({ now: 5 });
  h.coord.startSession(h.mock);
  h.coord.ensure(1, 4);
  await settleAll(h);

  h.coord.notifyTime(4.5); // 播放头进入段5 → 调度 5、6
  await tick();
  h.mock.quotaThrowsLeft = 2; // 首次追加与重试都抛配额
  h.resolveFetch(5);
  await tick();
  assert.deepEqual(h.callsOf('remove'), [['remove', 0, 3]], '清理旧播放区间 [0,3)');
  h.mock.completePending(); // remove 提交 → 重试 seq5 → 再次配额 → 失败
  await tick();
  assert.equal(h.callsOf('remove').length, 1, '同一追加至多清理一次');
  assert.equal(h.errors.length, 1);
  assert.equal(h.errors[0].seq, 5);
  assert.equal(h.errors[0].stage, 'append-retry');
  assert.match(h.errors[0].message, /buffer full/);
  assert.ok(h.statesFor(5).includes('failed'));
  assert.ok(!h.coord.isAppended(5));

  h.resolveFetch(6); // 其它片段不受牵连
  await settleAll(h);
  assert.ok(h.coord.isAppended(6));
  assert.equal(h.errors.length, 1);
});

test('停止并重建后旧事件彻底失效', async () => {
  const h = makeHarness();
  const mockA = h.mock;
  h.coord.startSession(mockA);
  h.coord.ensure(1, 1);
  await tick();
  h.resolveFetch(1);
  await tick();
  assert.deepEqual(h.callsOf('appendBuffer'), [['appendBuffer', 1]]);

  h.coord.stop();
  assert.deepEqual(h.callsOf('abort'), [['abort']], '停止时取消在飞追加');

  const mockB = new MockSourceBuffer();
  h.mock = mockB;
  h.coord.startSession(mockB);
  h.coord.ensure(1, 1);
  await tick();
  h.resolveFetch(1);
  await tick();

  // 旧 session 的原生事件迟到到达：走已移除监听器与残留引用两条路都必须无效
  mockA.completePending();
  mockA.fireStale('updateend');
  mockA.fireStale('abort');
  await tick();
  assert.deepEqual(mockB.calls, [['appendBuffer', 1]], '旧事件不得影响新 session');
  assert.deepEqual(h.errors, []);
  assert.ok(!h.coord.isAppended(1), '旧事件不得更新完成标记');

  mockB.completePending();
  await tick();
  assert.ok(h.coord.isAppended(1));

  // 空闲时的多余事件：无害
  mockB.fireStray('updateend');
  await h.coord.whenIdle();
  assert.ok(h.coord.isAppended(1));
  assert.deepEqual(h.errors, []);
});

test('跳播撤销旧请求与排队片段，清理旧数据后接续目标段', async () => {
  const h = makeHarness();
  h.coord.startSession(h.mock);
  h.coord.ensure(1, 3);
  await settleAll(h);
  assert.deepEqual(h.mock.bufferedRanges, [{ start: 0, end: 3 }]);

  h.coord.seekTo(4.0);
  // 先清理已进入 SourceBuffer 的旧数据，再接续目标段
  assert.deepEqual(h.callsOf('remove'), [['remove', 0, 3]]);
  assert.equal(h.callsOf('appendBuffer').length, 3, 'remove 提交前不得追加目标段');

  await settleAll(h);
  const kinds = h.mock.calls.map((c) => c[0]);
  assert.ok(kinds.indexOf('remove') < kinds.lastIndexOf('appendBuffer'));
  assert.deepEqual(h.mock.bufferedRanges, [{ start: 4, end: 6 }]);
  for (const seq of [1, 2, 3]) assert.ok(!h.coord.isAppended(seq), `seq${seq} 完成标记应已清除`);
  assert.ok(h.coord.isAppended(5) && h.coord.isAppended(6));
  assert.deepEqual(h.errors, []);
});

test('重复 ensure 不重复调度同一片段', async () => {
  const h = makeHarness();
  h.coord.startSession(h.mock);
  h.coord.ensure(1, 3);
  h.coord.ensure(1, 3);
  h.coord.ensure(2, 2);
  await tick();
  const seqs = [...h.pendingFetches.map((f) => f.seq), ...h.coord.snapshot().fetchQueue].sort();
  assert.deepEqual(seqs, [1, 2, 3]);
  await settleAll(h);
  assert.equal(h.callsOf('appendBuffer').length, 3);
  assert.deepEqual(h.errors, []);
});

test('seek 到已缓冲段：无 remove，直接复用并向前接续', async () => {
  const h = makeHarness();
  h.coord.startSession(h.mock);
  h.coord.ensure(1, 3);
  await settleAll(h);

  h.coord.seekTo(1.5); // 目标段 seq=2，[0,3) 与之相交
  assert.equal(h.callsOf('remove').length, 0);
  await settleAll(h);
  assert.ok(h.coord.isAppended(1) && h.coord.isAppended(2) && h.coord.isAppended(3));
  assert.ok(h.coord.isAppended(4), '从目标段继续向前接续');
  assert.deepEqual(h.errors, []);
});

test('初始化段经同一队列追加，随后媒体段正常', async () => {
  const h = makeHarness();
  h.coord.startSession(h.mock);
  h.coord.appendInit({ seq: 0, range: null });
  assert.deepEqual(h.callsOf('appendBuffer'), [['appendBuffer', 0]]);
  h.mock.completePending();
  h.coord.ensure(1, 1);
  await settleAll(h);
  assert.deepEqual(h.callsOf('appendBuffer').map((c) => c[1]), [0, 1]);
  assert.ok(h.coord.isAppended(1));
});
