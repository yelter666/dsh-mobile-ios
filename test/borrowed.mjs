// test/borrowed.mjs — 从 dsh-plugin-mobile-gateway 0.12.1 借鉴的机制验收
//
// 覆盖四项借鉴（详见 cordis.patch.yml 头注释与各模块内注释）：
//   1. 隧道意外退出自动重拉 + 显式 stop 取消重拉；
//   2. 诊断日志脱敏（JWT / 设备令牌 / Bearer 凭证）；
//   3. 设备注册表持久化：跨实例恢复 / 损坏文件备份后自愈；
//   4. revoke 管理面仅本机（loopback-only）。

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { TunnelManager, redactSecrets } from '../src/tunnel.mjs';
import { PairingService } from '../src/pairing.mjs';
import { createGateway } from '../src/server.mjs';
import { createMockHost } from '../src/adapter/mock-host.mjs';
import { httpJson } from './lib/wsclient.mjs';
import { fakeTunnel } from './lib/fake-tunnel.mjs';

// 假 cloudflared 统一来自 test/lib/fake-tunnel：node 脚本 + spawnImpl，
// 不再用只能在 POSIX 执行的 .sh（Windows 上 spawn 会 EFTYPE）。
const CRASH_TUNNEL = fakeTunnel('crash');
const SILENT_TUNNEL = fakeTunnel('silent');
const FAKE_CRASH = CRASH_TUNNEL.executable;
const FAKE_SILENT = SILENT_TUNNEL.executable;

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-borrowed-'));

// ---- 1. 诊断脱敏 ----
console.log('\n▶ 借鉴：日志脱敏');
{
  const line = 'token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig Bearer dt_0123456789abcdef0123456789abcdef01234567';
  const out = redactSecrets(line);
  check('JWT 被抹掉', !out.includes('eyJhbGciOiJIUzI1NiJ9'), out);
  check('设备令牌被抹掉', !out.includes('dt_0123456789abcdef'), out);
  check('Bearer 值被抹掉', !/Bearer\s+\S/.test(out.replace('[redacted-credential]', '')), out);
  check('非密钥内容保留', out.includes('token='), out);
}

// ---- 2. 隧道自动重拉 ----
console.log('\n▶ 借鉴：隧道意外退出自动重拉');
{
  const changes = [];
  const logs = [];
  const tunnel = new TunnelManager({
    port: 3199,
    executable: FAKE_CRASH,
    spawnImpl: CRASH_TUNNEL.spawnImpl,
    log: (m) => logs.push(m),
    onAddrChanged: (url, prevUrl) => changes.push({ url, prevUrl }),
    autoRestart: true,
    restartDelayMs: 150,
  });

  const first = await tunnel.start();
  check('首次启动 running', first.state === 'running', first.state);
  const firstUrl = first.url;

  // 假可执行文件 0.6s 后自崩 → 应进入 restarting → 自动重拉回 running
  let recovered = null;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const s = tunnel.status();
    if (s.state === 'running' && s.url && s.url !== firstUrl) { recovered = s; break; }
    if (s.state !== 'running' && s.state !== 'restarting' && s.state !== 'starting') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  check('崩溃后自动重拉出新地址', Boolean(recovered), tunnel.status().state);
  if (recovered) {
    check('重拉后地址漂移被广播', changes.some((c) => c.url === recovered.url && c.prevUrl === firstUrl),
      JSON.stringify(changes));
    check('日志记录了重拉动作', logs.some((m) => m.includes('自动重拉')), logs.join(' | ').slice(-200));
  }

  await tunnel.stop();
  check('显式 stop 后状态 stopped', tunnel.status().state === 'stopped', tunnel.status().state);
  await new Promise((r) => setTimeout(r, 400));
  check('stop 后不再悄悄重启', tunnel.status().state === 'stopped', tunnel.status().state);
}

// ---- 3. 启动失败不触发重拉（能力缺失不空转）----
console.log('\n▶ 借鉴边界：启动失败不重拉');
{
  const logs = [];
  const tunnel = new TunnelManager({
    port: 3199,
    executable: FAKE_SILENT, // 永不吐地址 → 必然走超时路径
    spawnImpl: SILENT_TUNNEL.spawnImpl,
    autoRestart: true,
    restartDelayMs: 120,
    startTimeoutMs: 300,
    log: (m) => logs.push(m),
  });
  try { await tunnel.start(); } catch { /* 超时即预期 */ }
  check('超时后 failed', tunnel.status().state === 'failed', tunnel.status().state);
  await new Promise((r) => setTimeout(r, 400));
  check('启动失败不自动重试', tunnel.status().state === 'failed', tunnel.status().state);
  check('没有重拉日志', !logs.some((m) => m.includes('自动重拉')), logs.join(' | '));
  await tunnel.stop();
}

