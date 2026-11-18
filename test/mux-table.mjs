// test/mux-table.mjs — X2 cordis 宿主适配器验收：方法表映射 + 如实降级
//
// 考古证据（app.asar @deepseek-ai/dsh-api-session-controller 等）钉出的宿主形状，
// 这里用假 ctx 忠实回放（与 mock-host「不模拟智能，只回放契约形状」同一纪律）：
//   · sessionController.list() → summaries：{sessionId, updatedAt, agentAvailable,
//     running, blank, cwd, projections}（summaryFor / summarizeCold 的字段）
//   · sessionController.create({cwd}) → {sessionId}
//   · sessionController.prompt({sessionId, requestId, content, mode}) → {accepted:true}
//   · sessionController.cancel({sessionId}) → {accepted:true}
//   · RemoteError：isDSHRemoteError===true + code（'session/not-found' 等）
//
// 跑法：cd gateway && node test/mux-table.mjs

import { createCordisHost } from '../src/adapter/cordis-host.mjs';

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push({ name, detail });
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const CODE = (c) => ({ isDSHRemoteError: true, code: c });

/** 假宿主服务组：形状照抄控制器源码（注释里标了出处）。 */
function fakeServices({ agentBusyOnSteer = false, missing = [] } = {}) {
  const calls = { create: [], prompt: [], cancel: [] };
  const summaries = [
    {
      // live 运行中（summaryFor 形状）
      sessionId: 'sess_live_run', updatedAt: 1700000001000, agentAvailable: true,
      running: true, blank: false, cwd: '/Users/yezheng/code/dsh-harness',
      projections: { values: { title: '跑压测脚本' } },
    },
    {
      // live 空闲（agent 附着但没在跑）→ 映射 idle：宿主不区分「说完了」和「被杀了」，
      // 不能替它断言中断
      sessionId: 'sess_live_idle', updatedAt: 1700000002000, agentAvailable: true,
      running: false, blank: false, cwd: '/tmp/scratch', projections: undefined,
    },
    {
      // 冷会话（历史归档，无 live agent）→ listTasks 必须过滤
      sessionId: 'sess_cold', updatedAt: 1699999000000, agentAvailable: false,
      running: false, blank: false, cwd: '/tmp/old', projections: undefined,
    },
  ];
  const ctrl = {
    async list() {
      if (missing.includes('list')) throw CODE('gateway/internal');
      return summaries;
    },
    async create(request) {
      calls.create.push(request);
      if (request.workspaceId !== undefined && request.cwd !== undefined) throw CODE('gateway/bad-request');
      return { sessionId: 'sess_new' };
    },
    async prompt(request) {
      calls.prompt.push(request);
      if (agentBusyOnSteer && request.mode === 'steer') throw CODE('session/agent-busy');
      if (request.sessionId === 'sess_missing') throw CODE('session/not-found');
      return { accepted: true };
    },
    cancel(request) {
      calls.cancel.push(request);
      if (request.sessionId === 'sess_missing') throw CODE('session/not-found');
      return { accepted: true };
    },
    // 2026-11-17 会话设置同步面（形状照抄 asar zod schema）
    async projections(request) {
      if (request.sessionId === 'sess_missing') throw CODE('session/not-found');
      return {
        asOfSeq: 42,
        values: {
          permissions: { currentValue: 'auto' },
          modelSelection: {
            next: { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' },
            lastUsed: { provider: 'deepseek', model: 'deepseek-chat' },
          },
        },
      };
    },
    async modelCatalog() {
      return {
        default: { provider: 'deepseek', model: 'deepseek-chat' },
        routableProviders: ['deepseek'],
        groups: [
          { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] },
        ],
        failures: [],
      };
    },
    async selectModel(request) {
      calls.selectModel = calls.selectModel ?? [];
      calls.selectModel.push(request);
      return { ok: true, value: { accepted: true } };
    },
  };
  const permissionPresets = {
    async catalog() {
      return {
        options: [
          { value: 'default', name: '默认' },
          { value: 'auto', name: '自动审查', description: '工具调用自动批准' },
        ],
      };
    },
  };
  const commands = {
    async execute(sessionId, command) {
      calls.commands = calls.commands ?? [];
      calls.commands.push({ sessionId, command });
      return { ok: true, value: { commandId: 'cmd_1', result: { kind: 'success' } } };
    },
  };
  return {
    calls,
    summaries,
    get(name) {
      if (missing.includes(name)) return undefined;
      if (name === 'sessionController') return ctrl;
      if (name === 'permissionPresets') return permissionPresets;
      if (name === 'commands') return commands;
      if (name === 'agents') return { get: () => undefined };
      if (name === 'llm') return { listProviders: () => [] };
      return undefined;
    },
  };
}

