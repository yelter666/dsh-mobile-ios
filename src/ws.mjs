// ws.mjs — WS 传输层（RFC6455 最小子集 + ticket 鉴权 + 握手泵）
// 安全要点（ADR-13）：一次性 ticket 走 Sec-WebSocket-Protocol，不进 URL query——
// query 会落到反向代理日志与崩溃上报里。

import crypto from 'node:crypto';
import { fail } from './protocol.mjs';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;
const SUBPROTOCOL = 'dsh.v1';
const TICKET_TTL_MS = 30_000;
const HELLO_TIMEOUT_MS = 5_000;

const acceptKey = (key) => crypto.createHash('sha1').update(key + GUID).digest('base64');

export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

class FrameParser {
  constructor(onMessage, onControl, maxFrame = 4 * 1024 * 1024) {
    this.buf = Buffer.alloc(0);
    this.frag = [];
    this.onMessage = onMessage;
    this.onControl = onControl;
    this.maxFrame = maxFrame;
  }

  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;

      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(this.maxFrame)) throw new Error('帧过大');
        len = Number(big);
        off = 10;
      }
      if (len > this.maxFrame) throw new Error('帧过大');

      let mask = null;
      if (masked) {
        if (b.length < off + 4) return;
        mask = b.subarray(off, off + 4);
        off += 4;
      }
      if (b.length < off + len) return;

      let payload = b.subarray(off, off + len);
      if (mask) {
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i += 1) out[i] = payload[i] ^ mask[i % 4];
        payload = out;
      }
      this.buf = b.subarray(off + len);

      if (opcode === OP_PING) this.onControl('ping', payload);
      else if (opcode === OP_PONG) this.onControl('pong', payload);
      else if (opcode === OP_CLOSE) this.onControl('close', payload);
      else if (opcode === OP_TEXT || opcode === OP_BINARY) {
        if (!fin) this.frag.push(payload);
        else if (this.frag.length) {
          this.frag.push(payload);
          const full = Buffer.concat(this.frag);
          this.frag = [];
          this.onMessage(full);
        } else this.onMessage(payload);
      }
    }
  }
}

export class TicketStore {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.map = new Map();
  }
  issue(deviceId) {
    // 前缀不是装饰：日志/崩溃上报里能一眼认出并做密钥扫描（契约 WsTicket.pattern 要求 tkt_）
    const ticket = `tkt_${crypto.randomBytes(18).toString('base64url')}`;
    this.map.set(ticket, { deviceId, expiresAt: this.now() + TICKET_TTL_MS });
    return { ticket, expiresInSec: TICKET_TTL_MS / 1000 };
  }
  /** 一次性：取出即删 */
  consume(ticket) {
    const rec = this.map.get(ticket);
    if (!rec) return null;
    this.map.delete(ticket);
    if (rec.expiresAt <= this.now()) return null;
    return rec;
  }
  get size() {
    return this.map.size;
  }
}

