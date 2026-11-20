// test/cloudflared-install.mjs — cloudflared 自举安装回归
//
// 覆盖：官方资产解析、裸二进制/压缩包两条形态、魔数校验、幂等复用、大小校验、
// 失败清理、坏包自愈、发现链纳入组件目录。
// 全程用注入的 mock fetch + 临时目录，不访问网络、不写真实组件目录。
//
// 重点回归（0.2.14）：macOS 的官方资产是 **.tgz**，不是裸二进制。早先的实现把压缩包
// 整个写成目标文件，装完看似成功、一执行就报格式错误 —— 这两个平台必须走解包分支。

import { mkdtempSync, writeFileSync, existsSync, mkdirSync, openSync, readSync, closeSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import {
  resolveAsset, ensureCloudflared, componentBinDir, CLOUDFLARED_RELEASE,
  extractTarGz, sniffBinary,
} from '../src/cloudflared-install.mjs';
import { findCloudflared } from '../src/tunnel.mjs';
import { LocalProvisioner } from '../src/provision-local.mjs';

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const tmp = mkdtempSync(path.join(os.tmpdir(), 'cf-install-'));

// ---- 造「像真的一样」的二进制：魔数对了才算本平台可执行文件 ----
const FILL = 0x5a;
function fakeBinary(kind, size) {
  const buf = Buffer.alloc(size, FILL);
  if (kind === 'pe') buf.write('MZ', 0, 'latin1');
  else if (kind === 'elf') buf.writeUInt32BE(0x7f454c46, 0);
  else if (kind === 'macho') buf.writeUInt32BE(0xfeedfacf, 0);
  return buf;
}

/** 最小 ustar 单文件归档（打包器不校验，只要字段位置对） */
function tarWith(name, data) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000755\0', 100, 8);
  h.write('0000000\0', 108, 8);
  h.write('0000000\0', 116, 8);
  h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12);
  h.write('00000000000\0', 136, 12);
  h.write('        ', 148, 8);
  h.write('0', 156, 1);
  h.write('ustar\0' + '00', 257, 8);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([h, data, pad, Buffer.alloc(1024)]);
}

/** 把 gzip 补到官方字节数：尾部补零不影响解压，但让大小校验走真实分支 */
function paddedGzip(inner, totalSize) {
  const gz = gzipSync(inner);
  if (gz.length > totalSize) throw new Error(`测试构造失败：gzip ${gz.length} > ${totalSize}`);
  return Buffer.concat([gz, Buffer.alloc(totalSize - gz.length)]);
}

const okFetch = (buf) => async () => ({ ok: true, status: 200, arrayBuffer: async () => buf });

console.log('\ncloudflared 自举安装回归\n');

// ---- 1. 资产解析 ----
const win = resolveAsset({ platform: 'win32', arch: 'x64' });
check('Windows x64 解析到官方 exe', /releases\/download\/.+\/cloudflared-windows-amd64\.exe$/.test(win.url), win?.url);
check('Windows exe 期望字节数 = 实测 55483112', win.size === 55483112);
check('Windows 可执行文件名为 cloudflared.exe', win.bin === 'cloudflared.exe');
check('Windows 是裸二进制（无需解包）', win.archive === null);
const macArm = resolveAsset({ platform: 'darwin', arch: 'arm64' });
check('macOS arm64 解析到官方 tgz', /cloudflared-darwin-arm64\.tgz$/.test(macArm.url), macArm?.url);
check('macOS arm64 是压缩包（必须解包）', macArm.archive === 'tgz');
check('macOS arm64 字节数已实测（非 0，可做完整性校验）', macArm.size === 19898712);
check('macOS x64 字节数 = 实测 21857340', resolveAsset({ platform: 'darwin', arch: 'x64' }).size === 21857340);
check('Linux arm64 字节数 = 实测 37818397', resolveAsset({ platform: 'linux', arch: 'arm64' }).size === 37818397);
check('未知平台返回 null（降级手动安装）', resolveAsset({ platform: 'freebsd', arch: 'x64' }) === null);
check('组件目录路径含版本号', componentBinDir({ home: '/h', version: '1.2.3' }).endsWith(path.join('components', 'cloudflared', '1.2.3')));
check('默认版本为实测最新 2026.11.1', CLOUDFLARED_RELEASE === '2026.11.1');

// ---- 2. Windows：裸二进制直落 ----
const dir1 = path.join(tmp, 'win');
const r1 = await ensureCloudflared({ destDir: dir1, platform: 'win32', arch: 'x64', fetchImpl: okFetch(fakeBinary('pe', 55483112)) });
check('Windows 下载成功返回 installed', r1.installed === true);
check('Windows 落点为组件目录内 exe', r1.executable === path.join(dir1, 'cloudflared.exe'));
check('Windows 文件真实存在', existsSync(r1.executable));
check('首次安装 reused=false', r1.reused === false);

