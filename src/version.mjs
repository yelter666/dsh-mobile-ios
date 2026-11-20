// src/version.mjs — 插件版本号的唯一真相源（single source of truth）
//
// 事故背景：面板「插件版本」走 summary.version（rest.mjs 的 GATEWAY_VERSION），
// 插件详情走 npm 包元数据 package.json，更新检查拿前者比对 npm latest。
// 发版时 npm version 只改了 package.json，两处硬编码仍停在 0.2.1，
// 于是详情显示 v0.2.2、面板显示 v0.2.1、更新检查误报「发现新版」。
//
// 修复：所有展示与比对统一从 package.json 读取，杜绝多处硬编码漂移。
// npm 始终会把 package.json 打进 tarball（无论 files 字段），故运行时可读。

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let loaded;
try {
  loaded = require('../package.json').version;
} catch (err) {
  // 读不到版本号是打包异常，必须显式失败，绝不能回退到某个写死的版本号
  // ——那正是本次事故的根因。
  throw new Error(`[dsh-mobile-ios] 无法从 package.json 读取版本号：${err.message}`);
}

export const PLUGIN_VERSION = String(loaded);
