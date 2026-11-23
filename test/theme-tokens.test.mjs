// H 组：主题令牌。深色和浅色两套令牌定义同一批、页面样式和脚本里不再写死颜色。不依赖浏览器。
// 运行：node --test test/theme-tokens.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CSS_FILES, JS_FILES, read, tokenBlocks, cssWithoutTokenBlocks, stripJsComments } from './theme-util.mjs';

const { dark, light } = tokenBlocks();

// 和主题无关、只在深色块里定义一次的令牌（尺寸之类）
const SHARED = new Set(['--side-w']);

// 改版前就有的令牌，和原先写死在脚本里的色板：深色下的值必须不变（深色界面保持原样）
const DARK_GOLDEN = {
  '--surface': '#0b1020', '--panel': 'rgba(17, 25, 48, 0.72)', '--panel-solid': '#111930', '--panel-line': 'rgba(110, 150, 255, 0.16)',
  '--text-primary': '#e8ecf6', '--text-secondary': '#a3aecb', '--text-muted': '#6f7a99', '--grid': 'rgba(148, 163, 184, 0.10)', '--glow': 'rgba(57, 135, 229, 0.35)',
  '--accent': '#86b6ef', '--accent2': '#9085e9', '--ok': '#0ca30c', '--warn': '#fab219', '--bad': '#d03b3b',
  '--s1': '#3987e5', '--s2': '#d95926', '--s3': '#199e70', '--s4': '#c98500', '--s5': '#d55181', '--s6': '#008300', '--s7': '#9085e9',
  '--other': '#5b6478', '--unwritten': '#39425a', '--side-w': '236px', '--tp-up': '84, 214, 240', '--tp-dn': '255, 184, 76',
  // 原先写在脚本里的颜色
  '--seq1': '#104281', '--seq2': '#184f95', '--seq3': '#256abf', '--seq4': '#3987e5', '--seq5': '#6da7ec', '--seq6': '#9ec5f4', '--seq7': '#cde2fb',
  '--hot1': '#7a2e10', '--hot2': '#a63d14', '--hot3': '#d95926', '--hot4': '#ec835a', '--hot5': '#f5b08f',
  '--other-lt': '#8b93a8', '--node-idle': '#2a3247', '--hub-text': '#0b1020',
  '--kind-project': '#3987e5', '--kind-machine': '#6da7ec', '--kind-site': '#ec835a', '--kind-version': '#b9b0f5',
  '--k-dev': '57, 135, 229', '--k-gate': '36, 196, 138', '--k-hub': '144, 133, 233', '--k-repo': '232, 170, 60', '--k-ext': '221, 96, 140', '--k-vec': '80, 200, 230', '--k-rep': '134, 182, 239', '--k-web': '205, 226, 251', '--k-talk': '124, 150, 255',
  '--dot-ok': '#35d36b', '--dot-bad': '#ef5b5b', '--dot-off': '#4a5470', '--dot-idle': '#3f9a5f', '--dot-paused': '#5a6482',
  '--t-orange': '#f5b08f', '--t-amber': '#fbc54b', '--t-red': '#f08a8a', '--t-red2': '#f4a3a3', '--t-green': '#6fdc6f', '--t-blue': '#9ec5f4', '--t-pale': '#cde2fb', '--t-mark': '#ffe3a0', '--t-hot': '#ec835a',
};

