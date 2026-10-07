'use strict';
/*
 * mock-sourcebuffer.js — 事件顺序完全由测试驱动的 SourceBuffer 替身。
 *
 * - appendBuffer/remove 只记录并置 updating=true，不自动发事件；
 *   事件由测试显式调用 completePending() / fireStray() 触发，顺序可控。
 * - abort() 遵循规范语义：只取消在飞的 append（随后 completePending 会按
 *   规范顺序抛出 abort + updateend）；对 remove 无影响；不在 updating 时不发事件。
 * - mode:'auto' 时原生调用后同步完成（用于搭建前置状态）。
 * - removeEventListener 移除的监听器被保留在 _stale 中，fireStale() 可用来
 *   验证“停止并重建后旧事件彻底失效”。
 */
class MockSourceBuffer {
  constructor(options = {}) {
    this.mode = options.mode || 'manual';
    this.updating = false;
    this.timestampOffset = 0;
    this.appendMode = 'segments';
    this.calls = [];          // 原生调用日志：[name, ...args]
    this.fired = [];          // 已触发事件日志（真实监听器通道）
    this.bufferedRanges = []; // 模拟物理缓冲，仅在“成功提交”时变化
    this.quotaThrowsLeft = 0; // appendBuffer 抛出 QuotaExceededError 的次数
    this._pending = null;     // 在飞原生操作
    this._listeners = new Map();
    this._stale = new Map();  // 已移除的监听器（供 fireStale 使用）
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }

  removeEventListener(type, fn) {
    const set = this._listeners.get(type);
    if (set && set.delete(fn)) {
      if (!this._stale.has(type)) this._stale.set(type, new Set());
      this._stale.get(type).add(fn);
    }
  }

  _emit(type) {
    this.fired.push(type);
    const set = this._listeners.get(type);
    if (set) for (const fn of [...set]) fn({ type });
  }

  /** 模拟已拆除 session 上迟到的旧事件（走已移除的监听器）。 */
  fireStale(type) {
    const set = this._stale.get(type);
    if (set) for (const fn of [...set]) fn({ type });
  }

  /** 触发与任何 op 无关的多余事件。 */
  fireStray(type) {
    this._emit(type);
  }

  appendBuffer(data) {
    this.calls.push(['appendBuffer', data && data.seq !== undefined ? data.seq : '(bytes)']);
    if (this.quotaThrowsLeft > 0) {
      this.quotaThrowsLeft--;
      const err = new Error('buffer full');
      err.name = 'QuotaExceededError';
      throw err;
    }
    if (this.updating) {
      const err = new Error('another update in progress');
      err.name = 'InvalidStateError';
      throw err;
    }
    this.updating = true;
    this._pending = { kind: 'append', data, aborted: false };
    if (this.mode === 'auto') this.completePending();
  }

  remove(start, end) {
    this.calls.push(['remove', start, end]);
    if (this.updating) {
      const err = new Error('another update in progress');
      err.name = 'InvalidStateError';
      throw err;
    }
    this.updating = true;
    this._pending = { kind: 'remove', start, end, aborted: false };
    if (this.mode === 'auto') this.completePending();
  }

  abort() {
    this.calls.push(['abort']);
    // 规范：abort() 只取消在飞的 append；remove 在飞时不得被它“冒充已清理”。
    if (this._pending && this._pending.kind === 'append') this._pending.aborted = true;
  }

  /** 测试驱动：为在飞 op 按规范顺序抛出事件并落账。 */
  completePending() {
    const p = this._pending;
    if (!p) throw new Error('completePending: 没有在飞 op');
    this._pending = null;
    this.updating = false;
    if (p.aborted) {
      this._emit('abort');
      this._emit('updateend');
      return;
    }
    if (p.kind === 'append') this._applyAppend(p.data);
    else this._applyRemove(p.start, p.end);
    this._emit('updateend');
  }

  _applyAppend(data) {
    if (!data || !Array.isArray(data.range)) return;
    this.bufferedRanges.push({ start: data.range[0], end: data.range[1] });
    this.bufferedRanges.sort((a, b) => a.start - b.start);
    // 合并相邻/重叠区间（近似真实 MSE 的 buffered 表现）
    const merged = [];
    for (const r of this.bufferedRanges) {
      const last = merged[merged.length - 1];
      if (last && r.start <= last.end + 0.05) last.end = Math.max(last.end, r.end);
      else merged.push({ start: r.start, end: r.end });
    }
    this.bufferedRanges = merged;
  }

  _applyRemove(start, end) {
    const out = [];
    for (const r of this.bufferedRanges) {
      if (r.end <= start || r.start >= end) { out.push(r); continue; }
      if (r.start < start) out.push({ start: r.start, end: start });
      if (r.end > end) out.push({ start: end, end: r.end });
    }
    this.bufferedRanges = out;
  }
}

module.exports = { MockSourceBuffer };
