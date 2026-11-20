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
const sandbox = {
  window: windowStub, document: documentStub, navigator: navigatorStub,
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  AbortSignal, fetch: async () => { throw new Error('no network in test'); },
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
check('测试钩子导出对话框函数', typeof showUpdateModal === 'function' && typeof closeUpdateModal === 'function');

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

console.log(`\n结果：${pass} 通过 / ${failures.length} 失败`);
if (failures.length) process.exit(1);
