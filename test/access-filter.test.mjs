// 访问控制：控制台和 /browse/* 按浏览者那台设备的 hide_projects 过滤。
// 造两个设备（build-server 设了 hide_projects，my-laptop 没设），写入含被隐藏项目和普通项目的记忆、对话、工作日志、待办，
// 逐个接口断言：设了的设备在整个响应里扫不到被隐藏项目的任何痕迹，没设的设备完全不变。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { startHub } from './helpers.mjs';
import { seed, leaks, AS, HIDDEN, VISIBLE, TOKENS, PEERS } from './access-fixture.mjs';

const strip = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === 'now' || k === 'generated' ? undefined : x)));

describe('访问控制：隐藏项目（控制台和 /browse）', () => {
  let hub; let S; let routes; const baseline = {};
  const as = (name, route, method = 'GET', body) => hub.web(method, route, body, AS(name));
  const SCOPED = 'build-server';
  const FREE = 'my-laptop';

  before(async () => {
    hub = await startHub({ tokens: TOKENS, peers: PEERS, config: { device_labels: { 'my-laptop': '笔记本' } } });
    S = await seed(hub);
    await hub.rpc(FREE, 'tools/call', { name: 'memory_search', arguments: { query: 'SEARCHQ-77' } });
    // 被隐藏项目也有一条分享链接，限制可见范围的浏览者在列表里不该看到
    const sh = await as(FREE, '/console/api/shares', 'POST', { project: HIDDEN, kind: 'timeline', days: 7 });
    assert.equal(sh.status, 200, sh.text);
    // [路由, 没设的设备应该能在里面看到被隐藏项目的痕迹]
    routes = [
      ['/console/api/devices', true],
      ['/console/api/jobs', true],
      ['/console/api/topology', true],
      ['/console/api/topology/events?limit=100', true],
      [`/console/api/topology/events?limit=100&project=${HIDDEN}`, true],
      ['/console/api/conv/search?q=MSG&limit=30', true],
      ['/console/api/shares', true],
      ['/browse/data', true],
      ['/browse/viz-data', true],
      [`/browse/viz-day?date=${S.days.SH}`, true],
      [`/browse/viz-day?date=${S.days.SM_old}`, true],
      ['/browse/viz-extra', true],
      ['/browse/viz-galaxy', true],
      ['/browse/viz-search?q=journal', false],
      ['/browse/viz-search?q=MSG', false],
      ['/browse/viz-live', true],
      ['/browse/viz-agents', true],
      ['/browse/projects', true],
      [`/browse/handoff?project=${VISIBLE}`, true],
      ['/browse/handoff?query=journal', true],
      [`/browse/handoff?project=${HIDDEN}`, true],
      ['/browse/todos', true],
      ['/browse/graph', true],
      [`/browse/entity?name=${VISIBLE}`, false],
      [`/browse/entity?name=${HIDDEN}`, true],
      ['/browse/manage-counts', false],
      ['/browse/manage-data', true],
      ['/browse/audit?days=7', true],
      ['/browse/wrapped-data', true],
      ['/browse/semantic?q=anything', false],
    ];
  });
  after(() => hub.stop());

  it('设之前：两台设备看到的完全一样，被隐藏项目的内容都在（对照）', async () => {
    for (const r of ['/browse/data', '/browse/projects', '/browse/graph', '/browse/viz-galaxy', '/browse/manage-data', `/browse/viz-day?date=${S.days.SH}`, '/console/api/conv/search?q=MSG&limit=30', '/browse/viz-search?q=journal']) {
      const a = await as(FREE, r);
      const b = await as(SCOPED, r);
      assert.equal(a.status, 200, r);
      assert.deepEqual(strip(b.json), strip(a.json), `${r} 设之前应该一样`);
      baseline[r] = strip(a.json);
    }
    assert.ok(leaks(JSON.stringify(baseline['/browse/data']), S.forbidden).length, '对照：设之前能看到被隐藏项目的条目');
  });

  it('设 hide_projects（大小写和数据里不同）：由 my-laptop 给 build-server 设', async () => {
    const r = await as(FREE, '/console/api/devices/build-server', 'POST', { hide_projects: ['QX-hidden-91'] });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.policy.hide_projects, ['QX-hidden-91'], '没设的设备看到完整的策略');
    const c = await as(FREE, '/console/api/devices/ci-box', 'POST', { hide_projects: ['zz-vis-only', 'QX-HIDDEN-91'] });
    assert.equal(c.status, 200, c.text);
  });

  it('逐个接口：设了的设备在整个响应里扫不到被隐藏项目的任何痕迹；没设的设备能看到', async () => {
    for (const [route, sees] of routes) {
      const hid = await as(SCOPED, route);
      const expected = route === `/browse/handoff?project=${HIDDEN}` ? 400 : 200;
      assert.equal(hid.status, expected, `${route} -> ${hid.status} ${hid.text.slice(0, 200)}`);
      assert.deepEqual(leaks(hid.text, S.forbidden), [], `${route} 漏了被隐藏项目的痕迹`);
      const free = await as(FREE, route);
      assert.equal(free.status, 200, route);
      if (sees) assert.ok(leaks(free.text, S.forbidden).length, `${route} 对照：没设的设备应该看得到被隐藏项目的内容`);
    }
  });

  it('设了的设备：普通项目和没有项目的内容照常可见', async () => {
    const data = (await as(SCOPED, '/browse/data')).text;
    for (const m of ['visible-title-V1', 'visible-status-V2', 'noproj-pref-N1']) assert.ok(data.includes(m), `/browse/data 应有 ${m}`);
    const day = (await as(SCOPED, `/browse/viz-day?date=${S.days.SV}`)).text;
    assert.ok(day.includes('journal-visible-J2') && day.includes('journal-noproj-J3'));
    const h = (await as(SCOPED, `/browse/handoff?project=${VISIBLE}`)).text;
    assert.ok(h.includes('visible-title-V1') && h.includes('journal-visible-J2') && h.includes('noproj-pref-N1'));
    const live = (await as(SCOPED, '/browse/viz-live')).json;
    const titles = live.recent.map((x) => x.title);
    assert.ok(titles.includes('title-visible-S2') && titles.includes('title-noproj-S3'));
    assert.ok(!titles.includes('title-hidden-S1') && !titles.includes('title-cwd-S4') && !titles.includes('title-multi-S5'));
  });

  it('没设的设备完全不变（设 hide_projects 前后同一批接口一字不差）', async () => {
    for (const [r, before] of Object.entries(baseline)) {
      const a = await as(FREE, r);
      assert.deepEqual(strip(a.json), before, `${r} 对没设的设备不该有任何变化`);
    }
  });

  it('总数按看得到的内容重算', async () => {
    const free = (p) => as(FREE, p).then((r) => r.json);
    const hid = (p) => as(SCOPED, p).then((r) => r.json);
    const [vf, vh] = [await free('/browse/viz-data'), await hid('/browse/viz-data')];
    assert.equal(vf.kpi.sessions, 5);
    assert.equal(vh.kpi.sessions, 2, '只有 SV 和 SN 看得到');
    assert.equal(vf.kpi.journal_segments, 5);
    assert.equal(vh.kpi.journal_segments, 2);
    assert.equal(vf.memories.total, 9);
    assert.equal(vh.memories.total, 4);
    assert.ok(vh.projects.every((x) => x.p !== HIDDEN) && vh.projects.some((x) => x.p === VISIBLE));
    for (const d of Object.values(vh.days)) assert.ok(!d.p[HIDDEN]);
    const [tf, th] = [await free('/console/api/topology'), await hid('/console/api/topology')];
    assert.equal(tf.hub.memories, 9);
    assert.equal(th.hub.memories, 4);
    assert.equal(tf.storage.repo.entries, 9);
    assert.equal(th.storage.repo.entries, 4);
    assert.deepEqual(th.projects.map((p) => p.name), [VISIBLE]);
    assert.ok(tf.projects.some((p) => p.name === HIDDEN));
    assert.equal(th.storage.archive.sessions, 2);
    assert.equal(tf.storage.archive.sessions, 5);
    const [af, ah] = [await free('/browse/viz-agents'), await hid('/browse/viz-agents')];
    assert.equal(af.memory.total, 9);
    assert.equal(ah.memory.total, 4);
    assert.ok(ah.memory.byProject.every(([p]) => p.toLowerCase() !== HIDDEN));
    const [pf, ph] = [await free('/browse/projects'), await hid('/browse/projects')];
    assert.deepEqual(ph, [{ p: VISIBLE, n: 4 }]);
    assert.equal(pf.find((x) => x.p === VISIBLE).n, 5);
    assert.equal((await free('/browse/wrapped-data')).kpi.sessions, 5);
    assert.equal((await hid('/browse/wrapped-data')).kpi.sessions, 2);
    assert.equal((await free('/browse/viz-search?q=MSG')).sessions, 5);
    assert.equal((await hid('/browse/viz-search?q=MSG')).sessions, 2);
    assert.equal((await free('/browse/viz-search?q=journal')).sessions, 5, '日志里 4 个会话，加上 SC 的原话里也有 journal 这个词');
    assert.equal((await hid('/browse/viz-search?q=journal')).sessions, 2);
    const [gf, gh] = [await free('/browse/viz-galaxy'), await hid('/browse/viz-galaxy')];
    assert.equal(gf.rows.length, 5);
    assert.deepEqual(gh.rows.map((r) => r[0]).sort(), [S.refs.SV, S.refs.SN].sort());
  });

  it('对话：归属按工作日志（有一天落在隐藏项目就整个会话隐藏）、工作目录路径；归不到项目的照常', async () => {
    const search = await as(SCOPED, '/console/api/conv/search?q=MSG&limit=30');
    assert.deepEqual(search.json.hits.map((h) => h.ref).sort(), [S.refs.SV, S.refs.SN].sort());
    assert.equal(search.json.total, 2);
    for (const name of ['SH', 'SC', 'SM']) {
      const r = await as(SCOPED, `/console/api/conv/${S.refs[name]}`);
      assert.equal(r.status, 404, `${name} 应该 404`);
      assert.deepEqual(r.json, { error: '没有这个会话' });
      assert.equal((await as(FREE, `/console/api/conv/${S.refs[name]}`)).status, 200, `${name} 没设的设备能读`);
    }
    for (const name of ['SV', 'SN']) {
      const r = await as(SCOPED, `/console/api/conv/${S.refs[name]}`);
      assert.equal(r.status, 200);
      assert.ok(r.text.includes(name === 'SV' ? 'MSG-VISIBLE-TWO' : 'MSG-NOPROJ-THREE'));
    }
    // 另一天的段在隐藏项目里：连带 vis-proj 那一天的日志也不给
    const old = await as(SCOPED, `/browse/viz-day?date=${S.days.SM_old}`);
    assert.ok(!old.text.includes('journal-multi-old-J4'));
  });

  it('时间线事件：对话按会话归属过滤，project=被隐藏项目返回空；调用记录里的查询词不带出来', async () => {
    const ev = (await as(SCOPED, '/console/api/topology/events?limit=100')).json.events;
    assert.ok(ev.some((e) => e.kind === 'talk' && e.project === VISIBLE));
    assert.ok(!ev.some((e) => e.id.includes(S.refs.SH) || e.id.includes(S.refs.SC) || e.id.includes(S.refs.SM)));
    assert.deepEqual((await as(SCOPED, `/console/api/topology/events?project=${HIDDEN}`)).json.events, []);
    assert.equal((await as(SCOPED, '/console/api/topology/events?project=QX-hidden-91')).status, 400, '大写不是合法的项目名，和以前一样 400');
    const free = (await as(FREE, '/console/api/topology/events?limit=100')).json.events;
    assert.ok(free.some((e) => e.text.includes('SEARCHQ-77')), '对照：没设的设备看得到查询词');
    assert.ok(!ev.some((e) => e.text.includes('SEARCHQ-77')));
    assert.ok(ev.some((e) => e.kind === 'read' && e.text === '查了记忆'), '只给动作');
  });

  it('jobs：最近提交说明不带记忆标题', async () => {
    const hid = (await as(SCOPED, '/console/api/jobs')).json;
    const free = (await as(FREE, '/console/api/jobs')).json;
    assert.match(free.repo.last_commit.subject, /^remember\(fact\): hidden-last-commit-L1$/);
    assert.equal(hid.repo.last_commit.subject, 'remember(fact)');
    assert.equal(hid.archive.sessions, 2);
  });

  it('待办：被隐藏的看不到；标记看不到的待办要拒，而且没有真的标上', async () => {
    const hid = (await as(SCOPED, '/browse/todos')).json;
    assert.deepEqual(hid.items.map((t) => t.ref).sort(), [S.refs.SV, S.refs.SN].sort());
    const free = (await as(FREE, '/browse/todos')).json;
    assert.equal(free.items.length, 4);
    for (const name of ['SH', 'SC', 'SM']) {
      const r = await as(SCOPED, '/browse/todo', 'POST', { ref: S.refs[name], action: 'done' });
      assert.equal(r.status, 400, name);
      assert.deepEqual(r.json, { error: '没有这个会话' });
    }
    assert.equal((await as(FREE, '/browse/todos')).json.items.length, 4, '没被标上');
    const ok = await as(SCOPED, '/browse/todo', 'POST', { ref: S.refs.SN, action: 'ignore' });
    assert.equal(ok.status, 200);
    assert.equal((await as(FREE, '/browse/todos')).json.items.length, 3, '看得到的照常能标');
    assert.equal((await as(FREE, '/browse/todo', 'POST', { ref: S.refs.SN, action: 'reopen' })).status, 200);
  });

  it('条目：/browse/entry/<被隐藏的 id> 404；看不到的条目改不了、作废不了、审批不了', async () => {
    for (const k of ['H1', 'H2', 'H3', 'P1', 'L1']) {
      assert.equal((await as(SCOPED, `/browse/entry/${S.ids[k]}`)).status, 404, k);
      assert.equal((await as(FREE, `/browse/entry/${S.ids[k]}`)).status, 200, `${k} 没设的设备能读`);
    }
    for (const k of ['V1', 'N1']) assert.equal((await as(SCOPED, `/browse/entry/${S.ids[k]}`)).status, 200, k);
    const retire = await as(SCOPED, '/browse/manage-action', 'POST', { action: 'retire', ids: [S.ids.H1, S.ids.H2], reason: 'x' });
    assert.equal(retire.status, 400);
    assert.deepEqual(retire.json, { error: '没有要处理的条目' });
    const edit = await as(SCOPED, '/browse/manage-action', 'POST', { action: 'edit', id: S.ids.H3, title: 'pwned' });
    assert.equal(edit.status, 400);
    const merge = await as(SCOPED, '/browse/manage-action', 'POST', { action: 'merge', ids: [S.ids.V1, S.ids.H1] });
    assert.equal(merge.status, 400, '合并只处理看得到的：只剩一条就没有要处理的');
    assert.deepEqual(merge.json, { error: '没有要处理的条目' });
    const h1 = await as(FREE, `/browse/entry/${S.ids.H1}`);
    assert.match(h1.text, /状态: 有效/);
    assert.ok(h1.text.includes('hidden-title-H1'), '没被改');
    assert.ok(!(await as(FREE, `/browse/entry/${S.ids.H3}`)).text.includes('pwned'));
    // 看得到的照常能改
    const ok = await as(SCOPED, '/browse/manage-action', 'POST', { action: 'edit', id: S.ids.V1, title: 'visible-title-V1' });
    assert.equal(ok.status, 200, ok.text);
  });

  it('项目参数：被隐藏项目的交接包拒绝且不回显名字；实体查询不回显', async () => {
    const h = await as(SCOPED, `/browse/handoff?project=${HIDDEN}`);
    assert.equal(h.status, 400);
    assert.deepEqual(h.json, { error: '没有这个项目' });
    const h2 = await as(SCOPED, '/browse/handoff?project=QX-Hidden-91&days=30');
    assert.equal(h2.status, 400, '大小写不敏感');
    const e = await as(SCOPED, '/browse/entity?name=Qx-Hidden-91');
    assert.equal(e.text, '知识图谱里没有这个实体。');
    const g = (await as(SCOPED, '/browse/graph')).json;
    assert.ok(g.nodes.some((n) => n.name === VISIBLE));
    assert.ok(!g.nodes.some((n) => n.name.toLowerCase().includes(HIDDEN)));
    assert.ok(!(await as(FREE, '/browse/graph')).json.nodes.every((n) => !n.name.toLowerCase().includes(HIDDEN)), '对照');
  });

  it('设备策略：受限的浏览者不能改 hide_projects；别的设备的隐藏列表只给他也看得到的项目名', async () => {
    const hid = (await as(SCOPED, '/console/api/devices')).json.devices;
    const by = Object.fromEntries(hid.map((d) => [d.name, d.policy.hide_projects]));
    assert.deepEqual(by['build-server'], [], '自己的隐藏列表也不显示');
    assert.deepEqual(by['ci-box'], ['zz-vis-only'], '只剩他也看得到的');
    assert.deepEqual(Object.fromEntries((await as(FREE, '/console/api/devices')).json.devices.map((d) => [d.name, d.policy.hide_projects])), { 'build-server': ['QX-hidden-91'], 'ci-box': ['zz-vis-only', 'QX-HIDDEN-91'], 'my-laptop': [], nightly: [] });
    const clear = await as(SCOPED, '/console/api/devices/build-server', 'POST', { hide_projects: [] });
    assert.equal(clear.status, 403);
    assert.match(clear.json.error, /不能修改隐藏项目/);
    assert.equal((await as(SCOPED, '/console/api/devices/ci-box', 'POST', { hide_projects: ['x-1'] })).status, 403);
    assert.deepEqual(hub.read('tokens.json').devices['build-server'].hide_projects, ['QX-hidden-91'], '没被清掉');
    const stale = await as(SCOPED, '/console/api/devices/ci-box', 'POST', { stale_hours: 9 });
    assert.equal(stale.status, 200);
    assert.deepEqual(stale.json.policy.hide_projects, ['zz-vis-only'], '响应里也不带被隐藏的名字');
    assert.deepEqual(hub.read('tokens.json').devices['ci-box'].hide_projects, ['zz-vis-only', 'QX-HIDDEN-91'], '没改的字段保持原样');
    const audit = (await as(SCOPED, '/browse/audit?days=7')).json;
    assert.deepEqual(audit.policies['ci-box'].hide, ['zz-vis-only']);
    assert.deepEqual(audit.policies['build-server'].hide, []);
    assert.ok(audit.events.every((u) => !('d' in u)), '调用记录不带细节');
    assert.ok(audit.rejections.every((r) => !String(r.where).includes(':')));
  });

  it('设备放开隐藏后马上恢复可见（缓存不留旧范围）', async () => {
    assert.equal((await as(FREE, '/console/api/devices/build-server', 'POST', { hide_projects: [] })).status, 200);
    const data = (await as(SCOPED, '/browse/data')).text;
    assert.ok(data.includes('hidden-title-H1'));
    assert.equal((await as(SCOPED, '/browse/viz-data')).json.kpi.sessions, 5);
    assert.equal((await as(SCOPED, `/console/api/conv/${S.refs.SH}`)).status, 200);
    assert.equal((await as(FREE, '/console/api/devices/build-server', 'POST', { hide_projects: ['qx-hidden-91'] })).status, 200);
    assert.equal((await as(SCOPED, '/browse/viz-data')).json.kpi.sessions, 2);
    assert.equal((await as(SCOPED, `/console/api/conv/${S.refs.SH}`)).status, 404);
  });
});

