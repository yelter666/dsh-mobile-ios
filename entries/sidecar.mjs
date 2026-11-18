// entries/sidecar.mjs — 独立进程入口（X1 不通过时的降级路径）
// 与插件入口共用同一个 core：形态不同，契约一致。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../src/server.mjs';
import { createProvisioner } from '../src/cloudflare.mjs';
import { createMockHost } from '../src/adapter/mock-host.mjs';
import { createMuxHost } from '../src/adapter/mux-host.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);

const port = Number(args.port || 3081);
const dev = args.dev === 'true';
const allowLan = args.lan === 'true';
const hostKind = args.host || 'mock';

const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

const host =
  hostKind === 'mux'
    ? createMuxHost({ baseUrl: args['mux-url'], token: args['mux-token'], log })
    : createMockHost({ autoPlay: args.autoplay === 'true', log });

if (hostKind === 'mux') {
  const probe = await host.probe();
  log(`mux   probe ${probe.ok ? 'OK' : 'FAIL'} status=${probe.status} ${probe.url}`);
}

// 固定地址开通器（可选）：有凭据就切 named 模式，没有保持 Quick Tunnel。
const tunnelStateFile = args['tunnel-state'] || path.join(os.homedir(), '.dsh', 'mobile-access', 'tunnel-named.json');
let provisioner = createProvisioner(
  {
    provisioner: args['tunnel-provisioner'] || (args['tunnel-endpoint'] || process.env.DSH_TUNNEL_ENDPOINT ? 'hosted' : 'cloudflare'),
    apiToken: args['cf-token'] || process.env.DSH_CF_API_TOKEN,
    accountId: args['cf-account'] || process.env.DSH_CF_ACCOUNT_ID,
    zoneId: args['cf-zone'] || process.env.DSH_CF_ZONE_ID,
    baseDomain: args['tunnel-domain'] || process.env.DSH_TUNNEL_BASE_DOMAIN || 'matrixboard.cn',
    prefix: args['tunnel-prefix'] || 'dsh',
    endpoint: args['tunnel-endpoint'] || process.env.DSH_TUNNEL_ENDPOINT,
    enrollToken: args['tunnel-enroll'] || process.env.DSH_TUNNEL_ENROLL_TOKEN,
  },
  {
    log,
    stateFile: tunnelStateFile,
  },
);
// 本地管理型：跑过 `cloudflared tunnel login`（~/.cloudflared/cert.pem 存在）就能开通。
if (!provisioner && fs.existsSync(path.join(os.homedir(), '.cloudflared', 'cert.pem'))) {
  const localCfg = {
    provisioner: 'local',
    baseDomain: args['tunnel-domain'] || process.env.DSH_TUNNEL_BASE_DOMAIN || 'matrixboard.cn',
    prefix: args['tunnel-prefix'] || 'dsh',
    executable: args['tunnel-bin'] || 'cloudflared',
  };
  const local = createProvisioner(localCfg, { log, stateFile: tunnelStateFile });
  if (local?.configured) provisioner = local;
}
// 已开通过的机器：没有凭据也能按状态文件起固定地址（token 在 0600 文件里）。
if (!provisioner && fs.existsSync(tunnelStateFile)) {
  const fromState = createProvisioner(
    { provisioner: 'state', baseDomain: args['tunnel-domain'] || process.env.DSH_TUNNEL_BASE_DOMAIN || 'matrixboard.cn' },
    { log, stateFile: tunnelStateFile },
  );
  if (fromState?.configured) provisioner = fromState;
}

const gw = await createGateway({
  host,
  port,
  dev,
  log,
  allowLan,
  hostSuffixes: args['host-suffix'] ? String(args['host-suffix']).split(',') : [],
  // auto：在 PATH 里找 cloudflared；也可指定绝对路径，或设 CLOUDFLARED_BIN。
  // 找不到时隧道接口返回 4021，不影响网关其余功能。
  tunnelExecutable: args['tunnel-bin'] || 'auto',
  tunnelProvisioner: provisioner,
});
const addr = await gw.start();

if (host.kind === 'mock') {
  const issued = gw.pairing.issueCode({ deviceName: 'sidecar' });
  log(`pair  配对码 ${issued.code}（${issued.expiresInSec}s 内有效，单次）`);
  log('pair  提示：这仅用于本机联调；真实产品里配对码只出现在桌面端界面');
}
log(`srv   REST  http://127.0.0.1:${addr.port}/mobile/v1/health`);
log(`srv   WS    ws://127.0.0.1:${addr.port}/ws/mobile`);
if (dev) {
  log('srv   dev 端点：POST /__mock/emit , GET /__mock/state');
  log('srv   dev 故障注入：POST /__mock/drop | /__mock/gap | /__mock/restart-host');
}
log(`srv   隧道   GET /mobile/v1/tunnel（模式=${gw.tunnel.mode} 可执行文件=${gw.tunnel.status().executable}）`);
if (provisioner) log(`srv   固定地址 POST /mobile/v1/tunnel/provision（${provisioner.kind} · ${provisioner.baseDomain}）`);

const shutdown = async (sig) => {
  log(`srv   ${sig} 收到，正在退出`);
  try {
    await gw.stop();
  } finally {
    process.exit(0);
  }
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
