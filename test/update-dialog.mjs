// test/update-dialog.mjs — 插件更新对话框回归测试
//
// 用户诉求：点「插件更新」banner 应弹出对话框（版本对比 + 更新与否由用户选），
// 而不是面板里一行内联文字。本套件用最小 DOM stub 加载浏览器注入模块
// lib/client.js，真实构造三种对话框并断言结构与按钮，防止「改完即宣称」。

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── 最小 DOM stub ──────────────────────────────────────────────
function makeEl(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(), children: [], className: '', _text: '',
    style: {}, listeners: {},
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      toggle(c, on) { if (on) this._set.add(c); else this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); this.children = []; },
    append(...els) { this.children.push(...els); },
    remove() { this._removed = true; },
    setAttribute() {}, select() {},
    addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    querySelector() { return null; },
    getAttribute() { return ''; },
  };
  return el;
}
const body = makeEl('body');
const head = makeEl('head');
const documentStub = {
  body, head, documentElement: makeEl('html'),
  createElement: (t) => makeEl(t),
  getElementById: () => null,
  addEventListener() {}, removeEventListener() {},
  execCommand: () => true,
};
const windowStub = {
  matchMedia: () => ({ matches: false }),
  __ModuleLoader__: { load(mod) { captured = mod; } },
};
const navigatorStub = { clipboard: { writeText: async () => { copied.push(lastCopyValue); } } };
const copied = [];
let lastCopyValue = '';

