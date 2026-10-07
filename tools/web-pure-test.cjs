/* 手机界面纯函数 / 静态资源检查（在仓库里，可重复运行）
 * 用法：node tools/web-pure-test.cjs
 * 内容：① index.html 资源引用与占位符检查
 *      ② 把 app.js 复制成 .cjs 后 require，取出纯函数跑用例
 * 说明：P3 新增的纯函数用例在 tools/web-test.mjs，两者互补。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const WEB = path.join(__dirname, '..', 'lib', 'web');
const APP_JS = path.join(WEB, 'app.js');
const APP_CSS = path.join(WEB, 'app.css');
const INDEX = path.join(WEB, 'index.html');
const ALLOWED = ['USERNAME', 'SCHEME', 'PORT', 'SECURE', 'ENABLE_PROMPT'];

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; failures.push(name); console.log('  FAIL  ' + name + (extra ? '  ← ' + extra : '')); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, 'got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected));
}
function has(name, haystack, needle) {
  ok(name, String(haystack).indexOf(needle) !== -1, '缺少 ' + JSON.stringify(needle));
}
function hasNot(name, haystack, needle) {
  ok(name, String(haystack).indexOf(needle) === -1, '不该出现 ' + JSON.stringify(needle));
}

/* ---------------- ① index.html 静态检查 ---------------- */
console.log('\n[1] index.html 资源引用与占位符');
const html = fs.readFileSync(INDEX, 'utf8');

