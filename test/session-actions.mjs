// test/session-actions.mjs — 会话动作（置顶/归档/重命名/分叉）契约测试。
//
// 桌面端 Session 右键菜单的六个动作里，四个要调用宿主 RPC（复制 ID 纯客户端、
// 「在应用中打开」是本机目录定位，手机端无语义）。这里用假服务抓下真正发给
// 宿主的 payload，逐字段核对 app.asar 实证的 @Remote 签名：
//   workspace/pinSession({sessionId})            → {pinnedSessionIds}
//   workspace/unpinSession({sessionId})          → {pinnedSessionIds}
//   workspace/archiveSession({sessionId,stopActivity?}) → {archivedSessionIds}
//   workspace/unarchiveSession({sessionId})      → {archivedSessionIds}
//   session/rename({sessionId,title})            → {title,seq}
//   session/fork({sessionId})                    → {sessionId}
// 关键纪律：这些动作都是**单参数**（无 signal 形参），误传第二参就是契约错误。

import { createCordisHost } from '../src/adapter/cordis-host.mjs';
import { createMockHost } from '../src/adapter/mock-host.mjs';

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push({ name, detail }); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function fakeCtx({
  withRegistry = true, summaries: customSummaries, archived = ['sess_b'],
} = {}) {
  const calls = { pin: [], unpin: [], archive: [], unarchive: [], rename: [], fork: [] };
  const summaries = customSummaries ?? [
    { sessionId: 'sess_a', cwd: '/w/a', updatedAt: 100, running: true },
    { sessionId: 'sess_b', cwd: '/w/b', updatedAt: 90, agentAvailable: true },
  ];
  const sessionController = {
    async list() { return { ok: true, value: { items: summaries } }; },
    async events() { return { ok: true, value: { records: [], hasMore: false } }; },
    async rename(request, ...extra) {
      calls.rename.push({ request, extra });
      return { ok: true, value: { title: request.title, seq: 7 } };
    },
    async fork(request, ...extra) {
      calls.fork.push({ request, extra });
      return { ok: true, value: { sessionId: 'sess_forked' } };
    },
  };
  const workspaceController = {
    async pinSession(request, ...extra) {
      calls.pin.push({ request, extra });
      return { ok: true, value: { pinnedSessionIds: ['sess_a'] } };
    },
    async unpinSession(request, ...extra) {
      calls.unpin.push({ request, extra });
      return { ok: true, value: { pinnedSessionIds: [] } };
    },
    async archiveSession(request, ...extra) {
      calls.archive.push({ request, extra });
      return { ok: true, value: { archivedSessionIds: [request.sessionId] } };
    },
    async unarchiveSession(request, ...extra) {
      calls.unarchive.push({ request, extra });
      return { ok: true, value: { archivedSessionIds: [] } };
    },
  };
  const workspaceRegistry = {
    pinnedSessionIds: ['sess_a'],
    archivedSessionIds: archived,
  };
  return {
    calls,
    get(name) {
      if (name === 'sessionController') return sessionController;
      if (name === 'workspaceController') return workspaceController;
      if (name === 'workspaceRegistry') return withRegistry ? workspaceRegistry : undefined;
      return undefined;
    },
  };
}

console.log('\n▶ cordis 会话动作契约（与桌面端右键菜单同源）\n');

// ---- 1. 置顶 / 取消置顶：单参数、信封解包、集合回传 ----
{
  const ctx = fakeCtx();
  const host = createCordisHost({ ctx });
  const pin = await host.pinTask('sess_b', { pinned: true });
  check('pin：请求形状 {sessionId}', JSON.stringify(ctx.calls.pin[0]?.request) === '{"sessionId":"sess_b"}',
    JSON.stringify(ctx.calls.pin[0]));
  check('pin：单参数，不传 signal', ctx.calls.pin[0]?.extra.length === 0);
  check('pin：解 {ok,value} 信封得集合', JSON.stringify(pin.pinnedSessionIds) === '["sess_a"]', JSON.stringify(pin));
  check('pin：回 applied/pinned/taskId', pin.applied === true && pin.pinned === true && pin.taskId === 'sess_b');

  const unpin = await host.pinTask('sess_a', { pinned: false });
  check('unpin：走 unpinSession 动作', JSON.stringify(ctx.calls.unpin[0]?.request) === '{"sessionId":"sess_a"}');
  check('unpin：单参数，不传 signal', ctx.calls.unpin[0]?.extra.length === 0);
  check('unpin：回 pinned=false', unpin.pinned === false && unpin.applied === true);
}

