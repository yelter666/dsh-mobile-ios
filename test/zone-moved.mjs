// test/zone-moved.mjs — 「公网解析不到地址」的归因与多机抢址保护
//
// 真实现场（2026-11-20，Windows 主机）：
//   面板开通「成功」，地址 dsh-8fde33c0c2.matrixboard.cn 写进了 Cloudflare，
//   公网却是 NXDOMAIN。原因不是 pending，而是 **zone 已被另一个 Cloudflare 账号接管**：
//     · 本机 cert.pem 属于账号 A，A 里该域名 status=moved，A 分配的 NS 是 lola/miguel
//     · 公网 NS 是 davina/trace —— 账号 B 的那一对
//   于是 A 账号里写得再对也不会下发。旧文案一律说「zone 处于 pending」，
//   让人去注册商改 NS 也改不对（改成了 A 的 NS 反而会与 B 打架），纯白跑。
//
// 本套件锁三件事：
//   ① zone 状态能归因（moved / pending / ns-mismatch / unresolved 各自可辨）；
//   ② 结论落到状态文件与面板提示上，且 moved 的提示必须点明「被另一个账号接管」；
//   ③ 多机共用账号时不会静默互相抢地址（--overwrite-dns 的隐形杀手）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalProvisioner } from '../src/provision-local.mjs';
import { createProvisioner } from '../src/cloudflare.mjs';
import { dnsWarningFor } from '../src/dns-probe.mjs';
import {
  cnameBelongsTo,
  classifyZone,
  diagnoseZone,
  fetchZoneHealth,
  findDnsOwner,
  readZoneCert,
  zoneHint,
} from '../src/zone-health.mjs';

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const TUNNEL_ID = 'af2f69b3-8e13-4a85-aca9-5ff8cc7d489f';
const OTHER_TUNNEL = 'd1b9c8fb-d84c-412e-aba1-7169460af351';
const ZONE_ID = 'da28630a774e7adc3188a1501ec01dcc';
const ACCOUNT_ID = 'd1e8dc9ae0d03db3e0437c9413b3234a';
const NS_A = ['lola.ns.cloudflare.com', 'miguel.ns.cloudflare.com'];
const NS_B = ['davina.ns.cloudflare.com', 'trace.ns.cloudflare.com'];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zone-moved-'));

const okBody = (result) => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, result }) });

/** 只应答给定路由的 fetch 桩，其余抛错（用来证明「查不到就降级」）。 */
function stubFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    for (const [re, handler] of routes) {
      if (re.test(url)) {
        const r = handler(url);
        if (r) return r;
      }
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  impl.calls = calls;
  return impl;
}

function fakeCert({ zoneId = ZONE_ID, accountId = ACCOUNT_ID, apiToken = 'fake-zone-token' } = {}) {
  const payload = Buffer.from(JSON.stringify({
    zoneID: zoneId, accountID: accountId, apiToken, endpoint: '',
  })).toString('base64');
  return `-----BEGIN ARGO TUNNEL TOKEN-----\n${payload}\n-----END ARGO TUNNEL TOKEN-----\n`;
}

console.log('\n1) zone 归因：每种状态给出不同结论\n');
{
  const moved = classifyZone({ zone: { status: 'moved', nameServers: NS_A, zoneName: 'matrixboard.cn' }, publicNs: NS_B, dnsOk: false });
  check('moved 被识别为 moved', moved.code === 'moved', JSON.stringify(moved));
  check('moved 保留本账号期望 NS', JSON.stringify(moved.expectedNs) === JSON.stringify(NS_A));
  check('moved 保留公网实际 NS', JSON.stringify(moved.publicNs) === JSON.stringify(NS_B));

  const pending = classifyZone({ zone: { status: 'pending', nameServers: NS_A }, publicNs: NS_B, dnsOk: false });
  check('pending 不被误判成 moved', pending.code === 'pending', JSON.stringify(pending));

  const active = classifyZone({ zone: { status: 'active', nameServers: NS_A }, publicNs: NS_A, dnsOk: false });
  check('active + NS 一致但解析不到 → unresolved', active.code === 'unresolved', JSON.stringify(active));

  const mismatch = classifyZone({ zone: { status: 'active', nameServers: NS_A }, publicNs: NS_B, dnsOk: false });
  check('active + 公网 NS 是另一对 → ns-mismatch', mismatch.code === 'ns-mismatch', JSON.stringify(mismatch));

  const okZone = classifyZone({ zone: { status: 'active', nameServers: NS_A }, publicNs: NS_A, dnsOk: true });
  check('已生效且能解析 → ok', okZone.code === 'ok', JSON.stringify(okZone));

  const unknown = classifyZone({ zone: null, publicNs: [] });
  check('拿不到 zone 信息 → unknown（不猜）', unknown.code === 'unknown');

  check('moved 有面板短提示且点明「另一个账号」', /另一个 Cloudflare 账号/.test(zoneHint('moved') || ''), zoneHint('moved'));
  check('ok 不给提示', zoneHint('ok') === null);
}

