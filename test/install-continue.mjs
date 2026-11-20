// test/install-continue.mjs — cloudflared 安装确认链路回归测试
//
// 用户诉求：点「安装 cloudflared 并开启远程」→ 确认后应有即时反馈，
// 且安装成功后要自动继续开启远程出码，不能停在「安装完成」让用户再点一次。
// 本套件用最小 DOM stub 走真实链路 apply→面板→主按钮→确认按钮，实测请求与状态流转。

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function makeEl(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(), children: [], className: '', _text: '',
    style: { cssText: '', setProperty() {} }, listeners: {}, id: '', type: '', disabled: false,
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); },
      toggle(c, on) { if (on === undefined) on = !this._set.has(c); on ? this._set.add(c) : this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); this.children = []; },
    append(...els) { for (const e of els) { e._parent = this; this.children.push(e); } },
    remove() { this._removed = true; const i = (this._parent?.children || []).indexOf(this); if (i >= 0) this._parent.children.splice(i, 1); },
    setAttribute(k, v) { this[k] = v; },
    getAttribute(k) { return this[k] || ''; },
    select() {}, focus() {},
    addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    removeEventListener(ev, fn) { if (this.listeners[ev]) this.listeners[ev] = this.listeners[ev].filter((f) => f !== fn); },
    querySelector(sel) { return queryTree(this, sel)[0] || null; },
    querySelectorAll(sel) { return queryTree(this, sel, [], true); },
    click() { if (this.disabled) return; (this.listeners.click || []).slice().forEach((fn) => fn({ target: this, stopPropagation() {} })); },
    replaceChildren(...els) { for (const c of this.children) c._parent = null; this.children = []; for (const e of els) { e._parent = this; this.children.push(e); } },
    insertAdjacentHTML(pos, html) { const d = makeEl(); d._text = html; this.append(d); },
    get innerHTML() { return this._text || ''; },
    set innerHTML(v) { this._text = v; this.children = []; },
    closest(sel) { let cur = this; while (cur) { if (sel.startsWith('.') ? (cur.className || '').split(/\s+/).includes(sel.slice(1)) : cur.tagName === sel.toUpperCase()) return cur; cur = cur._parent; } return null; },
  };
  return el;
}
function queryTree(root, sel, out = [], all = false) {
  for (const c of (root.children || []).slice()) {
    c._parent = root;
    let hit = false;
    if (sel.startsWith('#')) hit = c.id === sel.slice(1);
    else if (sel.startsWith('.')) hit = (c.className || '').split(/\s+/).includes(sel.slice(1));
    else hit = c.tagName === sel.toUpperCase();
    if (hit) { out.push(c); if (!all) return out; }
    queryTree(c, sel, out, all);
    if (out.length && !all) return out;
  }
  return out;
}
function allTexts(root, out = []) {
  if (root._text) out.push(root._text);
  for (const c of root.children || []) allTexts(c, out);
  return out;
}