const results = [];

// ---- 1. listTasks：live 映射 + 冷会话同口径 ----
console.log('\n▶ 方法表：session/list → tasks.list');
{
  const svc = fakeServices();
  const host = createCordisHost({ ctx: svc, hostname: 'TestHost' });
  const res = await host.listTasks();
  const ids = res.items.map((t) => t.taskId);
  // 手机侧栏必须与桌面端同口径：冷会话（历史归档）也在列表里，映射为 idle。
  // 之前只放行活动会话，手机上永远只有一条任务（2026-11-17 真机反馈）。
  check('冷会话也进列表（与桌面端同口径）', ids.includes('sess_cold'), JSON.stringify(ids));
  check('冷会话映射为 idle（不编造状态）',
    res.items.find((t) => t.taskId === 'sess_cold')?.status === 'idle');
  check('运行中 → running', res.items.find((t) => t.taskId === 'sess_live_run')?.status === 'running');
  check('live 空闲 → idle（可续，不冒充中断）', res.items.find((t) => t.taskId === 'sess_live_idle')?.status === 'idle');
  check('title 命中投影', res.items.find((t) => t.taskId === 'sess_live_run')?.title === '跑压测脚本');
  check('title 兜底 cwd 基名', res.items.find((t) => t.taskId === 'sess_live_idle')?.title === 'scratch');
  check('cwd 透传', res.items.find((t) => t.taskId === 'sess_live_run')?.cwd === '/Users/yezheng/code/dsh-harness');
  check('hostName 进 summary', res.items.every((t) => t.hostName === 'TestHost'));
  check('needsYou 如实为 false（不编造审批态）',
    res.items.every((t) => t.needsYou === false && t.pendingTodoCount === 0));
  check('排序按 updatedAt 降序', ids[0] === 'sess_live_idle', JSON.stringify(ids));
}

// ---- 2. getTask：summary 组 detail；缺失 → 4011 ----
console.log('\n▶ 方法表：session/state → tasks.get');
{
  const svc = fakeServices();
  const host = createCordisHost({ ctx: svc });
  const detail = await host.getTask('sess_live_run');
  check('detail.task.taskId 对齐', detail.task.taskId === 'sess_live_run');
  check('budget 如实缺省（iOS 可选解码）', detail.budget === undefined);
  check('lastSeq/serverTime 在位', detail.lastSeq === 0 && typeof detail.serverTime === 'string');
  // 详情必须带产物清单：手机端「对话里那句话提到的文件」全靠它才认得出。
  // 只给 `artifactsPreview: []` 的后果是——产物面板有五个文件，对话里一个入口都没有。
  check('detail 带 artifactsPreview 数组', Array.isArray(detail.artifactsPreview),
    JSON.stringify(detail.artifactsPreview));
  check('artifactsCount 与清单一致',
    detail.task.artifactsCount === detail.artifactsPreview.length,
    `${detail.task.artifactsCount} vs ${detail.artifactsPreview.length}`);
  // 本夹具没有 session/events 服务：产物推导必然失败，但**详情不能因此 500**。
  check('读不到事件时详情仍可解析（产物如实为空）', detail.artifactsPreview.length === 0);
  // 冷会话虽不出列表，但深链/历史跳转仍可解析——如实返回 summary 组的 detail。
  const cold = await host.getTask('sess_cold');
  check('冷会话 getTask 可解析（深链场景）', cold.task.taskId === 'sess_cold');
  let err;
  try { await host.getTask('sess_never_existed'); } catch (e) { err = e; }
  check('不存在的任务 → 4011（不假装存在）', err?.code === 4011, JSON.stringify(err));
}

