// B 组：拓扑心跳条加读取、时间回放的历史接口 GET /console/api/topology/history。运行：node --test test/b-topology-history.test.mjs
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startHub, GATE, GATE_HEADERS, TOKENS } from './helpers.mjs';

const MIN = 60e3;
const HOUR = 3600e3;
const ROLES = { ...TOKENS, 'old-box': { token: 'tok-old-secret-value' }, nightly: { token: 'tok-ext-secret-value', role: 'extractor' }, daily: { token: 'tok-rep-secret-value', role: 'reporter' } };
const AS_BUILD = { 'x-am-gate': GATE, 'x-am-peer': 'build-server' };
const call = (hub, dev, name, args, client = 'codex') => fetch(`${hub.base}/mcp?client=${client}`, { method: 'POST', headers: { authorization: `Bearer ${hub.tokenOf[dev]}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
const msgs = (n, startMs) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `m${i}`, ts: new Date(startMs + i * 1000).toISOString() }));
const backdate = (hub, ms) => {
  const t = hub.read('tokens.json');
  for (const d of Object.values(t.devices)) d.created = new Date(ms).toISOString();
  fs.writeFileSync(hub.path('tokens.json'), JSON.stringify(t));
};
const sum = (a) => a.reduce((x, y) => x + y, 0);

describe('心跳条：下行（读取）24 格', () => {
  it('hours_down 和上行同一时间格；只读不写的设备也有内容；没有活动的全 0', async () => {
    const hub = await startHub({ tokens: ROLES, peers: ['my-laptop'], config: { embed_url: '' } });
    try {
      await call(hub, 'build-server', 'memory_search', { query: 'a' });
      await call(hub, 'build-server', 'memory_search', { query: 'b' });
      await call(hub, 'build-server', 'memory_recent', {});
      const t = (await hub.get('topology')).json;
      const d = t.devices.find((x) => x.name === 'build-server');
      assert.equal(d.flow.up_24h, 0);
      assert.deepEqual(d.flow.hours, Array(24).fill(0), '只读不写：上行格全 0');
      assert.equal(d.flow.hours_down.length, 24);
      assert.equal(sum(d.flow.hours_down), 3);
      assert.equal(sum(d.flow.hours_down), d.flow.down_24h, '和 down_24h 同口径');
      assert.equal(d.flow.hours_down[23], 3, '刚刚的调用落在最后一格');
      assert.deepEqual(t.devices.find((x) => x.name === 'my-laptop').flow.hours_down, Array(24).fill(0));
    } finally { await hub.stop(); }
  });

  it('读取按小时分格：几小时前的调用落在对应格，写入类调用不进下行', async () => {
    const hub = await startHub({ tokens: ROLES, peers: ['my-laptop'], config: { embed_url: '' } });
    try {
      const now = Date.now();
      const row = (agoMs, op) => JSON.stringify({ t: new Date(now - agoMs).toISOString(), device: 'build-server', client: 'codex', op, d: 'x' });
      fs.writeFileSync(hub.path('state/usage.jsonl'), `${[row(40 * HOUR, 'tool:memory_search'), row(5 * HOUR + 20 * MIN, 'tool:memory_get'), row(5 * HOUR + 10 * MIN, 'tool:memory_search'), row(2 * HOUR + 30 * MIN, 'tool:memory_remember')].join('\n')}\n`);
      const d = (await hub.get('topology')).json.devices.find((x) => x.name === 'build-server');
      assert.equal(d.flow.down_24h, 2, '40 小时前的不算');
      assert.equal(sum(d.flow.hours_down), 2);
      assert.equal(d.flow.hours_down[18] + d.flow.hours_down[19], 2);
      assert.equal(d.flow.up_24h, 1);
      assert.equal(d.flow.hours[20] + d.flow.hours[21], 1);
      assert.equal(d.flow.hours_down[20] + d.flow.hours_down[21], 0, 'remember 是写入，不进读取格');
    } finally { await hub.stop(); }
  });
});

describe('拓扑历史接口：参数、权限、结构', () => {
  let hub;
  before(async () => { hub = await startHub({ tokens: ROLES, peers: ['my-laptop', 'build-server'], config: { embed_url: '' } }); });
  after(() => hub.stop());

  it('没有网关身份 403，只支持 GET，不泄露令牌和密钥', async () => {
    assert.equal((await hub.get('topology/history', { ...GATE_HEADERS, 'x-am-gate': 'wrong' })).status, 403);
    assert.equal((await hub.get('topology/history', { ...GATE_HEADERS, 'x-am-peer': 'stranger' })).status, 403);
    assert.equal((await hub.post('topology/history', {})).status, 405);
    const r = await hub.get('topology/history');
    assert.equal(r.status, 200);
    for (const bad of [GATE, 'gate_secret', 'tok-', 'sha256', hub.dir]) assert.ok(!r.text.includes(bad), `不应出现 ${bad}`);
  });

  it('参数校验：中文 error；默认 24 小时 15 分钟一格', async () => {
    for (const q of ['hours=0', 'hours=49', 'hours=x', 'hours=1.5', 'bucket=0', 'bucket=61', 'bucket=x', 'hours=48&bucket=1']) {
      const r = await hub.get(`topology/history?${q}`);
      assert.equal(r.status, 400, q);
      assert.match(r.json.error, /[一-龥]/, q);
    }
    const r = (await hub.get('topology/history')).json;
    assert.equal(r.hours, 24);
    assert.equal(r.bucket, 15);
    assert.equal(r.count, 96);
    assert.equal((await hub.get('topology/history?hours=48&bucket=15')).json.count, 192);
    const odd = (await hub.get('topology/history?hours=1&bucket=7')).json;
    assert.equal(odd.count, 9, '不能整除就多一格，时间从末尾往前排');
    assert.equal(Date.parse(odd.to) - Date.parse(odd.from), 9 * 7 * MIN);
  });

  it('结构：时间格对齐，每台设备的数组长度 = count，设备项带分组', async () => {
    assert.equal((await hub.post('devices/build-server', { group: '机房' })).status, 200);
    const r = (await hub.get('topology/history?hours=24&bucket=15')).json;
    for (const k of ['now', 'from', 'to', 'bucket', 'hours', 'count', 'devices', 'events']) assert.ok(k in r, k);
    assert.equal(Date.parse(r.to) - Date.parse(r.from), r.count * r.bucket * MIN);
    assert.ok(Math.abs(Date.parse(r.now) - Date.parse(r.to)) < 2000);
    assert.deepEqual(r.devices.map((d) => d.name).sort(), ['build-server', 'my-laptop', 'old-box'], '只列设备角色，抽取机和报表令牌不在');
    for (const d of r.devices) {
      assert.deepEqual(Object.keys(d).sort(), ['down', 'group', 'idle', 'name', 'state', 'up']);
      for (const k of ['up', 'down', 'state', 'idle']) assert.equal(d[k].length, r.count, `${d.name}.${k}`);
    }
    assert.equal(r.devices.find((d) => d.name === 'build-server').group, '机房');
    assert.equal(r.devices.find((d) => d.name === 'my-laptop').group, '');
    assert.equal(r.events.length, r.count);
  });

  it('设备刚加入：加入之前的格子是 none，加入之后才有状态', async () => {
    const h = (await hub.get('topology/history')).json;
    const b = h.devices.find((d) => d.name === 'build-server');
    assert.equal(b.state[0], 'none');
    assert.notEqual(b.state[h.count - 1], 'none');
    assert.equal(b.state.filter((s) => s !== 'none').length, 1, '设备是刚建的，只有最后一格在加入之后');
  });
});

describe('拓扑历史接口：空数据和边角', () => {
  it('没挂对话存档盘、没有任何设备活动也不崩：只有调用记录，其余全 0', async () => {
    const hub = await startHub({ archive: false, tokens: ROLES, peers: ['my-laptop'], config: { embed_url: '' } });
    try {
      let r = await hub.get('topology/history');
      assert.equal(r.status, 200);
      assert.ok(r.json.events.every((e) => e === null), '一件事都没发生');
      assert.ok(r.json.devices.every((d) => sum(d.up) === 0 && sum(d.down) === 0));
      await call(hub, 'build-server', 'memory_search', { query: 'x' });
      r = await hub.get('topology/history');
      assert.equal(sum(r.json.devices.find((d) => d.name === 'build-server').down), 1);
    } finally { await hub.stop(); }
  });

  it('没有任何设备（只有抽取机令牌）：devices 是空数组，也不崩', async () => {
    const hub = await startHub({ tokens: { nightly: { token: 'tok-ext-secret-value', role: 'extractor' } }, config: { gate_secret: '', console_viewer: 'nightly' } });
    try {
      const r = await hub.get('topology/history', {});
      assert.equal(r.status, 200);
      assert.deepEqual(r.json.devices, []);
      assert.equal(r.json.events.length, r.json.count);
    } finally { await hub.stop(); }
  });
});

describe('拓扑历史接口：流量、状态、事件', () => {
  let hub; let now0;
  const at = (agoMs) => new Date(now0 - agoMs).toISOString();
  const TODOS = 7;
  before(async () => {
    now0 = Date.now();
    hub = await startHub({ tokens: ROLES, peers: ['my-laptop', 'build-server'], config: { embed_url: '' } });
    backdate(hub, now0 - 3 * 24 * HOUR);
    // 先写好旧的调用记录（usage.jsonl 要按时间升序）：build-server 30 小时前、10 小时前各读了一次
    const row = (agoMs, op, d) => JSON.stringify({ t: at(agoMs), device: 'build-server', client: 'codex', op, ...(d ? { d } : {}) });
    fs.writeFileSync(hub.path('state/usage.jsonl'), `${[row(30 * HOUR, 'tool:memory_search', 'too old'), row(10 * HOUR, 'tool:memory_search', 'ten hours ago')].join('\n')}\n`);
    assert.equal((await hub.post('devices/old-box', { paused: true })).status, 200);
    await hub.device('build-server', '/v1/conv/append', { tool: 'codex', session_id: 'h1', base: 0, messages: msgs(2, now0 - 5 * HOUR) });
    await hub.device('build-server', '/v1/conv/append', { tool: 'codex', session_id: 'h2', base: 0, messages: msgs(4, now0 - 30 * MIN) });
    await call(hub, 'build-server', 'memory_remember', { type: 'fact', title: 'history fact', body: 'b' });
    for (let i = 0; i < TODOS; i++) await call(hub, 'build-server', 'memory_todos', {});
    await call(hub, 'build-server', 'memory_search', { query: 'history' });
    await call(hub, 'build-server', 'memory_search', { query: 'password=Abc12345secret' });
    await call(hub, 'build-server', 'memory_recent', {});
  });
  after(() => hub.stop());

  const idxOf = (h, ms) => Math.floor((ms - Date.parse(h.from)) / (h.bucket * MIN));
  const get = async (q = 'hours=24&bucket=15', headers) => { const r = await hub.get(`topology/history?${q}`, headers); assert.equal(r.status, 200, r.text); return r.json; };
  const dev = (h, name) => h.devices.find((d) => d.name === name);

  it('写入 = 新消息 + 写入类调用，读取 = 其余调用；总量和 /topology 的 24 小时一致', async () => {
    const h = await get();
    const live = (await hub.get('topology')).json.devices.find((x) => x.name === 'build-server');
    const b = dev(h, 'build-server');
    assert.equal(sum(b.up), 6 + 1, '2 + 4 条消息，加一次 remember');
    assert.equal(sum(b.down), 1 + TODOS + 3, '10 小时前一次，todos 若干，search 两次、recent 一次；30 小时前那次不在 24 小时里');
    assert.equal(sum(b.up), live.flow.up_24h);
    assert.equal(sum(b.down), live.flow.down_24h);
    assert.equal(sum(dev(h, 'my-laptop').up) + sum(dev(h, 'my-laptop').down), 0);
    const w = await get('hours=48&bucket=15');
    assert.equal(sum(dev(w, 'build-server').down), 1 + 1 + TODOS + 3, '48 小时里多出 30 小时前那次');
  });

  it('各项落在对应的时间格：5 小时前的消息、10 小时前的读取、半小时前的消息、刚才的调用', async () => {
    const h = await get();
    const b = dev(h, 'build-server');
    const ia = idxOf(h, now0 - 5 * HOUR); const ib = idxOf(h, now0 - 5 * HOUR + 1000);
    assert.equal(ia === ib ? b.up[ia] : b.up[ia] + b.up[ib], 2, '5 小时前的两条消息');
    assert.equal(b.down[idxOf(h, now0 - 10 * HOUR)], 1);
    assert.equal(sum(b.up.slice(idxOf(h, now0 - 30 * MIN))), 4 + 1, '半小时前的 4 条消息和刚才的 remember');
    assert.equal(sum(b.down.slice(idxOf(h, now0 - 1000))), TODOS + 3, '刚才的读取');
  });

  it('状态按"当时距上次活动多久"推：刚活动 ok/live、15 分钟后 idle、超过阈值（默认 3 小时）stale；暂停的一直 paused；没活动过的 stale', async () => {
    const h = await get('hours=48&bucket=15');
    const b = dev(h, 'build-server');
    let sawOk = false; let sawIdle = false; let sawStale = false; let sawLive = false;
    for (let i = 0; i < h.count; i++) {
      const s = b.state[i]; const idle = b.idle[i];
      if (idle !== null) assert.ok(Number.isInteger(idle) && idle >= 0, `${i}: idle ${idle}`);
      if (s === 'stale') { sawStale = true; assert.ok(idle === null || idle > 180, `${i} stale idle=${idle}`); } else assert.ok(idle !== null && idle <= 180, `${i} ${s} idle=${idle}`);
      if (s === 'ok') { sawOk = true; assert.ok(idle < 15, `${i} ok idle=${idle}`); }
      if (s === 'idle') { sawIdle = true; assert.ok(idle >= 15 && idle <= 180, `${i} idle=${idle}`); }
      if (s === 'live') sawLive = true;
      assert.ok(['live', 'ok', 'idle', 'stale'].includes(s), `${i}: ${s}`);
    }
    assert.ok(sawOk && sawIdle && sawStale && sawLive, '四种状态都出现过');
    // 10 小时前读了一次 → 它所在格末尾的 idle 和实际相符；之后安静了 5 小时，超过 3 小时的阈值
    const k = idxOf(h, now0 - 10 * HOUR);
    assert.ok(Math.abs(Date.parse(h.from) + (k + 1) * 15 * MIN - (now0 - 10 * HOUR) - b.idle[k] * MIN) <= MIN, '10 小时前那格的 idle 和实际相符');
    assert.equal(b.state[k], 'ok');
    assert.equal(b.state[idxOf(h, now0 - 6 * HOUR)], 'stale');
    // 5 小时前有两条新消息，当格是 live；半小时前也是；最后一格刚调过工具、最近一条消息是半小时前，所以是 ok
    assert.equal(b.state[idxOf(h, now0 - 5 * HOUR + 1000)], 'live');
    assert.equal(b.state[idxOf(h, now0 - 30 * MIN)], 'live');
    assert.equal(b.state[h.count - 1], 'ok');
    // 暂停和从没活动过
    assert.ok(dev(h, 'old-box').state.every((s) => s === 'paused'));
    assert.ok(dev(h, 'my-laptop').state.every((s) => s === 'stale'));
    assert.ok(dev(h, 'my-laptop').idle.every((x) => x === null));
  });

  it('事件：条数和种类按格汇总，每格最多 6 条（旧→新）；文字和实时事件流同口径，密钥打码', async () => {
    const h = await get();
    const cells = h.events.map((e, i) => ({ e, i })).filter((x) => x.e);
    const all = cells.flatMap((x) => x.e.items);
    assert.equal(sum(cells.map((x) => x.e.n)), 1 + 1 + 2 + TODOS + 3 + 1, '10 小时前的读取、remember、2 个会话、todos、search×2+recent、一次设备策略修改');
    const kinds = {};
    for (const x of cells) for (const [k, n] of Object.entries(x.e.kinds)) kinds[k] = (kinds[k] || 0) + n;
    assert.deepEqual(kinds, { read: 1 + TODOS + 3, write: 1, talk: 2, console: 1 });
    for (const x of cells) {
      assert.equal(sum(Object.values(x.e.kinds)), x.e.n);
      assert.ok(x.e.items.length >= 1 && x.e.items.length <= 6 && x.e.items.length <= x.e.n);
      for (const it of x.e.items) {
        assert.deepEqual(Object.keys(it).filter((k) => k !== 'project').sort(), ['device', 'id', 'kind', 't', 'text', 'tool']);
        assert.equal(idxOf(h, Date.parse(it.t)), x.i, '事件在它自己的时间格里');
      }
      for (let j = 1; j < x.e.items.length; j++) assert.ok(Date.parse(x.e.items[j].t) >= Date.parse(x.e.items[j - 1].t), '旧→新');
    }
    assert.equal(new Set(all.map((e) => e.id)).size, all.length, 'id 唯一');
    const last = h.events[h.count - 1];
    assert.equal(last.items.length, 6);
    assert.ok(last.n > 6);
    assert.deepEqual(last.items.slice(-3).map((e) => e.text.replace(/「.*」/, '「」')), ['查了记忆「」', '查了记忆「」', '看了最近的记忆']);
    assert.ok(!JSON.stringify(h).includes('Abc12345secret'), '查询里的密钥要打码');
    const ten = h.events[idxOf(h, now0 - 10 * HOUR)].items.find((e) => e.kind === 'read');
    assert.equal(ten.text, '查了记忆「ten hours ago」');
    assert.equal(ten.device, 'build-server');
    assert.equal(ten.tool, 'codex');
    const five = h.events[idxOf(h, now0 - 5 * HOUR + 1000)].items.find((e) => e.kind === 'talk');
    assert.equal(five.text, '有新对话');
    // id 和实时事件流用同一套：对话事件的 id 在历史里也能找到
    const live = (await hub.get('topology/events?limit=100')).json.events;
    for (const e of live.filter((x) => x.kind === 'talk')) assert.ok(all.some((x) => x.id === e.id), `实时事件 ${e.id} 应出现在历史里`);
    for (const bad of ['tok-', 'sha256', GATE, hub.dir]) assert.ok(!JSON.stringify(h).includes(bad), bad);
  });

  it('自己设了同步超时的设备按自己的阈值判', async () => {
    assert.equal((await hub.post('devices/build-server', { stale_hours: 8 })).status, 200);
    try {
      const h = await get('hours=48&bucket=15');
      assert.equal(dev(h, 'build-server').state[idxOf(h, now0 - 6 * HOUR)], 'idle', '4 小时的安静在 8 小时阈值内');
    } finally { assert.equal((await hub.post('devices/build-server', { stale_hours: null })).status, 200); }
  });
});

describe('拓扑历史接口：带项目的事件按浏览者过滤', () => {
  it('隐藏了某项目的设备看不到这个项目的对话事件，其他设备照常看到', async () => {
    const hub = await startHub({ tokens: ROLES, peers: ['my-laptop', 'build-server'], config: { embed_url: '' } });
    try {
      const now = Date.now();
      const post = (dev, tool, sid, agoMin) => hub.device(dev, '/v1/conv/append', { tool, session_id: sid, title: sid, base: 0, messages: [{ role: 'user', text: `work on ${sid}`, ts: new Date(now - agoMin * MIN).toISOString() }, { role: 'assistant', text: 'done', ts: new Date(now - agoMin * MIN + 1000).toISOString() }] });
      await post('build-server', 'codex', 'p1', 100);
      await post('my-laptop', 'claude-code', 'p2', 110);
      await post('my-laptop', 'codex', 'p3', 120);
      const pend = (await hub.device('nightly', '/v1/journal/pending?today=1')).json.items;
      const proj = { p1: 'alpha', p2: 'beta' };
      const items = pend.filter((x) => proj[x.title]).map((x) => ({ key: x.key, date: x.date, summary: `did ${x.title}`, project: proj[x.title], n: x.n }));
      assert.equal((await hub.device('nightly', '/v1/journal/result', { items })).status, 200);
      const talk = async (headers) => (await hub.get('topology/history', headers)).json.events.filter(Boolean).flatMap((e) => e.items).filter((e) => e.kind === 'talk');
      let all = await talk();
      assert.deepEqual(all.map((e) => e.project || '-').sort(), ['-', 'alpha', 'beta']);
      assert.equal((await hub.post('devices/my-laptop', { hide_projects: ['alpha'] })).status, 200);
      all = await talk();
      assert.deepEqual(all.map((e) => e.project || '-').sort(), ['-', 'beta'], 'my-laptop 看不到 alpha');
      const h = (await hub.get('topology/history')).json;
      assert.equal(sum(h.events.filter(Boolean).map((e) => e.kinds.talk || 0)), 2, '条数也不含被隐藏的');
      assert.ok(!JSON.stringify(h).includes('alpha'), '项目名也不出现');
      assert.deepEqual((await talk(AS_BUILD)).map((e) => e.project || '-').sort(), ['-', 'alpha', 'beta'], 'build-server 没隐藏，照常看到');
    } finally { await hub.stop(); }
  });
});