// ---- 2. 归档 / 取消归档：stopActivity 只在归档时透传 ----
{
  const ctx = fakeCtx();
  const host = createCordisHost({ ctx });
  const a = await host.archiveTask('sess_a', { archived: true, stopActivity: true });
  check('archive：请求带 stopActivity=true',
    JSON.stringify(ctx.calls.archive[0]?.request) === '{"sessionId":"sess_a","stopActivity":true}',
    JSON.stringify(ctx.calls.archive[0]));
  check('archive：单参数，不传 signal', ctx.calls.archive[0]?.extra.length === 0);
  check('archive：解信封得 archivedSessionIds', JSON.stringify(a.archivedSessionIds) === '["sess_a"]');

  await host.archiveTask('sess_a', { archived: true, stopActivity: false });
  check('archive：不带 stopActivity 时请求只有 sessionId',
    JSON.stringify(ctx.calls.archive[1]?.request) === '{"sessionId":"sess_a"}',
    JSON.stringify(ctx.calls.archive[1]));

  const u = await host.archiveTask('sess_b', { archived: false });
  check('unarchive：请求无 stopActivity 字段',
    JSON.stringify(ctx.calls.unarchive[0]?.request) === '{"sessionId":"sess_b"}');
  check('unarchive：单参数，不传 signal', ctx.calls.unarchive[0]?.extra.length === 0);
  check('unarchive：回 archived=false', u.archived === false);
}

// ---- 3. 重命名 / 分叉：sessionController 单参数 RPC ----
{
  const ctx = fakeCtx();
  const host = createCordisHost({ ctx });
  const r = await host.renameTask('sess_a', { title: '新标题' });
  check('rename：请求 {sessionId,title}',
    JSON.stringify(ctx.calls.rename[0]?.request) === '{"sessionId":"sess_a","title":"新标题"}',
    JSON.stringify(ctx.calls.rename[0]));
  check('rename：单参数，不传 signal', ctx.calls.rename[0]?.extra.length === 0);
  check('rename：回传宿主导出的 title/seq', r.title === '新标题' && r.seq === 7, JSON.stringify(r));

  const f = await host.forkTask('sess_a');
  check('fork：请求只有 {sessionId}',
    JSON.stringify(ctx.calls.fork[0]?.request) === '{"sessionId":"sess_a"}',
    JSON.stringify(ctx.calls.fork[0]));
  check('fork：单参数，不传 signal', ctx.calls.fork[0]?.extra.length === 0);
  check('fork：回传新会话 ID', f.forkedTaskId === 'sess_forked', JSON.stringify(f));

  let denied = false;
  try { await host.renameTask('sess_a', { title: '   ' }); } catch { denied = true; }
  check('rename：空标题 → 4400', denied);
}

// ---- 4. 列表可见性对齐桌面端 tree.ts（subagent / blank / archived 三段过滤）----
//
// 2026-11-18 真机对账：宿主 list 返回 48 条（25 条已归档 + 一批子会话与空占位），
// 桌面端侧栏只有十几条。手机此前把三类都塞进任务条，既比桌面端多很多，也让
// 「归档/删除」点完任务条纹丝不动——用户读到的是「点了没反应」。
{
  const ctx = fakeCtx();
  const host = createCordisHost({ ctx });

  let page = await host.listTasks({});
  check('列表：默认不含归档会话（与桌面端 hide 同口径）',
    page.items.map((t) => t.taskId).join(',') === 'sess_a',
    JSON.stringify(page.items.map((t) => t.taskId)));
  check('列表：未归档项的 pinned 仍来自 workspaceRegistry',
    page.items[0]?.pinned === true && page.items[0]?.archived === false,
    JSON.stringify(page.items[0]));

  // includeArchived 对应「已归档」视图：只返回归档项，供恢复。
  page = await host.listTasks({ includeArchived: true });
  check('列表：includeArchived 只返回归档会话',
    page.items.map((t) => t.taskId).join(',') === 'sess_b',
    JSON.stringify(page.items.map((t) => t.taskId)));
  check('列表：归档视图项标记 archived=true', page.items[0]?.archived === true);
}
{
  // 子代理子会话 / 空占位：桌面端只挂在父行的子代理目录里，不单独占任务条。
  const ctx = fakeCtx({
    archived: [],
    summaries: [
      { sessionId: 'sess_top', cwd: '/w', updatedAt: 100, agentAvailable: true },
      { sessionId: 'sess_child', cwd: '/w', updatedAt: 99, origin: 'subagent' },
      { sessionId: 'sess_child2', cwd: '/w', updatedAt: 98, parentSessionId: 'sess_top' },
      { sessionId: 'sess_blank', cwd: '/w', updatedAt: 97, blank: true },
      { sessionId: 'sess_blank_running', cwd: '/w', updatedAt: 96, blank: true, running: true },
    ],
  });
  const host = createCordisHost({ ctx });
  const ids = (await host.listTasks({})).items.map((t) => t.taskId);
  check('列表：subagent 子会话不进任务条',
    !ids.includes('sess_child') && !ids.includes('sess_child2'), JSON.stringify(ids));
  check('列表：blank 空占位不进任务条', !ids.includes('sess_blank'), JSON.stringify(ids));
  check('列表：正在跑的 blank 保留（新建即发消息不闪没）',
    ids.includes('sess_blank_running'), JSON.stringify(ids));
  check('列表：顶层会话照常返回', ids.includes('sess_top'), JSON.stringify(ids));
}
{
  // workspaceRegistry 不可见时不能拖垮整个列表（尽力而为的附加字段）
  const ctx = fakeCtx({ withRegistry: false });
  const host = createCordisHost({ ctx });
  const page = await host.listTasks({});
  check('列表：workspaceRegistry 缺失仍返回全部会话', page.items.length === 2);
  check('列表：状态标记降级为 false', page.items.every((t) => !t.pinned && !t.archived));
}

