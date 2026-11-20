// zone-health.mjs — 「域名到底归谁、公网到底在服务哪一份 zone」
//
// 为什么需要这个模块：DNS 解析失败只是**症状**，原因是 zone 层面的事，而面板原来
// 一律解释成「zone 处于 pending」——这在真实世界里会把人带偏。
//
// Cloudflare 的 zone 有四种会让地址「开通成功但解析不到」的状态：
//   · active      公网 NS 指向本账号、记录正常下发       —— 正常
//   · pending     域名已加进本账号，但注册商 NS 还没指过来 —— 改 NS 即可
//   · moved       域名已被**另一个 Cloudflare 账号**接管   —— 本账号写什么都无效，
//                 公网 NS 是对方那一对（每个账号的 NS 对是固定的，所以能直接看出来）
//   · 记录在某台机器上被 --overwrite-dns 改指到另一条隧道  —— 见 findDnsOwner()
//
// 本机 `cloudflared tunnel login` 生成的 cert.pem 里就带着 zoneID / accountID /
// 一份 zone 范围的 apiToken，因此**不需要额外凭据**就能只读地问清 zone 状态。
// 这里只做 GET，绝不写；token 只在函数内部流转，不进状态文件、不进日志。
//
// 另一条硬约束：所有失败都必须**降级为 null**（返回「不知道」），不能让一个
// 查不到状态的网络问题把本来能用的固定地址判死。

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

/** zone 状态码 → 面板可读的一句话（短，塞得进 300px 宽的面板）。 */
export const ZONE_STATUS_HINT = {
  active: '域名在 Cloudflare 已生效',
  pending: '域名在本账号尚未生效（zone pending），公网 NS 没指向本账号',
  moved: '域名已被另一个 Cloudflare 账号接管（zone moved），本账号写入的记录不再下发',
  initializing: '域名正在本账号初始化（zone initializing）',
};

/** 诊断码 → 短提示。code 比 status 更适合面板：它已经带上了「NS 对不对」的结论。 */
export const ZONE_CODE_HINT = {
  moved: '域名已被另一个 Cloudflare 账号接管，公网 NS 指向对方，本机写入的记录不会生效',
  pending: '域名在本账号还没生效（zone pending）：公网 NS 还没指向本账号分配的那一对',
  'ns-mismatch': '域名在本账号显示已生效，但公网 NS 与本账号分配的不一致',
  unresolved: '域名在 Cloudflare 已生效，但公网仍解析不到这台主机的地址',
};

/**
 * 读 cert.pem 里的 zone 身份。结构是 PEM 包一层 base64(JSON)。
 * @returns {{ zoneId: string|null, accountId: string|null, apiToken: string|null }|null}
 */
export function readZoneCert({ homeDir = os.homedir() } = {}) {
  const file = path.join(homeDir, '.cloudflared', 'cert.pem');
  let pem;
  try {
    pem = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    const parsed = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    return {
      zoneId: parsed.zoneID || parsed.zoneId || null,
      accountId: parsed.accountID || parsed.accountId || null,
      apiToken: parsed.apiToken || null,
    };
  } catch {
    return null;
  }
}

