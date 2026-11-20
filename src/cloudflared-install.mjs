// cloudflared-install.mjs — cloudflared 自举安装（每机首次开启远程时按需下载）
//
// 设计原则：
// 1. **只在用户确认后下载**：调用方（桌面面板）必须先弹窗得到同意，本模块不静默下载执行。
// 2. **只用官方源、只落私有目录**：从 Cloudflare 官方 GitHub Release 下载，写到
//    ~/.dsh/mobile-access/components/cloudflared/<version>/，不改系统 PATH、不装到 Program Files。
// 3. **如实校验**：GitHub Release 不提供 checksum 文件，故校验 HTTPS + HTTP 200 + 预期字节数；
//    校验不过就删除临时文件并报错，绝不把残缺二进制交给启动器。
// 4. **幂等**：目标已存在且大小吻合直接返回，不重复下载。

import { mkdirSync, writeFileSync, existsSync, statSync, unlinkSync, chmodSync, renameSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const CLOUDFLARED_RELEASE = '2026.11.1';
const RELEASE_BASE = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_RELEASE}`;

// 官方 Release 资产与预期字节数（2026-11-20 实测 api.github.com/releases/latest 的 size 字段）。
// 只列出我们支持的平台；未知平台由调用方降级为「手动安装」，不猜测下载地址。
const ASSETS = {
  win32: {
    x64: { file: 'cloudflared-windows-amd64.exe', size: 55483112, bin: 'cloudflared.exe' },
    ia32: { file: 'cloudflared-windows-386.exe', size: 38157960, bin: 'cloudflared.exe' },
  },
  darwin: {
    x64: { file: 'cloudflared-darwin-amd64.tgz', size: 21857340, bin: 'cloudflared' },
    arm64: { file: 'cloudflared-darwin-arm64.tgz', size: 0, bin: 'cloudflared' },
  },
  linux: {
    x64: { file: 'cloudflared-linux-amd64', size: 40346301, bin: 'cloudflared' },
    arm64: { file: 'cloudflared-linux-arm64', size: 0, bin: 'cloudflared' },
  },
};

/** 解析当前平台对应的资产。size=0 表示未实测，跳过严格大小校验（仍校验 HTTP 200 + 非空）。 */
export function resolveAsset({ platform = process.platform, arch = process.arch } = {}) {
  const byArch = ASSETS[platform];
  if (!byArch) return null;
  const asset = byArch[arch] || (arch === 'x64' ? byArch.amd64 : null);
  if (!asset) return null;
  return { ...asset, url: `${RELEASE_BASE}/${asset.file}` };
}

/** home 解析：与 tunnel.mjs 的 findCloudflared 保持一致（USERPROFILE/HOME 优先）。 */
export function resolveHome(env = process.env) {
  return env.USERPROFILE || env.HOME || os.homedir();
}

/** 组件目录：与 entries/plugin.mjs 的 discoverCloudflared 保持同一路径约定。 */
export function componentBinDir({ home, version = CLOUDFLARED_RELEASE, env = process.env } = {}) {
  const base = home || resolveHome(env);
  return path.join(base, '.dsh', 'mobile-access', 'components', 'cloudflared', version);
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

  // 幂等：已存在且大小吻合（或 size=0 未登记）直接复用
  if (existsSync(target)) {
    const actual = statSync(target).size;
    if (expected === 0 || actual === expected) {
      return { installed: true, executable: target, version, reused: true };
    }
    // 大小不符：视为残缺，删除后重下
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

  let buf;
  try {
    buf = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    const e = new Error(`读取 cloudflared 内容失败：${err?.message || err}`);
    e.code = 'DOWNLOAD_FAILED';
    throw e;
  }
  if (buf.length === 0 || (expected > 0 && buf.length !== expected)) {
    const e = new Error(`cloudflared 大小校验失败：期望 ${expected}，实际 ${buf.length}`);
    e.code = 'SIZE_MISMATCH';
    throw e;
  }

  try {
    writeFileSync(partial, buf, { mode: 0o700 });
    if (expected > 0 && statSync(partial).size !== expected) {
      throw new Error('落盘后大小校验失败');
    }
    renameSync(partial, target);
    // Windows 的 chmod 只认读写位；POSIX 补执行位
    try { chmodSync(target, 0o700); } catch { /* Windows 忽略 */ }
  } catch (err) {
    try { if (existsSync(partial)) unlinkSync(partial); } catch { /* 尽力清理 */ }
    const e = new Error(`写入 cloudflared 失败：${err?.message || err}`);
    e.code = 'WRITE_FAILED';
    throw e;
  }

  return { installed: true, executable: target, version, reused: false, size: buf.length };
}
