// test/ops.mjs — GW-8（隧道）与 GW-9（诊断包）验收
//
// 关键立场：cloudflared 未安装时不伪装可用。这里用一个假可执行文件模拟真实输出格式，
// 把「解析地址 / 地址漂移 / 超时 / 进程回收 / 事件广播」全部真跑一遍，
// 而不是只断言函数返回值。

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway } from '../src/server.mjs';
import { TunnelManager } from '../src/tunnel.mjs';
import { createMockHost } from '../src/adapter/mock-host.mjs';
import { connect, httpJson } from './lib/wsclient.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_OK = path.join(HERE, 'fixtures/fake-cloudflared.sh');
const FAKE_SILENT = path.join(HERE, 'fixtures/fake-cloudflared-silent.sh');
const ADDR_PATTERN = /^https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com$/;

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 1. TunnelManager：未安装必须如实报错 ----
console.log('\n▶ 隧道：未安装 cloudflared');
{
  const tunnel = new TunnelManager({ port: 3199, executable: '/nonexistent/cloudflared' });
  try {
    await tunnel.start();
    check('未安装时应拒绝启动', false, 'start() 竟然成功了');
  } catch (err) {
    check('未安装 → 4021（能力缺失）', err.code === 4021, `code=${err.code}`);
    check('错误信息可指导用户', String(err.message).includes('cloudflared'), err.message);
  }
  check('状态标为 failed 而非 running', tunnel.status().state === 'failed', tunnel.status().state);
  check('状态里标明可执行文件缺失', tunnel.status().executable === 'missing');
}

// ---- 1b. 缺失提示按平台给不同安装指引（macOS brew / Windows exe）----
console.log('\n▶ 隧道：缺失提示按平台分流');
{
  const realPlatform = process.platform;
  const setPlatform = (p) => Object.defineProperty(process, 'platform', { value: p, configurable: true });
  const detailFor = async (platform) => {
    setPlatform(platform);
    const t = new TunnelManager({ port: 3199, executable: '/nonexistent/cloudflared' });
    try { await t.start(); return ''; } catch (e) { return String(e.extra?.detail || ''); }
  };
  try {
    const mac = await detailFor('darwin');
    check('macOS 提示含 brew install', mac.includes('brew install cloudflared'), mac);
    const win = await detailFor('win32');
    check('Windows 提示含 .exe 与 PATH', win.includes('cloudflared.exe') && win.includes('PATH'), win);
    check('Windows 提示不再误导用 brew', !win.includes('brew install'), win);
  } finally {
    setPlatform(realPlatform);
  }
}

// ---- 2. TunnelManager：启动 / 幂等 / 地址漂移 / 回收 ----
console.log('\n▶ 隧道：启动、幂等与地址漂移');
let liveTunnel = null;
{
  const changes = [];
  const logs = [];
  const tunnel = new TunnelManager({
    port: 3199,
    executable: FAKE_OK,
    log: (m) => logs.push(m),
    onAddrChanged: (url, prevUrl) => changes.push({ url, prevUrl }),
  });
  liveTunnel = tunnel;

  const started = await tunnel.start();
  check('启动后进入 running', started.state === 'running', started.state);
  check('解析出 trycloudflare 地址', ADDR_PATTERN.test(started.url || ''), started.url);
  const firstUrl = started.url;

  const again = await tunnel.start();
  check('重复 start 幂等（地址不变）', again.url === firstUrl, `${again.url} vs ${firstUrl}`);
  check('首次启动不广播漂移', changes.length === 0, JSON.stringify(changes));

  const stopped = await tunnel.stop();
  check('stop 成功', stopped.stopped === true);
  check('stop 后状态为 stopped 且清空地址', tunnel.status().state === 'stopped' && !tunnel.status().url);

  const restarted = await tunnel.start();
  check('重启拿到新地址（模拟 Quick Tunnel 换域名）', restarted.url !== firstUrl, `${firstUrl} → ${restarted.url}`);
  check('地址漂移广播一次', changes.length === 1, JSON.stringify(changes));
  if (changes.length === 1) {
    check('广播内容含新旧地址', changes[0].url === restarted.url && changes[0].prevUrl === firstUrl,
      JSON.stringify(changes[0]));
  }

  await tunnel.stop();
  check('停止后无子进程句柄', tunnel.child === null);
}

