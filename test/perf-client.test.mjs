// 前端首屏汇总（console-core.js 里的 boot / Console.api 预取命中）：不开浏览器，把 console-core.js 放进 vm，DOM 用万能替身。
// 要验的是约定：汇总里有的 GET 直接命中、不发请求；写操作让它作废；10 秒过期；第二次命中给副本；汇总失败不影响启动。运行：node --test test/

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { HUB_DIR } from './perf-util.mjs';

const CORE = fs.readFileSync(path.join(HUB_DIR, 'console-core.js'), 'utf8');

// 什么属性都有、什么都能调用的替身：页面脚本碰到任何 DOM 接口都不会抛错
const any = new Proxy(function () {}, {
  get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : any),
  apply: () => any, construct: () => any, set: () => true,
});

const VIZ = { projects: [{ p: 'alpha' }], device_labels: { 'my-laptop': '笔记本' }, kpi: {} };

// 建一个"浏览器"：fetch 记录所有请求；boot 的响应由 bootReply 决定
function browser({ hash = '#/topology', bootReply, early } = {}) {
  const calls = [];
  let now = 1e12;
  const reply = (url) => {
    calls.push(url);
    if (url.startsWith('/console/api/boot')) return bootReply ? bootReply(url) : { ok: true, json: async () => ({ prime: {} }) };
    const body = url === '/browse/viz-data' ? { ...VIZ, from: 'network' } : { from: 'network', url };
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body };
  };
  class FakeDate extends Date { static now() { return now; } }
  const sandbox = {
    document: any, getComputedStyle: () => any, matchMedia: () => ({ matches: true }), requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {}, performance, structuredClone, URLSearchParams, console,
    location: { hash, search: '' }, history: { replaceState: () => {} }, Date: FakeDate,
    fetch: async (url) => { const r = reply(String(url)); if (r instanceof Error) throw r; return r; },
  };
  sandbox.window = sandbox;
  if (early) sandbox.__amBoot = early;
  vm.createContext(sandbox);
  vm.runInContext(CORE, sandbox, { filename: 'console-core.js' });
  return { C: sandbox.Console, calls, tick: (ms) => { now += ms; }, netCalls: () => calls.filter((u) => !u.startsWith('/console/api/boot')) };
}

const okBoot = (prime) => () => ({ ok: true, json: async () => ({ prime }) });