console.log('\n▶ mock 宿主会话动作（端到端镜像）\n');

// ---- 5. mock：动作改状态，列表/详情快照随之更新 ----
{
  const host = createMockHost();
  const before = await host.listTasks({});
  const target = before.items[0].taskId;
  const runningTarget = before.items.find((t) => t.status === 'running')?.taskId;

  const pin = await host.pinTask(target, { pinned: true });
  check('mock pin：回集合含目标', pin.pinnedSessionIds.includes(target));
  let page = await host.listTasks({});
  check('mock pin：列表带 pinned=true', page.items.find((t) => t.taskId === target)?.pinned === true);

  await host.pinTask(target, { pinned: false });
  page = await host.listTasks({});
  check('mock unpin：列表 pinned 回到 false', page.items.find((t) => t.taskId === target)?.pinned === false);

  // 归档运行中会话不带 stopActivity → 4007（与宿主 workspace/session-active 同语义）
  let busyDenied = false;
  try { await host.archiveTask(runningTarget, { archived: true }); } catch (e) { busyDenied = e.code === 4007; }
  check('mock archive：运行中未确认 → 4007', busyDenied);
  const a = await host.archiveTask(runningTarget, { archived: true, stopActivity: true });
  check('mock archive：stopActivity 后成功', a.archived === true);
  // 关键回归：归档后主列表必须立刻不含它——这正是真机「点了没反应」的根因。
  page = await host.listTasks({});
  check('mock archive：主列表不再含该任务',
    !page.items.some((t) => t.taskId === runningTarget),
    JSON.stringify(page.items.map((t) => t.taskId)));
  page = await host.listTasks({ includeArchived: true });
  check('mock archive：已归档视图带 archived=true',
    page.items.find((t) => t.taskId === runningTarget)?.archived === true);
  check('mock archive：归档同时取消置顶',
    page.items.find((t) => t.taskId === runningTarget)?.pinned === false);
  await host.archiveTask(runningTarget, { archived: false });
  page = await host.listTasks({});
  check('mock unarchive：回到主列表且 archived=false',
    page.items.find((t) => t.taskId === runningTarget)?.archived === false);

  const r = await host.renameTask(target, { title: '改名后' });
  check('mock rename：回显新标题', r.title === '改名后');
  const detail = await host.getTask(target);
  check('mock rename：详情快照标题同步', detail.task.title === '改名后');

  const f = await host.forkTask(target);
  check('mock fork：返回新 ID', typeof f.forkedTaskId === 'string' && f.forkedTaskId !== target);
  page = await host.listTasks({});
  check('mock fork：新会话出现在列表', page.items.some((t) => t.taskId === f.forkedTaskId));

  let missing = false;
  try { await host.pinTask('no_such_task', { pinned: true }); } catch (e) { missing = e.code === 4011; }
  check('mock：未知会话 → 4011', missing);
  await host.close();
}

const total = pass + failures.length;
console.log(`\n结果：${pass} 通过 / ${failures.length} 失败（共 ${total}）`);
if (failures.length) process.exitCode = 1;
