/**
 * dsh-mobile-mirror —— 浏览器半侧（已构建的客户端 bundle）。
 *
 * 目标：在 DSH 设置面板（左下角头像点开的那个）里加一页「手机镜像」，
 * 显示手机该访问哪个地址，以及当前的口令 / 证书状态。
 *
 * ── 为什么是"手写的 bundle" ──────────────────────────────────────────────────
 * DSH 把插件包里 `dsh.client` 的声明变成浏览器 bundle：宿主扫描 Loader 条目，
 * 把 `exports["./client"]` 指向的文件原样发给浏览器，浏览器用
 * `window.__ModuleLoader__.load({ id, factory })` 注册 factory，物化时把
 * `factory(require)` 的返回值当 Cordis 插件（读 `apply` / `inject`）。
 * 所以这个文件**不需要任何构建步骤**，它本身就是产物 —— 与已安装的
 * dsh-ctrl-enter-newline 用的是同一套格式。
 *
 * ── 数据从哪来 ──────────────────────────────────────────────────────────────
 * 浏览器在页面里，**拿不到本机网卡信息**（WebRTC 那条路被 mDNS 混淆挡掉，
 * 不可靠），所以只能问主机。主机半侧（lib/index.js）在 DSH 自己的 GUI 服务上
 * 注册了一条**只读、仅回环可访问**的路由 `GET /dsh-mirror/info.json`
 * （鲸鱼插件用 `ctx.webServer.register` 注册 /dsh-whale/*.json 也是这条路）。
 * 同源 fetch，不走手机镜像那个 19388 端口，因此不涉及自签证书与 CORS。
 *
 * ── 为什么不用 @deepseek-ai/dsh-client-ui-primitives ────────────────────────
 * 那个包的组件契约没有公开文档，猜错属性只会安静地显示错样子。这里只用
 * 原生元素 + 主题 token（`--dsw-alias-*`），明暗主题自动跟随，零耦合。
 *
 * ── 失败姿势 ────────────────────────────────────────────────────────────────
 * 主机侧路由拿不到（没重启 DSH、webServer 不可用）时，面板显示一行说明并
 * 给出「重启 DSH」的提示，**不抛异常**：客户端 bundle 抛错会被启动审计记成
 * 该包加载失败，为一个便利面板把设置页搞脏不划算。
 */

