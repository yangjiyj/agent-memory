// 只读分享链接：/console/api/shares 生成、列出、作废，公开页 /s/<令牌>。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startHub, sha256, GATE } from './helpers.mjs';
import { seed, AS, HIDDEN, VISIBLE, TOKENS, PEERS } from './access-fixture.mjs';

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const DAY = 86400e3;

describe('只读分享链接', () => {
  let hub; let S; let timeline; let handoff;
  const api = (who, method, route, body) => hub.web(method, `/console/api/${route}`, body, AS(who));
  const create = (who, body) => api(who, 'POST', 'shares', body);
  const pub = (token, headers = {}, method = 'GET') => hub.web(method, `/s/${token}`, undefined, headers);
  const fromIp = (ip) => ({ 'x-am-gate': GATE, 'x-am-peer-ip': ip });
  const sharesFile = () => JSON.parse(fs.readFileSync(hub.path('state/shares.json'), 'utf8'));
  const tokenOf = (r) => r.json.token;

  before(async () => {
    hub = await startHub({ tokens: TOKENS, peers: PEERS, config: { device_labels: { 'my-laptop': '笔记本' } } });
    S = await seed(hub);
    assert.ok((await hub.rpc('my-laptop', 'tools/call', { name: 'memory_remember', arguments: { type: 'fact', title: 'solo-title', body: 'solo-body', project: 'solo-proj' } })).content[0].text.includes('已写入'));
  });
  after(() => hub.stop());

  it('没有网关身份不能管理链接（403）；方法不对 405', async () => {
    assert.equal((await hub.web('POST', '/console/api/shares', { project: VISIBLE, kind: 'timeline', days: 7 }, {})).status, 403);
    assert.equal((await hub.web('GET', '/console/api/shares', undefined, {})).status, 403);
    assert.equal((await hub.web('POST', '/console/api/shares/revoke', { id: 'aaaaaaaaaaaa' }, {})).status, 403);
    assert.equal((await api('my-laptop', 'PUT', 'shares', {})).status, 405);
    assert.equal((await api('my-laptop', 'GET', 'shares/revoke')).status, 405);
  });

  it('参数校验：有效期只能 1、7、30，别的和不传都是 400（中文 error），项目不存在 404', async () => {
    const ok = { project: VISIBLE, kind: 'timeline', days: 7 };
    for (const days of [undefined, 0, 2, 3, 14, 31, 90, -1, 7.5, '7', null, [7]]) {
      const r = await create('my-laptop', { ...ok, days });
      assert.equal(r.status, 400, `days=${JSON.stringify(days)}`);
      assert.match(r.json.error, /有效期/);
    }
    for (const kind of [undefined, 'conversation', 'TIMELINE', 1, '']) assert.equal((await create('my-laptop', { ...ok, kind })).status, 400, `kind=${kind}`);
    for (const project of [undefined, '', '   ', 5, 'x'.repeat(61)]) assert.equal((await create('my-laptop', { ...ok, project })).status, 400, `project=${project}`);
    assert.equal((await create('my-laptop', [])).status, 400);
    const nope = await create('my-laptop', { ...ok, project: 'no-such-project' });
    assert.equal(nope.status, 404);
    assert.ok(!nope.text.includes('no-such-project'));
    assert.deepEqual(JSON.parse(fs.existsSync(hub.path('state/shares.json')) ? fs.readFileSync(hub.path('state/shares.json'), 'utf8') : '[]'), [], '校验失败不留记录');
  });

  it('生成：令牌 43 字符 base64url，响应里有完整链接和令牌；盘上只有哈希', async () => {
    const t0 = Date.now();
    const r = await create('my-laptop', { project: VISIBLE.toUpperCase(), kind: 'timeline', days: 7 });
    assert.equal(r.status, 200, r.text);
    timeline = r.json;
    assert.match(timeline.token, TOKEN_RE);
    assert.equal(timeline.url, `${hub.base.replace('127.0.0.1', 'hub.example')}/s/${timeline.token}`);
    assert.equal(timeline.project, VISIBLE, '项目名取库里的写法');
    assert.equal(timeline.kind, 'timeline');
    assert.equal(timeline.creator, 'my-laptop');
    assert.equal(timeline.status, 'active');
    assert.match(timeline.id, /^[0-9a-f]{12}$/);
    assert.ok(Math.abs(Date.parse(timeline.expires) - Date.parse(timeline.created) - 7 * DAY) < 1000);
    assert.ok(Math.abs(Date.parse(timeline.created) - t0) < 5000);
    const h = await create('my-laptop', { project: VISIBLE, kind: 'handoff', days: 30 });
    assert.equal(h.status, 200);
    handoff = h.json;
    assert.notEqual(handoff.token, timeline.token);
    assert.ok(Math.abs(Date.parse(handoff.expires) - Date.parse(handoff.created) - 30 * DAY) < 1000);
    for (const days of [1]) assert.equal((await create('my-laptop', { project: VISIBLE, kind: 'timeline', days })).status, 200);

    const raw = fs.readFileSync(hub.path('state/shares.json'), 'utf8');
    for (const t of [timeline.token, handoff.token]) assert.ok(!raw.includes(t), '盘上不能有令牌明文');
    const rec = sharesFile().find((x) => x.id === timeline.id);
    assert.deepEqual(Object.keys(rec).sort(), ['created', 'creator', 'expires', 'hash', 'id', 'kind', 'project', 'revoked']);
    assert.equal(rec.hash, sha256(timeline.token));
    assert.equal(rec.revoked, null);
    assert.equal(fs.statSync(hub.path('state/shares.json')).mode & 0o777, 0o600);
  });

  it('列表：只有 id、项目、类型、时间、创建者、状态，没有令牌和哈希；可按项目筛', async () => {
    const r = await api('my-laptop', 'GET', 'shares');
    assert.equal(r.status, 200);
    assert.equal(r.json.shares.length, 3);
    for (const s of r.json.shares) assert.deepEqual(Object.keys(s).sort(), ['created', 'creator', 'expires', 'id', 'kind', 'project', 'status']);
    for (const t of [timeline.token, handoff.token]) assert.ok(!r.text.includes(t));
    assert.ok(!r.text.includes(sha256(timeline.token)));
    assert.equal((await api('my-laptop', 'GET', `shares?project=${VISIBLE.toUpperCase()}`)).json.shares.length, 3);
    assert.equal((await api('my-laptop', 'GET', 'shares?project=solo-proj')).json.shares.length, 0);
  });

  it('公开页：不要身份就能打开；响应头和 meta；自包含、没有控制台链接', async () => {
    for (const [name, link] of [['时间线', timeline], ['交接包', handoff]]) {
      const r = await pub(link.token, {});
      assert.equal(r.status, 200, name);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
      assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
      assert.match(r.headers.get('content-type'), /^text\/html/);
      assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
      assert.match(r.text, /<meta name="robots" content="noindex, nofollow, noarchive">/);
      assert.ok(r.text.includes(`<h1>${VISIBLE}</h1>`));
      assert.ok(!/<script|<link|<img|<iframe|href=|src=|url\(|https?:\/\//i.test(r.text), `${name}：不能有外部资源和链接`);
      assert.ok(!r.text.includes('/console'), `${name}：不能有控制台的任何链接`);
    }
    const viaGate = await pub(timeline.token, AS('my-laptop'));
    assert.equal(viaGate.status, 200, '有身份的请求也一样');
    assert.equal((await pub(timeline.token, {}, 'HEAD')).status, 200);
  });

  it('内容边界：只有项目名、日期、设备显示名、智能体、日志摘要；没有对话原文、会话标题、要点、记忆标题和正文、ref、id、目录', async () => {
    const tl = (await pub(timeline.token)).text;
    const ho = (await pub(handoff.token)).text;
    for (const [name, page] of [['时间线', tl], ['交接包', ho]]) {
      for (const must of ['journal-visible-J2 已上线', 'journal-multi-old-J4']) assert.ok(page.includes(must), `${name} 应有 ${must}`);
      assert.ok(!page.includes('journal-noproj-J3'), '没有项目的日志段不属于这个项目');
      assert.ok(page.includes('笔记本') && page.includes('Claude Code'), `${name}：设备显示名和智能体`);
      assert.ok(!page.includes('my-laptop'), `${name}：只给设备显示名，不给设备名`);
      for (const bad of [
        'MSG-VISIBLE-TWO', 'MSG-NOPROJ-THREE', 'MSG-MULTI-OLD', 'MSG-MULTI-NEW', // 对话原文
        'title-visible-S2', 'title-multi-S5', // 会话标题
        'point-visible-J2', // 日志要点
        'visible-title-V1', 'visible-body-V1', 'visible-status-V2', 'noproj-pref-N1', // 记忆标题和正文
        S.ids.V1, S.ids.V2, S.refs.SV, S.refs.SM, // id 和 ref
        '/home/dev/code', // 会话目录
        HIDDEN, 'journal-hidden-J1', 'journal-multi-new-J5', // 别的项目
      ]) assert.ok(!page.toLowerCase().includes(bad.toLowerCase()), `${name} 不该出现 ${bad}`);
    }
    assert.ok(tl.includes('进行中') && ho.includes('进行中'), '状态用"进行中"');
    assert.ok(ho.includes('还没收尾') && ho.includes('最近 14 天做了什么'));
    assert.ok(!tl.includes('还没收尾'));
  });

  it('没有日志的项目：页面给空状态，不带记忆内容', async () => {
    const r = await create('my-laptop', { project: 'solo-proj', kind: 'handoff', days: 1 });
    assert.equal(r.status, 200);
    const page = (await pub(r.json.token)).text;
    assert.ok(page.includes('这段时间没有工作日志'));
    assert.ok(!page.includes('solo-title') && !page.includes('solo-body'));
  });

  it('无效、过期、作废、格式不对、方法不对：完全相同的 404（状态、响应头、响应体一字不差）', async () => {
    const short = await create('my-laptop', { project: VISIBLE, kind: 'timeline', days: 1 });
    const revoked = await create('my-laptop', { project: VISIBLE, kind: 'timeline', days: 7 });
    assert.equal((await api('my-laptop', 'POST', 'shares/revoke', { id: revoked.json.id })).status, 200);
    const expired = await create('my-laptop', { project: VISIBLE, kind: 'timeline', days: 1 });
    const all = sharesFile();
    all.find((x) => x.id === expired.json.id).expires = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(hub.path('state/shares.json'), JSON.stringify(all));
    const probes = [
      ['随机的合法格式', pub('A'.repeat(43), fromIp('192.0.2.1'))],
      ['随机 base64url', pub('abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE', fromIp('192.0.2.1'))],
      ['太短', pub('abc', fromIp('192.0.2.1'))],
      ['太长', pub('a'.repeat(44), fromIp('192.0.2.1'))],
      ['含非法字符', pub(`${'a'.repeat(42)}!`, fromIp('192.0.2.1'))],
      ['多一段路径', hub.web('GET', `/s/${short.json.token}/extra`, undefined, fromIp('192.0.2.1'))],
      ['没有令牌', hub.web('GET', '/s/', undefined, fromIp('192.0.2.1'))],
      ['已作废', pub(revoked.json.token, fromIp('192.0.2.1'))],
      ['已过期', pub(expired.json.token, fromIp('192.0.2.1'))],
      ['方法不对（令牌是对的）', hub.web('POST', `/s/${short.json.token}`, {}, fromIp('192.0.2.1'))],
      ['令牌被改了一位', pub(`${short.json.token.slice(0, 42)}${short.json.token.endsWith('A') ? 'B' : 'A'}`, fromIp('192.0.2.1'))],
    ];
    const res = [];
    for (const [name, p] of probes) res.push([name, await p]);
    const first = res[0][1];
    assert.equal(first.status, 404);
    for (const [name, r] of res) {
      assert.equal(r.status, 404, name);
      assert.equal(r.text, first.text, `${name} 的响应体和别的 404 不一样`);
      for (const h of ['content-type', 'cache-control', 'x-robots-tag', 'referrer-policy', 'content-security-policy', 'content-length']) assert.equal(r.headers.get(h), first.headers.get(h), `${name} 的 ${h}`);
    }
    assert.equal(first.headers.get('cache-control'), 'no-store');
    assert.equal(first.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
    assert.equal((await pub(short.json.token, fromIp('192.0.2.2'))).status, 200, '对照：没过期没作废的照常');
    const list = (await api('my-laptop', 'GET', 'shares')).json.shares;
    assert.equal(list.find((x) => x.id === revoked.json.id).status, 'revoked');
    assert.equal(list.find((x) => x.id === expired.json.id).status, 'expired');
    assert.equal(list.find((x) => x.id === short.json.id).status, 'active');
    assert.equal((await api('my-laptop', 'POST', 'shares/revoke', { id: expired.json.id })).status, 404, '过期的不用再作废');
  });

  it('作废：立刻失效；再作废、不存在的 id 404，格式不对 400；记审计', async () => {
    const r = await create('my-laptop', { project: VISIBLE, kind: 'handoff', days: 7 });
    assert.equal((await pub(r.json.token, fromIp('192.0.2.3'))).status, 200);
    const rv = await api('my-laptop', 'POST', 'shares/revoke', { id: r.json.id });
    assert.deepEqual(rv.json, { ok: true });
    assert.equal((await pub(r.json.token, fromIp('192.0.2.3'))).status, 404);
    assert.equal(sharesFile().find((x) => x.id === r.json.id).revoked !== null, true);
    assert.equal((await api('my-laptop', 'POST', 'shares/revoke', { id: r.json.id })).status, 404);
    assert.equal((await api('my-laptop', 'POST', 'shares/revoke', { id: 'ffffffffffff' })).status, 404);
    for (const id of [undefined, 5, 'xyz', 'ZZZZZZZZZZZZ', '../etc']) assert.equal((await api('my-laptop', 'POST', 'shares/revoke', { id })).status, 400, `id=${id}`);
  });

  it('审计：生成和作废各记一条（console:share-create / console:share-revoke），不含令牌', async () => {
    const rows = fs.readFileSync(hub.path('state/usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const created = rows.filter((x) => x.op === 'console:share-create');
    const revoked = rows.filter((x) => x.op === 'console:share-revoke');
    assert.ok(created.length >= 6);
    assert.ok(revoked.length >= 2);
    assert.ok(created.every((x) => x.device === 'my-laptop' && x.client === 'console'));
    assert.ok(created[0].d.includes(VISIBLE) && created[0].d.includes('时间线') && created[0].d.includes('7 天'));
    const raw = fs.readFileSync(hub.path('state/usage.jsonl'), 'utf8');
    for (const t of [timeline.token, handoff.token]) assert.ok(!raw.includes(t));
    assert.ok(!raw.includes(sha256(timeline.token)));
  });

  it('重启后链接照常有效（令牌哈希在盘上）', async () => {
    await hub.restart();
    assert.equal((await pub(timeline.token, fromIp('192.0.2.4'))).status, 200);
  });

  it('设了 hide_projects 的创建者：不能给被隐藏的项目建链接（404）；列表和作废也看不到别人建的', async () => {
    assert.equal((await api('my-laptop', 'POST', 'devices/build-server', { hide_projects: ['QX-Hidden-91'] })).status, 200);
    const hid = await create('build-server', { project: HIDDEN, kind: 'timeline', days: 7 });
    assert.equal(hid.status, 404);
    assert.ok(!hid.text.includes(HIDDEN));
    assert.equal((await create('build-server', { project: 'QX-HIDDEN-91', kind: 'handoff', days: 7 })).status, 404, '大小写不敏感');
    const free = await create('my-laptop', { project: HIDDEN, kind: 'timeline', days: 7 });
    assert.equal(free.status, 200, '没设的设备可以');
    const list = await api('build-server', 'GET', 'shares');
    assert.ok(!list.text.toLowerCase().includes(HIDDEN));
    assert.ok(list.json.shares.length > 0, '普通项目的链接照常列');
    assert.equal((await api('build-server', 'POST', 'shares/revoke', { id: free.json.id })).status, 404, '看不到的链接作废不了');
    assert.equal((await pub(free.json.token, fromIp('192.0.2.5'))).status, 200, '链接本身不受影响');
    assert.equal((await api('build-server', 'GET', `shares?project=${HIDDEN}`)).json.shares.length, 0);
  });

  it('链接不会比创建者现在看得到的更多：创建者看不到的会话不出现，项目被隐藏则整条失效', async () => {
    const mine = await create('build-server', { project: VISIBLE, kind: 'timeline', days: 7 });
    assert.equal(mine.status, 200);
    const page = (await pub(mine.json.token, fromIp('192.0.2.6'))).text;
    assert.ok(page.includes('journal-visible-J2'));
    assert.ok(!page.includes('journal-multi-old-J4'), 'SM 会话另一天落在被隐藏项目里，build-server 看不到，链接里也不给');
    const wide = (await pub(timeline.token, fromIp('192.0.2.6'))).text;
    assert.ok(wide.includes('journal-multi-old-J4'), '对照：my-laptop 建的链接有');
    assert.equal((await api('my-laptop', 'POST', 'devices/build-server', { hide_projects: ['QX-Hidden-91', VISIBLE] })).status, 200);
    assert.equal((await pub(mine.json.token, fromIp('192.0.2.6'))).status, 404, '创建者看不到这个项目了');
    assert.equal((await api('my-laptop', 'POST', 'devices/build-server', { hide_projects: ['QX-Hidden-91'] })).status, 200);
    assert.equal((await pub(mine.json.token, fromIp('192.0.2.6'))).status, 200);
  });

  it('限速：每个 IP 每分钟失败 30 次后 429（含对的令牌），别的 IP 不受影响；伪造 X-AM-Peer-IP 没用', async () => {
    const bad = (ip) => pub('B'.repeat(43), fromIp(ip));
    for (let i = 0; i < 30; i++) assert.equal((await bad('203.0.113.7')).status, 404, `第 ${i + 1} 次`);
    const limited = await bad('203.0.113.7');
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '60');
    assert.equal(limited.headers.get('cache-control'), 'no-store');
    assert.equal((await pub(timeline.token, fromIp('203.0.113.7'))).status, 429, '这个 IP 被限了，对的令牌也先等');
    assert.equal((await pub(timeline.token, fromIp('203.0.113.8'))).status, 200, '别的 IP 照常');
    // 没有网关暗号的请求，X-AM-Peer-IP 不可信：按连接的真实地址算（127.0.0.1），不能靠换头绕过限速
    for (let i = 0; i < 40; i++) await pub('C'.repeat(43), { 'x-am-peer-ip': `198.51.100.${i}` });
    assert.equal((await pub('C'.repeat(43), { 'x-am-peer-ip': '198.51.100.200' })).status, 429);
    assert.equal((await pub(timeline.token, fromIp('198.51.100.201'))).status, 200, '对照：带暗号的别的 IP 不受影响');
  });
});