console.log('\n2) 面板文案：moved / pending 的修法必须不同\n');
{
  const moved = dnsWarningFor({ dnsOk: false, zone: { code: 'moved' } });
  const pending = dnsWarningFor({ dnsOk: false, zone: { code: 'pending' } });
  check('moved 提示提到「接管」', /接管/.test(moved || ''), moved);
  check('moved 提示明确「记录不会下发」', /不会下发/.test(moved || ''), moved);
  check('pending 提示不再冒充 moved', pending !== moved && /pending/.test(pending || ''), pending);
  check('解析正常时不出提示', dnsWarningFor({ dnsOk: true, zone: { code: 'moved' } }) === null);
  check('篡改优先于 zone 故障', /篡改/.test(dnsWarningFor({ dnsOk: false, dnsTampered: true, zone: { code: 'moved' } }) || ''));
}

console.log('\n3) 读 cert.pem：零额外凭据就能知道域名归谁\n');
{
  const home = path.join(tmp, 'home-cert');
  fs.mkdirSync(path.join(home, '.cloudflared'), { recursive: true });
  fs.writeFileSync(path.join(home, '.cloudflared', 'cert.pem'), fakeCert());
  const cert = readZoneCert({ homeDir: home });
  check('解出 zoneId', cert?.zoneId === ZONE_ID, JSON.stringify(cert && { ...cert, apiToken: '***' }));
  check('解出 accountId', cert?.accountId === ACCOUNT_ID);
  check('解出 zone 级 token', cert?.apiToken === 'fake-zone-token');

  const empty = path.join(tmp, 'home-nocert');
  fs.mkdirSync(empty, { recursive: true });
  check('没有 cert.pem 返回 null（不抛）', readZoneCert({ homeDir: empty }) === null);

  const broken = path.join(tmp, 'home-broken');
  fs.mkdirSync(path.join(broken, '.cloudflared'), { recursive: true });
  fs.writeFileSync(path.join(broken, '.cloudflared', 'cert.pem'), 'not-a-pem');
  check('cert.pem 损坏也返回 null（不炸宿主）', readZoneCert({ homeDir: broken }) === null);
}

console.log('\n4) 查 zone：成功给结论，网络/权限失败一律降级为 null\n');
{
  const fetchOk = stubFetch([
    [/\/zones\/da28630a/, () => okBody({ id: ZONE_ID, name: 'matrixboard.cn', status: 'moved', name_servers: NS_A, account: { id: ACCOUNT_ID }, modified_on: '2026-11-18T09:49:52Z' })],
    [/\/accounts\//, () => okBody({ id: ACCOUNT_ID, name: "815353729@qq.com's Account" })],
  ]);
  const health = await fetchZoneHealth({ zoneId: ZONE_ID, apiToken: 't', fetchImpl: fetchOk });
  check('拿到 zone 状态 moved', health?.status === 'moved', JSON.stringify(health));
  check('拿到本账号分配的 NS', JSON.stringify(health?.nameServers) === JSON.stringify(NS_A));
  check('拿到账号名（面板用来点破「两个账号」）', health?.accountName === "815353729@qq.com's Account");

  const fetchDown = async () => { throw new Error('ECONNRESET'); };
  check('断网时返回 null', (await fetchZoneHealth({ zoneId: ZONE_ID, apiToken: 't', fetchImpl: fetchDown })) === null);

  const fetch403 = async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ success: false, errors: [{ code: 9109 }] }) });
  check('权限不足时返回 null', (await fetchZoneHealth({ zoneId: ZONE_ID, apiToken: 't', fetchImpl: fetch403 })) === null);

  check('没有 token 时直接 null（不发请求）', (await fetchZoneHealth({ zoneId: ZONE_ID, apiToken: null, fetchImpl: fetchOk })) === null);
}

