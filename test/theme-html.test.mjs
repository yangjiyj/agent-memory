// H 组：console.html 的防闪烁内联脚本（在样式表之前、逻辑对）、合并后的页面顺序、大屏/年报/审批页保持深色。
// 运行：node --test test/theme-html.test.mjs

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { startHub, TOKENS } from './helpers.mjs';
import { read } from './theme-util.mjs';

// 内联脚本：取 <head> 里含 am.theme 的那个 <script>
const inlineTheme = (html) => {
  const head = html.slice(0, html.indexOf('</head>'));
  const m = [...head.matchAll(/<script>([\s\S]*?)<\/script>/g)].find((x) => x[1].includes('am.theme'));
  return m ? { code: m[1], at: m.index } : null;
};

// 在最小的"浏览器"里跑内联脚本，返回它设的 data-theme
function runInline(code, { stored, systemDark = false, search = '', storageThrows = false, noMatchMedia = false } = {}) {
  const dataset = {};
  const ctx = vm.createContext({
    document: { documentElement: { dataset } },
    location: { search },
    localStorage: storageThrows ? { getItem() { throw new Error('denied'); } } : { getItem: (k) => (k === 'am.theme' && stored !== undefined ? stored : null) },
    matchMedia: noMatchMedia ? undefined : () => ({ matches: systemDark }),
  });
  ctx.window = ctx; // 内联脚本里 window.matchMedia
  vm.runInContext(code, ctx);
  return dataset.theme;
}

describe('console.html：防闪烁内联脚本', () => {
  const html = read('console.html');
  const it0 = inlineTheme(html);

  it('有一段很短的内联脚本，并且排在第一个样式表和脚本之前', () => {
    assert.ok(it0, '<head> 里要有读 am.theme 的内联脚本');
    assert.ok(it0.code.length < 400, `脚本 ${it0.code.length} 字节，要很短`);
    const iLink = html.indexOf('<link rel="stylesheet"');
    assert.ok(it0.at < iLink, '内联脚本要在样式表之前');
    assert.ok(it0.at < html.indexOf('window.__amBoot'), '也排在提前取数的脚本之前');
    assert.ok(html.indexOf('/console/console-core.js') < html.indexOf('/console/console-theme.js'), 'console-theme.js 在 core 之后');
    assert.ok(html.indexOf('/console/console-theme.js') < html.indexOf('/console/console-overview.js'), '主题脚本在各页面脚本之前');
  });

  it('逻辑：存储的选择先于系统；auto/没有 → 看系统；嵌入永远深色', () => {
    const t = (o) => runInline(it0.code, o);
    assert.equal(t({}), 'light');
    assert.equal(t({ systemDark: true }), 'dark');
    assert.equal(t({ stored: 'auto', systemDark: true }), 'dark');
    assert.equal(t({ stored: 'auto', systemDark: false }), 'light');
    assert.equal(t({ stored: 'dark', systemDark: false }), 'dark');
    assert.equal(t({ stored: 'light', systemDark: true }), 'light');
    assert.equal(t({ stored: 'junk', systemDark: true }), 'dark', '不认识的值按 auto');
    for (const search of ['?embed=1', '?embed', '?x=1&embed=1', '?embed=1&x=2']) assert.equal(t({ search, stored: 'light', systemDark: false }), 'dark', search);
    assert.equal(t({ search: '?embedded=1', systemDark: false }), 'light', '只认 embed 参数');
  });

  it('localStorage 抛错、没有 matchMedia 也不报错', () => {
    assert.equal(runInline(it0.code, { storageThrows: true, systemDark: true }), 'dark');
    assert.equal(runInline(it0.code, { storageThrows: true, systemDark: false }), 'light');
    assert.equal(runInline(it0.code, { noMatchMedia: true }), 'light');
  });
});

describe('服务端合并后的页面', () => {
  let hub;
  before(async () => { hub = await startHub({ tokens: TOKENS, peers: ['my-laptop'] }); });
  after(() => hub.stop());

  it('内联脚本留在合并后的样式包之前；console-theme.js 进了脚本包，排在 core 之后', async () => {
    const r = await hub.web('GET', '/console');
    assert.equal(r.status, 200);
    const t = inlineTheme(r.text);
    assert.ok(t, '合并后的页面里还有内联脚本');
    const iCss = r.text.search(/<link rel="stylesheet" href="\/console\/console-app-[0-9a-f]{12}\.css">/);
    assert.ok(iCss > t.at, '样式包在内联脚本之后');
    const js = r.text.match(/\/console\/(console-app-[0-9a-f]{12}\.js)/)[1];
    const bundle = (await hub.web('GET', `/console/${js}`)).text;
    const iCore = bundle.indexOf('/* console-core.js */'); const iTheme = bundle.indexOf('/* console-theme.js */'); const iOv = bundle.indexOf('/* console-overview.js */');
    assert.ok(iCore >= 0 && iCore < iTheme && iTheme < iOv, `包里顺序：core ${iCore} theme ${iTheme} overview ${iOv}`);
    const css = (await hub.web('GET', `/console/${r.text.match(/(console-app-[0-9a-f]{12}\.css)/)[1]}`)).text;
    assert.ok(css.includes(':root[data-theme="light"]'), '样式包里有浅色令牌');
  });

  it('console-theme.js 单独也能取到', async () => {
    const r = await hub.web('GET', '/console/console-theme.js');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /javascript/);
    assert.ok(r.text.includes('am.theme'));
  });

  it('大屏、年报、审批页不引用控制台样式、没有主题切换：保持深色', async () => {
    for (const route of ['/wall', '/browse/wrapped']) {
      const r = await hub.web('GET', route);
      assert.equal(r.status, 200, route);
      assert.ok(!/data-theme|am\.theme|console-theme/.test(r.text), `${route} 不该带主题逻辑`);
      assert.ok(!/\/console\/console[\w-]*\.css/.test(r.text), `${route} 不该引用控制台样式`);
    }
    const review = read('review.html');
    assert.ok(!/data-theme|am\.theme|console-theme|\/console\/console[\w-]*\.css/.test(review), '审批页保持原样');
  });

  it('大屏里嵌的拓扑是 /console?embed=1#/topology（内联脚本据此强制深色）', async () => {
    const wall = (await hub.web('GET', '/wall')).text;
    assert.match(wall, /\/console\?embed=1#\/topology/);
  });
});
