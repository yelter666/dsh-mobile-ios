// test/lib/tgz.mjs — 造合法的 ustar + gzip 归档（测试用，不依赖系统 tar）
import { gzipSync } from 'node:zlib';

function header(name, size) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000755\0', 100, 8);
  h.write('0000000\0', 108, 8);
  h.write('0000000\0', 116, 8);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12);
  h.write('00000000000\0', 136, 12);
  h.write('        ', 148, 8);
  h.write('0', 156, 1);
  h.write('ustar\0' + '00', 257, 8);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return h;
}

/** files: { 'package/package.json': string|Buffer } */
export function buildTar(files) {
  const parts = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
    parts.push(header(name, data.length), data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024)); // 归档结束标记
  return Buffer.concat(parts);
}

export function buildTgz(files) {
  return gzipSync(buildTar(files));
}
