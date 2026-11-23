// H 组：浅色（和深色的几个主要组合）的对比度。文字 ≥ 4.5:1（大标题 ≥ 3:1），图形/色块/状态点 ≥ 3:1。不依赖浏览器。
// 要看完整数值表：THEME_REPORT=1 node --test test/theme-contrast.test.mjs
// 运行：node --test test/theme-contrast.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tokenBlocks, color, over, ratio, lum } from './theme-util.mjs';

const { dark, light } = tokenBlocks();

// 一个主题下的所有检查：[名字, 前景, 背景, 最低对比度]
function checks(map) {
  const c = (k) => color(map.get(k));
  const rgb = (k) => c(k).slice(0, 3);
  const surface = rgb('--surface');
  const panelSolid = rgb('--panel-solid');
  const panel = over(c('--panel'), c('--panel')[3], surface);          // 半透明面板叠在页面底上
  const tint = (token, a, base = panel) => over(rgb(token), a, base);   // 着色底：某个三元组按透明度叠在面板上
  const out = [];
  const add = (name, fg, bg, min) => out.push([name, fg, bg, min]);
  const on = (name, fgKey, bgs, min) => { for (const [bn, bg] of Object.entries(bgs)) add(`${name} 在 ${bn}`, rgb(fgKey), bg, min); };
  const base = { 页面底: surface, 面板: panel, 卡片白底: panelSolid };

  // 正文：主文字、次文字、弱文字（≥ 4.5）
  on('主文字', '--text-primary', base, 7);
  on('次文字', '--text-secondary', base, 4.5);
  on('弱文字', '--text-muted', base, 4.5);
  add('弱文字 在 选中行底（蓝 .22）', rgb('--text-muted'), tint('--blue-rgb', 0.22), 4.5);
  add('弱文字 在 输入框/卡片底', rgb('--text-muted'), over(rgb('--ink-rgb'), 0.7, panel), 4.5);
  add('次文字 在 选中行底（蓝 .22）', rgb('--text-secondary'), tint('--blue-rgb', 0.22), 4.5);
  add('强调字 在 选中底（蓝 .5）', rgb('--text-strong'), tint('--blue-rgb', 0.5), 4.5);
  add('强调字 在 选中底（紫 .4）', rgb('--text-strong'), tint('--violet-rgb', 0.4), 4.5);
  // 链接/强调色（文字用）
  on('强调色（链接）', '--accent', base, 4.5);
  on('强调色 2', '--accent2', base, 4.5);
  // 状态字在各自的着色底上
  add('绿字 在 ok 标签', rgb('--t-green'), tint('--green-rgb', 0.12), 4.5);
  add('琥珀字 在 warn 标签', rgb('--t-amber'), tint('--amber-rgb', 0.10), 4.5);
  add('红字 在 bad 标签', rgb('--t-red'), tint('--red-rgb', 0.10), 4.5);
  add('浅红字 在 错误条', rgb('--t-red2'), tint('--red-rgb', 0.10), 4.5);
  add('蓝字 在 蓝标签', rgb('--t-blue'), tint('--blue-rgb', 0.12), 4.5);
  add('橙字 在 待处理徽标/按钮', rgb('--t-orange'), tint('--orange-rgb', 0.18), 4.5);
  add('橙字 在 橙色卡片', rgb('--t-orange'), tint('--orange-rgb', 0.14), 4.5);
  add('橙字 在 面板', rgb('--t-orange'), panel, 4.5);
  add('浅蓝字 在 引用角标（蓝 .25）', rgb('--t-pale'), tint('--blue-rgb', 0.25, panelSolid), 4.5);
  add('浅蓝字 在 代码块底', rgb('--t-pale'), over(rgb('--code-rgb'), 0.7, panel), 4.5);
  add('标记字 在 命中高亮（琥珀 .28）', rgb('--t-mark'), tint('--amber-rgb', 0.28, panelSolid), 4.5);
  add('标记字 在 搜索结果选中行上的命中高亮（蓝 .26 + 琥珀 .26）', rgb('--t-mark'), tint('--amber-rgb', 0.26, tint('--blue-rgb', 0.26, panelSolid)), 4.5);
  add('弱文字 在 搜索结果选中行（蓝 .26）', rgb('--text-muted'), tint('--blue-rgb', 0.26, panelSolid), 4.5);
  add('搜词字 在 面板', rgb('--t-hot'), panel, 4.5);
  add('绿字 在 差异新增行', rgb('--t-green'), tint('--green-rgb', 0.1, over(rgb('--diff-rgb'), 0.7, panel)), 4.5);
  add('红字 在 差异删除行', rgb('--t-red'), tint('--red-rgb', 0.1, over(rgb('--diff-rgb'), 0.7, panel)), 4.5);
  // 实心渐变按钮上的白字
  for (const k of ['--brand-a', '--brand-b', '--brand-c']) add(`白字 在 ${k}`, rgb('--on-solid'), rgb(k), 4.5);
  // 拓扑里写入/读取的数字（文字）
  on('写入数字（青）', '--tp-up', { 面板: panel, 节点白底: panelSolid }, 4.5);
  on('读取数字（琥珀）', '--tp-dn', { 面板: panel, 节点白底: panelSolid }, 4.5);
  // 图形 ≥ 3
  for (const k of ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7']) on(`项目色 ${k}`, k, { 页面底: surface, 面板: panel }, 3);
  for (const k of ['--ok', '--warn', '--bad', '--brand-a', '--brand-b', '--brand-c', '--accent', '--accent2', '--dot-ok', '--dot-bad', '--dot-idle', '--dot-off', '--dot-paused', '--other-lt', '--kind-project', '--kind-machine', '--kind-site', '--kind-version']) on(`图形 ${k}`, k, { 页面底: surface, 面板: panel }, 3);
  for (const k of ['--k-dev', '--k-gate', '--k-hub', '--k-repo', '--k-ext', '--k-vec', '--k-rep', '--k-web', '--k-talk']) on(`拓扑节点色 ${k}`, k, { 面板: panel, 节点白底: panelSolid }, 3);
  add('未写日志色 在 面板（只要看得见）', rgb('--unwritten'), panel, 1.3);
  for (const k of ['--seq1', '--seq4', '--seq7', '--hot1', '--hot3', '--hot5']) add(`热力色 ${k} 在 面板（≥1.15 能和底色区分）`, rgb(k), panel, 1.15);
  return out;
}

const fmt = (rows) => rows.map(([n, f, b, min]) => `${(ratio(f, b)).toFixed(2).padStart(6)}  ≥${String(min).padEnd(4)}  ${n}`).join('\n');

describe('浅色主题对比度', () => {
  it('文字 ≥ 4.5:1（主文字 ≥ 7），图形 ≥ 3:1，全部组合', () => {
    const rows = checks(light);
    if (process.env.THEME_REPORT) console.log(`浅色，共 ${rows.length} 组：\n${fmt(rows)}`);
    const bad = rows.filter(([, f, b, min]) => ratio(f, b) < min);
    assert.deepEqual(bad.map(([n, f, b, min]) => `${n}：${ratio(f, b).toFixed(2)} < ${min}`), [], '这些组合对比度不够');
    assert.ok(rows.length > 90, `检查了 ${rows.length} 组`);
  });

  it('热力色阶浅色下是"浅→深"（少→多越来越深），搜词点亮同理；深色下反过来', () => {
    const seq = (m, p) => [1, 2, 3, 4, 5, 6, 7].map((i) => lum(color(m.get(`--${p}${i}`)).slice(0, 3)));
    const hot = (m, p) => [1, 2, 3, 4, 5].map((i) => lum(color(m.get(`--${p}${i}`)).slice(0, 3)));
    const mono = (a, dir) => a.every((v, i) => i === 0 || (dir === 'down' ? v < a[i - 1] : v > a[i - 1]));
    assert.ok(mono(seq(light, 'seq'), 'down'), '浅色 seq 要逐级变深');
    assert.ok(mono(hot(light, 'hot'), 'down'), '浅色 hot 要逐级变深');
    assert.ok(mono(seq(dark, 'seq'), 'up'), '深色 seq 逐级变亮（原样）');
    assert.ok(mono(hot(dark, 'hot'), 'up'), '深色 hot 逐级变亮（原样）');
  });

  it('日历空格（叠一层很淡的深色）和最浅一档色阶看得出区别', () => {
    const surface = color(light.get('--surface')).slice(0, 3);
    const panel = over(color(light.get('--panel')), color(light.get('--panel'))[3], surface);
    const empty = over(color(`rgb(${light.get('--wash-rgb')})`), 0.04, panel);
    const lowest = color(light.get('--seq1')).slice(0, 3);
    assert.ok(Math.abs(lum(empty) - lum(lowest)) > 0.03, '最浅一档和空格太像');
  });
});

describe('深色主题对比度（原有设计，只保证主要文字）', () => {
  it('主文字 ≥ 7，次文字 ≥ 4.5，图形色 ≥ 3', () => {
    const rows = checks(dark).filter(([n]) => /^(主文字|次文字|项目色)/.test(n));
    if (process.env.THEME_REPORT) console.log(`深色（节选），共 ${rows.length} 组：\n${fmt(rows)}`);
    const bad = rows.filter(([, f, b, min]) => ratio(f, b) < min);
    assert.deepEqual(bad.map(([n, f, b, min]) => `${n}：${ratio(f, b).toFixed(2)} < ${min}`), []);
  });
});