function parseSubprotocols(header = '') {
  return String(header)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function attachWebSocket(server, { core, pairing, tickets, log = () => {}, hostAllow = () => true }) {
  const connections = new Set();
  let handshakes = 0;
  let rejects = 0;

  server.on('upgrade', (req, socket, head) => {
    const deny = (status, code, message) => {
      rejects += 1;
      const body = JSON.stringify({ code, message });
      socket.write(
        `HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Bad Request'}\r\n` +
          'Content-Type: application/json; charset=utf-8\r\n' +
          `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
      );
      socket.destroy();
    };

    const key = req.headers['sec-websocket-key'];
    if (!key) return deny(400, 4400, '缺少 Sec-WebSocket-Key');

    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/ws/mobile') return deny(400, 4404, '未知的 WS 路径');

    if (!hostAllow(req.headers.host)) return deny(403, 4003, '这台主机不信任当前地址');

    const protos = parseSubprotocols(req.headers['sec-websocket-protocol']);
    const ticketItem = protos.find((p) => p.startsWith('ticket.'));
    let device = null;
    try {
      if (ticketItem) {
        const rec = tickets.consume(ticketItem.slice('ticket.'.length));
        if (!rec) return deny(401, 4001, '连接票据无效或已过期');
        device = [...pairing.byDeviceId.values()].find((d) => d.deviceId === rec.deviceId) || null;
        if (!device) return deny(401, 4001, '设备不存在');
        if (device.revoked) return deny(401, 4009, '这台设备已被撤销');
      } else if (/^ticket\s+/i.test(String(req.headers.authorization || ''))) {
        // 某些客户端（如 URLSession）不允许自定义 Sec-WebSocket-Protocol，
        // 用 Authorization: Ticket <t> 承载同一张一次性票据，仍然不进 URL。
        const raw = String(req.headers.authorization).replace(/^ticket\s+/i, '');
        const rec = tickets.consume(raw);
        if (!rec) return deny(401, 4001, '连接票据无效或已过期');
        device = [...pairing.byDeviceId.values()].find((d) => d.deviceId === rec.deviceId) || null;
        if (!device) return deny(401, 4001, '设备不存在');
        if (device.revoked) return deny(401, 4009, '这台设备已被撤销');
      } else if (req.headers.authorization) {
        // 降级路径：宿主不支持票据时用长期凭证（PRD §10.4）
        device = pairing.verify(String(req.headers.authorization).replace(/^Bearer\s+/i, ''));
      } else {
        return deny(401, 4001, '缺少设备凭证');
      }
    } catch (err) {
      return deny(401, err.code === 4009 ? 4009 : 4001, err.message);
    }

    const accept = acceptKey(key);
    // RFC 6455 §4.1：只有当客户端在请求里声明了子协议，服务端才可以在 101 里回
    // Sec-WebSocket-Protocol。无条件回会被严格执行协议的客户端判为「响应非法」并断开
    // ——Apple 的 URLSession 就是如此，表现为 "There was a bad response from the server"，
    // 而服务端只看到「握手超时」，极易误判成客户端没发 hello。
    const handshakeLines = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
    ];
    if (protos.length > 0) handshakeLines.push(`Sec-WebSocket-Protocol: ${SUBPROTOCOL}`);
    handshakeLines.push('', '');
    socket.write(handshakeLines.join('\r\n'));
    handshakes += 1;

    let closed = false;
    let helloTimer = null;
    const session = core.addSession({
      device,
      remote: req.socket.remoteAddress || '',
      send: (obj) => {
        if (closed || socket.destroyed) return;
        session.lastFrameAt = Date.now();
        session.sent += 1;
        socket.write(encodeFrame(OP_TEXT, Buffer.from(JSON.stringify(obj))));
      },
      close: (code = 1000, reason = '') => {
        if (closed) return;
        closed = true;
        const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
        payload.writeUInt16BE(code, 0);
        payload.write(reason, 2);
        if (!socket.destroyed) {
          socket.write(encodeFrame(OP_CLOSE, payload));
          socket.end();
        }
        clearTimeout(helloTimer);
        connections.delete(conn);
        core.removeSession(session);
      },
    });
    const conn = { session, socket, device };
    connections.add(conn);

    const rejectAndClose = (err) => {
      rejects += 1;
      const code = err.code || 4500;
      session.send({ t: 'reject', code, message: err.message, ...(err.extra || {}) });
      session.close(1008, 'rejected');
      log(`ws    reject ${code} (${err.message})`);
    };

    const parser = new FrameParser(
      (payload) => {
        let msg;
        try {
          msg = JSON.parse(payload.toString('utf8'));
        } catch {
          return rejectAndClose(fail(4400, '帧不是合法 JSON'));
        }
        if (msg.t === 'hello') {
          clearTimeout(helloTimer);
          try {
            core.handleHello(session, msg);
            // hello 已通过凭证校验：把客户端「关于」页当前的设备名全称同步到注册表，
            // 面板下一次刷新即可看到改名后的名字（配对时记下的名字只是初始值）。
            if (typeof msg.deviceName === 'string') {
              pairing.renameDevice(session.device.deviceId, msg.deviceName);
            }
          } catch (err) {
            rejectAndClose(err);
          }
          return;
        }
        if (msg.t === 'req') {
          core
            .handleReq(session, msg)
            .then((res) => session.send({ t: 'res', id: res.id, ok: true, data: res.data }))
            .catch((err) => session.send({ t: 'res', id: msg.id, ok: false, error: err.toJSON?.() ?? { code: 4500, message: String(err) } }));
          return;
        }
        if (msg.t === 'ping') {
          session.send({ t: 'pong', serverTime: new Date().toISOString() });
          return;
        }
        rejectAndClose(fail(4400, `未知帧类型 ${msg.t}`));
      },
      (kind, payload) => {
        if (kind === 'ping') socket.write(encodeFrame(OP_PONG, payload));
        else if (kind === 'close') session.close(1000, '');
      }
    );

    helloTimer = setTimeout(() => {
      if (!session.ready) rejectAndClose(fail(4004, '握手超时'));
    }, HELLO_TIMEOUT_MS);

    if (head?.length) parser.push(head);
    socket.on('data', (chunk) => {
      try {
        parser.push(chunk);
      } catch (err) {
        log(`ws    parse error: ${err.message}`);
        session.close(1011, 'parse error');
      }
    });
    socket.on('error', () => session.close(1011, 'socket error'));
    socket.on('close', () => session.close(1000, ''));
  });

  // 空闲回收：客户端应 15s 一次 ping；120s 无帧说明对端已死，回收连接
  const sweep = setInterval(() => {
    for (const { session } of connections) {
      if (session.ready && Date.now() - session.lastFrameAt > 120_000) {
        log(`ws    idle timeout ${session.deviceId}`);
        session.close(1001, 'idle timeout');
      }
    }
  }, 30_000);
  sweep.unref?.();

  return {
    stats: () => ({ connections: connections.size, handshakes, rejects }),
    /**
     * 模拟链路中断：直接 destroy 底层 socket，不发 close 帧。
     * 与 closeAll（优雅 1001）区分开——客户端在两种情况下该走的重连逻辑不同。
     */
    dropAll: () => {
      let n = 0;
      for (const { socket } of [...connections]) {
        if (socket && !socket.destroyed) {
          socket.destroy();
          n += 1;
        }
      }
      return n;
    },
    closeAll: () => {
      clearInterval(sweep);
      for (const { session } of [...connections]) session.close(1001, 'server stopping');
    },
  };
}