console.log('\n5) diagnoseZone：把 cert + 公网 NS 合成一个结论\n');
{
  const home = path.join(tmp, 'home-diag');
  fs.mkdirSync(path.join(home, '.cloudflared'), { recursive: true });
  fs.writeFileSync(path.join(home, '.cloudflared', 'cert.pem'), fakeCert());
  const fetchImpl = stubFetch([
    [/\/zones\/da28630a/, () => okBody({ id: ZONE_ID, name: 'matrixboard.cn', status: 'moved', name_servers: NS_A, account: { id: ACCOUNT_ID } })],
    [/\/accounts\//, () => okBody({ id: ACCOUNT_ID, name: 'acct' })],
  ]);
  const zone = await diagnoseZone({ homeDir: home, baseDomain: 'matrixboard.cn', publicNs: NS_B, dnsOk: false, fetchImpl });
  check('诊断结论是 moved', zone.code === 'moved', JSON.stringify(zone));
  check('诊断不泄露 token', !JSON.stringify(zone).includes('fake-zone-token'));

  const noCertHome = path.join(tmp, 'home-diag-none');
  fs.mkdirSync(noCertHome, { recursive: true });
  const fallback = await diagnoseZone({ homeDir: noCertHome, baseDomain: 'matrixboard.cn', publicNs: [], dnsOk: false, fetchImpl });
  check('无凭据时退回 unknown，不抛', fallback.code === 'unknown');
}

console.log('\n6) 多机抢址：绝不静默覆盖别人的固定地址\n');
{
  const home = path.join(tmp, 'home-owner');
  fs.mkdirSync(path.join(home, '.cloudflared'), { recursive: true });
  fs.writeFileSync(path.join(home, '.cloudflared', 'cert.pem'), fakeCert());
  const fetchImpl = stubFetch([
    [/\/zones\?name=/, () => okBody([{ id: ZONE_ID, name: 'matrixboard.cn', status: 'active', name_servers: NS_A }])],
    [/\/dns_records/, () => okBody([{ type: 'CNAME', name: 'dsh-x.matrixboard.cn', content: `${OTHER_TUNNEL}.cfargotunnel.com` }])],
  ]);
  const owner = await findDnsOwner({ homeDir: home, baseDomain: 'matrixboard.cn', hostname: 'dsh-x.matrixboard.cn', fetchImpl });
  check('查到这条记录的归属隧道', owner === `${OTHER_TUNNEL}.cfargotunnel.com`, owner);
  check('归属是别人 → cnameBelongsTo 为 false', cnameBelongsTo(owner, TUNNEL_ID) === false);
  check('归属是自己 → 视为可复用', cnameBelongsTo(owner, OTHER_TUNNEL) === true);

  const noRecord = stubFetch([[/\/zones\?name=/, () => okBody([{ id: ZONE_ID, name: 'matrixboard.cn' }])], [/\/dns_records/, () => okBody([])]]);
  check('没有记录时返回 null', (await findDnsOwner({ homeDir: home, baseDomain: 'matrixboard.cn', hostname: 'dsh-y.matrixboard.cn', fetchImpl: noRecord })) === null);

  const broken = stubFetch([[/\/zones\?name=/, () => { throw new Error('offline'); }]]);
  check('查不到归属时返回 null（不阻断开通）', (await findDnsOwner({ homeDir: home, baseDomain: 'matrixboard.cn', hostname: 'dsh-z.matrixboard.cn', fetchImpl: broken })) === null);
}

console.log('\n7) 端到端：moved 会被写进状态，面板据此改文案\n');
{
  const home = path.join(tmp, 'home-e2e');
  const cfDir = path.join(home, '.cloudflared');
  fs.mkdirSync(cfDir, { recursive: true });
  fs.writeFileSync(path.join(cfDir, 'cert.pem'), fakeCert());
  const stateFile = path.join(home, 'tunnel-named.json');
  const configFile = path.join(home, 'tunnel-config.yml');
  const calls = [];
  const p = new LocalProvisioner({
    baseDomain: 'matrixboard.cn',
    seed: 'install-moved',
    stateFile,
    configFile,
    homeDir: home,
    log: () => {},
    run: async (args) => {
      calls.push(args.join(' '));
      if (args[1] === 'list') return '[]';
      if (args[1] === 'create') {
        fs.writeFileSync(path.join(cfDir, `${TUNNEL_ID}.json`), '{}', { mode: 0o600 });
        return `INF Created tunnel x with id ${TUNNEL_ID}`;
      }
      return 'INF Added CNAME';
    },
    probe: async () => ({ ok: false, kind: null, records: [] }),
    zoneDiagnose: async () => ({
      code: 'moved', status: 'moved', expectedNs: NS_A, publicNs: NS_B,
      zoneName: 'matrixboard.cn', accountName: "815353729@qq.com's Account", zoneId: ZONE_ID, accountId: ACCOUNT_ID,
    }),
    ownerLookup: async () => null,
  });

  const r = await p.ensure({ port: 3081 });
  check('开通仍成功写出地址', /^https:\/\/dsh-[0-9a-f]{10}\.matrixboard\.cn$/.test(r.url), r.url);
  check('解析不到时 dnsOk=false', r.dnsOk === false);
  check('返回值带上 zone 结论', r.zone?.code === 'moved', JSON.stringify(r.zone));
  check('zone 结论不含账号/zone 内部 ID（只给展示字段）',
    r.zone && r.zone.zoneId === undefined && r.zone.accountId === undefined, JSON.stringify(r.zone));
  check('状态文件持久化 zone 结论', JSON.parse(fs.readFileSync(stateFile, 'utf8')).zone?.code === 'moved');
  check('status() 暴露 zone 给面板', p.status().zone?.code === 'moved');
  check('warning 点明「接管」而非笼统 pending', /接管/.test(p.status().warning || ''), p.status().warning);
  check('期望 NS 与公网 NS 都可对照', JSON.stringify(p.status().zone.expectedNs) === JSON.stringify(NS_A)
    && JSON.stringify(p.status().zone.publicNs) === JSON.stringify(NS_B));

  // 改完 NS 后再重检：结论必须能被覆盖（不能把 moved 固化）
  p.zoneDiagnose = async () => ({ code: 'ok', status: 'active', expectedNs: NS_A, publicNs: NS_A, zoneName: 'matrixboard.cn' });
  p.probe = async () => ({ ok: true, kind: 'CNAME', records: [`${TUNNEL_ID}.cfargotunnel.com`] });
  const again = await p.recheckDns();
  check('NS 改对后重检通过', again.ok === true, JSON.stringify(again));
  // 解析通了就不再带故障结论：留着 moved 会让面板继续报警
  check('重检通过后清掉旧 zone 结论', again.zone === null && p.status().zone === null);
  check('重检后状态文件 dnsOk=true', JSON.parse(fs.readFileSync(stateFile, 'utf8')).dnsOk === true);
  check('重检后不再有告警', p.status().warning === null);
}

console.log('\n8) 抢址保护：目标地址属于另一条隧道时拒绝 overwrite\n');
{
  const home = path.join(tmp, 'home-conflict');
  const cfDir = path.join(home, '.cloudflared');
  fs.mkdirSync(cfDir, { recursive: true });
  fs.writeFileSync(path.join(cfDir, 'cert.pem'), fakeCert());
  const calls = [];
  const p = new LocalProvisioner({
    baseDomain: 'matrixboard.cn',
    seed: 'install-conflict',
    stateFile: path.join(home, 'tunnel-named.json'),
    configFile: path.join(home, 'tunnel-config.yml'),
    homeDir: home,
    log: () => {},
    run: async (args) => {
      calls.push(args.join(' '));
      if (args[1] === 'list') return '[]';
      if (args[1] === 'create') {
        fs.writeFileSync(path.join(cfDir, `${TUNNEL_ID}.json`), '{}', { mode: 0o600 });
        return `INF Created tunnel x with id ${TUNNEL_ID}`;
      }
      return 'INF Added CNAME';
    },
    probe: async () => ({ ok: true, kind: 'CNAME', records: [`${TUNNEL_ID}.cfargotunnel.com`] }),
    zoneDiagnose: async () => null,
    ownerLookup: async () => `${OTHER_TUNNEL}.cfargotunnel.com`,
  });
  let err = null;
  try {
    await p.ensure({ port: 3081 });
  } catch (e) {
    err = e;
  }
  check('地址被别人占用时抛错而不是覆盖', Boolean(err), calls.join(' | '));
  check('错误码 4021（可诊断的业务失败）', err?.body?.error?.code === 4021 || err?.code === 4021, JSON.stringify(err?.body?.error));
  check('错误信息点明「已被另一条隧道占用」', /另一条隧道占用/.test(JSON.stringify(err?.body || err || '')), JSON.stringify(err?.body));
  check('没有执行 route dns（真的没覆盖）', !calls.some((c) => c.includes('route dns')), calls.join(' | '));

  // 归属是自己的旧隧道：允许继续（重启后重建 ingress 的正常路径）
  const p2 = new LocalProvisioner({
    baseDomain: 'matrixboard.cn',
    seed: 'install-conflict',
    stateFile: path.join(home, 'tunnel-named2.json'),
    configFile: path.join(home, 'tunnel-config2.yml'),
    homeDir: home,
    log: () => {},
    run: async (args) => {
      if (args[1] === 'list') return '[]';
      if (args[1] === 'create') {
        fs.writeFileSync(path.join(cfDir, `${TUNNEL_ID}.json`), '{}', { mode: 0o600 });
        return `INF Created tunnel x with id ${TUNNEL_ID}`;
      }
      return 'INF Added CNAME';
    },
    probe: async () => ({ ok: true, kind: 'CNAME', records: [`${TUNNEL_ID}.cfargotunnel.com`] }),
    ownerLookup: async () => `${TUNNEL_ID}.cfargotunnel.com`,
  });
  const r2 = await p2.ensure({ port: 3081 });
  check('归属是自己的地址可以正常复用', r2.dnsOk === true, JSON.stringify(r2));
}

console.log('\n9) 生产接线：createProvisioner 必须真的挂上归因与归属查询\n');
{
  const h = path.join(tmp, 'home-wire');
  fs.mkdirSync(h, { recursive: true });
  const p = createProvisioner(
    { provisioner: 'local', baseDomain: 'matrixboard.cn' },
    { log: () => {}, stateFile: path.join(h, 'tunnel-named.json') },
  );
  check('local 开通器拿到了 zone 归因能力', typeof p?.zoneDiagnose === 'function');
  check('local 开通器拿到了地址归属查询', typeof p?.ownerLookup === 'function');
}

console.log('\n10) 授权账号变更：重建隧道但保留同一个固定地址\n');
{
  // 真实场景：域名从账号 A 迁到账号 B，本机重新 cloudflared tunnel login。
  // 状态文件里还留着 A 的 tunnelId —— 直接拿去 route dns 会 "tunnel not found"。
  const home = path.join(tmp, 'home-account-switch');
  const cfDir = path.join(home, '.cloudflared');
  fs.mkdirSync(cfDir, { recursive: true });
  fs.writeFileSync(path.join(cfDir, 'cert.pem'), fakeCert({ accountId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', zoneId: 'ffffffffffffffffffffffffffffffff' }));
  const oldTunnel = '99999999-8888-7777-6666-555555555555';
  const newTunnel = '12121212-3434-5656-7878-909090909090';
  const stateFile = path.join(home, 'tunnel-named.json');
  fs.writeFileSync(stateFile, JSON.stringify({
    version: 1,
    installationId: 'abc',
    account: ACCOUNT_ID, // 旧账号
    subdomain: 'dsh-keepme0000',
    hostname: 'dsh-keepme0000.matrixboard.cn',
    tunnelId: oldTunnel,
    credentialsFile: path.join(cfDir, `${oldTunnel}.json`),
    configFile: path.join(home, 'tunnel-config.yml'),
    port: 3081,
    dnsOk: false,
  }));
  fs.writeFileSync(path.join(cfDir, `${oldTunnel}.json`), '{}', { mode: 0o600 });

  const calls = [];
  const p = new LocalProvisioner({
    baseDomain: 'matrixboard.cn',
    seed: 'install-switch',
    stateFile,
    configFile: path.join(home, 'tunnel-config.yml'),
    homeDir: home,
    log: () => {},
    run: async (args) => {
      calls.push(args.join(' '));
      if (args[1] === 'list') return '[]'; // 新账号里没有任何隧道
      if (args[1] === 'create') {
        fs.writeFileSync(path.join(cfDir, `${newTunnel}.json`), '{}', { mode: 0o600 });
        return `INF Created tunnel ${args[2]} with id ${newTunnel}`;
      }
      return 'INF Added CNAME';
    },
    probe: async () => ({ ok: true, kind: 'CNAME', records: [`${newTunnel}.cfargotunnel.com`] }),
    ownerLookup: async () => null,
  });

  const r = await p.ensure({ port: 3081 });
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  check('账号变更后重建了隧道（没沿用旧 id）', st.tunnelId === newTunnel, st.tunnelId);
  check('调用了 tunnel create', calls.some((c) => c.startsWith('tunnel create')), calls.join(' | '));
  check('固定地址保持不变（子域沿用）', r.hostname === 'dsh-keepme0000.matrixboard.cn', r.hostname);
  check('状态文件记下新账号，下次变更才认得出来', st.account === 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  check('重建后照常写 DNS', calls.some((c) => c.includes('route dns') && c.includes('dsh-keepme0000')), calls.join(' | '));
  check('新隧道凭据路径已更新', st.credentialsFile.endsWith(`${newTunnel}.json`), st.credentialsFile);

  // 同一账号再次启动：不该无谓重建
  const again = new LocalProvisioner({
    baseDomain: 'matrixboard.cn',
    seed: 'install-switch',
    stateFile,
    configFile: path.join(home, 'tunnel-config.yml'),
    homeDir: home,
    log: () => {},
    run: async (args) => {
      calls.push(args.join(' '));
      // 账号没变、隧道确实还在账号里：列表必须如实返回它，否则会被判成孤儿隧道
      return args[1] === 'list'
        ? JSON.stringify([{ id: newTunnel, name: 'dsh-keepme0000' }])
        : 'INF ok';
    },
    probe: async () => ({ ok: true, kind: 'CNAME', records: [`${newTunnel}.cfargotunnel.com`] }),
  });
  const before = calls.length;
  // 端口变化走「只重写 ingress」的快路径，能直接验证没有重开隧道
  await again.ensure({ port: 3082 });
  check('账号未变时不重建隧道', JSON.parse(fs.readFileSync(stateFile, 'utf8')).tunnelId === newTunnel);
  check('账号未变时不调用 create', !calls.slice(before).some((c) => c.startsWith('tunnel create')), calls.slice(before).join(' | '));
}

console.log('\n11) 老状态文件没有 account 字段：靠「隧道是否还在当前账号」判定\n');
{
  // 0.2.11 之前写下的状态文件根本没有 account 字段，只记了 tunnelId。
  // 只比对 account 会漏判——必须真去问 Cloudflare 这条隧道还在不在。
  const home = path.join(tmp, 'home-legacy-state');
  const cfDir = path.join(home, '.cloudflared');
  fs.mkdirSync(cfDir, { recursive: true });
  fs.writeFileSync(path.join(cfDir, 'cert.pem'), fakeCert({ accountId: 'cccccccccccccccccccccccccccccccc' }));
  const oldTunnel = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const newTunnel = 'ffffffff-1111-2222-3333-444444444444';
  const stateFile = path.join(home, 'tunnel-named.json');
  const legacy = {
    version: 1,
    installationId: 'legacy1',
    subdomain: 'dsh-legacy0000',
    hostname: 'dsh-legacy0000.matrixboard.cn',
    tunnelId: oldTunnel,
    credentialsFile: path.join(cfDir, `${oldTunnel}.json`),
    configFile: path.join(home, 'tunnel-config.yml'),
    port: 3081,
    dnsOk: false,
  };
  fs.writeFileSync(stateFile, JSON.stringify(legacy)); // 注意：没有 account
  fs.writeFileSync(path.join(cfDir, `${oldTunnel}.json`), '{}', { mode: 0o600 });

  const calls = [];
  const p = new LocalProvisioner({
    baseDomain: 'matrixboard.cn',
    seed: 'legacy-switch',
    stateFile,
    configFile: path.join(home, 'tunnel-config.yml'),
    homeDir: home,
    log: () => {},
    run: async (args) => {
      calls.push(args.join(' '));
      // 当前账号的隧道列表里只有别的隧道，没有 oldTunnel
      if (args[1] === 'list') return JSON.stringify([{ id: 'other', name: 'someone-else' }]);
      if (args[1] === 'create') {
        fs.writeFileSync(path.join(cfDir, `${newTunnel}.json`), '{}', { mode: 0o600 });
        return `INF Created tunnel ${args[2]} with id ${newTunnel}`;
      }
      return 'INF Added CNAME';
    },
    probe: async () => ({ ok: true, kind: 'CNAME', records: [`${newTunnel}.cfargotunnel.com`] }),
    ownerLookup: async () => null,
  });
  const r = await p.ensure({ port: 3081 });
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  check('查了当前账号的隧道列表', calls.some((c) => c.startsWith('tunnel list')), calls.join(' | '));
  check('旧隧道不在账号里 → 重建', st.tunnelId === newTunnel, st.tunnelId);
  check('重建后仍沿用同一个子域', r.hostname === 'dsh-legacy0000.matrixboard.cn', r.hostname);
  check('重建后补写 account 字段', st.account === 'cccccccccccccccccccccccccccccccc', String(st.account));

  // 反向：隧道确实还在当前账号（列表里有它）→ 不该重建
  fs.writeFileSync(stateFile, JSON.stringify({ ...legacy, tunnelId: newTunnel, credentialsFile: path.join(cfDir, `${newTunnel}.json`) }));
  const keep = [];
  const p2 = new LocalProvisioner({
    baseDomain: 'matrixboard.cn',
    seed: 'legacy-switch',
    stateFile,
    configFile: path.join(home, 'tunnel-config.yml'),
    homeDir: home,
    log: () => {},
    run: async (args) => {
      keep.push(args.join(' '));
      if (args[1] === 'list') return JSON.stringify([{ id: newTunnel, name: 'dsh-legacy0000' }]);
      return 'INF ok';
    },
    probe: async () => ({ ok: true, kind: 'CNAME', records: [`${newTunnel}.cfargotunnel.com`] }),
  });
  await p2.ensure({ port: 3081 });
  check('隧道仍在当前账号 → 不重建', !keep.some((c) => c.startsWith('tunnel create')), keep.join(' | '));
  check('隧道仍在当前账号 → id 不变', JSON.parse(fs.readFileSync(stateFile, 'utf8')).tunnelId === newTunnel);

  // 边界：列表查不到（网络/凭据抖动）不能把好好的隧道判死
  const flaky = [];
  const p3 = new LocalProvisioner({
    baseDomain: 'matrixboard.cn',
    seed: 'legacy-switch',
    stateFile,
    configFile: path.join(home, 'tunnel-config.yml'),
    homeDir: home,
    log: () => {},
    run: async (args) => {
      flaky.push(args.join(' '));
      if (args[1] === 'list') throw new Error('network unreachable');
      return 'INF ok';
    },
    probe: async () => ({ ok: true, kind: 'CNAME', records: [`${newTunnel}.cfargotunnel.com`] }),
  });
  await p3.ensure({ port: 3081 });
  check('列表查不到时保守复用（不因抖动重建）', !flaky.some((c) => c.startsWith('tunnel create')), flaky.join(' | '));
  check('列表查不到时 id 保持', JSON.parse(fs.readFileSync(stateFile, 'utf8')).tunnelId === newTunnel);
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n结果：${pass} 通过 / ${failures.length} 失败\n`);
if (failures.length) process.exit(1);
