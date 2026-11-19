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
				body: JSON.stringify({ deviceName: 'desktop-sidebar', ...(route ? { route } : {}) }),
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
  color: var(--muted); font: 500 11px/1.4 inherit, sans-serif; cursor: pointer; padding: 3px 8px; }
.dsh-mios-upd:hover { color: var(--fg); border-color: var(--border-hover); }
.upd-result { margin: -4px 0 10px; font-size: 11px; color: var(--muted); line-height: 1.5; }
.upd-result.has-update { color: #3fb27f; }
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
.dsh-mios-device-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; color: var(--fg); }
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
		// 插件更新检查：读分发索引（发布前不可达时如实说明「本地开发版」）
		const PLUGIN_INDEX_URL = 'https://raw.githubusercontent.com/yelter/dsh-mobile-ios/main/spec/distribution/plugin-market.json';
		const stripUrl = (u) => String(u || '').replace(/^https?:\/\//, '');
		const stripLocal = (h) => String(h || '').replace(/\.local$/i, '');

		let panelEl = null;
		let tunnelBusy = false;
		const bannerBusy = { lan: false, remote: false };
		let outsideCloser = null;
		let devicesExpanded = false;
		let kickingDeviceId = null;

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
				name.textContent = device.deviceName || device.deviceId;
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
			renderDeviceList();

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
				mainBtn.textContent = dnsBroken
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

			// 提示行只承载告警与错误：没有告警就整行隐藏，不再放固定说明文字
			const hint = panelEl.querySelector('#dsh-mios-hint');
			if (hint) {
				const warn = ok ? summary.tunnel?.warning : null;
				hint.textContent = warn ? `⚠️ ${warn}` : '';
				hint.style.color = '#e0a03c';
				hint.style.display = warn ? '' : 'none';
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
			installStyle();
			panelEl = document.createElement('div');
			panelEl.className = 'dsh-mios-panel';

			const header = document.createElement('h3');
			const dot = document.createElement('span');
			dot.id = 'dsh-mios-panel-dot';
			dot.className = 'dsh-mios-dot down';
			const title = document.createElement('span');
			title.textContent = PANEL_TITLE;
			// 插件更新：放在关闭按钮左边，点开内联结果，不弹窗不跳页
			const updBtn = document.createElement('button');
			updBtn.className = 'dsh-mios-upd';
			updBtn.textContent = '插件更新';
			updBtn.addEventListener('click', () => checkPluginUpdate());
			const close = document.createElement('button');
			close.className = 'dsh-mios-close';
			close.textContent = '✕';
			close.setAttribute('aria-label', '关闭面板');
			close.addEventListener('click', removePanel);
			header.append(dot, title, updBtn, close);
			const updResult = document.createElement('div');
			updResult.id = 'dsh-mios-upd-result';
			updResult.style.display = 'none';

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
			footer.textContent = 'iPhone/iPad App → 连接 → 扫码（约 5 分钟有效）';

			panelEl.append(header, updResult, body, lanBanner, remoteBanner, hint, footer);
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

		/** 更新检查：发布后读分发索引比对版本；未发布时如实说明本地开发版怎么更新。 */
		async function checkPluginUpdate() {
			const box = panelEl?.querySelector('#dsh-mios-upd-result');
			if (!box) return;
			box.style.display = '';
			box.textContent = '正在检查更新…';
			box.className = 'upd-result';
			try {
				const res = await fetch(PLUGIN_INDEX_URL, { signal: AbortSignal.timeout(6000) });
				const index = await res.json();
				const entry = (index.plugins || []).find((p) => p.name === 'dsh-mobile-ios');
				const latest = entry?.versions?.[0]?.version;
				const current = summary?.version || '';
				if (!latest) throw new Error('索引里没有版本信息');
				if (compareVersions(latest, current) > 0) {
					box.className = 'upd-result has-update';
					box.textContent = `发现新版 v${latest}（当前 v${current}）：请到 DSH 插件市场 → 已安装 → 更新；商城会自动备份并热重载。`;
				} else {
					box.className = 'upd-result';
					box.textContent = `已是最新版本 v${current}。`;
				}
			} catch {
				box.className = 'upd-result';
				// 本地 link 安装（开发态）：更新 = 拉取仓库最新代码，宿主 patchReload 热重载
				box.textContent = '更新源暂不可达：插件尚未发布到插件市场，当前为本地开发版。'
					+ '更新方式：拉取仓库最新代码后重启 DSH 桌面端，插件会随源码自动热重载。';
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

		/** 远程主按钮：一条动作链走完「确保在跑 → 出码」。一次点击出码，绝不让人点两下。 */
		async function remoteMainAction(banner) {
			if (tunnelBusy || bannerBusy.remote) return;
			const mainBtn = panelEl?.querySelector('#dsh-mios-remote-main');
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

		const inject = ['slots'];
		exports.apply = apply;
		exports.inject = inject;
		exports.__test = { PORT_CANDIDATES, STATUS_OK, STATUS_DOWN };

		return module.exports;
	},
});