// ---- 3. createTask：create + prompt 两连，形状照宿主 ----
console.log('\n▶ 方法表：session/create + session/prompt → tasks.create');
{
  const svc = fakeServices();
  const host = createCordisHost({ ctx: svc });
  const res = await host.createTask({ prompt: '写个基准测试', cwd: '/tmp/ws' });
  check('返回 taskId = 宿主 sessionId', res.taskId === 'sess_new');
  check('create 收到 cwd', svc.calls.create[0]?.cwd === '/tmp/ws');
  // 契约必填字段：客户端把它当非可选布尔，缺了就整条响应解码失败，
  // 写队列会判成「可重试」并无限重放（真机症状：新建任务发不出去）。
  check('createTask 回 accepted:true', res.accepted === true, JSON.stringify(res));
  const prompt = svc.calls.prompt[0];
  check('prompt 带随机 requestId', typeof prompt?.requestId === 'string' && prompt.requestId.length >= 32);
  check('prompt content 是 text part', prompt?.content?.[0]?.type === 'text' && prompt.content[0].text === '写个基准测试');
  check('首条 prompt 用 steer（考古实证：mode 只有 steer/append）', prompt?.mode === 'steer');
  let err;
  try { await host.createTask({ prompt: '   ' }); } catch (e) { err = e; }
  check('空 prompt → 4400', err?.code === 4400, JSON.stringify(err));
}

// ---- 4. appendMessage：steer 优先，agent-busy 回落 queue ----
console.log('\n▶ 方法表：session/prompt → tasks.message');
{
  const svc = fakeServices({ agentBusyOnSteer: true });
  const host = createCordisHost({ ctx: svc });
  const res = await host.appendMessage('sess_live_run', { text: '换成更大的数据集' });
  check('appendMessage 返回 turnId（=requestId）', typeof res.turnId === 'string');
  check('appendMessage 回 accepted:true', res.accepted === true, JSON.stringify(res));
  check('steer 被拒绝后回落 append',
    svc.calls.prompt[0]?.mode === 'steer' && svc.calls.prompt[1]?.mode === 'append',
    JSON.stringify(svc.calls.prompt.map((p) => p.mode)));

  const svc2 = fakeServices();
  const host2 = createCordisHost({ ctx: svc2 });
  let err;
  try { await host2.appendMessage('sess_missing', { text: 'hi' }); } catch (e) { err = e; }
  check('宿主 session/not-found → 4011（不回落）', err?.code === 4011, JSON.stringify(err));
}

// ---- 5. cancelTask：形状与错误映射 ----
console.log('\n▶ 方法表：session/cancel → tasks.cancel');
{
  const svc = fakeServices();
  const host = createCordisHost({ ctx: svc });
  const res = await host.cancelTask('sess_live_run');
  check('cancel 请求形状 {sessionId}', svc.calls.cancel[0]?.sessionId === 'sess_live_run');
  check('返回 accepted', res.accepted === true);
  check('返回 cancelRequested / irreversible', res.cancelRequested === true && res.irreversible === false,
    JSON.stringify(res));
  let err;
  try { await host.cancelTask('sess_missing'); } catch (e) { err = e; }
  check('宿主 not-found → 4011', err?.code === 4011, JSON.stringify(err));
}

// ---- 6. 映射不到的方法如实 4021 ----
console.log('\n▶ 如实降级：未映射方法与缺失服务');
{
  const host = createCordisHost({ ctx: fakeServices() });
  let err;
  // 产物列表已接通（从会话事件的写类工具调用推导）。未知会话必须如实回 4011，
  // 而不是像以前那样一律 4021 —— 4021 的含义是「这个主机没有这个能力」。
  try { await host.listArtifacts('tsk_unknown'); } catch (e) { err = e; }
  check('listArtifacts 未知会话 → 4011', err?.code === 4011, JSON.stringify(err));
  err = undefined;
  try { await host.readArtifact('tsk_unknown', 'x'); } catch (e) { err = e; }
  check('readArtifact 未知会话 → 4011', err?.code === 4011, JSON.stringify(err));
  try { await host.answerTodo('t', 'todo', { decision: 'approve' }); } catch (e) { err = e; }
  check('answerTodo → 4021（宿主 session/control v2 接）', err?.code === 4021, JSON.stringify(err));

  const empty = { get: () => undefined };
  const host2 = createCordisHost({ ctx: empty });
  let err2;
  try { await host2.listTasks(); } catch (e) { err2 = e; }
    check('sessionController 缺失 → 4021（指名服务）',
    err2?.code === 4021 && String(err2?.extra?.detail).includes('sessionController'), JSON.stringify(err2));

  const info = host2.info();
  // caps 语义与 mock 对齐：协议能力（不论服务可见性）；服务可见性单独走 services
  // 2026-11-18 新增 tasks.sessionActions（置顶/归档/重命名/分叉，与桌面端右键菜单同源）。
  check('caps 为协议能力（read/write/cancel/artifacts/settings/sessionActions/enhance）',
    Array.isArray(info.caps)
      && info.caps.join(',') === 'tasks.read,tasks.write,tasks.cancel,artifacts.read,tasks.settings,tasks.sessionActions,prompt.enhance',
    JSON.stringify(info.caps));
  check('services 如实为空数组（服务不可见证据）', Array.isArray(info.services) && info.services.length === 0);
  const infoOk = createCordisHost({ ctx: fakeServices() }).info();
  check('services 含 sessionController（可见性证据）', infoOk.services.includes('sessionController'), JSON.stringify(infoOk.services));
  check('caps 含 tasks.read（协议能力）', infoOk.caps.includes('tasks.read'), JSON.stringify(infoOk.caps));
}

