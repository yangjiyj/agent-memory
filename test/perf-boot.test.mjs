// 首屏汇总接口 GET /console/api/boot：身份、内容与单独请求一致、老接口不变。运行：node --test test/

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startHub, TOKENS, GATE_HEADERS } from './helpers.mjs';
import { raw } from './perf-util.mjs';
import { bootPlan, BOOT_SHELL, BOOT_PAGES } from '../hub/perf.mjs';

// 这些字段每次请求都不一样（时间戳），比较时去掉
const strip = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === 'now' || k === 'generated' || k === 'since' ? undefined : x)));

describe('首屏汇总：清单', () => {
  it('每个页面的清单 = 外壳公共部分 + 自己的，不重复；未知页面只有公共部分', () => {
    assert.deepEqual(bootPlan('nope'), BOOT_SHELL);
    assert.deepEqual(bootPlan(''), BOOT_SHELL);
    assert.deepEqual(bootPlan('__proto__'), BOOT_SHELL);
    assert.deepEqual(bootPlan('constructor'), BOOT_SHELL);
    for (const page of Object.keys(BOOT_PAGES)) {
      const plan = bootPlan(page);
      assert.equal(new Set(plan).size, plan.length, page);
      assert.deepEqual(plan.slice(0, BOOT_SHELL.length), BOOT_SHELL);
    }
    for (const page of ['topology', 'overview', 'lib']) assert.ok(BOOT_PAGES[page].length, page);
  });

  it('清单里全是服务端自己的 GET 地址（不会被客户端带偏去取别的）', () => {
    for (const u of Object.values(BOOT_PAGES).flat().concat(BOOT_SHELL)) assert.match(u, /^\/(browse\/|console\/api\/|health$)/, u);
  });
});

