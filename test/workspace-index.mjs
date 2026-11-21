// test/workspace-index.mjs — 工作区分组索引的形状契约测试。
//
// 2026-11-21 真机返工（分组条三点菜单整条消失）复盘：适配器按 `ws.workspaceId`
// 取 id、用 `Array.isArray(ws.sessionIds)` 判会话归属，而宿主 workspaceRegistry.list()
// 的实际形状是同步返回的 Workspace 对象：
//   { id, title, path, sessionIds: Set<string> }
// 两处形状误判叠加 → 每个工作区都被跳过 → /tasks 的 workspaces 恒为 []（真机实测
// items:15 / workspaces:0）→ 所有任务 workspaceId=null → 手机端全部退化成 cwd 兜底
// 分组 → 分组头菜单被"非真实工作区"条件整体过滤掉。
//
// 这里用与宿主同形的假注册表把这条链路钉死：id 用 `id`、sessionIds 用 Set，
// 同时验证旧的数组形状仍然兼容（mock fixture / 老宿主）。

import { createCordisHost } from '../src/adapter/cordis-host.mjs';

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push({ name, detail }); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const summaries = [
  { sessionId: 's_harness', cwd: '/Users/me/code/harness', updatedAt: 3, agentAvailable: true },
  { sessionId: 's_stock', cwd: '/Users/me/code/stock', updatedAt: 2, agentAvailable: true },
  { sessionId: 's_desktop', cwd: '/Users/me/Desktop', updatedAt: 1, agentAvailable: false },
];

/** 宿主同形注册表：同步 list() + Workspace 对象（id / title / path / sessionIds:Set）。 */
function realShapeCtx() {
  const workspaces = [
    { id: 'ws_harness', title: 'DeepSeek Harness', path: '/Users/me/code/harness', sessionIds: new Set(['s_harness']) },
    { id: 'ws_stock', title: 'Stock', path: '/Users/me/code/stock', sessionIds: new Set(['s_stock']) },
  ];
  return {
    get(name) {
      if (name === 'sessionController') {
        return { async list() { return { ok: true, value: { items: summaries } }; } };
      }
      if (name === 'workspaceRegistry') {
        return {
          list() { return workspaces; },
          pinnedSessionIds: [],
          archivedSessionIds: [],
        };
      }
      return undefined;
    },
  };
}

console.log('\n▶ 工作区分组索引（workspaceRegistry.list 形状契约）\n');

// ---- 1. 宿主真实形状：id + Set 的 sessionIds 必须映射成功 ----
{
  const host = createCordisHost({ ctx: realShapeCtx() });
  const page = await host.listTasks({ limit: 50 });

  check('workspaces 非空（曾被全部跳过后恒为 []）', page.workspaces.length === 2,
    JSON.stringify(page.workspaces));
  check('分组 id 取 ws.id', page.workspaces.map((w) => w.id).join(',') === 'ws_harness,ws_stock',
    JSON.stringify(page.workspaces));
  check('分组名取 ws.title', page.workspaces.map((w) => w.name).join(',') === 'DeepSeek Harness,Stock');

  const byId = new Map(page.items.map((t) => [t.taskId, t]));
  check('Set 里的会话拿到 workspaceId',
    byId.get('s_harness')?.workspaceId === 'ws_harness', JSON.stringify(byId.get('s_harness')));
  check('Set 里的会话拿到 workspaceName',
    byId.get('s_harness')?.workspaceName === 'DeepSeek Harness');
  check('第二个工作区同样映射', byId.get('s_stock')?.workspaceId === 'ws_stock');
  check('无归属会话保持 null（由客户端落 cwd 兜底分组）',
    byId.get('s_desktop')?.workspaceId === null && byId.get('s_desktop')?.workspaceName === null);
}

// ---- 2. 旧形状兼容：workspaceId 字段 + sessionIds 数组 ----
{
  const ctx = {
    get(name) {
      if (name === 'sessionController') {
        return { async list() { return { ok: true, value: { items: summaries } }; } };
      }
      if (name === 'workspaceRegistry') {
        return {
          list() {
            return [{ workspaceId: 'ws_old', name: '旧分组', sessionIds: ['s_stock'] }];
          },
          pinnedSessionIds: [],
          archivedSessionIds: [],
        };
      }
      return undefined;
    },
  };
  const page = await createCordisHost({ ctx }).listTasks({ limit: 50 });
  check('旧形状：workspaceId 字段仍被识别', page.workspaces[0]?.id === 'ws_old',
    JSON.stringify(page.workspaces));
  check('旧形状：name 兜底成组名', page.workspaces[0]?.name === '旧分组');
  check('旧形状：数组 sessionIds 仍映射', page.items.find((t) => t.taskId === 's_stock')?.workspaceId === 'ws_old');
}

// ---- 3. 注册表整体缺席：不能抛，回空分组、任务保持 null ----
{
  const ctx = {
    get(name) {
      if (name === 'sessionController') {
        return { async list() { return { ok: true, value: { items: summaries } }; } };
      }
      return undefined;
    },
  };
  const page = await createCordisHost({ ctx }).listTasks({ limit: 50 });
  check('注册表缺席：workspaces 为空数组', Array.isArray(page.workspaces) && page.workspaces.length === 0);
  check('注册表缺席：任务仍全部下发', page.items.length === 3);
}

console.log(`\n工作区索引：${pass} 通过，${failures.length} 失败\n`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f.name} ${f.detail}`);
  process.exit(1);
}
