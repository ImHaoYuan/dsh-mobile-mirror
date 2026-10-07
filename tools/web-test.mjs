/**
 * P3 测试：手机界面（lib/web/*）与接线（lib/index.js）。
 *
 * 四个部分：
 *   ① index.html / app.css 静态检查 —— 新增的节点与类名真的在文件里、顺序也对
 *   ② app.js 纯函数用例 —— 复制成 .cjs 后 require，取出 PURE 导出
 *   ③ 回归护栏 —— 两个"不会报错、只会安静显示错值"的字段名坑，用源码断言钉死
 *   ④ lib/client.js（桌面设置面板）—— bundle 包裹格式、槽注册参数、与主机侧路由
 *      的路径逐字一致；这些写错**全都不报错**，只会安静地少一页面板
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
 * 取一条规则的声明体（`selector {` 到第一个 `}`）。
 *
 * 断言"某条规则用了哪个变量"时，比在全文里搜字符串准得多：`var(--code-font)`
 * 全文有十几处，搜到哪一处都算过。同时它也**不锁具体数值** —— 字号、颜色值
 * 以后想调就调，测试不用跟着改（锁死数值的断言每次微调都要改一遍，很快就没人维护了）。
 */
function rule(source, selector) {
  const text = String(source)
  const i = text.indexOf(selector + ' {')
  if (i === -1) return ''
  const j = text.indexOf('}', i)
  return j === -1 ? '' : text.slice(i, j)
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

/**
 * 读文本文件，并把换行统一成 LF。
 *
 * 为什么必须这么做：Windows 上 clone 出来的工作区是 CRLF（core.autocrlf=true，
 * 或 .gitattributes 里 text=auto 的原生换行），而下面有一批断言把 "\n" 直接写进了
 * 源码片段里（例如 "appendChild(frag);\n    staggerList();"）。那些断言验的是
 * **代码内容**，不该因为换行符在别人机器上失败 —— 失败信息还会看着像"代码坏了"。
 */
function readLf(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
}

const html = readLf(INDEX)
const css = readLf(APP_CSS)
const src = readLf(APP_JS)
const mirrorSrc = readLf(path.join(LIB, 'mirror.js'))
const serverSrc = readLf(path.join(LIB, 'server.js'))
const indexSrc = readLf(path.join(LIB, 'index.js'))

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

// APK 的原生返回键依赖这两个 id：它读 #view-list 判断"是否在聊天页"，
// 在聊天页就点 #btn-back 回列表。改 HTML 若把 id 改掉，返回键会**静默**退化成
// "永远直接退出"，不报任何错。所以在这里钉住。
// （配套的 setView 断言在下面 code 变量声明之后 —— 这个位置还用不了 code。）
has('视图容器 id 是 view-list（APK 返回键判断的就是它）', html, 'id="view-list"')
has('返回按钮 id 是 btn-back（APK 返回键会点击它）', html, 'id="btn-back"')

// 字体：三个页面都要引 font.css，否则登录页/设置页没有 JetBrains Mono
const FONT_CSS = path.join(WEB, 'font.css')
const fontCss = readLf(FONT_CSS)
has('font.css 声明 JetBrains Mono', fontCss, "font-family: 'JetBrains Mono'")
has('font.css 有 400 字重', fontCss, 'font-weight: 400')
has('font.css 有 700 字重', fontCss, 'font-weight: 700')
has('font.css 用 swap 避免阻塞首屏', fontCss, 'font-display: swap')
for (const page of ['index.html', 'login.html', 'setup.html']) {
  const pageSrc = readLf(path.join(WEB, page))
  has(`${page} 引用 /font.css`, pageSrc, 'href="/font.css"')
}
check('字体文件真的在仓库里（两个 TTF，各 >100KB）',
  fs.existsSync(path.join(WEB, 'fonts', 'JetBrainsMono-Regular.ttf')) &&
  fs.existsSync(path.join(WEB, 'fonts', 'JetBrainsMono-Bold.ttf')) &&
  fs.statSync(path.join(WEB, 'fonts', 'JetBrainsMono-Regular.ttf')).size > 100000 &&
  fs.statSync(path.join(WEB, 'fonts', 'JetBrainsMono-Bold.ttf')).size > 100000)
check('附带了 OFL 许可证全文（OFL 要求随字体分发）',
  fs.existsSync(path.join(WEB, 'fonts', 'OFL.txt')) &&
  readLf(path.join(WEB, 'fonts', 'OFL.txt')).includes('SIL OPEN FONT LICENSE Version 1.1'))

// 代码字体只作用于"真的是代码"的地方，正文与思考过程不动。
// 这里只断言"用了哪个字体变量"，不锁字号 —— 见 rule() 的说明。
has('CSS 定义了 --code-font', css, '--code-font: "JetBrains Mono"')
has('CSS 定义了 --mono', css, '--mono: ui-monospace')
has('.md code 用代码字体', rule(css, '.md code'), 'var(--code-font)')
has('代码块用代码字体', rule(css, '.md pre.md-code code'), 'var(--code-font)')
has('工具参数用代码字体', rule(css, '.tool-args'), 'var(--code-font)')
has('调试 JSON 用代码字体', rule(css, '.dbg-json'), 'var(--code-font)')
has('代码块语言名用代码字体', rule(css, '.code-lang'), 'var(--code-font)')
has('思考过程仍用系统等宽', rule(css, '.reason-body'), 'var(--mono)')
hasNot('思考过程不要用代码字体', rule(css, '.reason-body'), 'var(--code-font)')
has('正文不套代码字体', rule(css, '.md'), 'line-height')

// Markdown 新样式的挂钩
for (const cls of ['.md-table', '.md-check', '.md-check.on', '.md-task', '.md del', '.md img',
  '.sheet-block', '.sheet-input']) {
  has(`CSS 有 ${cls}`, css, cls)
}
has('表格容器可横向滚动', css, 'overflow-x:auto')
has('表格斑马纹', css, 'tbody tr:nth-child(even)')

// 「记住我」已经彻底移除
const loginSrc = readLf(path.join(WEB, 'login.html'))
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

// 配套上面「视图容器 id」的断言：光有 id 不够，还得确认 setView 切换的是 view-list。
// 若有人把 setView 改成切 #list，APK 返回键的判断会永远为假 —— 不报错，但返回键失效。
check('setView 切换的是 view-list，不是 list（写成 list 会让返回键永远失效）',
  code.indexOf("els.viewList = $('view-list')") !== -1 &&
  code.indexOf("els.viewList.hidden = name !== 'list'") !== -1)

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

/* ==================== ⑦ 借鉴 DeepSeek 的界面改造 ==================== */
console.log('\n———— ⑦ DeepSeek 风格改造 ————')

// 1. 助手消息不带气泡 —— 借 DeepSeek 最核心的一条：回复是"正文"，不是"消息条"
has('助手消息去气泡', rule(css, '.msg.assistant > .body > .bubble'), 'background:transparent')
has('助手消息铺满栏宽', rule(css, '.msg.assistant > .body'), 'max-width:100%')
has('用户气泡仍然限宽', rule(css, '.msg .body'), 'max-width:min(88%, 680px)')
has('用户气泡有底色', rule(css, '.msg.me > .body > .bubble'), 'var(--me)')

// 2. 代码块头部条 + 复制键
for (const cls of ['.code-block', '.code-head', '.code-lang', '.copy-btn']) {
  has(`CSS 有 ${cls}`, css, `${cls} {`)
}
has('复制成功有反馈样式', css, '.copy-btn.done')
hasNot('语言角标 ::before 已换成真实头部条', css, 'pre.md-code[data-lang]::before')
has('app.js 有 decorateCodeBlocks', code, 'function decorateCodeBlocks(')
has('app.js 在 renderBlocksInto 末尾统一装饰（唯一接缝）', code, 'decorateCodeBlocks(container)')
has('复制走 navigator.clipboard', code, 'navigator.clipboard.writeText')
has('复制有 execCommand 兜底（非 https 下 writeText 会 reject）', code, "document.execCommand('copy')")
has('助手消息也有复制键', code, "copyButton('复制', function () { return plain; })")
has('装饰过的代码块不会重复包一层', code, "pre.parentNode.className === 'code-block'")

// 3. 模式/模型芯片下移到输入区（手机单手操作时顶栏是拇指最难够的区域）
has('index.html 有 .chat-foot', html, 'class="chat-foot"')
has('芯片容器改挂 .chat-sub', html, 'class="chat-sub" id="chat-sub"')
hasNot('顶栏不再放芯片容器', html, 'class="topbar-sub" id="chat-sub"')
check('芯片条排在输入框之前（紧贴其上方）',
  html.indexOf('id="chat-sub"') !== -1 && html.indexOf('id="chat-sub"') < html.indexOf('id="composer"'))
has('发送键做成圆形', rule(css, '.composer .btn-send'), 'border-radius:50%')
has('发送键保留可访问名', html, 'aria-label="发送"')

// 4. 消息里的"块芯片"改名，不再和顶栏芯片撞规则（同名时后者会覆盖前者的全部重叠属性）
has('块芯片改用 .block-chip', code, "'block-chip block-chip-'")
has('CSS 有 .block-chip', css, '.block-chip {')
hasNot('app.js 不再把块芯片叫 chip', code, "el.className = 'chip chip-'")

// 5. 会话列表：扁平行 + 时间靠右
has('会话行不再是卡片', rule(css, '.session'), 'background:transparent')
has('会话行用分隔线分条', rule(css, '.session'), 'border-bottom')
has('时间挂在行右端', code, 'if (sub.textContent) btn.appendChild(sub)')
has('分组标题走小号灰字', rule(css, '.group-name'), 'var(--dim)')

/* ==================== ⑧ 两套主题 ==================== */
console.log('\n———— ⑧ 两套主题（跟随系统）————')

has('主页声明支持两套配色', html, 'name="color-scheme" content="light dark"')
has('地址栏颜色跟系统走（深）', html, 'media="(prefers-color-scheme: dark)"')
has('地址栏颜色跟系统走（浅）', html, 'media="(prefers-color-scheme: light)"')
has('app.css 声明 color-scheme', css, 'color-scheme: light dark')
has('app.css 有浅色分支', css, '@media (prefers-color-scheme: light)')
for (const page of ['login.html', 'setup.html']) {
  const pageSrc = readLf(path.join(WEB, page))
  has(`${page} 也跟系统走`, pageSrc, '@media (prefers-color-scheme: light)')
  has(`${page} 声明支持两套配色`, pageSrc, 'name="color-scheme" content="light dark"')
}

/**
 * 把两个主题块从 CSS 里挖掉（换成等长空白，行号不变），再扫描剩下的部分。
 * 不挖掉的话，`:root` 里那一堆颜色字面量会把扫描结果全占满。
 */
function withoutThemeBlocks(source) {
  let text = String(source)
  const cuts = []
  const rootAt = text.indexOf(':root {')
  if (rootAt !== -1) cuts.push([rootAt, text.indexOf('\n}', rootAt) + 2])
  const lightAt = text.indexOf('@media (prefers-color-scheme: light) {')
  if (lightAt !== -1) {
    const closeAt = text.indexOf('\n}\n', lightAt)
    cuts.push([lightAt, closeAt === -1 ? text.length : closeAt + 3])
  }
  for (const [a, b] of cuts) {
    // 换成**等长空格**而不是删掉：删掉会让后面那一段的偏移量整体前移，
    // 于是第二个块就切错位置了（而且行号也会对不上）。
    text = text.slice(0, a) + text.slice(a, b).replace(/[^\n]/g, ' ') + text.slice(b)
  }
  return text
}

const cssNoTheme = withoutThemeBlocks(css)
const stray = []
cssNoTheme.split('\n').forEach((line, i) => {
  const t = line.trim()
  if (t.startsWith('*') || t.startsWith('/*')) return
  if (/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(line)) stray.push(`第 ${i + 1} 行：${t}`)
})
eq('主题块之外没有硬编码颜色', stray.length, 0)
for (const s of stray.slice(0, 12)) console.log(`        ${s}`)

/**
 * 这两条是主题化的真正护栏：
 *   - 引用了没定义的变量 → var() 没有回退值时会退化成 currentColor，
 *     深色下可能看不出来，浅色下就是一块错色（这次真踩到过一次 --ok-line）。
 *   - 浅色没覆盖某个颜色变量 → 那个变量在浅色下沿用深色值，同样是错色。
 */
const usedVars = [...new Set((css.match(/var\((--[a-z0-9-]+)\)/g) || []).map((s) => s.slice(4, -1)))]
const allDefined = new Set([...css.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]))
const missingVars = usedVars.filter((v) => !allDefined.has(v))
eq('用到的变量都有定义', missingVars.length, 0)
for (const v of missingVars.slice(0, 12)) console.log(`        未定义：${v}`)