describe('前端首屏汇总命中', () => {
  it('启动先取汇总：loadData 和页面的第一次取数命中，不再发请求', async () => {
    const b = browser({ bootReply: okBoot({ '/browse/viz-data': VIZ, '/console/api/topology': { devices: [1, 2] }, '/health': { ok: true } }) });
    await b.C.start();
    assert.deepEqual(b.calls, ['/console/api/boot?page=topology'], '启动期间只有汇总这一个请求');
    assert.deepEqual(b.C.data(), VIZ);
    assert.equal(b.C.dev('my-laptop'), '笔记本', '设备显示名随 viz-data 一起到');
    assert.deepEqual(await b.C.api('/console/api/topology'), { devices: [1, 2] });
    assert.deepEqual(await b.C.api('/health'), { ok: true });
    assert.deepEqual(b.netCalls(), [], '命中的都没走网络');
    // 汇总里没有的照常单独取
    assert.equal((await b.C.api('/console/api/mcp')).from, 'network');
    assert.deepEqual(b.netCalls(), ['/console/api/mcp']);
  });

  it('按当前路由的页面 id 取汇总；乱写的路由回到 overview', async () => {
    for (const [hash, page] of [['#/lib/abc', 'lib'], ['#/timeline/2026-11-01', 'timeline'], ['#/nonsense', 'overview'], ['', 'overview'], ['#/topology?x=1', 'topology']]) {
      const b = browser({ hash });
      await b.C.start();
      assert.equal(b.calls[0], `/console/api/boot?page=${page}`, hash);
    }
  });

  it('页面里内联脚本已经提前发出的请求（window.__amBoot）直接用，不再自己取', async () => {
    const b = browser({ early: Promise.resolve({ prime: { '/browse/viz-data': VIZ, '/console/api/topology': { early: true } } }) });
    await b.C.start();
    assert.deepEqual(b.calls, [], 'start 自己不发汇总请求');
    assert.deepEqual(await b.C.api('/console/api/topology'), { early: true });
  });

  it('同一个地址允许命中多次（徽标和页面都要取），后面的拿到副本，改它不会串', async () => {
    const b = browser({ bootReply: okBoot({ '/browse/viz-data': VIZ, '/browse/manage-counts': { total: 3, list: [1] } }) });
    await b.C.start();
    const a1 = await b.C.api('/browse/manage-counts');
    const a2 = await b.C.api('/browse/manage-counts');
    assert.deepEqual(a1, a2);
    assert.notEqual(a1, a2);
    a2.list.push(2);
    assert.deepEqual((await b.C.api('/browse/manage-counts')).list, [1]);
    assert.deepEqual(b.netCalls(), []);
  });

  it('带 query 的地址要和 api() 拼出来的一致才命中；ttl 缓存照常生效', async () => {
    const b = browser({ bootReply: okBoot({ '/browse/viz-data': VIZ, '/console/api/topology/events?limit=30': { events: [] }, '/browse/audit?days=7': { total: 1 } }) });
    await b.C.start();
    assert.deepEqual(await b.C.api('/console/api/topology/events', { query: { since: '', limit: 30 } }), { events: [] }, '空值不进 query');
    assert.deepEqual(await b.C.api('/browse/audit', { query: { days: 7 }, ttl: 60000 }), { total: 1 });
    assert.deepEqual(await b.C.api('/browse/audit', { query: { days: 7 }, ttl: 60000 }), { total: 1 }, 'ttl 缓存里也有');
    assert.deepEqual(b.netCalls(), []);
    assert.equal((await b.C.api('/console/api/topology/events', { query: { since: '2026-11-01T00:00:00Z', limit: 30 } })).from, 'network', '参数不同就不命中');
  });

  it('任何写操作都让预取作废', async () => {
    const b = browser({ bootReply: okBoot({ '/browse/viz-data': VIZ, '/console/api/devices': { devices: ['old'] } }) });
    await b.C.start();
    await b.C.api('/console/api/devices/my-laptop', { body: { paused: true } });
    assert.equal((await b.C.api('/console/api/devices')).from, 'network', '写了之后再读必须是新的');
    assert.deepEqual(b.netCalls(), ['/console/api/devices/my-laptop', '/console/api/devices']);
  });

  it('10 秒后过期，之后都走网络', async () => {
    const b = browser({ bootReply: okBoot({ '/browse/viz-data': VIZ, '/health': { ok: true }, '/browse/todos': { items: [] } }) });
    await b.C.start();
    b.tick(9000);
    assert.deepEqual(await b.C.api('/health'), { ok: true });
    b.tick(2000);
    assert.equal((await b.C.api('/browse/todos')).from, 'network');
    assert.deepEqual(b.netCalls(), ['/browse/todos']);
  });

  it('改了设置后 loadData(true) 取到的是新数据，不是预取的旧数据', async () => {
    const b = browser({ bootReply: okBoot({ '/browse/viz-data': VIZ }) });
    await b.C.start();
    await b.C.api('/console/api/settings', { body: { device_labels: { x: 'y' } } });
    const d = await b.C.loadData(true);
    assert.equal(d.from, 'network', '改了设置后重读展示名必须是新的');
  });

  it('汇总失败（非 200、网络错、不是 JSON）不影响启动，各处照常自己取', async () => {
    for (const bootReply of [() => ({ ok: false, status: 403 }), () => new Error('offline'), () => ({ ok: true, json: async () => { throw new Error('bad json'); } }), () => ({ ok: true, json: async () => null })]) {
      const b = browser({ bootReply });
      await b.C.start();
      assert.deepEqual(b.netCalls(), ['/browse/viz-data'], 'loadData 自己取');
      assert.equal((await b.C.api('/console/api/topology')).from, 'network');
    }
    const early = browser({ early: Promise.resolve(null) });
    await early.C.start();
    assert.deepEqual(early.netCalls(), ['/browse/viz-data']);
  });
});
