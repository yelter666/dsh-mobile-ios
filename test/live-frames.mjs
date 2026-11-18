// test/live-frames.mjs — 实时事件流（v2）验收：宿主事件 → 网关帧
//
// 背景：适配器的 subscribe 曾是空实现，于是「手机发消息 → 宿主跑了 → 手机一片死寂」。
// 这里用假宿主回放真实事件形状（seq/time/data），钉住三件事：
//   1. 什么该推（真人输入、回复、思考、工具、回合结束）；
//   2. 什么不该推（系统注入的 user/message、噪声事件）；
//   3. 轮询的水位语义：首轮只记水位不补历史，之后只推新事件，且只推一次。
//
// 跑法：cd gateway && node test/live-frames.mjs

import { translateLiveEvent } from '../src/adapter/session-history.mjs';
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

const userMsg = (text, seq, kind = 'user') => ({
  type: 'user/message', seq, time: 1700000000000 + seq,
  data: { source: { kind }, content: [{ type: 'text', text }] },
});
const assistantMsg = (parts, seq) => ({
  type: 'assistant/message', seq, time: 1700000000000 + seq,
  data: { turn: 1, message: { content: parts } },
});
const toolCall = (name, seq) => ({
  type: 'tool/call', seq, time: 1700000000000 + seq,
  data: { turn: 1, callId: `c${seq}`, name, arguments: '{"path":"a.ts"}' },
});
const toolResult = (text, seq) => ({
  type: 'tool/result', seq, time: 1700000000000 + seq,
  data: { turn: 1, toolCallId: `c${seq - 1}`, content: [{ type: 'text', text }] },
});
const turnEnd = (seq, error) => ({
  type: 'turn/end', seq, time: 1700000000000 + seq,
  data: { turn: 1, ...(error ? { reason: { kind: 'error', error: { message: error } } } : {}) },
});

// MARK: 翻译层

console.log('实时帧翻译：');
{
  const [frame] = translateLiveEvent(userMsg('把测试补上', 10));
  check('真人输入 → user_message 帧', frame?.kind === 'turn' && frame?.data?.type === 'user_message');
  check('文本原样带上', frame?.data?.text === '把测试补上');

  const injected = translateLiveEvent(userMsg('system-reminder…', 11, 'system-reminder'));
  check('系统注入的 user/message 不推（否则时间线全是噪声）', injected.length === 0);

  const frames = translateLiveEvent(assistantMsg(
    [{ type: 'reasoning', text: '先看依赖' }, { type: 'text', text: '改完了' }], 12
  ));
  check('回复 + 思考拆成两帧', frames.length === 2);
  check('思考帧是 thought_delta', frames[0].data.type === 'thought_delta');
  check('正文帧是 assistant_delta', frames[1].data.type === 'assistant_delta');
  check('空 reasoning 不产生帧',
    translateLiveEvent(assistantMsg([{ type: 'reasoning', text: '' }], 13)).length === 0);

  const call = translateLiveEvent(toolCall('read_file', 14))[0];
  check('工具调用 → tool_call 帧', call?.data?.type === 'tool_call');
  check('工具名与参数摘要都在', call?.data?.toolName === 'read_file' && !!call?.data?.argSummary);

  const result = translateLiveEvent(toolResult('文件 120 行', 15))[0];
  check('工具结果 → tool_result 帧', result?.data?.type === 'tool_result' && result?.data?.ok === true);

  const end = translateLiveEvent(turnEnd(16))[0];
  check('回合结束 → turn_end 帧', end?.data?.type === 'turn_end');

  const failed = translateLiveEvent(turnEnd(17, '模型超时'))[0];
  check('失败回合带出原因', failed?.data?.ok === false && /模型超时/.test(failed?.data?.summary ?? ''));

  check('噪声事件（step/* 等）不产生帧',
    translateLiveEvent({ type: 'step/begin', seq: 18, data: {} }).length === 0);
  check('包层 {event} 也能解', translateLiveEvent({ event: userMsg('包一层', 19) })[0]?.data?.text === '包一层');
}

// MARK: 轮询水位