window.__ModuleLoader__.load({
	id: "dsh-mobile-mirror",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		// React 在平台 seed 表里（49 个官方 bundle 都 require 它）。仍然包一层：
		// 万一哪天 seed 表变了，这里是"面板不出现"，而不是"整个客户端启动失败"。
		let React = null;
		try {
			React = require("react");
		} catch (error) {
			React = null;
		}
		const h = React === null ? null : React.createElement;

		/** 设置页在列表槽里的位置：排在官方「智能体预设」（order 20）之后。 */
		const SECTION = "settings.section";
		/** 本页的槽内 id。必须是自己的 id —— 复用官方 id 会把官方那一页顶掉。 */
		const SECTION_ID = "mobile-mirror";
		/** 导航里的显示文字。 */
		const SECTION_LABEL = "手机镜像";
		/** 槽内排序。 */
		const SECTION_ORDER = 30;
		/**
		 * 主机侧那条路由的路径。
		 * ⚠️ 必须与 lib/index.js 里的 INFO_PATH 逐字一致 —— 测试会钉住这一点。
		 */
		const INFO_PATH = "/dsh-mirror/info.json";
		/** 面板打开期间的自动刷新间隔（毫秒）。关闭面板即停。 */
		const REFRESH_MS = 10000;

		/** 面板样式。全部挂在 .mm- 前缀下，只用主题 token，明暗主题自动跟随。 */
		const CSS = `
.mm-panel{display:flex;flex-direction:column;gap:14px;font-size:13px;line-height:1.6;
  color:var(--dsw-alias-label-primary,#1f1f1f);padding:2px 2px 14px}
.mm-h1{font-size:15px;font-weight:600}
.mm-sub{font-size:12px;color:var(--dsw-alias-label-secondary,#6b6b6b);margin-top:2px}
.mm-card{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));border-radius:10px;
  padding:12px 14px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06))}
.mm-card-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#6b6b6b);
  margin-bottom:9px}
.mm-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mm-line+.mm-line{margin-top:6px}
.mm-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;
  background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));
  border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));border-radius:6px;
  padding:3px 8px;word-break:break-all;user-select:all}
.mm-note{font-size:11.5px;color:var(--dsw-alias-label-secondary,#6b6b6b);margin-top:7px}
.mm-btn{font:inherit;font-size:11.5px;line-height:1;padding:5px 9px;border-radius:6px;cursor:pointer;
  color:var(--dsw-alias-label-primary,#1f1f1f);
  background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));
  border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28))}
.mm-btn:hover{background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.2))}
.mm-btn:disabled{opacity:.55;cursor:default}
.mm-btn.mm-ok{color:var(--dsw-alias-state-success-primary,#2f9e63);
  border-color:var(--dsw-alias-state-success-primary,#2f9e63)}
.mm-btn.mm-fail{color:var(--dsw-alias-state-error-primary,#d4383c);
  border-color:var(--dsw-alias-state-error-primary,#d4383c)}
.mm-grid{display:grid;grid-template-columns:auto 1fr;gap:5px 14px;align-items:baseline}
.mm-k{font-size:12px;color:var(--dsw-alias-label-secondary,#6b6b6b);white-space:nowrap}
.mm-v{word-break:break-all}
.mm-v.mm-good{color:var(--dsw-alias-state-success-primary,#2f9e63)}
.mm-v.mm-bad{color:var(--dsw-alias-state-error-primary,#d4383c)}
.mm-v.mm-warn{color:var(--dsw-alias-state-warn-primary,#b7791f)}
.mm-alt{margin-top:9px;border-top:1px dashed var(--dsw-alias-border-l1,rgba(127,127,127,.24));
  padding-top:9px}
.mm-alt-item{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;font-size:12px}
.mm-alt-item+.mm-alt-item{margin-top:5px}
.mm-alt-name{color:var(--dsw-alias-label-secondary,#6b6b6b);min-width:96px}
.mm-box{border-radius:10px;padding:10px 12px;font-size:12.5px;
  border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28))}
.mm-box.mm-err{color:var(--dsw-alias-state-error-primary,#d4383c)}
.mm-box.mm-warn{color:var(--dsw-alias-state-warn-primary,#b7791f)}
.mm-foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:11.5px;
  color:var(--dsw-alias-label-secondary,#6b6b6b)}
`;

		/**
		 * 注入样式表，返回卸载函数。
		 *
		 * 自己插 <style> 而不是用构建期 CSS 导入：这个文件是手写的产物，没有打包器。
		 * @returns 移除样式元素的函数。
		 */
		function insertStyles() {
			const el = document.createElement("style");
			el.setAttribute("data-mobile-mirror", "panel");
			el.textContent = CSS;
			document.head.appendChild(el);
			return () => {
				try {
					el.remove();
				} catch (error) {
					// 样式元素已经不在了，没什么可做的。
				}
			};
		}

		/**
		 * 把时间戳格式化成 HH:MM:SS。
		 * @param ts - 毫秒时间戳。
		 * @returns 本地时间字符串。
		 */
		function formatClock(ts) {
			const d = new Date(ts);
			const pad = (n) => String(n).padStart(2, "0");
			return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
		}

		/**
		 * 复制文本到剪贴板。
		 *
		 * `http://127.0.0.1` 属于安全上下文，navigator.clipboard 可用；退路是
		 * 临时 textarea + execCommand —— 老 Chromium 与某些权限策略下只有它管用。
		 * @param text - 要复制的文本。
		 * @returns 是否复制成功。
		 */
		function copyText(text) {
			const fallback = () => {
				try {
					const area = document.createElement("textarea");
					area.value = text;
					area.setAttribute("readonly", "");
					area.style.position = "fixed";
					area.style.top = "-1000px";
					document.body.appendChild(area);
					area.select();
					const ok = document.execCommand("copy");
					area.remove();
					return ok;
				} catch (error) {
					return false;
				}
			};
			try {
				if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
					return navigator.clipboard.writeText(text).then(
						() => true,
						() => fallback(),
					);
				}
			} catch (error) {
				// 落到退路。
			}
			return Promise.resolve(fallback());
		}

		/** 一个带"已复制/失败"反馈的复制按钮。 */
		function CopyButton(props) {
			const [tone, setTone] = React.useState("");
			const label = props.label || "复制";
			const onCopy = () => {
				Promise.resolve(copyText(props.text)).then((ok) => {
					setTone(ok ? "ok" : "fail");
					window.setTimeout(() => setTone(""), 1600);
				});
			};
			return h(
				"button",
				{
					type: "button",
					className: "mm-btn" + (tone ? " mm-" + tone : ""),
					onClick: onCopy,
					title: "复制 " + props.text,
				},
				tone === "ok" ? "已复制" : tone === "fail" ? "复制失败" : label,
			);
		}

		/**
		 * 读取主机信息，并在面板挂载期间每 REFRESH_MS 自动刷新一次。
		 * @returns [状态, 立即刷新函数]。
		 */
		function useMirrorInfo() {
			const [state, setState] = React.useState({ status: "loading", data: null, error: "", at: 0 });
			const alive = React.useRef(true);
			const load = React.useCallback(() => {
				fetch(INFO_PATH, { headers: { accept: "application/json" }, cache: "no-store" })
					.then((res) => {
						if (!res.ok) throw new Error("HTTP " + res.status);
						return res.json();
					})
					.then((data) => {
						if (!alive.current) return;
						setState({ status: "ready", data, error: "", at: Date.now() });
					})
					.catch((err) => {
						if (!alive.current) return;
						// 保留上一次成功的数据：刷新失败不该把已经看到的信息抹掉。
						setState((prev) => ({
							status: "error",
							data: prev.data,
							error: String((err && err.message) || err),
							at: prev.at,
						}));
					});
			}, []);
			React.useEffect(() => {
				alive.current = true;
				load();
				const timer = window.setInterval(load, REFRESH_MS);
				return () => {
					alive.current = false;
					window.clearInterval(timer);
				};
			}, [load]);
			return [state, load];
		}

		/** 一行「标签 — 值」。 */
		function InfoRow(label, value, tone) {
			return h(
				React.Fragment,
				null,
				h("span", { className: "mm-k" }, label),
				h("span", { className: "mm-v" + (tone ? " mm-" + tone : "") }, value),
			);
		}

		/** 主地址那一块：手机该访问的 URL + 网卡名 + 其他网卡。 */
		function AddressCard(props) {
			const [showAll, setShowAll] = React.useState(false);
			const list = props.candidates || [];
			const primary = list.length > 0 ? list[0] : null;
			const rest = list.slice(1);
			const body = [];
			if (primary === null) {
				body.push(
					h(
						"div",
						{ className: "mm-box mm-warn", key: "none" },
						"没找到局域网 IPv4 地址。手机现在连不上 —— 检查这台电脑有没有连上 Wi-Fi 或有线网。",
					),
				);
			} else {
				body.push(
					h(
						"div",
						{ className: "mm-line", key: "url" },
						h("code", { className: "mm-code" }, primary.url),
						h(CopyButton, { text: primary.url, key: "copy" }),
					),
				);
				body.push(h("div", { className: "mm-note", key: "which" }, "网卡 " + primary.name + " · " + primary.address));
			}
			if (rest.length > 0) {
				body.push(
					h(
						"button",
						{
							type: "button",
							className: "mm-btn",
							key: "toggle",
							style: { marginTop: "9px" },
							onClick: () => setShowAll(!showAll),
						},
						(showAll ? "▾ 收起其他网卡（" : "▸ 其他网卡（") + rest.length + "）",
					),
				);
			}
			if (showAll && rest.length > 0) {
				body.push(
					h(
						"div",
						{ className: "mm-alt", key: "alt" },
						rest.map((entry) =>
							h(
								"div",
								{ className: "mm-alt-item", key: entry.name + entry.address },
								h("span", { className: "mm-alt-name" }, entry.name),
								h("code", { className: "mm-code" }, entry.url),
							),
						),
					),
				);
			}
			return h("div", { className: "mm-card" }, h("div", { className: "mm-card-title" }, "手机访问地址"), body);
		}

		/** 设置面板主体。 */
		function Panel() {
			const [state, reload] = useMirrorInfo();
			const info = state.data;
			const blocks = [];

			blocks.push(
				h(
					"div",
					{ key: "head" },
					h("div", { className: "mm-h1" }, "手机镜像"),
					h("div", { className: "mm-sub" }, "在同一个 Wi-Fi 下，用手机看这台电脑的 DSH 会话"),
				),
			);

			if (info === null) {
				blocks.push(
					h(
						"div",
						{ className: "mm-box mm-err", key: "boot" },
						state.status === "loading"
							? "正在读取主机信息…"
							: "读不到主机信息（" + state.error + "）。" +
								"主机半侧那条路由可能还没加载 —— 重启一次 DSH 再回来看看。",
					),
				);
				return h("div", { className: "mm-panel" }, blocks);
			}

			blocks.push(h(AddressCard, { candidates: info.candidates, key: "addr" }));

			blocks.push(
				h(
					"div",
					{ className: "mm-card", key: "setup" },
					h("div", { className: "mm-card-title" }, "本机设置页（回环地址）"),
					h(
						"div",
						{ className: "mm-line" },
						h("code", { className: "mm-code" }, info.setupUrl),
						h(CopyButton, { text: info.setupUrl }),
					),
					h(
						"div",
						{ className: "mm-note" },
						"只有这台电脑能打开：改账号 / 口令、下载证书都在这里。诊断信息在 " + info.diagnosticsUrl,
					),
				),
			);

			const tls = info.tls || {};
			const schemeText = tls.enabled ? info.scheme + "（自签证书）" : info.scheme + "（明文，局域网内口令可被抓包）";
			blocks.push(
				h(
					"div",
					{ className: "mm-card", key: "state" },
					h("div", { className: "mm-card-title" }, "状态"),
					h(
						"div",
						{ className: "mm-grid" },
						InfoRow("协议", schemeText, tls.enabled ? "" : "bad"),
						InfoRow("端口", String(info.port)),
						InfoRow("账号", info.username || "（未设置）"),
						InfoRow(
							"口令",
							info.configured ? "已配置" : "未配置 —— 现在谁都无法登录",
							info.configured ? "good" : "bad",
						),
						InfoRow("证书指纹", tls.fingerprint || "—"),
						InfoRow("有效期至", tls.validTo || "—"),
						InfoRow("在线会话", String(info.activeSessions)),
					),
					tls.fingerprint
						? h(
								"div",
								{ className: "mm-line", style: { marginTop: "10px" } },
								h(CopyButton, { text: tls.fingerprint, label: "复制指纹" }),
							)
						: null,
					info.configured
						? null
						: h(
								"div",
								{ className: "mm-note mm-bad", style: { color: "var(--dsw-alias-state-error-primary,#d4383c)" } },
								"手机现在登录不了：先在上面那个本机设置页里设置账号和口令。",
							),
				),
			);

			if (state.status === "error") {
				blocks.push(
					h(
						"div",
						{ className: "mm-box mm-warn", key: "stale" },
						"刷新失败（" + state.error + "），下面是 " + formatClock(state.at) + " 读到的值。",
					),
				);
			}

			blocks.push(
				h(
					"div",
					{ className: "mm-foot", key: "foot" },
					h(
						"button",
						{ type: "button", className: "mm-btn", onClick: () => reload() },
						"刷新",
					),
					h("span", null, "最近更新 " + (state.at ? formatClock(state.at) : "—")),
					h("span", null, "面板打开期间每 " + REFRESH_MS / 1000 + " 秒自动刷新"),
				),
			);

			return h("div", { className: "mm-panel" }, blocks);
		}

		/**
		 * 注册设置页。用 slots.inject 等槽被声明出来：`settings.section` 由
		 * ui-settings 声明，两个插件的激活顺序没有约束，直接 register 可能
		 * 打在声明之前。
		 * @param slots - 客户端 slots 服务。
		 */
		function registerPanel(slots) {
			slots.inject(SECTION, () =>
				slots.register(
					{
						name: SECTION,
						id: SECTION_ID,
						order: SECTION_ORDER,
						label: SECTION_LABEL,
					},
					Panel,
				),
			);
		}

		/**
		 * 激活插件。
		 * @param ctx - Client 运行时上下文。
		 */
		function apply(ctx) {
			if (ctx === void 0 || ctx === null) return;
			if (typeof ctx.effect === "function") ctx.effect(insertStyles, "mobile-mirror: panel styles");
			else insertStyles();
			if (h === null) {
				try {
					console.warn("[mobile-mirror] 客户端没有 react 模块，设置面板不注册（其余功能不受影响）");
				} catch (error) {
					// 日志本身不是失败原因。
				}
				return;
			}
			const slots = typeof ctx.get === "function" ? ctx.get("slots") : ctx.slots;
			if (!slots || typeof slots.inject !== "function") {
				try {
					console.warn("[mobile-mirror] 客户端没有 slots 服务，设置面板不注册（其余功能不受影响）");
				} catch (error) {
					// 同上。
				}
				return;
			}
			registerPanel(slots);
		}

		exports.apply = apply;
		exports.inject = ["slots"];
		return module.exports;
	},
});