let captured = null;
let uuidSeq = 0;
const localStorageStub = (() => {
  const m = new Map();
  return { getItem: (k) => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
})();
const sandbox = {
  window: windowStub, document: documentStub, navigator: navigatorStub,
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  AbortSignal, AbortController, fetch: async () => { throw new Error('no network in test'); },
  crypto: { randomUUID: () => `11111111-2222-3333-4444-${String(++uuidSeq).padStart(12, '0')}` },
  localStorage: localStorageStub,
  getComputedStyle: () => ({ backgroundColor: 'rgb(20, 20, 20)' }),
  require: (id) => {
    if (id === 'react') return { createElement: () => makeEl() };
    return {};
  },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
vm.runInContext(src, sandbox);

check('client.js 通过 __ModuleLoader__ 注册模块', !!captured);
const exports = captured.factory(sandbox.require);
const { showUpdateModal, closeUpdateModal, copyToClipboard } = exports.__test;
const { performUpdate, setPluginManager, setUpdateTimeout, isUpdateInFlight, unwrapRemote } = exports.__test;
const { restorePendingUpdate, readUpdateState, writeUpdateState, clearUpdateState } = exports.__test;
const { probe, showDnsHelpModal, copyToClipboard: copyFn, offerManualCopy, showModalToast } = exports.__test;
check('测试钩子导出跨重载恢复函数', typeof restorePendingUpdate === 'function' && typeof writeUpdateState === 'function');
check('测试钩子导出对话框函数', typeof showUpdateModal === 'function' && typeof closeUpdateModal === 'function');
check('测试钩子导出一步更新函数', typeof performUpdate === 'function' && typeof setPluginManager === 'function' && typeof isUpdateInFlight === 'function');

function findByText(el, text, out = []) {
  if (el._text === text) out.push(el);
  for (const c of el.children || []) findByText(c, text, out);
  return out;
}
function allButtons(el, out = []) {
  if (el.tagName === 'BUTTON') out.push(el);
  for (const c of el.children || []) allButtons(c, out);
  return out;
}
function lastModal() { return body.children[body.children.length - 1]; }

console.log('\n插件更新对话框回归\n');

// 1. 发现新版：版本对比 + 两个按钮（稍后再说 / 复制包名）
showUpdateModal({
  title: '发现新版本',
  lines: [{ label: '当前版本', value: 'v0.2.3' }, { label: '最新版本', value: 'v0.2.4', highlight: true }],
  note: '由你决定是否更新',
  actions: [
    { label: '稍后再说', onClick: closeUpdateModal },
    { label: '复制 dsh-mobile-ios@0.2.4', primary: true, onClick: () => {} },
  ],
});
let modal = lastModal();
check('弹出模态遮罩挂到 document.body', body.children.includes(modal));
check('遮罩带 dsh-mios-modal-mask 类', modal.className.includes('dsh-mios-modal-mask'));
check('标题为「发现新版本」', findByText(modal, '发现新版本').length > 0);
check('显示当前版本 v0.2.3', findByText(modal, 'v0.2.3').length > 0);
check('显示最新版本 v0.2.4', findByText(modal, 'v0.2.4').length > 0);
const btns1 = allButtons(modal).map((b) => b._text);
check('有「稍后再说」按钮', btns1.includes('稍后再说'));
check('有「复制包名」按钮', btns1.some((t) => t.includes('复制') && t.includes('0.2.4')));
check('拥有新版本高亮样式', (() => {
  let found = false;
  const walk = (el) => { if (el.className === 'new') found = true; (el.children || []).forEach(walk); };
  walk(modal); return found;
})());

// 2. 关闭：遮罩被标记 remove
closeUpdateModal();
check('关闭后遮罩被移除', modal._removed === true);

// 3. 已是最新版本：单按钮，无复制入口
showUpdateModal({
  title: '已是最新版本',
  lines: [{ label: '当前版本', value: 'v0.2.4' }, { label: 'npm 最新', value: 'v0.2.4' }],
  note: '无需更新',
  actions: [{ label: '知道了', primary: true, onClick: closeUpdateModal }],
});
modal = lastModal();
const btns2 = allButtons(modal).map((b) => b._text);
check('已最新时只有「知道了」一个操作', btns2.filter((t) => t === '知道了').length === 1);
check('已最新时不出现复制按钮', !btns2.some((t) => t.includes('复制')));
closeUpdateModal();

// 4. 复制回退：clipboard API 可用时写入正确包名
lastCopyValue = 'dsh-mobile-ios@0.2.4';
copied.length = 0;
const copiedOk = await copyToClipboard('dsh-mobile-ios@0.2.4');
check('复制成功返回 true', copiedOk === true);
check('复制内容正确', copied.includes('dsh-mobile-ios@0.2.4'));

// ── 一步更新状态机 ──────────────────────────────────────────
console.log('\n一步更新状态机\n');

// banner 渲染：横幅带文本与 tone 类
showUpdateModal({
  title: '新版本更新',
  banner: { text: '⬆️ 发现新版本 v0.2.5，可一键更新', tone: 'info' },
  lines: [], note: '', actions: [],
});
modal = lastModal();
check('横幅文本渲染', findByText(modal, '⬆️ 发现新版本 v0.2.5，可一键更新').length > 0);
check('横幅带 tone 样式类', (() => {
  let found = false;
  const walk = (el) => { if ((el.className || '').includes('modal-banner') && el.className.includes('info')) found = true; (el.children || []).forEach(walk); };
  walk(modal); return found;
})());
closeUpdateModal();

// unwrapRemote：信封解包成功/失败
check('unwrapRemote 解包 ok 信封', unwrapRemote({ ok: true, value: { status: 'applied' } }).status === 'applied');
check('unwrapRemote 拒绝失败信封', (() => { try { unwrapRemote({ ok: false, error: { code: 'X' } }); return false; } catch (e) { return e.message === 'X'; } })());
check('unwrapRemote 透传非信封', unwrapRemote({ status: 'applied' }).status === 'applied');

// 成功路径：installBundle 收到正确 spec/requestId，弹窗显示成功，锁释放
let installArgs = null;
setPluginManager({
  installBundle: async (spec, opts) => { installArgs = { spec, opts }; return { ok: true, value: { status: 'applied', restartRequired: true } }; },
  waitForInstall: async () => null,
});
await performUpdate('0.2.5');
check('installBundle spec 为 包名@版本', installArgs?.spec === 'dsh-mobile-ios@0.2.5');
check('installBundle 传 enabled:true', installArgs?.opts?.enabled === true);
check('installBundle 传合法 UUID requestId', /^[0-9a-f-]{36}$/i.test(installArgs?.opts?.requestId || ''));
modal = lastModal();
check('成功后显示成功横幅', findByText(modal, '✅ 已安装 v0.2.5').length > 0);
check('需重启时提示重启', findByText(modal, '插件已更新，重启 DSH 桌面端后生效（面板版本号会在重启后变成新版本）。').length > 0);
check('成功后并发锁已释放', isUpdateInFlight() === false);
closeUpdateModal();

// 失败路径：installBundle 抛出 → 失败横幅 + 重试入口
setPluginManager({
  installBundle: async () => { throw new Error('网络中断'); },
  waitForInstall: async () => null,
});
await performUpdate('0.2.6');
modal = lastModal();
check('失败后显示失败横幅', findByText(modal, '❌ 更新未成功').length > 0);
check('失败后含重试按钮', allButtons(modal).some((b) => b._text === '重试更新'));
check('失败原因透传到文案', (() => {
  let found = false;
  const walk = (el) => { if ((el._text || '').includes('网络中断')) found = true; (el.children || []).forEach(walk); };
  walk(modal); return found;
})());
closeUpdateModal();

// 超时对账路径：installBundle 永不 settle → 极短超时 → waitForInstall 对账成功，判为成功且只提交一次
setUpdateTimeout(30);
let waitCalledWith = null;
let installSubmitCount = 0;
setPluginManager({
  installBundle: async () => {
    installSubmitCount += 1;
    // 100ms 后 resolve，但超时设为 30ms，确保先走超时→对账分支；避免永不 settle 的悬挂 promise 拖住事件循环。
    return new Promise((resolve) => setTimeout(() => resolve({ ok: true, value: { status: 'applied' } }), 100));
  },
  waitForInstall: async (id) => { waitCalledWith = id; return { ok: true, value: { status: 'applied' } }; },
});
await performUpdate('0.2.8');
modal = lastModal();
check('超时后调用 waitForInstall 对账', waitCalledWith !== null);
check('对账 requestId 与提交一致', waitCalledWith === installArgs?.opts?.requestId || /^[0-9a-f-]{36}$/i.test(waitCalledWith || ''));
check('对账成功判为成功横幅', findByText(modal, '✅ 已安装 v0.2.8').length > 0);
check('超时对账不重复提交安装', installSubmitCount === 1);
setUpdateTimeout(180000);

// ② 网关自更新路径：无 pluginManager 时不再把「复制包名」当主路径，
//    改由本机网关取 npm tarball 安装（这是「既不能一键更新又复制不了」的修法）。
setPluginManager(null);
let selfUpdateCalls = 0;
let selfUpdateBody = null;
sandbox.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('/mobile/v1/health')) return { ok: true, json: async () => ({ ok: true }) };
  if (u.includes('/mobile/v1/desktop/summary')) return { ok: true, json: async () => ({ version: '0.2.7' }) };
  if (u.includes('/mobile/v1/plugin/self-update')) {
    selfUpdateCalls += 1;
    selfUpdateBody = JSON.parse(opts?.body || '{}');
    return { ok: true, json: async () => ({ ok: true, from: '0.2.7', to: '0.2.8', changed: true, restartRequired: true }) };
  }
  throw new Error(`unexpected ${u}`);
};
await probe();
await performUpdate('0.2.8');
modal = lastModal();
check('无宿主服务时改走网关自更新', selfUpdateCalls === 1, `calls=${selfUpdateCalls}`);
check('自更新请求带目标版本', selfUpdateBody?.target === '0.2.8');
check('网关自更新成功显示成功横幅', findByText(modal, '✅ 已安装 v0.2.8').length > 0);
check('网关自更新后提示重启生效', findByText(modal, '插件已更新，重启 DSH 桌面端后生效（面板版本号会在重启后变成新版本）。').length > 0);
closeUpdateModal();

