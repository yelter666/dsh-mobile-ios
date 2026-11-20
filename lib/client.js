// lib/client.js — 桌面端 UI 注入模块（X3）
//
// 契约（考古自社区 dsh-mobile 0.8.11 的 lib/client.js）：
//   宿主 web app 按包的 `exports["./client"]` 加载本文件，浏览器里执行到
//   `window.__ModuleLoader__.load({ id, factory })` 注册模块；
//   factory 返回的模块需导出 `apply(ctx)` 与 `inject = ["slots"]`，
//   宿主把 slots 服务注入进来，UI 通过 slots 挂载。
//
// 我们挂两个东西：
//   1. 左下角侧栏 banner（slot: sidebar.footer.action）——手机图标 + 「iOS移动伴侣」
//      + 连接状态点；窄栏（rail）只留图标。
//   2. 点击展开的状态面板（原生 DOM overlay，宿主未提供 react-dom）——
//      网关状态 / 适配器 / 已配对设备 / 隧道 / 生成配对码。
//
// 如实边界：网关端口被占会自动顺延（3081–3085 探测）；面板数据来自
// /mobile/v1/desktop/summary（回环-only，无敏感字段），拿不到就明确显示
// 「网关不可达」，绝不编造状态。
window.__ModuleLoader__.load({
	id: 'dsh-mobile-ios',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		let react = require('react');

		// ── 状态 ─────────────────────────────────────────────────────
		const PORT_CANDIDATES = [3081, 3082, 3083, 3084, 3085];
		let gatewayPort = null;
		let summary = null;        // /desktop/summary 结果或 null
		let probing = false;

		function baseUrl() {
			return gatewayPort ? `http://127.0.0.1:${gatewayPort}` : null;
		}

		async function fetchJson(path, options, timeoutMs = 1500) {
			const base = baseUrl();
			if (!base) throw new Error('gateway-not-found');
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			try {
				const res = await fetch(base + path, { ...options, signal: controller.signal });
				const body = await res.json();
				if (!res.ok) throw Object.assign(new Error(body?.error?.message || res.statusText), { body });
				return body;
			} finally {
				clearTimeout(timer);
			}
		}

		/** 探测网关端口（顺延容忍），成功后拉一次摘要 */
		async function probe() {
			if (probing) return;
			probing = true;
			try {
				let found = null;
				for (const port of PORT_CANDIDATES) {
					const controller = new AbortController();
					const timer = setTimeout(() => controller.abort(), 700);
					try {
						const res = await fetch(`http://127.0.0.1:${port}/mobile/v1/health`, { signal: controller.signal });
						if (res.ok) { found = port; break; }
					} catch {} // 端口不是我们/没起，继续探
					finally { clearTimeout(timer); }
				}
				// 必须跟着探到的结果走：只在成功时赋值、失败时清空。
				// 以前失败会保留旧端口，网关换端口后一直去敲那个死端口（若被别的服务
				// 占用还会解析出非 JSON），面板就一直红着。
				gatewayPort = found;
				if (gatewayPort) summary = await fetchJson('/mobile/v1/desktop/summary').catch(() => null);
				else summary = null;
			} finally {
				probing = false;
			}
		}

		/** 面板打开时的轻量刷新：端口已经探到，只拉摘要并重绘，不再重复扫端口。 */
		async function refreshSummary() {
			if (!gatewayPort || summaryFetching) return;
			summaryFetching = true;
			try {
				const next = await fetchJson('/mobile/v1/desktop/summary').catch(() => null);
				if (next?.ok) {
					summary = next;
					renderSummary();
				}
			} finally {
				summaryFetching = false;
			}
		}

		/**
		 * 首屏快速补探。
		 *
		 * 宿主重启时插件先于网关绑端口加载，第一次探测必然落空；
		 * 只靠 15 秒轮询会让面板红着不动，用户看到的就是「插件坏了」。
		 */
		async function probeUntilUp(attempts = 5, delayMs = 1200) {
			for (let i = 0; i < attempts; i += 1) {
				await probe();
				if (summary && summary.ok) return;
				if (i < attempts - 1) await new Promise((resolve) => { setTimeout(resolve, delayMs); });
			}
		}

		/** 生成配对码（本机动作，回环-only 端点）。route 显式选路：'lan' | 'tunnel' | undefined=自动 */
		async function issuePairingCode(route) {
			return fetchJson('/mobile/v1/pairing/code', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ deviceName: '待连接设备', ...(route ? { route } : {}) }),
			}, 2500);
		}

		/** 隧道启停（本机管理面动作，回环-only 端点） */
		/** 单台下线：管理面动作，与出码同样的本机约束，绝不走公网域名。 */
		async function revokeDevice(deviceId) {
			return fetchJson('/mobile/v1/pairing/revoke-device', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ deviceId }),
			}, 2500);
		}

		async function tunnelAction(action) {
			// start 首次会顺带「开通固定地址 + 等公网注册 + DNS 复查」，实测经常超过 20s；
			// 以前 20s 就掐断，用户点第一次报错、点第二次才出码——就是这里太短。
			return fetchJson(`/mobile/v1/tunnel/${action}`, { method: 'POST' }, action === 'start' ? 60000 : 25000);
		}

		// ── 样式 ─────────────────────────────────────────────────────
		const STYLE_ID = 'dsh-mios-style';
		function installStyle() {
			if (document.getElementById(STYLE_ID)) return;
			const style = document.createElement('style');
			style.id = STYLE_ID;
			// 主题跟随宿主：颜色全部走 CSS 变量，.light 类由 detectHostTheme() 动态切换。
			// 以前全硬编码深色，宿主开浅色主题时面板像一块黑补丁（2026-11-18 真机反馈）。
			style.textContent = `
.dsh-mios-trigger { display: inline-flex; align-items: center; gap: 7px; background: none;
  border: none; color: inherit; cursor: pointer; padding: 6px 8px; border-radius: 8px;
  font: inherit; line-height: 1; }
.dsh-mios-trigger:hover { background: rgba(255,255,255,.08); }
.dsh-mios-trigger.is-rail { padding: 8px; }
.dsh-mios-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.dsh-mios-dot.ok { background: #3fb27f; }
.dsh-mios-dot.down { background: #d94f3d; }
.dsh-mios-panel { --bg: #171b24; --fg: #e8eaf0; --muted: #8b93a3; --border: #303a52;
  --border-hover: #4a5678; --shadow: rgba(0,0,0,.5); --fg-soft: rgba(232,234,240,.7);
  --muted-border: rgba(139,147,163,.45); --muted-bg: rgba(139,147,163,.12);
  --muted-bg-hover: rgba(139,147,163,.2); }
.dsh-mios-panel.light { --bg: #ffffff; --fg: #1f2430; --muted: #6b7280; --border: #d9dee8;
  --border-hover: #9aa5bd; --shadow: rgba(31,36,48,.18); --fg-soft: rgba(31,36,48,.7);
  --muted-border: rgba(107,114,128,.4); --muted-bg: rgba(107,114,128,.1);
  --muted-bg-hover: rgba(107,114,128,.18); }
.dsh-mios-panel { position: fixed; left: 14px; bottom: 52px; width: 300px; z-index: 99990;
  background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 14px;
  box-shadow: 0 14px 44px var(--shadow); font: 13px/1.6 -apple-system, "PingFang SC", sans-serif;
  padding: 14px; }
.dsh-mios-panel h3 { margin: 0 0 10px; font-size: 14px; display: flex; align-items: center; gap: 8px; }
.dsh-mios-upd { margin-left: auto; background: none; border: 1px solid var(--border); border-radius: 7px;
  color: var(--muted); font-family: inherit; font-size: 11px; font-weight: 500; line-height: 1.4;
  cursor: pointer; padding: 3px 8px; }
.dsh-mios-upd:hover { color: var(--fg); border-color: var(--border-hover); }
.dsh-mios-modal-mask { --modal-bg:#1c2230; --modal-fg:#e8eaf0; --modal-muted:#8b93a3;
  --modal-border:#3a4560; --modal-btn:rgba(139,147,163,.12); --modal-accent:#3fb27f; --modal-shadow:rgba(0,0,0,.6);
  position:fixed; inset:0; z-index:2147483000; background:var(--modal-shadow);
  display:flex; align-items:center; justify-content:center; padding:20px;
  font-family:-apple-system, "PingFang SC", sans-serif; font-size:13px; line-height:1.6; }
.dsh-mios-modal-mask.light { --modal-bg:#ffffff; --modal-fg:#1f2430; --modal-muted:#6b7280;
  --modal-border:#d9dee8; --modal-btn:rgba(107,114,128,.1); --modal-accent:#2f9d70; --modal-shadow:rgba(31,36,48,.35); }
.dsh-mios-modal { width:100%; max-width:340px; box-sizing:border-box; background:var(--modal-bg);
  color:var(--modal-fg); border:1px solid var(--modal-border); border-radius:14px; padding:18px;
  box-shadow:0 18px 60px var(--modal-shadow); }
.dsh-mios-modal h4 { margin:0 0 12px; font-size:15px; display:flex; align-items:center; gap:8px; }
.dsh-mios-modal .modal-banner { margin:0 0 12px; padding:9px 11px; border-radius:9px; font-size:12px;
  font-weight:600; line-height:1.5; background:rgba(63,178,127,.12); color:var(--modal-accent);
  border:1px solid var(--modal-accent); }
.dsh-mios-modal .modal-banner.success { background:rgba(63,178,127,.16); color:#2f9d70; }
.dsh-mios-modal .modal-banner.warn { background:rgba(224,160,60,.14); color:#d18a26; border-color:#d18a26; }
.dsh-mios-modal .modal-banner.error { background:rgba(217,79,61,.14); color:#d94f3d; border-color:#d94f3d; }
.dsh-mios-modal .modal-x { margin-left:auto; background:none; border:none; color:var(--modal-muted);
  font-size:16px; cursor:pointer; line-height:1; padding:2px 4px; }
.dsh-mios-modal .modal-line { display:flex; justify-content:space-between; gap:10px;
  font-size:12px; color:var(--modal-muted); margin:6px 0; }
.dsh-mios-modal .modal-line b { color:var(--modal-fg); font-weight:600; max-width:200px;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsh-mios-modal .modal-line b.new { color:var(--modal-accent); }
.dsh-mios-modal .modal-note { margin:12px 0 4px; font-size:11px; color:var(--modal-muted); line-height:1.6; }
.dsh-mios-modal .modal-actions { display:flex; gap:8px; margin-top:14px; }
.dsh-mios-modal .modal-actions button { flex:1; padding:8px 0; border-radius:8px; cursor:pointer;
  font-family:inherit; font-size:12px; font-weight:600; line-height:1.4;
  border:1px solid var(--modal-border); background:var(--modal-btn); color:var(--modal-fg); }
.dsh-mios-modal .modal-actions button.primary { border-color:var(--modal-accent);
  background:rgba(63,178,127,.16); color:var(--modal-accent); }
.dsh-mios-modal .modal-actions button:disabled { opacity:.6; cursor:default; }
.dsh-mios-panel .row { display: flex; justify-content: space-between; gap: 8px; color: var(--muted); margin: 3px 0; }
.dsh-mios-panel .row b { color: var(--fg); font-weight: 600; text-align: right; max-width: 170px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-mios-device-toggle { background: none; border: none; color: var(--muted); cursor: pointer;
  font: inherit; padding: 0; display: inline-flex; align-items: center; gap: 5px; }
.dsh-mios-device-toggle:hover { color: var(--fg); }
.dsh-mios-devices { margin: 2px 0 6px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.dsh-mios-devices[hidden] { display: none; }
.dsh-mios-device-row { display: flex; align-items: center; gap: 8px; padding: 5px 10px;
  font-size: 11px; color: var(--muted); border-top: 1px solid var(--border); }
.dsh-mios-device-row:first-child { border-top: none; }
.dsh-mios-device-name { flex: 1; min-width: 0; overflow-wrap: anywhere; white-space: normal;
  line-height: 1.35; color: var(--fg); }
.dsh-mios-device-online { color: #3fb27f; flex: none; }
.dsh-mios-device-offline { color: var(--muted); flex: none; }
.dsh-mios-device-kick { margin-left: auto; background: none; border: 1px solid rgba(217,79,61,.4); border-radius: 4px;
  color: #c97a6d; cursor: pointer; font-family: inherit; font-size: 9px; font-weight: 500;
  line-height: 1.3; padding: 1px 5px; flex: none; }
.dsh-mios-device-kick:hover { color: #d94f3d; border-color: rgba(217,79,61,.7); }
.dsh-mios-devices-empty { padding: 6px 8px; font-size: 11px; color: var(--muted); }
.dsh-mios-panel .pairbtn { width: 100%; margin-top: 10px; padding: 8px 0; border-radius: 9px;
  border: 1px solid rgba(63,178,127,.45); background: rgba(63,178,127,.14); color: #3fb27f;
  font: 600 13px/1.4 inherit-font, sans-serif; cursor: pointer; }
.dsh-mios-panel .pairbtn:disabled { opacity: .5; cursor: default; }
.dsh-mios-banner { border: 1px solid var(--border); border-radius: 10px; padding: 10px 10px 11px; margin-top: 10px; }
.dsh-mios-banner h4 { margin: 0; font-size: 12px; font-weight: 600; color: var(--fg);
  display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.dsh-mios-banner .banner-state { font-size: 11px; font-weight: 400; color: var(--muted);
  max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-mios-banner .banner-guide { margin-top: 4px; font-size: 11px; color: var(--muted); line-height: 1.5; }
.dsh-mios-banner .banner-addr { margin-top: 4px; font-size: 11px; color: var(--muted);
  font-family: ui-monospace, "SF Mono", Menlo, monospace; word-break: break-all; line-height: 1.5; }
.dsh-mios-banner .pairbtn { margin-top: 8px; }
.dsh-mios-banner .tunnelbtn { border-color: var(--muted-border); background: var(--muted-bg); color: var(--muted); }
.dsh-mios-banner .tunnelbtn:hover:not(:disabled) { border-color: var(--fg-soft); color: var(--fg); background: var(--muted-bg-hover); }
.dsh-mios-banner .tunnelbtn:disabled { opacity: .5; cursor: default; }
.dsh-mios-banner .stopbtn { margin-top: 6px; padding: 5px 0; font-weight: 500;
  border-color: rgba(217,79,61,.4); background: none; color: #c97a6d; }
.dsh-mios-banner .stopbtn:hover:not(:disabled) { border-color: rgba(217,79,61,.7); color: #d94f3d; }
.dsh-mios-panel .code { margin-top: 10px; text-align: center; font-size: 30px; letter-spacing: 8px;
  font-weight: 700; color: var(--fg); font-variant-numeric: tabular-nums; }
.dsh-mios-qr { margin-top: 10px; padding: 10px; background: #fff; border-radius: 10px;
  display: flex; justify-content: center; }
.dsh-mios-qr svg { width: 180px; height: 180px; display: block; }
.dsh-mios-panel .err { margin-top: 10px; font-size: 12px; color: #d94f3d; text-align: center; }
.dsh-mios-panel footer { margin-top: 10px; font-size: 11px; color: var(--muted); text-align: center; }
.dsh-mios-close { margin-left: auto; background: none; border: none; color: var(--muted);
  font-size: 16px; cursor: pointer; padding: 2px 6px; }
`;
			document.head.append(style);
		}

		// ── 面板（原生 DOM；宿主无 react-dom） ───────────────────────
		// 双 banner 布局：上面「局域网连接」，下面「远程通道连接」。
		// 远程 banner 是合并后的单一主按钮：没开过→开通；开过没跑→开启并出码；
		// 跑着→直接出码。停止远程是旁边的小按钮，只在该停的时候出现。
		const PANEL_TITLE = 'DSH iOS移动伴侣';
		const BANNER_LABEL = '📱 iOS移动伴侣';
		// 插件更新检查：读 npm registry 的 latest（与「添加插件」安装源同源）。
		// npm 官方源带 CORS *，桌面端 webview 可直接 fetch；npmmirror 作国内备用。
		const PLUGIN_NAME = 'dsh-mobile-ios';
		const PLUGIN_REGISTRIES = [
			'https://registry.npmjs.org',
			'https://registry.npmmirror.com',
		];
		const stripUrl = (u) => String(u || '').replace(/^https?:\/\//, '');
		const stripLocal = (h) => String(h || '').replace(/\.local$/i, '');

		// 宿主插件管理服务（remote.pluginManager）。注入模块经 apply 拿到；
		// 非 Desktop 或老宿主拿不到时保持 null，更新入口降级为「复制包名」手动安装。
		let pluginManager = null;
		let updateInFlight = false; // 一步更新的并发锁：更新中禁止再次触发
		let panelEl = null;
		let tunnelBusy = false;
		const bannerBusy = { lan: false, remote: false };
		let outsideCloser = null;
		let devicesExpanded = false;
		let kickingDeviceId = null;
		// 面板打开期间的摘要刷新：probe() 只更新数据不重绘，正是「扫码后要关掉重开才更新」的根因。
		let summaryPollTimer = null;
		let summaryFetching = false;
		let lastDeviceSignature = null;

		/** 探测宿主主题：显式标记（class/data-theme）→ body 亮度启发 → 系统偏好。
		 *  Electron 宿主切换主题只改页面 class，matchMedia 不一定跟着变，所以三级都查。 */
		function detectHostTheme() {
			const root = document.documentElement;
			const body = document.body;
			const marked = `${root.className} ${body?.className || ''} ${root.getAttribute('data-theme') || ''} ${body?.getAttribute('data-theme') || ''} ${root.getAttribute('data-color-mode') || ''}`.toLowerCase();
			if (/\bdark\b/.test(marked)) return 'dark';
			if (/\blight\b/.test(marked)) return 'light';
			// 亮度启发：宿主页面底色亮就是浅色主题（面板挂在这个页面上，跟它一致最直观）。
			// 全黑或全透明底色不可判，落到系统偏好。
			const bgc = body ? getComputedStyle(body).backgroundColor
				: getComputedStyle(root).backgroundColor;
			const m = bgc.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
			if (m && (+m[1] + +m[2] + +m[3]) > 0) {
				return (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) > 140 ? 'light' : 'dark';
			}
			return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
		}

		/** 面板主题实时跟随宿主：每次渲染都重判（用户可能中途切主题）。 */
		function applyPanelTheme() {
			if (!panelEl) return;
			panelEl.classList.toggle('light', detectHostTheme() === 'light');
		}

		function removePanel() {
			panelEl?.remove();
			panelEl = null;
			closeUpdateModal();
			if (summaryPollTimer) {
				clearInterval(summaryPollTimer);
				summaryPollTimer = null;
			}
			lastDeviceSignature = null;
			if (outsideCloser) {
				document.removeEventListener('pointerdown', outsideCloser);
				outsideCloser = null;
			}
		}

		function row(label, valueId) {
			const div = document.createElement('div');
			div.className = 'row';
			const l = document.createElement('span');
			l.textContent = label;
			const v = document.createElement('b');
			v.id = valueId;
			v.textContent = '—';
			div.append(l, v);
			return div;
		}

		/** 「同时在线设备」行：标签可点开展开在线设备清单，右侧显示 在线/上限。 */
		function deviceRows() {
			const wrap = document.createElement('div');
			const head = document.createElement('div');
			head.className = 'row';
			const toggle = document.createElement('button');
			toggle.className = 'dsh-mios-device-toggle';
			toggle.id = 'dsh-mios-device-toggle';
			toggle.type = 'button';
			toggle.textContent = '▸';
			toggle.setAttribute('aria-label', '展开或收起当前在线设备清单');
			const label = document.createElement('span');
			label.textContent = '同时在线设备(最多5台)';
			const left = document.createElement('span');
			left.append(toggle, label);
			const value = document.createElement('b');
			value.id = 'dsh-mios-devices';
			value.textContent = '—';
			head.append(left, value);
			toggle.addEventListener('click', () => {
				devicesExpanded = !devicesExpanded;
				renderDeviceList();
			});
			const list = document.createElement('div');
			list.className = 'dsh-mios-devices';
			list.id = 'dsh-mios-devices-list';
			list.hidden = true;
			wrap.append(head, list);
			return wrap;
		}

		/** 在线设备清单：默认折叠；只列当前在线设备（同时在线上限 5 台），下线逐台二次确认。 */
		function renderDeviceList() {
			const box = panelEl?.querySelector('#dsh-mios-devices-list');
			if (!box) return;
			box.hidden = !devicesExpanded;
			const toggle = panelEl.querySelector('#dsh-mios-device-toggle');
			if (toggle) toggle.textContent = devicesExpanded ? '▾' : '▸';
			box.replaceChildren();
			if (!summary?.ok) return;
			// 后端已限制活跃设备上限；这里再按在线态筛选并截到 5，保证面板只展示真实并发连接。
			const devices = (summary.pairing?.devices || []).filter((d) => d.online).slice(0, 5);
			if (!devices.length) {
				const empty = document.createElement('div');
				empty.className = 'dsh-mios-devices-empty';
				empty.textContent = '当前没有在线设备';
				box.append(empty);
				return;
			}
			for (const device of devices) {
				const line = document.createElement('div');
				line.className = 'dsh-mios-device-row';
				const name = document.createElement('span');
				name.className = 'dsh-mios-device-name';
				name.textContent = device.deviceName || '未命名设备';
				name.title = name.textContent;
				const state = document.createElement('span');
				state.className = device.online ? 'dsh-mios-device-online' : 'dsh-mios-device-offline';
				state.textContent = device.online ? '在线' : '离线';
				const kick = document.createElement('button');
				kick.className = 'dsh-mios-device-kick';
				kick.textContent = kickingDeviceId === device.deviceId ? '处理中' : '下线';
				kick.disabled = kickingDeviceId !== null;
				kick.title = `将 ${name.textContent} 从这台电脑移除`;
				kick.addEventListener('click', async () => {
					// 二次确认：下线会让那台手机立刻失去读任务的能力，不能误点。
					if (!window.confirm(`确定让「${name.textContent}」下线？该设备需要重新扫码才能再次连接。`)) return;
					kickingDeviceId = device.deviceId;
					renderDeviceList();
					try {
						await revokeDevice(device.deviceId);
						await probe();
					} catch (err) {
						window.alert('下线失败：' + (err?.body?.error?.message || err.message));
					} finally {
						kickingDeviceId = null;
						renderSummary();
					}
				});
				line.append(name, state, kick);
				box.append(line);
			}
		}

		function renderSummary() {
			if (!panelEl) return;
			applyPanelTheme();
			const dot = panelEl.querySelector('#dsh-mios-panel-dot');
			const ok = !!(summary && summary.ok);
			dot.className = 'dsh-mios-dot ' + (ok ? 'ok' : 'down');
			const set = (id, text) => { const el = panelEl.querySelector('#' + id); if (el) el.textContent = text; };
			set('dsh-mios-adapter', ok ? `v${summary.version}` : '—');
			set('dsh-mios-host', ok ? (stripLocal(summary.hostName) || '未上报') : '—');
			if (ok) {
				const max = summary.pairing?.maxDevices ?? 5;
				const online = summary.pairing?.onlineDevices ?? 0;
				set('dsh-mios-devices', `${online}/${max} 台`);
			} else {
				set('dsh-mios-devices', '—');
			}
			// 只有设备名/在线态/顺序变化才重建列表：1.2s 刷新不能让 hover 提示和下线按钮闪烁。
			const devices = ok ? (summary.pairing?.devices || []) : [];
			const signature = devices
				.map((d) => `${d.deviceId}\u0000${d.deviceName || ''}\u0000${d.online ? 1 : 0}`)
				.join('\u0001');
			if (signature !== lastDeviceSignature) {
				lastDeviceSignature = signature;
				renderDeviceList();
			}

			// ── 局域网 banner ──
			const lan = ok ? summary.lan : null;
			const lanState = panelEl.querySelector('#dsh-mios-lan-state');
			if (lanState) lanState.textContent = ok ? (lan ? `电脑地址 ${lan}` : '未获取到局域网地址') : '网关不可达';
			const lanCodeBtn = panelEl.querySelector('#dsh-mios-lan-code');
			if (lanCodeBtn) {
				lanCodeBtn.disabled = !ok || !lan || bannerBusy.lan;
				lanCodeBtn.title = ok && lan ? '' : '网关不可达或没有局域网地址';
			}

			// ── 远程通道 banner ──
			// 四种事实分开说：运行中 / 已开通但没开 / 根本没开通 / 域名没生效。
			// 「域名未生效」必须单列：地址开出来了但公网解析不到，显示「已开通」会误导人去扫码。
			const tunnel = ok ? summary.tunnel : null;
			const dnsBroken = tunnel && tunnel.dnsOk === false;
			const running = !!(tunnel && tunnel.state === 'running' && !dnsBroken);
			const remoteState = panelEl.querySelector('#dsh-mios-remote-state');
			if (remoteState) {
				remoteState.textContent = !tunnel
					? '—'
					: dnsBroken
						? '解析异常 · 未开启'
						: running
							? '已开启'
							: tunnel.provisioned && tunnel.fixedUrl
								? '已开通 · 未开启'
								: tunnel.mode === 'named' ? '未开通固定地址' : tunnel.state;
			}
			// 固定地址独占一行完整显示，不再和状态词挤在一起被省略号截断
			const remoteAddr = panelEl.querySelector('#dsh-mios-remote-addr');
			if (remoteAddr) {
				const addr = tunnel && (tunnel.fixedUrl || tunnel.url);
				remoteAddr.textContent = tunnel && tunnel.provisioned ? stripUrl(addr) : '—';
				// 默认色交给 CSS 变量（跟随主题）；只有解析异常时才覆盖成红色
				remoteAddr.style.color = dnsBroken ? '#d94f3d' : '';
			}
			const mainBtn = panelEl.querySelector('#dsh-mios-remote-main');
			if (mainBtn) {
				// 出码态走绿色主按钮；开启态走灰色次按钮（悬浮变白），视觉上分清两件事
				mainBtn.className = 'pairbtn' + (running || dnsBroken ? '' : ' tunnelbtn');
				mainBtn.style.display = tunnel && tunnel.state !== 'disabled' ? '' : 'none';
				mainBtn.disabled = tunnelBusy || bannerBusy.remote || dnsBroken;
				const needsInstall = tunnel.executable === 'missing';
				mainBtn.textContent = needsInstall && tunnel.canAutoInstall
					? '安装 cloudflared 并开启远程'
					: dnsBroken
						? '域名解析异常，暂不可开启'
						: running
							? (bannerBusy.remote ? '生成中…' : '生成配对码（远程）')
							: tunnel.mode === 'named'
								? (tunnel.provisioned ? '开启远程并生成配对码' : '开启远程（分配固定地址）')
								: '启动隧道（外网连接）';
			}
			const stopBtn = panelEl.querySelector('#dsh-mios-remote-stop');
			if (stopBtn) {
				// 停止按钮只在该停的时候出现：没开过/没在跑都没有「停」可言
				stopBtn.style.display = running && !tunnelBusy ? '' : 'none';
				stopBtn.disabled = tunnelBusy;
			}
			// 远程码跟着可用性走：不是 running 就收起（与「停止即收码」同一语义，
			// 兜住任何没经过停止按钮的路径，比如进程意外退出）。
			if (!running && !bannerBusy.remote) {
				panelEl.querySelector('#dsh-mios-remote-main')?.closest('.dsh-mios-banner')
					?.querySelectorAll('.dsh-mios-code-slot, .err').forEach((e) => e.remove());
			}

			// 提示行承载告警与错误：warning 优先，其次是 tunnel.error。
			// 以前只读 warning，服务端明确报的 error（如「主机未安装 cloudflared」）
			// 被 1.2s 一次的刷新瞬间清空，用户点了按钮只看到一闪而过、误以为「无反应」。
			const hint = panelEl.querySelector('#dsh-mios-hint');
			if (hint) {
				const t = ok ? summary.tunnel : null;
				const msg = t?.warning || t?.error || null;
				hint.textContent = msg ? `⚠️ ${msg}` : '';
				hint.style.color = t?.error && !t?.warning ? '#d94f3d' : '#e0a03c';
				hint.style.display = msg ? '' : 'none';
			}
		}

		/** 双 banner 里的一块：标题 + 状态行 + 指引一句 + 内容区 */
		function bannerBox(title, stateId, guideText) {
			const box = document.createElement('div');
			box.className = 'dsh-mios-banner';
			const head = document.createElement('h4');
			head.textContent = title;
			const state = document.createElement('span');
			state.className = 'banner-state';
			state.id = stateId;
			state.textContent = '—';
			head.append(state);
			const guide = document.createElement('div');
			guide.className = 'banner-guide';
			guide.textContent = guideText;
			box.append(head, guide);
			return box;
		}

		/** 出码结果挂进所属 banner：QR + 码 + 地址说明（同一 banner 只保留最新一码） */
		function mountCode(banner, issued) {
			banner.querySelectorAll('.dsh-mios-code-slot').forEach((e) => e.remove());
			const slot = document.createElement('div');
			slot.className = 'dsh-mios-code-slot';
			if (issued.qrSvg) {
				const qr = document.createElement('div');
				qr.className = 'dsh-mios-qr';
				qr.innerHTML = issued.qrSvg;
				slot.append(qr);
			}
			const code = document.createElement('div');
			code.className = 'code';
			code.textContent = issued.code;
			const addr = document.createElement('div');
			addr.style.cssText = 'margin-top:6px;text-align:center;font-size:12px;color:#3fb27f;';
			addr.textContent = issued.route === 'tunnel'
				? `扫码连接 · 公网固定地址 ${stripUrl(issued.address)}`
				: issued.address
					? `扫码连接 · 局域网 ${issued.address}`
					: '手机填电脑局域网地址 + 此码';
			slot.append(code, addr);
			banner.append(slot);
		}

		/** banner 内的出码按钮统一行为：busy → 出码 → 失败在 banner 内显错 */
		function bindCodeBtn(btn, banner, route) {
			btn.addEventListener('click', async () => {
				if (bannerBusy[route]) return;
				bannerBusy[route] = true;
				btn.disabled = true;
				btn.textContent = '生成中…';
				try {
					mountCode(banner, await issuePairingCode(route));
				} catch (err) {
					banner.querySelectorAll('.dsh-mios-code-slot').forEach((e) => e.remove());
					const errEl = document.createElement('div');
					errEl.className = 'err';
					errEl.textContent = '生成失败：' + (err?.body?.error?.message || err.message);
					banner.append(errEl);
				} finally {
					bannerBusy[route] = false;
					btn.textContent = '重新生成配对码';
					renderSummary();
				}
			});
		}

		function showPanel() {
			if (panelEl) return;
			// 打开期间持续轻量刷新：扫码上线、改名、下线都能立刻反映，无需关掉重开。
			if (summaryPollTimer) clearInterval(summaryPollTimer);
			summaryPollTimer = setInterval(refreshSummary, 1200);
			installStyle();
			panelEl = document.createElement('div');
			panelEl.className = 'dsh-mios-panel';

			const header = document.createElement('h3');
			const dot = document.createElement('span');
			dot.id = 'dsh-mios-panel-dot';
			dot.className = 'dsh-mios-dot down';
			const title = document.createElement('span');
			title.textContent = PANEL_TITLE;
			// 插件更新：放在关闭按钮左边，点击弹出更新对话框（版本对比 + 更新与否由用户选）
			const updBtn = document.createElement('button');
			updBtn.className = 'dsh-mios-upd';
			updBtn.textContent = '插件更新';
			updBtn.addEventListener('click', () => {
				// 点击务必先有可见反馈再联网，避免「无反应」错觉（缓存旧模块时旧逻辑写已移除的内联元素）。
				try { checkPluginUpdate(); } catch (e) {
					console.error('[dsh-mobile-ios] checkPluginUpdate failed:', e);
					showUpdateModal({ title: '插件更新', lines: [], note: `打开更新检查失败：${e?.message || e}`, actions: [{ label: '知道了', primary: true, onClick: closeUpdateModal }] });
				}
			});
			const close = document.createElement('button');
			close.className = 'dsh-mios-close';
			close.textContent = '✕';
			close.setAttribute('aria-label', '关闭面板');
			close.addEventListener('click', removePanel);
			header.append(dot, title, updBtn, close);

			const body = document.createElement('div');
			body.append(
				row('插件版本', 'dsh-mios-adapter'),
				row('电脑名称', 'dsh-mios-host'),
				deviceRows(),
			);

			// ── banner 1：局域网连接（在家 · 直连 · 始终可用） ──
			const lanBanner = bannerBox('局域网连接', 'dsh-mios-lan-state', '手机与电脑连同一个 Wi-Fi，直连不走外网。适合在家日常用。');
			const lanCodeBtn = document.createElement('button');
			lanCodeBtn.className = 'pairbtn';
			lanCodeBtn.id = 'dsh-mios-lan-code';
			lanCodeBtn.textContent = '生成配对码';
			bindCodeBtn(lanCodeBtn, lanBanner, 'lan');
			lanBanner.append(lanCodeBtn);

			// ── banner 2：远程通道连接（出门 · 固定域名 · 一个主按钮走完） ──
			// 「开启远程」与「生成配对码」合并成一个主按钮：没开过→开通；
			// 开过没跑→开启并出码；跑着→直接出码。停止是旁边的小按钮。
			const remoteBanner = bannerBox('远程通道连接', 'dsh-mios-remote-state', '出门在外扫码连固定域名，电脑和手机不必在同一网络。');
			const remoteAddr = document.createElement('div');
			remoteAddr.id = 'dsh-mios-remote-addr';
			remoteAddr.className = 'banner-addr';
			remoteAddr.textContent = '—';
			remoteBanner.append(remoteAddr);
			const mainBtn = document.createElement('button');
			mainBtn.className = 'pairbtn';
			mainBtn.id = 'dsh-mios-remote-main';
			mainBtn.textContent = '开启远程并生成配对码';
			mainBtn.addEventListener('click', () => remoteMainAction(remoteBanner));
			const stopBtn = document.createElement('button');
			stopBtn.className = 'pairbtn stopbtn';
			stopBtn.id = 'dsh-mios-remote-stop';
			stopBtn.textContent = '停止远程';
			stopBtn.addEventListener('click', stopRemoteAction);
			remoteBanner.append(mainBtn, stopBtn);

			const hint = document.createElement('div');
			hint.id = 'dsh-mios-hint';
			hint.style.cssText = 'margin-top:8px;font-size:11px;color:#e0a03c;line-height:1.5;';
			hint.style.display = 'none';

			const footer = document.createElement('footer');
			footer.textContent = 'iPhone/iPad App → 连接 → 扫码（约 2 分钟有效）';

			panelEl.append(header, body, lanBanner, remoteBanner, hint, footer);
			document.body.append(panelEl);
			applyPanelTheme();
			placePanelAboveTrigger();
			renderSummary();
			probe();

			// 点击面板/触发 banner 以外的任意区域即关闭（✕ 之外的第二条路）
			outsideCloser = (ev) => {
				if (!panelEl) return;
				const t = ev.target;
				if (panelEl.contains(t) || (t.closest && t.closest('.dsh-mios-trigger'))) return;
				removePanel();
			};
			document.addEventListener('pointerdown', outsideCloser);
		}

		/** 面板底边对齐触发 banner 顶边：不遮挡 banner，屏幕放不下就整体上推并内滚。 */
		function placePanelAboveTrigger() {
			const trigger = document.querySelector('.dsh-mios-trigger');
			if (trigger) {
				const rect = trigger.getBoundingClientRect();
				panelEl.style.left = `${Math.max(10, Math.round(rect.left))}px`;
				panelEl.style.bottom = `${Math.max(10, Math.round(window.innerHeight - rect.top + 8))}px`;
			}
			panelEl.style.maxHeight = 'min(72vh, 640px)';
			panelEl.style.overflowY = 'auto';
		}

		/** 更新检查：与「添加插件」同源，读 npm registry 的 latest 比对当前版本。
		 *  404 = 包未发布（本地开发版）；网络失败 = 如实报不可达，二者不混为一谈。 */
		/** 更新对话框：显示版本对比，更新与否由用户选；随面板销毁清理。 */
		let updateModal = null;
		function closeUpdateModal() {
			updateModal?.remove();
			updateModal = null;
		}
		function showUpdateModal({ title, banner, lines, note, actions }) {
			closeUpdateModal();
			const mask = document.createElement('div');
			mask.className = 'dsh-mios-modal-mask';
			if (detectHostTheme() === 'light') mask.classList.add('light');
			const box = document.createElement('div');
			box.className = 'dsh-mios-modal';

			const h = document.createElement('h4');
			h.textContent = title;
			const x = document.createElement('button');
			x.className = 'modal-x';
			x.textContent = '✕';
			x.setAttribute('aria-label', '关闭');
			x.addEventListener('click', closeUpdateModal);
			h.append(x);
			box.append(h);

			// banner：一步更新流程的状态横幅（发现新版 / 更新中 / 成功 / 失败）
			if (banner) {
				const b = document.createElement('div');
				b.className = `modal-banner${banner.tone ? ' ' + banner.tone : ''}`;
				b.textContent = banner.text;
				box.append(b);
			}

			for (const line of lines || []) {
				const row = document.createElement('div');
				row.className = 'modal-line';
				const label = document.createElement('span');
				label.textContent = line.label;
				const value = document.createElement('b');
				value.textContent = line.value;
				if (line.highlight) value.className = 'new';
				row.append(label, value);
				box.append(row);
			}
			if (note) {
				const n = document.createElement('div');
				n.className = 'modal-note';
				n.textContent = note;
				box.append(n);
			}

			const bar = document.createElement('div');
			bar.className = 'modal-actions';
			for (const action of actions || []) {
				const btn = document.createElement('button');
				btn.textContent = action.label;
				if (action.primary) btn.className = 'primary';
				btn.addEventListener('click', () => action.onClick?.(btn));
				bar.append(btn);
			}
			box.append(bar);
			mask.append(box);
			mask.addEventListener('click', (e) => { if (e.target === mask) closeUpdateModal(); });
			document.body.append(mask);
			updateModal = mask;
		}

		/** 复制文本：clipboard API 不可用时回退到 textarea + execCommand。 */
		async function copyToClipboard(text) {
			try {
				if (navigator.clipboard?.writeText) {
					await navigator.clipboard.writeText(text);
					return true;
				}
			} catch { /* 落到下面的回退 */ }
			try {
				const ta = document.createElement('textarea');
				ta.value = text;
				ta.style.position = 'fixed';
				ta.style.opacity = '0';
				document.body.append(ta);
				ta.select();
				const ok = document.execCommand('copy');
				ta.remove();
				return ok;
			} catch {
				return false;
			}
		}

		async function checkPluginUpdate() {
			showUpdateModal({ title: '插件更新', lines: [], note: '正在检查更新…', actions: [] });
			const current = summary?.version || '未知';
			let latest = '';
			let sawNotFound = false;
			let lastError = null;
			for (const base of PLUGIN_REGISTRIES) {
				try {
					const res = await fetch(`${base}/${PLUGIN_NAME}/latest`, { signal: AbortSignal.timeout(6000) });
					if (res.status === 404) { sawNotFound = true; continue; }
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					const meta = await res.json();
					if (meta?.version) { latest = String(meta.version); break; }
				} catch (e) {
					lastError = e;
				}
			}
			if (!latest) {
				showUpdateModal({
					title: '插件更新',
					lines: [{ label: '当前版本', value: `v${current}` }],
					note: sawNotFound
						? '插件尚未发布到 npm，当前为本地开发版。更新方式：拉取仓库最新代码后重启 DSH 桌面端，插件会随源码热重载。'
						: `更新源暂不可达${lastError ? `（${lastError.message}）` : ''}，无法确认是否有新版本。`,
					actions: [{ label: '知道了', primary: true, onClick: closeUpdateModal }],
				});
				return;
			}
			if (compareVersions(latest, current) > 0) {
				// 一步更新：宿主提供 pluginManager 时直接安装，无需复制包名手动添加。
				const canAuto = !!(pluginManager && typeof pluginManager.installBundle === 'function');
				const actions = [{ label: '稍后再说', onClick: closeUpdateModal }];
				if (canAuto) {
					actions.push({
						label: `立即更新到 v${latest}`, primary: true,
						onClick: () => performUpdate(latest),
					});
				} else {
					// 降级：拿不到宿主安装服务（老宿主 / 非 Desktop），保留复制包名手动安装。
					actions.push({
						label: `复制 ${PLUGIN_NAME}@${latest}`, primary: true,
						onClick: async (btn) => {
							const ok = await copyToClipboard(`${PLUGIN_NAME}@${latest}`);
							btn.textContent = ok ? '已复制，去插件页粘贴安装' : '复制失败，请手动复制包名';
						},
					});
				}
				showUpdateModal({
					title: '新版本更新',
					banner: { text: `⬆️ 发现新版本 v${latest}，可一键更新`, tone: 'info' },
					lines: [
						{ label: '当前版本', value: `v${current}` },
						{ label: '最新版本', value: `v${latest}`, highlight: true },
					],
					note: canAuto
						? '点击「立即更新」将由 DSH 安装器一步完成，更新中请勿关闭窗口。是否更新由你决定。'
						: '当前宿主未提供一步更新能力，请复制包名到 DSH「插件 → 添加插件」粘贴安装。',
					actions,
				});
			} else {
				showUpdateModal({
					title: '已是最新版本',
					lines: [
						{ label: '当前版本', value: `v${current}` },
						{ label: 'npm 最新', value: `v${latest}` },
					],
					note: '当前版本已是最新，无需更新。',
					actions: [{ label: '知道了', primary: true, onClick: closeUpdateModal }],
				});
			}
		}

		/** 一步更新：经宿主 pluginManager.installBundle 安装 npm spec，
		 *  状态机覆盖 更新中 / 成功 / 失败 / 超时对账 / 重复点击。 */
		let UPDATE_TIMEOUT_MS = 180000; // pnpm 安装 + 可能的重启，给足 3 分钟
		function unwrapRemote(result) {
			if (result && typeof result === 'object' && Object.hasOwn(result, 'ok')) {
				if (!result.ok) throw new Error(result.error?.code || result.error?.message || '宿主返回失败');
				return result.value;
			}
			return result;
		}
		function withTimeout(promise, ms, label) {
			return new Promise((resolve, reject) => {
				let settled = false;
				const timer = setTimeout(() => {
					if (settled) return;
					settled = true;
					reject(new Error(`${label}超时（${Math.round(ms / 1000)} 秒）`));
				}, ms);
				Promise.resolve(promise).then(
					(v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } },
					(e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } },
				);
			});
		}

		// ── 跨 HMR 重载的更新状态持久化 ─────────────────────────────
		// 更新「自己」会触发宿主卸载本模块并加载新版，当前 JS 上下文连同弹窗一起销毁。
		// 因此发起更新前把状态写入 localStorage，新模块 apply 时读取并给出结果反馈，
		// 避免出现「点一下弹窗消失、什么都没发生」的体验。
		const UPDATE_STATE_KEY = 'dsh-mios-update-state';
		function readUpdateState() {
			try {
				const raw = globalThis.localStorage?.getItem(UPDATE_STATE_KEY);
				return raw ? JSON.parse(raw) : null;
			} catch { return null; }
		}
		function writeUpdateState(state) {
			try { globalThis.localStorage?.setItem(UPDATE_STATE_KEY, JSON.stringify(state)); }
			catch { /* 存储不可用时静默，功能降级但不崩 */ }
		}
		function clearUpdateState() {
			try { globalThis.localStorage?.removeItem(UPDATE_STATE_KEY); }
			catch { /* 同上 */ }
		}
		/** apply 时调用：若上次更新尚未收尾，依据当前版本推断结果并弹窗告知。 */
		function restorePendingUpdate() {
			const st = readUpdateState();
			if (!st || st.status !== 'updating' || !st.target) return;
			const current = String(summary?.version || '').trim();
			const age = Date.now() - (st.at || 0);
			if (current && compareVersions(current, st.target) >= 0) {
				clearUpdateState();
				// 延迟到面板初次渲染后再弹，避免被 apply 后续的初始化覆盖
				setTimeout(() => showUpdateModal({
					title: '更新完成',
					banner: { text: `✅ 已更新到 v${st.target}`, tone: 'success' },
					lines: [{ label: '当前版本', value: `v${current}` }],
					note: '插件已更新并重新加载完成。',
					actions: [{ label: '知道了', primary: true, onClick: closeUpdateModal }],
				}), 600);
			} else if (age > 5 * 60 * 1000) {
				clearUpdateState();
				setTimeout(() => showUpdateModal({
					title: '更新结果未知',
					banner: { text: '⚠️ 上一步更新未能确认', tone: 'warn' },
					lines: [{ label: '目标版本', value: `v${st.target}` }, { label: '当前版本', value: current ? `v${current}` : '未知' }],
					note: '更新过程被中断或耗时过长。请到「插件」页确认当前版本，必要时手动更新。',
					actions: [{ label: '知道了', primary: true, onClick: closeUpdateModal }],
				}), 600);
			}
			// 未超时且版本未变：保持 updating 状态，等下次 apply（轮询重载）再判断
		}
		async function performUpdate(latest) {
			// 重复点击保护：更新中直接忽略再次触发
			if (updateInFlight) return;
			if (!pluginManager || typeof pluginManager.installBundle !== 'function') {
				showUpdateModal({
					title: '更新不可用',
					banner: { text: '⚠️ 宿主未提供一步更新能力', tone: 'warn' },
					lines: [],
					note: '请复制包名，到 DSH「插件 → 添加插件」粘贴安装。',
					actions: [
						{ label: '知道了', onClick: closeUpdateModal },
						{ label: `复制 ${PLUGIN_NAME}@${latest}`, primary: true, onClick: async (btn) => {
							const ok = await copyToClipboard(`${PLUGIN_NAME}@${latest}`);
							btn.textContent = ok ? '已复制' : '复制失败';
						} },
					],
				});
				return;
			}
			updateInFlight = true;
			const current = summary?.version || '未知';
			const spec = `${PLUGIN_NAME}@${latest}`;
			// 先持久化「更新中」，确保 HMR 卸载本模块后新实例能恢复出结果反馈。
			writeUpdateState({ status: 'updating', target: String(latest), at: Date.now() });
			// 状态：更新中。无取消/关闭动作外的操作按钮，防重复点击。
			showUpdateModal({
				title: '正在更新',
				banner: { text: `⏳ 正在更新到 v${latest}，请稍候`, tone: 'info' },
				lines: [
					{ label: '当前版本', value: `v${current}` },
					{ label: '目标版本', value: `v${latest}`, highlight: true },
				],
				note: '正在通过 DSH 安装器更新，可能需要 1–3 分钟。请勿重复点击或关闭窗口。',
				actions: [],
			});
			let requestId;
			try {
				requestId = globalThis.crypto?.randomUUID?.();
				if (typeof requestId !== 'string') throw new Error('无法生成更新请求 ID');
				let result;
				try {
					result = await withTimeout(
						pluginManager.installBundle(spec, { enabled: true, requestId }),
						UPDATE_TIMEOUT_MS, '安装',
					);
				} catch (err) {
					// 超时/结果未知：用 requestId 对账，绝不重复提交安装
					if (typeof pluginManager.waitForInstall === 'function') {
						const recovered = await withTimeout(pluginManager.waitForInstall(requestId), 60000, '结果对账');
						if (!recovered) throw err;
						result = recovered;
					} else throw err;
				}
				const value = unwrapRemote(result);
				const restart = !!(value && (value.restartRequired || value.restart));
				clearUpdateState(); // 安装器已返回结果，交由本弹窗反馈，无需跨重载恢复
				// 状态：成功
				showUpdateModal({
					title: '更新完成',
					banner: { text: `✅ 已安装 v${latest}`, tone: 'success' },
					lines: [
						{ label: '目标版本', value: `v${latest}` },
					],
					note: restart
						? '插件已更新，重启 DSH 桌面端后生效。'
						: '插件已更新。若面板未刷新，重开面板或重启 DSH 即可。',
					actions: [{ label: '知道了', primary: true, onClick: closeUpdateModal }],
				});
			} catch (err) {
				// 状态：失败（保留重试入口；重试会重新走一遍锁与状态机）
				clearUpdateState();
				showUpdateModal({
					title: '更新失败',
					banner: { text: '❌ 更新未成功', tone: 'error' },
					lines: [{ label: '目标版本', value: `v${latest}` }],
					note: `安装失败：${err?.message || String(err)}。可重试，或复制包名到「插件 → 添加插件」手动安装。`,
					actions: [
						{ label: '关闭', onClick: closeUpdateModal },
						{ label: '重试更新', primary: true, onClick: () => performUpdate(latest) },
					],
				});
			} finally {
				updateInFlight = false;
			}
		}

		function compareVersions(a, b) {
			const parse = (s) => String(s || '').replace(/^v/i, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
			const [pa, pb] = [parse(a), parse(b)];
			for (let i = 0; i < 3; i += 1) {
				if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
			}
			return 0;
		}

		/** 等 summary 反映出「远程已可用」：服务端 start 会等到注册成功才返回，
		 *  但客户端超时/轮询窗口内可能还没看到，这里统一补轮询兜底。 */
		async function waitForTunnelUp(attempts = 8, delayMs = 1500) {
			for (let i = 0; i < attempts; i += 1) {
				await probe();
				renderSummary();
				const t = summary?.tunnel;
				if (t && t.state === 'running' && t.dnsOk !== false) return true;
				if (i < attempts - 1) await new Promise((resolve) => { setTimeout(resolve, delayMs); });
			}
			return false;
		}

		/** 自举安装 cloudflared：先弹窗征得同意，确认后经网关从官方源下载到私有目录。
		 *  安装成功即重探状态（发现链已含组件目录），让本次点击继续走开启远程。 */
		let installBusy = false;
		let installBanner = null;      // 保存触发安装的 banner，供成功后自动继续出码（onClick 只传按钮，不传 banner）
		let autoContinueTimer = null;  // 安装成功后延迟自动出码的定时器，允许手动「立即开启」取消
		async function installCloudflaredAction(banner) {
			if (installBusy) return;
			installBusy = true;
			installBanner = banner || null;
			try {
				showUpdateModal({
					title: '安装 cloudflared',
					banner: { text: '⬇️ 远程通道需要 cloudflared', tone: 'info' },
					lines: [
						{ label: '来源', value: 'Cloudflare 官方发布' },
						{ label: '安装位置', value: '本机私有目录（不改系统设置）' },
					],
					note: '将从 Cloudflare 官方发布地址下载 cloudflared 到本机，仅用于远程通道。下载期间请保持网络畅通，是否继续？',
					actions: [
						{ label: '取消', onClick: () => { installBanner = null; closeUpdateModal(); } },
						{ label: '确认下载并安装', primary: true, onClick: () => runInstall() },
					],
				});
			} finally {
				installBusy = false;
			}
		}

		// 安装成功后接着走「确保隧道起来 → 出码」。抽出来供安装链与手动链共用，
		// 避免「装完只弹提示、还得再点一次」的伪无反应。
		async function continueRemoteAfterInstall() {
			const banner = installBanner;
			installBanner = null;
			await remoteMainAction(banner);
		}

		async function runInstall() {
			if (installBusy) return;
			installBusy = true;
			const mainBtn = panelEl?.querySelector('#dsh-mios-remote-main');
			if (mainBtn) { mainBtn.textContent = '安装中…'; mainBtn.disabled = true; }
			// 先把确认框换成「正在安装」——用户点确认后立即有可见反馈，不进入静默等待。
			showUpdateModal({
				title: '正在安装',
				banner: { text: '⏳ 正在下载 cloudflared，请稍候', tone: 'info' },
				lines: [],
				note: '首次下载约几十 MB，取决于网速，请耐心等待，不要关闭窗口。',
				actions: [],
			});
			let succeeded = false;
			try {
				const res = await fetchJson('/mobile/v1/tunnel/install-cloudflared', { method: 'POST' }, 240000);
				await probe();
				renderSummary();
				const nowFound = summary?.tunnel?.executable === 'found';
				if (!nowFound) throw new Error('安装完成但网关尚未识别到 cloudflared，请重开面板重试');
				succeeded = true;
				showUpdateModal({
					title: '安装完成',
					banner: { text: '✅ cloudflared 已就绪，正在开启远程…', tone: 'success' },
					lines: [],
					note: res?.reused ? '本机已有 cloudflared，无需重复下载。正在为你开启远程并出码。' : 'cloudflared 已安装。正在为你开启远程并出码。',
					actions: [{ label: '立即开启远程', primary: true, onClick: () => { if (autoContinueTimer) { clearTimeout(autoContinueTimer); autoContinueTimer = null; } closeUpdateModal(); continueRemoteAfterInstall(); } }],
				});
			} catch (err) {
				showUpdateModal({
					title: '安装失败',
					banner: { text: '❌ 未能自动安装', tone: 'error' },
					lines: [],
					note: `${err?.body?.error?.message || err?.message || String(err)}。可检查网络后重试，或按提示手动安装 cloudflared。`,
					actions: [
						{ label: '关闭', onClick: closeUpdateModal },
						{ label: '重试安装', primary: true, onClick: () => runInstall() },
					],
				});
			} finally {
				installBusy = false;
				renderSummary();
				// 关键修复：安装成功后自动继续出码，无需用户再点一次主按钮。
				if (succeeded) {
					if (autoContinueTimer) clearTimeout(autoContinueTimer);
					autoContinueTimer = setTimeout(() => {
						autoContinueTimer = null;
						closeUpdateModal();
						continueRemoteAfterInstall();
					}, 900);
				}
			}
		}

		/** 远程主按钮：一条动作链走完「确保在跑 → 出码」。一次点击出码，绝不让人点两下。 */
		async function remoteMainAction(banner) {
			if (tunnelBusy || bannerBusy.remote || installBusy) return;
			const mainBtn = panelEl?.querySelector('#dsh-mios-remote-main');
			// 缺依赖且平台可自动装：先走安装确认，装完再继续开启（避免点了必然失败的 start）
			if (summary?.tunnel?.executable === 'missing' && summary?.tunnel?.canAutoInstall) {
				installCloudflaredAction(banner);
				return;
			}
			const running = summary?.tunnel?.state === 'running' && summary?.tunnel?.dnsOk !== false;
			try {
				if (!running) {
					tunnelBusy = true;
					if (mainBtn) mainBtn.textContent = '开启中…';
					let startErr = null;
					try {
						await tunnelAction('start');
					} catch (err) {
						// 客户端超时 ≠ 服务端失败：cloudflared 可能还在注册路上。
						// 不直接报错收场，继续轮询等它真的起来（或确认起不来）。
						startErr = err;
					}
					const up = await waitForTunnelUp();
					if (!up) {
						// 真没起来才报错；错误信息优先用服务端带回来的
						const t = summary?.tunnel;
						const msg = startErr?.body?.error?.message
							|| (t?.dnsOk === false ? '固定域名尚未在公网生效，请稍后再试' : null)
							|| startErr?.message || '远程通道未能开启';
						throw Object.assign(new Error(msg), { body: startErr?.body });
					}
				}
				bannerBusy.remote = true;
				if (mainBtn) mainBtn.textContent = '生成中…';
				mountCode(banner, await issuePairingCode('tunnel'));
			} catch (err) {
				const hint = panelEl?.querySelector('#dsh-mios-hint');
				if (hint) {
					hint.textContent = `⚠️ ${err?.body?.error?.message || err.message}`;
					hint.style.display = '';
					hint.style.color = '#d94f3d';
				}
			} finally {
				tunnelBusy = false;
				bannerBusy.remote = false;
				renderSummary();
			}
		}

		async function stopRemoteAction() {
			if (tunnelBusy) return;
			tunnelBusy = true;
			const stopBtn = panelEl?.querySelector('#dsh-mios-remote-stop');
			if (stopBtn) stopBtn.textContent = '停止中…';
			try {
				await tunnelAction('stop');
			} catch (err) {
				const hint = panelEl?.querySelector('#dsh-mios-hint');
				if (hint) {
					hint.textContent = `⚠️ ${err?.body?.error?.message || err.message}`;
					hint.style.display = '';
					hint.style.color = '#d94f3d';
				}
			}
			// 停止即收码：远程关了，码还挂在屏幕上只会误导人去扫
			panelEl?.querySelectorAll('#dsh-mios-remote-main')
				.forEach((btn) => btn.closest('.dsh-mios-banner')?.querySelectorAll('.dsh-mios-code-slot, .err')
					.forEach((e) => e.remove()));
			await probe();
			renderSummary();
			tunnelBusy = false;
		}

		function togglePanel() {
			if (panelEl) removePanel();
			else showPanel();
		}

		// ── banner（slot 渲染，React 元素） ──────────────────────────
		// 注意：slot 渲染回调不是 React 组件（宿主按回调取元素），不能用 hooks；
		// 状态点读模块级 summary，新鲜度由 apply 里的轮询保证，
		// 宿主重渲侧栏时自然取到最新值。面板打开时另有主动 probe()。

		const STATUS_OK = { stroke: '#3fb27f', fill: 'rgba(63,178,127,.18)' };
		const STATUS_DOWN = { stroke: '#d94f3d', fill: 'rgba(217,79,61,.18)' };

		function PhoneIcon() {
			return react.createElement('svg', {
				'aria-hidden': true, focusable: false, width: 16, height: 16,
				viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
				strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
			},
			react.createElement('rect', { x: 4, y: 1, width: 8, height: 14, rx: 2 }),
			react.createElement('path', { d: 'M7 12h2' }));
		}

		function apply(ctx) {
			installStyle();

			// 注入宿主插件管理器：一步更新能力来源。可选能力——用安全读取而非硬依赖，
			// 拿不到时 pluginManager 保持 null，更新弹窗自动降级为「复制包名」手动安装。
			try {
				const remote = (typeof ctx.get === 'function' && ctx.get('remote'))
					|| ctx.remote || null;
				pluginManager = remote?.pluginManager || null;
			} catch { pluginManager = null; }

			// 跨 HMR 重载恢复：一步更新触发插件自更新会卸载本模块，弹窗随之消失。
			// 发起前把状态写入 localStorage，重载后据此显示「更新完成/进行中」反馈。
			try { restorePendingUpdate(); } catch { /* 存储不可用时跳过，不影响主流程 */ }

			// 轮询保持 summary 新鲜（banner 状态点 + 面板数据共用）
			probeUntilUp();
			const pollTimer = setInterval(probe, 15000);

			// 状态面板打开期间保持轮询：banner 的 useGatewayStatus 只在宿主渲染时活跃
			const disposeSlot = ctx.slots.inject('sidebar.footer.action', () =>
				ctx.slots.register(
					{ name: 'sidebar.footer.action', id: 'dsh-mobile-ios' },
					({ wide }) => {
						const ok = !!(summary && summary.ok);
						const tone = ok ? STATUS_OK : STATUS_DOWN;
						return react.createElement('button', {
							className: `dsh-mios-trigger${wide ? '' : ' is-rail'}`,
							type: 'button',
							title: PANEL_TITLE,
							'aria-label': PANEL_TITLE,
							onClick: togglePanel,
						},
						react.createElement('span', {
							className: 'dsh-mios-dot ' + (ok ? 'ok' : 'down'),
							style: { background: tone.stroke },
						}),
						// 名称左边不再放 SVG 手机图标：wide 模式有「📱」emoji 就够了；
					// 窄栏（rail）没有名字，图标仍是唯一的视觉标识，保留。
						wide ? undefined : react.createElement(PhoneIcon),
						wide ? react.createElement('span', null, BANNER_LABEL) : undefined);
					}
				)
			);

			return () => {
				clearInterval(pollTimer);
				disposeSlot();
				removePanel();
				document.getElementById(STYLE_ID)?.remove();
			};
		}

		// 注意：宿主 inject 数组是「硬依赖」，缺失会让整个模块挂起（pending）。
		// remote/pluginManager 属可选能力，只声明 slots；安装服务在 apply 内安全获取。
		const inject = ['slots'];
		exports.apply = apply;
		exports.inject = inject;
		exports.__test = {
			PORT_CANDIDATES, STATUS_OK, STATUS_DOWN,
			showUpdateModal, closeUpdateModal, copyToClipboard,
			performUpdate, checkPluginUpdate, compareVersions, unwrapRemote,
			setPluginManager: (m) => { pluginManager = m; },
			setUpdateTimeout: (ms) => { UPDATE_TIMEOUT_MS = ms; },
			isUpdateInFlight: () => updateInFlight,
			restorePendingUpdate, readUpdateState, writeUpdateState, clearUpdateState,
		};

		return module.exports;
	},
});
