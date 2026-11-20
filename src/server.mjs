// server.mjs — 组装：http server + REST + WS
// 监听面：默认绑 0.0.0.0（局域网伴侣是产品的核心路径；管理面仍回环-only，见 rest.mjs）。
// 端口被占用时自动顺延（R12：插件跑在宿主进程内，不能因为端口冲突就挂掉宿主）

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { GatewayCore } from './gateway.mjs';
import { PairingService } from './pairing.mjs';
import { TicketStore, attachWebSocket } from './ws.mjs';
import { createRestRouter } from './rest.mjs';
import { TunnelManager } from './tunnel.mjs';

const PORT_FALLBACK = 8;

const PRIVATE_IPV4 = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./];

function isPrivateIPv4(addr) {
  return PRIVATE_IPV4.some((re) => re.test(addr));
}

// 虚拟网卡：Windows 上 Hyper-V / WSL / VMware 会各造一块 172.x 的网卡，
// macOS 上 utun* 是 VPN。如果按「第一个私网地址」取，手机拿到的往往是这些
// 根本不通的地址 —— 扫码后一直转圈，用户只会以为插件坏了。
const VIRTUAL_IF = /(vEthernet|VMware|VirtualBox|Hyper-?V|Loopback|WSL|Docker|Tailscale|ZeroTier|TAP-|tap\d|utun|tun\d|ppp\d)/i;
// 物理网卡常见命名（Windows 中文系统是「以太网 / WLAN / Wi-Fi」，macOS 是 en0/en1）
const PHYSICAL_IF = /^(en\d|eth\d|wlan\d|wi-?fi|ethernet|以太网|wlan|无线)/i;

/**
 * 手机要填的「电脑地址」。
 *
 * 优先级：物理网卡 > 其它非虚拟网卡；同类里 192.168 > 10 > 172.16-31
 * （家用路由器几乎都在 192.168，而 172.16/12 更容易是虚拟网段）。
 * 实在挑不出来再退回「第一个私网 IPv4」，保证老行为不至于更差。
 */
export function lanIPv4(ifaces = os.networkInterfaces()) {
  const candidates = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal || !isPrivateIPv4(i.address)) continue;
      let score = 0;
      if (!VIRTUAL_IF.test(name)) score += 10;
      if (PHYSICAL_IF.test(name)) score += 5;
      if (i.address.startsWith('192.168.')) score += 3;
      else if (i.address.startsWith('10.')) score += 2;
      else score += 1;
      candidates.push({ address: i.address, score, name });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].address;
}

export function makeHostAllow(suffixes = []) {
  const list = suffixes.map((s) => s.toLowerCase().replace(/^\*?\./, ''));
  return (hostHeader) => {
    if (!hostHeader) return false;
    const host = String(hostHeader).split(':')[0].toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return true;
    // 手机经局域网 IP 直连：Host 头是私网地址（例 192.168.1.5:3081），必须放行，
    // 否则 REST 通了 WS 握手也会被拒（半通比不通更难诊断）。
    if (isPrivateIPv4(host)) return true;
    if (/^(fc|fd)[0-9a-f]{2}:/.test(host) || host.startsWith('fe80:')) return true; // IPv6 ULA/链路本地
    return list.some((s) => host === s || host.endsWith(`.${s}`));
  };
}

