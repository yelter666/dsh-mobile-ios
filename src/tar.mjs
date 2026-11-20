// tar.mjs — 零依赖 tar/gzip 读取
//
// 为什么不用系统 tar：
//   · Windows 只有 1803+ 才自带 bsdtar（且依赖 System32 在 PATH 里）；
//   · 解包是「安装」动作的最后一步，这里失败等于前面下载全白费，
//     不该把成败押在外部命令是否存在上。
//
// 只实现安装真正需要的能力：读 ustar/GNU 常规文件、整树解包。
// 不做符号链接、硬链接、稀疏文件 —— npm 包与 cloudflared 发布包都用不到，
// 真遇到就跳过（宁可少解一个文件，也不要解出宿主目录以外的路径）。

import { gunzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BLOCK = 512;

/** C 字符串字段（0 结尾或填满） */
function cstr(buf, start, len) {
  const slice = buf.subarray(start, start + len);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8').trim();
}

/** 八进制字段（可能被空格/NUL 填充） */
function octal(buf, start, len) {
  const text = cstr(buf, start, len);
  const value = parseInt(text || '0', 8);
  return Number.isFinite(value) ? value : 0;
}

/** 解 gzip；不是 gzip 就抛 BAD_ARCHIVE（调用方据此报「安装包损坏」） */
export function gunzip(raw) {
  try {
    return gunzipSync(raw);
  } catch (err) {
    const e = new Error(`压缩包解压失败：${err?.message || err}`);
    e.code = 'BAD_ARCHIVE';
    throw e;
  }
}

/**
 * 遍历 tar 条目。回调拿到 (entry)，entry.data 是 Buffer 视图。
 * 归档结束（连续两个全零块）即停。
 */
export function walkTar(buf, onEntry) {
  let off = 0;
  while (off + BLOCK <= buf.length) {
    const header = buf.subarray(off, off + BLOCK);
    if (header.every((b) => b === 0)) break;
    const name = cstr(header, 0, 100);
    const prefix = cstr(header, 345, 155);
    const full = prefix ? `${prefix}/${name}` : name;
    const size = octal(header, 124, 12);
    const typeByte = header[156];
    const type = typeByte === 0 ? '0' : String.fromCharCode(typeByte);
    const dataStart = off + BLOCK;
    const data = buf.subarray(dataStart, dataStart + size);
    // '0'/'\0' 常规文件；'x'/'g' 是 pax 扩展头（跳过，名字仍在下一个条目里）；
    // 'L' GNU 长文件名（同样跳过，宁可名字短一点也不越界写文件）
    if (type === '0') onEntry({ name: full, size, data, mode: octal(header, 100, 8) });
    off = dataStart + Math.ceil(size / BLOCK) * BLOCK;
  }
}

/** 把归档内的相对路径收敛到 destDir 内；越界返回 null。 */
function safeJoin(destDir, name) {
  const clean = String(name).replace(/\\/g, '/').replace(/^\/+/, '');
  const target = path.resolve(destDir, clean);
  const base = path.resolve(destDir);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

/** 取出归档里指定 basename 的文件（找不到就退化为第一个常规文件）。 */
export function extractEntry(rawTar, binName) {
  let hit = null;
  let first = null;
  walkTar(rawTar, (entry) => {
    if (hit) return;
    if (!first && entry.size > 0) first = entry;
    if (path.basename(entry.name) === binName && entry.size > 0) hit = entry;
  });
  const chosen = hit || first;
  return chosen ? Buffer.from(chosen.data) : null;
}

/** 解 gzip + 取单文件：安装 cloudflared（macOS 的 .tgz）走这条。 */
export function extractTgzEntry(raw, binName) {
  const file = extractEntry(gunzip(raw), binName);
  if (!file) {
    const e = new Error(`安装包里找不到 ${binName}`);
    e.code = 'BAD_ARCHIVE';
    throw e;
  }
  return file;
}

/** 整树解包到 destDir（npm tarball 形如 package/**）。返回写出的文件数。 */
export function extractTgzToDir(raw, destDir) {
  const tar = gunzip(raw);
  let written = 0;
  walkTar(tar, (entry) => {
    const target = safeJoin(destDir, entry.name);
    if (!target) return; // 越界路径直接丢弃：安装器不该有写宿主目录的能力
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, entry.data);
    written += 1;
  });
  return written;
}
