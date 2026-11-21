// test/workspace-create.mjs — 新建工作区 + 宿主错误分类（2026-11-22）。
//
// 两条真机事故都在这里锁住：
//   1) `session/attachment-invalid` 落到兜底 4500（可重试）→ 客户端无限重放，
//      队首堵死、后续消息全部发不出去、每次重试还多建一个空会话。
//      现在必须是 4400（不可重试）+ 一句能行动的中文 + 保留宿主 reason。
//   2) 新任务会话可以选「放进哪个工作区」，也可以新建工作区。工作区在宿主里
//      是一个已存在目录的注册：路径必须绝对，重复注册幂等，会话 cwd 必须一致。

import { createCordisHost } from '../src/adapter/cordis-host.mjs';
import { createMockHost } from '../src/adapter/mock-host.mjs';
import { toGatewayError, HOST_CODE_MAP } from '../src/adapter/host-errors.mjs';

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push({ name, detail }); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// 宿主真 RemoteError 的形状（isDSHRemoteError + code + details）。
function hostError(code, message = code, details = {}) {
  return Object.assign(new Error(message), { isDSHRemoteError: true, code, details });
}

console.log('\n▶ 宿主错误分类（写队列的刹车）\n');

// ---- 1. 附件被拒 = 确定性失败，不可重试 ----
{
  const e = toGatewayError(
    hostError('session/attachment-invalid', 'Model does not support image input.',
      { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' }),
    'session/create+prompt');
  check('attachment-invalid → 4400（不是 4500，不可重试）', e.code === 4400, `code=${e.code}`);
  check('attachment-invalid：文案说清「模型不吃图片」', /不支持图片输入|不接受图片输入/.test(e.message), e.message);
  check('attachment-invalid：detail 保留宿主码与 reason',
    e.extra?.detail?.includes('session/attachment-invalid')
      && e.extra?.detail?.includes('MODEL_DOES_NOT_SUPPORT_IMAGES'), JSON.stringify(e.extra));
  check('attachment-invalid：reason 作为机器字段回传', e.extra?.reason === 'MODEL_DOES_NOT_SUPPORT_IMAGES');

  const unknown = toGatewayError(
    hostError('session/attachment-invalid', 'x', { reason: 'IMAGE_DIMENSION_TOO_LARGE' }),
    'session/prompt');
  check('未知 reason 也带出来（不吞成一句「附件无效」）',
    unknown.code === 4400 && unknown.message.includes('IMAGE_DIMENSION_TOO_LARGE'), unknown.message);

  const bare = toGatewayError(hostError('session/attachment-invalid', 'x'), 'session/prompt');
  check('没有 reason 时给可行动提示', bare.code === 4400 && /去掉附件/.test(bare.message), bare.message);
}

// ---- 2. 其余宿主码保持原语义 ----
{
  check('agent-busy 仍是 4007（可重试）',
    toGatewayError(hostError('session/agent-busy'), 'session/prompt').code === 4007);
  check('not-found 仍是 4011',
    toGatewayError(hostError('session/not-found'), 'session/prompt').code === 4011);
  check('model-unavailable → 4400 且提示去电脑端选模型',
    (() => {
      const e = toGatewayError(hostError('session/model-unavailable'), 'session/create');
      return e.code === 4400 && /模型/.test(e.message);
    })());
  check('未知宿主码仍兜底 4500', toGatewayError(hostError('session/whatever'), 'x').code === 4500);
  check('映射表里 attachment-invalid 是 4400', HOST_CODE_MAP['session/attachment-invalid'] === 4400);
  check('非宿主错误 → 4500 宿主调用异常', (() => {
    const e = toGatewayError(new TypeError('boom'), 'session/create');
    return e.code === 4500 && e.extra?.detail?.includes('TypeError');
  })());
}

console.log('\n▶ cordis 新建工作区（workspaceController.create）\n');

function fakeCtx({ missing = false, createValue = null } = {}) {
  const calls = { create: [] };
  const workspaceController = {
    async create(request, ...extra) {
      calls.create.push({ request, extra });
      return createValue ?? {
        ok: true,
        value: {
          workspace: {
            workspaceId: 'ws_new', path: request.path, title: '项目',
            sessionIds: [], createdAt: '2026-11-22T00:00:00.000Z', updatedAt: '2026-11-22T00:00:00.000Z',
          },
          created: true,
        },
      };
    },
  };
  return {
    calls,
    get(name) {
      if (name === 'workspaceController') return missing ? undefined : workspaceController;
      return undefined;
    },
  };
}

{
  const ctx = fakeCtx();
  const host = createCordisHost({ ctx });
  const r = await host.createWorkspace({ path: '/Users/me/Documents/项目' });
  check('create：请求 {path}', JSON.stringify(ctx.calls.create[0]?.request) === '{"path":"/Users/me/Documents/项目"}',
    JSON.stringify(ctx.calls.create[0]?.request));
  check('create：单参数、不传 signal', ctx.calls.create[0]?.extra.length === 0);
  check('create：解 {ok,value.workspace} 信封', r.workspaceId === 'ws_new' && r.title === '项目', JSON.stringify(r));
  check('create：回传 created=true 与 path', r.created === true && r.path === '/Users/me/Documents/项目', JSON.stringify(r));

  let code;
  try { await host.createWorkspace({ path: '' }); } catch (e) { code = e?.code; }
  check('create：空路径 → 4400', code === 4400, `code=${code}`);
  code = undefined;
  try { await host.createWorkspace({ path: 'Documents/项目' }); } catch (e) { code = e?.code; }
  check('create：相对路径 → 4400（不落到可重试的 4500）', code === 4400, `code=${code}`);
  check('create：相对路径的调用没有打到宿主',
    ctx.calls.create.length === 1, `calls=${ctx.calls.create.length}`);
}
{
  const host = createCordisHost({ ctx: fakeCtx({ missing: true }) });
  let code;
  try { await host.createWorkspace({ path: '/Users/me/x' }); } catch (e) { code = e?.code; }
  check('create：宿主缺 workspaceController → 4021', code === 4021, `code=${code}`);
}

console.log('\n▶ mock 宿主对齐：新建工作区 / 会话归组\n');

{
  const host = createMockHost({ log: () => {} });
  const created = await host.createWorkspace({ path: '/tmp/dsh-ws-a' });
  check('mock create：created=true，标题取目录末段',
    created.created === true && created.title === 'dsh-ws-a' && created.workspaceId, JSON.stringify(created));

  const list = await host.listTasks({ limit: 50 });
  check('mock create：分组出现在列表快照',
    list.workspaces.some((w) => (w.id ?? w.workspaceId) === created.workspaceId),
    JSON.stringify(list.workspaces));

  const again = await host.createWorkspace({ path: '/tmp/dsh-ws-a' });
  check('mock create：同一目录重复登记 → 原分组 + created=false',
    again.created === false && again.workspaceId === created.workspaceId, JSON.stringify(again));

  let code;
  try { await host.createWorkspace({ path: 'relative/path' }); } catch (e) { code = e?.code; }
  check('mock create：相对路径 → 4400', code === 4400, `code=${code}`);

  const before = (await host.listTasks({ limit: 50 })).items.length;
  const task = await host.createTask({ prompt: '整理一下这个目录', workspaceId: created.workspaceId });
  const afterList = await host.listTasks({ limit: 50 });
  const row = afterList.items.find((t) => t.taskId === task.taskId);
  check('mock createTask：会话带上选中的工作区', row?.workspaceId === created.workspaceId, JSON.stringify(row));
  check('mock createTask：cwd 落在工作区目录', row?.cwd === '/tmp/dsh-ws-a', row?.cwd);
  check('mock createTask：列表多了一条（不是"没有下文"）', afterList.items.length === before + 1);

  const countBefore = afterList.items.length;
  code = undefined;
  try { await host.createTask({ prompt: 'x', workspaceId: 'ws_missing' }); } catch (e) { code = e?.code; }
  check('mock createTask：工作区不存在 → 4400', code === 4400, `code=${code}`);
  const afterFail = await host.listTasks({ limit: 50 });
  check('mock createTask：失败不留下空会话', afterFail.items.length === countBefore,
    `${countBefore} → ${afterFail.items.length}`);
}

console.log(`\n新建工作区 / 宿主错误分类：${pass} 通过 / ${failures.length} 失败`);
if (failures.length) {
  console.error(failures);
  process.exit(1);
}