// ---- 3. 幂等复用 ----
const r2 = await ensureCloudflared({
  destDir: dir1, platform: 'win32', arch: 'x64',
  fetchImpl: async () => { throw new Error('不应再次下载'); },
});
check('已存在且魔数正确时幂等复用', r2.reused === true && r2.executable === r1.executable);

// ---- 4. macOS arm64：.tgz 必须解包成真正的 Mach-O 二进制 ----
const dirMac = path.join(tmp, 'mac-arm');
const inner = fakeBinary('macho', 4096);
const macPayload = paddedGzip(tarWith('cloudflared', inner), macArm.size);
const rMac = await ensureCloudflared({ destDir: dirMac, platform: 'darwin', arch: 'arm64', fetchImpl: okFetch(macPayload) });
check('macOS 安装后落点为 cloudflared（不带扩展名）', rMac.executable === path.join(dirMac, 'cloudflared'));
check('macOS 落盘内容 = 归档里的二进制（不是压缩包本体）', rMac.size === inner.length, `size=${rMac.size}`);
check('macOS 落盘魔数为 Mach-O（旧实现这里是 gzip 头）',
  sniffBinary(Buffer.from([0xcf, 0xfa, 0xed, 0xfe])) === 'macho'
  && sniffBinary(readHeadOf(rMac.executable)) === 'macho', String(sniffBinary(readHeadOf(rMac.executable))));
check('macOS 落盘大小 ≠ 下载大小（证明真的解包了）', rMac.size !== rMac.archiveSize);

// ---- 5. 归档结构异常 ----
const dirBad = path.join(tmp, 'mac-bad');
let badErr = null;
try {
  await ensureCloudflared({
    destDir: dirBad, platform: 'darwin', arch: 'arm64',
    fetchImpl: okFetch(paddedGzip(Buffer.from('not a tar at all'), macArm.size)),
  });
} catch (e) { badErr = e; }
check('归档里没有可执行文件抛 BAD_ARCHIVE', badErr?.code === 'BAD_ARCHIVE', badErr?.message);
check('解包失败不留残缺文件', !existsSync(path.join(dirBad, 'cloudflared')));

// ---- 6. 平台不符的二进制必须拒收（下错源/被劫持到 HTML 页的兜底）----
const dirWrong = path.join(tmp, 'wrong-magic');
let magicErr = null;
try {
  await ensureCloudflared({
    destDir: dirWrong, platform: 'linux', arch: 'x64',
    fetchImpl: okFetch(fakeBinary('pe', 40346301)),
  });
} catch (e) { magicErr = e; }
check('Linux 收到 PE 二进制 → BAD_BINARY', magicErr?.code === 'BAD_BINARY', magicErr?.message);
check('拒收后不留文件', !existsSync(path.join(dirWrong, 'cloudflared')));

// ---- 7. 已存在的坏文件要能自愈（旧版把 .tgz 写坏的那批机器）----
const dirHeal = path.join(tmp, 'heal');
mkdirSync(dirHeal, { recursive: true });
writeFileSync(path.join(dirHeal, 'cloudflared.exe'), Buffer.alloc(55483112, 0x1f)); // 大小对、魔数错
const rHeal = await ensureCloudflared({
  destDir: dirHeal, platform: 'win32', arch: 'x64',
  fetchImpl: okFetch(fakeBinary('pe', 55483112)),
});
check('大小对但魔数错的文件会被重下覆盖', rHeal.reused === false);
check('自愈后魔数正确', sniffBinary(readHeadOf(rHeal.executable)) === 'pe');

// ---- 8. 大小校验失败 ----
const dir2 = path.join(tmp, 'case2');
let sizeErr = null;
try { await ensureCloudflared({ destDir: dir2, platform: 'win32', arch: 'x64', fetchImpl: okFetch(fakeBinary('pe', 1234)) }); }
catch (e) { sizeErr = e; }
check('大小不符抛 SIZE_MISMATCH', sizeErr?.code === 'SIZE_MISMATCH', sizeErr?.message);
check('校验失败后未留下残缺文件', !existsSync(path.join(dir2, 'cloudflared.exe')));
check('校验失败后未留下 .partial', !existsSync(path.join(dir2, 'cloudflared.exe.partial')));

// ---- 9. HTTP 失败 / 不支持平台 ----
const dir3 = path.join(tmp, 'case3');
let httpErr = null;
try {
  await ensureCloudflared({ destDir: dir3, platform: 'win32', arch: 'x64', fetchImpl: async () => ({ ok: false, status: 403 }) });
} catch (e) { httpErr = e; }
check('HTTP 403 抛 DOWNLOAD_FAILED', httpErr?.code === 'DOWNLOAD_FAILED', httpErr?.message);

