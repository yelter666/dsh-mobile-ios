// test/enhance.mjs — 提示词增强契约（真调宿主 llm，2026-11-18）。
//
// 这条能力此前是纯本地规则（只套模板、不调模型），实测质量太弱。改成走宿主
// `ctx.llm.stream()`：网关是宿主内插件，可以直接用服务对象，不需要 Remote RPC
// （宿主没有把补全暴露成 @Remote 动作）。
//
// 这里用假 llm 服务抓下真正发给模型的 GenerateOptions，逐字段核对：
//   provider/model 来自 modelCatalog.default（可被显式覆盖）
//   system      = 增强系统提示（语言一致/保留原意/结构化/控篇幅/只输出正文）
//   messages    = 恰好一条 user 文本（一次性补全，不背会话历史）
//   temperature / maxTokens / signal 必须给到
// 并覆盖流式拼接、输出清洗、错误路径。

import { createCordisHost } from '../src/adapter/cordis-host.mjs';
import { createMockHost } from '../src/adapter/mock-host.mjs';

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push({ name, detail }); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** 假宿主：llm.stream 吐给定块；modelCatalog 给默认模型。 */
function fakeCtx({ chunks, throwOnStream, defaultModel = { provider: 'p_demo', model: 'm_demo' } } = {}) {
  const calls = { stream: [] };
  const llm = {
    stream(options) {
      calls.stream.push(options);
      const payload = chunks ?? [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: '目标：\n把登录页改快。\n\n' },
        { type: 'text-delta', index: 0, text: '要求：\n1. 首屏 < 1 秒。' },
        { type: 'finish', reason: 'stop' },
      ];
      return (async function* gen() {
        if (throwOnStream) throw new Error('provider exploded');
        for (const chunk of payload) yield chunk;
      })();
    },
  };
  const sessionController = {
    async modelCatalog() {
      return {
        ok: true,
        value: {
          default: defaultModel,
          routableProviders: defaultModel?.provider ? [defaultModel.provider] : [],
          groups: [], failures: [],
        },
      };
    },
    async list() { return { ok: true, value: { items: [] } }; },
  };
  return {
    calls,
    get(name) {
      if (name === 'llm') return llm;
      if (name === 'sessionController') return sessionController;
      return undefined;
    },
  };
}

console.log('\n▶ 提示词增强契约（真调宿主 llm）\n');

// ---- 1. 请求形状：默认模型、system、单条 user、参数 ----
{
  const ctx = fakeCtx();
  const host = createCordisHost({ ctx });
  const result = await host.enhancePrompt({ text: '把登录页改快一点' });

  const req = ctx.calls.stream[0];
  check('增强：走 llm.stream 一次性补全', ctx.calls.stream.length === 1);
  check('增强：provider 取 modelCatalog.default', req?.provider === 'p_demo', JSON.stringify(req?.provider));
  check('增强：model 取 modelCatalog.default', req?.model === 'm_demo', JSON.stringify(req?.model));
  check('增强：带 system 提示词', typeof req?.system === 'string' && req.system.length > 80);
  check('增强：system 强调语言一致', /语言一致/.test(req?.system ?? ''), (req?.system ?? '').slice(0, 60));
  check('增强：system 要求只输出正文', /只输出改写后的提示词正文/.test(req?.system ?? ''));
  check('增强：system 禁止新增需求', /不新增用户没有表达的需求/.test(req?.system ?? ''));
  check('增强：messages 恰好一条', Array.isArray(req?.messages) && req.messages.length === 1);
  check('增强：消息角色为 user', req?.messages?.[0]?.role === 'user');
  check('增强：正文是 text block 且原样带上',
    req?.messages?.[0]?.content?.[0]?.type === 'text'
    && req.messages[0].content[0].text === '把登录页改快一点',
    JSON.stringify(req?.messages?.[0]?.content));
  check('增强：temperature 低且给定', req?.temperature === 0.2, String(req?.temperature));
  check('增强：maxTokens 给定', req?.maxTokens === 1200, String(req?.maxTokens));
  check('增强：带 abort signal', !!req?.signal);
  check('增强：purpose 标注辅助调用', req?.purpose === 'prompt-enhance', String(req?.purpose));

  check('增强：流式 text-delta 已拼接', result.text.includes('把登录页改快') && result.text.includes('首屏 < 1 秒'), result.text);
  check('增强：回传 finishReason', result.finishReason === 'stop', String(result.finishReason));
  check('增强：回传实际路由便于排查', result.provider === 'p_demo' && result.model === 'm_demo');
}