describe('首屏汇总：接口', () => {
  let hub;
  before(async () => {
    hub = await startHub({ tokens: TOKENS, peers: ['my-laptop'] });
    for (let i = 0; i < 4; i++) await hub.rpc('my-laptop', 'tools/call', { name: 'memory_remember', arguments: { type: 'fact', title: `汇总测试 ${i}`, body: `正文 ${i}` } });
  });
  after(() => hub.stop());

  it('没有网关身份一律 403，什么都不返回', async () => {
    for (const headers of [{}, { 'x-am-gate': 'wrong', 'x-am-peer': 'my-laptop' }, { ...GATE_HEADERS, 'x-am-peer': 'stranger' }, { 'x-am-peer': 'my-laptop' }]) {
      const r = await hub.get('boot?page=topology', headers);
      assert.equal(r.status, 403, JSON.stringify(headers));
      assert.ok(r.json?.error);
      assert.equal(r.json.prime, undefined);
      assert.ok(!r.text.includes('devices'), '403 里不能带数据');
    }
  });

  it('方法不对 405，未知路径照旧 404', async () => {
    assert.equal((await hub.post('boot?page=topology', {})).status, 405);
    assert.equal((await hub.get('boot2')).status, 404);
  });

  it('拓扑页：返回外壳公共数据和拓扑聚合，一次拿齐', async () => {
    const r = await hub.get('boot?page=topology');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json.prime), bootPlan('topology').filter((u) => r.json.prime[u] !== undefined));
    for (const u of bootPlan('topology')) assert.ok(u in r.json.prime, `缺 ${u}`);
    const topo = r.json.prime['/console/api/topology'];
    assert.ok(Array.isArray(topo.devices) && topo.hub && topo.viewer, '拓扑的主要字段');
    assert.ok(r.json.prime['/browse/viz-data'].memories.total >= 4);
    assert.ok(r.json.prime['/browse/viz-data'].device_labels !== undefined, '设备显示名随 viz-data 一起来');
    assert.ok(Array.isArray(r.json.prime['/console/api/topology/events?limit=30'].events));
    assert.equal(r.json.prime['/health'].ok, true);
  });

  it('汇总里每一项都和单独请求的结果一样（复用现有实现，字段自动一致）', async () => {
    for (const page of ['topology', 'overview', 'lib', 'triage', 'graph', 'todos', 'timeline', 'projects', 'agents', 'mcp', 'audit', 'jobs', 'settings', 'devices', 'convs']) {
      const r = await hub.get(`boot?page=${page}`);
      assert.equal(r.status, 200, page);
      for (const u of bootPlan(page)) {
        assert.ok(u in r.json.prime, `${page}: 缺 ${u}`);
        const direct = await hub.web('GET', u);
        assert.equal(direct.status, 200, u);
        assert.deepEqual(strip(r.json.prime[u]), strip(direct.json ?? direct.text), `${page}: ${u}`);
      }
    }
  });

  it('概览页和记忆库页首屏也只多这一个请求：清单覆盖它们启动时会发的 GET', () => {
    assert.deepEqual(bootPlan('overview'), [...BOOT_SHELL, '/browse/todos', '/browse/viz-agents', '/browse/viz-live', '/browse/viz-galaxy']);
    assert.ok(bootPlan('lib').includes('/browse/data') && bootPlan('lib').includes('/browse/semantic'));
  });

  it('取失败的项略过，不影响其他项；页面参数乱写也只返回公共部分', async () => {
    for (const page of ['nope', '', '__proto__', '../../etc/passwd', 'a'.repeat(5000), '%00']) {
      const r = await hub.get(`boot?page=${encodeURIComponent(page)}`);
      assert.equal(r.status, 200, page.slice(0, 20));
      assert.deepEqual(Object.keys(r.json.prime), BOOT_SHELL, page.slice(0, 20));
    }
    assert.deepEqual(Object.keys((await hub.get('boot')).json.prime), BOOT_SHELL);
  });

  it('响应不含配置里的密钥和令牌哈希', async () => {
    const hashes = Object.values(hub.read('tokens.json').devices).map((v) => v.sha256);
    for (const page of ['topology', 'devices', 'settings', 'mcp', 'jobs', 'overview']) {
      const text = (await hub.get(`boot?page=${page}`)).text;
      assert.ok(!text.includes('test-gate-secret'), page);
      for (const h of hashes) assert.ok(!text.includes(h), page);
      for (const t of Object.values(hub.tokenOf)) assert.ok(!text.includes(t), page);
    }
  });

  it('子请求不带 Accept-Encoding：汇总内容是原文，整体响应可以压缩', async () => {
    const plain = await raw(hub.port, '/console/api/boot?page=lib');
    const br = await raw(hub.port, '/console/api/boot?page=lib', { 'accept-encoding': 'br' });
    assert.equal(plain.status, 200);
    assert.equal(br.headers['content-encoding'], 'br');
    assert.equal(br.text, plain.text);
    assert.equal(br.headers['cache-control'], 'no-store');
    assert.ok(JSON.parse(br.text).prime['/browse/data'].entries.length >= 4);
    // 带条件请求头也不影响子请求
    const cond = await raw(hub.port, '/console/api/boot?page=lib', { 'if-none-match': '*', 'accept-encoding': 'gzip' });
    assert.equal(cond.status, 200);
    assert.ok(JSON.parse(cond.text).prime['/browse/data']);
  });

  it('汇总是只读的：不写审计、不改令牌文件', async () => {
    const usage = () => { try { return fs.readFileSync(hub.path('state/usage.jsonl'), 'utf8'); } catch { return ''; } };
    const before = { usage: usage(), tokens: fs.readFileSync(hub.path('tokens.json'), 'utf8') };
    await hub.get('boot?page=overview');
    await hub.get('boot?page=topology');
    assert.equal(usage(), before.usage);
    assert.equal(fs.readFileSync(hub.path('tokens.json'), 'utf8'), before.tokens);
  });
});

describe('老的 /browse/* 接口不变', () => {
  let hub;
  before(async () => { hub = await startHub({ tokens: TOKENS, peers: ['my-laptop'] }); });
  after(() => hub.stop());

  it('身份校验：没有身份 403，有身份 200，字段还在', async () => {
    for (const p of ['/browse/viz-data', '/browse/data', '/browse/manage-counts', '/browse/todos', '/browse/viz-agents', '/browse/viz-live', '/browse/graph', '/browse/projects']) {
      assert.equal((await hub.web('GET', p, undefined, {})).status, 403, p);
      assert.equal((await hub.web('GET', p)).status, 200, p);
    }
    const viz = (await hub.web('GET', '/browse/viz-data')).json;
    for (const k of ['kpi', 'projects', 'memories', 'device_labels']) assert.ok(k in viz, k);
    assert.ok(Array.isArray((await hub.web('GET', '/browse/data')).json.entries));
  });
});