const rootBlock = css.slice(css.indexOf(':root {'), css.indexOf('\n}', css.indexOf(':root {')))
const lightAt = css.indexOf('@media (prefers-color-scheme: light) {')
const lightBlock = lightAt === -1 ? '' : css.slice(lightAt, css.indexOf('\n}\n', lightAt))
const rootVars = [...rootBlock.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1])
const lightVars = new Set([...lightBlock.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]))
// 字体不随主题变，不要求覆盖
const notOverridden = rootVars.filter((v) => !lightVars.has(v) && v !== '--mono' && v !== '--code-font')
eq('浅色主题覆盖了所有颜色变量', notOverridden.length, 0)
for (const v of notOverridden.slice(0, 12)) console.log(`        浅色漏了：${v}`)

/* ==================== ⑨ P7：动效 ==================== */
console.log('\n———— ⑨ 动效 ————')

// 新消息进场：方向按消息归属区分（自己发的从右、助手的从左）
has('CSS 有 .msg-in 进场动画', css, '.msg-in { animation:msg-in-left')
has('自己发的消息从右侧进场', css, '.msg-in.me { animation-name:msg-in-right; }')
has('CSS 有 msg-in-left 关键帧', css, '@keyframes msg-in-left {')
has('CSS 有 msg-in-right 关键帧', css, '@keyframes msg-in-right {')
has('进场动画尊重 prefers-reduced-motion', css, '@media (prefers-reduced-motion:reduce) { .msg-in { animation:none; } }')