// ---- 2. 显式路由覆盖默认 ----
{
  const ctx = fakeCtx();
  const host = createCordisHost({ ctx });
  await host.enhancePrompt({ text: '写个周报', provider: 'p_custom', model: 'm_custom' });
  const req = ctx.calls.stream[0];
  check('增强：显式 provider/model 覆盖默认',
    req?.provider === 'p_custom' && req?.model === 'm_custom',
    `${req?.provider}/${req?.model}`);
}

{
  // 实测踩到：宿主 FinishReason 是对象 {kind:'stop'}，不是字符串。
  // 不压平的话 iOS 的 String? 解码会直接失败，整个增强回执变成「未知错误」。
  const ctx = fakeCtx({
    chunks: [
      { type: 'text-delta', index: 0, text: '目标：\n写点东西' },
      { type: 'finish', reason: { kind: 'length' } },
    ],
  });
  const host = createCordisHost({ ctx });
  const r = await host.enhancePrompt({ text: '写点东西' });
  check('增强：对象型 FinishReason 压成字符串 kind',
    r.finishReason === 'length', JSON.stringify(r.finishReason));
}

// ---- 3. 输出清洗：代码块外壳与「以下是」前言 ----
{
  const ctx = fakeCtx({
    chunks: [
      { type: 'text-delta', index: 0, text: '```markdown\n目标：\n生成周报\n```' },
      { type: 'finish', reason: 'stop' },
    ],
  });
  const host = createCordisHost({ ctx });
  const r = await host.enhancePrompt({ text: '写周报' });
  check('增强：剥掉整段代码块外壳', r.text === '目标：\n生成周报', JSON.stringify(r.text));
}
{
  const ctx = fakeCtx({
    chunks: [
      { type: 'text-delta', index: 0, text: '以下是增强后的提示词：\n目标：\n整理会议纪要\n' },
      { type: 'finish', reason: 'stop' },
    ],
  });
  const host = createCordisHost({ ctx });
  const r = await host.enhancePrompt({ text: '整理纪要' });
  check('增强：剥掉「以下是…：」前言', r.text === '目标：\n整理会议纪要', JSON.stringify(r.text));
}

// ---- 4. 错误路径 ----
{
  const ctx = fakeCtx();
  const host = createCordisHost({ ctx });
  let code = 0;
  try { await host.enhancePrompt({ text: '   ' }); } catch (e) { code = e.code; }
  check('增强：空输入 → 4400', code === 4400, String(code));
}
{
  const ctx = fakeCtx();
  const host = createCordisHost({ ctx });
  let code = 0;
  try { await host.enhancePrompt({ text: 'x'.repeat(4001) }); } catch (e) { code = e.code; }
  check('增强：超长输入 → 4400', code === 4400, String(code));
}
{
  const ctx = fakeCtx({ defaultModel: { provider: '', model: '' } });
  const host = createCordisHost({ ctx });
  let code = 0;
  try { await host.enhancePrompt({ text: '写点什么' }); } catch (e) { code = e.code; }
  check('增强：无可用默认模型 → 4021', code === 4021, String(code));
}
{
  const ctx = fakeCtx({ throwOnStream: true });
  const host = createCordisHost({ ctx });
  let code = 0; let message = '';
  try { await host.enhancePrompt({ text: '写点什么' }); } catch (e) { code = e.code; message = e.message; }
  check('增强：模型抛错 → 4500', code === 4500, String(code));
  check('增强：错误信息带「模型调用失败」', /模型调用失败/.test(message), message);
}
{
  const ctx = fakeCtx({
    chunks: [
      { type: 'text-delta', index: 0, text: '   \n ' },
      { type: 'finish', reason: 'stop' },
    ],
  });
  const host = createCordisHost({ ctx });
  let code = 0;
  try { await host.enhancePrompt({ text: '写点什么' }); } catch (e) { code = e.code; }
  check('增强：模型空结果 → 4500', code === 4500, String(code));
}

// ---- 5. mock 宿主 ----
{
  const host = createMockHost();
  const r = await host.enhancePrompt({ text: '把首页改成两栏' });
  check('mock enhance：返回非空文本', typeof r.text === 'string' && r.text.length > 20);
  check('mock enhance：保留原文', r.text.includes('把首页改成两栏'), r.text);
  check('mock enhance：标注 mock 路由', r.provider === 'mock' && r.model === 'mock-enhance');
  let code = 0;
  try { await host.enhancePrompt({ text: '' }); } catch (e) { code = e.code; }
  check('mock enhance：空输入 → 4400', code === 4400, String(code));
  await host.close();
}

const total = pass + failures.length;
console.log(`\n结果：${pass} 通过 / ${failures.length} 失败（共 ${total}）`);
if (failures.length) process.exitCode = 1;
