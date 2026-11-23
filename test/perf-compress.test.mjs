// 压缩：接口响应和静态文件按 Accept-Encoding 压缩（br 优先、其次 gzip），小响应不压，已压缩类型和下载不动。运行：node --test test/

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { startHub, TOKENS } from './helpers.mjs';
import { raw, HUB_DIR } from './perf-util.mjs';
import { acceptEncoding } from '../hub/perf.mjs';

describe('Accept-Encoding 协商', () => {
  it('br 优先，其次 gzip，没有头或都不接受就不压', () => {
    const cases = [
      [undefined, ''], ['', ''], ['identity', ''], ['gzip', 'gzip'], ['br', 'br'], ['gzip, deflate, br', 'br'], ['GZIP, BR', 'br'],
      ['br;q=0, gzip', 'gzip'], ['gzip;q=0', ''], ['gzip;q=0.5, br;q=0.8', 'br'], ['*', 'br'], ['deflate', ''], ['br;q=0, gzip;q=0, *;q=0', ''],
    ];
    for (const [h, want] of cases) assert.equal(acceptEncoding(h), want, JSON.stringify(h));
  });
});

describe('响应压缩', () => {
  let hub; let distDir;
  const tarball = crypto.randomBytes(8000);
  before(async () => {
    distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-perf-dist-'));
    fs.writeFileSync(path.join(distDir, 'node-v20.0.0-linux-x64.tar.gz'), tarball);
    hub = await startHub({ tokens: TOKENS, peers: ['my-laptop'], config: { dist_dir: distDir } });
    for (let i = 0; i < 6; i++) await hub.rpc('my-laptop', 'tools/call', { name: 'memory_remember', arguments: { type: 'fact', title: `压缩测试 ${i}`, body: `正文 ${i} `.repeat(40) } });
  });
  after(async () => { await hub.stop(); fs.rmSync(distDir, { recursive: true, force: true }); });

  const BIG = '/console/api/mcp'; // 工具清单，远超 1KB
  const body = (r) => JSON.parse(r.text);

  it('接口：没有 Accept-Encoding 就原样返回', async () => {
    const r = await raw(hub.port, BIG);
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-encoding'], undefined);
    assert.ok(r.body.length >= 1024, '这个接口得有 1KB 以上才能测压缩');
    assert.equal(r.headers['content-length'], String(r.body.length));
    assert.match(r.headers.vary, /Accept-Encoding/i, '≥1KB 的响应都要带 Vary，缓存才知道内容随请求头变');
    assert.ok(body(r).tools.length > 5);
  });

  it('接口：gzip 和 br 解开后与原文一致，且更小', async () => {
    const plain = await raw(hub.port, BIG);
    const gz = await raw(hub.port, BIG, { 'accept-encoding': 'gzip' });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.match(gz.headers.vary, /Accept-Encoding/i);
    assert.equal(gz.text, plain.text);
    assert.ok(gz.body.length < plain.body.length / 2, `${gz.body.length} vs ${plain.body.length}`);
    assert.equal(gz.headers['content-length'], String(gz.body.length));
    const br = await raw(hub.port, BIG, { 'accept-encoding': 'br' });
    assert.equal(br.headers['content-encoding'], 'br');
    assert.equal(br.text, plain.text);
    assert.ok(br.body.length < gz.body.length, `br ${br.body.length} 应比 gzip ${gz.body.length} 小`);
  });

  it('接口：两个都接受时用 br；br 被拒绝时用 gzip', async () => {
    assert.equal((await raw(hub.port, BIG, { 'accept-encoding': 'gzip, deflate, br' })).headers['content-encoding'], 'br');
    assert.equal((await raw(hub.port, BIG, { 'accept-encoding': 'br;q=0, gzip' })).headers['content-encoding'], 'gzip');
    assert.equal((await raw(hub.port, BIG, { 'accept-encoding': 'identity' })).headers['content-encoding'], undefined);
  });

  it('小响应不压，也不带 Vary', async () => {
    const r = await raw(hub.port, '/health', { 'accept-encoding': 'gzip, br' });
    assert.equal(r.status, 200);
    assert.ok(r.body.length < 1024);
    assert.equal(r.headers['content-encoding'], undefined);
    assert.equal(JSON.parse(r.text).ok, true);
  });

  it('接口仍然 no-store；错误响应也走同一套（小的不压）', async () => {
    const r = await raw(hub.port, BIG, { 'accept-encoding': 'br' });
    assert.equal(r.headers['cache-control'], 'no-store');
    const e = await raw(hub.port, '/console/api/nope', { 'accept-encoding': 'br' });
    assert.equal(e.status, 404);
    assert.ok(JSON.parse(e.text).error);
  });

  it('/browse/* 老接口：内容不变，也能压', async () => {
    const plain = await raw(hub.port, '/browse/data');
    const br = await raw(hub.port, '/browse/data', { 'accept-encoding': 'br' });
    assert.equal(plain.status, 200);
    assert.equal(br.text, plain.text);
    assert.ok(JSON.parse(plain.text).entries.length >= 6);
    assert.equal(br.headers['content-encoding'], plain.body.length >= 1024 ? 'br' : undefined);
    const viz = JSON.parse((await raw(hub.port, '/browse/viz-data')).text);
    assert.ok(viz.memories && viz.device_labels !== undefined && Array.isArray(viz.projects));
  });

  it('设备端接口（/v1/*、MCP）同样可压，解开后一致', async () => {
    const hdr = { authorization: `Bearer ${hub.tokenOf['my-laptop']}` };
    const get = (h) => raw(hub.port, '/v1/export', { ...hdr, ...h }, { gate: false });
    const plain = await get({});
    const gz = await get({ 'accept-encoding': 'gzip' });
    assert.equal(plain.status, 200);
    assert.ok(plain.body.length > 3000);
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(gz.text, plain.text);
  });

  it('静态文件：压缩后与原文件一致，小文件不压', async () => {
    const src = fs.readFileSync(path.join(HUB_DIR, 'console-core.js'), 'utf8');
    for (const [enc, name] of [['', undefined], ['gzip', 'gzip'], ['br', 'br']]) {
      const r = await raw(hub.port, '/console/console-core.js', enc ? { 'accept-encoding': enc } : {});
      assert.equal(r.status, 200);
      assert.equal(r.headers['content-encoding'], name);
      assert.equal(r.text, src);
      assert.match(r.headers.vary, /Accept-Encoding/i);
    }
    const tiny = await raw(hub.port, '/console/console-replay.js', { 'accept-encoding': 'br' });
    assert.ok(tiny.body.length < 1024);
    assert.equal(tiny.headers['content-encoding'], undefined);
  });

  it('已经压缩过的类型（Node 安装包）和流式下载原样传，不压', async () => {
    const r = await raw(hub.port, '/auto/node/linux-x64', { 'accept-encoding': 'br, gzip' }, { gate: false });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-encoding'], undefined);
    assert.ok(r.body.equals(tarball));
    assert.equal(r.headers['content-type'], 'application/octet-stream');
  });

  it('记忆浏览页年报（/browse/wrapped）内容不变', async () => {
    const plain = await raw(hub.port, '/browse/wrapped');
    const gz = await raw(hub.port, '/browse/wrapped', { 'accept-encoding': 'gzip' });
    assert.equal(plain.status, 200);
    assert.equal(gz.text, plain.text);
    assert.equal(plain.text, fs.readFileSync(path.join(HUB_DIR, 'wrapped.html'), 'utf8'));
  });
});