// ---- 4. 设备注册表持久化 ----
console.log('\n▶ 借鉴：设备注册表持久化');
{
  const file = path.join(tmpRoot, 'devices.json');
  const logA = [];
  const a = new PairingService({ log: (m) => logA.push(m), file });
  const issued = a.issueCode({ deviceName: '持久化测试' });
  check('配对码有效期 120 秒', issued.expiresInSec === 120, String(issued.expiresInSec));
  const redeemed = a.redeem({ code: issued.code, installId: 'ins_persist', deviceName: '持久化测试' });

  const stat = fs.statSync(file);
  check('注册表文件已落盘', stat.isFile(), file);
  // Windows 没有 POSIX 权限位（stat.mode 恒 0666），这里只对 POSIX 断言
  if (process.platform === 'win32') {
    console.log('  · 跳过「文件权限 0600」：Windows 无 POSIX 权限位');
    pass += 1;
  } else {
    check('文件权限 0600', (stat.mode & 0o777) === 0o600, (stat.mode & 0o777).toString(8));
  }

  // 新实例（模拟网关重启）应恢复设备
  const logB = [];
  const b = new PairingService({ log: (m) => logB.push(m), file });
  const device = b.verify(redeemed.deviceToken);
  check('重启后 token 仍有效', device.deviceId === redeemed.deviceId, JSON.stringify({ a: device?.deviceId, b: redeemed.deviceId }));
  check('恢复时打日志', logB.some((m) => m.includes('恢复 1 台设备')), logB.join(' | '));

  // 明文 token 绝不落盘
  const raw = fs.readFileSync(file, 'utf8');
  check('文件里没有明文 token', !raw.includes(redeemed.deviceToken), '泄露明文');

  // 撤销也持久化
  b.revokeAll();
  const c = new PairingService({ log: () => {}, file });
  try {
    c.verify(redeemed.deviceToken);
    check('撤销状态跨重启保留', false, '撤销后 token 仍有效');
  } catch (err) {
    check('撤销状态跨重启保留（4009）', err.code === 4009, `code=${err.code}`);
  }
}

// ---- 设备名称：hello 上报的「关于」页全称覆盖配对时的初始名 ----
console.log('\n▶ 设备名称：全称同步且不截断');
{
  const file = path.join(tmpRoot, 'devices-rename.json');
  const svc = new PairingService({ log: () => {}, file });
  const issued = svc.issueCode({ deviceName: 'desktop-sidebar' });
  const redeemed = svc.redeem({ code: issued.code, installId: 'ins_rename', deviceName: 'desktop-sidebar' });
  const fullName = '李大葉的 iPhone 17 Pro Max（工作机）';
  check('hello 全称覆盖初始名', svc.renameDevice(redeemed.deviceId, fullName) === true);
  check('清单展示完整名称', svc.listDevices()[0].deviceName === fullName, svc.listDevices()[0].deviceName);
  check('空名不改已有名称', svc.renameDevice(redeemed.deviceId, '   ') === false);
  check('重启后仍是全称', new PairingService({ log: () => {}, file }).listDevices()[0].deviceName === fullName);
  svc.revokeDevice(redeemed.deviceId);
  check('撤销后不接受改名', svc.renameDevice(redeemed.deviceId, '别的名字') === false);
}