// ---- 3. TunnelManager：启动超时 ----
console.log('\n▶ 隧道：启动超时');
{
  const tunnel = new TunnelManager({
    port: 3199,
    executable: FAKE_SILENT,
    startTimeoutMs: 500,
  });
  const begin = Date.now();
  try {
    await tunnel.start();
    check('不吐地址时应超时报错', false, 'start() 竟然成功了');
  } catch (err) {
    const elapsed = Date.now() - begin;
    check('超时 → 4500', err.code === 4500, `code=${err.code}`);
    check('在配置的时间附近超时', elapsed >= 400 && elapsed < 3000, `${elapsed}ms`);
  }
  check('超时后状态为 failed', tunnel.status().state === 'failed', tunnel.status().state);
  await tunnel.stop();
}

// ---- 4. REST：隧道接口与诊断包 ----
console.log('\n▶ REST：隧道接口与诊断包');
const PORT = Number(process.env.PORT || 3187) + 3;
const logLines = [];
const host = createMockHost({ log: (m) => logLines.push(m) });
const gw = await createGateway({
  host,
  port: PORT,
  dev: true,
  log: (m) => logLines.push(m),
  tunnelExecutable: FAKE_OK,
});
const addr = await gw.start();
const { port } = addr;

const codeRes = await httpJson({ port, method: 'POST', path: '/mobile/v1/pairing/code', body: {} });
const redeem = await httpJson({
  port,
  method: 'POST',
  path: '/mobile/v1/pairing/redeem',
  body: { code: codeRes.body.code, installId: 'ins_ops', deviceName: 'ops' },
});
const token = redeem.body.deviceToken;
check('配对成功拿到 token', Boolean(token));

const noAuthTunnel = await httpJson({ port, path: '/mobile/v1/tunnel' });
check('隧道状态需鉴权', noAuthTunnel.status === 401 && noAuthTunnel.body?.error?.code === 4001);

const initial = await httpJson({ port, path: '/mobile/v1/tunnel', token });
check('初始状态 stopped', initial.status === 200 && initial.body.state === 'stopped', JSON.stringify(initial.body));
check('状态含可执行文件探测结果', initial.body.executable === 'found', initial.body.executable);

const startRes = await httpJson({ port, method: 'POST', path: '/mobile/v1/tunnel/start', token });
check('POST /tunnel/start → running', startRes.status === 200 && startRes.body.state === 'running', JSON.stringify(startRes.body));
check('返回可用的公网地址', ADDR_PATTERN.test(startRes.body.url || ''), startRes.body.url);

const bundle = await httpJson({ port, path: '/mobile/v1/diag/bundle', token });
const bundleText = JSON.stringify(bundle.body);
check('诊断包含 stages', Array.isArray(bundle.body.stages) && bundle.body.stages.length >= 6);
check('诊断包含隧道阶段', bundle.body.stages.some((s) => s.name === 'tunnel' && s.state === 'ok'),
  JSON.stringify(bundle.body.stages));
check('诊断包含 transport 与 stats', Boolean(bundle.body.transport) && Boolean(bundle.body.stats));
check('诊断含可直接粘贴的文本', typeof bundle.body.text === 'string' && bundle.body.text.includes('DSH-mobile 诊断包'));
check('文本里带上隧道状态', bundle.body.text.includes('running'), bundle.body.text.split('\n').pop());
check('诊断包不含设备 token', !bundleText.includes(token), '泄露了 token');
check('诊断包不含绝对路径', !bundleText.includes('/Users/') && !bundleText.includes(HERE), '泄露了绝对路径');

const stopRes = await httpJson({ port, method: 'POST', path: '/mobile/v1/tunnel/stop', token });
check('POST /tunnel/stop → stopped', stopRes.status === 200 && stopRes.body.state === 'stopped', JSON.stringify(stopRes.body));