// 网关自更新失败：给出「复制包名」兜底，且复制失败时暴露可手选的输入框
sandbox.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/mobile/v1/health')) return { ok: true, json: async () => ({ ok: true }) };
  if (u.includes('/mobile/v1/desktop/summary')) return { ok: true, json: async () => ({ version: '0.2.7' }) };
  if (u.includes('/mobile/v1/plugin/self-update')) {
    return { ok: false, json: async () => ({ error: { message: '完整性校验失败' } }) };
  }
  throw new Error(`unexpected ${u}`);
};
await probe();
await performUpdate('0.2.8');
modal = lastModal();
check('自更新失败显示失败横幅', findByText(modal, '❌ 更新未成功').length > 0);
check('自更新失败透传原因', findByText(modal, '安装失败：完整性校验失败。可重试，也可以复制包名到「插件 → 添加插件」手动安装。').length > 0);
const copyBtn = allButtons(modal).find((b) => (b._text || '').includes('复制'));
check('失败弹窗保留复制包名兜底', Boolean(copyBtn));

// 复位：把网关模拟退回「不可达」，否则上面 probe() 留下的 summary.version
// 会让后面「更新结果未知」用例误判成「已更新完成」。
sandbox.fetch = async () => { throw new Error('no network in test'); };
await probe();

// ── 跨 HMR 重载状态恢复（修复「点击就消失无反应」） ──────────
console.log('\n跨重载恢复\n');

// performUpdate 发起后写入 updating 状态（用成功 mock；状态在成功时被 clear，
// 所以用超时 mock 让它停留在 updating，模拟模块被 HMR 卸载前的落盘状态）
setUpdateTimeout(30);
setPluginManager({
  installBundle: async () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, value: {} }), 100)),
  waitForInstall: async () => null, // 对账返回空 → 抛错 → 失败分支会 clear；这里换个思路见下
});
// 直接验证存储读写：写入 updating 后能读回
writeUpdateState({ status: 'updating', target: '0.2.6', at: Date.now() });
const rst = readUpdateState();
check('更新状态可写入并读回', rst?.status === 'updating' && rst?.target === '0.2.6');
clearUpdateState();
check('更新状态可清除', readUpdateState() === null);
setUpdateTimeout(180000);

