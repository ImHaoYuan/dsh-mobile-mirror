/**
 * P3 测试：手机界面（lib/web/*）与接线（lib/index.js）。
 *
 * 三个部分：
 *   ① index.html / app.css 静态检查 —— 新增的节点与类名真的在文件里、顺序也对
 *   ② app.js 纯函数用例 —— 复制成 .cjs 后 require，取出 PURE 导出
 *   ③ 回归护栏 —— 两个"不会报错、只会安静显示错值"的字段名坑，用源码断言钉死
 *
 * 为什么需要 ③：模式读错来源只会把"创造模式"显示成"standard"，模型读错键只会让芯片
 * 永远为空 —— 两者都不抛异常，单测也抓不到，只能靠断言源码来防止回退。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const WEB = fileURLToPath(new URL('../lib/web/', import.meta.url))
const LIB = fileURLToPath(new URL('../lib/', import.meta.url))
const APP_JS = path.join(WEB, 'app.js')
const APP_CSS = path.join(WEB, 'app.css')
const INDEX = path.join(WEB, 'index.html')

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${name}`) } else { failed += 1; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`) }
}
function eq(name, actual, expected) {
  check(name, Object.is(actual, expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}
function deepEq(name, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  check(name, a === b, `期望 ${b}，实际 ${a}`)
}
function has(name, haystack, needle) {
  check(name, String(haystack).includes(needle), `缺少 ${JSON.stringify(needle)}`)
}
function hasNot(name, haystack, needle) {
  check(name, !String(haystack).includes(needle), `不该出现 ${JSON.stringify(needle)}`)
}
/**
 * 去掉整行注释后再做源码断言。
 * 注释里会**特意提到**被修掉的旧写法（比如"之前读的是 proj.model"），
 * 直接在原文里断言 hasNot 会被自己的说明文字绊倒。
 */
function codeOnly(source) {
  return String(source).split('\n').filter((line) => {
    const t = line.trim()
    return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*')
  }).join('\n')
}

const html = fs.readFileSync(INDEX, 'utf8')
const css = fs.readFileSync(APP_CSS, 'utf8')
const src = fs.readFileSync(APP_JS, 'utf8')
const mirrorSrc = fs.readFileSync(path.join(LIB, 'mirror.js'), 'utf8')
const serverSrc = fs.readFileSync(path.join(LIB, 'server.js'), 'utf8')
const indexSrc = fs.readFileSync(path.join(LIB, 'index.js'), 'utf8')

/* ==================== ① index.html / app.css ==================== */
console.log('\n———— 界面骨架 ————')

