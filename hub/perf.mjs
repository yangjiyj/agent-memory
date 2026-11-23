/* 控制台提速：响应压缩、静态资源的缓存头与运行时合并、首屏汇总接口的取数清单。零依赖。
 *
 * ── 压缩 ──────────────────────────────────────────────────────────────────
 *   sendBody（server.mjs 的 send() 用它）：≥ 1KB 的文本/JSON 响应按 Accept-Encoding 压缩，br 优先，其次 gzip；
 *   请求里没有 Accept-Encoding 就不压；带 Vary: Accept-Encoding。已经压缩过的类型（压缩包、图片等）和流式下载不走这里。
 *
 * ── 静态资源 ──────────────────────────────────────────────────────────────
 *   /console 返回的 console.html 在服务端运行时改写：
 *     · 相邻的 <link rel="stylesheet" href="/console/console*.css"> 合成一个样式包，
 *       相邻的 <script src="/console/console*.js"> 合成一个脚本包（按在 html 里出现的先后顺序，文件之间用 "\n;\n" 隔开）；
 *     · 包按内容哈希命名：/console/console-app-<12 位十六进制>.css|js，内存里生成，文件的修改时间/大小变了就重建；
 *     · 包 Cache-Control: public, max-age=31536000, immutable；html 本身 no-cache 并带 ETag，If-None-Match 命中返回 304。
 *   其他组往 console.html 加 <script src>/<link> 行、往 hub/ 加新的 console*.js|css，包会自动带上，不用改这里。
 *   约定：被合并的 .js 不要在文件顶层写 'use strict'（写进自己的 IIFE 里）；
 *         有 media/async/defer/type=module 等属性的标签、行内脚本不合并，也会把前后两段隔开（各自成包）。
 *   单个 console*.css|js 仍可单独访问（大屏 wall.html、测试用），同样带 ETag 和压缩，但 Cache-Control 是 no-cache。
 *   静态文件的压缩结果按文件修改时间缓存在内存里，只压一次。
 *
 * ── 首屏汇总 ──────────────────────────────────────────────────────────────
 *   GET /console/api/boot?page=<页面 id>：一次返回外壳启动要的和该页首屏要的 GET 数据，格式 { page, prime: { "<URL>": 响应内容 } }。
 *   清单在下面的 BOOT_SHELL / BOOT_PAGES，URL 必须和 Console.api 实际发出的完全一致（包括 query 的顺序）；
 *   前端 console-core.js 把 prime 按 URL 存起来，Console.api 第一次碰到同样的 GET 就直接用，不再发请求。
 *   清单里没有的 URL 照常单独取，写错了只是少省一次请求，不会出错。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import vm from 'node:vm';

const MIN_BYTES = 1024; // 小于这个不压
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|xml)\b|image\/svg\+xml)/i;
const IMMUTABLE = 'public, max-age=31536000, immutable';
const TYPE = { css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', html: 'text/html; charset=utf-8' };

const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');

// ------------------------------------------------------------------ 压缩 ----

// 按 Accept-Encoding 选编码：br 优先，其次 gzip；没有头、q=0、不认识都返回 ''
export function acceptEncoding(header) {
  if (!header) return '';
  const q = {};
  for (const part of String(header).toLowerCase().split(',')) {
    const [tok, ...params] = part.split(';');
    const name = tok.trim();
    if (!name) continue;
    let v = 1;
    for (const p of params) { const m = /^\s*q\s*=\s*([\d.]+)/.exec(p); if (m) v = parseFloat(m[1]) || 0; }
    q[name] = v;
  }
  const ok = (e) => (q[e] ?? q['*'] ?? 0) > 0;
  return ok('br') ? 'br' : ok('gzip') ? 'gzip' : '';
}

const brotliOpts = (len, quality) => ({
  params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: quality,
    [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
    [zlib.constants.BROTLI_PARAM_SIZE_HINT]: len,
  },
});
// 接口响应每次现压：br 用 6（实测 150KB 的 JSON 约 4ms，比 gzip-6 小 17%），gzip 用 6
const compressSync = (buf, enc) => (enc === 'br' ? zlib.brotliCompressSync(buf, brotliOpts(buf.length, 6)) : zlib.gzipSync(buf, { level: 6 }));
// 静态文件只压一次：用高强度，放在线程池里压，不堵事件循环
const compressStatic = (buf, enc) => new Promise((resolve, reject) => {
  const done = (e, out) => (e ? reject(e) : resolve(out));
  if (enc === 'br') zlib.brotliCompress(buf, brotliOpts(buf.length, 11), done); else zlib.gzip(buf, { level: 9 }, done);
});

// send() 的实现：JSON/文本响应，≥ 1KB 且客户端接受时压缩
export function sendBody(res, code, body, type, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const h = { 'content-type': type, 'cache-control': 'no-store', ...headers };
  let out = buf;
  if (buf.length >= MIN_BYTES && COMPRESSIBLE.test(type) && !h['content-encoding']) {
    h.vary = 'Accept-Encoding';
    const enc = acceptEncoding(res.req?.headers['accept-encoding']);
    if (enc) {
      const z = compressSync(buf, enc);
      if (z.length < buf.length) { out = z; h['content-encoding'] = enc; }
    }
  }
  h['content-length'] = out.length;
  res.writeHead(code, h);
  res.end(out);
}

// If-None-Match 是否命中（支持多个值、W/ 前缀和 *）
const etagMatches = (header, etag) => {
  if (!header) return false;
  if (header.trim() === '*') return true;
  return header.split(',').some((t) => t.trim().replace(/^W\//, '') === etag);
};

// ------------------------------------------------------------ 静态资源 ----

// 一份可以发的内容：原文、内容哈希、各编码的压缩结果（Promise，第一次要用时才压）
class Asset {
  constructor(buf, type) { this.buf = buf; this.type = type; this.tag = sha1(buf).slice(0, 16); this.z = {}; }
  compressed(enc) { return (this.z[enc] ||= compressStatic(this.buf, enc)); }
  // 提前在线程池里压好，第一个访问的人不用等（失败了不要紧，访问时会重来）
  warm() { if (this.buf.length >= MIN_BYTES && COMPRESSIBLE.test(this.type)) for (const enc of ['br', 'gzip']) this.compressed(enc).catch(() => { delete this.z[enc]; }); }
}

async function serve(res, asset, cacheControl) {
  const compress = asset.buf.length >= MIN_BYTES && COMPRESSIBLE.test(asset.type);
  const enc = compress ? acceptEncoding(res.req?.headers['accept-encoding']) : '';
  // 不同编码是不同的表示，ETag 带上编码，缓存和 304 才不会串
  const etag = `"${asset.tag}${enc ? `-${enc}` : ''}"`;
  const h = { 'cache-control': cacheControl, etag };
  if (compress) h.vary = 'Accept-Encoding';
  if (etagMatches(res.req?.headers['if-none-match'], etag)) { res.writeHead(304, h); res.end(); return; }
  h['content-type'] = asset.type;
  let out = asset.buf;
  if (enc) {
    const z = await asset.compressed(enc);
    if (z.length < out.length) { out = z; h['content-encoding'] = enc; }
  }
  h['content-length'] = out.length;
  res.writeHead(200, h);
  res.end(out);
}

// html 里的标签：注释（整段跳过）、<link>、<script>…</script>
const RE_TAGS = /<!--[\s\S]*?-->|<link\b[^>]*>|<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
const RE_GAP = /^(?:\s|<!--[\s\S]*?-->)*$/;
const CSS_HREF = /^\/console\/(console[\w-]*\.css)$/;
const JS_SRC = /^\/console\/(console[\w-]*\.js)$/;
const BUNDLE_NAME = /^console-app-[0-9a-f]{12}\.(?:css|js)$/;

function attrs(tag) {
  const open = /^<[a-z]+\b([^>]*)>/i.exec(tag)?.[1] || '';
  const out = {};
  for (const m of open.matchAll(/([a-z][\w:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/gi)) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return out;
}

// 这个标签能不能并进包：只认没有多余属性的样式表 link 和外链 script
function classify(tag) {
  if (tag.startsWith('<!--')) return null;
  const a = attrs(tag);
  const keys = Object.keys(a);
  if (/^<link/i.test(tag)) {
    const m = CSS_HREF.exec(a.href || '');
    if (!m || !/(^|\s)stylesheet(\s|$)/i.test(a.rel || '') || keys.some((k) => !['rel', 'href', 'type'].includes(k))) return null;
    return { kind: 'css', name: m[1] };
  }
  const m = JS_SRC.exec(a.src || '');
  if (!m || keys.some((k) => !['src', 'type', 'charset'].includes(k)) || (a.type && !/^(text|application)\/(x-)?javascript$/i.test(a.type))) return null;
  if (!/^<script[^>]*>\s*<\/script\s*>$/i.test(tag)) return null; // 有行内内容的不是外链
  return { kind: 'js', name: m[1] };
}

export function createStatic(appDir, { notFound } = {}) {
  const abs = (n) => path.join(appDir, n);
  const missing = (res) => (notFound ? notFound(res) : (res.writeHead(404, { 'content-type': 'text/plain' }), res.end('not found')));

  // 单个文件：按修改时间和大小缓存内容、哈希和压缩结果
  const files = new Map();
  function fileAsset(name, type) {
    let st;
    try { st = fs.statSync(abs(name)); } catch { return null; }
    const sig = `${st.mtimeMs}:${st.size}`;
    const hit = files.get(name);
    if (hit?.sig === sig) return hit.asset;
    let buf;
    try { buf = fs.readFileSync(abs(name)); } catch { return null; }
    const asset = new Asset(buf, type);
    files.set(name, { sig, asset });
    return asset;
  }

  // console.html 改写后的整页和它引用的包。沿用上一次的结果，直到 html 或被合并的文件的修改时间/大小变了
  let app = null;
  const bundles = new Map(); // 包名 → Asset；最近几次构建的都留着，刚被顶掉的旧包还能取到
  const sigOf = (names) => names.map((n) => { try { const s = fs.statSync(abs(n)); return `${n}:${s.mtimeMs}:${s.size}`; } catch { return `${n}:-`; } }).join('|');

  function buildApp() {
    let st;
    try { st = fs.statSync(abs('console.html')); } catch { return null; }
    const htmlSig = `${st.mtimeMs}:${st.size}`;
    if (app && app.htmlSig === htmlSig && app.sig === sigOf(app.names)) return app;
    const html = fs.readFileSync(abs('console.html'), 'utf8');

    // 找出能并包的标签，同类且相邻（中间只有空白和注释）的连成一段
    const runs = [];
    for (const m of html.matchAll(RE_TAGS)) {
      const it = classify(m[0]);
      if (!it) continue;
      const item = { ...it, start: m.index, end: m.index + m[0].length };
      const last = runs[runs.length - 1];
      if (last && last.kind === it.kind && RE_GAP.test(html.slice(last.items[last.items.length - 1].end, item.start))) last.items.push(item);
      else runs.push({ kind: it.kind, items: [item] });
    }

    let out = ''; let pos = 0;
    const names = [];
    const built = [];
    for (const run of runs) {
      out += html.slice(pos, run.items[0].start);
      pos = run.items[run.items.length - 1].end;
      const parts = [];
      for (const it of run.items) {
        names.push(it.name); // 文件暂时不在也记下，之后出现了照样触发重建
        let src;
        try { src = fs.readFileSync(abs(it.name), 'utf8'); if (src.charCodeAt(0) === 0xfeff) src = src.slice(1); } catch { continue; } // 文件不在：和单独引用时的 404 一样，跳过
        if (run.kind === 'js') {
          // 语法有错的文件不能拖垮整个包：编译一下，坏的换成一句 console.error，服务端日志里也记一笔
          try { new vm.Script(src, { filename: it.name }); } catch (e) {
            console.error(`console bundle: ${it.name} 有语法错误，已从脚本包里跳过：${e.message}`);
            src = `console.error(${JSON.stringify(`${it.name} 有语法错误，已跳过：${e.message}`)});`;
          }
        }
        parts.push(`/* ${it.name} */\n${src}`);
      }
      if (!parts.length) continue;
      const ext = run.kind;
      const body = Buffer.from(parts.join(run.kind === 'js' ? '\n;\n' : '\n'), 'utf8');
      const asset = new Asset(body, TYPE[ext]);
      const name = `console-app-${sha1(body).slice(0, 12)}.${ext}`;
      built.push([name, asset]);
      out += ext === 'css' ? `<link rel="stylesheet" href="/console/${name}">` : `<script src="/console/${name}"></script>`;
    }
    out += html.slice(pos);

    for (const [name, asset] of built) { bundles.delete(name); bundles.set(name, asset); }
    while (bundles.size > 12) bundles.delete(bundles.keys().next().value);
    app = { htmlSig, sig: sigOf(names), names, html: new Asset(Buffer.from(out, 'utf8'), TYPE.html) };
    app.html.warm();
    for (const [, asset] of built) asset.warm();
    return app;
  }

  return {
    // 启动时调一次：把页面和包先构建、压缩好
    warm() { try { buildApp(); } catch (e) { console.error('console bundle:', e.message); } },
    // GET /console：改写后的 console.html，no-cache + ETag
    html(res) {
      const a = buildApp();
      if (!a) return missing(res);
      return serve(res, a.html, 'no-cache');
    },
    // 其他整页文件（wall.html 等）：no-cache + ETag
    page(res, name, type) {
      const a = fileAsset(name, type);
      if (!a) return missing(res);
      return serve(res, a, 'no-cache');
    },
    // GET /console/console*.css|js：先认包名（immutable），否则当单个文件（no-cache + ETag）。name 已经由路由校验过
    asset(res, name) {
      if (BUNDLE_NAME.test(name)) {
        let b = bundles.get(name);
        if (!b) { buildApp(); b = bundles.get(name); }
        if (b) return serve(res, b, IMMUTABLE);
      }
      const a = fileAsset(name, name.endsWith('.css') ? TYPE.css : TYPE.js);
      if (!a) return missing(res);
      return serve(res, a, 'no-cache');
    },
  };
}

// ------------------------------------------------------------ 首屏汇总 ----

// 外壳启动时每个页面都会取的（Console.loadData、侧栏徽标）
export const BOOT_SHELL = ['/browse/viz-data', '/browse/manage-counts', '/console/api/devices', '/health'];
// 各页面自己首屏要取的，按页面 id；URL 要和 Console.api 发出的完全一致
export const BOOT_PAGES = {
  overview: ['/browse/todos', '/browse/viz-agents', '/browse/viz-live', '/browse/viz-galaxy'],
  lib: ['/browse/semantic', '/browse/data'],
  triage: ['/browse/manage-data'],
  graph: ['/browse/graph'],
  timeline: ['/browse/viz-extra'],
  projects: ['/browse/projects'],
  todos: ['/browse/todos'],
  convs: ['/browse/viz-agents'],
  topology: ['/console/api/topology', '/console/api/topology/events?limit=30'],
  agents: ['/browse/viz-agents'],
  mcp: ['/console/api/mcp'],
  audit: ['/browse/audit?days=7'],
  jobs: ['/console/api/jobs'],
  settings: ['/console/api/settings'],
  // devices 页要的 /console/api/devices 和 /health 已经在 BOOT_SHELL 里
};

export function bootPlan(page) {
  const own = Object.hasOwn(BOOT_PAGES, page) ? BOOT_PAGES[page] : [];
  return [...new Set([...BOOT_SHELL, ...own])];
}
