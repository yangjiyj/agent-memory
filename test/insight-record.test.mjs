// 用量记录的新字段（hits / ids / p / dur / err）和 usage-meta.json：中心真的把它们写进 usage.jsonl，旧行照样能读，增量缓存不坏。运行：node --test test/
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startHub, TOKENS } from './helpers.mjs';
import { appendUsage, readUsage, iso, ago } from './insight-util.mjs';

describe('用量记录：新字段', () => {
  let hub; let id;
  before(async () => { hub = await startHub({ tokens: { ...TOKENS, 'ro-box': { token: 'tok-ro-secret-value', readonly: true } }, peers: ['my-laptop'] }); });
  after(() => hub.stop());
  const call = (name, args, dev = 'my-laptop') => hub.rpc(dev, 'tools/call', { name, arguments: args });
  const rows = (op) => readUsage(hub).filter((r) => r.op === op);
  const isDur = (v) => Number.isInteger(v) && v >= 0;

  it('搜索：记命中条数、命中的 id、限定的项目和耗时；0 命中 hits 为 0', async () => {
    const w = await call('memory_remember', { type: 'fact', title: '证书续期要提前一周', body: '到期前一周跑续期脚本', project: 'shop-api' });
    id = /m-\d{8}-[0-9a-f]{6}/.exec(w.content[0].text)[0];
    await call('memory_search', { query: '证书续期', project: 'shop-api' });
    await call('memory_search', { query: '完全没有的东西 zzz' });
    const [hit, miss] = rows('tool:memory_search');
    assert.equal(hit.d, '证书续期');
    assert.equal(hit.hits, 1);
    assert.deepEqual(hit.ids, [id]);
    assert.equal(hit.p, 'shop-api');
    assert.ok(isDur(hit.dur));
    assert.equal(hit.err, undefined);
    assert.equal(miss.hits, 0);
    assert.equal(miss.ids, undefined);
    assert.equal(miss.p, undefined);
  });

  it('耗时叫 dur，不叫 ms：每一条 tool: 记录都有；非搜索工具没有 hits', async () => {
    await call('memory_get', { id });
    await call('memory_recent', {});
    await call('memory_digest', {});
    const tool = readUsage(hub).filter((r) => r.op.startsWith('tool:'));
    assert.ok(tool.length >= 5);
    for (const r of tool) { assert.ok(isDur(r.dur), `${r.op} 缺 dur`); assert.equal(r.ms, undefined); }
    for (const op of ['tool:memory_get', 'tool:memory_recent', 'tool:memory_digest', 'tool:memory_remember']) assert.equal(rows(op)[0].hits, undefined, op);
  });

  it('读取：memory_get 的 d 是条目 id，找不到算 err；err 只在出错时才有', async () => {
    await call('memory_get', { id: 'm-00000000-zzzzzz' });
    const [ok, bad] = rows('tool:memory_get');
    assert.equal(ok.d, id);
    assert.equal(ok.err, undefined);
    assert.equal(bad.d, 'm-00000000-zzzzzz');
    assert.equal(bad.err, 1);
    assert.ok(isDur(bad.dur));
  });

  it('出错（UserError、停用、只读）都算 err，成功的调用不带 err', async () => {
    await call('memory_update', { id: 'm-00000000-zzzzzz', title: '不存在' });
    await call('memory_remember', { type: 'fact', title: '只读机器写' }, 'ro-box');
    await hub.post('mcp/tool', { name: 'memory_digest', disabled: true });
    await call('memory_digest', {});
    await hub.post('mcp/tool', { name: 'memory_digest', disabled: false });
    assert.equal(rows('tool:memory_update')[0].err, 1);
    assert.equal(rows('tool:memory_remember').find((r) => r.device === 'ro-box').err, 1);
    const digests = rows('tool:memory_digest');
    assert.equal(digests[0].err, undefined);
    assert.equal(digests[digests.length - 1].err, 1);
    assert.equal(rows('tool:memory_remember').find((r) => r.device === 'my-laptop').err, undefined);
  });

  it('其他搜索类工具也记命中数：kb_search、conversation_search、带 query 的 memory_timeline', async () => {
    await call('kb_search', { query: '没有的卡片内容' });
    await call('conversation_search', { query: '没有的对话内容' });
    await call('memory_timeline', { query: '没有的日志', days: 3 });
    await call('memory_timeline', { days: 3 });
    await call('kb_search', {});
    assert.equal(rows('tool:kb_search')[0].hits, 0);
    assert.equal(rows('tool:kb_search')[1].err, 1);
    assert.equal(rows('tool:conversation_search')[0].hits, 0);
    const [withQuery, without] = rows('tool:memory_timeline');
    assert.equal(withQuery.hits, 0);
    assert.equal(withQuery.d, '没有的日志');
    assert.equal(without.hits, undefined);
  });

  it('命令行的搜索和读取也记 hits、ids、dur', async () => {
    const s = await hub.device('my-laptop', `/v1/search?q=${encodeURIComponent('证书续期')}`);
    assert.equal(s.status, 200);
    assert.equal((await hub.device('my-laptop', `/v1/entries/${id}`)).status, 200);
    assert.equal((await hub.device('my-laptop', '/v1/entries/m-00000000-zzzzzz')).status, 404);
    const cs = rows('cli:search').pop();
    assert.equal(cs.d, '证书续期');
    assert.equal(cs.hits, 1);
    assert.deepEqual(cs.ids, [id]);
    assert.ok(isDur(cs.dur));
    const [g1, g2] = rows('cli:get');
    assert.equal(g1.d, id);
    assert.equal(g1.err, undefined);
    assert.equal(g2.err, 1);
  });

  it('usage-meta.json：第一次写带新字段的记录时落盘，起算时间就是那一行的时间，之后不变（重启也不变）', async () => {
    const meta = hub.read('state/usage-meta.json');
    const first = readUsage(hub).find((r) => Number.isInteger(r.dur));
    assert.equal(meta.since, first.t);
    await hub.restart();
    await call('memory_digest', {});
    assert.equal(hub.read('state/usage-meta.json').since, first.t);
  });

  it('旧行（没有新字段）混在里面：各接口不报错，旧的搜索不算 0 命中', async () => {
    appendUsage(hub, [
      { t: iso(ago(1)), device: 'my-laptop', client: 'claude-code', op: 'tool:memory_search', d: '旧版记录的查询' },
      { t: iso(ago(1)), device: 'my-laptop', client: 'claude-code', op: 'tool:memory_get', d: 'm-20260101-000000' },
      { t: iso(ago(1)), device: 'my-laptop', client: 'cli', op: 'cli:search' },
    ]);
    for (const r of ['devices', 'mcp', 'jobs', 'topology', 'topology/events?limit=50', 'insight/gaps', 'insight/cold']) assert.equal((await hub.get(r)).status, 200, r);
    const gaps = (await hub.get('insight/gaps')).json.groups;
    assert.ok(!gaps.some((g) => g.text.includes('旧版记录的查询')));
  });

  it('增量缓存：追加新行后仍然正确，dur 不会盖掉时间戳', async () => {
    const before = (await hub.get('topology')).json.hub.calls_7d;
    const t = Date.now() - 30e3;
    appendUsage(hub, [{ t: iso(t), device: 'my-laptop', client: 'claude-code', op: 'tool:memory_get', d: 'm-20260101-000001', dur: 5 }]);
    assert.equal((await hub.get('topology')).json.hub.calls_7d, before + 1);
    const ev = (await hub.get('topology/events?limit=100')).json.events;
    assert.ok(ev.some((e) => e.text === '读了一条记忆' && e.t === iso(t)), '事件的时间应是那一行的 t，不是 dur');
    await call('memory_digest', {});
    assert.equal((await hub.get('topology')).json.hub.calls_7d, before + 2);
    assert.ok(fs.readFileSync(hub.path('state/usage.jsonl'), 'utf8').endsWith('\n'));
  });
});
