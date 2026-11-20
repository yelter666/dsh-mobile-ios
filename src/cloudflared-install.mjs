// cloudflared-install.mjs — cloudflared 自举安装（每机首次开启远程时按需下载）
//
// 设计原则：
// 1. **只在用户确认后下载**：调用方（桌面面板）必须先弹窗得到同意，本模块不静默下载执行。
// 2. **只用官方源、只落私有目录**：从 Cloudflare 官方 GitHub Release 下载，写到
//    ~/.dsh/mobile-access/components/cloudflared/<version>/，不改系统 PATH、不装到 Program Files。
// 3. **如实校验**：GitHub Release 不提供 checksum 文件，故校验 HTTPS + HTTP 200 + 官方字节数
//    + 落盘后按平台嗅探可执行文件魔数（PE / Mach-O / ELF）。任何一步不过就删临时文件并报错，
//    绝不把残缺或错平台的文件交给启动器。
// 4. **幂等**：目标已存在且大小吻合直接返回，不重复下载。

import { closeSync, mkdirSync, openSync, readSync, writeFileSync, existsSync, statSync, unlinkSync, chmodSync, renameSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { extractTgzEntry } from './tar.mjs';

export { extractTgzEntry as extractTarGz } from './tar.mjs';

export const CLOUDFLARED_RELEASE = '2026.11.1';
const RELEASE_BASE = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_RELEASE}`;

// 官方 Release 资产与预期字节数（2026-11-20 实测 api.github.com 的 size 字段）。
// 只列出我们支持的平台；未知平台由调用方降级为「手动安装」，不猜测下载地址。
//
// macOS 只提供 .tgz（内含 cloudflared），Linux/Windows 是裸二进制 —— 这条差别曾经被忽略：
// 早先的实现把 .tgz 整个写成了目标文件，装完 chmod 也「成功」，但一执行就报格式错误。
// archive 字段就是为这条差别显式建模的。
const ASSETS = {
  win32: {
    x64: { file: 'cloudflared-windows-amd64.exe', size: 55483112, bin: 'cloudflared.exe', archive: null, magic: 'pe' },
    ia32: { file: 'cloudflared-windows-386.exe', size: 38157960, bin: 'cloudflared.exe', archive: null, magic: 'pe' },
  },
  darwin: {
    x64: { file: 'cloudflared-darwin-amd64.tgz', size: 21857340, bin: 'cloudflared', archive: 'tgz', magic: 'macho' },
    arm64: { file: 'cloudflared-darwin-arm64.tgz', size: 19898712, bin: 'cloudflared', archive: 'tgz', magic: 'macho' },
  },
  linux: {
    x64: { file: 'cloudflared-linux-amd64', size: 40346301, bin: 'cloudflared', archive: null, magic: 'elf' },
    arm64: { file: 'cloudflared-linux-arm64', size: 37818397, bin: 'cloudflared', archive: null, magic: 'elf' },
  },
};

/** 解析当前平台对应的资产。未知平台/架构返回 null（调用方降级为手动安装）。 */
export function resolveAsset({ platform = process.platform, arch = process.arch } = {}) {
  const byArch = ASSETS[platform];
  if (!byArch) return null;
  const asset = byArch[arch];
  if (!asset) return null;
  return { ...asset, url: `${RELEASE_BASE}/${asset.file}` };
}

/** home 解析：与 tunnel.mjs 的 findCloudflared 保持一致（USERPROFILE/HOME 优先）。 */
export function resolveHome(env = process.env) {
  return env.USERPROFILE || env.HOME || os.homedir();
}

/** 组件目录：与 tunnel.mjs 的 findCloudflared 保持同一路径约定。 */
export function componentBinDir({ home, version = CLOUDFLARED_RELEASE, env = process.env } = {}) {
  const base = home || resolveHome(env);
  return path.join(base, '.dsh', 'mobile-access', 'components', 'cloudflared', version);
}

/** 只读前 8 字节判魔数：别为了嗅探把 50MB 的二进制整个读进内存。 */
function readHead(file, bytes = 8) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * 可执行文件魔数嗅探。
 *
 * 为什么值得做：字节数与 HTTP 200 都只能证明「下载完整」，证明不了「这是本平台的可执行文件」。
 * macOS 的 .tgz 事故（把压缩包当二进制写盘）就是靠这条能立刻拦住。
 */
export function sniffBinary(buf, platform = process.platform) {
  if (!buf || buf.length < 4) return 'unknown';
  const want = platform === 'win32' ? 'pe' : platform === 'darwin' ? 'macho' : 'elf';
  const unix =
    buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46 ? 'elf'
      : buf[0] === 0x4d && buf[1] === 0x5a ? 'pe'
        : [0xfeedfacf, 0xfeedface, 0xcafebabe, 0xcefaedfe, 0xcffaedfe].includes(buf.readUInt32BE(0)) ? 'macho'
          : 'unknown';
  return unix === want ? want : unix;
}

/**
 * 确保 cloudflared 二进制存在于组件目录。返回 { installed, executable, version, reused }。
 * fetchImpl 注入便于测试；默认用全局 fetch。
 */
export async function ensureCloudflared({
  version = CLOUDFLARED_RELEASE,
  destDir,
  platform = process.platform,
  arch = process.arch,
  fetchImpl = globalThis.fetch,
  signal,
} = {}) {
  const asset = resolveAsset({ platform, arch });
  if (!asset) {
    const err = new Error(`暂不支持自动安装：${platform}/${arch} 无官方构建`);
    err.code = 'UNSUPPORTED_PLATFORM';
    throw err;
  }
  const dir = destDir || componentBinDir({ version });
  const target = path.join(dir, asset.bin);
  const expected = asset.size;

  // 幂等：已存在且大小吻合、且魔数正确才复用（只看大小会把「上次写坏的 .tgz」当成装好了）
  if (existsSync(target)) {
    const actual = statSync(target).size;
    const okSize = expected === 0 || actual === expected;
    let okMagic = true;
    if (okSize) {
      try {
        okMagic = sniffBinary(readHead(target), platform) !== 'unknown';
      } catch {
        okMagic = false;
      }
    }
    if (okSize && okMagic) {
      return { installed: true, executable: target, version, reused: true };
    }
    // 残缺或格式不对：删掉重下（旧版把 .tgz 当二进制写坏的机器靠这一步自愈）
    try { unlinkSync(target); } catch { /* 落到下面覆盖写 */ }
  }

  if (typeof fetchImpl !== 'function') {
    const err = new Error('当前运行时不支持下载，请手动安装 cloudflared');
    err.code = 'NO_FETCH';
    throw err;
  }

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const partial = `${target}.partial`;
  let res;
  try {
    res = await fetchImpl(asset.url, { signal });
  } catch (err) {
    const e = new Error(`下载 cloudflared 失败：${err?.message || err}`);
    e.code = 'DOWNLOAD_FAILED';
    throw e;
  }
  if (!res.ok) {
    const e = new Error(`下载 cloudflared 失败：HTTP ${res.status}`);
    e.code = 'DOWNLOAD_FAILED';
    throw e;
  }

  let raw;
  try {
    raw = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    const e = new Error(`读取 cloudflared 内容失败：${err?.message || err}`);
    e.code = 'DOWNLOAD_FAILED';
    throw e;
  }
  if (raw.length === 0 || (expected > 0 && raw.length !== expected)) {
    const e = new Error(`cloudflared 大小校验失败：期望 ${expected}，实际 ${raw.length}`);
    e.code = 'SIZE_MISMATCH';
    throw e;
  }

  let bin = raw;
  if (asset.archive === 'tgz') bin = extractTgzEntry(raw, asset.bin);
  if (sniffBinary(bin, platform) !== asset.magic) {
    const e = new Error(`cloudflared 二进制格式不符（期望 ${asset.magic}）`);
    e.code = 'BAD_BINARY';
    throw e;
  }

  try {
    writeFileSync(partial, bin, { mode: 0o700 });
    renameSync(partial, target);
    // Windows 的 chmod 只认读写位；POSIX 补执行位
    try { chmodSync(target, 0o755); } catch { /* Windows 忽略 */ }
  } catch (err) {
    try { if (existsSync(partial)) unlinkSync(partial); } catch { /* 尽力清理 */ }
    const e = new Error(`写入 cloudflared 失败：${err?.message || err}`);
    e.code = 'WRITE_FAILED';
    throw e;
  }

  return {
    installed: true,
    executable: target,
    version,
    reused: false,
    size: bin.length,
    archiveSize: raw.length,
  };
}
