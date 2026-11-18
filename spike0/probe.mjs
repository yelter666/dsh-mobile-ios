// spike0/probe.mjs — Spike-0 六项验收的可重复探测
// 用法：
//   node spike0/probe.mjs                    # mock 适配器（本机即可跑，验证 1/2/5/6 项）
//   node spike0/probe.mjs --host=mux --mux-url=http://127.0.0.1:3000
//                                           # 在真机上跑，额外验证 3/4 项（需宿主暴露 /api/remote.mux）
// 输出：控制台表格 + spike0/last-report.json

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createGateway } from '../src/server.mjs';
import { createMockHost } from '../src/adapter/mock-host.mjs';
import { createMuxHost } from '../src/adapter/mux-host.mjs';
import { apply } from '../entries/plugin.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const PORT = Number(args.port || 3291);
const HOST_KIND = args.host || 'mock';
const results = [];

const add = (id, title, state, detail = '', blocking = true) => {
  results.push({ id, title, state, detail, blocking });
  const mark = { PASS: '✓', FAIL: '✗', WARN: '!', SKIP: '–' }[state];
  console.log(`  ${mark} [${state}] ${title}${detail ? ` — ${detail}` : ''}`);
};

const lanAddress = () => {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return null;
};

const canConnect = (host, port, ms = 800) =>
  new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
    s.setTimeout(ms, () => done(false));
  });

const http = async (p, opts = {}, token) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    ...opts,
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 保留原文 */
  }
  return { status: res.status, json, text };
};

console.log(`\nDSH-mobile Spike-0 探测 · adapter=${HOST_KIND} · port=${PORT}\n`);

// ---- 1. 插件能否挂载（Cordis 语义模拟） ----
let disposers = [];
const stubCtx = {
  effect: (cb) => {
    const d = cb();
    if (typeof d === 'function') disposers.push(d);
    return () => {};
  },
  logger: { info: () => {} },
};
let pluginHandle = null;
try {
  pluginHandle = apply(stubCtx, { port: PORT + 1, printPairingCode: false, host: HOST_KIND, muxUrl: args['mux-url'] });
  await pluginHandle.ready;
  add(
    'mount',
    '插件可被宿主加载（apply 返回成功）',
    pluginHandle.ok ? 'PASS' : 'FAIL',
    pluginHandle.ok ? `steps=${pluginHandle.steps.map((s) => s.step).join('>')}` : pluginHandle.error
  );
} catch (err) {
  add('mount', '插件可被宿主加载（apply 返回成功）', 'FAIL', err.message);
}

// ---- 2. 是否只监听回环 ----
const gwHost = HOST_KIND === 'mux' ? createMuxHost({ baseUrl: args['mux-url'], log: () => {} }) : createMockHost({ log: () => {} });
if (HOST_KIND === 'mux') await gwHost.probe?.();
const gw = await createGateway({ host: gwHost, port: PORT, dev: false, log: () => {} });
const addr = await gw.start();
const lan = lanAddress();
add('listen-loopback', '监听地址为回环', addr.address === '127.0.0.1' ? 'PASS' : 'FAIL', `${addr.address}:${addr.port}`);
if (lan) {
  const reachable = await canConnect(lan, addr.port);
  add('listen-loopback', '同网段不可达（默认零暴露）', reachable ? 'FAIL' : 'PASS', reachable ? `${lan} 可以连上！` : `${lan} 连接被拒`);
} else {
  add('listen-loopback', '同网段不可达（默认零暴露）', 'SKIP', '未发现非回环网卡', false);
}

