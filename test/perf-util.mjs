// 提速相关测试的公用小工具（不是测试文件）：
//  - raw：用 node:http 发请求，自己控制 Accept-Encoding / If-None-Match（fetch 会自动解压、自动带头，看不到真实的传输内容）
//  - startCopyHub：把 hub/ 复制到临时目录再起中心，这样可以改里面的 console.html、console*.js 看合并包怎么变

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePort, GATE, GATE_HEADERS, sha256 } from './helpers.mjs';

export const HUB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hub');

// 原样发一个请求，返回 { status, headers, body（传输上的原始字节）, text（按 content-encoding 解开后的文本）}
export function raw(port, route, headers = {}, { method = 'GET', gate = true, agent } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method, agent, headers: { ...(gate ? GATE_HEADERS : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        const enc = res.headers['content-encoding'];
        const plain = enc === 'br' ? zlib.brotliDecompressSync(body) : enc === 'gzip' ? zlib.gunzipSync(body) : body;
        resolve({ status: res.statusCode, headers: res.headers, body, plain, text: plain.toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// 复制一份 hub/ 起中心，console_viewer 设成 my-laptop，浏览器不用带网关身份
export async function startCopyHub() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-perf-'));
  const app = path.join(dir, 'app');
  fs.mkdirSync(app);
  for (const f of fs.readdirSync(HUB_DIR)) fs.copyFileSync(path.join(HUB_DIR, f), path.join(app, f));
  for (const d of ['repo', 'state', 'cards', 'archive']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.writeFileSync(path.join(dir, 'archive/.am-archive'), '');
  const port = await freePort();
  const p = (n) => path.join(dir, n);
  fs.writeFileSync(p('config.json'), JSON.stringify({
    listen: '127.0.0.1', port, repo: p('repo'), state: p('state'), tokens: p('tokens.json'), cards_dir: p('cards'), archive_dir: p('archive'),
    public_url: `http://hub.example:${port}`, gate_secret: GATE, console_viewer: 'my-laptop',
  }));
  fs.writeFileSync(p('tokens.json'), JSON.stringify({ devices: { 'my-laptop': { sha256: sha256('tok-copy-hub'), role: 'device', created: new Date().toISOString() } } }));
  let log = '';
  const child = spawn(process.execPath, [path.join(app, 'server.mjs')], { env: { ...process.env, AGENT_MEMORY_CONFIG: p('config.json') }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (b) => { log += b; });
  child.stderr.on('data', (b) => { log += b; });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* 还没起来 */ }
    if (i > 100 || child.exitCode !== null) throw new Error(`中心没起来：${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    port, dir, app, log: () => log,
    get: (route, headers) => raw(port, route, headers, { gate: false }),
    file: (name) => path.join(app, name),
    read: (name) => fs.readFileSync(path.join(app, name), 'utf8'),
    write: (name, text) => fs.writeFileSync(path.join(app, name), text),
    async stop() {
      child.kill('SIGTERM');
      await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// 从 html 里取合并包的地址
export const bundlesOf = (html) => ({
  css: [...html.matchAll(/<link rel="stylesheet" href="(\/console\/console-app-[0-9a-f]{12}\.css)">/g)].map((m) => m[1]),
  js: [...html.matchAll(/<script src="(\/console\/console-app-[0-9a-f]{12}\.js)"><\/script>/g)].map((m) => m[1]),
});