console.log('实时轮询：');
{
  const log = [];
  let seq = 0;
  const records = [];
  const push = (e) => records.push({ event: e });

  // 已有 3 条历史：首轮必须**只记水位**，不能把历史重推给手机。
  push(userMsg('旧问题', ++seq));
  push(assistantMsg([{ type: 'text', text: '旧回答' }], ++seq));
  push(turnEnd(++seq));

  const ctrl = {
    async list() {
      return { ok: true, value: { items: [{ sessionId: 's_1', updatedAt: Date.now(), agentAvailable: true, running: true, cwd: '/tmp' }] } };
    },
    async events() {
      return { ok: true, value: { records: records.slice(-40), hasMore: false } };
    },
  };
  const ctx = { get: (n) => (n === 'sessionController' ? ctrl : undefined) };

  const host = createCordisHost({ ctx, log: (m) => log.push(m) });
  const frames = [];
  const stop = host.subscribe((f) => frames.push(f));

  await new Promise((r) => setTimeout(r, 300));
  // 首轮只允许一条 state（告诉手机「这个任务在跑」），**不能**把历史当新事件重推。
  const firstTurns = frames.filter((f) => f.kind === 'turn');
  check('首轮不补历史（手机的历史走 REST）', firstTurns.length === 0, `收到 ${firstTurns.length} 条 turn`);
  check('首轮给出运行状态', frames.some((f) => f.kind === 'state' && f.data.status === 'running'));

  // 宿主继续产出：一条新指令、一段回复、回合结束
  push(userMsg('新问题', ++seq));
  push(assistantMsg([{ type: 'text', text: '新回答' }], ++seq));
  push(turnEnd(++seq));

  await new Promise((r) => setTimeout(r, 1800));
  const turnFrames = frames.filter((f) => f.kind === 'turn');
  check('新事件被推出去', turnFrames.length === 3, `收到 ${turnFrames.length} 帧`);
  check('推送顺序 = 发生顺序',
    turnFrames.map((f) => f.data.type).join(',') === 'user_message,assistant_delta,turn_end',
    turnFrames.map((f) => f.data.type).join(','));
  check('帧上带 taskId', frames.every((f) => f.taskId === 's_1'));

  const before = frames.length;
  await new Promise((r) => setTimeout(r, 1600));
  check('同一条事件不会被推两次', frames.length === before, `多出 ${frames.length - before} 帧`);

  stop();
  const afterStop = frames.length;
  push(userMsg('停止后的消息', ++seq));
  await new Promise((r) => setTimeout(r, 1600));
  check('取消订阅后不再轮询', frames.length === afterStop);
}

// MARK: 写操作后的首轮（真机回归）

console.log('写操作后立刻观察：');
{
  // 宿主在 prompt() 内部就把这条指令写成 user/message。
  // 如果观察时把水位设成「此刻的最大 seq」，这条消息会把自己排除掉——
  // 真机表现：助手回答了，但用户那句问话不在时间线上（2026-11-17 实测）。
  let seq = 3;
  const records = [];
  const push = (e) => records.push({ event: e });
  push(userMsg('很早以前的问题', 1));
  push(assistantMsg([{ type: 'text', text: '很早以前的回答' }], 2));
  push(turnEnd(3));

  const ctrl = {
    async list() { return { ok: true, value: { items: [] } }; },
    async events() { return { ok: true, value: { records: records.slice(-40), hasMore: false } }; },
    async prompt() { push(userMsg('刚发的这句', ++seq)); return { ok: true }; },
  };
  const ctx = { get: (n) => (n === 'sessionController' ? ctrl : undefined) };
  const host = createCordisHost({ ctx, log: () => {} });
  const frames = [];
  const stop = host.subscribe((f) => frames.push(f));

  await new Promise((r) => setTimeout(r, 300));
  await host.appendMessage('s_2', { text: '刚发的这句' });
  await new Promise((r) => setTimeout(r, 1800));

  const users = frames.filter((f) => f.kind === 'turn' && f.data.type === 'user_message');
  check('刚发出的指令本身被推送', users.length === 1, `收到 ${users.length} 条`);
  check('推送的是刚写的那句', users[0]?.data?.text === '刚发的这句');
  check('没有把旧历史一起推出来',
    !frames.some((f) => f.kind === 'turn' && f.data.text === '很早以前的问题'));
  stop();
}

console.log(`\n结果：${pass} 通过 / ${failures.length} 失败`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  process.exit(1);
}
