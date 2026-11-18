// adapter/mux-host.mjs — HTTP 探测式宿主适配器（X2 考古后降级为诊断用途）
// 纪律（ADR-12）：这一层是唯一允许出现宿主 API 的地方。
//
// X2 结论（2026-11-16，见 RUNBOOK §10）：宿主不存在 `/api/remote.mux` HTTP 端点
// （asar 内 mux 命中全是 tmux-context）；宿主的「mux」是 Gateway 的
// RemoteStreamMuxServer——Typert RPC 挂在 webServer 的 WebSocket `/api` 上。
// 进程内路径由 cordis-host.mjs 承担；本适配器仅保留 probe 诊断能力，
// 任何业务方法都显式抛 4021，绝不假装成功——
// 假成功比连不上更糟：它会让客户端在错误的前提下通过验收。

import { fail } from '../protocol.mjs';

const DEFAULT_BASE = 'http://127.0.0.1:3000';

export function createMuxHost({ baseUrl = DEFAULT_BASE, token, log = () => {}, timeoutMs = 2500 } = {}) {
  const root = baseUrl.replace(/\/+$/, '');
  let cachedInfo = null;
  let lastProbe = null;

  const authHeaders = token ? { authorization: `Bearer ${token}` } : {};

  async function probe() {
    const startedAt = Date.now();
    const url = `${root}/api/remote.mux`;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(url, { method: 'GET', headers: authHeaders, signal: ctrl.signal });
      clearTimeout(timer);
      const text = await res.text();
      lastProbe = {
        ok: res.ok,
        status: res.status,
        ms: Date.now() - startedAt,
        url,
        bodyPreview: text.slice(0, 200),
      };
      if (res.ok) {
        try {
          const body = JSON.parse(text);
          cachedInfo = normalizeInfo(body);
        } catch {
          /* 返回非 JSON 也接受：说明端点存在，但报文格式未确认 */
        }
      }
      return lastProbe;
    } catch (err) {
      lastProbe = { ok: false, status: 0, ms: Date.now() - startedAt, url, error: err.message };
      return lastProbe;
    }
  }

  function normalizeInfo(body = {}) {
    return {
      hostId: body.hostId || 'host_unknown',
      hostName: body.hostName || body.name || 'DSH 宿主',
      hostVersion: body.hostVersion || body.version || 'unknown',
      platform: body.platform || process.platform,
      protocolVersion: '1.0',
      caps: Array.isArray(body.caps) ? body.caps : [],
      maxConcurrentTasks: body.maxConcurrentTasks ?? 3,
    };
  }

  const notMapped = (method) =>
    fail(4021, `方法 ${method} 尚未与 /api/remote.mux 对齐（X2 未闭环）`, {
      detail: lastProbe ? `probe status=${lastProbe.status}` : '尚未探测',
    });

  const host = {
    kind: 'mux',
    info() {
      if (!cachedInfo) {
        throw fail(4021, '宿主信息尚未取得：/api/remote.mux 不可达或格式未确认', {
          detail: lastProbe ? `status=${lastProbe.status} url=${lastProbe.url}` : '尚未探测',
        });
      }
      return cachedInfo;
    },
    probe,
    lastProbe: () => lastProbe,
    listTasks: async () => notMapped('tasks.list'),
    getTask: async () => notMapped('tasks.get'),
    listArtifacts: async () => notMapped('artifacts.list'),
    createTask: async () => notMapped('tasks.create'),
    appendMessage: async () => notMapped('tasks.message'),
    cancelTask: async () => notMapped('tasks.cancel'),
    answerTodo: async () => notMapped('todos.answer'),
    diag: async () => ({ adapter: 'mux', probe: lastProbe }),
    subscribe(fn) {
      // 真实宿主的事件流要挂 mux 的推送通道；未接通前不产生任何事件
      log('mux   subscribe：事件通道未接通（等 X2 方法表）');
      return () => fn;
    },
    async close() {},
  };

  return host;
}
