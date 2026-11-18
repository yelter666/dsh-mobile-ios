// session-history.mjs — 宿主会话事件 → 手机时间线条目（FR-CHAT-01 冷启动）
//
// 宿主事件形状（app.asar typert + 真机取证）：
//   { type, seq, time(ms), data, surfaceOp? }
// 事件类型实测 30 余种（tool/ptc-dispatch-*、step/*、job/*、compaction/* 等）。
// 手机端只渲染「用户 / 回复 / 思考 / 工具 / 回合结束」五类，其余（系统提示词、
// 调度噪声、投递回执）**不搬**——时间线要的是可读内容，不是原始日志。
//
// 严谨边界：
//   · assistant/message 的 content 里同时含 reasoning / text / tool-call，
//     tool-call 由独立的 tool/call 事件承载，这里跳过避免工具行重复；
//   · 空 reasoning / 空 text 一律丢弃（实测大量 {"type":"reasoning","text":""}）；
//   · seq 原样保留，供客户端排序与去重；客户端不拿它做实时续传判断。

const TEXT_LIMIT = 4000;
// 思考链单独一档上限：桌面端能看到完整推理过程，手机上被截在 4000 字
// 就等于「同步了一半」。正文仍收在 4000，避免长日志把时间线撑爆。
const REASONING_LIMIT = 24000;
const SUMMARY_LIMIT = 200;

const at = (ms) => (typeof ms === 'number' ? new Date(ms).toISOString() : undefined);
const texts = (content) =>
  Array.isArray(content)
    ? content.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('')
    : '';
