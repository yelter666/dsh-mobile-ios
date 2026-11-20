// adapter/mock-host.mjs — 用契约样本驱动宿主（决策 D3：Mock 载体）
// 目的：让客户端与网关在真实宿主不可用时也能跑到端到端；它不模拟"智能"，
// 只忠实回放契约里已有的报文形状，避免 UI 在假数据上长歪。

import { fail, newId } from '../protocol.mjs';
import { createMockData } from './mock-data.mjs';

export function createMockHost({ log = () => {}, autoPlay = false, speed = 1, data = null } = {}) {
  const fixtures = data || createMockData();
  const hostInfo = fixtures.hostInfo;
  const listBody = fixtures.listBody;
  const detail = fixtures.detail;
  const createOk = fixtures.createOk;
  const messageOk = fixtures.messageOk;
  const cancelOk = fixtures.cancelOk;
  const artifacts = fixtures.artifacts;
  const todoOk = fixtures.todoOk;
  const scenario = fixtures.scenario;

  const tasks = new Map(listBody.items.map((t) => [t.taskId, { ...t }]));
  // 工作区分组：与 cordis  alike，从夹具顶层 workspaces 下发，任务行带同源 id/name。
  const workspaces = Array.isArray(listBody.workspaces) ? listBody.workspaces : [];
  // 会话动作的 mock 状态（2026-11-18）：置顶/归档集合，与桌面端 workspaceRegistry 同语义。
  // 列表快照据此带 pinned/archived 标记，长按菜单的「取消置顶/取消归档」才能被验证。
  const pinnedIds = new Set();
  const archivedIds = new Set();
  // 会话设置的 mock 状态（2026-11-17 同步面）：权限当前值 + 每任务模型选择。
  const sessionModels = new Map();
  const MOCK_PERMISSION_OPTIONS = [
    { value: 'requireApproval', name: '需审批', description: '每一步写入与命令都需要确认' },
    { value: 'autoApprove', name: '自动批准', description: '跳过确认，按默认策略执行' },
    { value: 'readOnly', name: '只读', description: '只允许读取，不改动任何文件' },
  ];
  const MOCK_MODEL_GROUPS = [
    {
      id: 'deepseek', name: 'DeepSeek',
      models: [
        { id: 'deepseek-chat', name: 'DeepSeek Chat' },
        { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', defaultEffort: 'medium' },
      ],
    },
    {
      id: 'openai', name: 'OpenAI',
      models: [{ id: 'gpt-5.2', name: 'GPT-5.2', defaultEffort: 'high' }],
    },
  ];
  const modelOf = (taskId) => sessionModels.get(taskId) ?? { provider: 'deepseek', model: 'deepseek-chat' };
  const subscribers = new Set();
  const timers = new Set();
  let playing = null;

  // 宿主历史记录（2026-11-18 补齐 mock 冷启动历史缺口）：
  // 之前 mock 没有 events 面，GET /tasks/:id/events 永远 4500，
  // 手机端冷启动时间线永远是空的——mock 截图验证不了气泡/时间戳。
  // 记录形状与宿主对齐（session-history.mjs 的翻译输入）：{type, seq, time(ms), data}。
  const history = new Map(); // taskId -> [record]
  const record = (taskId, type, data, at) => {
    const list = history.get(taskId) ?? [];
    list.push({
      type,
      seq: list.length + 1,
      time: at ? Date.parse(at) || Date.now() : Date.now(),
      data,
    });
    history.set(taskId, list);
  };

  const emit = (taskId, kind, data, at) => {
    // 同步落一份宿主形状的历史记录（只落时间线会渲染的，噪声不搬）。
    host.ingestExternal(taskId, kind, data, at);
    for (const fn of subscribers) fn({ taskId, kind, data, at });
  };

  const clearTimers = () => {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    playing = null;
  };

  const host = {
    kind: 'mock',
    info: () => ({ ...hostInfo, caps: [...hostInfo.caps] }),

    /**
     * 外部注入的帧（dev 端点 /__mock/emit 直发 core，绕过 host.emit）也
     * 落一份宿主形状的历史记录，保证 events() 与 WS 看到同一个世界。
     */
    ingestExternal(taskId, kind, data, at) {
      if (kind !== 'turn' || !data || typeof data !== 'object') return;
      if (data.type === 'user_message') {
        record(taskId, 'user/message', {
          content: [{ type: 'text', text: String(data.text ?? '') }],
          source: { kind: 'user' },
        }, at);
      } else if (data.type === 'thought_delta') {
        record(taskId, 'assistant/message', {
          turn: 1,
          message: { content: [{ type: 'reasoning', text: String(data.delta ?? '') }] },
        }, at);
      } else if (data.type === 'assistant_delta') {
        record(taskId, 'assistant/message', {
          turn: 1,
          message: { content: [{ type: 'text', text: String(data.delta ?? '') }] },
        }, at);
      } else if (data.type === 'tool_call') {
        record(taskId, 'tool/call', {
          turn: 1, callId: data.callId ?? newId('call'),
          name: data.toolName ?? 'tool', arguments: data.argSummary ?? '',
        }, at);
      } else if (data.type === 'tool_result') {
        record(taskId, 'tool/result', {
          turn: 1, toolCallId: data.callId ?? newId('call'), name: data.toolName,
          content: [{ type: 'text', text: String(data.summary ?? '') }],
        }, at);
      }
    },

    async listTasks({ status, limit = 50, includeArchived = false } = {}) {
      // 与 cordis 同口径（桌面端 tree.ts isVisible）：置顶优先；
      // 子会话 / 空占位不进任务条；归档默认隐藏，只在 includeArchived 视图出现。
      const all = [...tasks.values()]
        .map((t) => ({ ...t, pinned: pinnedIds.has(t.taskId), archived: archivedIds.has(t.taskId) }))
        .filter((t) => !status || t.status === status)
        .filter((t) => t.origin !== 'subagent' && !t.parentSessionId)
        .filter((t) => !(t.blank === true && t.status !== 'running'))
        .filter((t) => (includeArchived ? t.archived : !t.archived));
      all.sort((a, b) => (Number(b.pinned) - Number(a.pinned))
        || (Date.parse(b.lastActivityAt ?? 0) - Date.parse(a.lastActivityAt ?? 0)));
      return {
        items: all.slice(0, limit),
        workspaces,
        nextCursor: null,
        serverTime: new Date().toISOString(),
      };
    },

    async getTask(taskId) {
      const t = tasks.get(taskId);
      if (!t) throw fail(4011);
      const flags = { pinned: pinnedIds.has(taskId), archived: archivedIds.has(taskId) };
      if (taskId === detail.task.taskId) {
        return { ...detail, task: { ...detail.task, ...t, ...flags }, lastSeq: 0, serverTime: new Date().toISOString() };
      }
      return {
        task: { ...t, ...flags, lastSeq: 0 },
        budget: { limitMin: t.budgetMin ?? 10, usedSec: t.elapsedSec ?? 0, remainingSec: 600, warnAt: 480 },
        pendingTodos: [],
        artifactsPreview: [],
        tokenUsage: null,
        lastSeq: 0,
        serverTime: new Date().toISOString(),
      };
    },

    async listArtifacts(taskId) {
      if (!tasks.has(taskId)) throw fail(4011);
      return artifacts;
    },

    /** mock 侧不碰磁盘：产物内容是固定文本，够客户端验证「点开→预览」这条链路。 */
    async readArtifact(taskId, artifactId) {
      if (!tasks.has(taskId)) throw fail(4011);
      const item = (artifacts.items ?? []).find((a) => a.artifactId === artifactId);
      if (!item) throw fail(4404, '产物不存在');
      const body = `# ${item.name}\n\nmock 产物内容（${item.kind}）\n`;
      return {
        name: item.name,
        mime: 'text/markdown; charset=utf-8',
        sizeBytes: Buffer.byteLength(body),
        data: Buffer.from(body, 'utf8'),
      };
    },

    async createTask({ prompt, title, permission = 'requireApproval', budgetMin = 10, attachments } = {}) {
      const taskId = newId('tsk');
      tasks.set(taskId, {
        taskId,
        storedKey: newId('sk'),
        title: title || String(prompt).slice(0, 24),
        status: 'running',
        phase: { index: 1, total: 5, label: '已接收' },
        elapsedSec: 0,
        startedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        hostId: hostInfo.hostId,
        hostName: hostInfo.hostName,
        cwd: '/mock/workspace',
        permission,
        budgetMin,
        needsYou: false,
        pendingTodoCount: 0,
        artifactsCount: 0,
      });
      emit(taskId, 'state', { status: 'running', phase: { index: 1, total: 5, label: '已接收' }, elapsedSec: 0, needsYou: false });
      log(`host  createTask ${taskId}`);
      return { ...createOk, taskId, storedKey: tasks.get(taskId).storedKey, acceptedAt: new Date().toISOString() };
    },

    async appendMessage(taskId, { text, attachments } = {}) {
      if (!tasks.has(taskId)) throw fail(4011);
      const turnId = newId('turn');
      // 纯附件消息 text 可空；mock 只记元数据（不落字节），供端到端断言送达。
      const atts = Array.isArray(attachments) ? attachments : [];
      const names = atts.map((a) => a?.name || a?.kind || 'attachment').join('、');
      const delta = text
        ? `收到：${String(text).slice(0, 40)}`
        : `收到附件：${names || '附件'}`;
      emit(taskId, 'turn', { turnId, type: 'assistant_delta', delta });
      return { ...messageOk, taskId, turnId, acceptedAt: new Date().toISOString() };
    },

    /**
     * 冷启动历史（FR-CHAT-01）：从 emit 落下的宿主形状记录里翻页。
     * 记录按 seq 升序返回；beforeSeq 取更早的一页（seq < beforeSeq）。
     * mock 数据量小，一页装得下，hasMore 恒 false。
     */
    async events(taskId, { beforeSeq, limit = 60 } = {}) {
      if (!tasks.has(taskId)) throw fail(4011);
      const all = history.get(taskId) ?? [];
      const filtered = Number.isFinite(beforeSeq) && beforeSeq > 0
        ? all.filter((r) => r.seq < beforeSeq)
        : all;
      const records = filtered.slice(-Math.min(Math.max(limit, 1), 200));
      return { taskId, records, hasMore: false };
    },

    async cancelTask(taskId) {
      const t = tasks.get(taskId);
      if (!t) throw fail(4011);
      t.status = 'cancelled';
      emit(taskId, 'state', { status: 'cancelled', phase: { index: 5, total: 5, label: '已停止' }, elapsedSec: t.elapsedSec ?? 0, needsYou: false });
      log(`host  cancelTask ${taskId}`);
      return { ...cancelOk, taskId, at: new Date().toISOString() };
    },

  async answerTodo(taskId, todoId, { decision }) {
    if (!tasks.has(taskId)) throw fail(4011);
    emit(taskId, 'todo', { todoId, state: 'resolved', decision, resolvedAt: new Date().toISOString() });
    return { ...todoOk, taskId, todoId, decision, resolvedAt: new Date().toISOString() };
  },

  // MARK: 会话动作（与桌面端右键菜单同源；mock 用内存集合模拟 workspaceRegistry）

  // MARK: 提示词增强（mock 无模型，返回可预期的结构化文本供端到端断言）

  async enhancePrompt({ text } = {}) {
    const source = String(text ?? '').trim();
    if (!source) throw fail(4400, '待增强的提示词不能为空');
    return {
      text: `目标：\n${source}\n\n要求：\n1. 先给结论，再给依据。\n2. 保留原文给出的数值、路径与名称。\n3. 输出可直接执行的结果，不要额外解释。`,
      provider: 'mock',
      model: 'mock-enhance',
      finishReason: 'stop',
      at: new Date().toISOString(),
    };
  },

  async pinTask(taskId, { pinned = true } = {}) {
    if (!tasks.has(taskId)) throw fail(4011);
    if (pinned) pinnedIds.add(taskId); else pinnedIds.delete(taskId);
    log(`host  ${pinned ? 'pin' : 'unpin'} ${taskId}`);
    return {
      applied: true, taskId, pinned,
      pinnedSessionIds: [...pinnedIds], at: new Date().toISOString(),
    };
  },

  async archiveTask(taskId, { archived = true, stopActivity = false } = {}) {
    const t = tasks.get(taskId);
    if (!t) throw fail(4011);
    if (archived) {
      // 与宿主一致：运行中会话不带 stopActivity 会拒绝（workspace/session-active → 我们用 4007 表达"忙"）。
      if ((t.status === 'running' || t.status === 'pending') && stopActivity !== true) {
        throw fail(4007, '会话正在运行，归档前需先停止', { detail: 'workspace/session-active' });
      }
      if (stopActivity === true && (t.status === 'running' || t.status === 'pending')) {
        t.status = 'cancelled';
      }
      archivedIds.add(taskId);
      pinnedIds.delete(taskId); // 宿主归档时同时取消置顶（client/model.ts installArchived 实证）
    } else {
      archivedIds.delete(taskId);
    }
    log(`host  ${archived ? 'archive' : 'unarchive'} ${taskId}`);
    return {
      applied: true, taskId, archived,
      archivedSessionIds: [...archivedIds], at: new Date().toISOString(),
    };
  },

  async renameTask(taskId, { title } = {}) {
    const t = tasks.get(taskId);
    if (!t) throw fail(4011);
    const name = String(title ?? '').trim();
    if (!name) throw fail(4400, '标题不能为空');
    t.title = name;
    t.lastActivityAt = new Date().toISOString();
    log(`host  rename ${taskId} → ${name}`);
    return { applied: true, taskId, title: name, seq: (t.lastSeq ?? 0) + 1, at: new Date().toISOString() };
  },

  async forkTask(taskId) {
    const t = tasks.get(taskId);
    if (!t) throw fail(4011);
    const forkedTaskId = newId('tsk');
    tasks.set(forkedTaskId, {
      ...t, taskId: forkedTaskId, storedKey: newId('sk'),
      title: `${t.title}（分叉）`,
      status: 'idle', phase: null, startedAt: null, lastActivityAt: new Date().toISOString(),
      needsYou: false, pendingTodoCount: 0,
    });
    log(`host  fork ${taskId} → ${forkedTaskId}`);
    return { accepted: true, taskId, forkedTaskId, at: new Date().toISOString() };
  },

  // MARK: 会话设置同步（与 cordis 适配器同形状；mock 恒 supported，供端到端与回归断言）

  async sessionSettings(taskId) {
    if (!tasks.has(taskId)) throw fail(4011);
    const selection = modelOf(taskId);
    return {
      taskId,
      permission: {
        supported: true,
        currentValue: tasks.get(taskId).permission ?? 'requireApproval',
        options: MOCK_PERMISSION_OPTIONS,
      },
      model: {
        supported: true,
        current: selection,
        default: { provider: 'deepseek', model: 'deepseek-chat' },
        groups: MOCK_MODEL_GROUPS,
        failures: [],
      },
      serverTime: new Date().toISOString(),
    };
  },

  async setPermission(taskId, { preset } = {}) {
    if (!tasks.has(taskId)) throw fail(4011);
    const value = String(preset ?? '').trim();
    if (!value) throw fail(4400, 'preset 不能为空');
    if (!MOCK_PERMISSION_OPTIONS.some((o) => o.value === value)) {
      throw fail(4400, `未知权限预设：${value}`);
    }
    tasks.get(taskId).permission = value;
    log(`host  setPermission ${taskId} → ${value}`);
    return { applied: true, taskId, value, at: new Date().toISOString() };
  },

  async selectModel(taskId, { provider, model, reasoningEffort } = {}) {
    if (!tasks.has(taskId)) throw fail(4011);
    const providerId = String(provider ?? '').trim();
    const modelId = String(model ?? '').trim();
    if (!providerId || !modelId) throw fail(4400, 'provider 与 model 不能为空');
    const group = MOCK_MODEL_GROUPS.find((g) => g.id === providerId);
    if (!group || !group.models.some((m) => m.id === modelId)) {
      throw fail(4400, `目录中没有 ${providerId}/${modelId}`);
    }
    const selection = { provider: providerId, model: modelId };
    if (reasoningEffort) selection.reasoningEffort = String(reasoningEffort);
    sessionModels.set(taskId, selection);
    log(`host  selectModel ${taskId} → ${providerId}/${modelId}`);
    return { applied: true, taskId, selection, at: new Date().toISOString() };
  },

    /**
     * 宿主重启钩子（由 GatewayCore.restartHost 调用）。
     *
     * 真实宿主重启后，在跑的任务不会复活，宿主会把它们标成中断。
     * mock 若不建模这一步，列表快照仍报 running，客户端「已中断 · 可续」的降级
     * 会被列表覆盖回「运行中」——端到端就验不出 FR-TASK-06。
     */
    onHostRestart(reason = 'host_restart') {
      let affected = 0;
      for (const t of tasks.values()) {
        if (t.status !== 'running' && t.status !== 'pending') continue;
        t.status = 'interrupted';
        t.needsYou = false;
        t.pendingTodoCount = 0;
        t.lastActivityAt = new Date().toISOString();
        affected += 1;
        // 刻意**不**发事件：调用方紧接着清空环缓冲并断开连接，谁也收不到；
        // 发了只会让「重启那一瞬间」的时序变得不可预测。
        // 状态由随后的列表快照体现——真实宿主也是这样。
      }
      log(`host  onHostRestart(${reason}) 降级 ${affected} 个运行中任务`);
      return affected;
    },

    async diag() {
      return { adapter: 'mock', data: 'builtin', tasks: tasks.size };
    },

    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },

    /** 回放契约里的 10 帧事件流（间隔按 speed 缩放），用于验收"实时"而不只是"首屏" */
    playScenario(taskId = fixtures.RUNNING_TASK, { speed: s = speed } = {}) {
      clearTimers();
      playing = taskId;
      let acc = 0;
      for (const item of scenario.frames || []) {
        acc += (item.delayMs || 60) / s;
        const t = setTimeout(() => {
          timers.delete(t);
          emit(taskId, item.frame.kind, item.frame.data, new Date().toISOString());
        }, acc);
        timers.add(t);
      }
      const done = setTimeout(() => timers.delete(done), acc + 50);
      timers.add(done);
      log(`host  playScenario ${taskId} frames=${(scenario.frames || []).length}`);
      return { playing, frames: (scenario.frames || []).length };
    },

    stopScenario: clearTimers,
    isPlaying: () => playing,

    async close() {
      clearTimers();
      subscribers.clear();
    },
  };

  if (autoPlay) setTimeout(() => host.playScenario(), 50).unref?.();
  return host;
}
