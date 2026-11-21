// test/workspace-actions.mjs — 工作区写动作（重命名/删除）契约测试。
//
// 桌面端分组右键菜单的「重命名 / 删除工作区」走宿主 workspaceController 的
// @Remote('rename') / @Remote('delete')，与 pin/archive 同一个 service、单参数无
// signal（RPC 元数据 invocation.kind='direct'）：
//   workspace/rename({workspaceId, title}) → WorkspaceValue
//   workspace/delete({workspaceId})        → {deleted:true}
// 这里用假 ctx 抓下真正发给宿主的 payload，逐字段核对 app.asar 实证签名。
// 删除只移除分组注册（会话落到未分组、文件保留），不是删文件——回执如实反映。

import { createCordisHost } from '../src/adapter/cordis-host.mjs';
import { createMockHost } from '../src/adapter/mock-host.mjs';

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push({ name, detail }); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function fakeCtx({ missingController = false } = {}) {
  const calls = { rename: [], delete: [] };
  const workspaceController = {
    async rename(request, ...extra) {
      calls.rename.push({ request, extra });
      return { ok: true, value: { workspace: { workspaceId: request.workspaceId, title: request.title } } };
    },
    async delete(request, ...extra) {
      calls.delete.push({ request, extra });
      return { ok: true, value: { deleted: true } };
    },
  };
  return {
    calls,
    get(name) {
      if (name === 'workspaceController') return missingController ? undefined : workspaceController;
      return undefined;
    },
  };
}

console.log('\n▶ cordis 工作区写动作契约（与桌面端分组右键菜单同源）\n');

// ---- 1. 重命名：workspaceController.rename 单参数、信封解包、标题回传 ----
{
  const ctx = fakeCtx();
  const host = createCordisHost({ ctx });
  const r = await host.renameWorkspace('ws_dseek', { title: '深度搜索组' });
  check('rename：请求 {workspaceId,title}',
    JSON.stringify(ctx.calls.rename[0]?.request) === '{"workspaceId":"ws_dseek","title":"深度搜索组"}',
    JSON.stringify(ctx.calls.rename[0]));
  check('rename：单参数，不传 signal', ctx.calls.rename[0]?.extra.length === 0);
  check('rename：解 {ok,value} 信封得新标题', r.title === '深度搜索组' && r.applied === true, JSON.stringify(r));
  check('rename：回传 workspaceId', r.workspaceId === 'ws_dseek');

  let denied = false;
  try { await host.renameWorkspace('ws_dseek', { title: '   ' }); } catch { denied = true; }
  check('rename：空标题 → 4400', denied);
  denied = false;
  try { await host.renameWorkspace('', { title: 'x' }); } catch { denied = true; }
  check('rename：空 workspaceId → 4400', denied);
}

// ---- 2. 删除：workspaceController.delete 单参数、只移除注册 ----
{
  const ctx = fakeCtx();
  const host = createCordisHost({ ctx });
  const d = await host.deleteWorkspace('ws_stock');
  check('delete：请求只有 {workspaceId}',
    JSON.stringify(ctx.calls.delete[0]?.request) === '{"workspaceId":"ws_stock"}',
    JSON.stringify(ctx.calls.delete[0]));
  check('delete：单参数，不传 signal', ctx.calls.delete[0]?.extra.length === 0);
  check('delete：回 applied/deleted/workspaceId',
    d.applied === true && d.deleted === true && d.workspaceId === 'ws_stock', JSON.stringify(d));

  let denied = false;
  try { await host.deleteWorkspace(''); } catch { denied = true; }
  check('delete：空 workspaceId → 4400', denied);
}

// ---- 3. 宿主服务缺失：如实 4021，不假装成功 ----
{
  const ctx = fakeCtx({ missingController: true });
  const host = createCordisHost({ ctx });
  let code;
  try { await host.renameWorkspace('ws_x', { title: 'x' }); }
  catch (e) { code = e?.code; }
  check('宿主缺 workspaceController → 4021', code === 4021, `code=${code}`);
}

// ---- 4. mock 宿主对齐：改名反映到列表、删除后会话落到未分组 ----
// 2026-11-21 双线合并后：mock 数据集统一由 src/adapter/mock-data.mjs 提供
// （Windows 侧抽出，单工作区 ws_mock），不再是旧的 ws_stock / ws_harness。
{
  const host = createMockHost({ log: () => {} });
  const WS = 'ws_mock';
  const r = await host.renameWorkspace(WS, { title: '新名称' });
  check('mock rename：回传新标题', r.title === '新名称' && r.applied === true, JSON.stringify(r));
  const list = await host.listTasks({ limit: 50 });
  check('mock rename：列表快照反映新名称',
    list.workspaces.find((w) => (w.id ?? w.workspaceId) === WS)?.name === '新名称',
    JSON.stringify(list.workspaces));
  const d = await host.deleteWorkspace(WS);
  check('mock delete：回 deleted=true', d.deleted === true && d.applied === true, JSON.stringify(d));
  const after = await host.listTasks({ limit: 50 });
  check('mock delete：分组从列表消失', !after.workspaces.some((w) => (w.id ?? w.workspaceId) === WS),
    JSON.stringify(after.workspaces));
  check('mock delete：会话落到未分组（workspaceId 清空）',
    !after.items.some((t) => t.workspaceId === WS), JSON.stringify(after.items.map((t) => t.workspaceId)));

  let code;
  try { await host.renameWorkspace('ws_nope', { title: 'x' }); }
  catch (e) { code = e?.code; }
  check('mock rename：不存在的工作区 → 4011', code === 4011, `code=${code}`);
}

// ---- 5. createTask 带 model：回执回显 modelApplied ----
{
  const host = createMockHost({ log: () => {} });
  const withModel = await host.createTask({
    prompt: '用新模型跑一遍', provider: 'deepseek', model: 'deepseek-chat',
  });
  check('create：带模型 → modelApplied=true', withModel.modelApplied === true, JSON.stringify(withModel));
  const noModel = await host.createTask({ prompt: '默认模型' });
  check('create：不带模型 → 无 modelApplied 字段', noModel.modelApplied === undefined, JSON.stringify(noModel));
}

console.log(`\n工作区写动作契约：${pass} 通过 / ${failures.length} 失败`);
if (failures.length) {
  console.error(failures);
  process.exit(1);
}
