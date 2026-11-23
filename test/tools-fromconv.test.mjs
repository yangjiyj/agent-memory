// 记忆工具之二：把对话里的一段存成记忆（带出处）。运行：node --test test/
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { startHub, TOKENS } from './helpers.mjs';
import { SOURCE_RE, parseSource, sourceLine } from '../hub/admin-tools.mjs';

const TOK = { ...TOKENS, 'journal-bot': { token: 'tok-journal-secret-value', role: 'extractor' } };
const refOf = (key) => crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const usage = (hub) => fs.readFileSync(hub.path('state/usage.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const rejections = (hub) => fs.readFileSync(hub.path('state/rejections.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const entries = async (hub) => (await hub.web('GET', '/browse/data')).json.entries;

// 上传一个会话（两条消息），可选写一段某个项目的工作日志；返回 { ref, date }
async function session(hub, sid, project) {
  const t = new Date().toISOString();
  const r = await hub.device('my-laptop', '/v1/conv/append', {
    tool: 'codex', session_id: sid, title: `会话 ${sid}`, cwd: '/work/demo', started: t,
    base: 0, messages: [{ role: 'user', text: `问题 ${sid}：怎么回滚`, ts: t }, { role: 'assistant', text: `先停写，再切回上一版镜像 ${sid}`, ts: t }],
  });
  assert.equal(r.json.ok, true, JSON.stringify(r.json));
  const key = `my-laptop__codex__${sid}`;
  const date = today();
  if (project) {
    const j = await hub.device('journal-bot', '/v1/journal/result', { items: [{ key, date, project, summary: `${project} 里讨论了回滚`, n: 2 }] });
    assert.equal(j.status, 200, JSON.stringify(j.json));
  }
  return { ref: refOf(key), date };
}

describe('对话存成记忆', () => {
  let hub; let open; let secret;
  before(async () => {
    hub = await startHub({ tokens: TOK, peers: ['my-laptop'] });
    open = await session(hub, 's-open', 'open-proj');
    secret = await session(hub, 's-secret', 'secret-proj');
  });
  after(() => hub.stop());

  const post = (body) => hub.post('memory/from-conv', { type: 'fact', title: '回滚前先停写', body: '先停写，再切回上一版镜像', project: 'open-proj', ...open, ...body });

  it('成功：走 remember 的写入路径，出处写在正文最后一行，记审计', async () => {
    const r = await post({});
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ok, true);
    assert.deepEqual(r.json.source, open);
    const id = r.json.id;
    assert.match(id, /^m-\d{8}-[0-9a-f]{6}$/);

    const e = (await entries(hub)).find((x) => x.id === id);
    assert.equal(e.type, 'fact');
    assert.equal(e.title, '回滚前先停写');
    assert.equal(e.project, 'open-proj');
    assert.equal(e.origin, 'explicit');
    assert.equal(e.state, 'active');
    assert.equal(e.author, 'my-laptop');
    assert.equal(e.client, 'console');

    const text = (await hub.web('GET', `/browse/entry/${id}`)).text;
    const body = text.slice(text.indexOf('\n---\n') + 5).trim();
    assert.equal(body, `先停写，再切回上一版镜像\n\n出处：对话 ${open.ref} · ${open.date}`);
    assert.deepEqual(parseSource(body), open);
    assert.ok(SOURCE_RE.test(body));
    // 智能体读到的也带出处
    const got = await hub.rpc('my-laptop', 'tools/call', { name: 'memory_get', arguments: { id } });
    assert.match(got.content[0].text, new RegExp(`出处：对话 ${open.ref} · ${open.date}`));

    const rows = usage(hub).filter((u) => u.op === 'console:memory-from-conv');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].device, 'my-laptop');
    assert.match(rows[0].d, new RegExp(`${id} .* ${open.ref} ${open.date}`));
    // 历史里认得出是从对话存的
    const h = (await hub.get(`memory/${id}/history`)).json;
    assert.equal(h.versions[0].action, '对话存成记忆');
    assert.equal(h.versions[0].by, 'my-laptop/console');
  });

  it('没写正文就用标题；现状类要主题键，和 remember 一样', async () => {
    const r = await post({ body: '   ', title: '只有标题' });
    assert.equal(r.status, 200, r.text);
    const text = (await hub.web('GET', `/browse/entry/${r.json.id}`)).text;
    assert.match(text.slice(text.indexOf('\n---\n') + 5), /^只有标题\n\n出处：对话 /);
    const st = await post({ type: 'status', title: '回滚现状' });
    assert.equal(st.status, 400);
    assert.match(st.json.error, /subject/);
    const ok = await post({ type: 'status', title: '回滚现状', subject: 'demo/rollback' });
    assert.equal(ok.status, 200, ok.text);
  });

  it('密钥照常拒收，原因照常返回，不留条目', async () => {
    const before = (await entries(hub)).length;
    const audits = usage(hub).filter((u) => u.op === 'console:memory-from-conv').length;
    for (const body of ['密码是 password: hunter2hunter2', 'secret: abcdefgh12345678']) {
      const r = await post({ body });
      assert.equal(r.status, 400);
      assert.match(r.json.error, /^拒收：内容里有/);
    }
    const r = await post({ title: 'api_key: abcdef123456' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /拒收/);
    assert.equal((await entries(hub)).length, before);
    const rej = rejections(hub).filter((x) => x.client === 'console');
    assert.equal(rej.length, 3);
    assert.ok(rej.every((x) => x.device === 'my-laptop' && x.where.startsWith('remember:')));
    assert.equal(usage(hub).filter((u) => u.op === 'console:memory-from-conv').length, audits, '被拒的不记审计');
  });

  it('长度和类型校验同 remember；出处行占的字数算在正文里', async () => {
    const t = `\n\n${sourceLine(open.ref, open.date)}`.length;
    const fit = await post({ body: 'x'.repeat(8000 - t), title: '刚好放得下' });
    assert.equal(fit.status, 200, fit.text);
    const over = await post({ body: 'x'.repeat(8000 - t + 1) });
    assert.equal(over.status, 400);
    assert.match(over.json.error, new RegExp(`正文太长（最多 ${8000 - t} 字`));
    assert.match((await post({ title: 'x'.repeat(201) })).json.error, /title 太长/);
    assert.match((await post({ title: '  ' })).json.error, /title 不能为空/);
    assert.match((await post({ type: 'nope' })).json.error, /type 必须是/);
    assert.match((await post({ type: undefined })).json.error, /type 必须是/);
    assert.equal((await post({ project: 'p'.repeat(61) })).status, 400);
  });

  it('ref / date 的校验：格式、会话存在、日期是会话有消息的一天', async () => {
    for (const ref of ['', 'XYZ', 'ABCDEF12', 'abcdef123', '../etc', undefined, 5]) assert.equal((await post({ ref })).status, 400, String(ref));
    assert.equal((await post({ ref: 'ffffffff' })).status, 404);
    for (const date of ['', '2026-13-40', '26-11-23', '2026-02-30', undefined, '2026-11-23x']) assert.equal((await post({ date })).status, 400, String(date));
    const r = await post({ date: '2020-01-01' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /没有消息/);
    assert.equal((await hub.post('memory/from-conv', [])).status, 400);
  });

  it('预填：项目取这一天的工作日志', async () => {
    const r = await hub.get(`memory/conv-hint?ref=${open.ref}&date=${open.date}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ref: open.ref, date: open.date, project: 'open-proj', title: '会话 s-open' });
    assert.equal((await hub.get('memory/conv-hint?ref=ffffffff&date=2026-11-23')).status, 404);
    assert.equal((await hub.get('memory/conv-hint?ref=zz&date=2026-11-23')).status, 400);
    assert.equal((await hub.post('memory/conv-hint', {})).status, 405);
  });

  it('没有网关身份 403；只读设备 403', async () => {
    assert.equal((await hub.api('POST', 'memory/from-conv', { type: 'fact', title: 't', ...open }, {})).status, 403);
    assert.equal((await hub.api('GET', `memory/conv-hint?ref=${open.ref}&date=${open.date}`, undefined, {})).status, 403);
    assert.equal((await hub.post('devices/my-laptop', { readonly: true })).status, 200);
    const r = await post({});
    assert.equal(r.status, 403);
    assert.match(r.json.error, /只读/);
    assert.equal((await hub.post('devices/my-laptop', { readonly: false })).status, 200);
  });

  it('浏览者看不见的项目：会话当它不存在', async () => {
    assert.equal((await post({ ...secret })).status, 200, '没隐藏时可以');
    assert.equal((await hub.post('devices/my-laptop', { hide_projects: ['secret-proj'] })).status, 200);
    const r = await post({ ...secret });
    assert.equal(r.status, 404);
    assert.match(r.json.error, /没有这个会话/);
    assert.equal((await hub.get(`memory/conv-hint?ref=${secret.ref}&date=${secret.date}`)).status, 404);
    assert.equal((await post({})).status, 200, '可见的会话照常');
    assert.equal((await hub.post('devices/my-laptop', { hide_projects: [] })).status, 200);
  });
});

describe('对话存成记忆：存档盘没挂上', () => {
  it('503', async () => {
    const hub = await startHub({ tokens: TOK, peers: ['my-laptop'], archive: false });
    try {
      const r = await hub.post('memory/from-conv', { ref: 'abcdef12', date: today(), type: 'fact', title: 't' });
      assert.equal(r.status, 503);
      assert.match(r.json.error, /没挂上/);
    } finally { await hub.stop(); }
  });
});
