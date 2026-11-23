// 静态资源：console.html 运行时合并样式和脚本、哈希命名、缓存头、ETag/304、文件变了包就变。运行：node --test test/

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { startHub, TOKENS } from './helpers.mjs';
import { raw, startCopyHub, bundlesOf, HUB_DIR } from './perf-util.mjs';

const srcHtml = fs.readFileSync(path.join(HUB_DIR, 'console.html'), 'utf8');
const listed = (re) => [...srcHtml.matchAll(re)].map((m) => m[1]);
const SRC_CSS = listed(/<link rel="stylesheet" href="\/console\/(console[\w-]*\.css)">/g);
const SRC_JS = listed(/<script src="\/console\/(console[\w-]*\.js)"><\/script>/g);
const IMMUTABLE = 'public, max-age=31536000, immutable';
const cssBundle = async (hub) => bundlesOf((await hub.get('/console')).text).css[0];
const jsBundle = async (hub) => bundlesOf((await hub.get('/console')).text).js[0];

describe('console.html 改写与合并', () => {
  let hub;
  before(async () => { hub = await startCopyHub(); });
  after(() => hub.stop());

  it('源文件里确实有一批样式和脚本要合并', () => {
    assert.ok(SRC_CSS.length >= 4 && SRC_JS.length >= 8, `${SRC_CSS.length} css, ${SRC_JS.length} js`);
  });

  it('样式合成一个、脚本合成一个，html 里不再有单个文件的引用', async () => {
    const r = await hub.get('/console');
    assert.equal(r.status, 200);
    const b = bundlesOf(r.text);
    assert.equal(b.css.length, 1);
    assert.equal(b.js.length, 1);
    assert.deepEqual(r.text.match(/\/console\/console[\w-]*\.(css|js)/g).sort(), [b.css[0], b.js[0]].sort(), '除了两个包不该再有别的 console*.css|js 引用');
    // 其余内容原样保留：提前取数的内联脚本在样式前，Console.start 在脚本包后
    const iBoot = r.text.indexOf('window.__amBoot');
    const iCss = r.text.indexOf(b.css[0]);
    const iJs = r.text.indexOf(b.js[0]);
    const iStart = r.text.indexOf('Console.start();');
    assert.ok(iBoot > 0 && iBoot < iCss && iCss < iJs && iJs < iStart, `${iBoot} ${iCss} ${iJs} ${iStart}`);
    assert.ok(r.text.includes('<canvas id="stars">') && r.text.includes('id="pages"'));
  });

  it('html：no-cache、带 ETag，If-None-Match 命中返回 304 且没有正文', async () => {
    const r = await hub.get('/console');
    assert.equal(r.headers['cache-control'], 'no-cache');
    const tag = r.headers.etag;
    assert.match(tag, /^"[0-9a-f]+"$/);
    const hit = await hub.get('/console', { 'if-none-match': tag });
    assert.equal(hit.status, 304);
    assert.equal(hit.body.length, 0);
    assert.equal(hit.headers.etag, tag);
    assert.equal(hit.headers['cache-control'], 'no-cache');
    const miss = await hub.get('/console', { 'if-none-match': '"nope"' });
    assert.equal(miss.status, 200);
    assert.equal(miss.text, r.text);
    assert.equal((await hub.get('/console', { 'if-none-match': `"zzz", ${tag}` })).status, 304, '多个值里有一个命中就算');
    assert.equal((await hub.get('/console', { 'if-none-match': `W/${tag}` })).status, 304, '弱比较');
    assert.equal((await hub.get('/console?embed=1', { 'if-none-match': tag })).status, 304, 'embed 用同一份');
  });

  it('html：压缩版的 ETag 和原文不同，各自 304，互不串', async () => {
    const plain = await hub.get('/console');
    const gz = await hub.get('/console', { 'accept-encoding': 'gzip' });
    const br = await hub.get('/console', { 'accept-encoding': 'br' });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(br.headers['content-encoding'], 'br');
    assert.equal(gz.text, plain.text);
    assert.equal(br.text, plain.text);
    assert.match(gz.headers.vary, /Accept-Encoding/i);
    assert.notEqual(gz.headers.etag, plain.headers.etag);
    assert.notEqual(gz.headers.etag, br.headers.etag);
    assert.equal((await hub.get('/console', { 'accept-encoding': 'gzip', 'if-none-match': gz.headers.etag })).status, 304);
    assert.equal((await hub.get('/console', { 'accept-encoding': 'gzip', 'if-none-match': plain.headers.etag })).status, 200, '原文的 ETag 不能拿来验证压缩版');
    assert.equal((await hub.get('/console', { 'if-none-match': gz.headers.etag })).status, 200, '反过来也一样');
  });

  it('包：immutable、一年有效；内容是 html 里列出的文件按先后顺序拼起来', async () => {
    const html = (await hub.get('/console')).text;
    const b = bundlesOf(html);
    const css = await hub.get(b.css[0]);
    const js = await hub.get(b.js[0]);
    for (const r of [css, js]) {
      assert.equal(r.status, 200);
      assert.equal(r.headers['cache-control'], IMMUTABLE);
      assert.ok(r.headers.etag);
    }
    assert.equal(css.headers['content-type'], 'text/css; charset=utf-8');
    assert.equal(js.headers['content-type'], 'text/javascript; charset=utf-8');
    const inOrder = (text, names) => {
      let at = -1;
      for (const n of names) {
        const src = fs.readFileSync(path.join(HUB_DIR, n), 'utf8');
        const i = text.indexOf(src, at + 1);
        assert.ok(i > at, `${n} 应该完整出现在包里，且排在前一个文件后面`);
        at = i;
      }
    };
    inOrder(css.text, SRC_CSS);
    inOrder(js.text, SRC_JS);
    assert.equal(SRC_JS[0], 'console-core.js', 'core 要排在最前面');
  });

  it('包：304、压缩、哈希就是内容的哈希', async () => {
    const js = await jsBundle(hub);
    const r = await hub.get(js);
    assert.equal((await hub.get(js, { 'if-none-match': r.headers.etag })).status, 304);
    const br = await hub.get(js, { 'accept-encoding': 'br' });
    assert.equal(br.headers['content-encoding'], 'br');
    assert.equal(br.headers['cache-control'], IMMUTABLE);
    assert.equal(br.text, r.text);
    assert.ok(br.body.length < r.body.length / 3);
    const again = await hub.get(js, { 'accept-encoding': 'br' });
    assert.ok(again.body.equals(br.body), '同一个包的压缩结果是缓存的，字节一致');
    assert.equal(js.slice(js.lastIndexOf('-') + 1, -3), crypto.createHash('sha1').update(r.body).digest('hex').slice(0, 12));
  });

  it('合并后的脚本能整体编译（顶层没有重名、没有语法冲突）', async () => {
    const js = await hub.get(await jsBundle(hub));
    assert.doesNotThrow(() => new vm.Script(js.text, { filename: 'bundle.js' }));
    // 文件顶层的 'use strict' 一旦排在包的最前面，会让整个包都变成严格模式；约定写进各自的 IIFE 里（前面的注释不算语句）
    const topStrict = (src) => /^(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))*['"]use strict['"]/.test(src);
    assert.ok(!topStrict(js.text), '合并后的脚本顶层不能是 use strict');
    for (const n of SRC_JS) assert.ok(!topStrict(fs.readFileSync(path.join(HUB_DIR, n), 'utf8')), `${n} 顶层写了 use strict，合并后会连累别的文件，请写进自己的 IIFE`);
  });

  it('单个 console*.css|js 仍可单独访问：内容一致、no-cache、有 ETag 和 304', async () => {
    for (const n of [...SRC_CSS, ...SRC_JS]) {
      const r = await hub.get(`/console/${n}`);
      assert.equal(r.status, 200, n);
      assert.equal(r.text, fs.readFileSync(path.join(HUB_DIR, n), 'utf8'), n);
      assert.equal(r.headers['cache-control'], 'no-cache', n);
      assert.ok(r.headers.etag, n);
      assert.equal((await hub.get(`/console/${n}`, { 'if-none-match': r.headers.etag })).status, 304, n);
    }
  });

  it('大屏 wall.html 同样 no-cache + ETag + 304 + 压缩', async () => {
    const r = await hub.get('/wall');
    assert.equal(r.status, 200);
    assert.equal(r.text, fs.readFileSync(path.join(HUB_DIR, 'wall.html'), 'utf8'));
    assert.equal(r.headers['cache-control'], 'no-cache');
    assert.equal((await hub.get('/wall', { 'if-none-match': r.headers.etag })).status, 304);
    const gz = await hub.get('/wall', { 'accept-encoding': 'br' });
    assert.equal(gz.headers['content-encoding'], 'br');
    assert.equal(gz.text, r.text);
  });

  it('路径穿越和乱写的名字都拿不到东西', async () => {
    const server = fs.readFileSync(path.join(HUB_DIR, 'server.mjs'), 'utf8').slice(0, 200);
    for (const p of ['/console/../server.mjs', '/console/console-x/../../x.js', '/console/%2e%2e/server.mjs', '/console/console-..%2fserver.js', '/console/console-app-000000000000.js', '/console/console-app-zzzzzzzzzzzz.js', '/console/nothing.js', '/console/console.css.map']) {
      const r = await hub.get(p);
      assert.ok([401, 404].includes(r.status), `${p} -> ${r.status}`);
      assert.ok(!r.text.includes(server.slice(0, 60)), p);
    }
    assert.equal((await hub.get('/console/console-app-000000000000.js')).status, 404);
    // 只放行 console*.css|js：别的文件即使存在也不给
    assert.equal((await hub.get('/console/server.mjs')).status, 404);
    assert.equal((await hub.get('/console/perf.mjs')).status, 404);
    assert.equal((await hub.get('/console/console.html')).status, 404);
  });
});

