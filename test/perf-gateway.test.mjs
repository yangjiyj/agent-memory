// 认证网关（gateway/am-gate.py）不能破坏压缩和缓存：Accept-Encoding / If-None-Match 往上游透传，
// Content-Encoding / ETag / Vary / Cache-Control 原样带回，304 无正文且不拖垮长连接。没有 python3 时跳过。运行：node --test test/

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startHub, TOKENS, freePort, GATE } from './helpers.mjs';
import { raw, bundlesOf } from './perf-util.mjs';

const GATEWAY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'gateway', 'am-gate.py');
const hasPython = spawnSync('python3', ['--version']).status === 0;

describe('认证网关透传压缩与缓存头', { skip: !hasPython && '没有 python3' }, () => {
  let hub; let gate; let gatePort; let log = '';
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 }); // 所有请求挤在一条长连接上，304 处理有问题后面的请求就会挂
  const via = (route, headers) => raw(gatePort, route, headers, { gate: false, agent });
  before(async () => {
    // console_viewer：经网关来的本机请求没有 Tailscale 身份，按这台设备算
    hub = await startHub({ tokens: TOKENS, peers: ['my-laptop'], config: { console_viewer: 'my-laptop' } });
    for (let i = 0; i < 5; i++) await hub.rpc('my-laptop', 'tools/call', { name: 'memory_remember', arguments: { type: 'fact', title: `网关测试 ${i}`, body: `正文 ${i} `.repeat(60) } });
    gatePort = await freePort();
    gate = spawn('python3', [GATEWAY], { env: { ...process.env, LISTEN_PORT: String(gatePort), UPSTREAM: `127.0.0.1:${hub.port}`, GATE_SECRET: GATE }, stdio: ['ignore', 'pipe', 'pipe'] });
    gate.stderr.on('data', (b) => { log += b; });
    for (let i = 0; ; i++) {
      const ok = await new Promise((r) => { const s = net.connect(gatePort, '127.0.0.1', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); });
      if (ok) break;
      if (i > 100 || gate.exitCode !== null) throw new Error(`网关没起来：${log}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  });
  after(async () => {
    agent.destroy();
    gate?.kill('SIGTERM');
    await hub.stop();
  });

  it('br/gzip 原样透传，解开后和直连一致', async () => {
    const direct = await raw(hub.port, '/console/api/mcp', { 'accept-encoding': 'br' }, { gate: false });
    const r = await via('/console/api/mcp', { 'accept-encoding': 'br' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-encoding'], 'br');
    assert.match(r.headers.vary, /Accept-Encoding/i);
    assert.equal(r.text, direct.text);
    assert.equal(r.headers['content-length'], String(r.body.length), 'Content-Length 是压缩后的字节数');
    const gz = await via('/console/api/mcp', { 'accept-encoding': 'gzip' });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(gz.text, direct.text);
  });

  it('客户端不带 Accept-Encoding：网关（http.client）会补 identity，上游不压', async () => {
    const r = await via('/console/api/mcp', {});
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-encoding'], undefined);
    assert.ok(JSON.parse(r.text).tools.length > 5);
  });

  it('ETag / If-None-Match 往返：304 没有正文，响应头带回，后续请求照常', async () => {
    const first = await via('/console', { 'accept-encoding': 'br' });
    assert.equal(first.status, 200);
    const tag = first.headers.etag;
    assert.ok(tag);
    assert.equal(first.headers['cache-control'], 'no-cache');
    const hit = await via('/console', { 'accept-encoding': 'br', 'if-none-match': tag });
    assert.equal(hit.status, 304);
    assert.equal(hit.body.length, 0);
    assert.equal(hit.headers.etag, tag);
    assert.equal(hit.headers['cache-control'], 'no-cache');
    assert.match(hit.headers.vary, /Accept-Encoding/i);
    // 同一条连接上接着取：304 之后连接没有错位
    const again = await via('/console', { 'accept-encoding': 'br' });
    assert.equal(again.status, 200);
    assert.equal(again.text, first.text);
    const hit2 = await via('/console', { 'accept-encoding': 'br', 'if-none-match': tag });
    assert.equal(hit2.status, 304);
  });

  it('带哈希的包：immutable 头、压缩、304 都能过网关', async () => {
    const html = (await via('/console', {})).text;
    const js = bundlesOf(html).js[0];
    const r = await via(js, { 'accept-encoding': 'br' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-encoding'], 'br');
    assert.equal(r.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.ok(r.body.length < r.text.length / 3);
    assert.equal((await via(js, { 'accept-encoding': 'br', 'if-none-match': r.headers.etag })).status, 304);
  });

  it('不触发 Nagle 加延迟 ACK 的 40ms 停顿：长连接上连续小请求的中位耗时远低于 40ms', async () => {
    await via('/health', {}); // 先把连接建好
    const xs = [];
    for (let i = 0; i < 40; i++) { const t = process.hrtime.bigint(); await via('/health', {}); xs.push(Number(process.hrtime.bigint() - t) / 1e6); }
    xs.sort((a, b) => a - b);
    assert.ok(xs[20] < 25, `中位 ${xs[20].toFixed(1)}ms：网关响应头和正文分两次写，没开 TCP_NODELAY 的话每个请求都会多 40ms`);
  });

  it('网关的请求处理类开了 TCP_NODELAY', () => {
    const code = [
      'import importlib.util, os, sys',
      'os.environ["GATE_SECRET"] = "x"',
      'spec = importlib.util.spec_from_file_location("amgate", sys.argv[1])',
      'm = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(m)',
      'print(m.Handler.disable_nagle_algorithm)',
    ].join('\n');
    const r = spawnSync('python3', ['-c', code, GATEWAY], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }); // 不在 gateway/ 里留 __pycache__
    assert.equal(r.stdout.trim(), 'True', r.stderr);
  });

  it('首屏汇总和大响应过网关也正常', async () => {
    const r = await via('/console/api/boot?page=lib', { 'accept-encoding': 'gzip' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-encoding'], 'gzip');
    assert.ok(JSON.parse(r.text).prime['/browse/data'].entries.length >= 5);
  });
});
