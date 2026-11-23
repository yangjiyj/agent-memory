// E 组：全局搜索 GET /console/api/search 和问答 /console/api/ask*、设置里的 ask_* 三项。
// 问答的模型用测试里起的本地假服务（模拟 /v1/chat/completions）。运行：node --test test/e-search-api.test.mjs

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { startHub, GATE_HEADERS, TOKENS } from './helpers.mjs';
import { askTerms } from '../hub/admin-search.mjs';

const KEY = 'ask-key-S3cretValue-0123456789';
const HIDER = { ...GATE_HEADERS, 'x-am-peer': 'build-server' }; // 这台设备看不到 secret-proj
const EXTRACTOR = { 'journal-bot': { token: 'tok-journal-secret-value', role: 'extractor' } };
const bjDay = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);

// 本地假的 OpenAI 兼容服务：记下每个请求，handler 决定怎么回
async function fakeModel(handler) {
  const reqs = [];
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const rec = { method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null };
    reqs.push(rec);
    await (handler || ok)(rec, res);
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    reqs, url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(r); }),
  };
}
const reply = (res, status, body, type = 'application/json') => { res.writeHead(status, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
const ok = (_req, res) => reply(res, 200, { choices: [{ message: { role: 'assistant', content: '按资料，支付回调用幂等键去重 [1]；对话里也讨论过 [2]。' } }] });

// 往中心里种：记忆（含一个隐藏项目的）、对话（含项目日志）、设备显示名
async function seed(hub) {
  const remember = async (args) => {
    const r = await hub.rpc('my-laptop', 'tools/call', { name: 'memory_remember', arguments: args });
    const m = /已写入 (\S+)：/.exec(r.content[0].text);
    assert.ok(m, r.content[0].text);
    return m[1];
  };
  const ids = {};
  ids.pay = await remember({ type: 'decision', project: 'shop-api', title: '支付回调改用幂等键去重', body: '订单支付回调会重复到达，用订单号加时间窗做幂等键去重，不要靠数据库唯一索引报错兜底。上线日期 11-20。' });
  ids.disk = await remember({ type: 'pitfall', project: 'infra', title: '部署脚本在磁盘满时静默失败', body: 'build-server 的 /var 分区满了以后部署脚本不报错但没有产物，先查 df 再重试。' });
  ids.secret = await remember({ type: 'fact', project: 'secret-proj', title: '内部项目 zebra-launch 的幂等键约定', body: 'zebra-launch 发布流程里幂等键放在专用头里，不要对外说。' });
  ids.bulk = [];
  for (let i = 1; i <= 8; i++) ids.bulk.push(await remember({ type: 'fact', project: 'shop-api', title: `批量记忆 ${i}：蓝莓果酱`, body: `第 ${i} 条，关于蓝莓果酱的笔记。` }));

  const t0 = Date.now() - 2 * 3600e3;
  const day = bjDay(t0);
  const up = (sid, title, cwd, messages) => hub.device('my-laptop', '/v1/conv/append', {
    tool: 'claude-code', session_id: sid, title, cwd, started: new Date(t0).toISOString(), base: 0,
    messages: messages.map(([role, text], i) => ({ role, text, ts: new Date(t0 + i * 60e3).toISOString() })),
  });
  assert.equal((await up('s-pay', '看支付回调', '/home/demo/shop', [
    ['user', '帮我看看支付回调重复到达时怎么做幂等键'],
    ['assistant', '可以用订单号加时间窗做幂等键，参考 redis SETNX，过期时间设成一小时。'],
  ])).json.ok, true);
  assert.equal((await up('s-secret', '内部发布', '/home/demo/zl', [
    ['user', 'zebra-launch 发布时幂等键放哪个头里'],
    ['assistant', 'zebra-launch 约定放在 X-Launch-Key 头里。'],
  ])).json.ok, true);
  assert.equal((await up('s-free', '随便聊聊', '/home/demo/misc', [
    ['user', '蓝莓果酱怎么做'],
  ])).json.ok, true);
  const items = [
    { key: 'my-laptop__claude-code__s-pay', date: day, summary: '讨论支付回调幂等键', project: 'shop-api', n: 2, status: 'done' },
    { key: 'my-laptop__claude-code__s-secret', date: day, summary: '内部发布', project: 'secret-proj', n: 2, status: 'done' },
  ];
  assert.equal((await hub.device('journal-bot', '/v1/journal/result', { items })).json.written, 2);
  return { ids, day, t0 };
}

const hubOpts = (config = {}) => ({ tokens: { ...TOKENS, ...EXTRACTOR }, peers: ['my-laptop', 'build-server'], config: { device_labels: { 'build-server': '构建机' }, ...config } });

describe('全局搜索：身份与参数', () => {
  let hub;
  before(async () => { hub = await startHub(hubOpts()); });
  after(() => hub.stop());

  it('没有网关身份 403；方法和参数不对 405 / 400；都是中文 error', async () => {
    for (const [m, r] of [['GET', 'search?q=x'], ['GET', 'ask/status'], ['POST', 'ask']]) {
      const res = await hub.api(m, r, m === 'POST' ? { q: 'x' } : undefined, {});
      assert.equal(res.status, 403, `${m} ${r}`);
      assert.match(res.json.error, /[一-龥]/);
    }
    assert.equal((await hub.post('search', {})).status, 405);
    assert.equal((await hub.post('ask/status', {})).status, 405);
    assert.equal((await hub.get('ask')).status, 405);
    for (const q of ['', '   ', 'x'.repeat(201)]) {
      const r = await hub.get(`search?q=${encodeURIComponent(q)}`);
      assert.equal(r.status, 400, JSON.stringify(q));
      assert.match(r.json.error, /[一-龥]/);
    }
    assert.equal((await hub.get('search')).status, 400);
  });

  it('空数据也不崩：各组都在、都是空的', async () => {
    const r = await hub.get('search?q=不存在的词');
    assert.equal(r.status, 200);
    for (const g of ['memories', 'convs', 'projects', 'devices']) {
      assert.deepEqual(r.json[g].items, [], g);
      assert.equal(r.json[g].total, 0, g);
    }
  });

  it('没挂对话存档盘：对话组空，其余照常', async () => {
    const h2 = await startHub({ ...hubOpts(), archive: false });
    try {
      await h2.rpc('my-laptop', 'tools/call', { name: 'memory_remember', arguments: { type: 'fact', title: '无存档测试', body: '无存档测试' } });
      const r = await h2.get('search?q=无存档测试');
      assert.equal(r.status, 200);
      assert.equal(r.json.memories.total, 1);
      assert.equal(r.json.convs.total, 0);
      assert.equal(r.json.convs.unavailable, true);
    } finally { await h2.stop(); }
  });
});

describe('全局搜索：结果', () => {
  let hub; let S;
  before(async () => { hub = await startHub(hubOpts()); S = await seed(hub); });
  after(() => hub.stop());

  it('记忆：id、标题、类型、项目、片段；片段围着命中词；只含有效记忆', async () => {
    const r = await hub.get(`search?q=${encodeURIComponent('幂等键')}`);
    assert.equal(r.status, 200);
    const m = r.json.memories.items.find((x) => x.id === S.ids.pay);
    assert.ok(m, '应命中支付那条');
    assert.equal(m.title, '支付回调改用幂等键去重');
    assert.equal(m.type, 'decision');
    assert.equal(m.project, 'shop-api');
    assert.match(m.snippet, /幂等键/);
    assert.ok(m.snippet.length <= 200);
    assert.match(m.date, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('记忆：标题优先；多词要同时命中；每组最多 6 条，total 是总数', async () => {
    const r = await hub.get(`search?q=${encodeURIComponent('蓝莓果酱')}`);
    assert.equal(r.json.memories.items.length, 6);
    assert.equal(r.json.memories.total, 8);
    const two = await hub.get(`search?q=${encodeURIComponent('部署 磁盘')}`);
    assert.equal(two.json.memories.items[0].id, S.ids.disk);
  });

  it('对话：ref、日期、设备（含显示名）、智能体、项目、命中的消息序号和片段', async () => {
    const r = await hub.get(`search?q=${encodeURIComponent('SETNX')}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.convs.items.length, 1);
    const c = r.json.convs.items[0];
    assert.match(c.ref, /^[0-9a-f]{8}$/);
    assert.equal(c.date, S.day);
    assert.equal(c.device, 'my-laptop');
    assert.equal(c.tool, 'claude-code');
    assert.equal(c.tool_label, 'Claude Code');
    assert.equal(c.project, 'shop-api');
    assert.equal(c.title, '看支付回调');
    assert.equal(c.hit, 2);
    assert.equal(c.role, 'assistant');
    assert.match(c.snippet, /SETNX/);
    // ref 能直接读回原文
    const got = await hub.get(`conv/${c.ref}`);
    assert.equal(got.status, 200);
    assert.equal(got.json.session.title, '看支付回调');
    assert.equal(r.json.convs.partial, false);
  });

  it('对话：多个词要在同一条消息里全部命中；大小写不敏感', async () => {
    assert.equal((await hub.get(`search?q=${encodeURIComponent('redis 蓝莓')}`)).json.convs.total, 0);
    assert.equal((await hub.get(`search?q=${encodeURIComponent('setnx')}`)).json.convs.total, 1);
  });

  it('对话：命中的会话多时每组最多 5 个、按最近的在前，more 为真；每个会话只给一条', async () => {
    for (let i = 1; i <= 8; i++) {
      const ts = (k) => new Date(S.t0 - i * 3600e3 + k * 1000).toISOString();
      const r = await hub.device('my-laptop', '/v1/conv/append', {
        tool: 'codex', session_id: `q-${i}`, title: `袋鼠话题 ${i}`, started: ts(0), base: 0,
        messages: [{ role: 'user', text: `第 ${i} 次聊 quokka-topic`, ts: ts(0) }, { role: 'assistant', text: `quokka-topic 的第 ${i} 个回答`, ts: ts(1) }],
      });
      assert.equal(r.json.ok, true);
    }
    const r = await hub.get('search?q=quokka-topic');
    assert.equal(r.json.convs.items.length, 5);
    assert.equal(r.json.convs.more, true);
    assert.deepEqual(r.json.convs.items.map((c) => c.title), [1, 2, 3, 4, 5].map((i) => `袋鼠话题 ${i}`), '最近的会话在前');
    assert.equal(new Set(r.json.convs.items.map((c) => c.ref)).size, 5);
    assert.ok(r.json.convs.items.every((c) => c.role === 'assistant'), '每个会话给最近的一条命中（助手那条）');
    assert.equal(r.json.convs.items[0].tool_label, 'Codex');
  });

  it('项目：按名字，带数量，隐藏项目之外的都在', async () => {
    const r = await hub.get('search?q=shop');
    assert.deepEqual(r.json.projects.items.map((p) => p.name), ['shop-api']);
    assert.ok(r.json.projects.items[0].count >= 9);
  });

  it('设备：按名字或显示名，带角色和最近同步', async () => {
    const byName = await hub.get('search?q=build');
    assert.deepEqual(byName.json.devices.items.map((d) => [d.name, d.label, d.role]), [['build-server', '构建机', 'device']]);
    const byLabel = await hub.get(`search?q=${encodeURIComponent('构建机')}`);
    assert.equal(byLabel.json.devices.items[0].name, 'build-server');
    assert.ok('last_seen' in byLabel.json.devices.items[0]);
  });

  it('只搜记忆里的有效项：作废的搜不到', async () => {
    const id = S.ids.bulk[0];
    await hub.rpc('my-laptop', 'tools/call', { name: 'memory_retire', arguments: { id, reason: '测试' } });
    const r = await hub.get(`search?q=${encodeURIComponent('蓝莓果酱')}`);
    assert.equal(r.json.memories.total, 7);
    assert.ok(!r.json.memories.items.some((x) => x.id === id));
  });

  it('响应够快，同一查询第二次走缓存也一样', async () => {
    const t0 = Date.now();
    const a = await hub.get(`search?q=${encodeURIComponent('幂等键')}`);
    const b = await hub.get(`search?q=${encodeURIComponent('幂等键')}`);
    assert.ok(Date.now() - t0 < 1500);
    assert.deepEqual(a.json, b.json);
  });
});

describe('全局搜索：按浏览者过滤隐藏项目', () => {
  let hub; let S;
  before(async () => {
    hub = await startHub(hubOpts());
    S = await seed(hub);
    assert.equal((await hub.post('devices/build-server', { hide_projects: ['secret-proj'] })).status, 200);
  });
  after(() => hub.stop());

  it('能看全部的浏览者看得到 secret-proj；被隐藏的浏览者记忆、对话、项目里都没有，片段里也没有', async () => {
    const q = encodeURIComponent('zebra-launch');
    const open = await hub.get(`search?q=${q}`);
    assert.equal(open.json.memories.total, 1);
    assert.equal(open.json.convs.total, 1);
    assert.equal((await hub.get('search?q=secret-proj')).json.projects.total, 1);

    const r = await hub.get(`search?q=${q}`, HIDER);
    assert.equal(r.status, 200);
    assert.equal(r.json.memories.total, 0);
    assert.equal(r.json.convs.total, 0);
    assert.ok(!r.text.includes('zebra-launch') || !/X-Launch-Key|专用头/.test(r.text));
    assert.equal((await hub.get('search?q=secret', HIDER)).json.projects.total, 0);

    const shared = await hub.get(`search?q=${encodeURIComponent('幂等键')}`, HIDER);
    assert.ok(shared.json.memories.items.some((x) => x.id === S.ids.pay), '没隐藏的项目照常能搜到');
    assert.ok(!shared.json.memories.items.some((x) => x.id === S.ids.secret));
    assert.equal(shared.json.convs.items.length, 1, '同一个词下只剩没隐藏项目的对话');
    assert.equal(shared.json.convs.items[0].project, 'shop-api');
  });

  it('没有项目日志的对话按"没有项目"算，所有人可见', async () => {
    const r = await hub.get(`search?q=${encodeURIComponent('蓝莓果酱怎么做')}`, HIDER);
    assert.equal(r.json.convs.total, 1);
    assert.equal(r.json.convs.items[0].project, '');
  });

  it('同一会话里有一天属于隐藏项目、命中那天没有日志时，保守地按隐藏处理', async () => {
    // s-secret 补一条第二天（没有日志）的消息：命中它的搜索对被隐藏的浏览者也不可见
    const t1 = Date.now() - 3 * 86400e3;
    const r0 = await hub.device('my-laptop', '/v1/conv/append', { tool: 'claude-code', session_id: 's-secret', base: 2, messages: [{ role: 'user', text: 'zebra-launch 第二天补充 plover', ts: new Date(t1).toISOString() }] });
    assert.equal(r0.json.ok, true);
    const r = await hub.get(`search?q=plover`, HIDER);
    assert.equal(r.json.convs.total, 0);
    assert.equal((await hub.get('search?q=plover')).json.convs.total, 1);
  });
});

describe('设置：ask_url / ask_model / ask_key', () => {
  let hub;
  before(async () => { hub = await startHub(hubOpts()); });
  after(() => hub.stop());
  const modeOf = (p) => fs.statSync(p).mode & 0o777;

  it('GET 里没有 ask_key，只有 ask_key_set；ask_url / ask_model 默认是 null', async () => {
    const r = await hub.get('settings');
    assert.equal(r.status, 200);
    assert.ok(!('ask_key' in r.json.settings));
    assert.equal(r.json.settings.ask_key_set, false);
    assert.equal(r.json.settings.ask_url, null);
    assert.equal(r.json.settings.ask_model, null);
  });

  it('写入：接口根和完整的 chat/completions 地址都认；密钥只进配置文件，响应里没有', async () => {
    const a = await hub.post('settings', { ask_url: 'https://gw.example/v1/', ask_model: 'my-model', ask_key: KEY });
    assert.equal(a.status, 200);
    assert.equal(a.json.settings.ask_url, 'https://gw.example/v1');
    assert.equal(a.json.settings.ask_model, 'my-model');
    assert.equal(a.json.settings.ask_key_set, true);
    assert.ok(!a.text.includes(KEY));
    assert.equal(hub.read('config.json').ask_key, KEY);
    const b = await hub.post('settings', { ask_url: 'https://gw.example/v1/chat/completions' });
    assert.equal(b.status, 200);
    assert.equal(b.json.settings.ask_url, 'https://gw.example/v1/chat/completions');
    const g = await hub.get('settings');
    assert.ok(!g.text.includes(KEY));
    assert.equal(g.json.settings.ask_key_set, true);
    // 只改别的字段，密钥不丢
    await hub.post('settings', { ask_model: 'other' });
    assert.equal(hub.read('config.json').ask_key, KEY);
  });

  it('.bak 的权限和配置文件一致（含 .bak 已存在且权限宽松的情况）', async () => {
    const cfg = hub.path('config.json');
    fs.chmodSync(cfg, 0o600);
    fs.writeFileSync(`${cfg}.bak`, 'old', { mode: 0o644 });
    fs.chmodSync(`${cfg}.bak`, 0o644);
    await hub.post('settings', { ask_model: 'm3' });
    assert.equal(modeOf(cfg), 0o600);
    assert.equal(modeOf(`${cfg}.bak`), 0o600);
    assert.match(fs.readFileSync(`${cfg}.bak`, 'utf8'), /ask_key/, '.bak 里是上一版配置，含明文密钥（汇报里说明）');
  });

  it('值校验：非 http 地址、带账号密码的地址、过长、类型不对都是 400；错误信息不回显密钥', async () => {
    const bad = [
      { ask_url: 'ftp://gw.example' }, { ask_url: 'gw.example/v1' }, { ask_url: 'https://user:pw@gw.example/v1' }, { ask_url: 5 }, { ask_url: `https://gw.example/${'a'.repeat(300)}` },
      { ask_model: 5 }, { ask_model: 'm'.repeat(81) },
      { ask_key: 5 }, { ask_key: 'k'.repeat(301) }, { ask_key: '' }, { ask_key: ['x'] },
    ];
    for (const body of bad) {
      const r = await hub.post('settings', body);
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
      assert.match(r.json.error, /[一-龥]/);
      if (typeof body.ask_key === 'string') assert.ok(!r.text.includes(body.ask_key.slice(0, 20)) || body.ask_key === '');
    }
    const tooLong = 'k'.repeat(300) + 'TAIL-SENTINEL';
    const r = await hub.post('settings', { ask_key: tooLong });
    assert.equal(r.status, 400);
    assert.ok(!r.text.includes('TAIL-SENTINEL'));
    assert.equal(hub.read('config.json').ask_key, KEY, '被拒的请求不改配置');
  });

  it('null 清除；ask_url / ask_model 传空串也是清除，ask_key 不能传空串', async () => {
    assert.equal((await hub.post('settings', { ask_key: null })).json.settings.ask_key_set, false);
    assert.ok(!('ask_key' in hub.read('config.json')));
    assert.equal((await hub.post('settings', { ask_url: '', ask_model: null })).status, 200);
    const c = hub.read('config.json');
    assert.ok(!('ask_url' in c) && !('ask_model' in c));
  });

  it('审计只记键名，不记值', async () => {
    await hub.post('settings', { ask_key: KEY });
    const raw = fs.readFileSync(hub.path('state/usage.jsonl'), 'utf8');
    assert.match(raw, /console:settings/);
    assert.ok(!raw.includes(KEY));
    await hub.post('settings', { ask_key: null });
  });
});

describe('问答', () => {
  let hub; let S; let fake;
  const seen = []; // 所有 /console/api/* 响应的原文，最后统一扫密钥
  const track = (r) => { seen.push(r.text); return r; };
  const ask = async (q, headers) => track(await hub.api('POST', 'ask', { q }, headers));
  const get = async (route, headers) => track(await hub.get(route, headers));
  const prompt = (rec) => rec.body.messages.map((m) => m.content).join('\n');

  before(async () => {
    fake = await fakeModel(ok);
    hub = await startHub(hubOpts({ ask_timeout_ms: 800, ask_rate_per_min: 1000 }));
    S = await seed(hub);
    assert.equal((await hub.post('devices/build-server', { hide_projects: ['secret-proj'] })).status, 200);
  });
  after(async () => { await fake.close(); await hub.stop(); });

  it('没配置：status 是 configured:false，不报错；POST 返回 409 和中文说明，不是 500', async () => {
    const s = await get('ask/status');
    assert.equal(s.status, 200);
    assert.deepEqual(s.json, { configured: false, model: '' });
    const r = await ask('支付回调怎么处理');
    assert.equal(r.status, 409);
    assert.match(r.json.error, /设置/);
    assert.equal(fake.reqs.length, 0);
  });

  it('只配一部分也算没配置（地址、模型、密钥缺一不可）', async () => {
    await hub.post('settings', { ask_url: `${fake.url}/v1`, ask_model: 'fake-model' });
    assert.equal((await get('ask/status')).json.configured, false);
    assert.equal((await ask('支付回调怎么处理')).status, 409);
  });

  it('配置后：status 给出模型名（不含地址和密钥）', async () => {
    const r = await hub.post('settings', { ask_key: KEY });
    track(r);
    const s = await get('ask/status');
    assert.deepEqual(s.json, { configured: true, model: 'fake-model' });
  });

  it('请求校验：问题必须是 1–500 字的字符串', async () => {
    for (const q of ['', '   ', 5, null, 'x'.repeat(501), '问'.repeat(501)]) {
      const r = track(await hub.api('POST', 'ask', { q }));
      assert.equal(r.status, 400, JSON.stringify(q).slice(0, 30));
      assert.match(r.json.error, /[一-龥]/);
    }
    assert.equal(track(await hub.api('POST', 'ask', {})).status, 400);
    assert.equal((await ask('问'.repeat(500))).status === 400, false, '恰好 500 字可以');
    fake.reqs.length = 0;
  });

  it('成功：带 Authorization 和模型名；消息里有记忆和对话片段；返回答案和可点的出处', async () => {
    fake.reqs.length = 0;
    const r = await ask('支付回调重复到达的时候怎么做幂等键？');
    assert.equal(r.status, 200, r.text);
    assert.equal(fake.reqs.length, 1);
    const rec = fake.reqs[0];
    assert.equal(rec.method, 'POST');
    assert.equal(rec.url, '/v1/chat/completions');
    assert.equal(rec.headers.authorization, `Bearer ${KEY}`);
    assert.equal(rec.body.model, 'fake-model');
    assert.equal(rec.body.stream, false);
    const p = prompt(rec);
    assert.match(p, /支付回调改用幂等键去重/);
    assert.match(p, /订单号加时间窗做幂等键/, '记忆片段');
    assert.match(p, /SETNX/, '对话片段');
    assert.match(p, /\[1\]/);
    assert.match(rec.body.messages[0].content, /只依据/);
    assert.match(rec.body.messages[0].content, /不知道/);
    assert.match(rec.body.messages[1].content, /支付回调重复到达的时候怎么做幂等键/);

    assert.match(r.json.answer, /\[1\]/);
    const mem = r.json.sources.find((s) => s.kind === 'memory' && s.id === S.ids.pay);
    assert.ok(mem);
    assert.equal(mem.n, 1, '最相关的记忆排第一');
    assert.equal(mem.title, '支付回调改用幂等键去重');
    assert.equal(mem.project, 'shop-api');
    assert.match(mem.date, /^\d{4}-\d{2}-\d{2}$/);
    const cv = r.json.sources.find((s) => s.kind === 'conv');
    assert.ok(cv);
    assert.equal(cv.n, r.json.sources.filter((s) => s.kind === 'memory').length + 1, '记忆在前、对话在后，编号连续');
    assert.match(cv.ref, /^[0-9a-f]{8}$/);
    assert.equal(cv.date, S.day);
    assert.equal(cv.project, 'shop-api');
    assert.ok(Number.isInteger(cv.hit) && cv.hit >= 1);
    assert.deepEqual(r.json.sources.filter((s) => s.cited).map((s) => s.n), [1, 2], '答案里引了 [1] 和 [2]');
    assert.ok(r.json.sources.every((s, i) => s.n === i + 1));
    assert.equal((await hub.get(`conv/${cv.ref}`)).status, 200, '出处里的 ref 能读回原文');
  });

  it('送给模型的对话片段已脱敏（存档里即使留着没打码的令牌）', async () => {
    const file = hub.path('archive/conv/my-laptop/claude-code/s-pay.jsonl');
    const ts = new Date(S.t0 + 5 * 60e3).toISOString();
    fs.appendFileSync(file, `${JSON.stringify({ r: 'a', t: ts, x: '之前用过的令牌 sk-ant-ABCDEFGHIJKLMNOPQRSTUVWX1234567890 也是做幂等键用的 password=Sup3rSecretPw' })}\n`);
    fake.reqs.length = 0;
    const r = await ask('幂等键的令牌是什么');
    assert.equal(r.status, 200);
    const p = prompt(fake.reqs[0]);
    assert.ok(!p.includes('sk-ant-ABCDEFGHIJKLMNOPQRSTUVWX1234567890'));
    assert.ok(!p.includes('Sup3rSecretPw'));
    assert.match(p, /已打码/, '被打码的位置有标记，说明这条片段确实送过去了');
    assert.ok(!r.text.includes('sk-ant-ABCDEFGHIJKLMNOPQRSTUVWX1234567890'));
  });

  it('检索范围按浏览者过滤：被隐藏的项目不进检索、不进提示词、不进出处', async () => {
    fake.reqs.length = 0;
    const open = await ask('zebra-launch 的幂等键放在哪个头里');
    assert.equal(open.status, 200);
    assert.ok(open.json.sources.some((s) => s.id === S.ids.secret), '能看全部的浏览者能检索到');
    assert.match(prompt(fake.reqs[0]), /X-Launch-Key/);

    fake.reqs.length = 0;
    const hid = await ask('zebra-launch 的幂等键放在哪个头里', HIDER);
    assert.equal(hid.status, 200);
    assert.ok(!hid.json.sources.some((s) => s.id === S.ids.secret || s.project === 'secret-proj'));
    assert.equal(fake.reqs.length, 1, '没隐藏的幂等键记忆仍会检索到');
    const p = prompt(fake.reqs[0]);
    assert.ok(!p.includes('zebra-launch 的幂等键约定'));
    assert.ok(!p.includes('X-Launch-Key'));
    assert.ok(!p.includes('专用头'));
    assert.match(p, /支付回调改用幂等键去重/);
    assert.ok(!hid.text.includes('X-Launch-Key'));
  });

  it('什么都没检索到：不调用模型，直说没找到', async () => {
    fake.reqs.length = 0;
    const r = await ask('quetzalcoatl 的年度预算');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.sources, []);
    assert.match(r.json.answer, /没有找到/);
    assert.equal(fake.reqs.length, 0);
  });

  it('每次提问记审计 console:ask：问题前 80 字，不记答案、不记密钥', async () => {
    const long = `幂等键${'的'.repeat(100)}怎么做`;
    await ask(long);
    const rows = fs.readFileSync(hub.path('state/usage.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((u) => u.op === 'console:ask');
    assert.ok(rows.length >= 4);
    const last = rows[rows.length - 1];
    assert.equal(last.client, 'console');
    assert.equal(last.device, 'my-laptop');
    assert.equal(last.d, long.slice(0, 80));
    const raw = fs.readFileSync(hub.path('state/usage.jsonl'), 'utf8');
    assert.ok(!raw.includes(KEY));
    assert.ok(!raw.includes('按资料，支付回调用幂等键去重'), '不记答案');
    // 问题里带了令牌：审计前打码
    await ask('我的令牌 sk-ant-ZZZZZZZZZZZZZZZZZZZZZZZZZZ1234567890 能做幂等键吗');
    assert.ok(!fs.readFileSync(hub.path('state/usage.jsonl'), 'utf8').includes('sk-ant-ZZZZZZZZZZZZZZZZZZZZZZZZZZ1234567890'));
  });

  it('模型接口出错：502 + 中文原因，只有短摘要，不透出原始内容；密钥不外泄', async () => {
    const leak = 'INTERNAL-HOST-10.9.8.7 stacktrace at /srv/secret/app.js '.repeat(10);
    const f2 = await fakeModel((_r, res) => reply(res, 500, `<html>${leak}</html>`, 'text/html'));
    await hub.post('settings', { ask_url: `${f2.url}/v1` });
    try {
      const r = await ask('幂等键怎么做');
      assert.equal(r.status, 502);
      assert.match(r.json.error, /模型接口/);
      assert.match(r.json.error, /500/);
      assert.ok(r.json.error.length < 120);
      assert.ok(!r.text.includes('INTERNAL-HOST'));
      assert.ok(!r.text.includes(KEY));
      // JSON 错误体：只留 error.message 的前面一小段
      const f3 = await fakeModel((_r, res) => reply(res, 401, { error: { message: `Incorrect API key provided: ${KEY}. ${'x'.repeat(300)} tail-sentinel` } }));
      await hub.post('settings', { ask_url: `${f3.url}/v1/chat/completions` });
      try {
        const r3 = await ask('幂等键怎么做');
        assert.equal(r3.status, 502);
        assert.match(r3.json.error, /401/);
        assert.ok(r3.json.error.length < 200);
        assert.ok(!r3.text.includes('tail-sentinel'));
        assert.ok(!r3.text.includes(KEY));
      } finally { await f3.close(); }
      // 返回的不是对话接口的格式 / 空内容
      for (const [body, re] of [[{ nope: 1 }, /格式/], [{ choices: [{ message: { content: '' } }] }, /没有返回内容/]]) {
        const f4 = await fakeModel((_r, res) => reply(res, 200, body));
        await hub.post('settings', { ask_url: `${f4.url}/v1` });
        try { const r4 = await ask('幂等键怎么做'); assert.equal(r4.status, 502); assert.match(r4.json.error, re); } finally { await f4.close(); }
      }
      // 连不上
      await hub.post('settings', { ask_url: 'http://127.0.0.1:1/v1' });
      const r5 = await ask('幂等键怎么做');
      assert.equal(r5.status, 502);
      assert.match(r5.json.error, /连不上/);
      assert.ok(!r5.text.includes(KEY));
    } finally {
      await f2.close();
      await hub.post('settings', { ask_url: `${fake.url}/v1` });
    }
  });

  it('模型接口超时：502 + 中文原因', async () => {
    const hang = await fakeModel(() => new Promise(() => {}));
    await hub.post('settings', { ask_url: `${hang.url}/v1` });
    try {
      const t0 = Date.now();
      const r = await ask('幂等键怎么做');
      assert.equal(r.status, 502);
      assert.match(r.json.error, /超时|没有响应/);
      assert.ok(Date.now() - t0 < 5000, '按 ask_timeout_ms（测试里 800ms）超时，而不是等 60 秒');
    } finally { await hang.close(); await hub.post('settings', { ask_url: `${fake.url}/v1` }); }
  });

  it('向量服务不可用时照常用关键词检索回答', async () => {
    await hub.post('settings', { embed_url: 'http://127.0.0.1:1' });
    try { assert.equal((await ask('支付回调的幂等键')).status, 200); } finally { await hub.post('settings', { embed_url: '' }); }
  });

  it('密钥不外泄：所有响应、配置读取、审计、服务端日志、错误里都没有；只给 ask_key_set', async () => {
    const s = await get('settings');
    assert.equal(s.json.settings.ask_key_set, true);
    assert.ok(!('ask_key' in s.json.settings));
    for (const route of ['devices', 'mcp', 'jobs', 'topology', 'topology/events', 'search?q=ask', 'ask/status']) await get(route);
    await get('nope'); // 404
    await hub.post('settings', { gate_secret: 'x' }).then(track);
    await hub.post('settings', { ask_key: 5 }).then(track);
    for (const body of seen) assert.ok(!body.includes(KEY), '响应里出现了密钥');
    const usage = fs.readFileSync(hub.path('state/usage.jsonl'), 'utf8');
    assert.ok(!usage.includes(KEY));
    const log = hub.getLog();
    assert.ok(!log.includes(KEY), '服务端日志里出现了密钥');
    // 浏览页、大屏的数据接口同样不含
    for (const route of ['/browse/viz-data', '/browse/data', '/browse/audit?days=7']) {
      const w = await hub.web('GET', route);
      assert.ok(!w.text.includes(KEY), route);
    }
    // 配置文件和 .bak 是唯一存放明文的地方
    assert.equal(hub.read('config.json').ask_key, KEY);
  });
});

describe('问答：限流', () => {
  let hub; let fake;
  before(async () => { fake = await fakeModel(ok); hub = await startHub(hubOpts({ ask_url: fake.url, ask_model: 'fake-model', ask_key: KEY })); await seed(hub); });
  after(async () => { await fake.close(); await hub.stop(); });

  it('同一浏览者每分钟最多 10 次，第 11 次 429；别的浏览者不受影响；不触发的请求（校验失败、未配置）不占额度', async () => {
    for (let i = 0; i < 3; i++) assert.equal((await hub.api('POST', 'ask', { q: '' })).status, 400);
    for (let i = 0; i < 10; i++) assert.equal((await hub.api('POST', 'ask', { q: `支付回调幂等键 ${i}` })).status, 200, `第 ${i + 1} 次`);
    const r = await hub.api('POST', 'ask', { q: '支付回调幂等键 又一次' });
    assert.equal(r.status, 429);
    assert.match(r.json.error, /每分钟|稍后/);
    assert.equal(fake.reqs.length, 10, '被限流的不调用模型');
    const other = await hub.api('POST', 'ask', { q: '支付回调幂等键' }, HIDER);
    assert.equal(other.status, 200);
    // 状态接口不受限流影响
    assert.equal((await hub.get('ask/status')).status, 200);
  });
});

describe('askTerms：从问句里拆关键词', () => {
  it('去掉问句里的虚词，ASCII 词整个留下，中文按二字片段', () => {
    const t = askTerms('订单系统现网现在是哪个版本？');
    assert.ok(t.includes('订单') && t.includes('版本'), t.join('|'));
    assert.ok(!t.some((x) => /[是哪个现在]/.test(x) && x.length === 1));
    const e = askTerms('怎么在 build-server 上排查 df 磁盘满了的问题');
    assert.ok(e.includes('build-server') && e.includes('df'), e.join('|'));
    assert.ok(e.includes('磁盘'), e.join('|'));
    assert.ok(!e.includes('怎么'));
  });
  it('空问题、全是虚词时给空数组；数量有上限', () => {
    assert.deepEqual(askTerms(''), []);
    assert.deepEqual(askTerms('请问是什么'), []);
    assert.ok(askTerms('一二三四五六七八九十'.repeat(20)).length <= 30);
  });
});
