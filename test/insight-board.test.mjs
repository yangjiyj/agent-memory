// 待整理页新增的两栏：记忆缺口（0 命中的查询，同义归并、忽略、30 天窗口）和冷记忆（起算日期、还在攒数据）。运行：node --test test/
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHub, TOKENS, GATE_HEADERS } from './helpers.mjs';
import { appendUsage, readUsage, writeMeta, writeEntryFile, row, ago } from './insight-util.mjs';

// 受限的浏览者不能自己改隐藏列表（访问控制），测试里直接改令牌文件把它清掉
const clearHide = (hub) => {
  const f = hub.path('tokens.json');
  const t = JSON.parse(fs.readFileSync(f, 'utf8'));
  delete t.devices['my-laptop'].hide_projects;
  fs.writeFileSync(f, JSON.stringify(t));
};

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const mem = (device, days, q, hits, extra = {}) => row('tool:memory_search', device, days, { d: q, hits, ...extra });

describe('待整理新栏：身份', () => {
  let hub;
  before(async () => { hub = await startHub({ tokens: TOKENS, peers: ['my-laptop'] }); });
  after(() => hub.stop());

  it('没有网关身份一律 403', async () => {
    for (const [m, r] of [['GET', 'insight/gaps'], ['GET', 'insight/cold'], ['POST', 'insight/ignore']]) {
      const res = await hub.api(m, r, m === 'POST' ? { key: 'x' } : undefined, {});
      assert.equal(res.status, 403, `${m} ${r}`);
      assert.ok(res.json?.error);
    }
  });

  it('方法不对 405；cold 的 days 要在 7–365 之间', async () => {
    assert.equal((await hub.post('insight/gaps', {})).status, 405);
    assert.equal((await hub.get('insight/ignore')).status, 405);
    for (const d of ['3', 'abc', '366', '30.5']) {
      const r = await hub.get(`insight/cold?days=${d}`);
      assert.equal(r.status, 400, d);
      assert.match(r.json.error, /days/);
    }
  });

  it('样式和脚本文件放行，console.html 引用了样式', async () => {
    for (const f of ['console-insight.css', 'console-insight.js']) assert.equal((await hub.web('GET', `/console/${f}`)).status, 200, f);
    assert.ok((await hub.web('GET', '/console/console-insight.css')).headers.get('content-type').includes('text/css'));
    assert.match(fs.readFileSync(path.join(ROOT, 'hub/console.html'), 'utf8'), /console-insight\.css/);
  });
});

