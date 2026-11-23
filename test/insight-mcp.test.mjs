// MCP 页每个工具近 7 天的耗时（中位数、95 分位，最近秩法）和失败率。运行：node --test test/
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHub, TOKENS } from './helpers.mjs';
import { appendUsage, row } from './insight-util.mjs';

describe('MCP 页：耗时和失败率', () => {
  let hub;
  before(async () => {
    hub = await startHub({ tokens: TOKENS, peers: ['my-laptop'] });
    const S = (days, extra) => row('tool:memory_search', 'my-laptop', days, extra);
    appendUsage(hub, [
      // memory_search：5 条带 dur（10 20 30 40 100，其中 40 那条出错），3 条旧格式（没有 dur），1 条 9 天前（不在 7 天内）
      S(0.5, { dur: 10 }), S(1, { dur: 20 }), S(1.5, { dur: 30 }), S(2, { dur: 40, err: 1 }), S(3, { dur: 100 }),
      { t: new Date(Date.now() - 86400e3).toISOString(), device: 'my-laptop', client: 'claude-code', op: 'tool:memory_search', d: '旧' },
      { t: new Date(Date.now() - 2 * 86400e3).toISOString(), device: 'my-laptop', client: 'claude-code', op: 'tool:memory_search', d: '旧' },
      { t: new Date(Date.now() - 3 * 86400e3).toISOString(), device: 'my-laptop', client: 'claude-code', op: 'tool:memory_search', d: '旧', err: 1 },
      S(9, { dur: 5000, err: 1 }),
      // memory_get：只有旧格式
      { t: new Date(Date.now() - 86400e3).toISOString(), device: 'my-laptop', client: 'claude-code', op: 'tool:memory_get', d: 'm-1' },
      { t: new Date(Date.now() - 2 * 86400e3).toISOString(), device: 'my-laptop', client: 'claude-code', op: 'tool:memory_get', d: 'm-2' },
      // memory_digest：4 条，没有出错
      row('tool:memory_digest', 'my-laptop', 0.2, { dur: 7 }), row('tool:memory_digest', 'my-laptop', 0.3, { dur: 9 }),
      row('tool:memory_digest', 'my-laptop', 0.4, { dur: 11 }), row('tool:memory_digest', 'my-laptop', 0.5, { dur: 13 }),
      // 命令行的调用不算工具
      row('cli:search', 'my-laptop', 0.1, { dur: 99999, err: 1 }),
    ]);
  });
  after(() => hub.stop());
  const tool = async (name) => (await hub.get('mcp')).json.tools.find((t) => t.name === name);

  it('有 dur 的行才进耗时；失败率分母只算有 dur 的新记录；超过 7 天的不算', async () => {
    const t = await tool('memory_search');
    assert.equal(t.calls_7d, 8, '调用次数口径不变：7 天内的全部行');
    assert.equal(t.timed_7d, 5);
    assert.equal(t.p50_ms, 30);
    assert.equal(t.p95_ms, 100);
    assert.equal(t.judged_7d, 5);
    assert.equal(t.errors_7d, 1);
    assert.equal(t.err_rate, 0.2);
  });

  it('最近秩法：偶数条时中位数取第 ceil(n/2) 个；没出错失败率是 0', async () => {
    const t = await tool('memory_digest');
    assert.equal(t.timed_7d, 4);
    assert.equal(t.p50_ms, 9);
    assert.equal(t.p95_ms, 13);
    assert.equal(t.err_rate, 0);
  });

  it('只有旧记录、或没人调过的工具：统计都是 null（界面显示 —），调用次数照旧', async () => {
    const g = await tool('memory_get');
    assert.equal(g.calls_7d, 2);
    assert.equal(g.timed_7d, 0);
    assert.equal(g.p50_ms, null);
    assert.equal(g.p95_ms, null);
    assert.equal(g.judged_7d, 0);
    assert.equal(g.err_rate, null);
    const never = await tool('kb_read');
    assert.equal(never.calls_7d, 0);
    assert.equal(never.p50_ms, null);
    assert.equal(never.err_rate, null);
  });

  it('命令行的调用不进工具的统计', async () => {
    const t = (await hub.get('mcp')).json.tools;
    assert.ok(!t.some((x) => x.name.startsWith('cli:')));
    assert.equal((await tool('memory_search')).errors_7d, 1);
  });

  it('真实调用之后统计跟着走；原有字段都还在', async () => {
    const before = await tool('memory_recent');
    await hub.rpc('my-laptop', 'tools/call', { name: 'memory_recent', arguments: {} });
    const after = await tool('memory_recent');
    assert.equal(after.calls_7d, before.calls_7d + 1);
    assert.equal(after.timed_7d, 1);
    assert.ok(Number.isInteger(after.p50_ms) && after.p50_ms >= 0 && after.p95_ms >= after.p50_ms);
    assert.equal(after.err_rate, 0);
    for (const k of ['name', 'description', 'kind', 'calls_7d', 'last_call', 'disabled']) assert.ok(k in after, k);
  });
});
