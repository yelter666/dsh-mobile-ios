// ring.mjs — 每任务独立 seq + 环缓冲（GW-6）
// 契约要点：
//   1. seq 是"每条任务各自单调递增"，不是全局序号；
//   2. 断线续传靠 since/游标，缺口不能"猜"，要么补帧要么明说下界；
//   3. 网关不持业务状态，这里只存"已发生的事实"，任务真相仍在宿主。

const DEFAULT_CAPACITY = 2000;
const DEFAULT_TOTAL_CAPACITY = 20000;

export class EventLog {
  constructor({ capacity = DEFAULT_CAPACITY, totalCapacity = DEFAULT_TOTAL_CAPACITY } = {}) {
    this.capacity = capacity;
    this.totalCapacity = totalCapacity;
    this.tasks = new Map(); // taskId -> { seq, frames: [], dropped: 0 }
    this.total = 0;
    this.listeners = new Set();
  }

  #bucket(taskId) {
    let b = this.tasks.get(taskId);
    if (!b) {
      b = { seq: 0, frames: [], dropped: 0 };
      this.tasks.set(taskId, b);
    }
    return b;
  }

  /** 追加一条事件并分配 seq；返回最终封套（不做任何内容改写） */
  append({ taskId, kind, data, at }) {
    if (!taskId) throw new Error('append 需要 taskId');
    const b = this.#bucket(taskId);
    b.seq += 1;
    const frame = {
      t: 'ev',
      seq: b.seq,
      taskId,
      kind,
      at: at || new Date().toISOString(),
      data: data ?? {},
    };
    b.frames.push(frame);
    this.total += 1;
    if (b.frames.length > this.capacity) {
      b.frames.shift();
      b.dropped += 1;
      this.total -= 1;
    }
    // 全局兜底：任务数异常增长时不至于吃满内存
    while (this.total > this.totalCapacity) {
      const oldest = this.#oldestTask();
      if (!oldest) break;
      this.tasks.get(oldest).frames.shift();
      this.tasks.get(oldest).dropped += 1;
      this.total -= 1;
    }
    for (const fn of this.listeners) fn(frame);
    return frame;
  }

  #oldestTask() {
    let target = null;
    let minSeq = Infinity;
    for (const [taskId, b] of this.tasks) {
      if (!b.frames.length) continue;
      if (b.frames[0].seq < minSeq) {
        minSeq = b.frames[0].seq;
        target = taskId;
      }
    }
    return target;
  }

  maxSeq(taskId) {
    return this.tasks.get(taskId)?.seq ?? 0;
  }

  lowerBound(taskId) {
    const b = this.tasks.get(taskId);
    if (!b || !b.frames.length) return this.maxSeq(taskId) + 1;
    return b.frames[0].seq;
  }

  /**
   * 计算续传结果。
   * @param {{lastSeq?:number, cursors?:Record<string,number>}} req
   * @returns {{frames:Array, resumeFrom:number, gap:boolean}}
   * gap=true 表示某任务请求的游标早于环缓冲下界，客户端应改用 GET /tasks/{id} 全量重建。
   */
  replay({ lastSeq = 0, cursors } = {}) {
    const out = [];
    let gap = false;
    let firstDelivered = null;

    for (const [taskId, b] of this.tasks) {
      const cursor = Number.isFinite(cursors?.[taskId]) ? cursors[taskId] : lastSeq;
      const picked = b.frames.filter((f) => f.seq > cursor);
      if (picked.length && b.dropped > 0 && cursor < b.frames[0].seq - 1) gap = true;
      for (const f of picked) {
        out.push(f);
        if (firstDelivered === null || f.seq < firstDelivered) firstDelivered = f.seq;
      }
    }

    out.sort((a, b) => (a.at === b.at ? a.seq - b.seq : a.at < b.at ? -1 : 1));
    const resumeFrom = firstDelivered ?? (lastSeq > 0 ? lastSeq : 1);
    return { frames: out, resumeFrom, gap };
  }

  onFrame(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * 裁掉某任务最早的若干帧，模拟环缓冲淘汰。
   * 只用于故障注入与测试：生产里淘汰发生在 append 时，这里是为了在「刚跑起来」
   * 的短会话中也能构造出「客户端游标早于下界」的真实场景。
   */
  trim(taskId, keep = 0) {
    const b = this.tasks.get(taskId);
    if (!b) return 0;
    const drop = Math.max(0, b.frames.length - keep);
    if (drop > 0) {
      b.frames.splice(0, drop);
      b.dropped += drop;
      this.total -= drop;
    }
    return drop;
  }

  stats() {
    let lowest = null;
    for (const b of this.tasks.values()) {
      if (b.frames.length && (lowest === null || b.frames[0].seq < lowest)) lowest = b.frames[0].seq;
    }
    return {
      tasks: this.tasks.size,
      frames: this.total,
      capacityPerTask: this.capacity,
      lowestSeq: lowest,
    };
  }

  clear() {
    this.tasks.clear();
    this.total = 0;
  }
}
