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

export const DNS_PENDING_HINT = '域名在当前 Cloudflare 账号里还没生效（zone pending）：公网 NS 指向的是另一份 zone。'
  + '要么把这个域名的 NS 改成该账号分配的 nameserver，要么换用持有生效 zone 的账号重新登录授权。';

// 本账号的 zone 已被另一个 Cloudflare 账号接管（status=moved）。这时改本账号的
// 记录、重装插件、重启隧道统统没用——公网根本不读这份 zone，必须动注册商 NS 或换账号。
export const DNS_MOVED_HINT = '域名已被另一个 Cloudflare 账号接管（zone moved）：本机写入的记录不会下发到公网。'
  + '在域名注册商处把 NS 改回本账号分配的一对，或统一只用同一个 Cloudflare 账号登录。';

export const DNS_NS_MISMATCH_HINT = '域名在本账号显示已生效，但公网 NS 与本账号分配的不一致，记录暂时查不到。'
  + '确认注册商处两处 NS 都已改完，再点「重新检测」。';

// zone 已 active、NS 也对，公网却还是没有这条记录：多半是刚写入的记录还在传播，
// 或者记录被手动删了。这时重装/重开都没意义，等一下再重检即可。
export const DNS_UNRESOLVED_HINT = '域名在 Cloudflare 已生效，但公网暂时查不到这台主机的记录：'
  + '记录可能刚写入（等 1–2 分钟），或已被删除。稍后点「重新检测」，仍不行就重新「开启远程」重建记录。';

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

/** 状态 → 面板提示。篡改优先于 zone 故障：两者都真时，先让人处理更危险的那个。 */
export function dnsWarningFor(state) {
  if (state?.dnsTampered) return DNS_TAMPER_HINT;
  if (state?.dnsOk !== false) return null;
  // zone 层面已经诊断出结论时，用结论而不是笼统的「pending」——
  // moved / pending / ns-mismatch 的修法完全不同，猜错等于让人白跑一趟。
  const code = state?.zone?.code;
  if (code === 'moved') return DNS_MOVED_HINT;
  if (code === 'ns-mismatch') return DNS_NS_MISMATCH_HINT;
  if (code === 'unresolved') return DNS_UNRESOLVED_HINT;
  if (code === 'pending') return DNS_PENDING_HINT;
  return DNS_PENDING_HINT;
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
