// 词典覆盖检查（静态）：把 hub/console*.js 和独立页面里所有含中文的字符串/模板片段抽出来，断言每一条英文下都翻得动；
// 服务端会返回给控制台的句子（bad()/HttpError() 的信息、事件文字、巡检问题、历史动作、MCP 工具说明）也一样。
// 模板里的 ${…} 用一组样例值代入（数字、名字、日期、"一"……），任意一组代入后翻得干净就算覆盖。
// 抽不干净的（拼在别的字符串中间的片段）列在下面的白名单里，每条写明为什么——它们由浏览器里的真实扫描（~/am-wt/i18n-scan.mjs）把关。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { extractJs, htmlRuns, inlineScripts, CJK } from './i18n-extract.mjs';
import { loadI18n, HUB } from './i18n-util.mjs';

const I = loadI18n({ lang: 'en' }).AMI18n;
const read = (f) => fs.readFileSync(path.join(HUB, f), 'utf8');

// 白名单：{} 表示模板里的 ${…}。格式 文本 → 原因
const WHITELIST = new Map([
  ['日一二三四五六', '星期的索引串：页面里用 WEEK[i] 取单个字，再由 "周{w}" 规则翻译'],
  ['年', '"{年} 年 {月} 月" 的中间片段，整句由规则 `{n} 年 {n} 月` 翻译'],
  ['{} 月', '同上：整句 "2026 年 11 月" 由规则翻译'],
  ['亿字', '中文下的字数单位；英文下 console-admin.js 的 chars() 走另一支（B/M/K chars）'],
  ['万字', '同上'],
  ['字', '同上'],
  ['万', '中文下的"万"：英文下 console-overview.js 走 K 的另一支'],
  ['{}同步', '"● {}同步" 里嵌着的片段，整句由规则 `● {t}同步` 翻译'],
  ['（列出最早的 {} 条）', '"{} 条（列出最早的 N 条）" 里嵌着的片段，整句由规则 `条（列出最早的 {n} 条）` 翻译'],
  ['{} 凌晨 {}', '年报里 md() 的输出（"11 月 5 日"）拼进来的，整句由规则 `{n} 月 {n} 日 凌晨 {*}` 翻译'],
]);

const sources = [];
for (const f of fs.readdirSync(HUB).filter((x) => /^console.*\.js$/.test(x) && !/^console-i18n/.test(x))) sources.push({ file: f, js: read(f) });
for (const f of ['wall.html', 'wrapped.html']) {
  const html = read(f);
  sources.push({ file: f, js: inlineScripts(html) });
  sources.push({ file: `${f}（标记）`, markup: html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '') });
}
sources.push({ file: 'console.html（标记）', markup: read('console.html').replace(/<script[\s\S]*?<\/script>/g, '') });

