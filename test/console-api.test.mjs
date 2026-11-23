// 控制台管理接口（/console/api/*）的集成测试：在临时目录里造最小的配置和数据，起一个真实的中心进程。
// 运行：node --test test/

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hub', 'server.mjs');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const GATE = 'test-gate-secret';
const GATE_HEADERS = { 'x-am-gate': GATE, 'x-am-peer': 'my-laptop' };

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

// 起一个中心：opts.tokens 是 {设备名: {token, role?, readonly?}}，opts.config 合并进配置，opts.archive 为 false 时不挂对话存档盘
async function startHub(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-console-'));
  const port = await freePort();
  const p = (n) => path.join(dir, n);
  for (const d of ['repo', 'state', 'cards']) fs.mkdirSync(p(d), { recursive: true });
  if (opts.archive !== false) { fs.mkdirSync(p('archive'), { recursive: true }); fs.writeFileSync(p('archive/.am-archive'), ''); }
  const config = {
    listen: '127.0.0.1', port, repo: p('repo'), state: p('state'), tokens: p('tokens.json'), cards_dir: p('cards'), archive_dir: p('archive'),
    public_url: `http://hub.example:${port}`, gate_secret: GATE, ...opts.config,
  };
  fs.writeFileSync(p('config.json'), JSON.stringify(config, null, 2));
  const devices = {};
  const tokenOf = {};
  for (const [name, d] of Object.entries(opts.tokens || {})) {
    tokenOf[name] = d.token;
    devices[name] = { sha256: sha256(d.token), role: d.role || 'device', created: new Date().toISOString(), ...(d.readonly ? { readonly: true } : {}) };
  }
  fs.writeFileSync(p('tokens.json'), JSON.stringify({ devices }));
  const peers = {};
  for (const name of opts.peers || []) peers[name] = { peer: `tailnet:${name}`, aliases: [`tailnet:${name}`], os: 'linux', seen: new Date().toISOString(), first: new Date().toISOString() };
  fs.writeFileSync(p('state/peers.json'), JSON.stringify(peers));

  let child = null;
  let log = '';
  const base = `http://127.0.0.1:${port}`;
  const launch = async () => {
    child = spawn(process.execPath, [SERVER], { env: { ...process.env, AGENT_MEMORY_CONFIG: p('config.json') }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (b) => { log += b; });
    child.stderr.on('data', (b) => { log += b; });
    for (let i = 0; ; i++) {
      try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* 还没起来 */ }
      if (i > 100 || child.exitCode !== null) throw new Error(`中心没起来：${log}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const halt = async () => {
    child.kill('SIGTERM');
    await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
  };
  await launch();
  const hub = {
    dir, base, port, tokenOf, path: p,
    // 浏览器身份（网关认出的）调用控制台接口
    async api(method, route, body, headers = GATE_HEADERS) {
      const res = await fetch(`${base}/console/api/${route}`, {
        method, headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
      return { status: res.status, json, text };
    },
    get: (route, headers) => hub.api('GET', route, undefined, headers),
    post: (route, body, headers) => hub.api('POST', route, body, headers),
    // 设备带令牌调 MCP
    async rpc(device, method, params) {
      const res = await fetch(`${base}/mcp?client=test`, {
        method: 'POST', headers: { authorization: `Bearer ${tokenOf[device]}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      return (await res.json()).result;
    },
    async device(device, route, body) {
      const res = await fetch(`${base}${route}`, {
        method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${tokenOf[device]}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
    read: (name) => JSON.parse(fs.readFileSync(p(name), 'utf8')),
    async restart() { await halt(); await launch(); },
    async stop() {
      await halt();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return hub;
}

const TOKENS = { 'my-laptop': { token: 'tok-laptop-secret-value' }, 'build-server': { token: 'tok-build-secret-value' } };
const TOKEN_HASHES = (hub) => Object.values(hub.read('tokens.json').devices).map((v) => v.sha256);
const ENDPOINTS = [['GET', 'devices'], ['POST', 'devices/build-server'], ['POST', 'join-code'], ['GET', 'join-codes'], ['POST', 'join-code/revoke'], ['GET', 'mcp'], ['POST', 'mcp/tool'], ['GET', 'jobs'], ['GET', 'topology'], ['GET', 'topology/events'], ['GET', 'settings'], ['POST', 'settings'], ['GET', 'conv/search?q=x'], ['GET', 'conv/abcdef12']];

describe('控制台接口：身份', () => {
  let hub;
  before(async () => { hub = await startHub({ tokens: TOKENS, peers: ['my-laptop'] }); });
  after(() => hub.stop());

  it('没有网关身份一律 403', async () => {
    for (const [m, r] of ENDPOINTS) {
      const res = await hub.api(m, r, m === 'POST' ? {} : undefined, {});
      assert.equal(res.status, 403, `${m} ${r}`);
      assert.ok(res.json?.error, `${m} ${r} 应带中文 error`);
    }
  });

  it('暗号不对、或身份没绑定设备都是 403', async () => {
    assert.equal((await hub.get('devices', { ...GATE_HEADERS, 'x-am-gate': 'wrong' })).status, 403);
    assert.equal((await hub.get('devices', { ...GATE_HEADERS, 'x-am-peer': 'stranger' })).status, 403);
  });

  it('已接入设备的身份可以访问', async () => {
    assert.equal((await hub.get('devices')).status, 200);
  });

  it('未知路径 404，方法不对 405', async () => {
    assert.equal((await hub.get('nope')).status, 404);
    assert.equal((await hub.post('devices', {})).status, 405);
    assert.equal((await hub.get('join-code')).status, 405);
  });
});

describe('控制台接口：console_viewer', () => {
  it('没有网关身份时，浏览器按配置的设备算', async () => {
    const hub = await startHub({ tokens: TOKENS, config: { gate_secret: '', console_viewer: 'my-laptop' } });
    try {
      assert.equal((await hub.get('devices', {})).status, 200);
    } finally { await hub.stop(); }
  });

  it('配置的设备不存在时仍是 403', async () => {
    const hub = await startHub({ tokens: TOKENS, config: { gate_secret: '', console_viewer: 'no-such-device' } });
    try {
      assert.equal((await hub.get('devices', {})).status, 403);
    } finally { await hub.stop(); }
  });
});

describe('控制台接口：设备', () => {
  let hub;
  before(async () => {
    hub = await startHub({ tokens: { ...TOKENS, 'ci-reporter': { token: 'tok-reporter-secret', role: 'reporter' } }, peers: ['my-laptop'], config: { device_labels: { 'my-laptop': '笔记本' } } });
    await hub.device('build-server', '/v1/heartbeat', { agent_version: '0.9.1', hostname: 'build-01', wiring: { 'claude-code': { mcp: 'on' } } });
  });
  after(() => hub.stop());

  it('列出每台设备：身份、角色、版本、最近同步、策略，不含令牌', async () => {
    const { status, json, text } = await hub.get('devices');
    assert.equal(status, 200);
    assert.equal(json.default_stale_hours, 3);
    const by = Object.fromEntries(json.devices.map((d) => [d.name, d]));
    assert.deepEqual(Object.keys(by).sort(), ['build-server', 'ci-reporter', 'my-laptop']);
    assert.equal(by['my-laptop'].label, '笔记本');
    assert.equal(by['my-laptop'].identity, 'gateway');
    assert.equal(by['build-server'].identity, 'token');
    assert.equal(by['ci-reporter'].role, 'reporter');
    assert.equal(by['build-server'].version, '0.9.1');
    assert.ok(by['build-server'].last_seen);
    assert.equal(by['my-laptop'].last_seen, null);
    assert.deepEqual(by['build-server'].policy, { readonly: false, hide_projects: [], paused: false, stale_hours: null });
    assert.equal(typeof by['build-server'].agents, 'object');
    assert.ok(!text.includes('sha256'));
    assert.ok(!text.includes('tok-'));
    assert.ok(!text.includes(sha256('tok-build-secret-value')));
    assert.ok(!text.includes(GATE));
  });

  it('改策略：写进令牌文件，devicePolicy 当场生效（只读设备写记忆被拒）', async () => {
    const remember = (title) => hub.rpc('build-server', 'tools/call', { name: 'memory_remember', arguments: { type: 'fact', title, body: 'body' } });
    assert.ok(!(await remember('before readonly')).isError);

    const r = await hub.post('devices/build-server', { readonly: true, stale_hours: 6, hide_projects: ['secret-proj'], paused: true });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.policy, { readonly: true, hide_projects: ['secret-proj'], paused: true, stale_hours: 6 });
    const onDisk = hub.read('tokens.json').devices['build-server'];
    assert.equal(onDisk.readonly, true);
    assert.equal(onDisk.stale_hours, 6);
    assert.deepEqual(onDisk.hide_projects, ['secret-proj']);
    assert.equal(onDisk.paused, true);
    assert.ok(onDisk.sha256, '令牌哈希必须保留');

    const denied = await remember('while readonly');
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /只读/);
    const viaHttp = await hub.device('build-server', '/v1/remember', { type: 'fact', title: 'http write', body: 'b' });
    assert.equal(viaHttp.status, 403);

    assert.equal((await hub.get('devices')).json.devices.find((d) => d.name === 'build-server').policy.readonly, true);

    const back = await hub.post('devices/build-server', { readonly: false, paused: false, hide_projects: [], stale_hours: null });
    assert.equal(back.status, 200);
    assert.deepEqual(back.json.policy, { readonly: false, hide_projects: [], paused: false, stale_hours: null });
    assert.ok(!(await remember('after readonly')).isError);
  });

  it('只改给出的字段', async () => {
    await hub.post('devices/build-server', { stale_hours: 12 });
    const r = await hub.post('devices/build-server', { paused: true });
    assert.equal(r.json.policy.stale_hours, 12);
    assert.equal(r.json.policy.paused, true);
    await hub.post('devices/build-server', { paused: false, stale_hours: null });
  });

  it('输入校验：4xx 和中文 error，且不改任何东西', async () => {
    const before = fs.readFileSync(hub.path('tokens.json'), 'utf8');
    const bad = [
      ['devices/no-such-device', { readonly: true }, 404],
      ['devices/build-server', { stale_hours: 0 }, 400],
      ['devices/build-server', { stale_hours: -2 }, 400],
      ['devices/build-server', { stale_hours: 1.5 }, 400],
      ['devices/build-server', { stale_hours: '6' }, 400],
      ['devices/build-server', { hide_projects: 'a,b' }, 400],
      ['devices/build-server', { hide_projects: [1] }, 400],
      ['devices/build-server', { readonly: 'yes' }, 400],
      ['devices/build-server', { paused: 1 }, 400],
      ['devices/build-server', { nickname: 'x' }, 400],
      ['devices/build-server', { sha256: 'x' }, 400],
      ['devices/build-server', { role: 'admin' }, 400],
      ['devices/build-server', { readonly: true, stale_hours: 0 }, 400],
    ];
    for (const [route, body, code] of bad) {
      const r = await hub.post(route, body);
      assert.equal(r.status, code, `${route} ${JSON.stringify(body)}`);
      assert.match(r.json.error, /[一-龥]/, '错误信息要是中文');
    }
    assert.equal(fs.readFileSync(hub.path('tokens.json'), 'utf8'), before);
  });

  it('写操作记审计', async () => {
    await hub.post('devices/build-server', { stale_hours: 9 });
    const ops = fs.readFileSync(hub.path('state/usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const e = ops.filter((o) => o.op === 'console:device-set').pop();
    assert.ok(e, '应有 console:device-set');
    assert.equal(e.device, 'my-laptop');
    assert.equal(e.client, 'console');
    assert.match(e.d, /build-server/);
  });
});

describe('控制台接口：加入码', () => {
  let hub;
  before(async () => { hub = await startHub({ tokens: TOKENS, peers: ['my-laptop'] }); });
  after(() => hub.stop());

  it('生成加入码和两条安装命令，码立即可用', async () => {
    const r = await hub.post('join-code', { days: 3 });
    assert.equal(r.status, 200);
    assert.match(r.json.code, /^[0-9a-f]{24}$/);
    assert.equal(r.json.days, 3);
    assert.ok(Date.parse(r.json.expires) > Date.now() + 2.9 * 86400e3);
    assert.equal(r.json.sh, `curl -fsSL http://hub.example:${hub.port}/join/${r.json.code}/sh | bash`);
    assert.equal(r.json.ps1, `irm http://hub.example:${hub.port}/join/${r.json.code}/ps1 | iex`);
    assert.equal(r.json.page, `http://hub.example:${hub.port}/join/${r.json.code}`);
    assert.equal((await fetch(`${hub.base}/join/${r.json.code}`)).status, 200);
  });

  it('不给 days 默认 7 天；超出 0–90 或不是整数是 400', async () => {
    assert.equal((await hub.post('join-code', {})).json.days, 7);
    for (const days of [91, -1, 2.5, '7', null]) {
      const r = await hub.post('join-code', { days });
      assert.equal(r.status, 400, `days=${days}`);
      assert.match(r.json.error, /[一-龥]/);
    }
  });

  it('days 为 0 是长期有效：没有到期时间，码照样可用', async () => {
    const r = await hub.post('join-code', { days: 0 });
    assert.equal(r.status, 200);
    assert.equal(r.json.days, 0);
    assert.equal(r.json.expires, null);
    assert.equal((await fetch(`${hub.base}/join/${r.json.code}`)).status, 200);
    assert.equal(hub.read('state/join.json')[Object.keys(hub.read('state/join.json')).pop()].expires, null);
  });

  it('列出还在生效的加入码，不泄露码本身；作废后立刻不能用', async () => {
    const a = (await hub.post('join-code', { days: 0 })).json;
    const b = (await hub.post('join-code', { days: 2 })).json;
    const list = await hub.get('join-codes');
    assert.equal(list.status, 200);
    assert.ok(!JSON.stringify(list.json).includes(a.code) && !JSON.stringify(list.json).includes(b.code));
    for (const c of list.json.codes) {
      assert.match(c.id, /^[0-9a-f]{12}$/);
      assert.equal(typeof c.uses, 'number');
      assert.ok(Date.parse(c.created) <= Date.now());
      assert.ok(c.expires === null || Date.parse(c.expires) > Date.now());
    }
    assert.ok(list.json.codes.some((c) => c.expires === null));
    const before = list.json.codes.length;
    // 最新生成的排最前
    const newest = list.json.codes[0];
    assert.ok(Date.parse(newest.expires) > Date.now(), '最新的是 2 天那个');
    const gone = await hub.post('join-code/revoke', { id: newest.id });
    assert.equal(gone.status, 200);
    assert.equal((await fetch(`${hub.base}/join/${b.code}`)).status, 404);
    assert.equal((await fetch(`${hub.base}/join/${a.code}`)).status, 200, '别的码不受影响');
    assert.equal((await hub.get('join-codes')).json.codes.length, before - 1);
    assert.equal((await hub.post('join-code/revoke', { id: newest.id })).status, 404);
    for (const id of ['', 'xyz', 12, null, 'ABCDEF123456']) assert.equal((await hub.post('join-code/revoke', { id })).status, 400, `id=${id}`);
    assert.match(fs.readFileSync(hub.path('state/usage.jsonl'), 'utf8'), /console:join-revoke/);
  });

  it('审计里记了天数，没有记加入码本身', async () => {
    const r = await hub.post('join-code', { days: 5 });
    const raw = fs.readFileSync(hub.path('state/usage.jsonl'), 'utf8');
    assert.match(raw, /console:join-code/);
    assert.ok(!raw.includes(r.json.code));
  });
});

describe('控制台接口：MCP', () => {
  let hub;
  before(async () => { hub = await startHub({ tokens: TOKENS, peers: ['my-laptop'] }); });
  after(() => hub.stop());

  const listed = async () => (await hub.rpc('my-laptop', 'tools/list', {})).tools.map((t) => t.name);

  it('接入地址和工具清单', async () => {
    await hub.rpc('my-laptop', 'tools/call', { name: 'memory_recent', arguments: {} });
    const r = await hub.get('mcp');
    assert.equal(r.status, 200);
    assert.equal(r.json.http, `http://hub.example:${hub.port}/mcp`);
    assert.match(r.json.stdio, /kb-agent\.mjs mcp --client/);
    const by = Object.fromEntries(r.json.tools.map((t) => [t.name, t]));
    for (const name of ['memory_search', 'memory_remember', 'conversation_get', 'kb_read']) assert.ok(by[name], name);
    assert.equal(by.memory_remember.kind, 'write');
    assert.equal(by.memory_search.kind, 'read');
    assert.equal(by.kb_read.kind, 'read');
    assert.ok(by.memory_search.description);
    assert.equal(by.memory_recent.calls_7d, 1);
    assert.ok(by.memory_recent.last_call);
    assert.equal(by.memory_search.calls_7d, 0);
    assert.equal(by.memory_search.last_call, null);
    assert.equal(by.memory_search.disabled, false);
    assert.equal(r.json.tools.length, (await listed()).length);
  });

  it('停用：tools/list 里没有，调用返回明确错误；再启用恢复', async () => {
    const off = await hub.post('mcp/tool', { name: 'memory_search', disabled: true });
    assert.equal(off.status, 200);
    assert.deepEqual(off.json.disabled_tools, ['memory_search']);
    assert.ok(!(await listed()).includes('memory_search'));
    const call = await hub.rpc('my-laptop', 'tools/call', { name: 'memory_search', arguments: { query: 'x' } });
    assert.equal(call.isError, true);
    assert.match(call.content[0].text, /停用/);
    assert.equal((await hub.get('mcp')).json.tools.find((t) => t.name === 'memory_search').disabled, true);
    assert.deepEqual(hub.read('config.json').disabled_tools, ['memory_search']);
    assert.equal(hub.read('config.json').gate_secret, GATE, '写配置不能丢别的键');

    // 其他工具不受影响，重复停用不重复记录
    assert.ok((await listed()).includes('memory_recent'));
    assert.deepEqual((await hub.post('mcp/tool', { name: 'memory_search', disabled: true })).json.disabled_tools, ['memory_search']);

    const on = await hub.post('mcp/tool', { name: 'memory_search', disabled: false });
    assert.deepEqual(on.json.disabled_tools, []);
    assert.ok((await listed()).includes('memory_search'));
    const again = await hub.rpc('my-laptop', 'tools/call', { name: 'memory_search', arguments: { query: 'x' } });
    assert.ok(!again.isError);
  });

  it('输入校验', async () => {
    for (const body of [{ name: 'no_such_tool', disabled: true }, { name: 'memory_search' }, { name: 'memory_search', disabled: 'yes' }, { disabled: true }, { name: 5, disabled: true }]) {
      const r = await hub.post('mcp/tool', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(r.json.error, /[一-龥]/);
    }
    assert.ok(await listed().then((l) => l.includes('memory_search')));
  });

  it('停用写审计', async () => {
    await hub.post('mcp/tool', { name: 'kb_map', disabled: true });
    await hub.post('mcp/tool', { name: 'kb_map', disabled: false });
    const raw = fs.readFileSync(hub.path('state/usage.jsonl'), 'utf8');
    assert.match(raw, /console:mcp-tool/);
    assert.match(raw, /kb_map/);
  });
});

describe('控制台接口：任务状态', () => {
  const KEYS = ['now', 'sync', 'extract', 'journal', 'vectors', 'archive', 'repo', 'watch'];

  it('数据为空（没有设备、没挂存档盘）也不崩，各项都在', async () => {
    const hub2 = await startHub({ archive: false, config: { gate_secret: '', console_viewer: 'my-laptop' }, tokens: { 'my-laptop': { token: 'tok-x-secret-value' } } });
    try {
      const r = await hub2.get('jobs', {});
      assert.equal(r.status, 200);
      for (const k of KEYS) assert.ok(k in r.json, k);
      assert.deepEqual(r.json.sync.devices.map((d) => d.name), ['my-laptop']);
      assert.equal(r.json.sync.devices[0].last_seen, null);
      assert.equal(r.json.sync.devices[0].stale, true);
      assert.equal(r.json.extract.pending, 0);
      assert.equal(r.json.extract.last_processed, null);
      assert.equal(r.json.journal.last_result, null);
      assert.equal(r.json.archive.mounted, false);
      assert.equal(r.json.vectors.enabled, false);
      assert.ok(Array.isArray(r.json.watch.problems));
      assert.ok(r.json.watch.problems.some((p) => /存档盘/.test(p.text)), '存档盘没挂上应出现在巡检里');
      assert.ok(r.json.repo.last_commit, '初始化提交');
      assert.equal(typeof r.json.repo.last_commit.subject, 'string');
      assert.equal((await hub2.get('conv/search?q=x', {})).status, 503);
    } finally { await hub2.stop(); }
  });

  it('有数据时：同步、抽取、日志、存档、最近提交', async () => {
    const hub = await startHub({ tokens: TOKENS, peers: ['my-laptop'], config: { embed_url: '' } });
    try {
      await hub.device('build-server', '/v1/heartbeat', { agent_version: '0.9.1' });
      await hub.device('build-server', '/v1/sessions', { tool: 'codex', session_id: 'x1', messages: [{ role: 'user', text: 'hello there' }] });
      await hub.device('build-server', '/v1/conv/append', { tool: 'codex', session_id: 'x1', base: 0, messages: [{ role: 'user', text: 'hello there', ts: new Date().toISOString() }] });
      await hub.device('build-server', '/v1/remember', { type: 'fact', title: 'a fact', body: 'b' });
      const r = await hub.get('jobs');
      assert.equal(r.status, 200);
      const by = Object.fromEntries(r.json.sync.devices.map((d) => [d.name, d]));
      assert.equal(by['build-server'].stale, false);
      assert.ok(by['build-server'].last_seen);
      assert.equal(by['my-laptop'].stale, true);
      assert.equal(r.json.sync.stale_count, 1);
      assert.equal(r.json.extract.pending, 1);
      assert.ok(r.json.extract.last_uploaded);
      assert.equal(r.json.archive.mounted, true);
      assert.equal(r.json.archive.sessions, 1);
      assert.equal(r.json.journal.pending >= 0, true);
      assert.match(r.json.repo.last_commit.subject, /./);
      assert.ok(Date.parse(r.json.repo.last_commit.time) > 0);
    } finally { await hub.stop(); }
  });
});

describe('控制台接口：拓扑', () => {
  const KEYS = ['now', 'hub', 'gate', 'devices', 'storage', 'extractors', 'reporters', 'pending', 'vectors', 'problems', 'viewer'];

  it('数据为空（没有网关、没挂存档盘、只有一台设备）也不崩，各块都在', async () => {
    const hub = await startHub({ archive: false, config: { gate_secret: '', console_viewer: 'my-laptop' }, tokens: { 'my-laptop': { token: 'tok-x-secret-value' } } });
    try {
      const r = await hub.get('topology', {});
      assert.equal(r.status, 200);
      for (const k of KEYS) assert.ok(k in r.json, k);
      assert.equal(r.json.gate.enabled, false);
      assert.equal(r.json.gate.devices, 0);
      assert.equal(r.json.hub.memories, 0);
      assert.equal(r.json.hub.calls_7d, 0);
      assert.match(r.json.hub.version, /^\d+\.\d+\.\d+$/);
      assert.equal(r.json.devices.length, 1);
      assert.equal(r.json.devices[0].name, 'my-laptop');
      assert.equal(r.json.devices[0].live, false);
      assert.deepEqual(r.json.devices[0].agents, []);
      assert.equal(r.json.storage.archive.mounted, false);
      assert.deepEqual(r.json.extractors, []);
      assert.deepEqual(r.json.reporters, []);
      assert.equal(r.json.vectors.enabled, false);
      assert.equal(r.json.viewer.device, 'my-laptop');
      assert.equal(r.json.viewer.via, 'config');
      assert.ok(Array.isArray(r.json.problems));
    } finally { await hub.stop(); }
  });

  it('配置了网关：enabled 为真，经网关认出的设备算进数量，浏览者按网关身份', async () => {
    const hub = await startHub({ tokens: TOKENS, peers: ['my-laptop'] });
    try {
      const r = await hub.get('topology');
      assert.equal(r.status, 200);
      assert.equal(r.json.gate.enabled, true);
      assert.equal(r.json.gate.devices, 1);
      const by = Object.fromEntries(r.json.devices.map((d) => [d.name, d]));
      assert.equal(by['my-laptop'].identity, 'gateway');
      assert.equal(by['build-server'].identity, 'token');
      assert.equal(r.json.viewer.device, 'my-laptop');
      assert.equal(r.json.viewer.via, 'gateway');
    } finally { await hub.stop(); }
  });

  it('没配网关：设备都不算经网关接入', async () => {
    const hub = await startHub({ tokens: TOKENS, config: { gate_secret: '', console_viewer: 'my-laptop' } });
    try {
      const r = await hub.get('topology', {});
      assert.equal(r.json.gate.enabled, false);
      assert.equal(r.json.gate.devices, 0);
    } finally { await hub.stop(); }
  });

  it('超时设备标成超时，刚同步的不是；暂停的不算超时；抽取机和报表单列', async () => {
    const tokens = { ...TOKENS, 'old-box': { token: 'tok-old-secret-value' }, nightly: { token: 'tok-ext-secret-value', role: 'extractor' }, daily: { token: 'tok-rep-secret-value', role: 'reporter' } };
    const hub = await startHub({ tokens, peers: ['my-laptop'] });
    try {
      await hub.device('build-server', '/v1/heartbeat', { agent_version: '0.9.1' });
      assert.equal((await hub.post('devices/old-box', { paused: true })).status, 200);
      const r = await hub.get('topology');
      const by = Object.fromEntries(r.json.devices.map((d) => [d.name, d]));
      assert.deepEqual(Object.keys(by).sort(), ['build-server', 'my-laptop', 'old-box']);
      assert.equal(by['my-laptop'].stale, true);
      assert.equal(by['my-laptop'].last_seen, null);
      assert.equal(by['build-server'].stale, false);
      assert.ok(by['build-server'].last_seen);
      assert.equal(by['old-box'].paused, true);
      assert.equal(by['old-box'].stale, false);
      assert.deepEqual(r.json.extractors.map((x) => x.name), ['nightly']);
      assert.deepEqual(r.json.reporters.map((x) => x.name), ['daily']);
      assert.ok(r.json.problems.some((p) => p.key === 'stale:my-laptop'));
    } finally { await hub.stop(); }
  });

  it('有会话和记忆时：正在干活、智能体、条数、存档会话数', async () => {
    const hub = await startHub({ tokens: TOKENS, peers: ['my-laptop'], config: { embed_url: '' } });
    try {
      await hub.device('build-server', '/v1/heartbeat', { agent_version: '0.9.1' });
      await hub.device('build-server', '/v1/conv/append', { tool: 'codex', session_id: 'x1', base: 0, messages: [{ role: 'user', text: 'hello there', ts: new Date().toISOString() }] });
      await hub.device('build-server', '/v1/remember', { type: 'fact', title: 'a fact', body: 'b' });
      const r = await hub.get('topology');
      const d = r.json.devices.find((x) => x.name === 'build-server');
      assert.equal(d.live, true);
      assert.ok(d.agents.some((a) => a.tool === 'codex'));
      assert.equal(r.json.devices.find((x) => x.name === 'my-laptop').live, false);
      assert.equal(r.json.hub.memories, 1);
      assert.equal(r.json.storage.archive.mounted, true);
      assert.equal(r.json.storage.archive.sessions, 1);
      assert.ok(Date.parse(r.json.storage.repo.last_commit.time) > 0);
    } finally { await hub.stop(); }
  });

  it('不泄露网关暗号、令牌和令牌哈希', async () => {
    const hub = await startHub({ tokens: { ...TOKENS, nightly: { token: 'tok-ext-secret-value', role: 'extractor' } }, peers: ['my-laptop'] });
    try {
      const r = await hub.get('topology');
      assert.equal(r.status, 200);
      for (const bad of [GATE, 'gate_secret', 'tok-', 'sha256', hub.dir, ...TOKEN_HASHES(hub)]) assert.ok(!r.text.includes(bad), `不应出现 ${bad}`);
    } finally { await hub.stop(); }
  });

  it('只支持 GET', async () => {
    const hub = await startHub({ tokens: TOKENS, peers: ['my-laptop'] });
    try { assert.equal((await hub.post('topology', {})).status, 405); } finally { await hub.stop(); }
  });
});

describe('控制台接口：拓扑的实时数据', () => {
  const ROLES = { ...TOKENS, nightly: { token: 'tok-ext-secret-value', role: 'extractor' }, daily: { token: 'tok-rep-secret-value', role: 'reporter' } };
  const rep = (hub, p) => hub.device('daily', p);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const usage = (hub) => { try { return fs.readFileSync(hub.path('state/usage.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

  it('报表令牌：调 /v1/report、/v1/weekly 记 usage，/v1/status 和 /v1/watch（探活、巡检，调得勤）不记；最近活动和最近操作准确', async () => {
    const hub = await startHub({ tokens: ROLES, peers: ['my-laptop'] });
    try {
      const before = (await hub.get('topology')).json.reporters[0];
      assert.equal(before.last_active, null);
      assert.equal(before.last_op, null);
      assert.equal((await rep(hub, '/v1/status')).status, 200);
      assert.ok(!usage(hub).some((u) => u.device === 'daily'), '/v1/status 不应记 usage');
      for (const p of ['/v1/report', '/v1/watch', '/v1/weekly']) assert.equal((await rep(hub, p)).status, 200, p);
      assert.deepEqual(usage(hub).filter((u) => u.device === 'daily').map((u) => u.op), ['report:report', 'report:weekly']);
      const r = (await hub.get('topology')).json.reporters[0];
      assert.ok(Date.now() - Date.parse(r.last_active) < 10e3);
      assert.equal(r.last_op, '/v1/weekly');
    } finally { await hub.stop(); }
  });

  it('抽取机令牌：最近一次请求落进 extractors，落盘限频，重启后读得回', async () => {
    const hub = await startHub({ tokens: ROLES, peers: ['my-laptop'] });
    try {
      assert.equal((await hub.device('nightly', '/v1/sessions/pending')).status, 200);
      const first = hub.read('state/last-request.json').nightly;
      assert.equal(first.op, '/v1/sessions/pending');
      await sleep(30);
      assert.equal((await hub.device('nightly', '/v1/journal/pending')).status, 200);
      assert.equal(hub.read('state/last-request.json').nightly.t, first.t, '60 秒内不重复落盘');
      let x = (await hub.get('topology')).json.extractors[0];
      assert.equal(x.last_op, '/v1/journal/pending');
      assert.ok(Date.parse(x.last_active) > Date.parse(first.t));
      await hub.restart();
      x = (await hub.get('topology')).json.extractors[0];
      assert.equal(x.last_op, '/v1/journal/pending');
      assert.ok(Date.now() - Date.parse(x.last_active) < 30e3);
    } finally { await hub.stop(); }
  });

  it('设备令牌和普通设备不进 last-request.json', async () => {
    const hub = await startHub({ tokens: ROLES, peers: ['my-laptop'] });
    try {
      await hub.device('build-server', '/v1/status');
      assert.ok(!fs.existsSync(hub.path('state/last-request.json')));
    } finally { await hub.stop(); }
  });

  it('读写流量：上行 = 新消息 + 写入类调用，下行 = 读取类调用；hours 和上行同口径；智能体、中心合计', async () => {
    const hub = await startHub({ tokens: ROLES, peers: ['my-laptop'], config: { embed_url: '' } });
    try {
      const now = Date.now();
      const msgs = (n, agoMs) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `m${i}`, ts: new Date(now - agoMs + i * 1000).toISOString() }));
      const post = (tool, sid, m) => fetch(`${hub.base}/v1/conv/append?client=${tool}`, { method: 'POST', headers: { authorization: `Bearer ${hub.tokenOf['build-server']}`, 'content-type': 'application/json' }, body: JSON.stringify({ tool, session_id: sid, base: 0, messages: m }) });
      assert.equal((await post('codex', 's1', msgs(4, 30 * 60e3))).status, 200);
      assert.equal((await post('codex', 's2', msgs(2, 5 * 3600e3))).status, 200);
      assert.equal((await post('claude-code', 's3', msgs(3, 30 * 3600e3))).status, 200); // 超过 24 小时，不算
      await hub.device('build-server', '/v1/heartbeat', { agent_version: '0.9.2', wiring: { codex: { mcp: 'on' }, 'claude-code': { mcp: 'on' } } });
      const call = (name, args) => fetch(`${hub.base}/mcp?client=codex`, { method: 'POST', headers: { authorization: `Bearer ${hub.tokenOf['build-server']}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
      await call('memory_remember', { type: 'fact', title: 'flow fact', body: 'b' });
      await call('memory_search', { query: 'flow' });
      await call('memory_search', { query: 'fact' });
      await call('memory_recent', {});
      const t = (await hub.get('topology')).json;
      const d = t.devices.find((x) => x.name === 'build-server');
      assert.equal(d.flow.up_24h, 6 + 1);
      assert.equal(d.flow.down_24h, 3);
      assert.equal(d.flow.hours.length, 24);
      assert.equal(d.flow.hours.reduce((a, b) => a + b, 0), d.flow.up_24h);
      assert.ok(d.flow.hours[23] >= 5, '最近一小时有活动');
      assert.equal(d.flow.hours[18] + d.flow.hours[19], 2, '5 小时前那两条落在对应格（边界上可能差一格）');
      const codex = d.agents.find((a) => a.tool === 'codex');
      assert.equal(codex.up_24h, 6 + 1);
      assert.equal(codex.down_24h, 3);
      assert.equal(d.agents.find((a) => a.tool === 'claude-code').up_24h, 0);
      assert.deepEqual(t.devices.find((x) => x.name === 'my-laptop').flow, { up_24h: 0, down_24h: 0, hours: Array(24).fill(0) });
      assert.equal(t.hub.up_24h, 7);
      assert.equal(t.hub.down_24h, 3);
    } finally { await hub.stop(); }
  });

  it('事件流：种类、文字、顺序、since、limit、id 稳定；不带设备名和密钥', async () => {
    const hub = await startHub({ tokens: ROLES, peers: ['my-laptop'], config: { embed_url: '' } });
    try {
      const call = (name, args) => fetch(`${hub.base}/mcp?client=codex`, { method: 'POST', headers: { authorization: `Bearer ${hub.tokenOf['build-server']}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
      await hub.device('build-server', '/v1/conv/append', { tool: 'codex', session_id: 'e1', base: 0, messages: [{ role: 'user', text: 'hi', ts: new Date().toISOString() }] });
      await call('memory_search', { query: '部署 回滚' });
      await sleep(5);
      await call('memory_remember', { type: 'decision', title: '用灰度发布', body: 'b' });
      await sleep(5);
      await call('memory_search', { query: `长${'很长'.repeat(40)}` });
      await rep(hub, '/v1/weekly');
      await hub.device('nightly', '/v1/sessions/result', { key: 'nope' }).catch(() => {});
      assert.equal((await hub.post('devices/my-laptop', { readonly: false })).status, 200);
      const r = await hub.get('topology/events');
      assert.equal(r.status, 200);
      assert.ok(Date.parse(r.json.now) > 0);
      const ev = r.json.events;
      const kinds = new Set(ev.map((e) => e.kind));
      for (const k of ['read', 'write', 'talk', 'report', 'console']) assert.ok(kinds.has(k), `缺 ${k}`);
      for (let i = 1; i < ev.length; i++) assert.ok(Date.parse(ev[i].t) >= Date.parse(ev[i - 1].t), '时间升序');
      assert.equal(new Set(ev.map((e) => e.id)).size, ev.length, 'id 唯一');
      for (const e of ev) assert.deepEqual(Object.keys(e).sort(), ['device', 'id', 'kind', 't', 'text', 'tool']);
      assert.ok(ev.some((e) => e.kind === 'read' && e.text === '查了记忆「部署 回滚」' && e.device === 'build-server' && e.tool === 'codex'));
      assert.ok(ev.some((e) => e.kind === 'write' && e.text === '写了一条记忆「用灰度发布」'));
      assert.ok(ev.some((e) => e.kind === 'report' && e.text === '拉了周报' && e.device === 'daily'));
      assert.ok(ev.some((e) => e.kind === 'talk' && e.text === '有新对话' && e.tool === 'codex'));
      assert.ok(ev.every((e) => e.text.length <= 48), '文字不超长');
      for (const e of ev) for (const bad of ['build-server', 'my-laptop', GATE, 'tok-', 'sha256', hub.dir]) assert.ok(!e.text.includes(bad), `text 不应含 ${bad}`);
      // since：只给更新的；同一次请求的 id 不变
      const again = (await hub.get('topology/events')).json.events;
      assert.deepEqual(again.map((e) => e.id), ev.map((e) => e.id));
      const mid = ev[Math.floor(ev.length / 2)];
      const later = (await hub.get(`topology/events?since=${encodeURIComponent(mid.t)}`)).json.events;
      assert.ok(later.length && later.every((e) => Date.parse(e.t) > Date.parse(mid.t)));
      assert.deepEqual((await hub.get(`topology/events?since=${encodeURIComponent(ev[ev.length - 1].t)}`)).json.events, []);
      // limit：取最新的几条
      const two = (await hub.get('topology/events?limit=2')).json.events;
      assert.deepEqual(two.map((e) => e.id), ev.slice(-2).map((e) => e.id));
      for (const bad of ['limit=0', 'limit=101', 'limit=x', 'since=昨天']) assert.equal((await hub.get(`topology/events?${bad}`)).status, 400, bad);
      assert.equal((await hub.post('topology/events', {})).status, 405);
    } finally { await hub.stop(); }
  });

  it('事件流：查询里带的密钥会打码', async () => {
    const hub = await startHub({ tokens: ROLES, peers: ['my-laptop'], config: { embed_url: '' } });
    try {
      await fetch(`${hub.base}/mcp?client=codex`, { method: 'POST', headers: { authorization: `Bearer ${hub.tokenOf['build-server']}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'password=Abc12345secret' } } }) });
      const r = await hub.get('topology/events');
      assert.ok(!r.text.includes('Abc12345secret'));
    } finally { await hub.stop(); }
  });
});

describe('控制台接口：设置', () => {
  let hub;
  before(async () => {
    hub = await startHub({ tokens: TOKENS, peers: ['my-laptop'], config: { stale_hours: 3, device_labels: { 'my-laptop': '笔记本' }, auto_register_deny: ['^customer-'], graph_entities: { machine: ['my-laptop'], site: [] } } });
  });
  after(() => hub.stop());

  const KEYS = ['public_url', 'embed_url', 'stale_hours', 'auto_approve_days', 'digest_budget', 'auto_register_deny', 'device_labels', 'graph_entities'];

  it('只返回白名单键，不含 gate_secret、令牌和路径', async () => {
    const r = await hub.get('settings');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json.settings).sort(), [...KEYS].sort());
    assert.equal(r.json.settings.stale_hours, 3);
    assert.deepEqual(r.json.settings.device_labels, { 'my-laptop': '笔记本' });
    assert.equal(r.json.settings.auto_approve_days, null);
    assert.equal(r.json.defaults.auto_approve_days, 3);
    for (const bad of [GATE, 'gate_secret', 'tokens', 'sha256', 'tok-', hub.dir]) assert.ok(!r.text.includes(bad), `不应出现 ${bad}`);
  });

  it('写回：.bak 在、别的键不丢、内存里当场生效', async () => {
    const before = fs.readFileSync(hub.path('config.json'), 'utf8');
    const r = await hub.post('settings', { stale_hours: 5, device_labels: { 'my-laptop': 'Laptop', 'build-server': '构建机' }, auto_approve_days: 7, digest_budget: 9000, embed_url: '', auto_register_deny: ['^guest-', '^kiosk-\\d+$'] });
    assert.equal(r.status, 200);
    assert.equal(r.json.settings.stale_hours, 5);
    assert.ok(!r.text.includes(GATE));

    const bak = fs.readFileSync(hub.path('config.json.bak'), 'utf8');
    assert.equal(bak, before);
    const now = hub.read('config.json');
    assert.equal(now.stale_hours, 5);
    assert.equal(now.auto_approve_days, 7);
    assert.equal(now.digest_budget, 9000);
    assert.equal(now.gate_secret, GATE);
    assert.equal(now.port, hub.port);
    assert.deepEqual(now.auto_register_deny, ['^guest-', '^kiosk-\\d+$']);
    assert.deepEqual(fs.readdirSync(hub.dir).filter((n) => n.includes('.tmp')), [], '不留临时文件');

    // 内存里当场生效：大屏数据用的是 CFG.device_labels；设备列表里的显示名同源
    const viz = await fetch(`${hub.base}/browse/viz-data`, { headers: GATE_HEADERS });
    assert.deepEqual((await viz.json()).device_labels, { 'my-laptop': 'Laptop', 'build-server': '构建机' });
    assert.equal((await hub.get('devices')).json.devices.find((d) => d.name === 'build-server').label, '构建机');
    assert.equal((await hub.get('settings')).json.settings.auto_approve_days, 7);
    assert.equal((await hub.get('devices')).json.default_stale_hours, 5);
  });

  it('null 清除可选项', async () => {
    const r = await hub.post('settings', { auto_approve_days: null, stale_hours: null });
    assert.equal(r.status, 200);
    assert.equal(r.json.settings.auto_approve_days, null);
    assert.ok(!('auto_approve_days' in hub.read('config.json')));
    assert.equal((await hub.get('devices')).json.default_stale_hours, 3);
  });

  it('白名单外的键被拒；gate_secret 不能改', async () => {
    const snapshot = fs.readFileSync(hub.path('config.json'), 'utf8');
    for (const body of [{ gate_secret: 'x' }, { tokens: '/etc/x' }, { repo: '/x' }, { port: 1 }, { disabled_tools: [] }, { stale_hours: 4, gate_secret: 'x' }]) {
      const r = await hub.post('settings', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(r.json.error, /[一-龥]/);
    }
    assert.equal(fs.readFileSync(hub.path('config.json'), 'utf8'), snapshot, '被拒的请求不能改配置（一个字段都不能应用）');
    assert.equal(hub.read('config.json').gate_secret, GATE);
  });

  it('值校验', async () => {
    const bad = [
      { public_url: 'ftp://hub.example' }, { public_url: 'not a url' }, { public_url: null }, { embed_url: 'localhost:8080' },
      { stale_hours: 0 }, { stale_hours: 1.5 }, { stale_hours: 'x' }, { auto_approve_days: -1 }, { auto_approve_days: 1.2 }, { digest_budget: 10 }, { digest_budget: 'big' },
      { auto_register_deny: 'a' }, { auto_register_deny: ['('] }, { auto_register_deny: ['ok', '[a-'] }, { auto_register_deny: [1] },
      { device_labels: ['a'] }, { device_labels: { 'my laptop': 'x' } }, { device_labels: { 'my-laptop': 5 } },
      { graph_entities: { machine: 'a' } }, { graph_entities: { other: [] } }, { graph_entities: { machine: [1] } },
    ];
    for (const body of bad) {
      const r = await hub.post('settings', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(r.json.error, /[一-龥]/);
    }
    const ok = await hub.post('settings', { public_url: 'https://hub.example:8443', embed_url: 'http://embed.example:9000', graph_entities: { machine: ['my-laptop'], site: ['site-a'] } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.settings.public_url, 'https://hub.example:8443');
    assert.equal(ok.json.settings.embed_url, 'http://embed.example:9000');
    assert.equal((await hub.post('join-code', { days: 1 })).json.page.startsWith('https://hub.example:8443/join/'), true, 'public_url 当场生效');
    await hub.post('settings', { embed_url: '' });
  });

  it('空请求体不改配置；写审计', async () => {
    const snapshot = fs.readFileSync(hub.path('config.json'), 'utf8');
    assert.equal((await hub.post('settings', {})).status, 400);
    assert.equal(fs.readFileSync(hub.path('config.json'), 'utf8'), snapshot);
    const raw = fs.readFileSync(hub.path('state/usage.jsonl'), 'utf8');
    assert.match(raw, /console:settings/);
  });

  it('配置文件坏了不覆盖', async () => {
    const hub2 = await startHub({ tokens: TOKENS, peers: ['my-laptop'] });
    try {
      fs.writeFileSync(hub2.path('config.json'), '{ not json');
      const r = await hub2.post('settings', { stale_hours: 4 });
      assert.equal(r.status, 500);
      assert.equal(fs.readFileSync(hub2.path('config.json'), 'utf8'), '{ not json');
    } finally { await hub2.stop(); }
  });
});

describe('控制台接口：对话存档', () => {
  let hub;
  let ref;
  before(async () => {
    hub = await startHub({ tokens: TOKENS, peers: ['my-laptop'] });
    const t0 = Date.now() - 3600e3;
    const messages = [
      { role: 'user', text: 'please fix the parser bug in the tokenizer', ts: new Date(t0).toISOString() },
      { role: 'assistant', text: 'The tokenizer drops the last character; patched.', ts: new Date(t0 + 60e3).toISOString() },
      { role: 'user', text: 'thanks, now add a unit test', ts: new Date(t0 + 120e3).toISOString() },
    ];
    const r = await hub.device('build-server', '/v1/conv/append', { tool: 'claude-code', session_id: 's1', base: 0, title: 'Fix parser', messages });
    assert.equal(r.json.ok, true);
    await hub.device('my-laptop', '/v1/conv/append', { tool: 'codex', session_id: 's2', base: 0, title: 'Other', messages: [{ role: 'user', text: 'tokenizer question on another machine', ts: new Date(t0).toISOString() }] });
  });
  after(() => hub.stop());

  it('搜索：返回结构化结果', async () => {
    const r = await hub.get('conv/search?q=tokenizer');
    assert.equal(r.status, 200);
    assert.equal(r.json.total, 2);
    assert.equal(r.json.limit, 10);
    assert.deepEqual(r.json.words, ['tokenizer']);
    const h = r.json.hits.find((x) => x.device === 'build-server');
    assert.match(h.ref, /^[0-9a-f]{8}$/);
    assert.equal(h.tool, 'claude-code');
    assert.equal(h.tool_label, 'Claude Code');
    assert.equal(h.title, 'Fix parser');
    assert.equal(h.found.length, 2);
    assert.equal(h.found[0].role, 'user');
    assert.match(h.found[0].snippet, /tokenizer/);
    assert.match(h.found[0].day, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(h.found[0].time, /^\d{2}:\d{2}$/);
    ref = h.ref;
  });

  it('搜索：按设备、智能体、角色、日期筛选', async () => {
    assert.equal((await hub.get('conv/search?q=tokenizer&device=build-server')).json.total, 1);
    assert.equal((await hub.get('conv/search?q=tokenizer&tool=codex')).json.hits[0].device, 'my-laptop');
    assert.equal((await hub.get('conv/search?q=tokenizer&role=assistant')).json.total, 1);
    assert.equal((await hub.get('conv/search?q=tokenizer&from=2099-01-01')).json.total, 0);
    assert.equal((await hub.get('conv/search?q=tokenizer&to=2000-01-01')).json.total, 0);
    assert.equal((await hub.get('conv/search?q=tokenizer&from=2000-01-01&to=2099-01-01&limit=1')).json.hits.length, 1);
    const none = await hub.get('conv/search?q=zzz-no-such-word');
    assert.equal(none.status, 200);
    assert.deepEqual(none.json.hits, []);
  });

  it('搜索：参数校验', async () => {
    for (const route of ['conv/search', 'conv/search?q=', 'conv/search?q=x&from=yesterday-ish', 'conv/search?q=x&to=2026-13-45', 'conv/search?q=x&role=system', 'conv/search?q=x&limit=0']) {
      const r = await hub.get(route);
      assert.equal(r.status, 400, route);
      assert.match(r.json.error, /[一-龥]/);
    }
  });

  it('读取：会话信息和消息', async () => {
    const r = await hub.get(`conv/${ref}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.session.ref, ref);
    assert.equal(r.json.session.title, 'Fix parser');
    assert.equal(r.json.session.device, 'build-server');
    assert.equal(r.json.session.n, 3);
    assert.ok(r.json.session.days.length >= 1);
    assert.equal(r.json.messages.length, 3);
    assert.deepEqual(r.json.messages.map((m) => m.index), [1, 2, 3]);
    assert.equal(r.json.messages[1].role, 'assistant');
    assert.match(r.json.messages[0].text, /parser bug/);
    assert.equal(r.json.messages[0].truncated, false);
    assert.equal(r.json.next, null);
    assert.equal(r.json.empty, false);
  });

  it('读取：按日期、角色、起点筛选；没有的会话 404', async () => {
    const day = (await hub.get(`conv/${ref}`)).json.messages[0].day;
    assert.equal((await hub.get(`conv/${ref}?date=${day}`)).json.messages.length, 3);
    const none = await hub.get(`conv/${ref}?date=2000-01-01`);
    assert.equal(none.json.messages.length, 0);
    assert.equal(none.json.empty, true);
    assert.equal((await hub.get(`conv/${ref}?role=user`)).json.messages.length, 2);
    assert.deepEqual((await hub.get(`conv/${ref}?from=3`)).json.messages.map((m) => m.index), [3]);
    assert.equal((await hub.get('conv/00000000')).status, 404);
    assert.equal((await hub.get(`conv/${ref}?date=soon`)).status, 400);
    assert.equal((await hub.get(`conv/${ref}?role=bot`)).status, 400);
  });

  it('长会话分页：next 接着读，长消息截断、full=1 看全文', async () => {
    const t0 = Date.now() - 1800e3;
    const long = 'x'.repeat(3900);
    const messages = Array.from({ length: 12 }, (_, i) => ({ role: 'user', text: `${i}-${long}`, ts: new Date(t0 + i * 1000).toISOString() }));
    messages.push({ role: 'assistant', text: 'y'.repeat(5000), ts: new Date(t0 + 20e3).toISOString() });
    await hub.device('build-server', '/v1/conv/append', { tool: 'claude-code', session_id: 'long', base: 0, title: 'Long one', messages });
    const found = (await hub.get('conv/search?q=0-xxxx&device=build-server')).json.hits.find((h) => h.title === 'Long one');
    const first = (await hub.get(`conv/${found.ref}`)).json;
    assert.ok(first.next, '应分页');
    assert.ok(first.messages.length < 13);
    const rest = (await hub.get(`conv/${found.ref}?from=${first.next}`)).json;
    assert.equal(rest.messages[0].index, first.next);
    const all = [...first.messages, ...rest.messages];
    const a = all.find((m) => m.role === 'assistant') || (await hub.get(`conv/${found.ref}?from=13`)).json.messages[0];
    assert.equal(a.truncated, true);
    assert.equal(a.text.length, 2500);
    const full = (await hub.get(`conv/${found.ref}?from=13&full=1`)).json.messages[0];
    assert.equal(full.truncated, false);
    assert.equal(full.text.length, 5000);
  });

  it('原来给模型看的文本版输出不变', async () => {
    const s = await hub.rpc('my-laptop', 'tools/call', { name: 'conversation_search', arguments: { query: 'tokenizer', device: 'build-server' } });
    assert.match(s.content[0].text, /^在 1 个会话里搜到「tokenizer」（用 conversation_get 加 ref 和日期读上下文）：\n1\. build-server\/Claude Code「Fix parser」ref:[0-9a-f]{8}\n   - \d{4}-\d{2}-\d{2} \d{2}:\d{2} 第 1 条（用户）：/);
    const g = await hub.rpc('my-laptop', 'tools/call', { name: 'conversation_get', arguments: { ref } });
    assert.match(g.content[0].text, /^会话「Fix parser」 build-server\/Claude Code ref:[0-9a-f]{8}\n时间 .* → .*，共 3 条\n按天：.* 3 条\n\n\[1 用户 /);
    const miss = await hub.rpc('my-laptop', 'tools/call', { name: 'conversation_get', arguments: { ref: 'ffffffff' } });
    assert.match(miss.content[0].text, /^没有这个会话：ffffffff。/);
  });
});

describe('命令行与接口共用的逻辑', () => {
  it('device-set 命令行输出不变，改动和接口同一个函数', async () => {
    const hub = await startHub({ tokens: TOKENS, peers: ['my-laptop'] });
    try {
      const env = { ...process.env, AGENT_MEMORY_CONFIG: hub.path('config.json') };
      const { spawnSync } = await import('node:child_process');
      const run = (...args) => spawnSync(process.execPath, [SERVER, ...args], { env, encoding: 'utf8' });
      const r = run('device-set', 'build-server', 'stale_hours=48', 'readonly=true', 'hide_projects=a, b');
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, 'build-server: {"stale_hours":48,"paused":false,"readonly":true,"hide_projects":["a","b"]}\n');
      assert.equal((await hub.get('devices')).json.devices.find((d) => d.name === 'build-server').policy.readonly, true);
      const bad = run('device-set', 'nope', 'paused=true');
      assert.equal(bad.status, 1);
      assert.equal(bad.stderr, '没有设备 nope\n');
      const bad2 = run('device-set', 'build-server', 'color=red');
      assert.equal(bad2.status, 1);
      assert.equal(bad2.stderr, '不认识的参数 color\n');
      assert.equal(hub.read('tokens.json').devices['build-server'].stale_hours, 48, '出错时不应写入');
      const forever = run('join-code', '0');
      assert.equal(forever.status, 0, forever.stderr);
      assert.match(forever.stdout, /^长期有效，可以在任意多台机器上用：\n/);
      const j = run('join-code', '2');
      assert.equal(j.status, 0, j.stderr);
      assert.match(j.stdout, new RegExp(`^2 天内有效，可以在任意多台机器上用：\\nmacOS / Linux：curl -fsSL http://hub\\.example:${hub.port}/join/[0-9a-f]{24}/sh \\| bash\\nWindows PowerShell：irm http://hub\\.example:${hub.port}/join/[0-9a-f]{24}/ps1 \\| iex\\n说明页：http://hub\\.example:${hub.port}/join/[0-9a-f]{24}\\n$`));
    } finally { await hub.stop(); }
  });
});

describe('待整理计数与审计', () => {
  let hub;
  before(async () => { hub = await startHub({ tokens: TOKENS, peers: ['my-laptop'] }); });
  after(() => hub.stop());
  const browse = async (route, body) => {
    const res = await fetch(`${hub.base}/browse/${route}`, {
      method: body ? 'POST' : 'GET', headers: { ...GATE_HEADERS, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json() };
  };
  const remember = (title, project) => hub.rpc('my-laptop', 'tools/call', { name: 'memory_remember', arguments: { type: 'decision', title, body: `${title} body`, project } });

  it('manage-counts 没有身份是 403；口径和 manage-data 一致', async () => {
    assert.equal((await fetch(`${hub.base}/browse/manage-counts`)).status, 403);
    let c = (await browse('manage-counts')).json;
    assert.deepEqual(c, { proposed: 0, duplicates: 0, stale: 0, total: 0 });
    await remember('Use the blue deployment pipeline for releases', 'demo');
    await remember('Use the blue deployment pipeline for releases now', 'demo');
    await remember('Something entirely unrelated about caching', 'demo');
    c = (await browse('manage-counts')).json;
    const d = (await browse('manage-data')).json;
    assert.equal(c.duplicates, 1);
    assert.deepEqual(c, { proposed: d.proposed.length, duplicates: d.duplicates.length, stale: d.stale.length, total: d.proposed.length + d.duplicates.length + d.stale.length });
  });

  it('作废后重复分组和计数立刻下降，并写进审计', async () => {
    const d = (await browse('manage-data')).json;
    const [keep, other] = d.duplicates[0];
    const r = await browse('manage-action', { action: 'retire', ids: [other], reason: 'test' });
    assert.equal(r.json.ok, true);
    assert.equal((await browse('manage-counts')).json.duplicates, 0);
    assert.ok(keep);
    const a = (await browse('audit')).json;
    assert.ok(a.events.some((e) => e.op === 'manage:retire'), '作废应在审计事件里');
    const row = a.byClient.find(([k]) => k === 'my-laptop/browser');
    assert.ok(row && row[1].writes >= 1);
  });

  it('控制台写操作进审计事件和统计，打开页面不算写', async () => {
    await hub.post('settings', { stale_hours: 5 });
    await hub.post('devices/build-server', { paused: true });
    await fetch(`${hub.base}/console`, { headers: GATE_HEADERS });
    const a = (await browse('audit')).json;
    const ops = a.events.map((e) => e.op);
    assert.ok(ops.includes('console:settings'));
    assert.ok(ops.includes('console:device-set'));
    const row = a.byClient.find(([k]) => k === 'my-laptop/console');
    assert.ok(row && row[1].writes >= 2, JSON.stringify(a.byClient));
    const page = a.byClient.find(([k]) => k === 'my-laptop/browser');
    assert.ok(page);
  });
});