describe('合并包随文件变化重建', () => {
  let hub;
  before(async () => { hub = await startCopyHub(); });
  after(() => hub.stop());

  it('改样式：样式包换名，脚本包不变；旧包还能取到；html 的 ETag 跟着变', async () => {
    const before = await hub.get('/console');
    const b0 = bundlesOf(before.text);
    hub.write('console-topology.css', `${hub.read('console-topology.css')}\n.perf-marker-1{color:#123456}\n`);
    const after = await hub.get('/console');
    const b1 = bundlesOf(after.text);
    assert.notEqual(b1.css[0], b0.css[0]);
    assert.equal(b1.js[0], b0.js[0]);
    assert.notEqual(after.headers.etag, before.headers.etag);
    assert.ok((await hub.get(b1.css[0])).text.includes('.perf-marker-1'));
    assert.equal((await hub.get(b0.css[0])).status, 200, '刚被顶掉的旧包还留着');
    assert.equal((await hub.get('/console', { 'if-none-match': before.headers.etag })).status, 200, '旧 ETag 不再命中');
  });

  it('改脚本：脚本包换名，样式包不变；不改就不变', async () => {
    const b0 = bundlesOf((await hub.get('/console')).text);
    hub.write('console-work.js', `${hub.read('console-work.js')}\n;window.perfMarker2 = 2;\n`);
    const b1 = bundlesOf((await hub.get('/console')).text);
    assert.notEqual(b1.js[0], b0.js[0]);
    assert.equal(b1.css[0], b0.css[0]);
    assert.ok((await hub.get(b1.js[0])).text.includes('perfMarker2'));
    assert.equal(bundlesOf((await hub.get('/console')).text).js[0], b1.js[0], '没改文件，哈希稳定');
    // 单个文件也是最新的
    assert.ok((await hub.get('/console/console-work.js')).text.includes('perfMarker2'));
  });

  it('别的组往 html 里加一行 script 和一个新文件：包自动带上，顺序按 html', async () => {
    hub.write('console-newfeat.js', 'window.perfNewFeat = (window.perfNewFeat || 0) + 1;\n');
    hub.write('console.html', hub.read('console.html').replace('<script src="/console/console-replay.js"></script>', '<script src="/console/console-newfeat.js"></script>\n<script src="/console/console-replay.js"></script>'));
    const html = (await hub.get('/console')).text;
    const b = bundlesOf(html);
    assert.equal(b.js.length, 1);
    assert.ok(!html.includes('console-newfeat.js'));
    const js = (await hub.get(b.js[0])).text;
    const a = js.indexOf('perfNewFeat');
    assert.ok(a > js.indexOf('Console.page(\'topology\''), '排在 topology 之后');
    assert.ok(a < js.indexOf(hub.read('console-replay.js').trim().slice(0, 40)), '排在 replay 之前');
    // 新加的样式文件同理
    hub.write('console-newfeat.css', '.perf-newfeat{color:red}\n');
    hub.write('console.html', hub.read('console.html').replace('<link rel="stylesheet" href="/console/console-topology.css">', '<link rel="stylesheet" href="/console/console-topology.css">\n<link rel="stylesheet" href="/console/console-newfeat.css">'));
    const b2 = bundlesOf((await hub.get('/console')).text);
    assert.equal(b2.css.length, 1);
    assert.ok((await hub.get(b2.css[0])).text.includes('.perf-newfeat'));
  });

  it('html 里引用的文件后来才出现：补上就重建', async () => {
    hub.write('console.html', hub.read('console.html').replace('<script src="/console/console-replay.js"></script>', '<script src="/console/console-late.js"></script>\n<script src="/console/console-replay.js"></script>'));
    const b0 = bundlesOf((await hub.get('/console')).text);
    assert.ok(!(await hub.get(b0.js[0])).text.includes('perfLate'));
    hub.write('console-late.js', 'window.perfLate = true;\n');
    const b1 = bundlesOf((await hub.get('/console')).text);
    assert.notEqual(b1.js[0], b0.js[0]);
    assert.ok((await hub.get(b1.js[0])).text.includes('perfLate'));
  });

  it('文件之间用换行加分号隔开：前一个文件末尾是行注释、没写分号也不会吞掉后一个', async () => {
    hub.write('console-a1.js', 'window.perfA1 = 1 // 没有分号也没有换行');
    hub.write('console-a2.js', '(function () { window.perfA2 = window.perfA1 + 1; })();');
    hub.write('console.html', hub.read('console.html').replace('<script src="/console/console-replay.js"></script>', '<script src="/console/console-a1.js"></script>\n<script src="/console/console-a2.js"></script>\n<script src="/console/console-replay.js"></script>'));
    const js = (await hub.get(await jsBundle(hub))).text;
    const ctx = vm.createContext({ window: {} });
    const i = js.indexOf('/* console-a1.js */');
    const j = js.indexOf('/* console-replay.js */');
    vm.runInContext(js.slice(i, j), ctx);
    assert.equal(ctx.window.perfA2, 2);
  });

  it('语法有错的文件不拖垮整个包：被换成一句 console.error，服务端日志里有记录', async () => {
    hub.write('console-broken.js', 'window.x = ;\n');
    hub.write('console.html', hub.read('console.html').replace('<script src="/console/console-replay.js"></script>', '<script src="/console/console-broken.js"></script>\n<script src="/console/console-replay.js"></script>'));
    const js = (await hub.get(await jsBundle(hub))).text;
    assert.doesNotThrow(() => new vm.Script(js));
    assert.match(js, /console\.error\(".*console-broken\.js.*语法错误/);
    assert.ok(js.includes('Console.page(\'topology\''), '其他文件都在');
    assert.match(hub.log(), /console-broken\.js 有语法错误/);
  });

  it('有 defer/async/type=module 的标签和行内脚本不合并，并把前后隔成两段，顺序不变', async () => {
    const html = `<!doctype html><html><head>
<link rel="stylesheet" href="/console/console.css">
<link rel="stylesheet" href="/console/console-admin.css" media="print">
</head><body>
<script src="/console/console-core.js"></script>
<script src="/console/console-overview.js"></script>
<script>window.perfInline = 1;</script>
<script src="/console/console-work.js"></script>
<!-- 注释不拆开 -->
<script src="/console/console-graph.js"></script>
<script src="/console/console-access.js" defer></script>
<script src="https://cdn.example/x.js"></script>
</body></html>`;
    hub.write('console.html', html);
    const r = (await hub.get('/console')).text;
    const b = bundlesOf(r);
    assert.equal(b.css.length, 1);
    assert.ok(r.includes('href="/console/console-admin.css" media="print"'), '带 media 的原样保留');
    assert.equal(b.js.length, 2, '行内脚本把前后隔成两个包');
    assert.ok(r.indexOf(b.js[0]) < r.indexOf('window.perfInline') && r.indexOf('window.perfInline') < r.indexOf(b.js[1]));
    assert.ok(r.includes('<script src="/console/console-access.js" defer></script>'));
    assert.ok(r.includes('<script src="https://cdn.example/x.js"></script>'));
    const first = (await hub.get(b.js[0])).text;
    const second = (await hub.get(b.js[1])).text;
    assert.ok(first.includes('/* console-core.js */') && first.includes('/* console-overview.js */') && !first.includes('/* console-work.js */'));
    assert.ok(second.includes('/* console-work.js */') && second.includes('/* console-graph.js */'));
  });

  it('html 里没有可合并的标签时原样返回；没有 console.html 时 404', async () => {
    hub.write('console.html', '<!doctype html><title>x</title><p>hi</p>');
    const r = await hub.get('/console');
    assert.equal(r.text, '<!doctype html><title>x</title><p>hi</p>');
    fs.rmSync(hub.file('console.html'));
    assert.equal((await hub.get('/console')).status, 404);
  });
});

describe('静态路由的身份校验', () => {
  let hub;
  before(async () => { hub = await startHub({ tokens: TOKENS, peers: ['my-laptop'] }); });
  after(() => hub.stop());

  it('没有网关身份：页面、包、单个文件、大屏都是 403', async () => {
    for (const p of ['/console', '/console/console-core.js', '/console/console-app-000000000000.js', '/wall']) {
      const r = await raw(hub.port, p, {}, { gate: false });
      assert.equal(r.status, 403, p);
    }
  });

  it('有网关身份：页面、包能取到', async () => {
    const r = await raw(hub.port, '/console');
    assert.equal(r.status, 200);
    const b = bundlesOf(r.text);
    assert.equal((await raw(hub.port, b.js[0])).status, 200);
    assert.equal((await raw(hub.port, b.css[0])).status, 200);
  });
});
