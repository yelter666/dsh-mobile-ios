// tunnel-state.mjs — 固定地址本地状态的**读写与归属校验**（唯一入口）
//
// 事故背景（2026-11-21，新 Mac 装插件后分配不出固定地址）：
// 本机 `~/.cloudflared/cert.pem` 是另一个 Cloudflare 账号签发的旧证书，
// 插件却只检查「文件存在」就当已登录，于是隧道能建、写 DNS 才失败，
// 面板只留一句「写入 DNS 失败」，用户无从下手。
//
// 同一类问题还有第二个形态：**状态文件被跨机复用**。
//   · 用户把 ~/.dsh 连同 tunnel-named.json 一起拷到新机器；
//   · 或者网盘/迁移工具把整个 home 同步过去；
//   · 状态里记着上一台机器的 tunnelId / credentialsFile / hostname。
// 若直接信这份状态，新机器会对外宣称一个指向**旧机器**的固定地址，
// 面板显示「已开通」，扫码却连到别人那里——比报错更糟。
//
// 因此状态文件的读必须带「这台机器是不是它的主人」这一条：
//   · machine.id 与当前机器不同 → 外来状态，整份作废并重新派生地址；
//   · credentialsFile 不存在 → 状态在本机不可用（缺 tunnel 凭据跑不起来）；
//   · 都没有（0.2.18 之前的旧状态）→ 认领，补写 machine 字段。
//
// 注：状态结构保持 version: 1，新字段全部可选——老插件读到新文件也只是忽略，
// 不需要迁移逻辑，升级与回滚都不会丢地址。

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const STATE_VERSION = 1;
const MACHINE_FILE = 'machine-id';

/**
 * 读状态文件。不存在/结构不符都当「没有」，绝不抛。
 * 结构不符时留一份备份，方便用户把地址找回来（与设备注册表同一取舍）。
 */
export function readState(file, log) {
  if (!file) return null;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') log?.(`tunnel 本地开通状态不可用：${err.message}`);
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || parsed.version !== STATE_VERSION) throw new Error('结构不符');
    return parsed;
  } catch (err) {
    const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      fs.renameSync(file, backup);
      log?.(`tunnel 状态损坏，已备份到 ${path.basename(backup)}（${err.message}）`);
    } catch {
      log?.(`tunnel 状态损坏且备份失败（${err.message}）`);
    }
    return null;
  }
}

export function writeState(file, state) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: STATE_VERSION, ...state }, null, 2), { mode: 0o600, flag: 'w' });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* 刚写即 0600 */ }
}

/**
 * 本机的持久标识。
 *
 * 放在状态文件同目录（生产是 ~/.dsh/mobile-access/），0600。
 * 为什么不用 hostname：改机器名、切网络都会变，拿它做身份会把正常机器判成新机器；
 * 而 machine-id 只在首次运行时生成一次，稳定且不依赖系统信息。
 * 目录整体被拷贝时 id 会跟着走——这种情况由 credentialsFile 存在性兜底（见 isStateUsable）。
 */
export function machineIdentity({ stateFile = null, hostname = null } = {}) {
  if (!stateFile) return null;
  const dir = path.dirname(stateFile);
  const file = path.join(dir, MACHINE_FILE);
  let id = null;
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{16,64}$/i.test(raw)) id = raw.toLowerCase();
  } catch { /* 没有就建 */ }
  if (!id) {
    id = crypto.randomBytes(16).toString('hex');
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, `${id}\n`, { mode: 0o600, flag: 'w' });
      try { fs.chmodSync(file, 0o600); } catch { /* 刚写即 0600 */ }
    } catch {
      // 写不进去（只读目录/权限）不能挡住开通：退化成「无身份」，行为等同旧版本
      return null;
    }
  }
  return { id, hostname: hostname || os.hostname() };
}

/** 状态里记的机器身份是否与当前机器不同（不同 = 从别的电脑拷来的）。 */
export function isForeignState(state, machine) {
  if (!state || !machine?.id) return false;
  const recorded = state.machine?.id;
  // 旧状态没有 machine 字段：无法判断，按「认领」处理（不重建，避免老用户地址漂移）
  if (!recorded) return false;
  return String(recorded).toLowerCase() !== String(machine.id).toLowerCase();
}

/**
 * 这份状态在本机是否**可执行**：tunnel 凭据文件必须还在。
 *
 * 只查状态里记的路径（不探测网络）：凭据缺失时隧道根本起不来，
 * 继续对外宣称这个地址就是给用户一个必然失败的扫码结果。
 */
export function hasLocalCredentials(state) {
  if (!state?.credentialsFile) return false;
  try {
    return fs.statSync(state.credentialsFile).isFile();
  } catch {
    return false;
  }
}