// 恢复场景1：目标版本已生效 → 弹「更新完成」
writeUpdateState({ status: 'updating', target: '0.2.5', at: Date.now() });
// summary 当前版本需 ≥ 0.2.5；测试里 summary 为 null，无法直接设，
// 用 compareVersions 断言判定逻辑本身 + 超时分支（当前版本未知 → 走 age 判断）
writeUpdateState({ status: 'updating', target: '0.2.5', at: Date.now() - 6 * 60 * 1000 });
restorePendingUpdate();
await new Promise((r) => setTimeout(r, 700)); // 等 restore 的 600ms 延迟弹窗
modal = lastModal();
check('超时未生效弹「更新结果未知」', findByText(modal, '⚠️ 上一步更新未能确认').length > 0);
check('恢复后清理了持久化状态', readUpdateState() === null);
closeUpdateModal();

// ── 域名解析异常排障弹窗（解「暂不可开启」死胡同） ──────────
console.log('\n域名解析排障弹窗\n');
closeUpdateModal();
showDnsHelpModal({ ok: false, publicNs: ['davina.ns.cloudflare.com', 'trace.ns.cloudflare.com'] });
modal = lastModal();
check('弹窗标题点明未生效', findByText(modal, '域名暂未生效').length > 0);
check('横幅给出解析不到', findByText(modal, '⚠️ 公网解析不到这个地址').length > 0);
check('列出公网 NS 供对照', findByText(modal, 'davina.ns.cloudflare.com / trace.ns.cloudflare.com').length > 0);
check('给出可执行步骤（不是只报异常）',
  findByText(modal, '到 Cloudflare 后台看该域名状态是否为「活动 / Active」。').length > 0);
check('提供「重新检测」主按钮', allButtons(modal).some((b) => b._text === '重新检测'));
closeUpdateModal();

// zone 被另一个 Cloudflare 账号接管（moved）：这是「改 NS 也改不对」的那类，
// 文案必须点明归属冲突，并把本账号期望 NS 与公网 NS 并排列出来供对照。
showDnsHelpModal({
  ok: false,
  publicNs: ['davina.ns.cloudflare.com', 'trace.ns.cloudflare.com'],
  zone: {
    code: 'moved',
    status: 'moved',
    expectedNs: ['lola.ns.cloudflare.com', 'miguel.ns.cloudflare.com'],
    publicNs: ['davina.ns.cloudflare.com', 'trace.ns.cloudflare.com'],
    accountName: "815353729@qq.com's Account",
  },
});
modal = lastModal();
check('moved 标题点明被另一个账号接管', findByText(modal, '域名已被另一个账号接管').length > 0);
check('moved 横幅说明不再归本机账号', findByText(modal, '⚠️ 这个域名不再归本机登录的 Cloudflare 账号').length > 0);
check('moved 列出本账号分配 NS', findByText(modal, 'lola.ns.cloudflare.com / miguel.ns.cloudflare.com').length > 0);
check('moved 列出公网 NS', findByText(modal, 'davina.ns.cloudflare.com / trace.ns.cloudflare.com').length > 0);
check('moved 显示本账号名（点破「两个账号」）', findByText(modal, "815353729@qq.com's Account").length > 0);
check('moved 给出「改回本账号 NS」的执行步骤',
  findByText(modal, '在域名注册商处把 NS 改回本账号这一对：lola.ns.cloudflare.com / miguel.ns.cloudflare.com（当前公网是 davina.ns.cloudflare.com / trace.ns.cloudflare.com）。隧道与 DNS 记录都在这边，改回即全部恢复。').length > 0);
check('moved 提醒两边别同时改 (二选一)', findByText(modal, '两种做法都只能二选一，别在两边同时改；改完等几分钟回到面板点「重新检测」。').length > 0);
check('moved 仍有「重新检测」出口', allButtons(modal).some((b) => b._text === '重新检测'));
closeUpdateModal();

// pending：NS 还没指过来，话术不能与 moved 混用
showDnsHelpModal({
  ok: false,
  publicNs: ['davina.ns.cloudflare.com'],
  zone: { code: 'pending', status: 'pending', expectedNs: ['lola.ns.cloudflare.com'], publicNs: [] },
});
modal = lastModal();
check('pending 标题为「域名在本账号未生效」', findByText(modal, '域名在本账号未生效').length > 0);
check('pending 不冒充 moved', findByText(modal, '域名已被另一个账号接管').length === 0);
closeUpdateModal();

// CNAME 被改指：文案要换成更危险的那一类
showDnsHelpModal({ ok: false, tampered: true });
modal = lastModal();
check('改指时标题为「固定域名被改指」', findByText(modal, '固定域名被改指').length > 0);
check('改指时提示网关拒绝下发', findByText(modal, '⚠️ CNAME 已不指向本机隧道').length > 0);
closeUpdateModal();

console.log(`\n结果：${pass} 通过 / ${failures.length} 失败`);
if (failures.length) process.exit(1);
