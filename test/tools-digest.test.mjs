// 记忆工具之三：摘要页（预览、预算、置顶/排除、没信息量和重复的标记）。运行：node --test test/
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startHub, TOKENS } from './helpers.mjs';
import { vagueReason, dupGroups } from '../hub/admin-tools.mjs';

const TOK = { ...TOKENS, 'journal-bot': { token: 'tok-journal-secret-value', role: 'extractor' } };
const mk = async (hub, type, title, extra = {}) => {
  const r = await hub.device('my-laptop', '/v1/remember?client=claude-code', { type, title, body: extra.body || `${title} 的正文`, ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.id;
};
const bytes = (s) => Buffer.byteLength(s);
const usage = (hub) => fs.readFileSync(hub.path('state/usage.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const v1Digest = async (hub, device, tool) => (await hub.web('GET', `/v1/digest?tool=${tool}`, undefined, { authorization: `Bearer ${hub.tokenOf[device]}` })).text;
const mcpDigest = async (hub, device, client) => {
  const res = await fetch(`${hub.base}/mcp?client=${client}`, {
    method: 'POST', headers: { authorization: `Bearer ${hub.tokenOf[device]}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_digest', arguments: {} } }),
  });
  return (await res.json()).result.content[0].text;
};
const heartbeat = (hub, device, wiring) => hub.device(device, '/v1/heartbeat', { agent_version: '0.9.3', hostname: `${device}-host`, wiring });
const lines = (text) => text.split('\n').filter((l) => l.startsWith('- '));

describe('摘要标记：没信息量', () => {
  it('过于泛的标题', () => {
    for (const t of ['Memory Block', 'Notes', '基础设施', '设备台账', '代码生成纪律', '服务状态', '待处理', '关键报错', '机器', '日常', 'Project Notes', 'General Info', 'TODO', 'Docker', '坑', '备忘录', 'misc settings', '']) {
      assert.ok(vagueReason(t, '正文'), `应判为没信息量：${t}`);
    }
    assert.equal(vagueReason('Memory Block'), 'generic');
    assert.equal(vagueReason('基础设施'), 'generic');
    assert.equal(vagueReason('代码生成纪律'), 'label');
    assert.equal(vagueReason('Docker'), 'short');
    assert.equal(vagueReason('坑'), 'short');
  });

  it('标题和正文对不上（标题短、正文长、一个字都对不上）', () => {
    const body = '部署流水线先在预发跑一遍冒烟，再放量到线上；任何一步失败都要回滚并通知值班同学，回滚之后要补一份复盘写清原因和后续动作。';
    assert.equal(vagueReason('回家路线', body), 'unrelated');
    assert.equal(vagueReason('部署流水线要点', body), null, '标题的字在正文里出现过');
    assert.equal(vagueReason('回家路线', '短正文'), null, '正文太短不判');
  });

  it('正常的标题不误伤', () => {
    for (const t of [
      '回复统一用中文', '发布前必须先在预发验收', '客户界面只保留防止误用所必需的说明，避免次要标签和重复描述', 'Windows 上 docx 生成与目检',
      '禁用代理', '部署到生产要先备份数据库', 'shop-api 2.4.1 发布与线上升级', '个人知识库（home）', 'build-server 物理机 11-10', '回滚前先停写',
      '改鉴权中间件时不能放宽现有断言', '周报用固定模板，按项目分段', 'Use dry-run before deleting backups', '登录页验收用真实账号走一遍',
      '代码交付必须可供他人审查', '课件第一版就要做足图表和案例', '接口超时按 30 秒处理', '测试库每晚重建', '前端不引入构建工具',
    ]) {
      assert.equal(vagueReason(t, `${t} 的详细说明，写了很长很长的一段文字用来凑够字数。`), null, `不该判：${t}`);
    }
  });
});

describe('摘要标记：重复', () => {
  const g = (...titles) => dupGroups(titles.map((title, i) => ({ id: `e${i}`, title, cls: 0 })));

  it('标题近似的归一组；归一化后相同的也归一组', () => {
    assert.deepEqual(g('学生作业类材料要用学生口吻，避免明显 AI 感', '学生课程作业要用学生口吻，避免明显的 AI 叙述'), [['e0', 'e1']]);
    assert.deepEqual(g('上线验收必须用现网真实账号的角色走一遍', '上线验收要用现网真实账号', '数据库每晚备份'), [['e0', 'e1']]);
    assert.deepEqual(g('Release Checklist', '这条不相干的标题放在中间', 'release  checklist!'), [['e0', 'e2']]);
    assert.deepEqual(g('Notes', 'notes'), [['e0', 'e1']], '短标题只认完全相同');
    assert.deepEqual(g('电商订单平台 M1 11-08', '电商订单平台 11-09', '电商订单平台 F1 11-11', '另一件完全不同的事情要记一下'), [['e0', 'e1', 'e2']]);
  });

  it('句式一样、只是中间不同的一批不算；日期版本号不算；不同项目的不算', () => {
    const templated = ['修复登录页白屏', '增加导出功能', '支持批量删除', '优化列表加载速度', '接入新的告警渠道', '补全接口文档'].map((x) => `mobile-app：${x}，先灰度 10% 再全量`);
    assert.deepEqual(g(...templated), []);
    assert.deepEqual(g('发布说明汇总 1.0 版', '发布说明汇总 2.0 版'), [['e0', 'e1']], '只差版本号的算近似');
    const withProject = (...rows) => dupGroups(rows.map(([title, project], i) => ({ id: `e${i}`, title, cls: 0, project })));
    assert.deepEqual(withProject(['灰度放量进度：已全量', 'shop-api'], ['灰度放量进度：已全量', 'mobile-app']), [], '项目不同的不归');
    assert.deepEqual(withProject(['灰度放量进度：已全量', 'shop-api'], ['灰度放量进度：已全量', '']), [['e0', 'e1']], '没写项目的可能和谁都重复');
    assert.deepEqual(withProject(['值班注意事项', 'infra'], ['值班注意事项', 'infra']), [['e0', 'e1']]);
    assert.deepEqual(g('mobile-app 值班注意事项', 'docs-site 值班注意事项'), [], '标题里的项目名不同');
    assert.deepEqual(g('shop-api：支付回调重复触发导致重复入账', '支付回调重复触发导致重复入账（shop-api）'), [['e0', 'e1']], '同一个项目名换了位置');
  });

  it('不同的标题、短标题近似、不同类的都不归', () => {
    assert.deepEqual(g('客户界面只保留防止误用所必需的说明', '页面上不放没有信息量的标签'), []);
    assert.deepEqual(g('发布流程', '发布回滚'), [], '太短只认完全相同');
    assert.deepEqual(dupGroups([{ id: 'a', title: '部署到生产要先备份数据库再动手', cls: 0 }, { id: 'b', title: '部署到生产要先备份数据库再动手', cls: 1 }]), []);
    assert.deepEqual(g('', ''), [], '空标题不算');
  });
});

describe('摘要页：预览、预算、规则', () => {
  let hub; let ids;
  before(async () => {
    hub = await startHub({ tokens: TOK, peers: ['my-laptop'], config: { digest_budget: 2600, device_labels: { 'my-laptop': '笔记本' } } });
    await heartbeat(hub, 'my-laptop', { 'claude-code': { mcp: 'on' } });
    await heartbeat(hub, 'build-server', { codex: { mcp: 'on' } });
    ids = { pref: [], ref: [], dec: [] };
    for (let i = 0; i < 40; i++) ids.pref.push(await mk(hub, i % 2 ? 'feedback' : 'preference', `偏好条目第 ${String(i).padStart(2, '0')} 号：请按约定处理这类事情并保持一致`));
    for (let i = 0; i < 4; i++) ids.dec.push(await mk(hub, 'decision', `决定条目第 ${i} 号：采用灰度发布并保留一周回滚窗口`, { project: 'shop-api' }));
    for (let i = 0; i < 6; i++) ids.ref.push(await mk(hub, i % 2 ? 'fact' : 'reference', `参考条目第 ${i} 号：监控面板地址与值班手册的位置，以及各环境入口链接和值班联系方式`));
  });
  after(() => hub.stop());

  const view = async (q = 'device=my-laptop&tool=claude-code') => { const r = await hub.get(`digest?${q}`); assert.equal(r.status, 200, r.text); return r.json; };
  const rule = (id, action) => hub.post('digest/rule', { id, action });

  it('预览的就是设备启动时实际拿到的摘要（和 /v1/digest、MCP memory_digest 逐字一致）', async () => {
    const d = await view();
    assert.equal(d.device, 'my-laptop');
    assert.equal(d.tool, 'claude-code');
    assert.ok(d.text.startsWith('# 共享记忆摘要'));
    assert.equal(d.text, await v1Digest(hub, 'my-laptop', 'claude-code'));
    assert.equal(d.text, await mcpDigest(hub, 'my-laptop', 'claude-code'));
    // 不带参数：默认是浏览者自己那台、它的 claude-code
    assert.equal((await view('')).text, d.text);
    assert.deepEqual(d.options.devices.map((x) => x.name).sort(), ['build-server', 'my-laptop']);
    const mine = d.options.devices.find((x) => x.name === 'my-laptop');
    assert.equal(mine.label, '笔记本');
    assert.ok(mine.tools.includes('claude-code'));
    assert.deepEqual(d.options.devices.find((x) => x.name === 'build-server').tools, ['codex']);
    assert.equal(fs.existsSync(hub.path('state/digest-rules.json')), false, '没设过规则就没有规则文件');
  });

  it('预算：用了多少、多少条没列出，逐条状态和摘要里的行对得上', async () => {
    const d = await view();
    assert.equal(d.budget.limit, 2600);
    assert.equal(d.budget.used, bytes(d.text));
    assert.ok(d.budget.used <= d.budget.limit + 80, '只有末尾的"没列出"提示可以超出预算');
    assert.ok(d.omitted > 0);
    assert.ok(d.text.includes(`…还有 ${d.omitted} 条没列出`));
    assert.equal(d.counts.omitted, d.omitted);
    assert.equal(d.counts.active, 50);
    assert.equal(d.counts.listed, lines(d.text).length);
    assert.equal(d.counts.unlisted, d.counts.active - d.counts.listed);
    assert.equal(d.items.length, 50);
    assert.equal(d.items.filter((x) => x.listed).length, d.counts.listed);
    for (const it of d.items) {
      assert.deepEqual(Object.keys(it).filter((k) => ['id', 'title', 'type', 'project', 'flags', 'pinned', 'excluded', 'listed'].includes(k)).sort(), ['excluded', 'flags', 'id', 'listed', 'pinned', 'project', 'title', 'type']);
      assert.equal(it.listed, d.text.includes(`- ${it.title}`) || d.text.includes(`] ${it.title}`), it.title);
    }
    // 偏好那一节吃光了预算：后面的参考条目一条都没列出
    assert.ok(d.items.filter((x) => x.section === 3).every((x) => !x.listed));
    assert.equal(d.titles.length, 4);
  });

  it('本机这个工具自己的原生记忆不算：按所选设备和智能体算', async () => {
    const content = '---\nname: native-note\ndescription: 工具自己记的一条\nmetadata:\n  type: user\n---\n正文';
    assert.equal((await hub.device('build-server', '/v1/native/sync?client=codex', { tool: 'codex', files: [{ key: 'n.md', content }], present: ['n.md'] })).status, 200);
    const own = await view('device=build-server&tool=codex');
    const other = await view('device=my-laptop&tool=claude-code');
    assert.ok(!own.items.some((x) => x.title === '工具自己记的一条'));
    assert.ok(other.items.some((x) => x.title === '工具自己记的一条'));
    assert.equal(own.text, await v1Digest(hub, 'build-server', 'codex'));
  });

  it('置顶：排在本节最前、优先占预算（即使前面的普通条目已经把预算吃光）', async () => {
    const t0 = (await view()).text;
    const target = ids.ref[2];
    assert.equal((await view()).items.find((x) => x.id === target).listed, false);
    const r = await rule(target, 'pin');
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.json.pinned, r.json.excluded, r.json.pin_count], [true, false, 1]);
    assert.deepEqual(hub.read('state/digest-rules.json'), { pin: [target], exclude: [] });
    const d = await view();
    const it = d.items.find((x) => x.id === target);
    assert.ok(it.pinned && it.listed);
    assert.ok(d.budget.used <= d.budget.limit + 80);
    const sec = d.text.slice(d.text.indexOf('## 参考与事实'));
    assert.ok(sec.split('\n')[1].includes(it.title), '置顶的排在这一节第一行');
    assert.equal(d.items.filter((x) => x.section === 3)[0].id, target, '清单里也排最前');
    // 所有读摘要的路径都认
    assert.equal(d.text, await v1Digest(hub, 'my-laptop', 'claude-code'));
    assert.equal(d.text, await mcpDigest(hub, 'my-laptop', 'claude-code'));
    assert.ok((await view('device=build-server&tool=codex')).items.find((x) => x.id === target).listed, '规则对所有设备生效');
    assert.notEqual(d.text, t0);
    // 取消后和从前逐字一致
    assert.equal((await rule(target, 'unpin')).status, 200);
    assert.equal((await view()).text, t0);
    assert.deepEqual(hub.read('state/digest-rules.json'), { pin: [], exclude: [] });
  });

  it('排除：不出现，空出来的位置给后面的；恢复后逐字一致；置顶和排除互斥', async () => {
    const t0 = (await view()).text;
    const d0 = await view();
    const victim = d0.items.find((x) => x.listed && x.section === 0);
    const r = await rule(victim.id, 'exclude');
    assert.deepEqual([r.json.pinned, r.json.excluded], [false, true]);
    const d = await view();
    const it = d.items.find((x) => x.id === victim.id);
    assert.ok(it.excluded && !it.listed);
    assert.ok(!d.text.includes(`- ${victim.title}\n`));
    assert.equal(d.text, await v1Digest(hub, 'my-laptop', 'claude-code'));
    assert.equal(d.text, await mcpDigest(hub, 'my-laptop', 'claude-code'));
    assert.equal(d.counts.excluded, 1);
    assert.equal(d.counts.active, d0.counts.active, '被排除的仍在清单里，才能点回来');
    // 置顶它 = 不再排除
    const p = await rule(victim.id, 'pin');
    assert.deepEqual([p.json.pinned, p.json.excluded], [true, false]);
    assert.deepEqual(hub.read('state/digest-rules.json'), { pin: [victim.id], exclude: [] });
    assert.equal((await rule(victim.id, 'exclude')).json.pinned, false);
    assert.equal((await rule(victim.id, 'include')).status, 200);
    assert.deepEqual(hub.read('state/digest-rules.json'), { pin: [], exclude: [] });
    assert.equal((await view()).text, t0);
  });

  it('置顶不受年龄窗口限制（过了 14 天的决定也能进摘要）', async () => {
    const old = ids.dec[0];
    const file = path.join(hub.path('repo'), 'entries', `${old}.md`);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^updated: ".*"$/m, 'updated: "2026-01-01T00:00:00.000Z"'));
    await hub.restart();
    let d = await view();
    assert.ok(!d.items.find((x) => x.id === old).listed, '过了窗口，普通情况不列');
    assert.equal((await rule(old, 'pin')).status, 200);
    d = await view();
    assert.ok(d.items.find((x) => x.id === old).listed);
    assert.ok(d.text.includes('决定条目第 0 号'));
    await rule(old, 'unpin');
  });

  it('置顶最多 50 条', async () => {
    const extra = [];
    for (let i = 0; i < 12; i++) extra.push(await mk(hub, 'fact', `额外事实第 ${i} 号：占位用的一条记忆内容`));
    const pool = [...ids.pref, ...ids.ref, ...extra];
    let n = 0;
    for (const id of pool) {
      if (n === 50) break;
      assert.equal((await rule(id, 'pin')).status, 200);
      n++;
    }
    const r = await rule(pool[50], 'pin');
    assert.equal(r.status, 400);
    assert.match(r.json.error, /最多置顶 50/);
    for (const id of pool.slice(0, 50)) await rule(id, 'unpin');
    assert.deepEqual(hub.read('state/digest-rules.json'), { pin: [], exclude: [] });
  });

  it('输入校验与审计', async () => {
    assert.equal((await rule('m-20260101-aaaaaa', 'pin')).status, 404);
    assert.equal((await rule('../x', 'pin')).status, 400);
    assert.equal((await rule(ids.pref[0], 'stick')).status, 400);
    assert.equal((await hub.post('digest/rule', { action: 'pin' })).status, 400);
    assert.equal((await hub.post('digest/rule', [])).status, 400);
    assert.equal((await hub.get('digest/rule')).status, 405);
    assert.equal((await hub.post('digest', {})).status, 405);
    // 作废的条目不能置顶/排除，但能"取消"
    const gone = await mk(hub, 'fact', '马上要作废的一条记忆内容');
    assert.ok(!(await hub.rpc('build-server', 'tools/call', { name: 'memory_retire', arguments: { id: gone, reason: '过时' } })).isError);
    const stale = await rule(ids.pref[1], 'pin');
    assert.equal(stale.status, 200);
    assert.ok(!(await hub.rpc('build-server', 'tools/call', { name: 'memory_retire', arguments: { id: ids.pref[1], reason: '过时' } })).isError);
    assert.equal((await rule(ids.pref[2], 'pin')).status, 200);
    assert.deepEqual(hub.read('state/digest-rules.json'), { pin: [ids.pref[2]], exclude: [] }, '已作废的条目自动从规则里清掉');
    await rule(ids.pref[2], 'unpin');
    const bad = await rule(gone, 'pin');
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /只有有效的/);
    assert.equal((await rule(gone, 'exclude')).status, 400);
    assert.equal((await rule(gone, 'unpin')).status, 200);
    const rows = usage(hub).filter((u) => u.op === 'console:digest-rule');
    assert.ok(rows.length >= 6);
    assert.ok(rows.every((u) => u.device === 'my-laptop'));
    assert.ok(rows.some((u) => /^pin m-/.test(u.d)) && rows.some((u) => /^exclude [mn]-/.test(u.d)));
  });

  it('设备或智能体不存在 400；没有网关身份 403', async () => {
    for (const q of ['device=nope', 'device=my-laptop&tool=nope', 'device=build-server&tool=claude-code', 'device=my-laptop&tool=a%20b', 'device=journal-bot', 'device=..%2Fx']) {
      const r = await hub.get(`digest?${q}`);
      assert.equal(r.status, 400, q);
      assert.ok(r.json.error);
    }
    assert.equal((await hub.api('GET', 'digest', undefined, {})).status, 403);
    assert.equal((await hub.api('POST', 'digest/rule', { id: ids.pref[0], action: 'pin' }, {})).status, 403);
  });

  it('只读设备不能改规则，但能预览', async () => {
    assert.equal((await hub.post('devices/my-laptop', { readonly: true })).status, 200);
    assert.equal((await hub.get('digest')).status, 200);
    const r = await rule(ids.pref[0], 'pin');
    assert.equal(r.status, 403);
    assert.match(r.json.error, /只读/);
    assert.equal((await hub.post('devices/my-laptop', { readonly: false })).status, 200);
  });
});

describe('摘要页：标记', () => {
  let hub;
  before(async () => {
    hub = await startHub({ tokens: TOK, peers: ['my-laptop'] });
    await heartbeat(hub, 'my-laptop', { 'claude-code': { mcp: 'on' } });
  });
  after(() => hub.stop());

  it('没信息量的和重复的都被标出来，正常条目不带标记', async () => {
    const vague = ['Memory Block', 'Notes', '基础设施', '设备台账', '代码生成纪律'];
    const normal = ['回复统一用中文', '发布前必须先在预发验收', '禁用代理', 'shop-api 2.4.1 发布与线上升级', '部署到生产要先备份数据库'];
    const dupA = ['学生作业类材料要用学生口吻，避免明显 AI 感', '学生课程作业要用学生口吻，避免明显的 AI 叙述'];
    const dupB = ['上线验收必须用现网真实账号的角色走一遍', '上线验收要用现网真实账号'];
    const by = {};
    for (const t of vague) by[t] = await mk(hub, 'preference', t, { body: '一些正文，说明这条到底记了什么内容。' });
    for (const t of normal) by[t] = await mk(hub, 'preference', t);
    for (const t of dupA) by[t] = await mk(hub, 'preference', t);
    for (const t of dupB) by[t] = await mk(hub, 'feedback', t); // 偏好和反馈同在摘要的第一节，算同一类
    const same = await mk(hub, 'status', dupA[0], { subject: 'x/y' }); // 不同节，不算重复
    const d = (await hub.get('digest')).json;
    const item = (id) => d.items.find((x) => x.id === id);
    for (const t of vague) assert.deepEqual(item(by[t]).flags, ['vague'], t);
    assert.equal(item(by['Memory Block']).vague_why, 'generic');
    assert.equal(item(by['代码生成纪律']).vague_why, 'label');
    for (const t of normal) assert.deepEqual(item(by[t]).flags, [], t);
    const ga = item(by[dupA[0]]).dup;
    assert.ok(ga);
    assert.equal(item(by[dupA[1]]).dup, ga);
    assert.deepEqual(item(by[dupA[0]]).flags, ['dup']);
    const gb = item(by[dupB[0]]).dup;
    assert.ok(gb && gb !== ga);
    assert.equal(item(by[dupB[1]]).dup, gb);
    assert.deepEqual(item(same).flags, []);
    assert.equal(d.counts.vague, 5);
    assert.equal(d.counts.dup_groups, 2);
    assert.equal(d.counts.dup_items, 4);
    // 排除掉一条之后，剩下那条不再算重复
    assert.equal((await hub.post('digest/rule', { id: by[dupA[1]], action: 'exclude' })).status, 200);
    const d2 = (await hub.get('digest')).json;
    assert.deepEqual(d2.items.find((x) => x.id === by[dupA[0]]).flags, []);
    assert.equal(d2.counts.dup_groups, 1);
    assert.deepEqual(d2.items.find((x) => x.id === by[dupA[1]]).flags, [], '被排除的不参与重复判定');
  });
});

describe('摘要页：按浏览者的 hide_projects 过滤', () => {
  let hub; let secretId;
  before(async () => {
    hub = await startHub({ tokens: TOK, peers: ['my-laptop'] });
    await heartbeat(hub, 'my-laptop', { 'claude-code': { mcp: 'on' } });
    secretId = await mk(hub, 'decision', '秘密项目的决定：只在内网发布', { project: 'secret-proj' });
    await mk(hub, 'decision', '公开项目的决定：照常灰度发布', { project: 'open-proj' });
    const t = new Date().toISOString();
    for (const [sid, project] of [['s1', 'secret-proj'], ['s2', 'open-proj']]) {
      await hub.device('my-laptop', '/v1/conv/append', { tool: 'codex', session_id: sid, title: sid, cwd: '/work/demo', started: t, base: 0, messages: [{ role: 'user', text: `问题 ${sid}`, ts: t }, { role: 'assistant', text: `回答 ${sid}`, ts: t }] });
      const key = `my-laptop__codex__${sid}`;
      const date = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
      await hub.device('journal-bot', '/v1/journal/result', { items: [{ key, date, project, summary: `${project}-摘要`, n: 2 }] });
    }
  });
  after(() => hub.stop());

  it('隐藏的项目：清单、预览文本、最近 3 天的段落里都不出现，也不能改它的规则', async () => {
    const all = (await hub.get('digest')).json;
    assert.ok(all.items.some((x) => x.project === 'secret-proj'));
    assert.ok(all.text.includes('秘密项目的决定'));
    assert.ok(all.text.includes('secret-proj-摘要') && all.text.includes('open-proj-摘要'));

    assert.equal((await hub.post('devices/my-laptop', { hide_projects: ['secret-proj'] })).status, 200);
    const d = (await hub.get('digest')).json;
    assert.ok(!d.items.some((x) => x.project === 'secret-proj'));
    assert.ok(d.items.some((x) => x.project === 'open-proj'));
    assert.ok(!d.text.includes('秘密项目的决定'));
    assert.ok(!d.text.includes('secret-proj'));
    assert.ok(d.text.includes('公开项目的决定') && d.text.includes('open-proj-摘要'));
    assert.equal((await hub.post('digest/rule', { id: secretId, action: 'pin' })).status, 404);
    assert.equal((await hub.post('devices/my-laptop', { hide_projects: [] })).status, 200);
  });
});