// ---- 7. 会话设置同步：权限 / 模型（2026-11-17） ----
console.log('\n▶ 会话设置：sessionSettings / setPermission / selectModel');
{
  const svc = fakeServices();
  const host = createCordisHost({ ctx: svc, hostname: 'TestHost' });

  const settings = await host.sessionSettings('sess_live_run');
  check('settings 权限当前值来自 projections', settings.permission.currentValue === 'auto');
  check('settings 权限目录来自 permissionPresets',
    settings.permission.options.some((o) => o.value === 'auto'), JSON.stringify(settings.permission));
  check('settings 模型当前值 = next 优先', settings.model.current?.model === 'deepseek-reasoner',
    JSON.stringify(settings.model.current));
  check('settings 模型目录分组透传',
    settings.model.groups[0]?.models?.[0]?.id === 'deepseek-chat', JSON.stringify(settings.model.groups));

  const applied = await host.setPermission('sess_live_run', { preset: 'auto' });
  check('权限切换回 applied:true', applied.applied === true && applied.value === 'auto');
  check('权限切换走 /permission 会话命令（桌面端同路径）',
    svc.calls.commands?.[0]?.command === '/permission auto', JSON.stringify(svc.calls.commands));

  const picked = await host.selectModel('sess_live_run', { provider: 'deepseek', model: 'deepseek-chat' });
  check('模型切换回显 selection',
    picked.applied === true && picked.selection.provider === 'deepseek'
      && picked.selection.model === 'deepseek-chat', JSON.stringify(picked));
  check('selectModel 请求形状 {sessionId, provider, model}',
    svc.calls.selectModel?.[0]?.sessionId === 'sess_live_run'
      && svc.calls.selectModel?.[0]?.provider === 'deepseek', JSON.stringify(svc.calls.selectModel));

  let err;
  try { await host.sessionSettings('tsk_unknown'); } catch (e) { err = e; }
  check('settings 未知会话 → 4011', err?.code === 4011, JSON.stringify(err));

  // 面缺失降级：permissionPresets 服务不存在 → 该节 supported:false，整接口不炸
  const partial = fakeServices({ missing: ['permissionPresets'] });
  const host2 = createCordisHost({ ctx: partial, hostname: 'TestHost' });
  const degraded = await host2.sessionSettings('sess_live_run');
  check('permissionPresets 缺失 → 权限节如实 supported:false',
    degraded.permission.supported === false && degraded.permission.options.length === 0,
    JSON.stringify(degraded.permission));
  check('模型节不受影响', degraded.model.supported === true, JSON.stringify(degraded.model));
}

// ---- 8. 宿主内部错误 → 4500 ----
console.log('\n▶ 错误翻译：宿主异常 → 协议码');
{
  const svc = fakeServices({ missing: ['list'] });
  const host = createCordisHost({ ctx: svc });
  let err;
  try { await host.listTasks(); } catch (e) { err = e; }
  check('gateway/internal → 4500', err?.code === 4500, JSON.stringify(err));
}

// ---- 汇总 ----
console.log(`\n结果：${pass} 通过 / ${failures.length} 失败`);
if (failures.length) {
  console.log('失败明细:');
  for (const f of failures) console.log(`  ✗ ${f.name} — ${f.detail}`);
  process.exit(1);
}
console.log('PASS');
