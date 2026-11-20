// plugin-update.mjs — 插件自更新（不依赖宿主插件管理器）
//
// 为什么需要它：宿主是否暴露 `remote.pluginManager.installBundle` 取决于版本与平台，
// 拿不到时面板只能让用户「复制包名 → 去插件页粘贴」，而 dsh-app:// 这类自定义协议
// 页面里 navigator.clipboard 与 document.execCommand('copy') 都可能不可用，
// 于是「一键更新」在最需要它的机器上恰恰用不了。
//
// 这里走的是网关进程自己动手：从 npm registry 取 tarball → 按 dist.shasum 校验 →
// 解包到临时目录 → 备份旧目录 → 覆盖安装目录。全程不依赖宿主 API，
// 解包优先用内置实现（src/tar.mjs，零依赖、三平台一致），
// 只有遇到内置解析不了的老式归档才回退到系统 tar（Win10 1803+ 的 bsdtar）。
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
import { extractTgzToDir } from './tar.mjs';

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

/** 锁文件里我们这一个包的条目重写：importers / packages / snapshots 三处都要对齐。 */
function rewriteLock(text, { from, to, specifier, integrity }) {
  const lines = text.split('\n');
  const headPattern = new RegExp(`^(\\s{2})${PLUGIN_NAME}@([^:\\s]+):(.*)$`);
  const depPattern = new RegExp(`^(\\s+)${PLUGIN_NAME}:\\s*$`);
  for (let i = 0; i < lines.length; i += 1) {
    // ① importers 下的 specifier / version
    const dep = lines[i].match(depPattern);
    if (dep) {
      const baseIndent = dep[1].length;
      for (let j = i + 1; j < lines.length; j += 1) {
        if (!lines[j].trim()) continue;
        const indent = lines[j].length - lines[j].trimStart().length;
        if (indent <= baseIndent) break;
        const kv = lines[j].match(/^(\s*)(specifier|version):\s*(.+)$/);
        if (!kv) continue;
        if (kv[2] === 'specifier' && specifier) lines[j] = `${kv[1]}specifier: ${specifier}`;
        // version 可能带 peer 后缀，只替换版本前缀
        if (kv[2] === 'version' && kv[3].trim().split('(')[0] === from) {
          lines[j] = `${kv[1]}version: ${to}${kv[3].trim().slice(from.length)}`;
        }
      }
    }
    // ② packages / snapshots 的条目头，紧随其后的 resolution.integrity 一并改
    const head = lines[i].match(headPattern);
    if (head && head[2] === from) {
      lines[i] = `${head[1]}${PLUGIN_NAME}@${to}:${head[3]}`;
      for (let j = i + 1; j < lines.length; j += 1) {
        if (!lines[j].trim()) continue;
        if (!/^\s{4}/.test(lines[j])) break;
        if (integrity && /^\s*resolution:/.test(lines[j])) {
          lines[j] = lines[j].replace(/integrity:\s*[^,}]+/, `integrity: ${integrity}`);
        }
      }
    }
  }
  return lines.join('\n');
}

/**
 * 自更新后同步宿主配置档里的「版本钉」。
 *
 * 为什么必须做：安装目录是宿主包管理器（pnpm）托管的，它的 package.json
 * dependencies 与 pnpm-lock.yaml 都钉着具体版本。只替换 node_modules 里的文件，
 * 下一次 `pnpm install`（插件开关、配置档修复都会触发）就按旧钉重装，自更新被静默
 * 回滚——在 macOS 上表现为「刚修好的自动安装又坏了」。所以这里把 specifier 与
 * 锁文件三处一起改到新版本，并用下载到的 tarball 现算 integrity，避免锁文件校验不过。
 *
 * 只在「确实装在 node_modules 里」时动手：开发态直接跑仓库目录，上层不是配置档。
 */
export function syncProfilePin({ pluginRoot, version, tarball, log = () => {} }) {
  if (path.basename(pluginRoot) !== PLUGIN_NAME) return { synced: false, reason: 'not-plugin-root', path: null };
  const modulesDir = path.dirname(pluginRoot);
  if (path.basename(modulesDir) !== 'node_modules') return { synced: false, reason: 'not-in-node-modules', path: null };
  const profileRoot = path.dirname(modulesDir);
  const manifestPath = path.join(profileRoot, 'package.json');
  if (!fs.existsSync(manifestPath)) return { synced: false, reason: 'no-profile-manifest', path: null };

  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return { synced: false, reason: 'bad-profile-manifest', path: null };
  }
  const deps = manifest?.dependencies;
  if (!deps || !Object.prototype.hasOwnProperty.call(deps, PLUGIN_NAME)) {
    return { synced: false, reason: 'not-a-dependency', path: null };
  }

  const old = String(deps[PLUGIN_NAME]);
  // 保留用户/宿主原本的区间写法（^ 或 ~），只换版本号
  const next = /^[\^~]/.test(old) ? `${old[0]}${version}` : version;
  let changed = false;
  if (old !== next) {
    deps[PLUGIN_NAME] = next;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    changed = true;
  }

  const lockPath = path.join(profileRoot, 'pnpm-lock.yaml');
  if (fs.existsSync(lockPath)) {
    const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
    const before = fs.readFileSync(lockPath, 'utf8');
    const after = rewriteLock(before, {
      from: old.replace(/^[\^~]/, ''),
      to: version,
      specifier: next,
      integrity,
    });
    if (after !== before) {
      fs.writeFileSync(lockPath, after);
      log(`配置档锁文件已同步 ${PLUGIN_NAME}@${version}`);
      changed = true;
    }
  }
  return { synced: changed, reason: changed ? 'ok' : 'already-current', path: manifestPath };
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
    try {
      extractTgzToDir(buf, outDir);
    } catch (err) {
      // 内置解析只认 ustar/GNU 常规文件；老式归档或特殊条目回退到系统 tar。
      // Windows 老版本可能没有 tar.exe，那时错误会同时列出两条原因。
      log(`plugin 内置解包失败（${err.message}），改用系统 tar`);
      try {
        await execImpl('tar', ['-xzf', tgz, '-C', outDir], { timeout: 120_000 });
      } catch (tarErr) {
        throw new Error(`解包失败：${err.message}；系统 tar 亦不可用（${tarErr?.message || tarErr}）`);
      }
    }

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

    // 同步配置档版本钉：不同步的话，下次宿主 install 会按旧钉把自更新悄悄回滚。
    // 这一步失败不影响本次更新（磁盘上已是新版），只记录原因。
    let pin = { synced: false, reason: 'skipped' };
    try {
      pin = syncProfilePin({ pluginRoot, version: meta.version, tarball: buf, log });
      if (pin.synced) log(`配置档版本钉同步到 ${meta.version}`);
    } catch (err) {
      log(`配置档版本钉同步失败（${err?.message || err}）：下次宿主安装可能装回旧版`);
    }

    log(`plugin 已更新 ${from || '?'} → ${meta.version}`);
    return {
      ok: true, from, to: meta.version, changed: true, root: pluginRoot, backup,
      restartRequired: true, pinSynced: pin.synced,
    };
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响结果 */ }
  }
}
