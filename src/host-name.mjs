// host-name.mjs — 给人看的电脑名（2026-11-21）
//
// 为什么不再直接用 os.hostname()：
//   · macOS 上它返回的是 Bonjour 名（`MacBook-Air-15-M4.local`），手机设置页里
//     跟着一串 `.local` 只会让人疑惑「这是什么东西」，而且短横线也不是用户认得的名字；
//   · 用户认得的是**电脑名称**（系统设置 → 通用 → 共享 → 电脑名称），
//     `scutil --get ComputerName` 给的正是那个全称（`MacBook Air 15 M4`）。
//
// 取舍：这里是纯展示文字，但只在进程启动时算一次（scutil 有 ~10ms 的进程开销），
// 拿不到就退回截断 `.local` 的 hostname —— 名字不漂亮可以接受，名字空掉不行。

import os from 'node:os';
import { execFileSync } from 'node:child_process';

/** 去掉 Bonjour 的 `.local`（含可能的结尾点）：`a.local` → `a`，其余原样。 */
export function stripLocalSuffix(name) {
  return String(name ?? '')
    .trim()
    .replace(/\.local\.?$/i, '')
    .trim();
}

/**
 * 电脑的全称：macOS 用 ComputerName，其他平台退回 hostname。
 * 失败一律退到 hostname（截断 `.local`），绝不返回空串。
 */
export function displayHostName({ platform = process.platform } = {}) {
  if (platform === 'darwin') {
    try {
      const name = execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], {
        encoding: 'utf8',
        timeout: 1500,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (name) return name;
    } catch {
      // 没有 scutil / 超时 / 权限异常：退回 hostname，不在启动路径上抛错。
    }
  }
  const fallback = stripLocalSuffix(os.hostname());
  return fallback || 'DSH 主机';
}