describe('访问控制：按意思搜（向量）也按浏览者过滤', () => {
  let hub; let embed; let S;
  before(async () => {
    embed = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => { const { texts } = JSON.parse(b); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: 'fake', vectors: texts.map(() => [1, 0, 0]) })); });
    });
    await new Promise((r) => embed.listen(0, '127.0.0.1', r));
    hub = await startHub({ tokens: TOKENS, peers: PEERS, config: { embed_url: `http://127.0.0.1:${embed.address().port}` } });
    S = await seed(hub);
    // 直接写向量文件（所有条目和日志段向量相同），重启让中心读进去；向量重建任务 30 秒后才跑，测试在那之前结束
    const v = Buffer.from(new Float32Array([1, 0, 0]).buffer).toString('base64');
    const items = {};
    for (const id of Object.values(S.ids)) items[`m:${id}`] = { h: 'x', v };
    const day = (name) => S.days[name];
    items[`j:${day('SH')}|${S.keys.SH}`] = { h: 'x', v };
    items[`j:${day('SV')}|${S.keys.SV}`] = { h: 'x', v };
    items[`j:${day('SN')}|${S.keys.SN}`] = { h: 'x', v };
    items[`j:${S.days.SM_old}|${S.keys.SM}`] = { h: 'x', v };
    items[`j:${S.days.SM_new}|${S.keys.SM}`] = { h: 'x', v };
    fs.writeFileSync(hub.path('state/vectors.json'), JSON.stringify({ model: 'fake', items }));
    await hub.restart();
    assert.equal((await hub.web('POST', '/console/api/devices/build-server', { hide_projects: ['Qx-Hidden-91'] }, AS('my-laptop'))).status, 200);
  });
  after(async () => { await hub.stop(); await new Promise((r) => embed.close(r)); });

  it('没设的设备搜得到全部，设了的搜不到被隐藏项目的记忆和日志，而且条数仍然补满', async () => {
    const free = await hub.web('GET', '/browse/semantic?q=whatever', undefined, AS('my-laptop'));
    assert.equal(free.json.results.length, 14, '9 条记忆 + 5 段日志，上限 20');
    assert.ok(leaks(free.text, S.forbidden).length);
    const hid = await hub.web('GET', '/browse/semantic?q=whatever', undefined, AS('build-server'));
    assert.deepEqual(leaks(hid.text, S.forbidden), []);
    assert.equal(hid.json.results.length, 4 + 2, '4 条普通记忆 + SV、SN 两段日志');
  });

  it('MCP 工具的行为不变：设了的设备 memory_get 被隐藏条目照旧回"没有"', async () => {
    const r = await hub.rpc('build-server', 'tools/call', { name: 'memory_get', arguments: { id: S.ids.H1 } });
    assert.equal(r.isError, true);
    assert.ok(!JSON.stringify(r).includes('hidden-title-H1'));
  });
});
