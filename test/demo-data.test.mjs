// 演示数据脚本的测试：生成到临时目录 → 起中心 → 关键接口的数据量不为零。运行：node --test test/
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

describe('演示数据', () => {
  let dir; let base; let child; let parent;
  before(async () => {
    parent = fs.mkdtempSync(path.join(os.tmpdir(), 'am-demo-test-'));
    dir = path.join(parent, 'data');
    const port = await freePort();
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'demo-data.mjs'), dir, '--port', String(port)], { encoding: 'utf8', timeout: 240000 });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    child = spawn(process.execPath, [path.join(ROOT, 'hub', 'server.mjs')], { env: { ...process.env, AGENT_MEMORY_CONFIG: path.join(dir, 'config.json') }, stdio: 'ignore' });
    base = `http://127.0.0.1:${port}`;
    for (let i = 0; ; i++) {
      try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* 还没起来 */ }
      if (i > 100) throw new Error('中心没起来');
      await new Promise((res) => setTimeout(res, 100));
    }
  });
  after(async () => {
    child?.kill('SIGTERM');
    if (child && child.exitCode === null) await new Promise((r) => child.once('exit', r));
    fs.rmSync(parent, { recursive: true, force: true });
  });
  const get = async (p) => { const res = await fetch(`${base}${p}`); assert.equal(res.status, 200, p); return res.json(); };

  it('目录非空时拒绝执行', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'demo-data.mjs'), dir], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /拒绝覆盖/);
  });

  it('记忆、对话、日志的数据量不为零', async () => {
    const h = await get('/health');
    assert.ok(h.entries > 200);
    const v = await get('/browse/viz-data');
    assert.ok(v.kpi.sessions > 1000);
    assert.ok(v.kpi.journal_segments > 1000);
    assert.ok(v.kpi.devices >= 5);
    assert.ok(v.projects.length >= 6);
    assert.ok((await get('/browse/viz-galaxy')).rows.length > 1000);
  });

  it('待整理、待办、图谱、审计、实时都有内容', async () => {
    const m = await get('/browse/manage-counts');
    assert.ok(m.proposed > 0 && m.duplicates > 0 && m.stale > 0);
    const t = await get('/browse/todos');
    assert.ok(t.items.length > 0 && t.stalled.length > 0);
    const g = await get('/browse/graph');
    assert.ok(g.nodes.length > 10 && g.edges.length > 10);
    const a = await get('/browse/audit');
    assert.ok(a.total > 100);
    const live = await get('/browse/viz-live');
    assert.ok(Object.values(live.devices).some((d) => Object.values(d).some((x) => x.age < 20)));
    assert.ok((await get('/browse/viz-extra')).milestones.length > 0);
  });

  it('设备页和 MCP 页有内容', async () => {
    const d = await get('/console/api/devices');
    assert.ok(d.devices.filter((x) => x.role === 'device').length >= 5);
    assert.ok(d.devices.some((x) => x.policy.readonly) && d.devices.some((x) => x.policy.hide_projects.length));
    const mcp = await get('/console/api/mcp');
    assert.ok(mcp.tools.some((t) => t.calls_7d > 0));
    const j = await get('/console/api/jobs');
    assert.ok(j.sync.stale_count >= 1 && j.extract.total > 0);
  });

  it('摘要页有没信息量、重复的记忆，修改历史有多版的记忆', async () => {
    const d = await get('/console/api/digest');
    assert.ok(d.items.length > 200 && d.budget.used > 0 && d.budget.used <= d.budget.limit + 100);
    const vague = d.items.filter((x) => x.flags.includes('vague')).map((x) => x.title);
    for (const t of ['Memory Block', 'Notes', '基础设施', '设备台账', '代码生成纪律']) assert.ok(vague.includes(t), t);
    assert.ok(d.counts.dup_groups >= 3 && d.counts.dup_items >= 7);
    const week = d.items.filter((x) => x.title.startsWith('周报要按项目分段') || x.title.startsWith('写周报要按项目分段'));
    assert.equal(week.length, 3);
    assert.equal(new Set(week.map((x) => x.dup)).size, 1);
    const entries = (await get('/browse/data')).entries;
    const e = entries.find((x) => x.title.startsWith('发布窗口'));
    const h = await get(`/console/api/memory/${e.id}/history`);
    assert.ok(h.total >= 3 && h.restorable && h.versions.some((v) => v.action === '编辑'));
  });

  it('拓扑页的流量、心跳条、事件带都有内容', async () => {
    const t = await get('/console/api/topology');
    const devs = t.devices;
    assert.ok(devs.filter((d) => d.flow.up_24h > 0 && d.flow.down_24h > 0).length >= 4);
    for (const d of devs) {
      assert.equal(d.flow.hours.length, 24);
      assert.equal(d.flow.hours.reduce((a, b) => a + b, 0), d.flow.up_24h);
    }
    assert.ok(devs.some((d) => d.flow.hours.filter((x) => x > 0).length >= 3));
    assert.ok(devs.some((d) => d.agents.some((a) => a.up_24h > 0)) && devs.some((d) => d.agents.some((a) => a.down_24h > 0)));
    assert.equal(t.hub.up_24h, devs.reduce((a, d) => a + d.flow.up_24h, 0));
    assert.ok(t.hub.down_24h > 0);
    assert.ok(t.reporters.length && Date.now() - Date.parse(t.reporters[0].last_active) < 12 * 3600e3 && t.reporters[0].last_op === '/v1/report');
    assert.ok(t.extractors.length && Date.now() - Date.parse(t.extractors[0].last_active) < 3600e3 && t.extractors[0].last_op);
    const ev = (await get('/console/api/topology/events?limit=100')).events;
    const kinds = new Set(ev.map((e) => e.kind));
    for (const k of ['read', 'write', 'talk', 'extract', 'report', 'console']) assert.ok(kinds.has(k), `事件缺 ${k}`);
    assert.ok(ev.filter((e) => Date.now() - Date.parse(e.t) < 35 * 60e3).length >= 8);
    assert.ok(new Set(ev.filter((e) => e.kind === 'read' || e.kind === 'write').map((e) => e.device)).size >= 4);
  });
});
