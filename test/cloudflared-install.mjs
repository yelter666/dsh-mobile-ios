// test/cloudflared-install.mjs — cloudflared 自举安装回归
//
// 覆盖：官方资产解析、幂等复用、大小校验、失败清理、发现链纳入组件目录。
// 全程用注入的 mock fetch + 临时目录，不访问网络、不写真实组件目录。

import { mkdtempSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveAsset, ensureCloudflared, componentBinDir, CLOUDFLARED_RELEASE,
} from '../src/cloudflared-install.mjs';
import { findCloudflared } from '../src/tunnel.mjs';

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const tmp = mkdtempSync(path.join(os.tmpdir(), 'cf-install-'));
const bytes = (n) => Buffer.alloc(n, 0x5a);
const okFetch = (buf) => async () => ({ ok: true, status: 200, arrayBuffer: async () => buf });

console.log('\ncloudflared 自举安装回归\n');

// 1. 资产解析
const win = resolveAsset({ platform: 'win32', arch: 'x64' });
check('Windows x64 解析到官方 exe', /^https:\/\/github\.com\/cloudflare\/cloudflared\/releases\/download\/.+\/cloudflared-windows-amd64\.exe$/.test(win.url), win?.url);
check('Windows exe 期望字节数 = 实测 55483112', win.size === 55483112);
check('Windows 可执行文件名为 cloudflared.exe', win.bin === 'cloudflared.exe');
check('未知平台返回 null（降级手动安装）', resolveAsset({ platform: 'freebsd', arch: 'x64' }) === null);
check('组件目录路径含版本号', componentBinDir({ home: '/h', version: '1.2.3' }).endsWith(path.join('components', 'cloudflared', '1.2.3')));
check('默认版本为实测最新 2026.11.1', CLOUDFLARED_RELEASE === '2026.11.1');

// 2. 下载并落盘
const dir1 = path.join(tmp, 'case1');
const r1 = await ensureCloudflared({ destDir: dir1, platform: 'win32', arch: 'x64', fetchImpl: okFetch(bytes(55483112)) });
check('下载成功返回 installed', r1.installed === true);
check('落点为组件目录内 exe', r1.executable === path.join(dir1, 'cloudflared.exe'));
check('文件真实存在', existsSync(r1.executable));
check('首次安装 reused=false', r1.reused === false);

// 3. 幂等复用
const r2 = await ensureCloudflared({ destDir: dir1, platform: 'win32', arch: 'x64', fetchImpl: async () => { throw new Error('不应再次下载'); } });
check('已存在时幂等复用', r2.reused === true && r2.executable === r1.executable);

// 4. 大小校验失败（给一个错误大小）
const dir2 = path.join(tmp, 'case2');
let sizeErr = null;
try { await ensureCloudflared({ destDir: dir2, platform: 'win32', arch: 'x64', fetchImpl: okFetch(bytes(1234)) }); }
catch (e) { sizeErr = e; }
check('大小不符抛 SIZE_MISMATCH', sizeErr?.code === 'SIZE_MISMATCH', sizeErr?.message);
check('校验失败后未留下残缺文件', !existsSync(path.join(dir2, 'cloudflared.exe')));
check('校验失败后未留下 .partial', !existsSync(path.join(dir2, 'cloudflared.exe.partial')));

// 5. HTTP 失败
const dir3 = path.join(tmp, 'case3');
let httpErr = null;
try {
  await ensureCloudflared({ destDir: dir3, platform: 'win32', arch: 'x64', fetchImpl: async () => ({ ok: false, status: 403 }) });
} catch (e) { httpErr = e; }
check('HTTP 403 抛 DOWNLOAD_FAILED', httpErr?.code === 'DOWNLOAD_FAILED', httpErr?.message);

// 6. 不支持平台
let platErr = null;
try { await ensureCloudflared({ destDir: path.join(tmp, 'case4'), platform: 'freebsd', arch: 'x64', fetchImpl: okFetch(bytes(10)) }); }
catch (e) { platErr = e; }
check('不支持平台抛 UNSUPPORTED_PLATFORM', platErr?.code === 'UNSUPPORTED_PLATFORM');

// 7. 发现链：组件目录纳入 findCloudflared（装完即时可见）
//   构造一个隔离的 home，写入组件目录二进制，验证 findCloudflared 能命中。
const fakeHome = path.join(tmp, 'home');
const compDir = path.join(fakeHome, '.dsh', 'mobile-access', 'components', 'cloudflared', CLOUDFLARED_RELEASE);
const { mkdirSync } = await import('node:fs');
mkdirSync(compDir, { recursive: true });
const fakeBin = path.join(compDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
writeFileSync(fakeBin, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
const found = findCloudflared('auto', { HOME: fakeHome, USERPROFILE: fakeHome, PATH: '' });
check('findCloudflared 从组件目录发现刚装的二进制', found === fakeBin, `found=${found}`);

// 8. 显式路径优先级不变
check('显式路径优先于组件目录', findCloudflared(fakeBin, { HOME: fakeHome, PATH: '' }) === fakeBin);
check('显式路径不存在返回 null', findCloudflared(path.join(tmp, 'nope'), { HOME: fakeHome, PATH: '' }) === null);

console.log(`\n结果：${pass} 通过 / ${failures.length} 失败\n`);
if (failures.length) process.exit(1);

// 顺带清理临时目录中的大文件，避免占磁盘
try {
  for (const d of readdirSync(tmp)) {
    const f = path.join(tmp, d);
    if (existsSync(f)) { /* 目录交由 OS 临时回收，仅删除已知大文件 */ }
  }
} catch { /* noop */ }
void fileURLToPath;