describe('记忆缺口', () => {
  let hub;
  before(async () => {
    hub = await startHub({ tokens: TOKENS, peers: ['my-laptop'] });
    writeMeta(hub, ago(40));
    appendUsage(hub, [
      // 同义归并：证书 续期 / 续期 证书 / 证书续期失败
      mem('my-laptop', 1, '证书 续期', 0), mem('my-laptop', 2, '证书 续期', 0), mem('build-server', 3, '续期 证书', 0), mem('my-laptop', 5, '证书续期失败', 0),
      // 大小写、标点、词序
      mem('my-laptop', 2, 'Deploy Checklist', 0), mem('build-server', 4, 'checklist, deploy', 0),
      mem('my-laptop', 6, '备份 恢复', 0),
      // 有命中的不是缺口；旧行（没有 hits）不算 0 命中；出错（没有 hits）不算
      mem('my-laptop', 1, '部署', 3),
      { t: new Date(ago(1)).toISOString(), device: 'my-laptop', client: 'claude-code', op: 'tool:memory_search', d: '旧查询' },
      row('tool:memory_search', 'my-laptop', 1, { d: '报错的查询', err: 1 }),
      // 30 天窗口
      mem('my-laptop', 31, '过期查询', 0), mem('my-laptop', 29, '临界查询', 0),
      // 后来有了命中：已补上，不再是缺口
      mem('my-laptop', 5, '回滚 脚本', 0), mem('build-server', 1, '回滚 脚本', 2),
      // 对话和时间线的 0 命中单列；同一个词在记忆里有命中，不能抵掉对话里的缺口
      row('tool:conversation_search', 'my-laptop', 3, { d: '超卖', hits: 0 }), mem('my-laptop', 2, '超卖', 2),
      row('tool:memory_timeline', 'my-laptop', 2, { d: '周报', hits: 0 }),
      // 限定了项目的查询：对隐藏了这个项目的浏览者不可见
      mem('my-laptop', 2, '机密 查询', 0, { p: 'secret-proj' }),
    ]);
  });
  after(() => hub.stop());
  const gaps = async () => (await hub.get('insight/gaps')).json;
  const by = (g, text) => g.groups.find((x) => x.text === text);

  it('同义写法归成一组：次数、最近一次、谁搜的、组内最常见的写法；旧行和出错的行不算', async () => {
    const g = await gaps();
    assert.equal(g.window_days, 30);
    assert.ok(g.since);
    const a = by(g, '证书 续期');
    assert.ok(a, JSON.stringify(g.groups.map((x) => x.text)));
    assert.equal(a.count, 4);
    assert.equal(a.corpus, 'memory');
    assert.equal(a.device_count, 2);
    assert.deepEqual([...a.devices].sort(), ['build-server', 'my-laptop']);
    assert.equal(Math.round((Date.now() - Date.parse(a.last)) / 86400e3), 1);
    assert.deepEqual(a.variants.map((v) => [v.text, v.count]), [['证书 续期', 2], ['续期 证书', 1], ['证书续期失败', 1]]);
    assert.ok(!g.groups.some((x) => ['旧查询', '报错的查询', '部署'].includes(x.text)));
  });

  it('忽略大小写、标点、词序', async () => {
    const b = by(await gaps(), 'Deploy Checklist');
    assert.ok(b);
    assert.equal(b.count, 2);
    assert.equal(b.variants.length, 2);
  });

  it('只统计近 30 天：31 天前的不在，29 天前的在', async () => {
    const g = await gaps();
    assert.ok(!by(g, '过期查询'));
    assert.equal(by(g, '临界查询').count, 1);
  });

  it('后来搜到了的不再算缺口；对话里的缺口不会被记忆里的命中抵掉', async () => {
    const g = await gaps();
    assert.ok(!by(g, '回滚 脚本'));
    const conv = g.groups.find((x) => x.corpus === 'conversation');
    assert.equal(conv.text, '超卖');
    assert.ok(!g.groups.some((x) => x.corpus === 'memory' && x.text === '超卖'));
    assert.equal(g.groups.find((x) => x.corpus === 'timeline').text, '周报');
  });

  it('排序：次数多的在前，同样多的最近的在前', async () => {
    const g = await gaps();
    const counts = g.groups.map((x) => x.count);
    assert.deepEqual(counts, [...counts].sort((x, y) => y - x));
    assert.equal(g.groups[0].text, '证书 续期');
    const ones = g.groups.filter((x) => x.count === 1).map((x) => Date.parse(x.last));
    assert.deepEqual(ones, [...ones].sort((x, y) => y - x));
  });

  it('带项目的查询按浏览者过滤：隐藏了这个项目的浏览者看不到', async () => {
    assert.ok(by(await gaps(), '机密 查询'));
    assert.equal((await hub.post('devices/my-laptop', { hide_projects: ['secret-proj'] })).status, 200);
    assert.ok(!by(await gaps(), '机密 查询'));
    clearHide(hub);
    assert.ok(by(await gaps(), '机密 查询'));
  });

  it('忽略：从列表里消失、写审计、栏底的已忽略数加一；之后同组的新写法也不再出现；重启后仍然忽略', async () => {
    const a = by(await gaps(), '证书 续期');
    const r = await hub.post('insight/ignore', { key: a.key });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    let g = await gaps();
    assert.ok(!by(g, '证书 续期'));
    assert.equal(g.ignored_count, 1);
    assert.equal(g.ignored[0].text, '证书 续期');
    assert.equal(g.ignored[0].key, a.key);
    assert.ok(readUsage(hub).some((u) => u.op === 'console:insight-ignore'));
    appendUsage(hub, [mem('my-laptop', 0, '证书续期', 0)]);
    g = await gaps();
    assert.ok(!g.groups.some((x) => x.variants.some((v) => v.text.startsWith('证书续期') || v.text.startsWith('续期 证书'))));
    assert.equal(g.ignored_count, 1);
    assert.ok(fs.existsSync(hub.path('state/insight-ignore.json')));
    await hub.restart();
    g = await gaps();
    assert.ok(!by(g, '证书 续期'));
    assert.equal(g.ignored_count, 1);
  });

  it('恢复：回到列表，次数包含忽略期间的新记录', async () => {
    const key = (await gaps()).ignored[0].key;
    assert.equal((await hub.post('insight/ignore', { key, ignored: false })).status, 200);
    const g = await gaps();
    assert.equal(g.ignored_count, 0);
    assert.equal(by(g, '证书 续期').count, 5);
  });

  it('输入校验：不认识的 key 404；缺 key、ignored 不是布尔值 400；错误是中文', async () => {
    const nokey = await hub.post('insight/ignore', { key: 'memory:000000000000' });
    assert.equal(nokey.status, 404);
    assert.ok(/[一-鿿]/.test(nokey.json.error));
    assert.equal((await hub.post('insight/ignore', {})).status, 400);
    assert.equal((await hub.post('insight/ignore', { key: 'x'.repeat(300) })).status, 400);
    assert.equal((await hub.post('insight/ignore', { key: 'memory:abc', ignored: 'yes' })).status, 400);
    assert.equal((await hub.post('insight/ignore', { key: 'memory:000000000000', ignored: false })).status, 404);
  });

  it('查询里带的密钥打码', async () => {
    appendUsage(hub, [mem('my-laptop', 0, 'password=hunter2hunter2hunter2 配置', 0)]);
    const g = await gaps();
    assert.ok(!JSON.stringify(g).includes('hunter2hunter2hunter2'));
  });
});