// ---- 5. 设备上限与同机去重 ----
console.log('\n▶ 借鉴（2026-11-18 面板 60 台事故）：installId 去重 + 活跃上限 5 台');
{
  const file = path.join(tmpRoot, 'devices-cap.json');
  // 出码限速 5 次/分钟：测试要连出 7 个码，用递增时钟逐次越过限速窗口
  let clock = Date.now();
  const svc = new PairingService({ log: () => {}, file, now: () => clock });
  const tokenById = new Map();
  const pair = (installId, name) => {
    clock += 61_000; // 越过限速窗口，code createdAt/TTL 也随之前移但不影响断言
    const code = svc.issueCode({ deviceName: name }).code;
    const result = svc.redeem({ code, installId, deviceName: name });
    tokenById.set(result.deviceId, result.deviceToken);
    return result;
  };

  // 同一 installId 反复重装重配：不应堆记录（历史上同机 6 条、总数 60）
  const first = pair('ins_dup', '反复重装的手机');
  const second = pair('ins_dup', '反复重装的手机');
  check('同 installId 重配对不堆记录', svc.stats().activeDevices === 1, JSON.stringify(svc.stats()));
  try { svc.verify(first.deviceToken); check('旧凭证被覆盖后失效', false, '旧 token 仍有效'); }
  catch (err) { check('旧凭证被覆盖后失效（4001）', err.code === 4001, `code=${err.code}`); }
  check('新凭证可用', svc.verify(second.deviceToken).deviceId === second.deviceId);

  // 上限 5 台：第 6 台挤掉最旧的，被挤手机下次请求收到 4009 重新配对
  const tokens = { ins_dup: second.deviceToken };
  for (let i = 2; i <= 5; i += 1) {
    tokens[`ins_${i}`] = pair(`ins_${i}`, `手机${i}`).deviceToken;
  }
  check('满 5 台', svc.stats().activeDevices === 5, JSON.stringify(svc.stats()));
  pair('ins_6', '手机6');
  check('第 6 台入表后仍 5 台活跃', svc.stats().activeDevices === 5, JSON.stringify(svc.stats()));
  try { svc.verify(tokens.ins_dup); check('最旧设备被挤掉', false, 'ins_dup 的 token 仍有效'); }
  catch (err) { check('最旧设备被挤掉（4009）', err.code === 4009, `code=${err.code}`); }
  check('其余设备不受影响', svc.verify(tokens.ins_2).deviceName === '反复重装的手机' || svc.verify(tokens.ins_2).deviceName === '手机2');
  check('撤销记录保留做 audit', svc.devices.size >= 6, String(svc.devices.size));

  // 面板设备清单：真实活跃设备 + 展示名，绝不带凭证哈希 / installId
  const listed = svc.listDevices();
  check('设备清单只列活跃设备', listed.length === 5, JSON.stringify(listed.map((d) => d.deviceName)));
  check('设备清单带可读名称', listed.some((d) => d.deviceName.includes('手机')),
        JSON.stringify(listed.map((d) => d.deviceName)));
  check('设备清单不泄露凭证哈希', listed.every((d) => !('deviceTokenHash' in d) && !('installId' in d)),
        JSON.stringify(listed[0]));
  check('上限常量可从服务读取', svc.maxDevices === 5, String(svc.maxDevices));

  // 单台下线：只影响目标设备，其他凭证仍可用
  const targetId = listed[0].deviceId;
  const otherId = listed[1].deviceId;
  const otherToken = Object.entries(tokens).find(([k]) => k !== 'ins_dup')?.[1];
  check('下线命中目标设备', svc.revokeDevice(targetId) === 1);
  check('下线幂等（重复调用返回 0）', svc.revokeDevice(targetId) === 0);
  check('被下线设备从清单消失', svc.listDevices().every((d) => d.deviceId !== targetId));
  check('目标设备凭证回 4009', (() => {
    try {
      svc.verify(tokenById.get(targetId));
      return false;
    } catch (err) { return err.code === 4009; }
  })());
  check('其他设备仍在线', svc.listDevices().some((d) => d.deviceId === otherId));
}

// ---- 6. 损坏注册表自愈 ----
console.log('\n▶ 借鉴（有意偏离）：损坏文件备份后空表启动');
{
  const file = path.join(tmpRoot, 'broken.json');
  fs.writeFileSync(file, '{ "version": 1, "devices": [ 截断');
  const logs = [];
  const s = new PairingService({ log: (m) => logs.push(m), file });
  check('损坏文件不炸构造器', s.devices.size === 0, String(s.devices.size));
  check('打了损坏告警', logs.some((m) => m.includes('损坏')), logs.join(' | '));
  const backups = fs.readdirSync(tmpRoot).filter((f) => f.startsWith('broken.json.corrupt-'));
  check('损坏文件已备份', backups.length === 1, backups.join(','));

  // 结构不符（合法 JSON 但字段缺失）同样自愈
  const file2 = path.join(tmpRoot, 'wrongshape.json');
  fs.writeFileSync(file2, JSON.stringify({ hello: 'world' }));
  const s2 = new PairingService({ log: () => {}, file: file2 });
  check('结构不符同样自愈', s2.devices.size === 0, String(s2.devices.size));
}

