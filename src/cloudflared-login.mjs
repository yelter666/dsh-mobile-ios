// cloudflared-login.mjs — 面板里一键完成 `cloudflared tunnel login`
//
// 为什么必须做在插件里：固定地址写在 Cloudflare 的域名下，只有**持有该域名的账号**
// 的证书才写得进去。而 `cloudflared tunnel login` 需要「在浏览器里点授权」——这一步
// 人必须参与，但**不该要求用户先会开终端、会敲命令、会找 HOME**。
// 现场（2026-11-21）的结论很直接：新机上插件提示「账号不对」，用户重装、重启、
// 点重置都没用，唯一能修好的动作是一条终端命令，而面板只说了一句话。
//
// 这个模块只做三件事：起进程、把授权链接捞出来给面板、等进程结束并交代结果。
// 四个硬约束：
//   1. 幂等：等待中重复调用返回同一会话，不会起第二个浏览器授权；
//   2. 不静默：超时/被杀/退出码非 0/退出但没生成证书，都要有可读原因；
//   3. 不留孤儿：网关停止或取消时 kill 掉子进程；
//   4. 不写死路径：用调用方给的 executable（发现链解析结果），只覆盖 HOME。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const LOG_CAP = 8 * 1024;

/** 从 cloudflared 的输出里捞出浏览器授权链接。 */
const AUTH_URL = /https:\/\/dash\.cloudflare\.com\/argotunnel\?[^\s"'<>]+/i;

/** 有用的最后几行（错误信息通常就在末尾，且不能像原来那样只留第一行）。 */
function tailLines(raw, max = 400) {
  const lines = String(raw || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const text = lines.slice(-4).join(' / ');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export const LOGIN_HINT = {
  idle: null,
  waiting: '在浏览器里选择「持有该域名的账号」并点授权',
  ok: '授权完成，本机证书已更新',
  error: '授权没有完成',
  canceled: '已取消授权',
};

/**
 * @param {object} opts
 * @param {Function} [opts.spawn]  注入用（测试里给假进程）
 * @param {Function} [opts.now]
 * @param {Function} [opts.log]
 * @param {number}   [opts.timeoutMs]
 * @param {object}   [opts.fsImpl]
 */
export function createLoginManager({
  spawn = nodeSpawn,
  now = () => Date.now(),
  log = () => {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fsImpl = fs,
} = {}) {
  let session = null; // { state, url, startedAt, finishedAt, pid, error, homeDir, child, certBefore }

  const certFile = (homeDir) => path.join(homeDir || os.homedir(), '.cloudflared', 'cert.pem');
  const certMtime = (homeDir) => {
    try { return fsImpl.statSync(certFile(homeDir)).mtimeMs; } catch { return null; }
  };

  function snapshot() {
    if (!session) {
      return { state: 'idle', url: null, startedAt: null, finishedAt: null, pid: null, error: null, hint: null };
    }
    return {
      state: session.state,
      url: session.url,
      startedAt: session.startedAt,
      finishedAt: session.finishedAt,
      pid: session.pid,
      error: session.error,
      hint: LOGIN_HINT[session.state] ?? null,
    };
  }

  function finish(state, error = null) {
    if (!session) return;
    session.state = state;
    session.error = error;
    session.finishedAt = new Date(now()).toISOString();
    session.child = null;
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
  }

  /**
   * 开始（或复用）一次授权。
   * @returns {{state:string,url:string|null,startedAt:string|null,pid:number|null,error:string|null}}
   */
  function start({ executable, homeDir = os.homedir() } = {}) {
    if (session && session.state === 'waiting') return snapshot();
    if (!executable) {
      const err = new Error('这台主机还没有 cloudflared，无法发起授权');
      err.code = 'NO_CLOUDFLARED';
      throw err;
    }
    session = {
      state: 'waiting',
      url: null,
      startedAt: new Date(now()).toISOString(),
      finishedAt: null,
      pid: null,
      error: null,
      homeDir,
      child: null,
      timer: null,
      certBefore: certMtime(homeDir),
    };
    let raw = '';
    let child;
    try {
      child = spawn(executable, ['tunnel', 'login'], {
        // 只覆盖 HOME：证书一定落在本机真正使用的那份 ~/.cloudflared 里。
        // （Windows 走 USERPROFILE，两者都设，避免 cloudflared 用另一套路径）
        env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      finish('error', `无法启动 cloudflared：${err?.message || err}`);
      return snapshot();
    }
    session.child = child;
    session.pid = child.pid ?? null;
    log(`tunnel login 已启动 pid=${session.pid} exe=${executable}`);

    const onChunk = (buf) => {
      raw = (raw + String(buf)).slice(-LOG_CAP);
      if (!session.url) {
        const m = AUTH_URL.exec(raw);
        if (m) {
          // cloudflared 会把 & 原样打印；有些版本会加尾随标点，去掉
          session.url = m[0].replace(/[.,;)]+$/, '');
          log('tunnel login 已拿到授权链接');
        }
      }
    };
    child.stdout?.on?.('data', onChunk);
    child.stderr?.on?.('data', onChunk);

    child.on?.('error', (err) => {
      finish('error', `无法启动 cloudflared：${err?.message || err}`);
    });
    child.on?.('close', (code, signal) => {
      if (session.state !== 'waiting') return; // 已经被取消/超时收口
      if (code === 0) {
        const after = certMtime(session.homeDir);
        const renewed = after !== null && (session.certBefore === null || after !== session.certBefore);
        if (!renewed) {
          finish('error', 'cloudflared 正常退出，但没有生成 ~/.cloudflared/cert.pem（授权可能未完成）');
          return;
        }
        finish('ok');
        log('tunnel login 完成，证书已更新');
        return;
      }
      const reason = tailLines(raw);
      finish('error', `cloudflared 退出（${signal ? `signal ${signal}` : `code ${code}`}）`
        + (reason ? `：${reason}` : ''));
      log(`tunnel login 失败 code=${code} signal=${signal || '-'}`);
    });

    session.timer = setTimeout(() => {
      if (session?.state !== 'waiting') return;
      try { session.child?.kill?.('SIGTERM'); } catch { /* 已退出 */ }
      finish('error', `等待浏览器授权超时（${Math.round(timeoutMs / 1000)} 秒）。`
        + '可以重新发起，或在终端手动执行 cloudflared tunnel login。');
      log('tunnel login 超时');
    }, timeoutMs);
    if (session.timer.unref) session.timer.unref();

    return snapshot();
  }

  function cancel() {
    if (!session || session.state !== 'waiting') return snapshot();
    try { session.child?.kill?.('SIGTERM'); } catch { /* 已退出 */ }
    finish('canceled');
    log('tunnel login 已取消');
    return snapshot();
  }

  return { start, cancel, status: snapshot };
}
