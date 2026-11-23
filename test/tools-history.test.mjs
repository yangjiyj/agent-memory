// 记忆工具之一：修改历史（列表、差异、恢复）。运行：node --test test/
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startHub, TOKENS } from './helpers.mjs';

const call = (hub, device, name, args) => hub.rpc(device, 'tools/call', { name, arguments: args });
const remember = async (hub, body, client = 'claude-code') => {
  const r = await hub.device('my-laptop', `/v1/remember?client=${client}`, body);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.id;
};
const update = async (hub, args) => { const r = await call(hub, 'build-server', 'memory_update', args); assert.ok(!r.isError, r.content?.[0]?.text); };
const entryText = async (hub, id) => (await hub.web('GET', `/browse/entry/${id}`)).text;
const usage = (hub) => fs.readFileSync(hub.path('state/usage.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

describe('修改历史：列表、差异、恢复', () => {
  let hub; let id; let shas;
  before(async () => {
    hub = await startHub({ tokens: TOKENS, peers: ['my-laptop'] });
    id = await remember(hub, { type: 'decision', title: 'v1 title', body: 'v1 body line', project: 'proj-a', tags: ['x'] });
    await update(hub, { id, title: 'v2 title', body: 'v2 body line' });
    await update(hub, { id, body: 'v3 body line\nsecond line' });
  });
  after(() => hub.stop());

  it('列表：新的在前，带时间、改动者、动作、序号', async () => {
    const r = await hub.get(`memory/${id}/history`);
    assert.equal(r.status, 200);
    assert.equal(r.json.total, 3);
    assert.equal(r.json.more, false);
    assert.equal(r.json.restorable, true);
    const v = r.json.versions;
    assert.deepEqual(v.map((x) => x.n), [3, 2, 1]);
    assert.deepEqual(v.map((x) => x.current), [true, false, false]);
    assert.deepEqual(v.map((x) => x.by), ['build-server/test', 'build-server/test', 'my-laptop/claude-code']);
    assert.deepEqual(v.map((x) => x.action), ['编辑', '编辑', '新建']);
    assert.equal(v[2].device, 'my-laptop');
    assert.equal(v[2].client, 'claude-code');
    for (const x of v) {
      assert.match(x.sha, /^[0-9a-f]{40}$/);
      assert.equal(x.short, x.sha.slice(0, 7));
      assert.ok(Math.abs(Date.parse(x.time) - Date.now()) < 5 * 60e3, '时间应是刚才');
    }
    assert.match(v[2].subject, /^remember\(decision\): v1 title/);
    shas = v.map((x) => x.sha);
  });

  it('差异：是这个提交对这个文件的 unified diff 文本', async () => {
    const r = await hub.get(`memory/${id}/history/${shas[1]}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.sha, shas[1]);
    assert.equal(r.json.action, '编辑');
    assert.equal(r.json.by, 'build-server/test');
    assert.match(r.json.diff, /^@@/m);
    assert.match(r.json.diff, /^-title: "v1 title"$/m);
    assert.match(r.json.diff, /^\+title: "v2 title"$/m);
    assert.match(r.json.diff, /^-v1 body line$/m);
    assert.match(r.json.diff, /^\+v2 body line$/m);
    assert.ok(!/^diff --git/m.test(r.json.diff), '去掉 git 的文件头');
    // 7 位短 sha 也行；创建那一版是整份新增
    const first = await hub.get(`memory/${id}/history/${shas[2].slice(0, 7)}`);
    assert.equal(first.status, 200);
    assert.equal(first.json.sha, shas[2]);
    assert.match(first.json.diff, /^\+title: "v1 title"$/m);
    assert.ok(!/^-[^-]/m.test(first.json.diff), '创建版没有删除行');
  });

  it('恢复：产生新版本、旧版本原样还在、记审计', async () => {
    const r = await hub.post(`memory/${id}/restore`, { sha: shas[2] });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.restored_from, shas[2].slice(0, 7));
    assert.equal(r.json.entry.title, 'v1 title');
    const text = await entryText(hub, id);
    assert.match(text, /^# v1 title/);
    assert.match(text, /v1 body line/);
    assert.ok(!/v3 body line/.test(text));
    // 项目和标签一并恢复
    assert.match(text, /project: proj-a/);
    assert.match(text, /tags: x/);

    const h = (await hub.get(`memory/${id}/history`)).json;
    assert.equal(h.total, 4);
    assert.equal(h.versions[0].action, '恢复旧版本');
    assert.equal(h.versions[0].by, 'my-laptop/console');
    assert.equal(h.versions[0].sha.slice(0, 7), r.json.version);
    assert.deepEqual(h.versions.slice(1).map((x) => x.sha), shas, '历史没有被改写');

    const rows = usage(hub).filter((u) => u.op === 'console:memory-restore');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].device, 'my-laptop');
    assert.match(rows[0].d, new RegExp(`${id} .* ${shas[2].slice(0, 7)}`));
    // 恢复本身又是一个版本：可以再恢复回去
    const back = await hub.post(`memory/${id}/restore`, { sha: shas[0] });
    assert.equal(back.status, 200, back.text);
    assert.match(await entryText(hub, id), /v3 body line/);
  });

  it('和当前内容一样的版本不用恢复', async () => {
    const h = (await hub.get(`memory/${id}/history`)).json;
    const r = await hub.post(`memory/${id}/restore`, { sha: h.versions[0].sha });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /一样/);
  });

  it('非法 id / sha 一律挡在 git 之前', async () => {
    for (const bad of ['..%2F..%2Fetc%2Fpasswd', 'a%3Brm%20-rf', '-x', 'a%20b', 'x'.repeat(81), '%2Fetc']) {
      assert.equal((await hub.get(`memory/${bad}/history`)).status, 400, bad);
      assert.equal((await hub.post(`memory/${bad}/restore`, { sha: 'abcdef0' })).status, 400, bad);
    }
    for (const sha of ['zzzzzzz', 'abc', '--help', 'HEAD', 'abcdef0;ls', 'ABCDEF0', 'a'.repeat(41)]) {
      assert.equal((await hub.get(`memory/${id}/history/${encodeURIComponent(sha)}`)).status, 400, sha);
      assert.equal((await hub.post(`memory/${id}/restore`, { sha })).status, 400, sha);
    }
    assert.equal((await hub.post(`memory/${id}/restore`, {})).status, 400);
    assert.equal((await hub.post(`memory/${id}/restore`, [])).status, 400);
    // 格式对但不存在
    assert.equal((await hub.get('memory/m-20260101-aaaaaa/history')).status, 404);
    assert.equal((await hub.get(`memory/${id}/history/abcdef0`)).status, 404);
    assert.equal((await hub.post(`memory/${id}/restore`, { sha: 'abcdef0' })).status, 404);
    // 别的记忆的提交号不算这条记忆的版本
    const other = await remember(hub, { type: 'fact', title: 'other entry', body: 'b' });
    const otherSha = (await hub.get(`memory/${other}/history`)).json.versions[0].sha;
    assert.equal((await hub.get(`memory/${id}/history/${otherSha}`)).status, 404);
    assert.equal((await hub.post(`memory/${id}/restore`, { sha: otherSha })).status, 404);
  });

  it('没有网关身份一律 403，方法不对 405', async () => {
    for (const [m, r, b] of [['GET', `memory/${id}/history`], ['GET', `memory/${id}/history/${shas[0]}`], ['POST', `memory/${id}/restore`, { sha: shas[0] }]]) {
      const res = await hub.api(m, r, b, {});
      assert.equal(res.status, 403, r);
      assert.ok(res.json?.error);
    }
    assert.equal((await hub.post(`memory/${id}/history`, {})).status, 405);
    assert.equal((await hub.get(`memory/${id}/restore`)).status, 405);
  });
});

describe('修改历史：不能改的条目', () => {
  let hub;
  before(async () => { hub = await startHub({ tokens: TOKENS, peers: ['my-laptop'] }); });
  after(() => hub.stop());

  it('原生同步来的条目：历史能看，恢复被拒（400，中文原因）', async () => {
    const content = (d) => `---\nname: pref-x\ndescription: ${d}\nmetadata:\n  type: user\n---\nnative body ${d}`;
    const sync = (d) => hub.device('my-laptop', '/v1/native/sync?client=claude-code', { tool: 'claude-code', files: [{ key: 'pref.md', content: content(d) }], present: ['pref.md'] });
    assert.equal((await sync('first')).status, 200);
    assert.equal((await sync('second')).status, 200);
    const nid = (await hub.web('GET', '/browse/data')).json.entries.find((e) => e.origin === 'native').id;
    const h = await hub.get(`memory/${nid}/history`);
    assert.equal(h.status, 200);
    assert.equal(h.json.total, 2);
    assert.equal(h.json.restorable, false);
    assert.match(h.json.reason, /原生/);
    assert.equal(h.json.versions[0].action, '原生同步');
    assert.equal(h.json.versions[1].action, '原生同步（新建）');
    assert.equal((await hub.get(`memory/${nid}/history/${h.json.versions[0].sha}`)).status, 200);
    const r = await hub.post(`memory/${nid}/restore`, { sha: h.json.versions[1].sha });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /原生/);
    assert.match(await entryText(hub, nid), /native body second/, '没被改动');
  });

  it('已作废、已被取代的条目：历史能看，恢复被拒', async () => {
    const a = await remember(hub, { type: 'fact', title: 'retire me', body: 'one' });
    await call(hub, 'build-server', 'memory_update', { id: a, body: 'two' });
    const old = (await hub.get(`memory/${a}/history`)).json.versions[1].sha;
    assert.ok(!(await call(hub, 'build-server', 'memory_retire', { id: a, reason: '过时' })).isError);
    const h = await hub.get(`memory/${a}/history`);
    assert.equal(h.json.restorable, false);
    assert.match(h.json.reason, /作废/);
    assert.equal(h.json.versions[0].action, '作废');
    const r = await hub.post(`memory/${a}/restore`, { sha: old });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /作废/);

    const s1 = await remember(hub, { type: 'status', title: 'status v1', body: 'one', subject: 'demo/x' });
    const s2 = await remember(hub, { type: 'status', title: 'status v2', body: 'two', subject: 'demo/x' });
    assert.ok(s2);
    const sh = await hub.get(`memory/${s1}/history`);
    assert.equal(sh.json.restorable, false);
    assert.match(sh.json.reason, /取代/);
    assert.equal(sh.json.versions[0].action, '被新条目取代');
    assert.equal((await hub.post(`memory/${s1}/restore`, { sha: sh.json.versions[1].sha })).status, 400);
  });

  it('旧版本里含密钥：恢复被拒，条目不变', async () => {
    const id = await remember(hub, { type: 'fact', title: 'clean entry', body: 'clean v1' });
    const repo = hub.path('repo');
    const file = path.join(repo, 'entries', `${id}.md`);
    fs.appendFileSync(file, '\npassword: hunter2hunter2\n');
    const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
    git('add', '-A');
    git('commit', '-q', '-m', 'manual: leak', '--author=tester <tester@example.com>');
    await call(hub, 'build-server', 'memory_update', { id, body: 'clean v2' });
    const h = (await hub.get(`memory/${id}/history`)).json;
    assert.equal(h.total, 3);
    const leaky = h.versions[1];
    assert.equal(leaky.action, '其他');
    const r = await hub.post(`memory/${id}/restore`, { sha: leaky.sha });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /拒收/);
    assert.match(await entryText(hub, id), /clean v2/);
    assert.equal((await hub.get(`memory/${id}/history`)).json.total, 3, '没有新版本');
    const rej = fs.readFileSync(hub.path('state/rejections.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(rej.some((x) => x.where === `update:${id}` && x.client === 'console'));
  });

  it('只读的浏览设备不能恢复，但能看历史', async () => {
    const id = await remember(hub, { type: 'fact', title: 'ro entry', body: 'one' });
    await call(hub, 'build-server', 'memory_update', { id, body: 'two' });
    const v1 = (await hub.get(`memory/${id}/history`)).json.versions[1].sha;
    assert.equal((await hub.post('devices/my-laptop', { readonly: true })).status, 200);
    assert.equal((await hub.get(`memory/${id}/history`)).status, 200);
    const r = await hub.post(`memory/${id}/restore`, { sha: v1 });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /只读/);
    assert.equal((await hub.post('devices/my-laptop', { readonly: false })).status, 200);
    assert.equal((await hub.post(`memory/${id}/restore`, { sha: v1 })).status, 200);
  });
});

describe('修改历史：按浏览者的 hide_projects 过滤', () => {
  let hub;
  before(async () => { hub = await startHub({ tokens: TOKENS, peers: ['my-laptop'] }); });
  after(() => hub.stop());

  it('看不见的项目：历史、差异、恢复都当它不存在', async () => {
    const secret = await remember(hub, { type: 'fact', title: 'secret one', body: 'a', project: 'secret-proj' });
    await call(hub, 'build-server', 'memory_update', { id: secret, body: 'b' });
    const open = await remember(hub, { type: 'fact', title: 'open one', body: 'a', project: 'open-proj' });
    await call(hub, 'build-server', 'memory_update', { id: open, body: 'b' });
    const secretSha = (await hub.get(`memory/${secret}/history`)).json.versions[1].sha;
    assert.equal((await hub.post('devices/my-laptop', { hide_projects: ['secret-proj'] })).status, 200);
    assert.equal((await hub.get(`memory/${secret}/history`)).status, 404);
    assert.equal((await hub.get(`memory/${secret}/history/${secretSha}`)).status, 404);
    assert.equal((await hub.post(`memory/${secret}/restore`, { sha: secretSha })).status, 404);
    assert.equal((await hub.get(`memory/${open}/history`)).status, 200);
  });

  it('条目现在可见，但某个旧版本属于被隐藏的项目：那一版不给差异、不给恢复', async () => {
    assert.equal((await hub.post('devices/my-laptop', { hide_projects: [] })).status, 200);
    const id = await remember(hub, { type: 'fact', title: 'moved one', body: 'a', project: 'secret-proj' });
    await call(hub, 'build-server', 'memory_update', { id, project: 'open-proj', body: 'b' });
    await call(hub, 'build-server', 'memory_update', { id, body: 'c' });
    const v = (await hub.get(`memory/${id}/history`)).json.versions; // [改正文, 改项目, 创建]
    assert.equal((await hub.post('devices/my-laptop', { hide_projects: ['secret-proj'] })).status, 200);
    assert.equal((await hub.get(`memory/${id}/history`)).status, 200);
    assert.equal((await hub.get(`memory/${id}/history/${v[0].sha}`)).status, 200);
    assert.equal((await hub.get(`memory/${id}/history/${v[1].sha}`)).status, 404, '上一版在隐藏项目里');
    assert.equal((await hub.get(`memory/${id}/history/${v[2].sha}`)).status, 404);
    assert.equal((await hub.post(`memory/${id}/restore`, { sha: v[2].sha })).status, 404);
    assert.match(await entryText(hub, id), /project: open-proj/);
  });
});
