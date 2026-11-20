// test/tar.mjs — 零依赖 tar/gzip 解包（三平台唯一的安装解包实现）
//
// 为什么单独立一层：macOS 的 cloudflared 是 .tgz，npm 包也是 tar.gz。两处安装都靠它，
// 一旦解包把目录或路径搞错，用户看到的是「装完了但用不了」，极难自查。
// 这里锁住三件事：能取到文件、能整树解包、绝不写到目标目录以外。

import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractTgzEntry, extractTgzToDir, gunzip, walkTar } from '../src/tar.mjs';
import { buildTar, buildTgz } from './lib/tgz.mjs';

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-tar-'));

console.log('\ntar/gzip 解包回归\n');

// ---- 1. 单文件提取（cloudflared 的 mac 包形态）----
{
  const bin = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3, 4]);
  const tgz = buildTgz({ 'cloudflared': bin });
  const got = extractTgzEntry(tgz, 'cloudflared');
  check('按 basename 取到可执行文件', Buffer.compare(got, bin) === 0);
  check('取出的内容长度正确', got.length === bin.length);
}

// ---- 2. 嵌套目录里的同名文件也能取到 ----
{
  const tgz = buildTgz({ 'pkg/bin/cloudflared': 'x'.repeat(1000) });
  check('嵌套路径按 basename 命中', extractTgzEntry(tgz, 'cloudflared').length === 1000);
}

// ---- 3. 名字对不上时退回第一个常规文件（不因命名差异装不上）----
{
  const tgz = buildTgz({ 'weird-name.bin': 'abc' });
  check('找不到目标名时退回首个文件', extractTgzEntry(tgz, 'cloudflared').toString() === 'abc');
}

// ---- 4. 非 gzip 内容 ----
{
  let err = null;
  try { gunzip(Buffer.from('not gzip')); } catch (e) { err = e; }
  check('非 gzip 抛 BAD_ARCHIVE', err?.code === 'BAD_ARCHIVE', err?.message);
  let err2 = null;
  try { extractTgzEntry(Buffer.from('not gzip'), 'x'); } catch (e) { err2 = e; }
  check('提取路径同样归为 BAD_ARCHIVE', err2?.code === 'BAD_ARCHIVE');
}

// ---- 5. 整树解包（npm 包形态）----
{
  const dir = path.join(tmp, 'pkg');
  const n = extractTgzToDir(buildTgz({
    'package/package.json': '{"name":"dsh-mobile-ios","version":"1.0.0"}',
    'package/lib/client.js': '// client\n',
    'package/lib/vendor/qrcode.cjs': '// qr\n',
  }), dir);
  check('整树解包写出 3 个文件', n === 3, String(n));
  check('package.json 内容正确', JSON.parse(readFileSync(path.join(dir, 'package/package.json'), 'utf8')).version === '1.0.0');
  check('嵌套目录被创建', existsSync(path.join(dir, 'package/lib/vendor/qrcode.cjs')));
}

// ---- 6. 越界路径必须丢弃（安装器不能写目标目录之外）----
{
  const dir = path.join(tmp, 'escape');
  const n = extractTgzToDir(buildTgz({
    'package/ok.txt': 'ok',
    '../escape.txt': 'nope',
    'package/../../escape2.txt': 'nope',
  }), dir);
  check('越界条目被丢弃，只写合法文件', n === 1, String(n));
  check('上级目录没有出现被写入的文件', !existsSync(path.join(tmp, 'escape.txt')));
  check('合法文件仍然写出', existsSync(path.join(dir, 'package/ok.txt')));
}

// ---- 7. 遍历器在结束块停止（不会把填充数据当文件）----
{
  const names = [];
  walkTar(buildTar({ 'a.txt': 'a', 'b.txt': 'b' }), (e) => names.push(e.name));
  check('只遍历两个真实条目', names.join(',') === 'a.txt,b.txt', names.join(','));
}

console.log(`\n结果：${pass} 通过 / ${failures.length} 失败\n`);
if (failures.length) process.exit(1);
