// B 组：设备分组（接口、命令行、设备页和拓扑接口里的 group）。运行：node --test test/b-topology-group.test.mjs
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { startHub, GATE, SERVER, TOKENS } from './helpers.mjs';

const ROLES = { ...TOKENS, 'old-box': { token: 'tok-old-secret-value' }, nightly: { token: 'tok-ext-secret-value', role: 'extractor' } };
const usage = (hub) => fs.readFileSync(hub.path('state/usage.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

describe('设备分组：接口', () => {
  let hub;
  before(async () => { hub = await startHub({ tokens: ROLES, peers: ['my-laptop'] }); });
  after(() => hub.stop());
  const dev = async (name) => (await hub.get('devices')).json.devices.find((d) => d.name === name);

  it('默认没有分组：设备项里 group 是空串，令牌文件里没有 group 键', async () => {
    assert.equal((await dev('build-server')).group, '');
    assert.ok(!('group' in hub.read('tokens.json').devices['build-server']));
    const t = (await hub.get('topology')).json.devices.find((d) => d.name === 'build-server');
    assert.equal(t.group, '');
  });

  it('设分组：写进令牌文件，设备接口和拓扑接口都带上，别的策略不受影响', async () => {
    assert.equal((await hub.post('devices/build-server', { readonly: true, stale_hours: 5 })).status, 200);
    const r = await hub.post('devices/build-server', { group: '办公室' });
    assert.equal(r.status, 200);
    assert.equal(r.json.policy.group, '办公室');
    assert.equal(r.json.policy.readonly, true);
    assert.equal(r.json.policy.stale_hours, 5);
    assert.equal(hub.read('tokens.json').devices['build-server'].group, '办公室');
    const d = await dev('build-server');
    assert.equal(d.group, '办公室');
    assert.equal(d.policy.readonly, true);
    assert.equal(d.policy.stale_hours, 5);
    const t = (await hub.get('topology')).json.devices.find((x) => x.name === 'build-server');
    assert.equal(t.group, '办公室');
    assert.equal((await dev('my-laptop')).group, '');
    assert.equal((await hub.get('topology/history')).json.devices.find((x) => x.name === 'build-server').group, '办公室');
  });

  it('改分组、清分组（空串、null、纯空白都是清掉）', async () => {
    assert.equal((await hub.post('devices/build-server', { group: '  机房  ' })).status, 200);
    assert.equal((await dev('build-server')).group, '机房', '首尾空白去掉');
    for (const v of ['', null, '   ']) {
      await hub.post('devices/build-server', { group: '机房' });
      const r = await hub.post('devices/build-server', { group: v });
      assert.equal(r.status, 200, JSON.stringify(v));
      assert.ok(!('group' in r.json.policy));
      assert.ok(!('group' in hub.read('tokens.json').devices['build-server']));
      assert.equal((await dev('build-server')).group, '');
    }
  });

  it('长度和类型：最多 20 个字（中文也按字算），不是字符串 400，不认识的字段仍然拒绝', async () => {
    assert.equal((await hub.post('devices/build-server', { group: '字'.repeat(20) })).status, 200);
    assert.equal((await dev('build-server')).group, '字'.repeat(20));
    for (const bad of ['字'.repeat(21), 'x'.repeat(21), 5, true, ['a'], { a: 1 }, 'a\nb']) {
      const r = await hub.post('devices/build-server', { group: bad });
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.match(r.json.error, /[一-龥]/);
    }
    assert.equal((await dev('build-server')).group, '字'.repeat(20), '出错时不改');
    assert.equal((await hub.post('devices/no-such-device', { group: 'x' })).status, 404);
    assert.equal((await hub.post('devices/build-server', { grp: 'x' })).status, 400);
    await hub.post('devices/build-server', { group: null });
  });

  it('改分组写审计，和其他字段一起改也行', async () => {
    const r = await hub.post('devices/build-server', { group: '实验室', paused: true });
    assert.equal(r.status, 200);
    const e = usage(hub).filter((o) => o.op === 'console:device-set').pop();
    assert.equal(e.device, 'my-laptop');
    assert.match(e.d, /build-server .*group/);
    await hub.post('devices/build-server', { group: null, paused: false, readonly: false, stale_hours: null });
  });

  it('响应里没有令牌哈希和网关暗号', async () => {
    const r = await hub.post('devices/old-box', { group: '实验室' });
    for (const bad of [GATE, 'gate_secret', 'tok-', 'sha256']) assert.ok(!r.text.includes(bad), bad);
    const list = await hub.get('devices');
    for (const bad of [GATE, 'tok-', 'sha256']) assert.ok(!list.text.includes(bad), bad);
  });
});

describe('设备分组：命令行 device-set', () => {
  it('device-set <设备> group=xxx 设置和清除，输出里带 group，没分组时输出不变；超长报错且不写入', async () => {
    const hub = await startHub({ tokens: TOKENS, peers: ['my-laptop'] });
    try {
      const env = { ...process.env, AGENT_MEMORY_CONFIG: hub.path('config.json') };
      const run = (...args) => spawnSync(process.execPath, [SERVER, ...args], { env, encoding: 'utf8' });
      let r = run('device-set', 'build-server', 'group=办公室');
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, 'build-server: {"stale_hours":null,"paused":false,"readonly":false,"hide_projects":[],"group":"办公室"}\n');
      assert.equal(hub.read('tokens.json').devices['build-server'].group, '办公室');
      assert.equal((await hub.get('devices')).json.devices.find((d) => d.name === 'build-server').group, '办公室');
      r = run('device-set', 'build-server', 'group=', 'readonly=true');
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, 'build-server: {"stale_hours":null,"paused":false,"readonly":true,"hide_projects":[]}\n', '清掉以后输出和以前一样');
      assert.ok(!('group' in hub.read('tokens.json').devices['build-server']));
      r = run('device-set', 'build-server', 'group=a=b');
      assert.equal(r.status, 0, r.stderr);
      assert.equal(hub.read('tokens.json').devices['build-server'].group, 'a=b', '值里带等号也行');
      r = run('device-set', 'build-server', `group=${'字'.repeat(21)}`);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /分组.*20/);
      assert.equal(hub.read('tokens.json').devices['build-server'].group, 'a=b', '出错时不写入');
    } finally { await hub.stop(); }
  });
});

describe('前端文件', () => {
  it('回放脚本不再是占位，几个页面脚本语法正确，控制台页引用它们', async () => {
    const hub = await startHub({ tokens: TOKENS, peers: ['my-laptop'] });
    try {
      // 服务端会把相邻的脚本合成带哈希的包，所以引用关系看源文件，单个文件仍能单独取到
      const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hub', 'console.html'), 'utf8');
      for (const f of ['console-topology.js', 'console-replay.js', 'console-admin.js']) {
        assert.ok(html.includes(`/console/${f}`), f);
        const r = await hub.web('GET', `/console/${f}`);
        assert.equal(r.status, 200, f);
        assert.doesNotThrow(() => new vm.Script(r.text, { filename: f }), `${f} 语法`);
      }
      const replay = (await hub.web('GET', '/console/console-replay.js')).text;
      assert.ok(replay.length > 4000 && replay.includes('TopologyHooks'));
    } finally { await hub.stop(); }
  });
});