// ── 构造宿主环境 ──────────────────────────────────────────────
function makeHarness({ installFails = false, installDelay = 0 } = {}) {
  const body = makeEl('body');
  const documentStub = {
    body, head: makeEl('head'), documentElement: makeEl('html'),
    createElement: (t) => makeEl(t),
    getElementById: (id) => queryTree(body, '#' + id)[0] || null,
    addEventListener() {}, removeEventListener() {}, execCommand: () => true,
    querySelector(sel) { return queryTree(body, sel)[0] || null; },
  };
  let captured = null;
  const fetchCalls = [];
  const tunnel = { executable: 'missing', state: 'stopped', canAutoInstall: true, dnsOk: true, provisioned: false };

  const sandbox = {
    window: { matchMedia: () => ({ matches: false }), __ModuleLoader__: { load(mod) { captured = mod; } } },
    document: documentStub,
    navigator: { clipboard: { writeText: async () => {} } },
    console: { log() {}, warn() {}, error() {}, debug() {} },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
    AbortController, AbortSignal,
    fetch: async (url, opts) => {
      fetchCalls.push({ url, method: opts?.method || 'GET' });
      if (url.includes('/health')) return { ok: true, json: async () => ({ ok: true }) };
      if (url.includes('install-cloudflared')) {
        if (installDelay) await new Promise((r) => setTimeout(r, installDelay));
        if (installFails) return { ok: false, json: async () => ({ ok: false, error: { message: '下载失败' } }) };
        tunnel.executable = 'found';
        return { ok: true, json: async () => ({ ok: true, installed: true, executable: 'x', reused: false }) };
      }
      if (url.includes('tunnel/start')) {
        tunnel.state = 'running';
        return { ok: true, json: async () => ({ ok: true, state: 'running', url: 'https://example.trycloudflare.com' }) };
      }
      if (url.includes('/summary')) return { ok: true, json: async () => ({ ok: true, version: '0.2.7', tunnel: { ...tunnel } }) };
      return { ok: true, json: async () => ({ ok: true, code: 'PAIR123', url: 'https://example' }) };
    },
    crypto: { randomUUID: () => '11111111-2222-3333-4444-000000000001' },
    localStorage: (() => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; })(),
    getComputedStyle: () => ({ backgroundColor: 'rgb(20,20,20)' }),
    require: (id) => id === 'react' ? {
      createElement: (tag, props, ...kids) => {
        const el = makeEl(tag);
        for (const [k, v] of Object.entries(props || {})) {
          if (k === 'onClick') el.addEventListener('click', v);
          else if (k === 'className') el.className = v;
          else if (k === 'style') el.style = { ...el.style, ...v };
          else el[k] = v;
        }
        for (const kid of kids) if (kid && kid.tagName) el.append(kid);
        return el;
      },
    } : {},
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), sandbox);
  const mod = captured.factory(sandbox.require);

  let footerRender = null;
  let registeredEl = null;
  const ctx = {
    get: () => null,
    slots: {
      inject: (name, fn) => { footerRender = fn; return () => {}; },
      register: (cfg, renderFn) => { registeredEl = typeof renderFn === 'function' ? renderFn({ wide: true }) : null; return { dispose() {} }; },
    },
  };
  return { mod, ctx, body, documentStub, fetchCalls, tunnel, getTrigger: () => registeredEl, setFooter: () => footerRender?.({ wide: true }) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\ncloudflared 安装确认链路回归\n');

// 1. 成功路径：确认后立即反馈 → 发安装请求 → 自动继续开启远程
{
  const h = makeHarness();
  h.mod.apply(h.ctx);
  await sleep(250);
  h.setFooter();
  h.getTrigger()?.click();
  await sleep(80);
  const mainBtn = h.documentStub.getElementById('dsh-mios-remote-main');
  check('缺依赖时主按钮显示安装文案', (mainBtn?._text || '').includes('安装 cloudflared'));
  mainBtn?.click();
  await sleep(40);
  const bar = queryTree(h.body, '.modal-actions')[0];
  const confirm = bar?.children?.find((b) => (b._text || '').includes('确认下载并安装'));
  check('弹出安装确认框', !!confirm);
  h.fetchCalls.length = 0;
  confirm?.click();
  await sleep(80);
  check('确认后发出安装请求', h.fetchCalls.some((c) => c.url.includes('install-cloudflared') && c.method === 'POST'));
  check('安装完成弹窗出现', allTexts(h.body).some((t) => t.includes('安装完成')));
  await sleep(1200); // 等 900ms 自动继续定时器
  check('安装成功后自动继续开启远程（tunnel/start）', h.fetchCalls.some((c) => c.url.includes('tunnel/start') && c.method === 'POST'));
}

// 2. 失败路径：显示失败弹窗 + 重试入口，不触发自动继续
{
  const h = makeHarness({ installFails: true });
  h.mod.apply(h.ctx);
  await sleep(250);
  h.setFooter();
  h.getTrigger()?.click();
  await sleep(80);
  const mainBtn = h.documentStub.getElementById('dsh-mios-remote-main');
  mainBtn?.click();
  await sleep(40);
  const bar = queryTree(h.body, '.modal-actions')[0];
  const confirm = bar?.children?.find((b) => (b._text || '').includes('确认下载并安装'));
  h.fetchCalls.length = 0;
  confirm?.click();
  await sleep(400);
  check('失败时显示失败弹窗', allTexts(h.body).some((t) => t.includes('安装失败')));
  check('失败时提供重试入口', allTexts(h.body).some((t) => t.includes('重试安装')));
  check('失败时不自动开启远程', !h.fetchCalls.some((c) => c.url.includes('tunnel/start')));
}

// 3. 下载耗时期间保持「正在安装」可见（模拟慢下载）
{
  const h = makeHarness({ installDelay: 300 });
  h.mod.apply(h.ctx);
  await sleep(250);
  h.setFooter();
  h.getTrigger()?.click();
  await sleep(80);
  const mainBtn = h.documentStub.getElementById('dsh-mios-remote-main');
  mainBtn?.click();
  await sleep(40);
  const bar = queryTree(h.body, '.modal-actions')[0];
  const confirm = bar?.children?.find((b) => (b._text || '').includes('确认下载并安装'));
  confirm?.click();
  await sleep(80);
  check('慢下载期间「正在安装」持续可见', allTexts(h.body).some((t) => t.includes('正在安装')));
  await sleep(1500);
  check('慢下载完成后仍能自动继续', h.fetchCalls.some((c) => c.url.includes('tunnel/start')));
}

console.log(`\n结果：${pass} 通过 / ${failures.length} 失败`);
if (failures.length) process.exit(1);