describe('主题令牌：深色和浅色两套', () => {
  it('令牌块只在 console.css 里（其他页面样式不另开 :root），且深色、浅色各一块', () => {
    for (const f of CSS_FILES.filter((x) => x !== 'console.css')) {
      assert.ok(!/:root\b/.test(read(f).replace(/\/\*[\s\S]*?\*\//g, '')), `${f} 里不该有 :root 块，令牌都放 console.css`);
    }
    const css = read('console.css').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal((css.match(/:root\s*\{/g) || []).length, 1, '深色令牌一块');
    assert.equal((css.match(/:root\[data-theme="light"\]\s*\{/g) || []).length, 1, '浅色令牌一块');
  });

  it('两套定义的是同一批令牌，不缺项、不多项（和主题无关的除外）', () => {
    const miss = [...dark.keys()].filter((k) => !light.has(k) && !SHARED.has(k));
    const extra = [...light.keys()].filter((k) => !dark.has(k));
    assert.deepEqual(miss, [], `浅色缺这些令牌：${miss.join(' ')}`);
    assert.deepEqual(extra, [], `浅色多出这些令牌（深色没有）：${extra.join(' ')}`);
    assert.ok(dark.size > 120, `令牌数 ${dark.size}`);
  });

  it('深色下改版前的令牌值一字不变（深色界面保持原样）', () => {
    for (const [k, v] of Object.entries(DARK_GOLDEN)) assert.equal(dark.get(k), v, `${k} 深色值变了`);
  });

  it('格式：三元组令牌是 "r, g, b"；脚本要在后面拼透明度的色板必须是 6 位十六进制', () => {
    for (const [name, map] of [['深色', dark], ['浅色', light]]) {
      for (const [k, v] of map) {
        if (/-rgb$/.test(k) || /^--(k-|tp-(up|dn))/.test(k) && !/core/.test(k)) assert.match(v, /^\d{1,3}, \d{1,3}, \d{1,3}$/, `${name} ${k}：${v}`);
      }
      for (const k of ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7', '--other', '--unwritten']) assert.match(map.get(k), /^#[0-9a-f]{6}$/, `${name} ${k} 要是 6 位十六进制（脚本里会拼 aa 透明度）`);
      for (const k of [...map.keys()].filter((x) => /^--(seq|hot)\d$/.test(x) || /^--kind-/.test(x) || /^--dot-/.test(x) || /^--t-/.test(x))) assert.match(map.get(k), /^#[0-9a-f]{6}$/, `${name} ${k}：${map.get(k)}`);
    }
  });

  it('浅色真的和深色不同：背景是浅的、文字是深的、星空画布被隐藏', () => {
    const L = (name, k) => assert.notEqual(light.get(k), dark.get(k), `${name}：${k} 浅色和深色一样`);
    for (const k of ['--surface', '--panel', '--panel-solid', '--text-primary', '--text-secondary', '--text-muted', '--text-strong', '--seq1', '--seq7', '--hot1', '--hot5', '--wash-rgb', '--ink-rgb', '--tp-up', '--tp-dn', '--s1', '--ok', '--bad']) L('主题', k);
    const css = read('console.css');
    assert.match(css, /:root\[data-theme="light"\]\s+#stars\s*\{\s*display:\s*none/);
  });
});

describe('页面样式和脚本里不再写死颜色', () => {
  // 白名单：只有这一条。mask-image 里的 #000 只是透明度蒙版（只看 alpha，颜色无所谓），深浅主题都一样。
  const MASK = /(^|[;{\s])(-webkit-)?mask(-image)?\s*:[^;}]*/g;
  const HEX = /#[0-9a-fA-F]{3,8}\b/;
  const FUNC = /\b(rgba?|hsla?)\(\s*[\d.]/;

  it('console*.css：令牌块以外没有 #十六进制、rgb()/rgba()/hsl() 数字写法（mask 蒙版除外）', () => {
    const bad = [];
    for (const f of CSS_FILES) {
      const css = cssWithoutTokenBlocks(f).replace(MASK, '$1');
      css.split('\n').forEach((line, i) => { if (HEX.test(line) || FUNC.test(line)) bad.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`); });
    }
    assert.deepEqual(bad, [], `这些行还有写死的颜色：\n${bad.join('\n')}`);
  });

  it('白名单只有 mask 蒙版：确实用到了，并且都是 #000', () => {
    const hits = [];
    for (const f of CSS_FILES) for (const m of stripCss(read(f)).matchAll(MASK)) hits.push(...(m[0].match(/#[0-9a-fA-F]{3,8}\b/g) || []));
    assert.ok(hits.length >= 3);
    assert.ok(hits.every((h) => h === '#000'), hits.join(' '));
  });

  it('console*.js：没有 #十六进制 和 rgb()/rgba() 数字写法，颜色都取自令牌', () => {
    const bad = [];
    for (const f of JS_FILES) {
      stripJsComments(read(f)).split('\n').forEach((line, i) => { if (HEX.test(line) || FUNC.test(line)) bad.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`); });
    }
    assert.deepEqual(bad, [], `这些行还有写死的颜色：\n${bad.join('\n')}`);
  });

  it('样式和脚本里引用的令牌都有定义（组件自己在元素上设的 --pc/--cr 这类除外）', () => {
    const defined = new Set(dark.keys());
    const local = new Set();
    const css = CSS_FILES.map(cssWithoutTokenBlocks).join('\n');
    for (const m of css.matchAll(/(--[\w-]+)\s*:/g)) local.add(m[1]);
    const js = JS_FILES.map((f) => stripJsComments(read(f))).join('\n');
    for (const m of js.matchAll(/setProperty\(\s*['"`](--[\w-]+)/g)) local.add(m[1]);
    for (const m of js.matchAll(/style="[^"]*?(--[\w-]+)\s*:/g)) local.add(m[1]);
    const used = new Set();
    for (const m of css.matchAll(/var\(\s*(--[\w-]+)/g)) used.add(m[1]);
    for (const m of js.matchAll(/var\(\s*(--[\w-]+)/g)) used.add(m[1]);
    for (const m of js.matchAll(/Console\.(?:css|rgba)\(\s*['"`](--[\w-]+)['"`]/g)) used.add(m[1]);
    const missing = [...used].filter((k) => !defined.has(k) && !local.has(k));
    assert.deepEqual(missing, [], `用了没定义的令牌：${missing.join(' ')}`);
    // 动态拼出来的那几族：全都要有
    for (const fam of [['--s', 7], ['--seq', 7], ['--hot', 5]]) for (let i = 1; i <= fam[1]; i++) assert.ok(defined.has(`${fam[0]}${i}`), `${fam[0]}${i}`);
    for (const k of ['project', 'machine', 'site', 'version']) assert.ok(defined.has(`--kind-${k}`), `--kind-${k}`);
    for (const k of ['dev', 'gate', 'hub', 'repo', 'ext', 'vec', 'rep', 'web', 'talk']) assert.ok(defined.has(`--k-${k}`), `--k-${k}`);
  });

  it('定义了的令牌基本都有人用（防止留一堆死令牌）', () => {
    const all = [read('console.html'), ...CSS_FILES.map((f) => read(f)), ...JS_FILES.map((f) => read(f))].join('\n');
    const dynamic = /^--(s\d|seq\d|hot\d|kind-|k-)/;
    const unused = [...dark.keys()].filter((k) => !dynamic.test(k) && all.split(k).length - 1 < 2); // 定义（深色+浅色）以外至少用一次
    assert.deepEqual(unused, [], `没人用的令牌：${unused.join(' ')}`);
  });
});

function stripCss(s) { return s.replace(/\/\*[\s\S]*?\*\//g, ''); }