// 这条是这轮最要紧的护栏：进场动画只能加在"实时新增"的节点上。
// 快照重建一次插几十条历史，若都加动画，打开会话时一屏会同时乱动。
has('state 里有 replaying 标志', code, 'replaying: false')
has('applySnapshot 期间置位 replaying', code, 'state.replaying = true')
has('appendEvent 只对实时新增加 msg-in', code,
  "if (host === els.stream && !state.replaying) node.classList.add('msg-in')")
check('replaying 用 try/finally 复位（渲染中途抛错也不会卡在 true）',
  code.indexOf('state.replaying = true;\n    try {') !== -1 &&
  code.indexOf('} finally {\n      state.replaying = false;\n    }') !== -1)

// 会话列表错开进场
has('CSS 有列表进场动画', css, '.list-in { animation:list-in')
has('CSS 有 list-in 关键帧', css, '@keyframes list-in {')
has('列表进场尊重 prefers-reduced-motion', css, '@media (prefers-reduced-motion:reduce) { .list-in { animation:none; } }')
has('有 staggerList', code, 'function staggerList()')
has('有错开收集器', code, 'function collectStagger(node, out)')
has('renderSessions 收尾调用 staggerList', code, 'els.list.appendChild(frag);\n    staggerList();')
// 列表每 10 秒会整棵重建（renderSessions 先 textContent=''），必须只播一次，
// 否则界面每 10 秒闪一次。
has('错开进场只播一次（有标志）', code, 'var listStaggered = false;')
has('标志生效（已播过就返回）', code, 'if (listStaggered || reducedMotion()) return;')
// 延迟封顶：会话多时不能让最后一行排到一秒以后
has('错开延迟有封顶', code, 'Math.min(i, 11) * 24')

