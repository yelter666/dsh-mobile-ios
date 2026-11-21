// test/tunnel-credentials.mjs — 「换台电脑就分配不出固定地址」的根因回归
//
// 现场（2026-11-21，新 Mac）：插件装好后点「开启远程」，面板只报
//   `写入 DNS 失败：Command failed: /opt/homebrew/bin/cloudflared tunnel route dns …`
// 真实原因是 ~/.cloudflared/cert.pem 属于**另一个 Cloudflare 账号**，
// 而域名已迁到新账号：跨账号的证书能列隧道、能建隧道，唯独写不了 DNS。
//
// 本套件锁五件事：
//   ① 开通前预检能认出「证书看不到这个域名 / 账号不符 / 证书过时」，且在**任何写入之前**失败；
//   ② 预检的降级原则：断网/证书格式不认识 → unknown，绝不误杀本来能用的凭据；
//   ③ 失败信息保留 cloudflared 的 code/reason，并给出唯一正确的修法（用对的账号 login）；
//   ④ 状态文件的**机器归属**：跨机拷来的状态不会被当成自己的地址，凭据缺失也不冒充；
//   ⑤ 没有 cert.pem 时仍能用本机状态起固定地址（端口顺延只改本地 ingress）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalProvisioner, LocalStateProvisioner, renderConfig } from '../src/provision-local.mjs';
import { createProvisioner } from '../src/cloudflare.mjs';
import { resolveProvisioner } from '../src/provision-select.mjs';
import { explainTunnelFailure, parseCloudflaredFailure } from '../src/tunnel-error.mjs';
import { verifyCertAccess } from '../src/zone-health.mjs';
import { machineIdentity } from '../src/tunnel-state.mjs';
import { createGateway } from '../src/server.mjs';
import { createMockHost } from '../src/adapter/mock-host.mjs';
import { httpJson } from './lib/wsclient.mjs';
import { fakeTunnel } from './lib/fake-tunnel.mjs';

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const TUNNEL_ID = 'af2f69b3-8e13-4a85-aca9-5ff8cc7d489f';
const ZONE_ID = 'da28630a774e7adc3188a1501ec01dcc';
const ACCOUNT = 'bb53f02d73b7b0722fca9cbe23bdf10f';
const OTHER_ACCOUNT = '815353729aaaaaaaaaaaaaaaaaaaaaaaaa';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cred-'));
const dirs = [tmp];
function tmpHome(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, '.cloudflared'), { recursive: true });
  dirs.push(dir);
  return dir;
}

function fakeCert({ zoneId = ZONE_ID, accountId = ACCOUNT, apiToken = 'zone-token-abc' } = {}) {
  const payload = Buffer.from(JSON.stringify({ zoneID: zoneId, accountID: accountId, apiToken })).toString('base64');
  return `-----BEGIN ARGO TUNNEL ACCOUNT-----\n${payload}\n-----END ARGO TUNNEL ACCOUNT-----\n`;
}

/** 只应答给定路由的 fetch 桩，其余抛错（证明「查不到就降级」）。 */
function stubFetch(routes) {
  const impl = async (url) => {
    for (const [re, handler] of routes) {
      if (re.test(url)) return handler(url);
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  impl.calls = [];
  return impl;
}
const okBody = (result) => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, result }) });
const errBody = (status, errors = [{ code: 10000, message: 'Authentication error' }]) => ({
  ok: false, status, text: async () => JSON.stringify({ success: false, result: null, errors }),
});