export async function createGateway({
  host,
  port = 3081,
  hostSuffixes = [],
  dev = false,
  log = () => {},
  addrs = {},
  allowLan = true,
  tunnelExecutable = 'auto',
  // 设备注册表落盘路径（可选）。提供后配对设备跨重启保留，手机无需重新配对。
  pairingFile = null,
  tunnelAutoRestart = false,
  // Pro 固定地址开通器（见 cloudflare.mjs）。**提供即切到 named 模式**：
  // 有稳定子域就不该再退化成随机域名。为 null 时保持 Quick Tunnel 行为不变。
  tunnelProvisioner = null,
  tunnelPidFile = null,
  // 隧道子进程的 spawn 实现。默认用 node:child_process；测试注入假进程，
  // 嵌入式场景也可替换（TunnelManager 本身已支持，这里只是让网关能透传）。
  tunnelSpawn = null,
} = {}) {
  if (!host) throw new Error('createGateway 需要 host 适配器');

  // 网关自身提供的能力（与宿主能力合并后对外声明）：
  // 只加"客户端需要据此决定走哪条路"的项，不虚报业务能力。
  const GATEWAY_CAPS = ['ws.ticket'];
  // info() 绝不抛：宿主未就绪时给"降级但可诊断"的答案，
  // 否则网关会连启动都失败，用户在手机上只会看到"连不上"而不知道原因。
  const hostView = Object.create(host, {
    info: {
      value: () => {
        try {
          const i = host.info();
          return { ...i, caps: [...new Set([...(i.caps || []), ...GATEWAY_CAPS])] };
        } catch (err) {
          return {
            hostId: 'host_unknown',
            hostName: '主机端未就绪',
            hostVersion: 'unknown',
            platform: process.platform,
            protocolVersion: '1.0',
            caps: [...GATEWAY_CAPS],
            degraded: true,
            reason: err.message,
          };
        }
      },
    },
    kind: { value: host.kind },
  });

  const pairing = new PairingService({ log, file: pairingFile });
  const tickets = new TicketStore();
  const core = new GatewayCore({ host: hostView, pairing, log });

  // 隧道（GW-8）：地址漂移必须广播，否则客户端会一直连旧域名。
  const tunnel = new TunnelManager({
    port,
    log,
    executable: tunnelExecutable,
    ...(tunnelSpawn ? { spawnImpl: tunnelSpawn } : {}),
    // 插件形态默认开自动重拉：宿主进程长活，cloudflared 意外退出后
    // 不重拉的话手机会一直显示「在线」但隧道实际已死。
    autoRestart: tunnelAutoRestart,
    mode: tunnelProvisioner ? 'named' : 'quick',
    // 孤儿回收用：宿主被 kill -9 时 cloudflared 不随父进程退出
    pidFile: tunnelPidFile || path.join(os.homedir(), '.dsh', 'mobile-access', 'cloudflared.pid'),
    // named 的 token 每次启动时现取（可能顺带完成开通），**不进 argv**。
    // 这里读 tunnel.port 而不是外层 port：端口被占用时会顺延，ingress 必须跟着走。
    resolveNamedTarget: tunnelProvisioner
      ? () => tunnelProvisioner.credential({ port: tunnel.port })
      : null,
    onAddrChanged: (url, prevUrl) => {
      core.notifyGateway({ event: 'addr_changed', baseUrl: url, prevBaseUrl: prevUrl });
    },
  });

  const config = {
    dev,
    addrs,
    adapterKind: host.kind,
    wsStats: () => ws.stats(),
    dropAll: () => ws.dropAll?.() ?? 0,
    tunnel,
    tunnelProvisioner,
    hostView,
    // 手机端要填的「电脑地址」（LAN IP:port）；未起或无私网地址时为 null
    lanAddr: () => (listening?.lan ?? null),
  };
  const handler = createRestRouter({ core, pairing, host: hostView, tickets, config, log });
  // 固定地址是自有域名：隧道进来的 Host 是 dsh-xxxx.matrixboard.cn，
  // 不把 zone 加进白名单会在 WS 握手阶段 403（REST 通但实时不通，最难查的一种半通）。
  const suffixes = tunnelProvisioner?.baseDomain ? [...hostSuffixes, tunnelProvisioner.baseDomain] : hostSuffixes;
  const hostAllow = makeHostAllow(suffixes);

  const server = http.createServer((req, res) => {
    handler(req, res).catch((err) => {
      log(`http  unhandled ${err.stack || err}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 4500, message: '网关内部错误' } }));
      } else res.end();
    });
  });
  server.keepAliveTimeout = 15_000;

  const ws = attachWebSocket(server, { core, pairing, tickets, log, hostAllow });

  let listening = null;

  const tryListen = (candidate) =>
    new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(candidate);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(candidate, allowLan ? '0.0.0.0' : '127.0.0.1');
    });

  async function start() {
    core.start();
    let lastErr = null;
    for (let i = 0; i < PORT_FALLBACK; i += 1) {
      try {
        const used = await tryListen(port + i);
        const addr = server.address();
        const lan = lanIPv4();
        listening = {
          port: used,
          address: addr.address,
          requested: port,
          fallback: used !== port,
          lan: allowLan && lan ? `${lan}:${used}` : null,
        };
        // 隧道指向真实监听端口（端口可能因占用而顺延）
        tunnel.port = used;
        log(`srv   listening ${addr.address}:${used}${used !== port ? ` (端口 ${port} 被占用，已顺延)` : ''}`);
        if (listening.lan) log(`srv   LAN    http://${listening.lan}/mobile/v1/health（手机端填这个地址）`);
        return listening;
      } catch (err) {
        lastErr = err;
        if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') break;
      }
    }
    core.stop();
    throw lastErr || new Error('无法绑定端口');
  }

  async function stop() {
    ws.closeAll();
    core.stop();
    // 先收隧道子进程，再关监听：反序会让 cloudflared 变成连不上任何东西的孤儿进程。
    await tunnel.stop().catch((err) => log(`tunnel stop error: ${err.message}`));
    await new Promise((resolve) => server.close(() => resolve()));
    await host.close?.();
    listening = null;
    log('srv   stopped');
  }

  return {
    server,
    core,
    pairing,
    tickets,
    tunnel,
    start,
    stop,
    get address() {
      return listening;
    },
    stats: () => ({ ...core.stats(), ws: ws.stats(), address: listening }),
  };
}
