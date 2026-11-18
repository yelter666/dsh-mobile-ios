// tunnel.mjs — cloudflared Quick Tunnel 生命周期（GW-8）
//
// 设计原则：
// 1. **绝不伪装可用**。cloudflared 未安装时返回 4021（能力缺失），
//    而不是返回 500 或假地址——客户端据此隐藏入口。
// 2. **地址漂移必须广播**。Quick Tunnel 重启后域名会变，不通知客户端就会一直连旧地址。
// 3. **进程必须能被收干净**。网关退出时子进程不能变成孤儿，否则下次启动端口冲突。

import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import { accessSync, constants, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fail } from './protocol.mjs';

// cloudflared 把日志写到 stderr，地址形如：
//   2026-11-15T11:00:01Z INF |  https://random-words-1234.trycloudflare.com  |
const URL_PATTERN = /https:\/\/([a-z0-9][a-z0-9-]*)\.trycloudflare\.com/i;
// named tunnel（带 token 运行）不会打印公网地址——地址是提前在 Cloudflare 侧
// 绑好的固定域名。它只在连接真正注册成功时打这一行，正好当作「可用」的判据。
const NAMED_REGISTERED = /Registered tunnel connection|Connection [0-9a-f-]{8,} registered/i;
const DEFAULT_START_TIMEOUT_MS = 20_000;
const DEFAULT_RESTART_DELAY_MS = 10_000;
const LOG_TAIL = 40;

// 诊断脱敏（借鉴 dsh-plugin-mobile-gateway 0.12.1）：logTail 会进 status() 与诊断包，
// 可能被粘贴到聊天/issue 里，密钥类字符串必须在记录时就抹掉。
//   · eyJ 开头的 JWT（cloudflared named tunnel token 等）
//   · dt_ 设备令牌（配对凭证，40 位十六进制）
//   · Bearer / Ticket 凭证值
export function redactSecrets(line) {
  return String(line)
    .replace(/eyJ[A-Za-z0-9._=-]+/g, '[redacted-jwt]')
    .replace(/dt_[0-9a-fA-F]{8,}/g, '[redacted-device-token]')
    .replace(/(Bearer|Ticket)\s+\S+/gi, '$1 [redacted-credential]');
}

/** 在 PATH 里找可执行文件。找不到返回 null（调用方转成 4021）。 */
export function findCloudflared(explicit, env = process.env) {
  if (explicit && explicit !== 'auto') {
    try {
      accessSync(explicit, constants.X_OK);
      return explicit;
    } catch {
      return null;
    }
  }
  if (env.CLOUDFLARED_BIN) {
    try {
      accessSync(env.CLOUDFLARED_BIN, constants.X_OK);
      return env.CLOUDFLARED_BIN;
    } catch {
      /* 落到 PATH 搜索 */
    }
  }
  const dirs = (env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin').split(path.delimiter);
  const name = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* 继续找 */
    }
  }
  return null;
}

export class TunnelManager {
  constructor({
    port,
    log = () => {},
    executable = 'auto',
    spawnImpl = nodeSpawn,
    onAddrChanged = () => {},
    env = process.env,
    startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
    // 借鉴 dsh-plugin-mobile-gateway：运行中意外退出后自动重拉（退避 restartDelayMs）。
    // 语义边界：
    //   · 只有「已经 running 过然后意外退出」才重拉——启动失败（超时/缺二进制）不重试，
    //     能力缺失属于用户要修的环境问题，无限重试只会空转刷日志；
    //   · 显式 stop() 取消重拉（desired=off）；
    //   · 重拉成功后地址必然漂移，onAddrChanged 会再次广播。
    autoRestart = false,
    restartDelayMs = DEFAULT_RESTART_DELAY_MS,
    // 两种模式：
    //   quick —— 匿名隧道，地址随机且重启即变（现状，免费/临时用）
    //   named —— Pro 固定地址：token 认证 + 子域在 CF 侧绑好，地址永不漂移
    // named 模式下 token 只能经 resolveNamedTarget 注入，**不进 argv**：
    // argv 在 ps 里对所有本地进程可见，等于把隧道凭据贴在屏幕上。
    mode = 'quick',
    hostname = null,
    resolveNamedTarget = null,
    // 记录 cloudflared 的 pid。宿主被 kill -9 时子进程不会随父进程退出，
    // 会变成孤儿继续占着隧道连接（端口顺延后还会把公网请求打到旧端口）。
    // 下次启动据 pidfile 回收，比从头 pkill cloudflared 安全。
    pidFile = null,
  } = {}) {
    this.port = port;
    this.log = log;
    this.executable = executable;
    this.spawnImpl = spawnImpl;
    this.onAddrChanged = onAddrChanged;
    this.env = env;
    this.startTimeoutMs = startTimeoutMs;
    this.autoRestart = autoRestart;
    this.restartDelayMs = restartDelayMs;
    this.pidFile = pidFile;
    this.mode = mode === 'named' ? 'named' : 'quick';
    this.hostname = hostname;
    this.resolveNamedTarget = resolveNamedTarget;

    this.state = 'stopped'; // stopped | starting | running | failed | restarting
    this.url = null;
    // lastUrl 跨 stop/start 保留：Quick Tunnel 重启后域名必然变，
    // 若 stop 时把基线一起清掉，就永远检测不到「地址漂移」这个真实场景。
    this.lastUrl = null;
    this.prevUrl = null;
    this.startedAt = null;
    this.error = null;
    this.exitCode = null;
    this.child = null;
    this.pending = null;
    this.logTail = [];
    this.restartTimer = null;
    // desired=on 表示「用户开过隧道且没手动关」——意外退出后据此决定是否重拉
    this.desired = 'off';
  }