// ---- 6. revoke 仅本机（loopback-only）----
console.log('\n▶ 借鉴：revoke 管理面仅本机');
{
  // 单元路径：假 socket 直接打路由，不依赖真网卡（沙箱内可能没有非回环地址）
  {
    const events = await import('node:events');
    const { createRestRouter } = await import('../src/rest.mjs');
    const router = createRestRouter({
      core: { stats: () => ({ pairing: { activeDevices: 1 } }), notifyGateway: () => {} },
      pairing: new PairingService({ log: () => {} }),
      host: { kind: 'mock', info: () => ({ hostId: 'h', hostName: 'n', hostVersion: 'v', platform: 'darwin', protocolVersion: '1.0', caps: [] }) },
      tickets: { issue: () => ({ ticket: 't' }) },
      config: {},
      log: () => {},
    });
    const callRoute = (remoteAddress, headers = {}) => new Promise((resolve) => {
      const req = new events.EventEmitter();
      req.method = 'POST';
      req.url = '/mobile/v1/pairing/revoke';
      req.headers = { authorization: 'Bearer whatever', ...headers };
      req.socket = { remoteAddress };
      const res = {
        statusCode: 0,
        body: '',
        writeHead(code) { this.statusCode = code; },
        end(payload) { this.body = payload; resolve(this); },
      };
      router(req, res);
      queueMicrotask(() => req.emit('end'));
    });
    const lanRes = await callRoute('192.168.1.50');
    check('单元：非本机来源 revoke → 4003', lanRes.statusCode === 403 && JSON.parse(lanRes.body).error.code === 4003,
      `${lanRes.statusCode} ${lanRes.body}`);
    const lbRes = await callRoute('127.0.0.1');
    check('单元：本机来源放行（走到 auth 后 4001）', lbRes.statusCode === 401, `${lbRes.statusCode} ${lbRes.body}`);

    // Origin 门：宿主 Electron 自有 scheme（dsh-app://app）必须放行，
    // 这是桌面侧栏面板的真实调用方（2026-11-18 回归：非 http(s) 源被误伤）。
    const appSchemeRes = await callRoute('127.0.0.1', { origin: 'dsh-app://app' });
    check('单元：宿主自有 scheme 源放行（走到 auth 后 4001）',
      appSchemeRes.statusCode === 401, `${appSchemeRes.statusCode} ${appSchemeRes.body}`);
    const evilRes = await callRoute('127.0.0.1', { origin: 'https://evil.example' });
    check('单元：公网 http(s) 源 → 4003', evilRes.statusCode === 403 && JSON.parse(evilRes.body).error.code === 4003,
      `${evilRes.statusCode} ${evilRes.body}`);
    const forgedRes = await callRoute('192.168.1.50', { origin: 'dsh-app://app' });
    check('单元：局域网伪造自有 scheme 源仍 → 4003（socket 门兜底）',
      forgedRes.statusCode === 403 && JSON.parse(forgedRes.body).error.code === 4003,
      `${forgedRes.statusCode} ${forgedRes.body}`);
    const otherSchemeRes = await callRoute('127.0.0.1', { origin: 'mcp://somewhere' });
    check('单元：其他自定义 scheme 源放行（非 http(s) 即本机特权上下文）',
      otherSchemeRes.statusCode === 401, `${otherSchemeRes.statusCode} ${otherSchemeRes.body}`);
  }

  // 端到端路径（有非回环 IPv4 时才跑）：经 LAN IP 访问 = 局域网内另一台设备
  // 注意 Node ≥18 的 family 是 'IPv4' 字符串，不是 'AF_INET'
  const nets = os.networkInterfaces();
  const lanAddr = Object.values(nets).flat()
    .find((n) => n && !n.internal && (n.family === 'IPv4' || n.family === 'AF_INET'))?.address;
  if (!lanAddr) {
    console.log('  ⚠ 本机无非回环 IPv4 地址，跳过端到端非回环实测（单元路径已覆盖）');
  } else {
    const host = createMockHost({ log: () => {} });
    const gw = await createGateway({ host, port: 3188, dev: true, allowLan: true, log: () => {} });
    const addr = await gw.start();
    const codeRes = await httpJson({ port: addr.port, host: lanAddr, method: 'POST', path: '/mobile/v1/pairing/code', body: {} });
    check('端到端：非本机来源配对码 → 4003', codeRes.status === 403 && codeRes.body?.error?.code === 4003,
      JSON.stringify(codeRes.body));

    const codeResLocal = await httpJson({ port: addr.port, method: 'POST', path: '/mobile/v1/pairing/code', body: {} });
    const redeem = await httpJson({
      port: addr.port, method: 'POST', path: '/mobile/v1/pairing/redeem',
      body: { code: codeResLocal.body.code, installId: 'ins_lb', deviceName: 'lb' },
    });
    const lanRevoke = await httpJson({ port: addr.port, host: lanAddr, method: 'POST', path: '/mobile/v1/pairing/revoke', token: redeem.body.deviceToken });
    check('端到端：非本机来源 revoke → 4003（即使带有效 token）',
      lanRevoke.status === 403 && lanRevoke.body?.error?.code === 4003, JSON.stringify(lanRevoke.body));

    await gw.stop();
  }
}

// ---- 收尾 ----
fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${failures.length} 失败`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(1);
}
process.exit(0);