check('主页引用 /app.js', /<script[^>]+defer[^>]+src=["']\/app\.js["']/.test(html))
check('主页引用 /app.css', /<link[^>]+rel=["']stylesheet["'][^>]+href=["']\/app\.css["']/.test(html))
check('app.js / app.css 都非空', fs.statSync(APP_JS).size > 10000 && fs.statSync(APP_CSS).size > 5000)

const ALLOWED = ['USERNAME', 'SCHEME', 'PORT', 'SECURE', 'ENABLE_PROMPT']
const placeholders = [...new Set([...html.matchAll(/\{\{([A-Za-z0-9_]*)\}\}/g)].map((m) => m[1]))]
check('没有非法/未替换占位符', placeholders.every((k) => ALLOWED.includes(k)), placeholders.join(','))
has('用到了 {{USERNAME}}', html, '{{USERNAME}}')
has('用到了 {{ENABLE_PROMPT}}', html, '{{ENABLE_PROMPT}}')
hasNot('没有外链资源', html, 'src="http')
hasNot('没有内联 <style>', html, '<style')
check('没有内联 <script> 代码', !/<script(?![^>]*\bsrc=)[^>]*>\s*\S/i.test(html))

// P3-D：提问卡片
for (const id of ['qcard', 'qcard-title', 'qcard-count', 'qcard-body', 'qcard-submit', 'qcard-note']) {
  has(`提问卡片有 #${id}`, html, `id="${id}"`)
}
has('提问卡片有 aria 语义', html, 'aria-modal="true"')
check('提问卡片排在输入框之前（位置紧贴输入框上方）',
  html.indexOf('id="qcard"') !== -1 && html.indexOf('id="qcard"') < html.indexOf('id="composer"'))

// P3-B/C：选择面板
for (const id of ['sheet', 'sheet-backdrop', 'sheet-title', 'sheet-body', 'sheet-close']) {
  has(`选择面板有 #${id}`, html, `id="${id}"`)
}
has('选择面板有面板容器', html, 'class="sheet-panel"')

for (const cls of ['.group-head', '.group.collapsed .group-body', '.group-caret', '.group-path',
  '.group-count', '.chip', '.sheet-panel', '.sheet-backdrop', '.opt', '.opt-efforts', '.effort',
  '.qcard', '.q-item', '.q-opt', '.q-mark', '.q-custom', '.tag-ask', '.sub-text']) {
  has(`CSS 有 ${cls}`, css, cls)
}
has('面板留了 safe-area 内边距', css, 'env(safe-area-inset-bottom')
has('动画尊重 prefers-reduced-motion', css, 'prefers-reduced-motion')

/* ==================== ①·五、P4：新建会话 / 字体 / Markdown ==================== */
console.log('\n———— P4 静态骨架 ————')

// 新建会话入口
has('列表页有"新建会话"按钮', html, 'id="btn-new"')
check('新建按钮在刷新按钮之前',
  html.indexOf('id="btn-new"') !== -1 && html.indexOf('id="btn-new"') < html.indexOf('id="btn-refresh"'))

// 字体：三个页面都要引 font.css，否则登录页/设置页没有 JetBrains Mono
const FONT_CSS = path.join(WEB, 'font.css')
const fontCss = fs.readFileSync(FONT_CSS, 'utf8')
has('font.css 声明 JetBrains Mono', fontCss, "font-family: 'JetBrains Mono'")
has('font.css 有 400 字重', fontCss, 'font-weight: 400')
has('font.css 有 700 字重', fontCss, 'font-weight: 700')
has('font.css 用 swap 避免阻塞首屏', fontCss, 'font-display: swap')
for (const page of ['index.html', 'login.html', 'setup.html']) {
  const pageSrc = fs.readFileSync(path.join(WEB, page), 'utf8')
  has(`${page} 引用 /font.css`, pageSrc, 'href="/font.css"')
}
check('字体文件真的在仓库里（两个 TTF，各 >100KB）',
  fs.existsSync(path.join(WEB, 'fonts', 'JetBrainsMono-Regular.ttf')) &&
  fs.existsSync(path.join(WEB, 'fonts', 'JetBrainsMono-Bold.ttf')) &&
  fs.statSync(path.join(WEB, 'fonts', 'JetBrainsMono-Regular.ttf')).size > 100000 &&
  fs.statSync(path.join(WEB, 'fonts', 'JetBrainsMono-Bold.ttf')).size > 100000)
check('附带了 OFL 许可证全文（OFL 要求随字体分发）',
  fs.existsSync(path.join(WEB, 'fonts', 'OFL.txt')) &&
  fs.readFileSync(path.join(WEB, 'fonts', 'OFL.txt'), 'utf8').includes('SIL OPEN FONT LICENSE Version 1.1'))

// 代码字体只作用于"真的是代码"的地方，正文与思考过程不动
has('CSS 定义了 --code-font', css, '--code-font: "JetBrains Mono"')
has('.md code 用代码字体', css, 'font:13px/1.5 var(--code-font)')
has('代码块用代码字体', css, 'font:12.5px/1.6 var(--code-font)')
has('工具参数用代码字体', css, 'font:12.5px/1.6 var(--code-font); color:#c7d0dd')
has('调试 JSON 用代码字体', css, 'font:11.5px/1.55 var(--code-font)')
has('思考过程仍用系统等宽（不是代码）', css, 'font:12.5px/1.65 var(--mono)')

// Markdown 新样式的挂钩
for (const cls of ['.md-table', '.md-check', '.md-check.on', '.md-task', '.md del', '.md img',
  '.sheet-block', '.sheet-input', '.md pre.md-code[data-lang]::before']) {
  has(`CSS 有 ${cls}`, css, cls)
}
has('表格容器可横向滚动', css, 'overflow-x:auto')
has('表格斑马纹', css, 'tbody tr:nth-child(even)')

// 「记住我」已经彻底移除
const loginSrc = fs.readFileSync(path.join(WEB, 'login.html'), 'utf8')
hasNot('登录页没有 remember 复选框', loginSrc, 'name="remember"')
hasNot('登录页没有"记住我"文案', loginSrc, '记住我')
hasNot('登录页没有 .remember 样式', loginSrc, '.remember')

/* ==================== ② app.js 纯函数 ==================== */
console.log('\n———— app.js 纯函数 ————')

// package.json 是 "type": "module"，而 app.js 用 module.exports 导出 PURE，
// 所以只能复制成 .cjs 再 require（与 %TEMP% 里那两套一次性脚本同一个办法）。
const tmp = path.join(os.tmpdir(), `dsh-mm-web-test-${process.pid}.cjs`)
fs.copyFileSync(APP_JS, tmp)
let P
try {
  P = require(tmp)
} finally {
  fs.rmSync(tmp, { force: true })
}
check('PURE 导出可加载', P && typeof P === 'object' && Object.keys(P).length > 30, `${Object.keys(P || {}).length} 个导出`)

// —— 工作区分组 ——
eq('shortPath：深路径保留首尾', P.shortPath('D:\\VibeCoding\\Plugin\\dsh-mobile-mirror'), 'D:\\…\\dsh-mobile-mirror')
eq('shortPath：两层不动', P.shortPath('D:\\x'), 'D:\\x')
eq('shortPath：去掉尾部斜杠', P.shortPath('D:\\a\\b\\'), 'D:\\…\\b')
eq('shortPath：空值返回空串', P.shortPath(null), '')
eq('collapseKey：按工作区区分', P.collapseKey('d:\\a'), 'dsh-mm-collapsed:d:\\a')
eq('collapseKey：无工作区也有关键字', P.collapseKey(''), 'dsh-mm-collapsed:')

const localGroups = P.groupLocally([
  { id: 'l1', cwd: 'D:\\p\\alpha', updatedAt: 10 },
  { id: 'l2', cwd: 'D:\\p\\beta', updatedAt: 20 },
  { id: 'l3', cwd: '', updatedAt: 30 },
])
eq('groupLocally：分组数量', localGroups.length, 3)
eq('groupLocally：组名取末段', localGroups[0].name, 'beta')
eq('groupLocally："无工作区"排最后', localGroups[2].key, '')
eq('groupLocally：组内有 running 时组头置位',
  P.groupLocally([{ id: 'x', cwd: 'D:\\p', running: true }])[0].running, true)
eq('groupLocally：非数组不炸', P.groupLocally(null).length, 0)

// —— 模式 / 模型显示 ——
eq('presetDisplay：内置中文名', P.presetDisplay('cordis'), '创造模式')
eq('presetDisplay：roster 自带优先', P.presetDisplay('cordis', [{ id: 'cordis', label: '我的' }]), '我的')
eq('presetDisplay：roster 的 name 也认', P.presetDisplay('cordis', [{ id: 'cordis', name: '我的2' }]), '我的2')
eq('presetDisplay：未知 id 原样', P.presetDisplay('weird'), 'weird')
eq('presetDisplay：空 id 空串', P.presetDisplay(''), '')
eq('内置模式表就 4 个', Object.keys(P.PRESET_NAMES).length, 4)

const catalog = { groups: [{ id: 'p', name: 'P', models: [{ id: 'm', name: '模型M', efforts: [{ id: 'low' }] }] }] }
eq('modelDisplay：命中用友好名', P.modelDisplay('p', 'm', catalog), '模型M')
eq('modelDisplay：未命中退回 id', P.modelDisplay('p', 'zz', catalog), 'zz')
eq('modelDisplay：空模型空串', P.modelDisplay('p', '', catalog), '')
eq('modelEntry：能找到条目', (P.modelEntry('p', 'm', catalog) || {}).id, 'm')
eq('modelEntry：找不到返回 null', P.modelEntry('p', 'zz', catalog), null)

// —— 两个坑的核心逻辑（抽成纯函数就是为了能在这里测） ——
eq('activePreset：投影优先于 header', P.activePreset({ agentPreset: 'cordis' }, { agentPreset: 'standard' }), 'cordis')
eq('activePreset：投影缺失才用 header', P.activePreset({}, { agentPreset: 'ptc' }), 'ptc')
eq('activePreset：都没有返回空串', P.activePreset({}, {}), '')
eq('activePreset：非字符串当没有', P.activePreset({ agentPreset: 42 }, {}), '')

const selProj = { modelSelection: { lastUsed: { provider: 'a', model: 'old' }, next: { provider: 'b', model: 'new', reasoningEffort: 'high' } } }
deepEq('selectionOf：读 modelSelection.next', P.selectionOf(selProj, null, null), { provider: 'b', model: 'new', reasoningEffort: 'high' })
deepEq('selectionOf：next 为 null 时退回 request/header',
  P.selectionOf({ modelSelection: { lastUsed: null, next: null } }, { provider: 'x', model: 'y' }, null),
  { provider: 'x', model: 'y', reasoningEffort: '' })
deepEq('selectionOf：都没有时用全局默认',
  P.selectionOf({}, null, { default: { provider: 'd', model: 'def', reasoningEffort: 'medium' } }),
  { provider: 'd', model: 'def', reasoningEffort: 'medium' })
deepEq('selectionOf：全空就是空', P.selectionOf(null, null, null), { provider: '', model: '', reasoningEffort: '' })
deepEq('selectionOf：投影不是对象也不炸', P.selectionOf({ modelSelection: 'x' }, null, null), { provider: '', model: '', reasoningEffort: '' })

// —— 答案组装 ——
const Q = [
  { id: 'q1', question: '选一个', options: [{ label: 'A' }] },
  { id: 'q2', question: '多说点', multiSelect: true, options: [{ label: 'X' }] },
]
eq('draftFor：空草稿', JSON.stringify(P.draftFor({}, 'q1')), JSON.stringify({ selected: [], custom: '' }))
eq('draftFor：不共享引用', P.draftFor({ q1: { selected: ['A'], custom: 'c' } }, 'q1').selected.length, 1)
eq('toggleSingle：选中', JSON.stringify(P.toggleSingle([], 'a')), JSON.stringify(['a']))
eq('toggleSingle：点已选中的取消', JSON.stringify(P.toggleSingle(['a'], 'a')), JSON.stringify([]))
eq('toggleSingle：换一个', JSON.stringify(P.toggleSingle(['a'], 'b')), JSON.stringify(['b']))
eq('toggleMulti：加', JSON.stringify(P.toggleMulti(['a'], 'b')), JSON.stringify(['a', 'b']))
eq('toggleMulti：删', JSON.stringify(P.toggleMulti(['a', 'b'], 'a')), JSON.stringify(['b']))
eq('toggleMulti：不改原数组', P.toggleMulti(['a'], 'b').length === 2 && ['a'].length === 1, true)

eq('answersFromDraft：缺答返回 null', P.answersFromDraft(Q, { q1: { selected: ['A'], custom: '' } }), null)
eq('answersFromDraft：题目列表为空返回 null', P.answersFromDraft([], {}), null)
eq('answersFromDraft：题干缺 id 返回 null', P.answersFromDraft([{ question: '?' }], {}), null)
deepEq('answersFromDraft：全答',
  P.answersFromDraft(Q, { q1: { selected: ['A'], custom: '' }, q2: { selected: [], custom: '自己写的' } }),
  [{ id: 'q1', selected: ['A'] }, { id: 'q2', selected: [], custom: '自己写的' }])
deepEq('answersFromDraft：只有自定义也算答了',
  P.answersFromDraft([{ id: 'q1' }], { q1: { selected: [], custom: '嗯' } }),
  [{ id: 'q1', selected: [], custom: '嗯' }])
deepEq('answersFromDraft：自定义是空白不算',
  P.answersFromDraft([{ id: 'q1' }], { q1: { selected: [], custom: '   ' } }), null)
deepEq('answersFromDraft：多选多值',
  P.answersFromDraft(Q, { q1: { selected: ['A'] }, q2: { selected: ['X', 'Y'], custom: '' } }),
  [{ id: 'q1', selected: ['A'] }, { id: 'q2', selected: ['X', 'Y'] }])
eq('unansweredCount：一题没答', P.unansweredCount(Q, { q1: { selected: ['A'], custom: '' } }), 1)
eq('unansweredCount：全答完', P.unansweredCount(Q, { q1: { selected: ['A'] }, q2: { selected: ['X'] } }), 0)

// —— 分组视图里的行标题 ——
eq('groupedLabel：有标题用标题', P.groupedLabel({ title: ' 你好 ' }), '你好')
eq('groupedLabel：无标题不再重复文件夹名', P.groupedLabel({ cwd: 'D:\\a\\b' }), '未命名会话')
eq('sessionSubtitle：只留时间，不再拼工作区名',
  /b/.test(P.sessionSubtitle({ title: 't', cwd: 'D:\\a\\b', updatedAt: Date.now() })), false)

/* ==================== ③ 回归护栏 ==================== */
console.log('\n———— 回归护栏 ————')

const code = codeOnly(src)
const mirrorCode = codeOnly(mirrorSrc)
const serverCode = codeOnly(serverSrc)
const indexCode = codeOnly(indexSrc)

// 坑 1：模式曾读 header.agentPreset（创建时的值、深冻结），创造模式的会话显示成 standard。
has('deriveSub 用 activePreset 推导模式', code, 'activePreset(proj, header)')
has('activePreset 读投影里的模式', code, 'p.agentPreset')
hasNot('不再直接把 header.agentPreset 当模式显示', code, 'preset: header.agentPreset')
hasNot('不再直接读 proj.agentPreset 给 sub', code, 'preset: typeof p.agentPreset')

// 坑 2：模型曾读 proj.model，而投影键叫 modelSelection，于是芯片永远是空的。
has('deriveSub 用 selectionOf 取模型', code, 'selectionOf(proj, fallback, state.catalog)')
has('selectionOf 读 modelSelection 投影', code, 'p.modelSelection')
has('selectionOf 读它的 next 字段', code, 'modelSelection.next')
hasNot('不再读不存在的 proj.model', code, 'proj.model')

// 事件：换模式 / 换模型要能实时更新头部
has('处理 agent-preset/selected 事件', code, "type === 'agent-preset/selected'")
has('处理 model/selection 事件', code, "type === 'model/selection'")
has('快照走 deriveSub', code, 'state.sub = deriveSub(')
has('快照用最新 request/header 兜底', code, "records[r].type === 'request/header'")

// 服务端一侧：镜像层也必须读投影
has('mirror 投影事件里有 agent-preset/selected', mirrorCode, "case 'agent-preset/selected'")
has('mirror 投影事件里有 model/selection', mirrorCode, "case 'model/selection'")
has('mirror 的 presetOf 读 projections.values', mirrorCode, 'projections.values')
has('mirror 的 presetOf 有内置中文名表', mirrorCode, "'创造模式'")

// 提问链路：必须 prepend 才能抢在 Remote 转发器之前
has('注册 user-questions/request', indexCode, "'user-questions/request'")
has('用 prepend 抢在 Remote 转发器之前', indexCode, 'prepend: true')
has('注册失败不影响其他功能（有兜底分支）', indexCode, '注册提问转发失败')
has('注入了 agentPresets 与 agents', indexCode, "root.inject(['agentPresets', 'agents']")
has('问题流是独立 SSE', code, "'/api/questions/stream'")
has('答案提交到 /api/answer', code, "'/api/answer'")
has('列表页会拉待答问题', code, "'/api/questions?id='")
// tryJson 返回的是 { ok, value } 而不是解析结果本身。把包装对象当帧传下去，
// frame.e 就是 undefined，提问帧会被静默丢弃 —— 界面上完全看不出问题。
has('问题流先检查 tryJson 的 ok', code, 'if (!parsed.ok) return;')
has('问题流用 parsed.value 当帧', code, 'var frame = parsed.value;')
hasNot('不把 tryJson 的包装对象直接当帧', code, 'var frame = tryJson(')

// 服务端路由
for (const route of ['/api/models', '/api/model', '/api/presets', '/api/preset', '/api/questions', '/api/answer', '/api/questions/stream']) {
  has(`server 有 ${route}`, serverCode, `'${route}'`)
}
has('写操作统一走 guardedJsonBody', serverCode, 'guardedJsonBody')
has('agent-preset/locked 翻成 409', serverCode, 'preset-locked')
has('/api/sessions 带 groups', serverCode, '{ items, groups }')
has('目录缓存 60 秒', serverCode, 'createCatalogCache({ ttlMs: 60000 })')

// 折叠状态持久化（默认折叠，展开也要显式落盘）
has('折叠状态写 localStorage', code, 'localStorage.setItem')
has('折叠键按工作区分开', code, 'dsh-mm-collapsed:')
has('localStorage 被 try 包住（隐私模式不炸）', code, 'catch (err) { value = true; }')
has('默认折叠：没记录过就是折叠', code, "value = global.localStorage.getItem(collapseKey(key)) !== '0'")
has('展开也要显式存 0（不能靠 removeItem，否则刷新又弹回折叠）',
  code, "global.localStorage.setItem(collapseKey(key), value ? '1' : '0')")
hasNot('不再用 removeItem 表示展开', code, 'removeItem(collapseKey(')

// 写操作开关覆盖到新功能
has('只读模式下切模型也会被拒', code, "'切换模型失败'")
has('面板在只读模式下拒绝打开', code, '手机端写操作已被配置关闭')

/* ==================== ⑤ P4：新建会话的接线 ==================== */
console.log('\n———— P4 接线 ————')

// 服务端
for (const route of ['/api/workspaces', '/api/session']) {
  has(`server 有 ${route}`, serverCode, `'${route}'`)
}
has('server 调 createSession', serverCode, 'createSession(deps.controller, body)')
has('server 用 normalizeWorkspaces 合并清单', serverCode, 'normalizeWorkspaces(listRegisteredWorkspaces(deps.registry), items)')
has('server 把 registry 放进 deps 默认值', serverCode, 'registry: null')
has('字体走 binary 读取（raw 是 utf8，会读坏 TTF）', serverCode, 'binary: true')
has('字体单独开长缓存', serverCode, "cache: 'public, max-age=31536000, immutable'")
has('静态资源抽成了 serveAsset', serverCode, 'function serveAsset(res, pathname)')
has('字体在鉴权之前放行（登录页也要用）', serverCode, "url.pathname === '/font.css' || url.pathname.startsWith('/font/')")
// 用原始源码比对：那两行标记都是注释，codeOnly 会把它们剥掉
check('字体放行排在"需要登录"之前',
  serverSrc.indexOf("startsWith('/font/')") < serverSrc.indexOf('以下全部需要登录'))

// mirror.js
has('mirror 有 normalizeWorkspaces', mirrorCode, 'export function normalizeWorkspaces(')
has('mirror 有 listRegisteredWorkspaces', mirrorCode, 'export function listRegisteredWorkspaces(')
has('mirror 有 validateSessionCreate', mirrorCode, 'export function validateSessionCreate(')
has('mirror 有 createSession', mirrorCode, 'export async function createSession(')
has('拒绝相对路径（会落到 DSH 进程 cwd 上）', mirrorCode, 'path-not-absolute')
has('只放行 http/https 的图片与链接', code, 'function safeUrl(url)')

// 入口层
has('index 注入 workspaceRegistry', indexCode, "'workspaceRegistry'")
has('workspaceRegistry 单独 inject（不连累 presets/agents）', indexCode, "root.inject(['workspaceRegistry']")
has('deps 里有 registry 字段', indexCode, 'registry: null')

// 页面
has('app.js 有 openNewSheet', code, 'function openNewSheet()')
has('app.js 有 workspaceOption', code, 'function workspaceOption(row)')
has('app.js 有 appendPathRow', code, 'function appendPathRow(body)')
has('app.js 提交时禁用面板按钮（防连点建多个会话）', code, 'function setSheetBusy(busy)')
has('新建按钮绑到了 openNewSheet', code, "els.btnNew.addEventListener('click', function () { openNewSheet(); })")
has('列表页顶栏按钮都在 els 里', code, "els.btnNew = $('btn-new')")
has('建完直接进新会话', code, 'openSession(id)')
has('新会话不缓存旧的工作区清单', code, 'state.workspaces = null')
hasNot('不做模式选择器（新会话进去再改）', code, 'createSession({ cwd: item.path, preset:')

/* ==================== ⑥ P5：隐藏系统消息 ==================== */
console.log('\n———— P5 隐藏系统消息 ————')

// 判别依据：DSH 把 AGENTS.md / 运行时上下文等也塞进 user/message，
// 只有 data.source.kind 能区分真人输入。
has('mirror 导出 isInjectedUserMessage', mirrorCode, 'export function isInjectedUserMessage(')
has('只认 kind === "user" 是真人输入', mirrorCode, "const USER_SOURCE_KIND = 'user'")
has('projectEvent 里注入消息直接返回 null', mirrorCode, 'if (isInjectedUserMessage(data)) return null')
has('source 缺失时 fail-safe 保留', mirrorCode, "if (!source || typeof source !== 'object') return false")
has('kind 缺失时 fail-safe 保留', mirrorCode, "if (!kind) return false")
has('kind 必须严格等于 user 才算真人', mirrorCode, 'return kind !== USER_SOURCE_KIND')

// 光靠 kind 不够：子代理的启动提示 kind 就是 user，但里面裹着 <system-reminder>，
// 而且真正的任务书在**同一块的后面**，所以只能按块剥。
has('mirror 导出 stripInjectedBlocks', mirrorCode, 'export function stripInjectedBlocks(')
has('识别整块 <system-reminder>', mirrorCode, 'SYSTEM_REMINDER_RE')
has('必须首尾都被包住才剥（免得误伤"引用了 reminder 又接着说正事"）', mirrorCode, '/^\\s*<system-reminder>[\\s\\S]*<\\/system-reminder>\\s*$/')
has('剥空后整条丢掉', mirrorCode, 'if (rawBlocks.length > 0 && blocks.length === 0) return null')

// 系统提示 / 开发者消息：连"已省略"那一行标记都不再下发
has('仍有 system/message 分支', mirrorCode, "case 'system/message':")
has('仍有 developer/message 分支', mirrorCode, "case 'developer/message':")
hasNot('不再下发"系统提示（已省略）"', mirrorCode, '系统提示（已省略）')
hasNot('不再下发"开发者消息（已省略）"', mirrorCode, '开发者消息（已省略）')
hasNot('projectEvent 里不再出现 omitted 标记', mirrorCode, 'omitted: true')

// 客户端侧的对应处理也一并删掉，免得留死代码
hasNot('客户端不再有 renderSystemNote', code, 'renderSystemNote')
hasNot('CSS 里没有 .sys-note', css, '.sys-note')

console.log(`\n${passed}/${passed + failed} 通过`)
if (failed > 0) process.exitCode = 1
