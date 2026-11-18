// dns-probe.mjs — 固定地址的「公网解析」自检
//
// 为什么需要它：Cloudflare 允许同一个域名在多个账号下各有一份 zone，但公网 NS
// 只指向其中一个。写进 pending 那份时，API 返回 success、cloudflared 说
// "already configured"，公网却仍是 NXDOMAIN——用户扫码连不上，界面却显示「开通成功」。
// 这类故障无法从开通返回码看出来，只能真的去解析一次。
//
// 刻意用公共解析器而不是系统解析：本机 hosts / 内网 DNS 可能残留旧记录，
// 要验证的是「别人家的手机会解析成什么」。

import dns from 'node:dns';

export const DNS_PENDING_HINT = '域名在当前 Cloudflare 账号里未生效（zone 处于 pending，公网 NS 指向另一份 zone）。'
  + '要么把这个域名的 NS 改成该账号分配的 nameserver，要么换用持有生效 zone 的账号重新登录授权。';

// 防劫持：CNAME 没有指向本机隧道。解析「成功」但流量会落到别人的 ingress，
// 扫码连接等于把指令发给未知服务器——必须当作地址不可用处理。
export const DNS_TAMPER_HINT = '固定域名解析异常：CNAME 已不指向本机隧道（可能被篡改或误改）。'
  + '网关已拒绝下发该地址。请到 Cloudflare 检查这条 CNAME 记录，必要时删除后重新「开启远程」自动重建。';

/**
 * 把一次解析结果对照「期望的隧道」评分：CNAME 没有指向本机隧道 = 被改指。
 * A 记录（边缘 IP Flatten）比对不了目标，按可解析放行；解析不到本身不算篡改。
 *
 * @returns {{ ok: boolean, tampered: boolean, target: string|null, expected: string|null }}
 */
export function evaluateDnsAnswer(check, tunnelId) {
  const expected = tunnelId ? `${tunnelId}.cfargotunnel.com` : null;
  const target = check?.kind === 'CNAME' && check.records?.[0]
    ? String(check.records[0]).toLowerCase().replace(/\.$/, '')
    : null;
  const tampered = Boolean(check?.ok && expected && target && target !== expected);
  return { ...check, ok: Boolean(check?.ok) && !tampered, tampered, target, expected };
}

/** 状态 → 面板提示。篡改优先于 pending：两者都真时，先让人处理更危险的那个。 */
export function dnsWarningFor(state) {
  if (state?.dnsTampered) return DNS_TAMPER_HINT;
  if (state?.dnsOk === false) return DNS_PENDING_HINT;
  return null;
}

/**
 * @returns {{ ok: boolean, kind: 'CNAME'|'A'|null, records: string[] }}
 */
export async function probeDns(hostname, { attempts = 3, delayMs = 1500, servers = ['1.1.1.1', '8.8.8.8'] } = {}) {
  if (!hostname) return { ok: false, kind: null, records: [] };
  const resolver = new dns.promises.Resolver({ timeout: 4000, tries: 2 });
  try {
    resolver.setServers(servers);
  } catch {
    /* 退化成系统解析器 */
  }
  for (let i = 0; i < attempts; i += 1) {
    for (const method of ['resolveCname', 'resolve4']) {
      try {
        const rr = await resolver[method](hostname);
        if (rr?.length) return { ok: true, kind: method === 'resolveCname' ? 'CNAME' : 'A', records: rr };
      } catch {
        /* NXDOMAIN / SERVFAIL 都当没查到，继续下一种 */
      }
    }
    // 刻意不 unref：unref 后若没有别的句柄，进程会在等待期间直接退出
    // （CLI 与测试都会踩到，表现为 unsettled top-level await）。
    if (i < attempts - 1) await new Promise((resolve) => { setTimeout(resolve, delayMs); });
  }
  return { ok: false, kind: null, records: [] };
}

/**
 * 当前公网 NS 列表（不带末尾点、已排序）。
 *
 * 用途：给「名称服务器无效」这类故障一个可直接核对的答案——
 * 用户不需要理解 zone/pending，只要把这里列出的名字和 Cloudflare 要求的一致即可。
 */
export async function resolveNs(domain, { servers = ['1.1.1.1', '8.8.8.8'] } = {}) {
  if (!domain) return [];
  const resolver = new dns.promises.Resolver({ timeout: 4000, tries: 2 });
  try {
    resolver.setServers(servers);
  } catch {
    /* 退化成系统解析器 */
  }
  try {
    const list = await resolver.resolveNs(domain);
    return list.map((n) => String(n).toLowerCase().replace(/\.$/, '')).sort();
  } catch {
    return [];
  }
}