// 流式输出的"正在写"渐变呼吸条
has('流式气泡有渐变呼吸条', css, '.live-bubble::after {')
has('呼吸条用渐变（且颜色走变量，不写死）', css,
  'background:linear-gradient(180deg, transparent, var(--accent), transparent);')
has('CSS 有 cursor-breathe 关键帧', css, '@keyframes cursor-breathe')
has('呼吸条尊重 prefers-reduced-motion', css, '.live-bubble::after { animation:none; opacity:.7; }')

// 折叠卡展开
has('折叠卡展开有内容动画', css, 'details.fold[open] > *:not(summary) { animation:fold-in')
has('CSS 有 fold-in 关键帧', css, '@keyframes fold-in {')
has('展开时箭头旋转', css, 'details.fold[open] > summary .group-caret { transform:rotate(180deg); }')
has('折叠卡展开尊重 prefers-reduced-motion', css,
  'details.fold[open] > *:not(summary) { animation:none; }')

// 提示条与悬浮件
has('CSS 有 toast 进场', css, '.toast { animation:toast-in')
has('CSS 有 toast 退场', css, '.toast.toast-out { animation:toast-out')
has('CSS 有 toast-in 关键帧', css, '@keyframes toast-in {')
has('CSS 有 toast-out 关键帧', css, '@keyframes toast-out {')
has('有 hideToast（先播退场再隐藏）', code, 'function hideToast()')
has('hideToast 加的是 toast-out 类', code, "els.toast.classList.add('toast-out')")
has('回到最新按钮有进场', css, '.to-bottom { animation:rise-in')
has('断线横幅有进场', css, '.banner { animation:drop-in')
has('顶栏提示有进场', css, '.top-hint { animation:hint-in')
has('悬浮件尊重 prefers-reduced-motion', css,
  '.toast, .toast.toast-out, .to-bottom, .banner, .top-hint { animation:none; }')