// ---- 3. 宿主信息与方法清单（X2 的前半段） ----
const health = await http('/mobile/v1/health');
const pairRes = await http('/mobile/v1/pairing/code', { method: 'POST', body: JSON.stringify({ deviceName: 'probe' }) });
let token = null;
if (pairRes.status === 201) {
  const redeem = await http('/mobile/v1/pairing/redeem', {
    method: 'POST',
    body: JSON.stringify({ code: pairRes.json.code, installId: `ins_probe_${Date.now()}`, deviceName: 'probe' }),
  });
  token = redeem.json?.deviceToken ?? null;
}
const hostInfo = token ? await http('/mobile/v1/host', {}, token) : { status: 0, json: null };
if (hostInfo.status === 200 && hostInfo.json?.hostVersion && hostInfo.json.hostVersion !== 'unknown') {
  const info = hostInfo.json;
  add('host-info', '取得 hostVersion 与能力集', 'PASS', `v${info.hostVersion} caps=${info.caps.length} adapter=${HOST_KIND === 'mux' ? 'mux' : 'mock'}`);
  if (HOST_KIND !== 'mux') {
    add('host-info', '连接的是真实宿主（非 Mock）', 'WARN', '当前为 mock 适配器：本项必须在真机复核', false);
  }
} else if (hostInfo.status === 200 && hostInfo.json?.degraded) {
  add('host-info', '取得 hostVersion 与能力集', 'FAIL', `宿主降级：${hostInfo.json.reason}`);
} else {
  add('host-info', '取得 hostVersion 与能力集', 'FAIL', `HTTP ${hostInfo.status}`);
}

// ---- 4. 能否调通一个只读 mux 方法 ----
if (HOST_KIND === 'mux') {
  const probe = gwHost.lastProbe?.();
  add('mux-read', '宿主 /api/remote.mux 可达', probe?.ok ? 'PASS' : 'FAIL', probe ? `status=${probe.status} ${probe.ms}ms` : '未探测');
  if (probe?.ok) {
    try {
      const list = token ? await http('/mobile/v1/tasks', {}, token) : { status: 0 };
      add('mux-read', '只读方法（列任务）走通', list.status === 200 ? 'PASS' : 'WARN', `HTTP ${list.status}：方法映射需按 X2 方法表补齐`, false);
    } catch (err) {
      add('mux-read', '只读方法（列任务）走通', 'WARN', err.message, false);
    }
  }
} else {
  add('mux-read', '真实 mux 只读方法', 'SKIP', 'mock 适配器不涉及 mux；真机复跑时用 --host=mux', false);
}

// ---- 5. 宿主退出 / 网关停止后端口释放 ----
await gw.stop();
await new Promise((r) => setTimeout(r, 150));
const stillOpen = await canConnect('127.0.0.1', PORT);
add('port-release', '停止后端口释放（无孤儿监听）', stillOpen ? 'FAIL' : 'PASS', stillOpen ? '端口仍在监听' : `${PORT} 已关闭`);

// ---- 6. 插件异常不带崩宿主 ----
let threw = false;
let brokenHandle = null;
try {
  brokenHandle = apply(
    {
      effect: () => {
        throw new Error('宿主 effect 抛错');
      },
      logger: {
        info: () => {
          throw new Error('logger 抛错');
        },
      },
    },
    { port: PORT + 2, printPairingCode: false, host: 'mock' }
  );
} catch {
  threw = true;
}
add('isolation', '插件异常不外抛（防带崩宿主）', !threw && brokenHandle?.ok === false ? 'PASS' : 'FAIL', threw ? 'apply 向外抛异常' : brokenHandle?.error);

// 清理插件实例
for (const d of disposers) {
  try {
    await d();
  } catch {
    /* 清理失败不影响结论 */
  }
}
disposers = [];
await brokenHandle?.ready?.catch?.(() => {});

// ---- 汇总 ----
const blocking = results.filter((r) => r.blocking);
const failed = blocking.filter((r) => r.state === 'FAIL');
const report = {
  at: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  adapter: HOST_KIND,
  results,
  verdict: failed.length === 0 ? 'PASS' : 'FAIL',
  blockingFailed: failed.map((r) => r.id),
};
fs.writeFileSync(path.join(HERE, 'last-report.json'), JSON.stringify(report, null, 2));

console.log(`\n结论：${report.verdict}（阻塞项 ${blocking.length} 项，失败 ${failed.length} 项）`);
console.log(`报告：spike0/last-report.json\n`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log(`  - ${f.id}: ${f.detail}`);
}
process.exit(failed.length ? 1 : 0);
