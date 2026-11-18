// test/lib/wsclient.mjs — 零依赖 WS 客户端（测试用）
// 与网关的 ws.mjs 是两套独立实现：避免"只有自家协议栈对得上"的自证。

import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';

const OP_TEXT = 0x1;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

function maskedFrame(opcode, payload) {
  const mask = crypto.randomBytes(4);
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i += 1) body[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, body]);
}

export function connect({ port, path = '/ws/mobile', protocols = [], headers = {}, timeoutMs = 4000 }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      port,
      host: '127.0.0.1',
      path,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        ...(protocols.length ? { 'Sec-WebSocket-Protocol': protocols.join(', ') } : {}),
        ...headers,
      },
    });

    req.setTimeout(timeoutMs, () => req.destroy(new Error('upgrade timeout')));

    req.on('upgrade', (res, socket, head) => {
      const queue = [];
      const waiters = [];
      let buf = head?.length ? Buffer.from(head) : Buffer.alloc(0);
      let closed = false;
      const closedWaiters = [];

      const deliver = (item) => {
        if (waiters.length) waiters.shift()(item);
        else queue.push(item);
      };

      const onFrame = (opcode, payload) => {
        if (opcode === OP_PING) {
          socket.write(maskedFrame(OP_PONG, payload));
          return;
        }
        if (opcode === OP_CLOSE) {
          closed = true;
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
          client.closeCode = code;
          for (const w of closedWaiters.splice(0)) w({ code });
          return;
        }
        if (opcode === OP_TEXT) {
          const text = payload.toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* 允许非 JSON */
          }
          deliver({ text, json });
        }
      };

      const pump = () => {
        for (;;) {
          if (buf.length < 2) return;
          const opcode = buf[0] & 0x0f;
          const masked = (buf[1] & 0x80) !== 0;
          let len = buf[1] & 0x7f;
          let off = 2;
          if (len === 126) {
            if (buf.length < 4) return;
            len = buf.readUInt16BE(2);
            off = 4;
          } else if (len === 127) {
            if (buf.length < 10) return;
            len = Number(buf.readBigUInt64BE(2));
            off = 10;
          }
          if (masked) off += 4;
          if (buf.length < off + len) return;
          const payload = Buffer.from(buf.subarray(off, off + len));
          buf = buf.subarray(off + len);
          onFrame(opcode, payload);
        }
      };

      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        pump();
      });
      socket.on('close', () => {
        closed = true;
        for (const w of closedWaiters.splice(0)) w({ code: 1006 });
      });
      socket.on('error', () => {});

      const client = {
        status: res.statusCode,
        protocol: res.headers['sec-websocket-protocol'] || null,
        socket,
        send(obj) {
          socket.write(maskedFrame(OP_TEXT, Buffer.from(JSON.stringify(obj))));
        },
        raw: (text) => socket.write(maskedFrame(OP_TEXT, Buffer.from(text))),
        ping: (payload = Buffer.alloc(0)) => socket.write(maskedFrame(OP_PING, payload)),
        next(timeout = 3000) {
          if (queue.length) return Promise.resolve(queue.shift());
          return new Promise((res2, rej2) => {
            const t = setTimeout(() => rej2(new Error('等待帧超时')), timeout);
            waiters.push((v) => {
              clearTimeout(t);
              res2(v);
            });
          });
        },
        async until(pred, timeout = 4000) {
          const deadline = Date.now() + timeout;
          for (;;) {
            const left = deadline - Date.now();
            if (left <= 0) throw new Error('until 超时');
            const item = await this.next(left);
            if (!pred || pred(item.json)) return item;
          }
        },
        close(code = 1000) {
          const payload = Buffer.alloc(2);
          payload.writeUInt16BE(code, 0);
          socket.write(maskedFrame(OP_CLOSE, payload));
          closed = true;
          socket.end();
        },
        waitClose(timeout = 3000) {
          if (closed) return Promise.resolve({ code: client.closeCode ?? null });
          return new Promise((res2, rej2) => {
            const t = setTimeout(() => rej2(new Error('等待关闭超时')), timeout);
            closedWaiters.push((v) => {
              clearTimeout(t);
              res2(v);
            });
          });
        },
      };
      if (head?.length) pump();
      resolve(client);
    });

    req.on('response', (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => reject(Object.assign(new Error(`upgrade 被拒绝 ${res.statusCode}`), { status: res.statusCode, body })));
    });
    req.on('error', reject);
    req.end();
  });
}

export function httpJson({ port, method = 'GET', path, body, token, headers = {}, host = '127.0.0.1' }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        port,
        host,
        path,
        method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            /* 保留原文 */
          }
          resolve({ status: res.statusCode, body: json, text: data, headers: res.headers });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('http timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

export function portFree(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (free) => {
      socket.destroy();
      resolve(free);
    };
    socket.on('connect', () => done(false));
    socket.on('error', () => done(true));
    socket.setTimeout(1500, () => done(true));
  });
}
