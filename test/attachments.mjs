// test/attachments.mjs — cordis 适配器附件翻译的契约测试（无宿主、假服务）。
//
// 这是「禁止假设」的关键一道：真宿主只在用户机器上，CI/本地跑不到。
// 这里用假 sessionController / fileUploads 抓下 submitPrompt 真正发给宿主的
// payload，逐字段核对 app.asar 实证的 PromptContentPart schema：
//   {type:'text',text} | {type:'image',mediaType,data,name?} | {type:'file',receiptId}

import { createCordisHost } from '../src/adapter/cordis-host.mjs';

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push({ name, detail }); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function fakeCtx() {
  const calls = { prompt: [], uploadStream: [] };
  const sessionController = {
    async list() { return []; },
    async create() { return { ok: true, value: { sessionId: 'sess_new' } }; },
    async events() { throw new Error('no events in fixture'); }, // preWriteSeq → 0
    async prompt(request) { calls.prompt.push(request); return { accepted: true }; },
  };
  const fileUploads = {
    async uploadStream(request) {
      calls.uploadStream.push(request);
      // 真宿主返回 {receiptId, file}；这里只关心 receiptId 被写进 content。
      return { receiptId: 'rcpt_generated_1', file: { attachmentId: 'att_1' } };
    },
  };
  return {
    calls,
    get(name) {
      if (name === 'sessionController') return sessionController;
      if (name === 'fileUploads') return fileUploads;
      return undefined;
    },
  };
}

console.log('\n▶ cordis 附件翻译契约（图片内联 + 文件 receiptId）\n');

// ---- 1. 图片内联：data 是 base64，不触发 uploadStream ----
{
  const ctx = fakeCtx();
  const host = createCordisHost({ ctx });
  const png = Buffer.from([0x89, 0x50, 0x4E, 0x47]).toString('base64');
  await host.appendMessage('sess_a', {
    text: '看这张图',
    attachments: [{ kind: 'image', name: 'shot.png', mediaType: 'image/png', dataBase64: png }],
  });
  const payload = ctx.calls.prompt.at(-1);
  check('图片消息：只发一次 prompt', ctx.calls.prompt.length === 1,
    JSON.stringify(ctx.calls.prompt.length));
  check('图片消息：不调 fileUploads.uploadStream', ctx.calls.uploadStream.length === 0);
  const blocks = payload?.content ?? [];
  check('图片消息：content = 文本块 + 图片块', blocks.length === 2, JSON.stringify(blocks));
  check('图片块 type=image', blocks[1]?.type === 'image', JSON.stringify(blocks[1]));
  check('图片块 mediaType 原样透传 image/png', blocks[1]?.mediaType === 'image/png');
  check('图片块 data 是 base64 字节无损', blocks[1]?.data === png);
  check('图片块 name 透传', blocks[1]?.name === 'shot.png');
  check('图片消息 mode=steer（运行中路径）', payload?.mode === 'steer');
}

// ---- 2. 通用文件：先 uploadStream 换 receiptId，content 只放 receiptId ----
{
  const ctx = fakeCtx();
  const host = createCordisHost({ ctx });
  const data = Buffer.from('report bytes').toString('base64');
  await host.appendMessage('sess_b', {
    text: '看这份报告',
    attachments: [{ kind: 'file', name: '报告.pdf', dataBase64: data }],
  });
  check('文件消息：调了一次 uploadStream', ctx.calls.uploadStream.length === 1,
    JSON.stringify(ctx.calls.uploadStream.length));
  const up = ctx.calls.uploadStream[0];
  check('uploadStream 带 sessionId', up?.sessionId === 'sess_b', JSON.stringify(up?.sessionId));
  check('uploadStream 带 name', up?.name === '报告.pdf');
  check('uploadStream 的 data 是 async iterable', typeof up?.data?.[Symbol.asyncIterator] === 'function');
  const blocks = ctx.calls.prompt.at(-1)?.content ?? [];
  check('文件消息：content = 文本块 + 文件块', blocks.length === 2, JSON.stringify(blocks));
  check('文件块 type=file', blocks[1]?.type === 'file', JSON.stringify(blocks[1]));
  check('文件块用 receiptId，不内嵌字节', blocks[1]?.receiptId === 'rcpt_generated_1' && blocks[1]?.dataBase64 === undefined,
    JSON.stringify(blocks[1]));
}

// ---- 3. 纯附件消息：text 为空也能构造出非空 content ----
{
  const ctx = fakeCtx();
  const host = createCordisHost({ ctx });
  await host.appendMessage('sess_c', {
    text: '',
    attachments: [{ kind: 'image', name: 'only.jpg', mediaType: 'image/jpeg', dataBase64: 'QQ==' }],
  });
  const blocks = ctx.calls.prompt.at(-1)?.content ?? [];
  check('纯附件：content 不含空文本块', blocks.length === 1 && blocks[0]?.type === 'image',
    JSON.stringify(blocks));
}

// ---- 4. 未知 mediaType 的 image 按通用文件处理，不猜、不丢 ----
{
  const ctx = fakeCtx();
  const host = createCordisHost({ ctx });
  await host.appendMessage('sess_d', {
    text: '看看',
    attachments: [{ kind: 'image', name: 'weird.heic', mediaType: 'image/heic', dataBase64: 'QQ==' }],
  });
  check('不支持的图片 mediaType → 走文件通道', ctx.calls.uploadStream.length === 1);
  const blocks = ctx.calls.prompt.at(-1)?.content ?? [];
  check('不支持的图片最终是 file 块', blocks.at(-1)?.type === 'file', JSON.stringify(blocks));
}

// ---- 5. 空数据 / 缺服务如实报错，不假装成功 ----
{
  const ctx = fakeCtx();
  const host = createCordisHost({ ctx });
  let code = null;
  try {
    await host.appendMessage('sess_e', {
      text: 'x', attachments: [{ kind: 'image', name: 'empty.png', mediaType: 'image/png', dataBase64: '' }],
    });
  } catch (err) { code = err?.code; }
  check('附件数据为空 → 4400', code === 4400, String(code));
}
{
  // 缺 fileUploads 服务：文件附件应抛 4021，不能静默丢。
  const ctx = fakeCtx();
  const origGet = ctx.get.bind(ctx);
  ctx.get = (name) => (name === 'fileUploads' ? undefined : origGet(name));
  const host = createCordisHost({ ctx });
  let code = null;
  try {
    await host.appendMessage('sess_f', {
      text: 'x', attachments: [{ kind: 'file', name: 'a.pdf', dataBase64: 'QQ==' }],
    });
  } catch (err) { code = err?.code; }
  check('缺 fileUploads 服务 → 4021（如实边界）', code === 4021, String(code));
}

const total = pass + failures.length;
console.log(`\n结果：${pass} 通过 / ${failures.length} 失败（共 ${total}）`);
if (failures.length) process.exitCode = 1;