// 提问卡片选中反馈
has('选中项勾号弹出', css, '.q-opt.on .q-mark { animation:mark-pop')
has('CSS 有 mark-pop 关键帧', css, '@keyframes mark-pop {')
has('勾号弹出尊重 prefers-reduced-motion', css, '.q-opt.on .q-mark { animation:none; }')

// 换会话时顶栏标题淡入
has('顶栏标题有进场', css, '.topbar-title.title-in { animation:title-in')
has('CSS 有 title-in 关键帧', css, '@keyframes title-in {')
has('只在会话真的变了时才播标题动画', code, 'headerSession !== state.sessionId')

// 面板遮罩
has('面板遮罩淡入', css, '.sheet-backdrop { animation:backdrop-in')
has('CSS 有 backdrop-in 关键帧', css, '@keyframes backdrop-in {')

// 发送按钮反馈
has('发送成功有脉冲环', css, '.btn-send.pulse::after {')
has('CSS 有 send-pulse 关键帧', css, '@keyframes send-pulse {')
has('发送失败有抖动', css, '.btn-send.shake { animation:send-shake')
has('CSS 有 send-shake 关键帧', css, '@keyframes send-shake {')
has('有 flashSend 助手', code, 'function flashSend(kind)')
has('发送成功调 flashSend(pulse)', code, "flashSend('pulse')")
has('发送失败调 flashSend(shake)', code, "flashSend('shake')")
has('按钮反馈尊重 prefers-reduced-motion', css,
  '.btn-send.pulse::after, .btn-send.shake { animation:none; }')

// 列表页 ↔ 聊天页转场
// 顶栏两个视图共用同一个名字 —— 转场时原地交叉淡化、不位移，
// 只有内容区滑动，"外壳不动"的层次感就来自这里。
has('CSS 顶栏两个视图共用转场名', css, '.topbar { view-transition-name:v-topbar; }')
has('CSS 给列表内容区起转场名', css, '#view-list .scroll { view-transition-name:v-list-body; }')
has('CSS 给聊天内容区起转场名', css, '#view-chat .stream-wrap { view-transition-name:v-chat-body; }')
has('CSS 给输入区起转场名', css, '#view-chat .chat-foot { view-transition-name:v-composer; }')
has('顶栏用显式淡入淡出（不用默认的 plus-lighter）', css,
  '::view-transition-new(v-topbar) { animation:vtx-fade-in .22s ease both; mix-blend-mode:normal; }')
has('CSS 有 forward 方向的转场', css, 'html[data-nav="forward"]::view-transition-old(v-list-body)')
has('forward 时新页从右侧进', css, 'html[data-nav="forward"]::view-transition-new(v-chat-body)')
has('forward 时输入区从下方进', css, 'html[data-nav="forward"]::view-transition-new(v-composer)')
has('CSS 有 back 方向的转场', css, 'html[data-nav="back"]::view-transition-new(v-list-body)')
has('back 时聊天内容右退', css, 'html[data-nav="back"]::view-transition-old(v-chat-body)')
has('back 时输入区下退', css, 'html[data-nav="back"]::view-transition-old(v-composer)')
has('CSS 有 vtx-in-right 关键帧', css, '@keyframes vtx-in-right')
has('CSS 有 vtx-out-left 关键帧', css, '@keyframes vtx-out-left')
has('setView 用 View Transitions API', code, 'document.startViewTransition(apply)')
has('setView 先特性检测（不支持时直接切，无副作用）', code,
  "typeof document.startViewTransition !== 'function'")
has('转场尊重 prefers-reduced-motion', code,
  "window.matchMedia('(prefers-reduced-motion: reduce)').matches")
check('方向写在 html[data-nav] 上，供 CSS 选择',
  code.indexOf("document.documentElement.setAttribute('data-nav'") !== -1)