let platErr = null;
try { await ensureCloudflared({ destDir: path.join(tmp, 'case4'), platform: 'freebsd', arch: 'x64', fetchImpl: okFetch(fakeBinary('elf', 10)) }); }
catch (e) { platErr = e; }
check('不支持平台抛 UNSUPPORTED_PLATFORM', platErr?.code === 'UNSUPPORTED_PLATFORM');

// ---- 10. 解包器单测（不依赖下载）----
const tarOk = gzipSync(tarWith('pkg/cloudflared', inner));
check('extractTarGz 能按 basename 取到文件', extractTarGz(tarOk, 'cloudflared').length === inner.length);
let zipErr = null;
try { extractTarGz(Buffer.from('plain'), 'cloudflared'); } catch (e) { zipErr = e; }
check('非 gzip 内容抛 BAD_ARCHIVE', zipErr?.code === 'BAD_ARCHIVE');

// ---- 11. 发现链：组件目录纳入 findCloudflared（装完即时可见）----
const fakeHome = path.join(tmp, 'home');
const compDir = path.join(fakeHome, '.dsh', 'mobile-access', 'components', 'cloudflared', CLOUDFLARED_RELEASE);
mkdirSync(compDir, { recursive: true });
const fakeBin = path.join(compDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
writeFileSync(fakeBin, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
const found = findCloudflared('auto', { HOME: fakeHome, USERPROFILE: fakeHome, PATH: '' });
check('findCloudflared 从组件目录发现刚装的二进制', found === fakeBin, `found=${found}`);
check('显式路径优先于组件目录', findCloudflared(fakeBin, { HOME: fakeHome, PATH: '' }) === fakeBin);
check('显式路径不存在返回 null', findCloudflared(path.join(tmp, 'nope'), { HOME: fakeHome, PATH: '' }) === null);

// 裸文件名要当作 PATH 里的名字继续搜（sidecar --tunnel-bin cloudflared 就是这么传的）
const pathDir = path.join(tmp, 'pathdir');
const emptyHome = path.join(tmp, 'emptyhome');
mkdirSync(pathDir, { recursive: true });
mkdirSync(emptyHome, { recursive: true });
const binName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
writeFileSync(path.join(pathDir, binName), 'x', { mode: 0o700 });
check('裸文件名按 PATH 解析（不再直接判缺失）',
  findCloudflared(binName, { HOME: emptyHome, USERPROFILE: emptyHome, PATH: pathDir })
  === path.join(pathDir, binName),
  String(findCloudflared(binName, { HOME: emptyHome, USERPROFILE: emptyHome, PATH: pathDir })));

// 版本目录按数字比较：字符串排序会把 2026.9.1 排在 2026.11.1 前面（装新版本却用旧的）
const compRoot = path.join(fakeHome, '.dsh', 'mobile-access', 'components', 'cloudflared');
for (const v of ['2026.9.1', '2026.11.1']) {
  mkdirSync(path.join(compRoot, v), { recursive: true });
  writeFileSync(path.join(compRoot, v, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'), 'x', { mode: 0o700 });
}
check('组件目录按版本号数值取最新（2026.11.1 > 2026.9.1）',
  findCloudflared('auto', { HOME: fakeHome, USERPROFILE: fakeHome, PATH: '' }) === path.join(compRoot, '2026.11.1', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'),
  findCloudflared('auto', { HOME: fakeHome, USERPROFILE: fakeHome, PATH: '' }));

// ---- 12. 新机器真实路径：装好即可开通（不再信任构造时的裸名字）----
// 现场：Windows 全新机器 PATH 里没有 cloudflared，插件启动时 tunnelExecutable='cloudflared.exe'，
// 用户装完后同一次会话点开通 —— 若开通器直接 execFile('cloudflared.exe') 就 ENOENT。
const prov = new LocalProvisioner({
  executable: process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared',
  env: { HOME: fakeHome, USERPROFILE: fakeHome, PATH: '' },
  homeDir: fakeHome,
  stateFile: null,
  baseDomain: 'matrixboard.cn',
});
check('开通器按发现链解析出组件目录里的绝对路径',
  prov.notConfiguredDetail.includes(fakeBin), prov.notConfiguredDetail);
check('开通文案带上实际域名（不再写死）', prov.notConfiguredDetail.includes('matrixboard.cn'));
const elsewhere = path.join(tmp, 'installed-elsewhere');
writeFileSync(elsewhere, 'x', { mode: 0o700 });
prov.useExecutable(elsewhere);
check('安装完成后可用 useExecutable 回填新路径',
  prov.notConfiguredDetail.includes('installed-elsewhere'), prov.notConfiguredDetail);

console.log(`\n结果：${pass} 通过 / ${failures.length} 失败\n`);
if (failures.length) process.exit(1);

function readHeadOf(file) {
  const fd = openSync(file, 'r');
  const b = Buffer.alloc(8);
  readSync(fd, b, 0, 8, 0);
  closeSync(fd);
  return b;
}