async function cfGet(apiBase, apiToken, pathname, fetchImpl) {
  const res = await fetchImpl(`${apiBase}${pathname}`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  const text = await res.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
  if (!payload || payload.success !== true) return null;
  return payload.result;
}

/**
 * 查 zone 现状：状态 + **这个账号要求**的 NS 对 + 账号名。
 * 任一环节失败都返回 null（未知 ≠ 异常）。
 */
export async function fetchZoneHealth({
  zoneId = null,
  baseDomain,
  apiToken,
  fetchImpl = globalThis.fetch,
  apiBase = CF_API_BASE,
  accountId = null,
} = {}) {
  if (!apiToken || typeof fetchImpl !== 'function') return null;
  let zone = null;
  try {
    if (zoneId) {
      zone = await cfGet(apiBase, apiToken, `/zones/${zoneId}`, fetchImpl);
    }
    // cert 里的 zoneID 可能属于旧 zone（重新接入后会换），名字查一遍更稳
    if (!zone && baseDomain) {
      const list = await cfGet(apiBase, apiToken, `/zones?name=${encodeURIComponent(baseDomain)}`, fetchImpl);
      zone = Array.isArray(list) ? list.find((z) => z && z.name === baseDomain) || null : null;
    }
  } catch {
    return null;
  }
  if (!zone) return null;

  let accountName = null;
  const acc = accountId || zone.account?.id || null;
  if (acc) {
    try {
      const a = await cfGet(apiBase, apiToken, `/accounts/${acc}`, fetchImpl);
      accountName = a?.name || null;
    } catch {
      /* 只是少一句「账号是谁」，不影响结论 */
    }
  }
  return {
    zoneId: zone.id || null,
    zoneName: zone.name || baseDomain || null,
    status: zone.status || null,
    nameServers: (zone.name_servers || []).map((n) => String(n).toLowerCase().replace(/\.$/, '')).sort(),
    accountId: acc,
    accountName,
    modifiedAt: zone.modified_on || null,
  };
}

const norm = (list) => (Array.isArray(list) ? list : [])
  .map((n) => String(n).toLowerCase().replace(/\.$/, ''))
  .filter(Boolean)
  .sort();

/**
 * 把 zone 身份 + 公网 NS 合成为一个诊断码。
 *
 * 判据刻意简单：`moved` 是 Cloudflare 已经明确告诉我们「这域名不归你了」，
 * 优先采信；`active` 时用 NS 交集兜底（NS 刚改完的过渡期两边都可能答话）。
 */
export function classifyZone({ zone = null, publicNs = [], dnsOk = false } = {}) {
  const expectedNs = norm(zone?.nameServers);
  const publicNsNorm = norm(publicNs);
  const status = zone?.status || null;
  const base = { status, expectedNs, publicNs: publicNsNorm, zoneName: zone?.zoneName || null, accountName: zone?.accountName || null };

  if (!zone) return { code: 'unknown', ...base };
  if (status === 'moved') return { code: 'moved', ...base };
  if (status === 'pending' || status === 'initializing') return { code: 'pending', ...base };
  if (status === 'active') {
    const overlap = publicNsNorm.some((n) => expectedNs.includes(n));
    if (publicNsNorm.length && expectedNs.length && !overlap) return { code: 'ns-mismatch', ...base };
    return { code: dnsOk ? 'ok' : 'unresolved', ...base };
  }
  return { code: 'unknown', ...base };
}

/** 诊断码 → 面板短提示（null 表示不必打扰用户）。 */
export function zoneHint(code) {
  return ZONE_CODE_HINT[code] || null;
}

/**
 * 完整诊断：读证书 → 查 zone → 若给了公网 NS 就一并归类。
 * 任何一步不可用都退回 `{ code: 'unknown' }`，绝不抛。
 */
export async function diagnoseZone({
  homeDir = os.homedir(),
  baseDomain,
  publicNs = [],
  dnsOk = false,
  zoneId = null,
  apiToken = null,
  accountId = null,
  fetchImpl = globalThis.fetch,
  apiBase = CF_API_BASE,
} = {}) {
  const cert = apiToken ? null : readZoneCert({ homeDir });
  const health = await fetchZoneHealth({
    zoneId: zoneId || cert?.zoneId || null,
    accountId: accountId || cert?.accountId || null,
    baseDomain,
    apiToken: apiToken || cert?.apiToken || null,
    fetchImpl,
    apiBase,
  });
  if (!health) return { code: 'unknown', status: null, expectedNs: [], publicNs: norm(publicNs), zoneName: null, accountName: null };
  const verdict = classifyZone({ zone: health, publicNs, dnsOk });
  return {
    ...verdict,
    zoneId: health.zoneId,
    accountId: health.accountId,
    modifiedAt: health.modifiedAt,
  };
}

/**
 * 这条 hostname 现在的 CNAME 指向哪条隧道？
 *
 * 用途：多台机器共用一个 Cloudflare 账号时，`cloudflared tunnel route dns
 * --overwrite-dns` 会**静默**把别人的地址抢过来——A 机好好的，B 机一开通 A 机就断，
 * 而且两边面板都显示「成功」。开通前先看一眼归属，能避免这种互相踩踏。
 *
 * @returns {string|null} 小写 CNAME 目标；无记录返回 null；查不到（无凭据/断网）也返回 null
 */
export async function findDnsOwner({
  homeDir = os.homedir(),
  baseDomain,
  hostname,
  fetchImpl = globalThis.fetch,
  apiBase = CF_API_BASE,
  zoneId = null,
  apiToken = null,
} = {}) {
  const cert = apiToken ? null : readZoneCert({ homeDir });
  const token = apiToken || cert?.apiToken || null;
  if (!token || !hostname) return null;
  try {
    let zid = zoneId || null;
    if (!zid && baseDomain) {
      const list = await cfGet(apiBase, token, `/zones?name=${encodeURIComponent(baseDomain)}`, fetchImpl);
      zid = Array.isArray(list) ? list.find((z) => z && z.name === baseDomain)?.id || null : null;
    }
    if (!zid) return null;
    const records = await cfGet(
      apiBase,
      token,
      `/zones/${zid}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`,
      fetchImpl,
    );
    const hit = Array.isArray(records) ? records[0] : null;
    return hit?.content ? String(hit.content).toLowerCase().replace(/\.$/, '') : null;
  } catch {
    return null;
  }
}

/** 这条 CNAME 目标是不是"本机隧道"：只比较 UUID 前缀，容忍 cfdargotunnel.com 结尾差异。 */
export function cnameBelongsTo(content, tunnelId) {
  if (!content || !tunnelId) return false;
  return String(content).toLowerCase().startsWith(String(tunnelId).toLowerCase());
}

/** 稳定摘要，用于把「同一份 zone」与「另一份 zone」区分开（不写 ID，只做等值比较）。 */
export function zoneFingerprint(zone) {
  const src = `${zone?.accountId || ''}|${zone?.zoneId || ''}|${zone?.zoneName || ''}`;
  if (!src.replace(/\|/g, '')) return null;
  return crypto.createHash('sha256').update(src).digest('hex').slice(0, 12);
}