const POOL = ['12', 'x', '2026-11-01', '一', '', '停用', '已被取代', '▴', '11-01 12:00', '3 分钟前'];
const SEP = / · |(?<=[）)])· | ·(?=[「（(])|；/; // 和引擎拆分用的分隔符一致：占位符多的长句子按它拆开，每段单独代入
function covered(run) {
  const k = (run.match(/\u0000/g) || []).length;
  if (!k) return !CJK.test(I.t(run));
  const parts = run.split('\u0000');
  const build = (vals) => parts.reduce((a, p, i) => a + p + (i < k ? vals[i] : ''), '');
  if (POOL.some((v) => !CJK.test(I.t(build(new Array(k).fill(v)))))) return true; // 每个占位符都代入同一个值
  if (POOL.length ** k <= 12000) {
    const idx = new Array(k).fill(0);
    for (;;) {
      if (!CJK.test(I.t(build(idx.map((i) => POOL[i]))))) return true;
      let j = 0;
      while (j < k && ++idx[j] === POOL.length) idx[j++] = 0;
      if (j === k) return false;
    }
  }
  return SEP.test(run) && run.split(SEP).every((p) => !CJK.test(p) || covered(p)); // 占位符太多：按引擎拆分用的分隔符拆开，各段单独代入
}

function runsOf(items) {
  const out = [];
  for (const s of items) {
    if (!CJK.test(s.text)) continue;
    const { texts, attrs } = htmlRuns(s.text);
    for (const raw of [...texts, ...attrs]) {
      const t = raw.trim();
      if (CJK.test(t)) out.push({ line: s.line, text: t, depth: s.depth || 0 });
    }
  }
  return out;
}

test('前端：console*.js、大屏、年报里每一条含中文的文字都翻得动（白名单除外）', () => {
  const missing = [];
  let total = 0;
  for (const src of sources) {
    const items = src.markup !== undefined ? [{ line: 0, kind: 'str', text: src.markup, depth: 0 }] : extractJs(src.js);
    for (const r of runsOf(items)) {
      total++;
      const label = r.text.replace(/\u0000/g, '{}');
      if (WHITELIST.has(label)) continue;
      if (!covered(r.text)) missing.push(`${src.file}:${r.line}  ${JSON.stringify(label)}`);
    }
  }
  assert.ok(total > 800, `抽到的文字片段太少（${total}），抽取器可能坏了`);
  assert.deepEqual(missing, [], `没翻的片段 ${missing.length} 条：\n${missing.join('\n')}`);
});

test('白名单里的条目都还在源码里（改掉了就从白名单删掉）', () => {
  const all = new Set();
  for (const src of sources) {
    if (src.markup !== undefined) continue;
    for (const r of runsOf(extractJs(src.js))) all.add(r.text.replace(/\u0000/g, '{}'));
  }
  assert.deepEqual([...WHITELIST.keys()].filter((k) => !all.has(k)), []);
});

// ---- 服务端句子 ----
// 取调用第一个参数的字符串：bad('…')、new HttpError(404, '…')
function firstLiteralsAfter(src, re, span = 900) {
  const out = [];
  for (const m of src.matchAll(re)) {
    const items = extractJs(src.slice(m.index + m[0].length, m.index + m[0].length + span));
    // 取出现位置最靠前的那一条：extractJs 按"读完"的顺序给，模板里嵌套的在前，所以取 depth 为 0 且第一个出现的
    const first = items.find((x) => x.depth === 0);
    if (first) out.push({ line: src.slice(0, m.index).split('\n').length, text: first.text });
  }
  return out;
}

function serverStrings() {
  const out = [];
  const add = (file, items) => { for (const it of items) if (CJK.test(it.text)) out.push({ file, ...it }); };
  for (const f of fs.readdirSync(HUB).filter((x) => /^admin.*\.mjs$/.test(x) || ['share.mjs', 'extras.mjs', 'server.mjs'].includes(x))) {
    const src = read(f);
    add(f, firstLiteralsAfter(src, /\b(?:bad|HttpError)\(\s*(?:\d+\s*,\s*)?(?=[`'"])/g));
  }
  // 事件文字表、历史动作、巡检问题、MCP 工具说明
  const admin = read('admin.mjs');
  for (const name of ['READ_TEXT', 'WRITE_TEXT', 'CONSOLE_TEXT', 'REPORT_TEXT', 'EXTRACT_TEXT']) {
    const m = new RegExp(`const ${name} = \\{[\\s\\S]*?\\};`).exec(admin);
    add('admin.mjs', extractJs(m[0]).map((x) => ({ line: 0, text: x.text })));
  }
  add('admin.mjs', extractJs(admin.slice(admin.indexOf('const talkEvent'), admin.indexOf('function eventOf'))).map((x) => ({ line: 0, text: x.text })));
  add('admin.mjs', extractJs(admin.slice(admin.indexOf('function eventOf'), admin.indexOf('function events('))).map((x) => ({ line: 0, text: x.text })));
  const tools = read('admin-tools.mjs');
  add('admin-tools.mjs', extractJs(tools.slice(tools.indexOf('function actionOf'), tools.indexOf('function actionOf') + 1400)).map((x) => ({ line: 0, text: x.text })));
  add('admin-tools.mjs', extractJs(tools.slice(tools.indexOf('function restorable'), tools.indexOf('async function gitOut'))).map((x) => ({ line: 0, text: x.text })));
  const srv = read('server.mjs');
  add('server.mjs', extractJs(srv.slice(srv.indexOf('function watch()'), srv.indexOf('return [...new Map(problems'))).map((x) => ({ line: 0, text: x.text })));
  for (const f of ['pipeline.mjs', 'convlog.mjs']) {
    const s = read(f);
    const a = s.indexOf('function watchProblems');
    add(f, extractJs(s.slice(a, s.indexOf('return out;', a))).map((x) => ({ line: 0, text: x.text })));
  }
  for (const [f, re] of [['server.mjs', /^    description: /gm], ['cards.mjs', /^    description: /gm]]) add(f, firstLiteralsAfter(read(f), re, 1500));
  add('admin.mjs', [{ text: 'node kb-agent.mjs mcp --client <智能体名>' }]);
  return out;
}

// 服务端句子里不会显示在控制台的（只在 MCP 或设备端用）不在抽取范围里；抽到又翻不了的，列在这里
const SERVER_WHITELIST = new Map([
  ['、', '列表分隔符，由 "，" "、" 的词典条目翻译（这里只是被抽到的片段）'],
]);

test('服务端：返回给控制台的错误信息、事件文字、巡检问题、历史动作、MCP 工具说明都翻得动', () => {
  const missing = [];
  const seen = new Set();
  const list = serverStrings();
  for (const s of list) {
    const label = s.text.replace(/\u0000/g, '{}');
    if (SERVER_WHITELIST.has(label) || seen.has(label)) continue;
    seen.add(label);
    // 服务端句子里的变量（设备名、项目名、数字）用样例代入
    if (!covered(s.text)) missing.push(`${s.file}:${s.line}  ${JSON.stringify(label)}`);
  }
  assert.ok(list.length > 150, `抽到的服务端句子太少（${list.length}）`);
  assert.deepEqual(missing, [], `没翻的服务端句子 ${missing.length} 条：\n${missing.join('\n')}`);
});
