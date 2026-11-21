// provision-select.mjs — 「这台机器该用哪种固定地址开通器」的唯一判定入口
//
// 背景：同一套判定原来在两个入口各写了一份（entries/plugin.mjs 与 entries/sidecar.mjs），
// 判据还不一样——sidecar 只看 `fs.existsSync(cert.pem)` 就选 local，plugin 还要看
// `configured`。分发到不同电脑后，「同一版本、同样的凭据，两个入口给出不同结论」，
// 这正是「换台电脑就分配不出固定地址 / 地址忽然没了」的一部分来源。
//
// 统一后的顺序（谁先齐备用谁）：
//   1. 显式 provisioner：尊重运营决定，但配置的形态不可用时**明确降级并记录原因**；
//   2. hosted：有开通服务地址（endpoint + enrollToken）——产品形态；
//   3. cloudflare：本机有 accountId + apiToken——运营/自托管；
//   4. local：跑过 `cloudflared tunnel login`（cert.pem 存在）——零 API Token 的默认路径；
//   5. state：以前开通过的机器，没有证书也能按本机状态起隧道（token 或本地 ingress 两种形态）；
//   6. 都没有 → null，隧道退回 Quick Tunnel（行为与旧版一致）。
//
// 判定只做**本地**检查（文件/配置存在性），不发网络请求。凭据是否真能写这个域名，
// 由 LocalProvisioner.checkCredentials 在真正开通前问 Cloudflare——两件事分开，
// 启动不能被网络拖住，写入不能带着错凭据。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProvisioner } from './cloudflare.mjs';

/**
 * @param {object} opts
 * @param {object} opts.tunnelCfg  已归一化的 tunnel 配置（plugin config 或 sidecar args 映射后）
 * @param {string|null} [opts.stateFile]
 * @param {string|null} [opts.hostId]
 * @param {string} [opts.homeDir]  cert.pem 所在 home（测试必须能隔离；默认当前用户）
 * @param {Function} [opts.log]
 * @returns {object|null} 可用的开通器；null 表示保持 Quick Tunnel
 */
export function resolveProvisioner({
  tunnelCfg = {}, stateFile = null, hostId = null, log = () => {}, homeDir = os.homedir(),
} = {}) {
  const baseDomain = tunnelCfg.baseDomain || process.env.DSH_TUNNEL_BASE_DOMAIN || 'matrixboard.cn';
  const common = {
    baseDomain,
    homeDir,
    prefix: tunnelCfg.prefix || 'dsh',
    // 没找到就留 'auto'：让发现链在真正要用的那一刻再解析一次（自动安装发生在启动之后）
    executable: tunnelCfg.executable || 'auto',
  };
  const make = (kind, extra = {}) => createProvisioner(
    { ...common, ...extra, provisioner: kind },
    { log, stateFile, hostId },
  );
  const usable = (p) => (p && p.configured ? p : null);
  const pick = (p, why) => {
    if (p) log(`tunnel 固定地址开通器=${p.kind}（${why}）域名=${baseDomain}`);
    return p || null;
  };
  /** 启动时顺手预检一次凭据（不阻塞启动）：面板因此能在用户点按钮之前就提示账号不对。 */
  const warm = (p) => {
    if (p && typeof p.checkCredentials === 'function') p.checkCredentials().catch(() => {});
    return p;
  };

  const explicit = tunnelCfg.provisioner ? String(tunnelCfg.provisioner) : null;
  // 「有没有登录过 Cloudflare」只由 cert.pem 决定：它是唯一能做特权写入（建隧道/写 DNS）的凭据。
  // 状态文件只能复用已有地址，不能代替它——两者混在 configured 里会让判定随状态漂移。
  const hasCert = (() => {
    try {
      return fs.statSync(path.join(homeDir, '.cloudflared', 'cert.pem')).isFile();
    } catch {
      return false;
    }
  })();
  /** 没有证书时只能复用本机状态（token 形态或本地 ingress 形态）。 */
  const stateOnly = () => usable(make('state'));

  if (explicit === 'state') return warm(pick(stateOnly(), '显式 state'));
  if (explicit === 'local') {
    if (hasCert) {
      const local = usable(make('local'));
      if (local) return warm(pick(local, '显式 local'));
    }
    return warm(pick(stateOnly(), 'cert.pem 缺失，复用本机已开通状态'));
  }
  if (explicit === 'hosted' || (!explicit && tunnelCfg.endpoint)) {
    return warm(pick(make('hosted', { endpoint: tunnelCfg.endpoint, enrollToken: tunnelCfg.enrollToken }), '开通服务'));
  }
  if (explicit === 'cloudflare') {
    const cf = make('cloudflare', { apiToken: tunnelCfg.apiToken, accountId: tunnelCfg.accountId, zoneId: tunnelCfg.zoneId });
    if (cf) return warm(pick(cf, '显式 cloudflare'));
    return warm(pick(hasCert ? usable(make('local')) : null, 'cloudflare 凭据不全，改用 cloudflared 证书'));
  }
  // 自动：API 凭据 → 证书（可开通/可复用） → 本机状态（只复用）
  const cf = make('cloudflare', { apiToken: tunnelCfg.apiToken, accountId: tunnelCfg.accountId, zoneId: tunnelCfg.zoneId });
  if (cf) return warm(pick(cf, 'API 凭据'));
  if (hasCert) {
    const local = usable(make('local'));
    if (local) return warm(pick(local, 'cloudflared 证书'));
  }
  const fromState = stateOnly();
  if (fromState) return warm(pick(fromState, '本机已开通状态（无需证书）'));
  log('tunnel 没有可用的固定地址凭据，保持 Quick Tunnel');
  return null;
}

/** 供入口读取的默认状态文件位置（两个入口必须一致，否则状态会分裂成两份）。 */
export function defaultTunnelStateFile() {
  return process.env.DSH_TUNNEL_STATE_FILE || path.join(os.homedir(), '.dsh', 'mobile-access', 'tunnel-named.json');
}