ok('存在 <link rel="stylesheet" href="/app.css">', /<link[^>]+rel=["']stylesheet["'][^>]+href=["']\/app\.css["']/.test(html));
ok('存在 <script defer src="/app.js">', /<script[^>]+defer[^>]+src=["']\/app\.js["']/.test(html));
ok('app.css 文件存在且非空', fs.existsSync(APP_CSS) && fs.statSync(APP_CSS).size > 0);
ok('app.js 文件存在且非空', fs.existsSync(APP_JS) && fs.statSync(APP_JS).size > 0);

const placeholders = [];
const phRe = /\{\{([A-Za-z0-9_]*)\}\}/g;
let m;
while ((m = phRe.exec(html)) !== null) placeholders.push(m[1]);
const illegal = placeholders.filter((k) => ALLOWED.indexOf(k) === -1);
ok('没有非法/未替换占位符（仅允许 ' + ALLOWED.join(', ') + '）', illegal.length === 0, illegal.join(','));
ok('用到了 {{USERNAME}}', placeholders.indexOf('USERNAME') !== -1);
ok('用到了 {{ENABLE_PROMPT}}', placeholders.indexOf('ENABLE_PROMPT') !== -1);

/* 额外：零 CDN / 零内联脚本 */
hasNot('没有 http(s) 外链资源', html, 'src="http');
hasNot('没有内联 <style>', html, '<style');
const inlineScript = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i.exec(html);
ok('没有内联 <script> 代码', !inlineScript || inlineScript[1].trim() === '');

/* ---------------- ② 纯函数用例 ---------------- */
console.log('\n[2] app.js 纯函数（复制为 .cjs 后 require）');
const tmp = path.join(os.tmpdir(), 'dsh-mm-verify-app-' + process.pid + '.cjs');
fs.copyFileSync(APP_JS, tmp);
let P = null;
try {
  P = require(tmp);
} catch (e) {
  ok('require(app.js) 成功', false, e && e.message);
}
if (P) {
  ok('require(app.js) 成功且导出纯函数集', typeof P === 'object' && typeof P.esc === 'function');
  ok('导出项齐全', ['esc', 'renderMarkdown', 'relTime', 'summarizeArgs', 'formatToolArgs', 'formatUsage', 'blocksToText', 'blockChip', 'sessionLabel', 'sessionSubtitle', 'turnEndText'].every((k) => typeof P[k] === 'function'));

  console.log('\n  -- esc / XSS --');
  const xss = P.esc('<img src=x onerror=alert(1)>');
  hasNot('esc: 尖括号被转义（无 <img）', xss, '<img');
  has('esc: 含 &lt;img', xss, '&lt;img');
  has('esc: onerror 仍在但已惰性化', xss, 'onerror=alert(1)');
  hasNot('esc: 双引号被转义', P.esc('a"b'), '"');
  eq('esc: null → 空串', P.esc(null), '');
  eq('esc: & 优先转义', P.esc('&<>'), '&amp;&lt;&gt;');

  console.log('\n  -- renderMarkdown --');
  const codeMd = P.renderMarkdown('```\n<b>bold</b>\n```');
  has('代码块: <b> 保持字面（&lt;b&gt;）', codeMd, '&lt;b&gt;bold&lt;/b&gt;');
  hasNot('代码块: 不产生真实 <b> 元素', codeMd, '<b>');
  has('代码块: 包在 pre.md-code 里', codeMd, '<pre class="md-code"');
  const codeJs = P.renderMarkdown('```js\nconst a = 1 < 2 && 3 > 2;\n```');
  has('代码块: lang 保留', codeJs, 'data-lang="js"');
  has('代码块: < 保持字面', codeJs, '1 &lt; 2 &amp;&amp; 3 &gt; 2');
  const inlineCode = P.renderMarkdown('看 `a < b **not bold**` 这里');
  has('行内代码: 保持字面', inlineCode, '<code>a &lt; b **not bold**</code>');
  hasNot('行内代码: 内部不做标记替换', inlineCode, '<strong>');

  const md = P.renderMarkdown([
    '# 一级标题',
    '## 二级 **粗**',
    '',
    '段落一行',
    '段落二行',
    '',
    '- 项目 A',
    '- 项目 B',
    '',
    '1. 第一',
    '2. 第二',
    '',
    '> 引用内容',
    '',
    '---',
    '',
    '链接 [文档](https://example.com/a?b=1&c=2) 与 *斜体* 与 `code`'
  ].join('\n'));
  has('标题 h1', md, '<h1>一级标题</h1>');
  has('标题 h2 + 粗体', md, '<h2>二级 <strong>粗</strong></h2>');
  has('段落换行 → <br>', md, '<p>段落一行<br>段落二行</p>');
  has('无序列表', md, '<ul><li>项目 A</li><li>项目 B</li></ul>');
  has('有序列表', md, '<ol><li>第一</li><li>第二</li></ol>');
  has('引用', md, '<blockquote>引用内容</blockquote>');
  has('水平线', md, '<hr>');
  has('https 链接可用', md, '<a href="https://example.com/a?b=1&amp;c=2"');
  has('斜体', md, '<em>斜体</em>');
  has('行内代码', md, '<code>code</code>');

  const badLink = P.renderMarkdown('[点我](javascript:alert(1))');
  hasNot('javascript: 链接降级（无 <a）', badLink, '<a');
  has('javascript: 链接降级为纯文本', badLink, '[点我](javascript:alert(1))');
  const badLink2 = P.renderMarkdown('[x](data:text/html,<script>1</script>)');
  hasNot('data: 链接降级', badLink2, '<a');

  const rawXss = P.renderMarkdown('<script>alert(1)</script>');
  hasNot('Markdown 里的 script 被转义', rawXss, '<script>');
  has('Markdown 里的 script 转义结果', rawXss, '&lt;script&gt;');

  console.log('\n  -- renderMarkdown: P4 新增语法 --');

  // 表格（GFM）：以前整段退化成带 <br> 的段落，是这次最主要的修复
  const table = P.renderMarkdown([
    '| 名称 | 值 | 说明 |',
    '|:-----|----:|:----:|',
    '| a | 1 | 左对齐 |',
    '| b | 2 | 居中 |'
  ].join('\n'));
  has('表格: 生成 table', table, '<table>');
  has('表格: 表头左对齐', table, '<th style="text-align:left">名称</th>');
  has('表格: 表头右对齐', table, '<th style="text-align:right">值</th>');
  has('表格: 表头居中', table, '<th style="text-align:center">说明</th>');
  has('表格: 表体单元格', table, '<td style="text-align:left">a</td>');
  has('表格: 外层容器可横向滚动', table, '<div class="md-table">');
  hasNot('表格: 不再退化成裸竖线文本', table, '| 名称 |');

  const tableEsc = P.renderMarkdown('| a | b |\n|---|---|\n| x\\|y | 2 |');
  has('表格: 转义的 \\| 不当分隔符', tableEsc, '<td>x|y</td>');

  const tablePara = P.renderMarkdown('| a |\n|---|\n| 1 |\n\n正文');
  has('表格: 后面的段落正常收尾', tablePara, '</table></div>\n<p>正文</p>');

  // 嵌套列表：以前缩进被丢掉，三级全拍平成一级
  eq('嵌套列表: 三层结构完整', P.renderMarkdown('- 一级\n  - 二级\n    - 三级\n- 又一级'),
    '<ul><li>一级<ul><li>二级<ul><li>三级</li></ul></li></ul></li><li>又一级</li></ul>');

  // 任务列表
  const tasks = P.renderMarkdown('- [ ] 没做\n- [x] 做了');
  has('任务列表: 未勾选', tasks, '<li class="md-task"><span class="md-check" aria-hidden="true"></span>没做</li>');
  has('任务列表: 已勾选', tasks, '<span class="md-check on" aria-hidden="true"></span>做了');

  // 强调的嵌套与边界
  eq('粗体里套斜体（以前解析错乱）', P.renderMarkdown('**粗 *斜* 粗**'),
    '<p><strong>粗 <em>斜</em> 粗</strong></p>');
  eq('粗斜体三连星', P.renderMarkdown('***又粗又斜***'), '<p><strong><em>又粗又斜</em></strong></p>');
  eq('删除线', P.renderMarkdown('这是 ~~删掉~~ 的字'), '<p>这是 <del>删掉</del> 的字</p>');
  eq('下划线斜体', P.renderMarkdown('这是 _斜体_ 的字'), '<p>这是 <em>斜体</em> 的字</p>');
  eq('snake_case 不被当斜体', P.renderMarkdown('变量 my_long_name 在这'), '<p>变量 my_long_name 在这</p>');
  eq('未闭合的 ** 原样保留', P.renderMarkdown('这里有 ** 两个星号'), '<p>这里有 ** 两个星号</p>');
  eq('空内容的 ** 不成对', P.renderMarkdown('a **** b'), '<p>a **** b</p>');

  // 有序列表起始号：以前 3. 开头也渲染成 1.
  eq('有序列表认起始号', P.renderMarkdown('3. 三\n4. 四'), '<ol start="3"><li>三</li><li>四</li></ol>');

  // 列表续行：以前会断成独立段落
  eq('列表续行并进同一项', P.renderMarkdown('- 第一项\n  继续说明\n- 第二项'),
    '<ul><li>第一项<br>继续说明</li><li>第二项</li></ul>');

  // 图片 / 带标题的链接 / 自动链接
  has('图片', P.renderMarkdown('![图](https://x.com/a.png)'),
    '<img src="https://x.com/a.png" alt="图" loading="lazy">');
  hasNot('javascript: 图片降级（无 <img）', P.renderMarkdown('![x](javascript:alert(1))'), '<img');
  has('带标题的链接', P.renderMarkdown('[点我](https://a.com "标题")'),
    '<a href="https://a.com" target="_blank" rel="noopener noreferrer" title="标题">点我</a>');
  has('自动链接 <url>', P.renderMarkdown('见 <https://a.com/x>'),
    '<a href="https://a.com/x" target="_blank" rel="noopener noreferrer">https://a.com/x</a>');
  hasNot('非 http 的尖括号不自动链接', P.renderMarkdown('<foo@bar.com>'), '<a');

  has('代码块语言属性仍在（角标靠 CSS 渲染）', P.renderMarkdown('```python\nx=1\n```'), 'data-lang="python"');

  console.log('\n  -- relTime 边界 --');
  const T = 1700000000000;
  eq('relTime(0 秒)', P.relTime(T, T), '刚刚');
  eq('relTime(59 秒)', P.relTime(T - 59000, T), '刚刚');
  eq('relTime(60 秒)', P.relTime(T - 60000, T), '1 分钟前');
  eq('relTime(90 秒)', P.relTime(T - 90000, T), '1 分钟前');
  eq('relTime(2 小时)', P.relTime(T - 2 * 3600 * 1000, T), '2 小时前');
  eq('relTime(23 小时)', P.relTime(T - 23 * 3600 * 1000, T), '23 小时前');
  eq('relTime(24 小时=1 天)', P.relTime(T - 24 * 3600 * 1000, T), '1 天前');
  eq('relTime(3 天)', P.relTime(T - 3 * 86400 * 1000, T), '3 天前');
  eq('relTime(40 天)', P.relTime(T - 40 * 86400 * 1000, T), '1 个月前');
  eq('relTime(未来时间)', P.relTime(T + 5000, T), '刚刚');
  eq('relTime(null)', P.relTime(null, T), '');

  console.log('\n  -- Block / 参数 / usage 渲染 --');
  const blocks = [
    { type: 'text', text: '正文一' },
    { type: 'reasoning', text: '思考' },
    { type: 'text', text: '正文二' },
    { type: 'image', attachmentId: 'a1', mediaType: 'image/png', width: 800, height: 600, bytes: 34567 },
    { type: 'file', name: 'report.pdf', bytes: 2048, attachmentId: 'a2' },
    { type: 'tool-call', id: 'c1', name: 'read_file', args: '{"path":"a.js"}' },
    { type: 'mystery' }
  ];
  const btext = P.blocksToText(blocks);
  has('blocksToText: 拼接 text', btext, '正文一');
  has('blocksToText: 拼接 text2', btext, '正文二');
  hasNot('blocksToText: 不含 reasoning', btext, '思考');
  has('blocksToText: 图片占位', btext, '[图片]');
  has('blocksToText: 文件占位', btext, '[文件 report.pdf]');
  eq('blocksToText: 非数组 → 空', P.blocksToText(null), '');
  ok('blocksToText: 截断', P.blocksToText([{ type: 'text', text: 'x'.repeat(50) }], 10).length === 10);

  eq('blockChip(image).kind', P.blockChip(blocks[3]).kind, 'image');
  has('blockChip(image).label 尺寸', P.blockChip(blocks[3]).label, '800×600');
  has('blockChip(image).label 大小', P.blockChip(blocks[3]).label, '34 KB');
  has('blockChip(file).label', P.blockChip(blocks[4]).label, 'report.pdf');
  eq('blockChip(text) → null', P.blockChip({ type: 'text', text: 'x' }), null);
  eq('blockChip(未知 type).kind', P.blockChip({ type: 'mystery' }).kind, 'other');

  const full = JSON.stringify({ path: 'src/a.js', content: 'line1\nline2', n: 3 });
  has('summarizeArgs: 一行 key=value', P.summarizeArgs(full), 'path=src/a.js');
  hasNot('summarizeArgs: 不含换行', P.summarizeArgs(full), '\n');
  has('summarizeArgs: 换行被压平', P.summarizeArgs(full), 'content=line1 line2');
  eq('summarizeArgs: 空 → 空串', P.summarizeArgs(''), '');
  eq('summarizeArgs: 截断 JSON 用原文首行', P.summarizeArgs('{"path":"a.js","content":"unterminated'), '{"path":"a.js","content":"unterminated');
  has('summarizeArgs: 长文本会截断', P.summarizeArgs(JSON.stringify({ a: 'x'.repeat(300) }), 20).length <= 20, true);

  const pretty = P.formatToolArgs('{"a":1,"b":[2]}');
  has('formatToolArgs: 合法 JSON 格式化', pretty, '\n  "a": 1');
  eq('formatToolArgs: 截断 JSON 原文', P.formatToolArgs('{"a":1'), '{"a":1');
  eq('formatToolArgs: 空 → 空串', P.formatToolArgs(''), '');
  eq('formatToolArgs: 数组 JSON', P.formatToolArgs('[1,2]'), '[\n  1,\n  2\n]');

  has('formatUsage: 完整', P.formatUsage({ inputTokens: 1234, outputTokens: 567, totalTokens: 1801 }), '输入 1.2k');
  has('formatUsage: 缺字段不报错', P.formatUsage({ outputTokens: 5 }), '输出 5');
  eq('formatUsage(null)', P.formatUsage(null), '');
  eq('formatUsage({})', P.formatUsage({}), '');

  console.log('\n  -- 会话列表降级文本 --');
  eq('sessionLabel: 有 title', P.sessionLabel({ title: '会话标题', cwd: 'D:\\a\\b' }), '会话标题');
  eq('sessionLabel: title=null → cwd 末段', P.sessionLabel({ title: null, cwd: 'D:\\VibeCoding\\Plugin' }), 'Plugin');
  eq('sessionLabel: 全空 → 兜底', P.sessionLabel({ title: null, cwd: null }), '未命名会话');
  // P3 起列表按工作区分组，分组头上已经写了完整路径，
  // 行副标题再补一次文件夹名就是纯噪音 —— 所以只留时间。
  eq('sessionSubtitle: 只给时间（不再重复文件夹名）', P.sessionSubtitle({ title: 'T', cwd: 'D:\\a\\b', updatedAt: T - 90000 }, T), '1 分钟前');
  eq('sessionSubtitle: 无 title 时也只给时间', P.sessionSubtitle({ title: null, cwd: 'D:\\a\\b', updatedAt: T - 90000 }, T), '1 分钟前');

  console.log('\n  -- turn/end 原因 --');
  eq('completed 文案', P.turnEndText('completed').text, '本轮完成');
  eq('completed 不醒目', P.turnEndText('completed').warn, false);
  eq('error 醒目', P.turnEndText('error').warn, true);
  eq('aborted 文案', P.turnEndText('aborted').text, '本轮已中止');
  eq('max-tokens 文案', P.turnEndText('max-tokens').text, '达到 token 上限');
  eq('未知原因降级', P.turnEndText('whatever').text, '本轮结束：whatever');
  eq('未知原因醒目', P.turnEndText('whatever').warn, true);

  console.log('\n  -- P2 发送：文本校验 / 字数 / requestId / payload --');
  eq('normalizePromptText 去首尾空白', P.normalizePromptText('  a b\n '), 'a b');
  eq('normalizePromptText(null)', P.normalizePromptText(null), '');
  eq('空文本 → empty-text', P.promptTextError('   \n '), 'empty-text');
  eq('正常文本无错', P.promptTextError('你好'), '');
  eq('正好 8000 字符通过', P.promptTextError('x'.repeat(8000)), '');
  eq('8001 字符 → text-too-long', P.promptTextError('x'.repeat(8001)), 'text-too-long');
  eq('去空白后判长', P.promptTextError('  ' + 'x'.repeat(8000) + '  '), '');
  eq('counterText 7000 不显示', P.counterText('x'.repeat(7000)).text, '');
  eq('counterText 7001 显示', P.counterText('x'.repeat(7001)).text, '7001/8000');
  eq('counterText 7001 未超限', P.counterText('x'.repeat(7001)).over, false);
  eq('counterText 8000 未超限', P.counterText('x'.repeat(8000)).over, false);
  eq('counterText 8001 超限', P.counterText('x'.repeat(8001)).over, true);

  const uuid = P.newRequestId({ randomUUID: () => 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' }, 1700000000000);
  eq('newRequestId 用 randomUUID', uuid, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890');
  ok('UUID 形态合法（含 "-"）', P.REQUEST_ID_RE.test(uuid));
  const fb1 = P.newRequestId(null, 1700000000000);
  const fb2 = P.newRequestId(undefined, 1700000000000);
  ok('回退 id 合法: ' + fb1, P.REQUEST_ID_RE.test(fb1));
  ok('回退 id 合法: ' + fb2, P.REQUEST_ID_RE.test(fb2));
  ok('回退 id 两次不相同', fb1 !== fb2);
  const dirty = P.newRequestId({ randomUUID: () => 'bad id!!<script>' }, 1);
  ok('非法字符被清掉: ' + JSON.stringify(dirty), P.REQUEST_ID_RE.test(dirty));
  eq('超长 id 截到 128', P.newRequestId({ randomUUID: () => 'x'.repeat(300) }, 1).length, 128);
  ok('randomUUID 抛异常也能回退', P.REQUEST_ID_RE.test(P.newRequestId({ randomUUID: () => { throw new Error('nope'); } }, 5)));

  eq('timeZoneOf 正常取值', P.timeZoneOf({ DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Asia/Shanghai' }) }) }), 'Asia/Shanghai');
  eq('timeZoneOf 拿不到退 UTC', P.timeZoneOf(null), 'UTC');
  eq('timeZoneOf 抛异常退 UTC', P.timeZoneOf({ DateTimeFormat: () => { throw new Error('x'); } }), 'UTC');
  eq('timeZoneOf 空时区退 UTC', P.timeZoneOf({ DateTimeFormat: () => ({ resolvedOptions: () => ({}) }) }), 'UTC');

  const payload = P.buildPromptPayload('sess-1', 'rid-1', '  你好  ', 'Asia/Shanghai');
  eq('payload.sessionId', payload.sessionId, 'sess-1');
  eq('payload.requestId', payload.requestId, 'rid-1');
  eq('payload.text 去空白', payload.text, '你好');
  eq('payload.timeZone', payload.timeZone, 'Asia/Shanghai');
  eq('payload 缺时区退 UTC', P.buildPromptPayload('s', 'r', 't', null).timeZone, 'UTC');
  eq('payload 字段恰好 4 个', Object.keys(payload).sort().join(','), 'requestId,sessionId,text,timeZone');

  const recs = [
    { type: 'user/message', seq: 2, data: { role: 'user', id: 'u', blocks: [{ type: 'text', text: '你好' }] } },
    { type: 'assistant/message', seq: 3, data: { blocks: [{ type: 'text', text: '在' }] } }
  ];
  const M = (r, t) => P.matchPendingAgainstRecords(r, t).join(',');
  eq('对账：命中一个', M(recs, ['你好']), '0');
  eq('对账：前后空白也算命中', M(recs, [' 你好 ']), '0');
  eq('对账：不命中', M(recs, ['别的']), '');
  eq('对账：records 非数组', M(null, ['你好']), '');
  eq('对账：pending 非数组', P.matchPendingAgainstRecords(recs, null).length, 0);
  eq('对账：空 pending', M(recs, []), '');
  eq('对账：多 text block 拼接命中',
    M([{ type: 'user/message', data: { blocks: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }], ['a\nb']), '0');
  eq('对账：同文本发两次、只回显一条 → 只消最老那个', M(recs, ['你好', '你好']), '0');
  eq('对账：两条都回显 → 两个都消',
    M([{ type: 'user/message', data: { blocks: [{ type: 'text', text: 'A' }] } },
       { type: 'user/message', data: { blocks: [{ type: 'text', text: 'B' }] } }], ['A', 'B']), '0,1');
  eq('对账：顺序反了也能按文本配对',
    M([{ type: 'user/message', data: { blocks: [{ type: 'text', text: 'B' }] } }], ['A', 'B']), '1');
  eq('对账：只回显 A 时不动 B',
    M([{ type: 'user/message', data: { blocks: [{ type: 'text', text: 'A' }] } }], ['A', 'B']), '0');
  eq('对账：忽略非 user/message 与空块',
    M([{ type: 'assistant/message', data: { blocks: [{ type: 'text', text: 'A' }] } },
       { type: 'user/message', data: { blocks: [] } }], ['A']), '');

  console.log('\n  -- 源码约束 --');
  const src = fs.readFileSync(APP_JS, 'utf8');
  hasNot('无 .innerHTML 赋值', src, '.innerHTML');
  hasNot('无 import 语句', src, '\nimport ');
  hasNot('无 ESM export', src, '\nexport ');
  hasNot('无 fetch 外链', src, 'fetch("http');
  ok('末尾有 Node 无害导出', /module\.exports\s*=\s*PURE/.test(src));
  ok('幂等规则写进了注释', src.indexOf('重试必须复用同一个 id') !== -1);
}

try { fs.unlinkSync(tmp); } catch (e) { /* 忽略 */ }

/* ---------------- 汇总 ---------------- */
console.log('\n========================================');
console.log('通过 ' + pass + ' / 失败 ' + fail);
if (fail) {
  console.log('失败用例：');
  failures.forEach((f) => console.log('  - ' + f));
}
console.log('========================================');
process.exit(fail ? 1 : 0);
