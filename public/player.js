/*
 * player.js — 页面胶水：固定清单 + 单视频 SourceBuffer。
 * 可播放标记只依据 video.buffered（真实缓冲区间），协调器账本仅作对照展示。
 */
/* global MseCoordinator */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const video = $('video');
  const logEl = $('log');
  const errEl = $('err');

  let manifest = null;
  let initBytes = null;
  let coord = null;
  let ms = null;
  let sb = null;
  let objectUrl = null;
  const ledger = new Map(); // seq -> 协调器账本状态（仅展示）

  // ---- 日志与错误 ----------------------------------------------------------

  function logLine(msg, isErr) {
    const time = (performance.now() / 1000).toFixed(3).padStart(8);
    const line = document.createElement('div');
    if (isErr) line.className = 'err';
    line.textContent = `[${time}] ${msg}`;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function showError(e) {
    errEl.style.display = 'block';
    errEl.textContent = `段 ${e.seq} @ ${e.stage}: ${e.message}`;
    logLine(`错误 段${e.seq} @ ${e.stage}: ${e.message}`, true);
  }

  function clearError() {
    errEl.style.display = 'none';
    errEl.textContent = '';
  }

  // ---- 片段请求（可受控延迟） ----------------------------------------------

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new DOMException('aborted', 'AbortError'));
        });
      }
    });
  }

  async function loadSegment(seq, signal) {
    const delay = Math.max(0, Number($('delay').value) || 0);
    const seg = manifest.segments[seq - 1];
    const [resp] = await Promise.all([
      fetch('media/' + seg.url, { signal }),
      sleep(delay, signal), // 人为延迟：模拟慢网络，便于复现跳播交错
    ]);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return new Uint8Array(await resp.arrayBuffer());
  }

  // ---- 真实 buffered（可播放标记的唯一依据） --------------------------------

  function bufferedRanges() {
    const out = [];
    for (let i = 0; i < video.buffered.length; i++) {
      out.push({ start: video.buffered.start(i), end: video.buffered.end(i) });
    }
    return out;
  }

  function renderMarkers() {
    if (!manifest) return;
    const ranges = bufferedRanges();
    const ledgerRow = $('ledger');
    const playRow = $('playable');
    for (const seg of manifest.segments) {
      const playable = ranges.some(
        (r) => r.start <= seg.start + 0.05 && r.end >= seg.end - 0.05,
      );
      const pCell = playRow.cells[seg.seq];
      pCell.className = playable ? 'playable' : 'notplayable';
      pCell.textContent = playable ? '可播放' : '—';
      ledgerRow.cells[seg.seq].textContent = ledger.get(seg.seq) || '·';
    }
    const bar = $('bufbar');
    bar.textContent = '';
    const dur = manifest.segments[manifest.segments.length - 1].end;
    for (const r of ranges) {
      const div = document.createElement('div');
      div.style.left = `${(r.start / dur) * 100}%`;
      div.style.width = `${((r.end - r.start) / dur) * 100}%`;
      bar.appendChild(div);
    }
    const cur = document.createElement('i');
    cur.style.left = `${(video.currentTime / dur) * 100}%`;
    bar.appendChild(cur);
    $('buftext').textContent =
      `buffered: ${ranges.map((r) => `[${r.start.toFixed(2)}, ${r.end.toFixed(2)})`).join(' ') || '(空)'}` +
      `  currentTime: ${video.currentTime.toFixed(2)}`;
  }

  // ---- MediaSource 生命周期 -------------------------------------------------

  function openSession() {
    closeSession();
    clearError();
    ledger.clear();
    ms = new MediaSource();
    objectUrl = URL.createObjectURL(ms);
    video.src = objectUrl;
    ms.addEventListener('sourceopen', () => {
      ms.duration = manifest.segments[manifest.segments.length - 1].end; // 已知总时长，否则 seek 会被钳制
      sb = ms.addSourceBuffer(manifest.mimeType);
      coord.startSession(sb);
      coord.appendInit(initBytes);
      coord.ensure(1, 3);
      video.play().catch(() => { /* 用户手势前自动播放可能被拒 */ });
    }, { once: true });
  }

  function closeSession() {
    if (coord) coord.stop();
    try { video.pause(); } catch (_) { /* 忽略 */ }
    video.removeAttribute('src');
    video.load();
    if (ms && ms.readyState === 'open') {
      try { ms.endOfStream(); } catch (_) { /* 忽略 */ }
    }
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    ms = null;
    sb = null;
    objectUrl = null;
  }

  // ---- 初始化 ---------------------------------------------------------------

  async function init() {
    manifest = await (await fetch('media/manifest.json')).json();
    const supported = window.MediaSource && MediaSource.isTypeSupported(manifest.mimeType);
    $('mime').textContent = supported
      ? `(${manifest.mimeType} ✓)`
      : `(${manifest.mimeType} ✗ 当前浏览器不支持)`;
    if (!supported) {
      showError({ seq: '-', stage: 'init', message: `MSE 不支持 ${manifest.mimeType}` });
      return;
    }
    initBytes = new Uint8Array(await (await fetch('media/' + manifest.init)).arrayBuffer());

    coord = MseCoordinator.createCoordinator({
      manifest,
      keepBehindSec: 2,
      lookahead: 3,
      loadSegment,
      getBuffered: bufferedRanges,
      getCurrentTime: () => video.currentTime,
      onSegmentState: (seq, state) => {
        ledger.set(seq, state);
        renderMarkers();
        // 全部段都已提交 → 结束流，让元素能到达 ended
        if (
          ms && ms.readyState === 'open' &&
          manifest.segments.every((s) => coord.isAppended(s.seq))
        ) {
          try { ms.endOfStream(); } catch (_) { /* 忽略 */ }
        }
      },
      onError: showError,
      onLog: (m) => logLine(m),
    });

    // 段表与跳播按钮
    const ledgerRow = $('ledger');
    const playRow = $('playable');
    for (const seg of manifest.segments) {
      ledgerRow.insertCell().textContent = '·';
      playRow.insertCell().className = 'notplayable';
      const btn = document.createElement('button');
      btn.textContent = `段${seg.seq} (${seg.start}s)`;
      btn.addEventListener('click', () => { video.currentTime = seg.start + 0.01; });
      $('seekrow').appendChild(btn);
    }

    $('start').addEventListener('click', openSession);
    $('stop').addEventListener('click', closeSession);
    $('rebuild').addEventListener('click', openSession);

    video.addEventListener('seeking', () => {
      if (sb) coord.seekTo(video.currentTime);
    });
    video.addEventListener('timeupdate', () => coord.notifyTime(video.currentTime));
    video.addEventListener('error', () => {
      if (video.error) logLine(`video 元素错误: code=${video.error.code}`, true);
    });

    setInterval(renderMarkers, 250);
    renderMarkers();
    logLine('就绪：清单与初始化段已加载');
  }

  init().catch((e) => showError({ seq: '-', stage: 'init', message: e.message }));
})();