  status() {
    return {
      state: this.state,
      url: this.url,
      mode: this.mode,
      // named 模式即使没启动也能报出固定域名：UI 据此显示「开通后就是这个地址」
      hostname: this.mode === 'named' ? this.hostname : null,
      startedAt: this.startedAt,
      executable: findCloudflared(this.executable, this.env) ? 'found' : 'missing',
      error: this.error,
      // 不返回绝对路径：诊断包会外发，路径属于主机侧信息
      logTail: [...this.logTail],
    };
  }

  /**
   * 回收上一轮遗留的 cloudflared。
   *
   * 只杀「确定是自己那条隧道」的进程：pidfile 里的 pid 可能已被系统复用，
   * 所以必须核对命令行同时含 cloudflared 与我们的配置文件，否则宁可放过。
   * 这一步不能省——孤儿进程会一直维持隧道连接，公网请求被分到旧端口时表现为 502。
   */
  #reapStale() {
    if (!this.pidFile || process.platform === 'win32') return;
    let pid;
    try {
      pid = Number(readFileSync(this.pidFile, 'utf8').trim());
    } catch {
      return; // 没有 pidfile 是最常见的情况
    }
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) {
      this.#dropPid();
      return;
    }
    let cmd = '';
    try {
      cmd = String(execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })).trim();
    } catch {
      this.#dropPid();
      return; // 进程已不在
    }
    const ours = cmd.includes('cloudflared') && cmd.includes('tunnel-config');
    if (!ours) {
      this.#dropPid();
      return;
    }
    try {
      process.kill(pid, 'SIGTERM');
      this.log(`tunnel 回收上一轮遗留进程 pid=${pid}`);
    } catch {
      /* 已退出或没权限，交给后续启动判断 */
    }
    this.#dropPid();
  }

  #writePid(pid) {
    if (!this.pidFile || !pid) return;
    try {
      writeFileSync(this.pidFile, String(pid), { mode: 0o600 });
    } catch {
      /* pidfile 只是优化，写不进去不该影响隧道 */
    }
  }

  #dropPid() {
    if (!this.pidFile) return;
    try {
      unlinkSync(this.pidFile);
    } catch {
      /* 本来就没有 */
    }
  }

  #record(line) {
    const text = redactSecrets(String(line).trimEnd());
    if (!text) return;
    this.logTail.push(text);
    if (this.logTail.length > LOG_TAIL) this.logTail.shift();
  }

  #scheduleRestart() {
    if (!this.autoRestart || this.desired !== 'on') return;
    this.state = 'restarting';
    this.log(`tunnel 意外退出，${Math.round(this.restartDelayMs / 1000)}s 后自动重拉`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.desired !== 'on' || this.state === 'running' || this.pending) return;
      this.start().catch((err) => this.log(`tunnel 重拉失败：${err.message}`));
    }, this.restartDelayMs);
    this.restartTimer.unref?.();
  }

  async start() {
    if (this.state === 'running') return this.status();
    if (this.pending) return this.pending;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    const exe = findCloudflared(this.executable, this.env);
    if (!exe) {
      this.state = 'failed';
      this.error = '主机未安装 cloudflared';
      const err = fail(4021, '主机未安装 cloudflared，无法开启隧道', {
        detail: '在主机执行 `brew install cloudflared`，或设置 CLOUDFLARED_BIN 指向可执行文件',
      });
      throw err;
    }

    this.state = 'starting';
    this.error = null;
    this.exitCode = null;

    // 起新进程前先收掉上一轮的遗留（宿主被强杀时会留下孤儿）
    this.#reapStale();

    this.pending = new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.pending = null;
        fn(value);
      };

      const spawnTunnel = (target) => {
        const named = this.mode === 'named';
        // named 有两种落地形态，对外都是「固定地址」：
        //   · token 形态（remotely-managed）→ TUNNEL_TOKEN 环境变量 + 远端 ingress
        //   · 本地管理型（cloudflared 自己的证书）→ --config 指向本地 ingress
        // 两种都不用 --url：路由由 ingress 决定，本地再给 --url 会把它覆盖掉。
        // 参数顺序有讲究：`run` 是 cloudflared 的子命令，`--config` / `--no-autoupdate`
        // 都属于 `tunnel` 这一层，必须放在 `run` **之前**。
        // 放到 `run` 之后会被当成 run 自己的选项，直接
        // "flag provided but not defined: -no-autoupdate" 退出（真机才会踩到）。
        // named 保持默认 QUIC：本机实测（深圳 → 洛杉矶边缘）QUIC 稳定 3.1–3.4s，
        // 强制 http2 反而出现 12s 与直接超时。瓶颈是国际链路，不是协议。
        // quick 仍用 http2——那是短命地址，优先保证在受限网络下能建起来。
        const args = named
          ? (target?.configFile
            ? ['tunnel', '--config', target.configFile, '--no-autoupdate', 'run']
            : ['tunnel', '--no-autoupdate', 'run'])
          : ['tunnel', '--url', `http://127.0.0.1:${this.port}`, '--no-autoupdate', '--protocol', 'http2'];
        const childEnv = target?.token ? { ...this.env, TUNNEL_TOKEN: target.token } : this.env;

        let child;
        try {
          child = this.spawnImpl(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
        } catch (err) {
          this.state = 'failed';
          this.error = `无法启动 cloudflared：${err.message}`;
          finish(reject, fail(4021, this.error));
          return;
        }
        this.child = child;
      this.#writePid(child.pid);

        timer = setTimeout(() => {
          this.state = 'failed';
          this.error = named
            ? `隧道启动超时（${Math.round(this.startTimeoutMs / 1000)}s 内未连上 Cloudflare）`
            : '隧道启动超时（20s 内未拿到地址）';
          try {
            child.kill('SIGTERM');
          } catch {
            /* 忽略 */
          }
          finish(reject, fail(4500, this.error, { detail: this.logTail.slice(-3).join(' | ') }));
        }, this.startTimeoutMs);
        timer.unref?.();

        const onChunk = (chunk) => {
          const text = chunk.toString('utf8');
          for (const line of text.split('\n')) {
            this.#record(line);
            if (settled) continue;
            if (named) {
              if (!NAMED_REGISTERED.test(line)) continue;
              // 地址是既定的固定域名，不存在漂移；running 的判据是「连接真的注册成功」，
              // 而不是「进程起来了」——后者会在出口被墙时给用户一个连不上的假绿灯。
              const url = `https://${this.hostname}`;
              this.url = url;
              this.lastUrl = url;
              this.state = 'running';
              this.startedAt = new Date().toISOString();
              this.desired = 'on';
              this.log(`tunnel up url=${url} (named)`);
              finish(resolve, this.status());
              continue;
            }
            const match = URL_PATTERN.exec(line);
            if (!match) continue;
            const url = `https://${match[1]}.trycloudflare.com`;
            const previous = this.lastUrl;
            this.url = url;
            this.lastUrl = url;
            this.state = 'running';
            this.startedAt = new Date().toISOString();
            this.desired = 'on';
            this.log(`tunnel up url=${url}`);
            if (previous && previous !== url) {
              this.prevUrl = previous;
              this.log(`tunnel addr changed ${previous} → ${url}`);
              // 地址漂移：必须广播，否则客户端一直连旧域名
              this.onAddrChanged(url, previous);
            }
            finish(resolve, this.status());
          }
        };

        child.stdout?.on('data', onChunk);
        child.stderr?.on('data', onChunk);

        child.on('error', (err) => {
          this.state = 'failed';
          this.error = `cloudflared 进程错误：${err.message}`;
          this.child = null;
          finish(reject, fail(4021, this.error));
        });

        child.on('exit', (code, signal) => {
          this.exitCode = code;
          const wasRunning = this.state === 'running';
          if (this.state !== 'stopped') {
            this.state = wasRunning ? 'failed' : this.state;
            if (wasRunning) this.error = `cloudflared 退出（code=${code}, signal=${signal ?? 'none'}）`;
          }
          this.child = null;
          this.url = null;
          this.#dropPid();
          this.log(`tunnel exit code=${code} signal=${signal ?? 'none'}`);
          finish(reject, fail(4500, this.error || 'cloudflared 提前退出'));
          // 运行中意外退出（而非启动阶段失败）→ 按退避自动重拉。
          // start() 已 resolved 后的退出 pending 为空、finish 是 no-op，同样走到这里；
          // 显式 stop() 已先把 state 置 stopped 且 desired=off，#scheduleRestart 会拒绝。
          if (wasRunning) this.#scheduleRestart();
        });
      };

      if (this.mode !== 'named') {
        spawnTunnel(null);
        return;
      }
      if (!this.resolveNamedTarget) {
        this.state = 'failed';
        this.error = '固定地址模式缺少 token 解析器';
        finish(reject, fail(4021, this.error));
        return;
      }
      // token 解析可能要走一次开通服务（网络），放在 pending 里做，
      // 既保证 start() 的单飞语义，也不会让调用方以为隧道已经起来了。
      Promise.resolve()
        .then(() => this.resolveNamedTarget())
        .then((target) => {
          if (settled) return;
          if (!target?.hostname || (!target.token && !target.configFile)) {
            this.state = 'failed';
            this.error = '固定地址未开通（缺少凭据或域名）';
            finish(reject, fail(4021, this.error));
            return;
          }
          this.hostname = target.hostname;
          spawnTunnel(target);
        })
        .catch((err) => {
          this.state = 'failed';
          this.error = err?.message || '开通固定地址失败';
          finish(reject, err?.code ? err : fail(4500, this.error));
        });
    });

    return this.pending;
  }

  async stop() {
    // 显式停止即「用户不再要隧道」：取消计划中的重拉，否则 stop 后又悄悄起来。
    this.desired = 'off';
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    this.state = 'stopped';
    this.url = null;
    this.child = null;
    this.pending = null;
    if (!child) return { stopped: false, alreadyStopped: true };
    await new Promise((resolve) => {
      const done = () => resolve();
      const timer = setTimeout(done, 3000);
      timer.unref?.();
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
    // 显式停止也清一次：exit 回调是异步的，用户点停止后 pidfile 不该还指着一个死进程
    this.#dropPid();
    this.log('tunnel stopped');
    return { stopped: true };
  }
}

/**
 * 孤儿隧道清扫（2026-11-16 真机排查发现）：DSH 桌面自身的 `dsh web` 每次重启
 * 都会从同一个组件目录（~/.dsh/mobile-access/components/cloudflared/）新拉一个
 * Quick Tunnel，旧的从不回收——指向已死端口的 cloudflared 进程空转堆积
 * （实测一次清理出 13 个）。本函数在插件启动时按「目标端口已死 → 进程是孤儿」
 * 清理该组件目录拉起的隧道：
 *   · 只认组件目录二进制（不碰用户自己 PATH 里的 cloudflared）；
 *   · 只杀目标端口已无人监听的（活端口——包括 DSH 当前 GUI 伴生口和我们自己的
 *     隧道——一律保留）；
 *   · SIGTERM 优雅退出，1.5s 不退再 SIGKILL。
 */
export async function sweepOrphanTunnels({ componentDir, log = () => {} } = {}) {
  if (!componentDir) return { killed: 0 };
  const { execFile } = await import('node:child_process');
  const net = await import('node:net');

  const portAlive = (port) => new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    sock.setTimeout(600);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
  });

  const listPids = () => new Promise((resolve) => {
    execFile('/usr/bin/pgrep', ['-fl', 'cloudflared'], (err, stdout) => {
      resolve(err ? [] : String(stdout).split('\n').filter(Boolean));
    });
  });

  const lines = await listPids();
  const orphans = [];
  for (const line of lines) {
    const pid = Number(line.split(' ')[0]);
    if (!Number.isFinite(pid)) continue;
    // 只认组件目录二进制 + Quick Tunnel 形态（--url http://127.0.0.1:<port>）
    if (!line.includes(componentDir)) continue;
    const m = line.match(/--url\s+https?:\/\/127\.0\.0\.1:(\d+)/);
    if (!m) continue;
    const port = Number(m[1]);
    if (!(await portAlive(port))) orphans.push({ pid, port });
  }

  let killed = 0;
  for (const { pid, port } of orphans) {
    try {
      process.kill(pid, 'SIGTERM');
      killed += 1;
      log(`tunnel sweep: SIGTERM orphan pid=${pid} (target 127.0.0.1:${port} 已死)`);
    } catch { /* 进程已退出/权限不足，忽略 */ }
  }
  // 宽限后强杀残留
  if (killed > 0) {
    await new Promise((r) => setTimeout(r, 1500));
    for (const { pid } of orphans) {
      try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch { /* 已退 */ }
    }
  }
  return { killed };
}