console.log('\n1) 凭据预检：五种「确定不可用」各给出不同结论\n');
{
  const home = tmpHome('preflight');
  fs.writeFileSync(path.join(home, '.cloudflared', 'cert.pem'), fakeCert());

  const okFetch = stubFetch([
    [/\/zones\?name=/, () => okBody([{ id: ZONE_ID, name: 'matrixboard.cn', status: 'active', account: { id: ACCOUNT }, name_servers: [] }])],
    [/\/accounts\//, () => okBody({ id: ACCOUNT, name: "yelter@qq.com's Account" })],
  ]);
  const ok = await verifyCertAccess({ homeDir: home, baseDomain: 'matrixboard.cn', fetchImpl: okFetch });
  check('证书与域名同账号 → ok', ok.state === 'ok' && ok.blocking === false, JSON.stringify(ok));
  check('ok 时带出账号名供提示使用', ok.accountName === "yelter@qq.com's Account", String(ok.accountName));
  check('预检结论绝不回传 token', !JSON.stringify(ok).includes('zone-token-abc'), JSON.stringify(ok));

  const missing = await verifyCertAccess({ homeDir: tmpHome('no-cert'), baseDomain: 'matrixboard.cn', fetchImpl: okFetch });
  check('没有 cert.pem → missing 且阻断', missing.state === 'missing' && missing.blocking === true, JSON.stringify(missing));

  const unreadableHome = tmpHome('bad-cert');
  fs.writeFileSync(path.join(unreadableHome, '.cloudflared', 'cert.pem'), 'fake-cert');
  const unreadable = await verifyCertAccess({ homeDir: unreadableHome, baseDomain: 'matrixboard.cn', fetchImpl: okFetch });
  check('cert.pem 结构不认识 → unreadable 但不阻断（降级）',
    unreadable.state === 'unreadable' && unreadable.blocking === false, JSON.stringify(unreadable));

  // 跨账号：token 是 zone 范围的，查不到这个域名 → 空列表
  const emptyFetch = stubFetch([[/\/zones\?name=/, () => okBody([])]]);
  const cross = await verifyCertAccess({ homeDir: home, baseDomain: 'matrixboard.cn', fetchImpl: emptyFetch });
  check('token 看不到该域名 → zone-missing 且阻断', cross.state === 'zone-missing' && cross.blocking === true, JSON.stringify(cross));
  check('zone-missing 的提示点明「账号里看不到这个域名」', /看不到这个域名/.test(cross.hint || ''), cross.hint);

  const forbidding = stubFetch([[/\/zones\?name=/, () => errBody(403)]]);
  const forbidden = await verifyCertAccess({ homeDir: home, baseDomain: 'matrixboard.cn', fetchImpl: forbidding });
  check('403 → forbidden 且阻断', forbidden.state === 'forbidden' && forbidden.blocking === true, JSON.stringify(forbidden));

  const mismatchFetch = stubFetch([
    [/\/zones\?name=/, () => okBody([{ id: ZONE_ID, name: 'matrixboard.cn', status: 'active', account: { id: OTHER_ACCOUNT } }])],
    [/\/accounts\//, () => okBody({ name: 'other' })],
  ]);
  const mismatch = await verifyCertAccess({ homeDir: home, baseDomain: 'matrixboard.cn', fetchImpl: mismatchFetch });
  check('zone 归属账号与证书不同 → account-mismatch 且阻断',
    mismatch.state === 'account-mismatch' && mismatch.blocking === true, JSON.stringify(mismatch));

  const staleFetch = stubFetch([
    [/\/zones\?name=/, () => okBody([{ id: 'ffffeeee111122223333444455556666', name: 'matrixboard.cn', status: 'active', account: { id: ACCOUNT } }])],
    [/\/accounts\//, () => okBody({ name: 'acc' })],
  ]);
  const stale = await verifyCertAccess({ homeDir: home, baseDomain: 'matrixboard.cn', fetchImpl: staleFetch });
  check('cert 指向旧 zoneID → stale-zone 且阻断', stale.state === 'stale-zone' && stale.blocking === true, JSON.stringify(stale));

  const movedFetch = stubFetch([
    [/\/zones\?name=/, () => okBody([{ id: ZONE_ID, name: 'matrixboard.cn', status: 'moved', account: { id: ACCOUNT } }])],
    [/\/accounts\//, () => okBody({ name: 'acc' })],
  ]);
  const moved = await verifyCertAccess({ homeDir: home, baseDomain: 'matrixboard.cn', fetchImpl: movedFetch });
  check('zone moved → zone-moved 且阻断', moved.state === 'zone-moved' && moved.blocking === true, JSON.stringify(moved));

  const offline = async () => { throw new Error('ENETUNREACH'); };
  const unknown = await verifyCertAccess({ homeDir: home, baseDomain: 'matrixboard.cn', fetchImpl: offline });
  check('断网 → unknown 且不阻断（不误杀正常凭据）',
    unknown.state === 'unknown' && unknown.blocking === false, JSON.stringify(unknown));
}

console.log('\n2) 错误透传：code/reason 不再被第一行吞掉\n');
{
  const parsed = parseCloudflaredFailure(
    'Command failed: /opt/homebrew/bin/cloudflared tunnel route dns x\r\n'
    + 'Failed to add route: code: 10000, reason: Authentication error\r\n',
  );
  check('解析出 code 10000', parsed.code === 10000, String(parsed.code));
  check('解析出 reason', parsed.reason === 'Authentication error', String(parsed.reason));

  const explained = explainTunnelFailure(new Error(
    'Command failed: cloudflared tunnel route dns x\nFailed to add route: code: 10000, reason: Authentication error',
  ), { baseDomain: 'matrixboard.cn', accountName: "815353729@qq.com's Account" });
  check('归类为 credentials', explained.reason === 'credentials', explained.reason);
  check('提示说清「没有该域名的权限」', /没有 matrixboard\.cn 的权限/.test(explained.message), explained.message);
  check('detail 给出 login 命令', /tunnel login/.test(explained.detail), explained.detail);
  check('detail 保留 cloudflared 原始 code', /code: 10000/.test(explained.detail), explained.detail);
  check('detail 点名当前证书所属账号', /815353729@qq\.com/.test(explained.detail), explained.detail);

  const zoneErr = explainTunnelFailure(new Error('Failed to add route: zone not found'), { baseDomain: 'matrixboard.cn' });
  check('zone not found 归类为 zone', zoneErr.reason === 'zone', zoneErr.reason);
  check('zone 错误仍保留原文供排障', /zone not found/.test(zoneErr.message), zoneErr.message);
}

console.log('\n3) 开通前预检：跨账号证书在写入之前就失败\n');
{
  const home = tmpHome('preflight-block');
  fs.writeFileSync(path.join(home, '.cloudflared', 'cert.pem'), fakeCert());
  const calls = [];
  const prov = new LocalProvisioner({
    baseDomain: 'matrixboard.cn',
    seed: 'cred-block',
    stateFile: path.join(home, 'tunnel-named.json'),
    configFile: path.join(home, 'tunnel-config.yml'),
    homeDir: home,
    log: () => {},
    run: async (args) => { calls.push(args.join(' ')); return ''; },
    probe: async () => ({ ok: true, kind: 'CNAME', records: [] }),
    verifyAccess: async () => ({ state: 'zone-missing', blocking: true, hint: '当前登录的账号里看不到这个域名' }),
  });
  let err = null;
  try { await prov.ensure({ port: 3081 }); } catch (e) { err = e; }
  check('预检不通过 → 抛错', Boolean(err), '竟然继续开通了');
  check('错误码 4021（凭据前置条件不满足）', err?.code === 4021, String(err?.code));
  check('message 直接说明账号看不到域名', /看不到这个域名/.test(err?.message || ''), err?.message);
  check('detail 给出可执行 login 命令', /tunnel login/.test(err?.extra?.detail || ''), err?.extra?.detail);
  check('detail 说明「选持有该域名的账号」', /持有 matrixboard\.cn 的账号/.test(err?.extra?.detail || ''), err?.extra?.detail);
  check('detail 明确否掉重装/重启这类无效动作', /重装插件/.test(err?.extra?.detail || ''), err?.extra?.detail);
  check('错误带 reason=credentials（供面板分流）', err?.extra?.reason === 'credentials', err?.extra?.reason);
  check('没有执行任何 cloudflared 子命令（写入之前就失败）', calls.length === 0, calls.join(' | '));
  check('status().credentials 暴露预检结论', prov.status().credentials?.blocking === true, JSON.stringify(prov.status()));

  // 降级：预检「不知道」时不能拦人
  const home2 = tmpHome('preflight-unknown');
  fs.writeFileSync(path.join(home2, '.cloudflared', 'cert.pem'), fakeCert());
  const created = [];
  const prov2 = new LocalProvisioner({
    baseDomain: 'matrixboard.cn',
    seed: 'cred-unknown',
    stateFile: path.join(home2, 'tunnel-named.json'),
    configFile: path.join(home2, 'tunnel-config.yml'),
    homeDir: home2,
    log: () => {},
    run: async (args) => {
      created.push(args.join(' '));
      if (args[1] === 'list') return '[]';
      if (args[1] === 'create') {
        fs.writeFileSync(path.join(home2, '.cloudflared', `${TUNNEL_ID}.json`), '{}', { mode: 0o600 });
        return `INF Created tunnel x with id ${TUNNEL_ID}`;
      }
      return 'INF Added CNAME';
    },
    probe: async () => ({ ok: true, kind: 'CNAME', records: [`${TUNNEL_ID}.cfargotunnel.com`] }),
    verifyAccess: async () => ({ state: 'unknown', blocking: false, hint: '暂时查不到' }),
  });
  const r2 = await prov2.ensure({ port: 3081 });
  check('预检 unknown 时不拦，正常开通', /^https:\/\/dsh-/.test(r2.url), r2.url);
  check('unknown 时照旧建隧道 + 写 DNS', created.some((c) => c.startsWith('tunnel create')) && created.some((c) => c.includes('route dns')), created.join(' | '));
}

console.log('\n4) 预检结果有缓存：不发重复请求，login 后指纹变了自动失效\n');
{
  const home = tmpHome('preflight-cache');
  const certFile = path.join(home, '.cloudflared', 'cert.pem');
  fs.writeFileSync(certFile, fakeCert());
  let calls = 0;
  const prov = new LocalProvisioner({
    baseDomain: 'matrixboard.cn',
    stateFile: path.join(home, 'tunnel-named.json'),
    homeDir: home,
    log: () => {},
    run: async () => '',
    verifyAccess: async () => { calls += 1; return { state: 'ok', blocking: false, hint: null }; },
  });
  await prov.checkCredentials();
  await prov.checkCredentials();
  check('TTL 内只预检一次', calls === 1, `calls=${calls}`);
  await prov.checkCredentials({ force: true });
  check('force 绕过缓存', calls === 2, `calls=${calls}`);
  fs.writeFileSync(certFile, fakeCert({ apiToken: 'new-token-after-login' }));
  await prov.checkCredentials();
  check('cert.pem 变化后缓存自动失效', calls === 3, `calls=${calls}`);
}

console.log('\n5) 状态归属：跨机拷来的状态不会被当成自己的地址\n');
{
  const home = tmpHome('foreign-state');
  fs.writeFileSync(path.join(home, '.cloudflared', 'cert.pem'), fakeCert());
  fs.writeFileSync(path.join(home, '.cloudflared', `${TUNNEL_ID}.json`), '{}', { mode: 0o600 });
  const stateFile = path.join(home, 'tunnel-named.json');
  // 模拟「把旧 Mac 的 ~/.dsh 整份拷过来」：地址、隧道、凭据都在，机器身份是别人的
  fs.writeFileSync(stateFile, JSON.stringify({
    version: 1,
    installationId: 'from-old-machine',
    subdomain: 'dsh-oldmachine',
    hostname: 'dsh-oldmachine.matrixboard.cn',
    tunnelId: TUNNEL_ID,
    credentialsFile: path.join(home, '.cloudflared', `${TUNNEL_ID}.json`),
    configFile: path.join(home, 'tunnel-config.yml'),
    port: 3081,
    dnsOk: true,
    account: ACCOUNT,
    machine: { id: 'f'.repeat(32), hostname: 'Old-Mac.local' },
  }));
  const logs = [];
  const newTunnel = '12121212-3434-5656-7878-909090909090';
  const prov = new LocalProvisioner({
    baseDomain: 'matrixboard.cn',
    stateFile,
    configFile: path.join(home, 'tunnel-config.yml'),
    homeDir: home,
    log: (m) => logs.push(m),
    run: async (args) => {
      if (args[1] === 'list') return '[]';
      if (args[1] === 'create') {
        fs.writeFileSync(path.join(home, '.cloudflared', `${newTunnel}.json`), '{}', { mode: 0o600 });
        return `INF Created tunnel x with id ${newTunnel}`;
      }
      return 'INF Added CNAME';
    },
    probe: async () => ({ ok: true, kind: 'CNAME', records: [`${newTunnel}.cfargotunnel.com`] }),
    ownerLookup: async () => null,
    verifyAccess: async () => ({ state: 'ok', blocking: false, hint: null }),
  });
  const r = await prov.ensure({ port: 3081 });
  check('识别为外来状态并记录原因', logs.some((m) => String(m).includes('另一台电脑')), logs.join(' | '));
  check('不再复用旧机器的地址', r.hostname !== 'dsh-oldmachine.matrixboard.cn', r.hostname);
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  check('换了新的安装标识', st.installationId !== 'from-old-machine', st.installationId);
  check('状态里改成本机的 machine id', st.machine?.id && st.machine.id !== 'f'.repeat(32), JSON.stringify(st.machine));
  check('machine id 与本机 machine-id 文件一致', st.machine.id === fs.readFileSync(path.join(home, 'machine-id'), 'utf8').trim(), st.machine.id);

  // 反向：本机自己的状态不能被误判
  const again = new LocalProvisioner({
    baseDomain: 'matrixboard.cn', stateFile, configFile: path.join(home, 'tunnel-config.yml'), homeDir: home,
    log: () => {}, run: async () => 'INF ok',
    probe: async () => ({ ok: true, kind: 'CNAME', records: [`${newTunnel}.cfargotunnel.com`] }),
    verifyAccess: async () => ({ state: 'ok', blocking: false, hint: null }),
  });
  const r2 = await again.ensure({ port: 3081 });
  check('同一台机器再次开通：地址不变', r2.hostname === r.hostname, r2.hostname);
}

console.log('\n6) 状态归属：tunnel 凭据丢了要重新分配，不能对外宣称一个跑不起来的地址\n');
{
  const home = tmpHome('lost-creds');
  fs.writeFileSync(path.join(home, '.cloudflared', 'cert.pem'), fakeCert());
  const stateFile = path.join(home, 'tunnel-named.json');
  fs.writeFileSync(stateFile, JSON.stringify({
    version: 1,
    installationId: 'lost',
    subdomain: 'dsh-lostcreds',
    hostname: 'dsh-lostcreds.matrixboard.cn',
    tunnelId: TUNNEL_ID,
    credentialsFile: path.join(home, '.cloudflared', 'gone.json'), // 文件不存在
    configFile: path.join(home, 'tunnel-config.yml'),
    port: 3081,
    dnsOk: true,
  }));
  const fresh = '77777777-6666-5555-4444-333333333333';
  const prov = new LocalProvisioner({
    baseDomain: 'matrixboard.cn', stateFile, configFile: path.join(home, 'tunnel-config.yml'), homeDir: home,
    log: () => {},
    run: async (args) => {
      if (args[1] === 'list') return '[]';
      if (args[1] === 'create') {
        fs.writeFileSync(path.join(home, '.cloudflared', `${fresh}.json`), '{}', { mode: 0o600 });
        return `INF Created tunnel x with id ${fresh}`;
      }
      return 'INF Added CNAME';
    },
    probe: async () => ({ ok: true, kind: 'CNAME', records: [`${fresh}.cfargotunnel.com`] }),
    ownerLookup: async () => null,
    verifyAccess: async () => ({ state: 'ok', blocking: false, hint: null }),
  });
  const r = await prov.ensure({ port: 3081 });
  check('凭据缺失 → 重新分配地址', r.hostname !== 'dsh-lostcreds.matrixboard.cn', r.hostname);
  check('状态写入新的凭据路径', JSON.parse(fs.readFileSync(stateFile, 'utf8')).credentialsFile.endsWith(`${fresh}.json`));
}

console.log('\n7) 老状态文件（没有 machine 字段）被认领，地址不漂移\n');
{
  const home = tmpHome('legacy-state');
  fs.writeFileSync(path.join(home, '.cloudflared', 'cert.pem'), fakeCert());
  fs.writeFileSync(path.join(home, '.cloudflared', `${TUNNEL_ID}.json`), '{}', { mode: 0o600 });
  const stateFile = path.join(home, 'tunnel-named.json');
  fs.writeFileSync(stateFile, JSON.stringify({
    version: 1,
    installationId: 'legacy',
    subdomain: 'dsh-legacyaddr',
    hostname: 'dsh-legacyaddr.matrixboard.cn',
    tunnelId: TUNNEL_ID,
    credentialsFile: path.join(home, '.cloudflared', `${TUNNEL_ID}.json`),
    configFile: path.join(home, 'tunnel-config.yml'),
    port: 3081,
    dnsOk: true,
    account: ACCOUNT,
  }));
  let cliCalls = 0;
  const prov = new LocalProvisioner({
    baseDomain: 'matrixboard.cn', stateFile, configFile: path.join(home, 'tunnel-config.yml'), homeDir: home,
    log: () => {}, run: async () => { cliCalls += 1; return 'INF ok'; },
    probe: async () => ({ ok: true, kind: 'CNAME', records: [`${TUNNEL_ID}.cfargotunnel.com`] }),
  });
  const r = await prov.ensure({ port: 3081 });
  check('老状态照常复用地址', r.hostname === 'dsh-legacyaddr.matrixboard.cn', r.hostname);
  check('零 CLI 调用（缓存命中不拉子进程）', cliCalls === 0, `calls=${cliCalls}`);
  check('认领后补写 machine 字段', Boolean(JSON.parse(fs.readFileSync(stateFile, 'utf8')).machine?.id));
}

console.log('\n8) 没有 cert.pem 也能用固定地址（只读本机状态）\n');
{
  const home = tmpHome('state-only');
  fs.writeFileSync(path.join(home, '.cloudflared', `${TUNNEL_ID}.json`), '{}', { mode: 0o600 });
  const stateFile = path.join(home, 'tunnel-named.json');
  const configFile = path.join(home, 'tunnel-config.yml');
  fs.writeFileSync(configFile, renderConfig({
    tunnelId: TUNNEL_ID, credentialsFile: path.join(home, '.cloudflared', `${TUNNEL_ID}.json`),
    hostname: 'dsh-stateonly.matrixboard.cn', port: 3081,
  }));
  fs.writeFileSync(stateFile, JSON.stringify({
    version: 1,
    installationId: 'state-only',
    subdomain: 'dsh-stateonly',
    hostname: 'dsh-stateonly.matrixboard.cn',
    tunnelId: TUNNEL_ID,
    credentialsFile: path.join(home, '.cloudflared', `${TUNNEL_ID}.json`),
    configFile,
    port: 3081,
    dnsOk: true,
  }));

  const p = new LocalStateProvisioner({ stateFile, configFile, baseDomain: 'matrixboard.cn', homeDir: home, log: () => {} });
  check('只读状态可复用 → configured', p.configured === true);
  const cred = await p.credential({ port: 3082 });
  check('返回同一固定地址', cred.hostname === 'dsh-stateonly.matrixboard.cn', cred.hostname);
  check('端口顺延只重写本地 ingress', /127\.0\.0\.1:3082/.test(fs.readFileSync(configFile, 'utf8')));
  check('状态文件记下新端口', JSON.parse(fs.readFileSync(stateFile, 'utf8')).port === 3082);

  // 外来状态：绝不冒充
  const foreignState = path.join(home, 'foreign.json');
  fs.writeFileSync(foreignState, JSON.stringify({
    ...JSON.parse(fs.readFileSync(stateFile, 'utf8')),
    machine: { id: 'e'.repeat(32), hostname: 'Other.local' },
  }));
  const pf = new LocalStateProvisioner({ stateFile: foreignState, configFile, baseDomain: 'matrixboard.cn', homeDir: home, log: () => {} });
  check('外来状态 → configured=false（不冒充别人的地址）', pf.configured === false);

  // 凭据缺失：同样不可用
  const brokenState = path.join(home, 'broken.json');
  fs.writeFileSync(brokenState, JSON.stringify({ ...JSON.parse(fs.readFileSync(stateFile, 'utf8')), credentialsFile: path.join(home, 'nope.json') }));
  const pb = new LocalStateProvisioner({ stateFile: brokenState, configFile, baseDomain: 'matrixboard.cn', homeDir: home, log: () => {} });
  check('凭据文件缺失 → configured=false', pb.configured === false);

  const reset = await p.reset();
  check('reset 幂等且删掉状态与 ingress', reset.reset === true && !fs.existsSync(stateFile) && !fs.existsSync(configFile), JSON.stringify(reset));
  const reset2 = await p.reset();
  check('重复 reset 不报错', reset2.reset === true && reset2.hadState === false, JSON.stringify(reset2));
}

console.log('\n9) 统一判定：两个入口同一套顺序\n');
{
  const home = tmpHome('resolve');
  fs.writeFileSync(path.join(home, '.cloudflared', 'cert.pem'), fakeCert());
  const withCert = resolveProvisioner({
    tunnelCfg: { baseDomain: 'matrixboard.cn', executable: 'cloudflared' },
    stateFile: path.join(home, 'tunnel-named.json'),
    homeDir: home,
    log: () => {},
  });
  check('有 cert.pem → local', withCert?.kind === 'local', withCert?.kind);
  check('local 开通器挂上了凭据预检', typeof withCert?.checkCredentials === 'function' && typeof withCert?.verifyAccess === 'function');

  const noCertHome = tmpHome('resolve-state');
  fs.writeFileSync(path.join(noCertHome, '.cloudflared', `${TUNNEL_ID}.json`), '{}', { mode: 0o600 });
  const configFile = path.join(noCertHome, 'tunnel-config.yml');
  fs.writeFileSync(configFile, renderConfig({
    tunnelId: TUNNEL_ID, credentialsFile: path.join(noCertHome, '.cloudflared', `${TUNNEL_ID}.json`),
    hostname: 'dsh-resolve.matrixboard.cn', port: 3081,
  }));
  const stateFile = path.join(noCertHome, 'tunnel-named.json');
  fs.writeFileSync(stateFile, JSON.stringify({
    version: 1, installationId: 'r', subdomain: 'dsh-resolve', hostname: 'dsh-resolve.matrixboard.cn',
    tunnelId: TUNNEL_ID, credentialsFile: path.join(noCertHome, '.cloudflared', `${TUNNEL_ID}.json`),
    configFile, port: 3081, dnsOk: true,
  }));
  const stateOnly = resolveProvisioner({
    tunnelCfg: { baseDomain: 'matrixboard.cn' }, stateFile, homeDir: noCertHome, log: () => {},
  });
  check('没有 cert.pem 但有本机状态 → 只读状态（不再掉回随机地址）', stateOnly?.kind === 'state' && stateOnly.configured === true, stateOnly?.kind);
  const emptyHome = path.join(tmp, 'empty-home');
  fs.mkdirSync(emptyHome, { recursive: true });
  const nothing = resolveProvisioner({
    tunnelCfg: { baseDomain: 'matrixboard.cn' }, stateFile: path.join(tmp, 'empty', 'tunnel.json'), homeDir: emptyHome, log: () => {},
  });
  check('什么凭据都没有 → null（保持 Quick Tunnel）', nothing === null, String(nothing));
  check('cloudflare 形态工厂仍只认齐备凭据', createProvisioner({ apiToken: '', accountId: '' }, { stateFile: path.join(tmp, 'x.json') }) === null);
}

console.log('\n10) REST：凭据结论进 summary，reset 回环-only 且幂等\n');
{
  const home = tmpHome('rest');
  fs.writeFileSync(path.join(home, '.cloudflared', 'cert.pem'), fakeCert());
  fs.writeFileSync(path.join(home, '.cloudflared', `${TUNNEL_ID}.json`), '{}', { mode: 0o600 });
  const stateFile = path.join(home, 'tunnel-named.json');
  fs.writeFileSync(stateFile, JSON.stringify({
    version: 1, installationId: 'rest', subdomain: 'dsh-restaddr', hostname: 'dsh-restaddr.matrixboard.cn',
    tunnelId: TUNNEL_ID, credentialsFile: path.join(home, '.cloudflared', `${TUNNEL_ID}.json`),
    configFile: path.join(home, 'tunnel-config.yml'), port: 3081, dnsOk: true, account: ACCOUNT,
  }));
  const prov = new LocalProvisioner({
    baseDomain: 'matrixboard.cn', stateFile, configFile: path.join(home, 'tunnel-config.yml'), homeDir: home,
    log: () => {}, run: async () => 'INF ok',
    probe: async () => ({ ok: true, kind: 'CNAME', records: [`${TUNNEL_ID}.cfargotunnel.com`] }),
    verifyAccess: async () => ({ state: 'zone-missing', blocking: true, hint: '当前登录的账号里看不到这个域名' }),
  });
  await prov.checkCredentials();

  const port = Number(process.env.PORT || 3187) + 21;
  const fake = fakeTunnel('named');
  const gw = await createGateway({
    host: createMockHost(),
    port,
    dev: true,
    log: () => {},
    tunnelExecutable: fake.executable,
    tunnelSpawn: fake.spawnImpl,
    tunnelProvisioner: prov,
  });
  const { port: livePort } = await gw.start();
  try {
    const summary = await httpJson({ port: livePort, path: '/mobile/v1/desktop/summary' });
    check('summary 带出凭据结论', summary.body?.tunnel?.credentials?.blocking === true, JSON.stringify(summary.body?.tunnel?.credentials));
    check('summary 不回传 token', !JSON.stringify(summary.body).includes('zone-token-abc'));

    const blocked = await httpJson({
      port: livePort, method: 'POST', path: '/mobile/v1/tunnel/reset',
      headers: { 'CF-Ray': '8fakelax', 'CF-Connecting-IP': '203.0.113.9' },
    });
    check('隧道来源不能 reset（管理面守卫）', blocked.status === 403 && blocked.body?.error?.code === 4003, JSON.stringify(blocked.body));

    const ok = await httpJson({ port: livePort, method: 'POST', path: '/mobile/v1/tunnel/reset' });
    check('本机 reset 成功', ok.status === 200 && ok.body?.reset === true, JSON.stringify(ok.body));
    check('reset 后状态文件已删除', !fs.existsSync(stateFile));
    check('reset 返回 status 供面板刷新', ok.body?.status?.provisioned === false, JSON.stringify(ok.body?.status));

    const again = await httpJson({ port: livePort, method: 'POST', path: '/mobile/v1/tunnel/reset' });
    check('重复 reset 幂等', again.status === 200 && again.body?.hadState === false, JSON.stringify(again.body));
    check('reset 后不再宣称已开通', again.body?.status?.provisioned === false);
  } finally {
    await gw.stop();
  }
}

for (const d of dirs) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log(`\n结果：${pass} 通过 / ${failures.length} 失败（共 ${pass + failures.length}）`);
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