// 点击反馈：原来有 :active 却没有 transition，缩放是瞬间跳变、看不出来
has('可点元素统一补了 transition', css,
  '.icon-btn, .btn, .ghost-btn, .btn-stop, .chip, .opt, .effort, .q-opt, .to-bottom {')
check('点击反馈只过渡 transform 与颜色（不碰布局属性，不引起重排）',
  css.indexOf('transition:transform .1s ease, background-color .14s ease, border-color .14s ease;') !== -1)

// 转场名与 backdrop-filter 不能落在同一个元素上。
// 按 CSS View Transitions 规范 §2.1.1，view-transition-name 不是 none 的元素
// （**任何时候**，不只在转场期间）会形成一个 backdrop root —— 让带 backdrop-filter
// 的元素去当 backdrop root，等于给自己的磨砂玻璃换底色。
// 当前 .topbar 两者都曾是，模糊已按"无效功"移除；这条防的是以后有人加回来。
// 先把注释剥掉再查 —— .topbar 那条注释里就写着 backdrop-filter，不剥等于自欺。
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
const topbarRule = cssNoComments.slice(
  cssNoComments.indexOf('.topbar {'),
  cssNoComments.indexOf('}', cssNoComments.indexOf('.topbar {')))
check('顶栏没有 backdrop-filter（背后是纯色，模糊是无效功，且会与转场名形成 backdrop root）',
  topbarRule.indexOf('backdrop-filter') === -1)

/* ---------------------------------------------------------------------
 * 性能护栏：动画只许动 transform 与 opacity。
 *
 * 用**白名单**而不是黑名单 —— 黑名单只能挡住想到的那些布局属性，
 * 白名单能把没想到的也一起挡住。这条比"动画好不好看"重要得多：
 * 动 width/height/top 会触发重排，手机上立刻掉帧。
 * ------------------------------------------------------------------- */
const kfSteps = []
// 关键帧的每个档位都长这样：from { ... } / to { ... } / 0%, 100% { ... }
// 普通规则不会以 from/to/百分比开头，所以这个匹配不会误伤别的地方。
for (const m of cssNoComments.matchAll(/(?:from|to|\d+%)(?:\s*,\s*(?:from|to|\d+%))*\s*\{([^{}]*)\}/g)) {
  kfSteps.push(m[1])
}
check('关键帧扫描确实抓到了内容（正则没失效）', kfSteps.length > 20)
const kfBad = new Set()
for (const step of kfSteps) {
  for (const decl of step.split(';')) {
    const colon = decl.indexOf(':')
    if (colon === -1) continue
    const prop = decl.slice(0, colon).trim().toLowerCase()
    if (prop && prop !== 'transform' && prop !== 'opacity') kfBad.add(prop)
  }
}
eq('关键帧只动 transform / opacity（不触发重排）',
  kfBad.size ? [...kfBad].join(', ') : '无', '无')
check('过渡也没有涉及布局属性',
  !/transition:[^;]*\b(width|height|top|left|right|bottom|margin|padding|font-size)\b/.test(css))

/* ==================== ⑩ 桌面设置面板（客户端 bundle）==================== */
console.log('\n———— ⑩ 桌面设置面板 ————')

const CLIENT_JS = path.join(LIB, 'client.js')
const clientSrc = readLf(CLIENT_JS)
const clientCode = codeOnly(clientSrc)

