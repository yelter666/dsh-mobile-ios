// gateway.mjs — 传输无关的网关核心（ADR-12）
// 这一层只认识三样东西：host 适配器、配对服务、会话集合。
// 不含任何宿主 API 调用、不含任何 HTTP/WS 细节 —— 插件与 sidecar 共用它。

import crypto from 'node:crypto';
import { EventLog } from './ring.mjs';
import { fail, isSupportedProtocol, PROTOCOL_VERSION, newId } from './protocol.mjs';

const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;

export class GatewayCore {
  constructor({ host, pairing, log = () => {}, now = () => Date.now(), eventLog } = {}) {
    if (!host) throw new Error('GatewayCore 需要 host 适配器');
    if (!pairing) throw new Error('GatewayCore 需要 pairing 服务');
    this.host = host;
    this.pairing = pairing;
    this.log = log;
    this.now = now;
    this.events = eventLog || new EventLog();
    this.sessions = new Map();
    this.idempotency = new Map();
    this.gen = `gen_${crypto.randomBytes(3).toString('hex')}`;
    this.unsubscribe = null;
    this.startedAt = null;
  }

  start() {
    if (this.startedAt) return;
    this.startedAt = this.now();
    this.unsubscribe = this.host.subscribe((evt) => this.publish(evt));
    this.log(`core  start gen=${this.gen} host=${this.host.info().hostName}`);
  }

  stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const s of this.sessions.values()) {
      try {
        s.close(1001, 'gateway stopping');
      } catch {
        /* 关闭失败不影响退出 */
      }
    }
    this.sessions.clear();
    this.startedAt = null;
  }

  /**
   * 宿主重启：seq 空间作废，旧游标不再指向同一串事实。
   *
   * 契约只写了「gen 变化 ⇒ 客户端全量重建」，但客户端要等 ready 才知道 gen 变了；
   * 若不额外告知，它会把「补不到增量」读成「没有新事件」——静默丢数据。
   * 所以这里做三件事：换 gen、清空环缓冲、给在线会话推 gateway 事件并以 1012 关闭。
   */
  restartHost(reason = 'host_restart') {
    const prevGen = this.gen;
    this.gen = `gen_${crypto.randomBytes(3).toString('hex')}`;
    this.notifyGateway({ event: 'host.restarted', reason, gen: this.gen, prevGen });
    // 真实宿主重启后，在跑的任务不会自己复活：宿主会把它们标成「已中断」。
    // 之前 mock 不建模这一点，列表快照仍报 running，客户端刚降级的状态会被覆盖回去，
    // 端到端就永远验不出 FR-TASK-06（「已中断 · 可续」而不是一直转圈）。
    try {
      this.host.onHostRestart?.(reason);
    } catch (err) {
      this.log(`core  host.onHostRestart 失败：${err.message}`);
    }
    this.events.clear();
    for (const s of [...this.sessions.values()]) {
      try {
        s.close(1012, 'host restarted');
      } catch {
        /* 关闭失败不影响重启 */
      }
    }
    this.sessions.clear();
    this.log(`core  restart gen=${prevGen} -> ${this.gen}`);
    return { gen: this.gen, prevGen, reason };
  }

  /**
   * 网关级事件（不属于某个任务）：不分配 seq，不进环缓冲。
   *
   * 这类事件描述的是「连接环境」本身变了（宿主重启、隧道地址漂移），
   * 与之关联的不是某个任务的时间线，因此不带 seq 也不该被续传。
   */
  notifyGateway(data) {
    const notice = {
      t: 'ev',
      seq: 0,
      taskId: null,
      kind: 'gateway',
      at: new Date(this.now()).toISOString(),
      data,
    };
    for (const s of this.sessions.values()) {
      if (!s.ready) continue;
      try {
        s.send(notice);
      } catch {
        /* 对端已断，忽略 */
      }
    }
    return notice;
  }

  /** 故障注入：裁掉某任务已缓冲的旧帧，制造「游标早于下界」的缺口场景 */
  injectGap(taskId, keep = 0) {
    const dropped = this.events.trim(taskId, keep);
    return { taskId, dropped, lowerBound: this.events.lowerBound(taskId), maxSeq: this.events.maxSeq(taskId) };
  }

  /** 宿主事件 → 分配 seq → 扇出。网关不改写 data，只加封套。 */
  publish({ taskId, kind, data, at }) {
    const frame = this.events.append({ taskId, kind, data, at });
    for (const s of this.sessions.values()) {
      if (s.ready) s.send(frame);
    }
    return frame;
  }

  addSession({ device, send, close, remote = '' }) {
    const session = {
      id: newId('sess'),
      deviceId: device?.deviceId || null,
      installId: device?.installId || null,
      device,
      send,
      close,
      remote,
      ready: false,
      cursors: {},
      createdAt: this.now(),
      lastFrameAt: this.now(),
      sent: 0,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  removeSession(session) {
    if (session) this.sessions.delete(session.id);
  }

  /** 握手：任何一步失败都抛 GatewayError，由传输层转 reject + close(1008) */
  handleHello(session, hello = {}) {
    if (!session.device) throw fail(4001);
    if (!isSupportedProtocol(hello.protocolVersion)) {
      throw fail(4004, undefined, { supported: PROTOCOL_VERSION });
    }
    if (hello.deviceId && hello.deviceId !== session.device.deviceId) {
      throw fail(4001, '设备标识与凭证不匹配');
    }
    if (hello.installId && hello.installId !== session.device.installId) {
      // 安装标识变化 = 凭证被搬到另一台设备，宁可让用户重新配对
      throw fail(4009, '设备标识已变化，请重新配对');
    }

    const host = this.host.info();
    // 客户端回带上次见过的 gen：不一致说明跨了一次宿主重启，旧游标无意义。
    // 此时必须把 gap 置真并丢弃游标，否则客户端会把「补不到」误读成「没有新事件」。
    const genChanged = typeof hello.gen === 'string' && hello.gen !== '' && hello.gen !== this.gen;
    const { frames, resumeFrom, gap } = genChanged
      ? { frames: [], resumeFrom: 1, gap: true }
      : this.events.replay({
          lastSeq: Number(hello.lastSeq) || 0,
          cursors: hello.cursors,
        });

    session.ready = true;
    session.cursors = { ...(hello.cursors || {}) };
    const ready = {
      t: 'ready',
      hostId: host.hostId,
      hostName: host.hostName,
      hostVersion: host.hostVersion,
      protocolVersion: PROTOCOL_VERSION,
      caps: host.caps,
      gen: this.gen,
      resumeFrom,
      resumed: frames.length,
      gap,
      ...(genChanged ? { genChanged: true } : {}),
      ...(host.degraded ? { degraded: true, reason: host.reason } : {}),
    };
    session.send(ready);
    for (const f of frames) session.send(f);
    this.log(
      `ws    ready device=${session.device.deviceId} resumeFrom=${resumeFrom} frames=${frames.length}${gap ? ' GAP' : ''}${genChanged ? ' GEN-CHANGED' : ''}`
    );
    return { ready, replayed: frames.length };
  }

  /** WS 上的控制调用。方法表只放"必须走同一连接"的，业务读写一律走 REST。 */
  async handleReq(session, msg = {}) {
    if (!session.ready) throw fail(4004, '未握手');
    const { id, method, params = {} } = msg;
    switch (method) {
      case 'ping':
        return { id, data: { serverTime: new Date(this.now()).toISOString(), gen: this.gen } };
      case 'diag.snapshot':
        return { id, data: this.stats() };
      default:
        throw fail(4021, undefined, { method });
    }
  }

  /**
   * 写操作幂等（FR-CMD-03）：同键 10 分钟内返回首次结果，不重复下发。
   * 注意：缓存的是"结果"，不是"意图"——宿主成功了才写缓存。
   *
   * 命中缓存时必须把 duplicate 置真：契约（openapi §createTask / schemas）规定
   * "重复请求返回首次结果并置 duplicate: true"，客户端靠这个字段决定要不要提示
   * "已经提交过了"。此前只回 replayed（契约外字段），实现与契约不符。
   */
  async idempotent(key, fn) {
    if (!key) return fn();
    const hit = this.idempotency.get(key);
    if (hit && this.now() - hit.at < IDEMPOTENCY_TTL_MS) {
      if (hit.pending) return hit.pending;
      this.log(`idem  hit ${key.slice(0, 12)}…`);
      return { ...hit.result, duplicate: true, replayed: true };
    }
    const pending = (async () => {
      const result = await fn();
      this.idempotency.set(key, { at: this.now(), result });
      return result;
    })();
    this.idempotency.set(key, { at: this.now(), pending });
    try {
      return await pending;
    } catch (err) {
      this.idempotency.delete(key); // 失败不占位，允许原键重试
      throw err;
    }
  }

  #gcIdempotency() {
    for (const [k, v] of this.idempotency) {
      if (this.now() - v.at > IDEMPOTENCY_TTL_MS) this.idempotency.delete(k);
    }
  }

  stats() {
    this.#gcIdempotency();
    const host = this.host.info();
    return {
      gen: this.gen,
      uptimeSec: this.startedAt ? Math.floor((this.now() - this.startedAt) / 1000) : 0,
      host: {
        hostId: host.hostId,
        hostName: host.hostName,
        hostVersion: host.hostVersion,
        platform: host.platform,
        caps: host.caps,
      },
      sessions: this.sessions.size,
      readySessions: [...this.sessions.values()].filter((s) => s.ready).length,
      events: this.events.stats(),
      pairing: this.pairing.stats(),
      idempotencyKeys: this.idempotency.size,
      protocolVersion: PROTOCOL_VERSION,
    };
  }
}
