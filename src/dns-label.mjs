// dns-label.mjs — 子域 label 的派生与校验（开通器与本地管理型共用）
//
// 单独成文件是为了避免 cloudflare.mjs ↔ provision-local.mjs 互相 import 造成环。

import crypto from 'node:crypto';
import { fail } from './protocol.mjs';

const LABEL_MAX = 63;

/** 子域 label 必须能过 DNS：小写字母数字与中划线，首尾不能是中划线。 */
export function isValidLabel(label) {
  return typeof label === 'string'
    && label.length > 0
    && label.length <= LABEL_MAX
    && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label);
}

/**
 * 由安装标识派生稳定子域。
 *
 * 为什么是哈希而不是 hostId：cordis 宿主上报的 hostId 对所有机器都是
 * `host_cordis`（不是唯一标识），直接拿来当子域会让第一台之后的机器全部撞名。
 * 哈希还顺带避免把机器名/用户名写进公开 DNS。
 */
export function deriveSubdomain(seed, { prefix = 'dsh', hashLen = 10 } = {}) {
  if (!seed) throw fail(4400, '派生隧道子域需要安装标识');
  const n = Math.min(32, Math.max(8, hashLen));
  const digest = crypto.createHash('sha256').update(String(seed)).digest('hex').slice(0, n);
  const label = `${prefix}-${digest}`;
  if (!isValidLabel(label)) throw fail(4400, `派生出的子域不合法：${label}`);
  return label;
}
