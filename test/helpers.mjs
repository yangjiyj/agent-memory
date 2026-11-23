// 测试公用的辅助：在临时目录里造最小的配置和数据，起一个真实的中心进程。
// 各测试文件 import { startHub, GATE_HEADERS, TOKENS } from './helpers.mjs'。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hub', 'server.mjs');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const GATE = 'test-gate-secret';
export const GATE_HEADERS = { 'x-am-gate': GATE, 'x-am-peer': 'my-laptop' };

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

// 起一个中心：opts.tokens 是 {设备名: {token, role?, readonly?}}，opts.config 合并进配置，opts.archive 为 false 时不挂对话存档盘
export async function startHub(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-console-'));
  const port = await freePort();
  const p = (n) => path.join(dir, n);
  for (const d of ['repo', 'state', 'cards']) fs.mkdirSync(p(d), { recursive: true });
  if (opts.archive !== false) { fs.mkdirSync(p('archive'), { recursive: true }); fs.writeFileSync(p('archive/.am-archive'), ''); }
  const config = {
    listen: '127.0.0.1', port, repo: p('repo'), state: p('state'), tokens: p('tokens.json'), cards_dir: p('cards'), archive_dir: p('archive'),
    public_url: `http://hub.example:${port}`, gate_secret: GATE, ...opts.config,
  };
  fs.writeFileSync(p('config.json'), JSON.stringify(config, null, 2));
  const devices = {};
  const tokenOf = {};
  for (const [name, d] of Object.entries(opts.tokens || {})) {
    tokenOf[name] = d.token;
    devices[name] = { sha256: sha256(d.token), role: d.role || 'device', created: new Date().toISOString(), ...(d.readonly ? { readonly: true } : {}) };
  }
  fs.writeFileSync(p('tokens.json'), JSON.stringify({ devices }));
  const peers = {};
  for (const name of opts.peers || []) peers[name] = { peer: `tailnet:${name}`, aliases: [`tailnet:${name}`], os: 'linux', seen: new Date().toISOString(), first: new Date().toISOString() };
  fs.writeFileSync(p('state/peers.json'), JSON.stringify(peers));

  let child = null;
  let log = '';
  const base = `http://127.0.0.1:${port}`;
  const launch = async () => {
    child = spawn(process.execPath, [SERVER], { env: { ...process.env, AGENT_MEMORY_CONFIG: p('config.json') }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (b) => { log += b; });
    child.stderr.on('data', (b) => { log += b; });
    for (let i = 0; ; i++) {
      try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* 还没起来 */ }
      if (i > 100 || child.exitCode !== null) throw new Error(`中心没起来：${log}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const halt = async () => {
    child.kill('SIGTERM');
    await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
  };
  await launch();
  const hub = {
    dir, base, port, tokenOf, path: p,
    // 浏览器身份（网关认出的）调用控制台接口
    async api(method, route, body, headers = GATE_HEADERS) {
      const res = await fetch(`${base}/console/api/${route}`, {
        method, headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
      return { status: res.status, json, text };
    },
    get: (route, headers) => hub.api('GET', route, undefined, headers),
    // 任意路径（静态文件、/browse/*、/s/* 等），默认带网关身份；返回 { status, headers, text, json, buf }
    async web(method, route, body, headers = GATE_HEADERS) {
      const res = await fetch(`${base}${route}`, {
        method, headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const buf = Buffer.from(await res.arrayBuffer());
      const text = buf.toString('utf8');
      let json = null;
      try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
      return { status: res.status, headers: res.headers, text, json, buf };
    },
    post: (route, body, headers) => hub.api('POST', route, body, headers),
    // 设备带令牌调 MCP
    async rpc(device, method, params) {
      const res = await fetch(`${base}/mcp?client=test`, {
        method: 'POST', headers: { authorization: `Bearer ${tokenOf[device]}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      return (await res.json()).result;
    },
    async device(device, route, body) {
      const res = await fetch(`${base}${route}`, {
        method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${tokenOf[device]}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
    read: (name) => JSON.parse(fs.readFileSync(p(name), 'utf8')),
    async restart() { await halt(); await launch(); },
    async stop() {
      await halt();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return hub;
}

export const TOKENS = { 'my-laptop': { token: 'tok-laptop-secret-value' }, 'build-server': { token: 'tok-build-secret-value' } };