// ① bundle 包裹格式：DSH 的客户端模块系统只认这一个入口形状，
//    写错的话浏览器连 factory 都注册不上，而宿主侧**不会**报错。
check('用 __ModuleLoader__.load 注册 factory', /window\.__ModuleLoader__\.load\(\{/.test(clientCode))
check('bundle id 就是包名', /id:\s*["']dsh-mobile-mirror["']/.test(clientCode))
check('factory 接收 require', /factory:\s*\(require\)\s*=>/.test(clientCode))
check('导出 apply', /exports\.apply\s*=/.test(clientCode))
check('导出 inject = [slots]', /exports\.inject\s*=\s*\[["']slots["']\]/.test(clientCode))
check('没有 ESM 语法（bundle 是 CJS factory）', !/^\s*(import|export)\s/m.test(clientCode))
check('client.js 有实际内容（不是空壳）', clientSrc.length > 8000, String(clientSrc.length))

// ② 槽注册：id / order / label 任一处写错都不会报错，只会安静地少一页或顶掉官方页。
has('用 slots.inject 等槽被声明出来', clientCode, 'slots.inject')
has('注册到 settings.section', clientCode, 'settings.section')
has('槽内 id 是自己的', clientCode, 'const SECTION_ID = "mobile-mirror"')
has('导航文字是「手机镜像」', clientCode, 'const SECTION_LABEL = "手机镜像"')
has('order 排在官方五页（最大 20）之后', clientCode, 'const SECTION_ORDER = 30')
check('用 slots.register 注册组件', /slots\.register\(\s*\{/.test(clientCode))

// ③ 两侧路径必须逐字一致：写错的话面板只会安静地显示"读不到主机信息"。
const clientPath = /const INFO_PATH = "([^"]+)"/.exec(clientCode)
const hostPath = /export const PANEL_ROUTE = '([^']+)'/.exec(indexSrc)
check('客户端写死了 INFO_PATH', !!clientPath)
check('主机侧写死了 PANEL_ROUTE', !!hostPath)
eq('两侧路径逐字一致', clientPath && clientPath[1], hostPath && hostPath[1])
eq('路径就是 /dsh-mirror/info.json', clientPath && clientPath[1], '/dsh-mirror/info.json')
has('主机侧真的注册了这条路由', indexSrc, 'webServer.register')

// ④ 失败姿势与安全边界。
hasNot('面板不注入 HTML', clientCode, 'dangerouslySetInnerHTML')
hasNot('面板不碰口令哈希', clientCode, 'passwordHash')
check('fetch 用 no-store，避免拿到缓存的旧 IP', /cache:\s*"no-store"/.test(clientCode))
check('挂载时定时刷新、卸载时清掉定时器', /setInterval\(/.test(clientCode) && /clearInterval\(/.test(clientCode))
check('样式元素在卸载时移除', /el\.remove\(\)/.test(clientCode))
check('拿不到 react 只打日志、不抛错', /React === null/.test(clientCode) && /console\.warn/.test(clientCode))
check('拿不到 slots 只打日志、不抛错', clientCode.includes('没有 slots 服务'))
check('主机侧那条路由是仅回环的', indexSrc.includes('fromLoopback(req)') && indexSrc.includes('loopback only'))

// ⑤ 面板样式不许污染宿主界面：全部挂在 .mm- 前缀下。
const cssBlock = (clientCode.split('const CSS = `')[1] || '').split('`')[0]
check('抓到了面板样式块（正则没失效）', cssBlock.length > 500, String(cssBlock.length))
const badSel = [...cssBlock.matchAll(/(?:^|\})\s*([^@{}]+?)\s*\{/gm)]
  .map((m) => m[1].trim())
  .filter((sel) => sel && !sel.split(',').every((one) => one.trim().startsWith('.mm-')))
eq('面板样式全部挂在 .mm- 前缀下', badSel.length ? badSel.join(' | ') : '无', '无')
has('面板用的是 DSH 主题 token（明暗主题自动跟随）', cssBlock, '--dsw-alias-')

/* ---------------------------------------------------------------------
 * 引用的关键帧名必须真的存在。
 *
 * 名字打错时 CSS **不会报错**，动画只是不动 —— 在真机上跟"没做"长得一模一样，
 * 很难查。这条把"静默失效"变成"测试变红"。
 * ------------------------------------------------------------------- */
const kfNames = new Set()
for (const m of cssNoComments.matchAll(/@keyframes\s+([\w-]+)/g)) kfNames.add(m[1])
const kfMissing = new Set()
for (const m of cssNoComments.matchAll(/animation(?:-name)?\s*:\s*([^;}\n]+)/g)) {
  for (const raw of m[1].split(/[\s,]+/)) {
    const t = raw.trim()
    if (!t) continue
    // 跳过时间、缓动函数（含逗号会被切开）、以及关键字
    if (t === 'none' || /^[.\d]/.test(t) || t.indexOf('(') !== -1 || t.indexOf(')') !== -1) continue
    if (/^(ease|linear|infinite|both|forwards|backwards|normal|reverse|alternate|running|paused|step)/.test(t)) continue
    if (!kfNames.has(t)) kfMissing.add(t)
  }
}
eq('引用的关键帧都真的定义了（打错名字动画会静默失效）',
  kfMissing.size ? [...kfMissing].join(', ') : '无', '无')
check('关键帧名扫描确实抓到了内容（正则没失效）', kfNames.size > 20)

console.log(`\n${passed}/${passed + failed} 通过`)
if (failed > 0) process.exitCode = 1