// ---- 5. 地址漂移必须广播给在线客户端 ----
console.log('\n▶ 隧道：地址漂移广播（在线客户端真实接收）');
{
  const wsTicket = await httpJson({ port, method: 'POST', path: '/mobile/v1/ws-ticket', token });
  const client = await connect({
    port,
    protocols: ['dsh.v1'],
    headers: { Authorization: `Ticket ${wsTicket.body.ticket}` },
  });
  client.send({
    t: 'hello', protocolVersion: '1.0', caps: ['tasks.read'],
    deviceId: redeem.body.deviceId, installId: 'ins_ops',
  });
  const ready = await client.next(4000).catch(() => null);
  check('WS 握手成功', ready?.json?.t === 'ready',
    `status=${client.status} proto=${client.protocol} frame=${JSON.stringify(ready?.json)}`);

  const first = await httpJson({ port, method: 'POST', path: '/mobile/v1/tunnel/start', token });
  const firstUrl = first.body.url;

  // 第一次启动后 lastUrl 已有值，重新启动才会产生漂移
  await httpJson({ port, method: 'POST', path: '/mobile/v1/tunnel/stop', token });
  const second = await httpJson({ port, method: 'POST', path: '/mobile/v1/tunnel/start', token });

  check('两次启动地址不同', firstUrl !== second.body.url, `${firstUrl} vs ${second.body.url}`);

  let drift = null;
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && !drift) {
    const frame = await client.next(1000).catch(() => null);
    // 队列里可能还压着「上一次启动」的漂移帧，必须匹配本次目标地址
    if (
      frame?.json?.kind === 'gateway' &&
      frame.json.data?.event === 'addr_changed' &&
      frame.json.data?.baseUrl === second.body.url
    ) {
      drift = frame.json;
    }
  }
  check('在线客户端收到 addr_changed', Boolean(drift), drift ? 'yes' : 'no frame');
  if (drift) {
    check('addr_changed 带新地址', drift.data.baseUrl === second.body.url, drift.data.baseUrl);
    check('addr_changed 带旧地址', drift.data.prevBaseUrl === firstUrl, drift.data.prevBaseUrl);
    check('gateway 事件不占用任务 seq', drift.seq === 0 && drift.taskId === null, JSON.stringify({ seq: drift.seq, taskId: drift.taskId }));
  }
  client.close();
}

// ---- 6. 重启宿主事件字段与契约一致 ----
console.log('\n▶ 事件字段：host.restarted 使用 data.event（契约字段）');
{
  const wsTicket = await httpJson({ port, method: 'POST', path: '/mobile/v1/ws-ticket', token });
  const client = await connect({
    port,
    protocols: ['dsh.v1'],
    headers: { Authorization: `Ticket ${wsTicket.body.ticket}` },
  });
  client.send({
    t: 'hello', protocolVersion: '1.0', caps: ['tasks.read'],
    deviceId: redeem.body.deviceId, installId: 'ins_ops',
  });
  const readyFrame = await client.next(4000).catch(() => null);
  check('WS 第二次握手成功', readyFrame?.json?.t === 'ready', `status=${client.status}`);
  await httpJson({ port, method: 'POST', path: '/__mock/restart-host', body: { reason: 'ops' } });

  let restarted = null;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !restarted) {
    const frame = await client.next(800).catch(() => null);
    if (frame?.json?.kind === 'gateway' && frame.json.data?.event === 'host.restarted') {
      restarted = frame.json;
    }
  }
  check('收到 host.restarted 事件', Boolean(restarted));
  if (restarted) {
    check('字段名为 data.event（不是 data.type）', restarted.data.type === undefined, JSON.stringify(restarted.data));
    check('带 gen 与 prevGen', typeof restarted.data.gen === 'string' && typeof restarted.data.prevGen === 'string',
      JSON.stringify({ gen: restarted.data.gen, prevGen: restarted.data.prevGen }));
  }
  client.close();
}

// ---- 收尾 ----
await gw.stop();
if (liveTunnel) await liveTunnel.stop();

console.log(`\n结果：${pass} 通过 / ${failures.length} 失败`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(1);
}
process.exit(0);
