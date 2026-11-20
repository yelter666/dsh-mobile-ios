// plugin-update.mjs — 插件自更新（不依赖宿主插件管理器）
//
// 为什么需要它：宿主是否暴露 `remote.pluginManager.installBundle` 取决于版本与平台，
// 拿不到时面板只能让用户「复制包名 → 去插件页粘贴」，而 dsh-app:// 这类自定义协议
// 页面里 navigator.clipboard 与 document.execCommand('copy') 都可能不可用，
// 于是「一键更新」在最需要它的机器上恰恰用不了。
//
// 这里走的是网关进程自己动手：从 npm registry 取 tarball → 按 dist.shasum 校验 →
// 解包到临时目录 → 备份旧目录 → 覆盖安装目录。全程不依赖宿主 API、不依赖 shell 别名，
// 只用 Node 内置能力 + 系统 tar（Win10 1803+ 自带的 bsdtar 命名为 tar.exe）。
//
// 边界与克制：
//   · 只装本插件自己的 npm 包，不接受任意包名/任意 URL（避免变成通用下载执行器）；
//   · 校验 shasum 不通过一律中止，绝不落盘；
//   · 覆盖前先整目录备份，失败可回滚（返回 backup 路径）；
//   · 不做「静默后台更新」，只由面板弹窗里的明确点击触发。

import { createHash } from 'node:crypto';
import { execFile as nodeExecFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(nodeExecFile);

export const PLUGIN_NAME = 'dsh-mobile-ios';

/** 官方源优先，镜像作备用（国内网络下官方源偶发超时）。 */
export const PLUGIN_REGISTRIES = [
  'https://registry.npmjs.org',
  'https://registry.npmmirror.com',
];

/**
 * 本模块所在包根目录（`<...>/node_modules/dsh-mobile-ios`）。
 * `src/plugin-update.mjs` 的上一级目录就是包根。
 */
export function pluginRootFrom(url = import.meta.url) {
  return path.dirname(path.dirname(fileURLToPath(url)));
}

function readVersion(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

function sha1(buf) {
  return createHash('sha1').update(buf).digest('hex');
}

/** 取 registry 元数据：目标版本（缺省 latest）的 tarball 地址与 shasum。 */
async function loadMetadata(registry, { name = PLUGIN_NAME, target = null, fetchImpl }) {
  const res = await fetchImpl(`${registry}/${name}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
  });
  if (!res.ok) throw new Error(`registry ${registry} 返回 ${res.status}`);
  const body = await res.json();
  const version = target || body?.['dist-tags']?.latest;
  if (!version) throw new Error('registry 元数据里没有可安装版本');
  const entry = body?.versions?.[version];
  if (!entry?.dist?.tarball) throw new Error(`registry 缺少 ${version} 的 tarball 信息`);
  return { version, tarball: entry.dist.tarball, shasum: entry.dist.shasum || null };
}

/**
 * 下载并安装指定版本到 `pluginRoot`。
 *
 * @param {object} opts
 * @param {string|null} opts.target 目标版本；null = 跟随 registry latest
 * @param {string|null} opts.registry 指定源；null = 官方源优先、镜像备用
 * @param {string} opts.pluginRoot 安装目录（默认本包根）
 * @param {Function} opts.fetchImpl 可注入（测试不联网）
 * @param {Function} opts.execImpl 可注入（测试不解包）
 * @returns {Promise<{ok:boolean, from:string|null, to:string, changed:boolean, root:string, backup:string|null, restartRequired:boolean}>}
 */
export async function selfUpdatePlugin({
  target = null,
  registry = null,
  pluginRoot = pluginRootFrom(),
  fetchImpl = globalThis.fetch,
  execImpl = execFileAsync,
  log = () => {},
} = {}) {
  const registries = registry ? [registry] : PLUGIN_REGISTRIES;
  let meta = null;
  let lastError = null;
  for (const reg of registries) {
    try {
      meta = await loadMetadata(reg, { target, fetchImpl });
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (!meta) throw new Error(`无法获取版本信息：${lastError?.message || '未知错误'}`);

  const from = readVersion(pluginRoot);
  if (from === meta.version) {
    log(`plugin 已是 ${from}，无需更新`);
    return { ok: true, from, to: meta.version, changed: false, root: pluginRoot, backup: null, restartRequired: false };
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-update-'));
  const tgz = path.join(tmpRoot, 'pkg.tgz');
  const outDir = path.join(tmpRoot, 'unpacked');
  try {
    log(`plugin 下载 ${meta.tarball}`);
    const res = await fetchImpl(meta.tarball);
    if (!res.ok) throw new Error(`下载 tarball 失败：HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1024) throw new Error(`下载内容异常（${buf.length} 字节）`);
    if (meta.shasum) {
      const actual = sha1(buf);
      if (actual !== String(meta.shasum).toLowerCase()) {
        throw new Error(`完整性校验失败（期望 ${meta.shasum}，实际 ${actual}）`);
      }
    }
    fs.writeFileSync(tgz, buf);

    fs.mkdirSync(outDir, { recursive: true });
    await execImpl('tar', ['-xzf', tgz, '-C', outDir], { timeout: 120_000 });

    const unpacked = path.join(outDir, 'package');
    if (!fs.existsSync(path.join(unpacked, 'package.json'))) throw new Error('解包后缺少 package.json');
    const got = readVersion(unpacked);
    if (got !== meta.version) throw new Error(`解包版本不符（期望 ${meta.version}，实际 ${got}）`);

    // 备份：整目录复制到同级，命名为 .<name>.backup-<from>-<ts>
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = path.join(path.dirname(pluginRoot), `.${path.basename(pluginRoot)}.backup-${from || 'unknown'}-${stamp}`);
    fs.cpSync(pluginRoot, backup, { recursive: true, force: true });
    log(`plugin 已备份到 ${backup}`);

    fs.cpSync(unpacked, pluginRoot, { recursive: true, force: true });
    const now = readVersion(pluginRoot);
    if (now !== meta.version) throw new Error(`覆盖后版本仍为 ${now}，更新未生效`);

    log(`plugin 已更新 ${from || '?'} → ${meta.version}`);
    return { ok: true, from, to: meta.version, changed: true, root: pluginRoot, backup, restartRequired: true };
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响结果 */ }
  }
}