describe('冷记忆', () => {
  let hub;
  const E = [
    { id: 'm-20260901-a00001', title: '从没读到过的旧记忆', project: 'shop-api', createdAgo: 70 },
    { id: 'm-20260901-a00002', title: '最近读过的旧记忆', project: 'shop-api', createdAgo: 70 },
    { id: 'm-20260901-a00003', title: '很久前读过一次', project: 'shop-api', createdAgo: 70 },
    { id: 'm-20261115-a00004', title: '刚写的新记忆', project: 'shop-api', createdAgo: 3 },
    { id: 'm-20260901-a00005', title: '已作废的旧记忆', project: 'shop-api', createdAgo: 70, state: 'retired' },
    { id: 'm-20260901-a00006', title: '机密项目的旧记忆', project: 'secret-proj', createdAgo: 70 },
    { id: 'm-20260901-a00007', title: '只被搜索结果带出过', project: '', createdAgo: 70 },
    { id: 'm-20260901-a00008', title: '读取报错过的旧记忆', project: '', createdAgo: 70 },
    { id: 'm-20260901-a00009', title: '放了很久但前两天刚更新', project: '', createdAgo: 70, updatedAgo: 2 },
  ];
  before(async () => {
    hub = await startHub({ tokens: TOKENS, peers: ['my-laptop'] });
    for (const e of E) writeEntryFile(hub, e);
    await hub.restart();
  });
  after(() => hub.stop());
  const cold = async (q = '') => (await hub.get(`insight/cold${q}`)).json;
  const ids = (c) => c.groups.flatMap((g) => g.items.map((i) => i.id)).sort();

  it('还没有任何带新字段的记录：没有起算日期，说明还在攒数据，不列条目', async () => {
    const c = await cold();
    assert.equal(c.since, null);
    assert.equal(c.accumulating, true);
    assert.equal(c.total, 0);
    assert.deepEqual(c.groups, []);
  });

  it('记录不足 days 天：还在攒数据，带起算日期和已攒天数，不列条目', async () => {
    writeMeta(hub, ago(10));
    appendUsage(hub, [row('tool:memory_get', 'my-laptop', 5, { d: 'm-20260901-a00002' })]);
    const c = await cold('?days=30');
    assert.equal(c.accumulating, true);
    assert.equal(c.days, 30);
    assert.equal(Date.parse(c.since), Date.parse(JSON.parse(fs.readFileSync(hub.path('state/usage-meta.json'), 'utf8')).since));
    assert.ok(Math.abs(c.observed_days - 10) < 0.2);
    assert.equal(c.total, 0);
    assert.deepEqual(c.groups, []);
    assert.equal((await cold('?days=7')).accumulating, false, '攒够 7 天就可以按 7 天看');
  });

  it('攒够了：列出近 days 天没被读到的有效记忆；读到的口径 = memory_get、命令行读取、搜索结果带出的 id，出错的读取不算', async () => {
    writeMeta(hub, ago(50));
    appendUsage(hub, [
      row('tool:memory_get', 'my-laptop', 40, { d: 'm-20260901-a00003' }),
      row('tool:memory_search', 'build-server', 2, { d: '某查询', hits: 1, ids: ['m-20260901-a00007'] }),
      row('tool:memory_get', 'my-laptop', 1, { d: 'm-20260901-a00008', err: 1 }),
      row('cli:get', 'my-laptop', 6, { d: 'm-20260901-a00002' }),
    ]);
    const c = await cold('?days=30');
    assert.equal(c.accumulating, false);
    assert.ok(Math.abs(c.observed_days - 50) < 0.2);
    assert.deepEqual(ids(c), ['m-20260901-a00001', 'm-20260901-a00003', 'm-20260901-a00006', 'm-20260901-a00008']);
    assert.equal(c.total, 4);
  });

  it('不列：新写的、近期更新过的、已作废的；每条带最后一次被读到的时间（没读到过是 null），没读到过的排前面', async () => {
    const c = await cold('?days=30');
    const all = c.groups.flatMap((g) => g.items);
    for (const bad of ['m-20261115-a00004', 'm-20260901-a00005', 'm-20260901-a00009', 'm-20260901-a00002', 'm-20260901-a00007']) assert.ok(!all.some((i) => i.id === bad), bad);
    const shop = c.groups.find((g) => g.project === 'shop-api');
    assert.deepEqual(shop.items.map((i) => i.id), ['m-20260901-a00001', 'm-20260901-a00003']);
    assert.equal(shop.items[0].last_read, null);
    assert.equal(Math.round((Date.now() - Date.parse(shop.items[1].last_read)) / 86400e3), 40);
    for (const k of ['id', 'type', 'title', 'created', 'updated', 'last_read']) assert.ok(k in shop.items[0], k);
    assert.equal(shop.count, 2);
    assert.ok(c.groups.some((g) => g.project === ''));
  });

  it('按浏览者过滤：隐藏了项目的浏览者看不到那个项目的冷记忆', async () => {
    assert.equal((await hub.post('devices/my-laptop', { hide_projects: ['secret-proj'] })).status, 200);
    const c = await cold('?days=30');
    assert.ok(!ids(c).includes('m-20260901-a00006'));
    assert.equal(c.total, 3);
    clearHide(hub);
  });

  it('days 越大越严：60 天内没被读到的更多（读过的 40 天前那条不算冷了）', async () => {
    const c = await cold('?days=60');
    assert.equal(c.accumulating, true, '只攒了 50 天，看 60 天要说明还在攒');
    writeMeta(hub, ago(70));
    const d = await cold('?days=60');
    assert.equal(d.accumulating, false);
    assert.ok(!ids(d).includes('m-20260901-a00003'));
  });

  it('侧栏徽标不变：待整理计数只有原来三栏，新栏不进去', async () => {
    const before = (await hub.web('GET', '/browse/manage-counts')).json;
    await hub.get('insight/gaps');
    await hub.get('insight/cold');
    const after = (await hub.web('GET', '/browse/manage-counts')).json;
    assert.deepEqual(after, before);
    assert.equal(after.total, after.proposed + after.duplicates + after.stale);
    assert.ok(!Object.keys(after).some((k) => /gap|cold|insight/.test(k)));
    assert.ok(!/Console\.badge/.test(fs.readFileSync(path.join(ROOT, 'hub/console-insight.js'), 'utf8')));
  });
});