const clip = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…` : s);
const turnIdOf = (data) => (typeof data?.turn === 'number' ? `t${data.turn}` : undefined);

/**
 * @param {Array<{event?: object}|object>} records 宿主 events 记录（可能带 {event} 包层）
 * @returns {{items: Array<object>, lastSeq: number, nextBeforeSeq: number|null, skipped: Record<string, number>}}
 */
export function translateRecords(records = []) {
  const items = [];
  const skipped = Object.create(null);
  let lastSeq = 0;
  let minSeq = null;
  let order = 0;

  const push = (seq, entry) => {
    // 注意顺序：entry 展开在前，id/seq 兜底在后——否则 entry.id === undefined
    // 会覆盖生成的兜底 id，JSON 序列化丢键，客户端整页解码失败（实测 items[22]）。
    items.push({ ...entry, id: entry.id ?? `h-${seq}-${order++}`, seq });
    if (typeof seq === 'number') {
      lastSeq = Math.max(lastSeq, seq);
      minSeq = minSeq === null ? seq : Math.min(minSeq, seq);
    }
  };

  for (const raw of records) {
    const e = raw && typeof raw === 'object' && raw.event ? raw.event : raw;
    if (!e || typeof e !== 'object') continue;
    const seq = typeof e.seq === 'number' ? e.seq : 0;
    const time = at(e.time);
    const d = e.data ?? {};

    switch (e.type) {
      case 'user/message': {
        const text = texts(d.content);
        // 只收真人输入：宿主把 system-reminder / 时间戳采样 / checkpoint 摘要
        // 也塞成 user/message（source.kind 分别 different），搬进时间线就是噪声。
        if (!text || d.source?.kind !== 'user') break;
        push(seq, {
          id: d.id ? `u-${d.id}` : undefined,
          kind: 'user',
          at: time,
          text: clip(text, TEXT_LIMIT),
        });
        break;
      }

      case 'assistant/message': {
        const turnId = turnIdOf(d);
        const parts = Array.isArray(d.message?.content) ? d.message.content : [];
        parts.forEach((part, index) => {
          if (!part || typeof part !== 'object') return;
          if (part.type === 'reasoning' && part.text) {
            push(seq, {
              id: `a-${seq}-r${index}`,
              kind: 'thought',
              at: time,
              turnId,
              text: clip(part.text, REASONING_LIMIT),
            });
          } else if (part.type === 'text' && part.text) {
            push(seq, {
              id: `a-${seq}-t${index}`,
              kind: 'assistant',
              at: time,
              turnId,
              text: clip(part.text, TEXT_LIMIT),
            });
          }
          // tool-call 部件由 tool/call 事件承载，这里跳过（避免重复工具行）
        });
        break;
      }

      case 'tool/call': {
        push(seq, {
          id: d.callId ? `tc-${d.callId}` : undefined,
          kind: 'tool_call',
          at: time,
          turnId: turnIdOf(d),
          name: d.name || 'tool',
          argSummary: clip(typeof d.arguments === 'string' ? d.arguments : JSON.stringify(d.arguments ?? ''), SUMMARY_LIMIT),
        });
        break;
      }

      case 'tool/result': {
        const text = texts(d.content ?? d.message?.content);
        push(seq, {
          id: d.toolCallId ? `tr-${d.toolCallId}` : undefined,
          kind: 'tool_result',
          callId: d.toolCallId,
          at: time,
          turnId: turnIdOf(d),
          ok: true,
          summary: clip(text, SUMMARY_LIMIT),
        });
        break;
      }

      case 'turn/end': {
        const reason = d.reason?.kind === 'error'
          ? (d.reason.error?.message || '回合因错误结束')
          : null;
        push(seq, {
          id: `te-${seq}`,
          kind: 'turn_end',
          at: time,
          turnId: turnIdOf(d) ?? (typeof d.turn === 'number' ? `t${d.turn}` : undefined),
          summary: reason ? clip(reason, SUMMARY_LIMIT) : null,
        });
        break;
      }

      case 'approval/asked': {
        push(seq, {
          id: d.id ? `ap-${d.id}` : undefined,
          kind: 'marker',
          at: time,
          text: `需要审批：${d.toolName || 'tool'}${d.reason ? ` — ${clip(d.reason, 120)}` : ''}`,
        });
        break;
      }

      default:
        skipped[e.type] = (skipped[e.type] ?? 0) + 1;
        break;
    }
  }

  return { items, lastSeq, nextBeforeSeq: minSeq, skipped };
}

/**
 * 单个宿主事件 → 网关实时帧（WS `turn`）。
 *
 * 为什么是「整条消息」而不是 token 增量：宿主的事件日志是**已落盘的事实**，
 * 里面每条 assistant/message 都是完整句子。真机增量流在宿主的 observeEvent
 * 面（形状尚未取证），在拿到之前如实按整条推送——手机上看到的是「一段一段
 * 长出来」，不是「一个字一个字跳」，但内容一个字都不少。
 *
 * 返回数组：一条宿主事件可能同时含 reasoning 与 text 两个部件。
 */
export function translateLiveEvent(input) {
  const e = input && typeof input === 'object' && input.event ? input.event : input;
  if (!e || typeof e !== 'object') return [];
  const d = e.data ?? {};
  const turnId = turnIdOf(d);
  const at = (typeof e.time === 'number' ? new Date(e.time) : new Date()).toISOString();
  const out = [];

  switch (e.type) {
    case 'user/message': {
      const text = texts(d.content);
      // 只推真人输入。系统注入（system-reminder / checkpoint / 时间戳采样）
      // 也是 user/message，推给手机就是满屏噪声。
      if (!text || d.source?.kind !== 'user') break;
      out.push({ kind: 'turn', at, data: { type: 'user_message', turnId, text: clip(text, TEXT_LIMIT) } });
      break;
    }

    case 'assistant/message': {
      const parts = Array.isArray(d.message?.content) ? d.message.content : [];
      parts.forEach((part) => {
        if (!part || typeof part !== 'object') return;
        if (part.type === 'reasoning' && part.text) {
          out.push({ kind: 'turn', at, data: { type: 'thought_delta', turnId, delta: clip(part.text, REASONING_LIMIT) } });
        } else if (part.type === 'text' && part.text) {
          out.push({ kind: 'turn', at, data: { type: 'assistant_delta', turnId, delta: clip(part.text, TEXT_LIMIT) } });
        }
      });
      break;
    }

    case 'tool/call': {
      out.push({
        kind: 'turn',
        at,
        data: {
          type: 'tool_call',
          turnId,
          toolName: d.name || 'tool',
          argSummary: clip(typeof d.arguments === 'string' ? d.arguments : JSON.stringify(d.arguments ?? ''), SUMMARY_LIMIT),
        },
      });
      break;
    }

    case 'tool/result': {
      const text = texts(d.content ?? d.message?.content);
      out.push({
        kind: 'turn',
        at,
        data: { type: 'tool_result', turnId, toolName: d.name, ok: true, summary: clip(text, SUMMARY_LIMIT) },
      });
      break;
    }

    case 'turn/end': {
      const failed = d.reason?.kind === 'error';
      out.push({
        kind: 'turn',
        at,
        data: {
          type: 'turn_end',
          turnId: turnId ?? (typeof d.turn === 'number' ? `t${d.turn}` : undefined),
          ...(failed ? { ok: false, summary: clip(d.reason?.error?.message || '回合因错误结束', SUMMARY_LIMIT) } : {}),
        },
      });
      break;
    }

    default:
      break;
  }
  return out;
}
