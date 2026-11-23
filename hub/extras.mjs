/* 中心 0.8 的附加功能：
 *  - 交接包 handoff：某个项目（或关键词）一段时间内的现状、决定、坑、日志、未收尾的事、相关会话，拼成一份接力提示词
 *  - 待办雷达 todos：日志里最后状态还是"进行中/卡住"的会话；可以标"已收尾/不用管"
 *  - 周报 weekly：上周干了什么、干成的事、悬着的事、停了的项目（GET /v1/weekly，可以用任意定时任务每周推送）
 *  - 记忆管理 manage：重复、过期、待审的条目，网页上改/作废/合并
 *  - 审计 audit：哪个智能体什么时候查了/写了什么
 *  - 知识图谱 graph：项目、机器、客户现场、版本号之间的关系（同一条记忆/日志里一起出现）
 *  - 按意思搜 semantic：调本地向量服务（gateway/am-embed.py），给记忆和日志建向量，问法不同也能搜到
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TZ = 8 * 3600e3;
const localDay = (iso) => new Date(Date.parse(iso) + TZ).toISOString().slice(0, 10);
const short = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const TOOL_LABEL = { 'claude-code': 'Claude Code', codex: 'Codex', workbuddy: 'WorkBuddy', 'workbuddy-ai': 'WorkBuddy AI', codebuddy: 'CodeBuddy', hermes: 'Hermes', openclaw: 'OpenClaw', opencode: 'OpenCode', gemini: 'Gemini', qwen: 'Qwen' };
const tl = (t) => TOOL_LABEL[t] || t;

// 二元组相似度（查重用；中英文都行）
function grams(s) {
  const t = String(s || '').toLowerCase().replace(/[\s\p{P}]+/gu, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
}

export function createExtras(ctx) {
  const { CFG, store, conv, nowIso, readJSON, appendJsonl, serial, writeEntry, commit, byUpdated, ageDays, TYPE_LABEL, UserError, readJsonl, usageFile, findSecret, redactSecrets } = ctx;
  const radarFile = path.join(CFG.state, 'radar.json');
  const active = () => [...store.values()].filter((e) => e.meta.state === 'active');
  const refMap = () => new Map(Object.keys(conv.index()).map((k) => [conv.refOf(k), k]));
  const sameProj = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

  // ---------------------------------------------------------------- 项目列表
  function projects() {
    const m = {};
    for (const e of active()) if (e.meta.project) m[e.meta.project] = (m[e.meta.project] || 0) + 1;
    for (const [, o] of conv.journal()) for (const s of Object.values(o)) if (s.project) m[s.project] = (m[s.project] || 0) + 1;
    return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([p, n]) => ({ p, n }));
  }

  // ---------------------------------------------------------------- 待办雷达
  function loadRadar() { return readJSON(radarFile, {}); }
  function todos({ project = '', days = 21 } = {}) {
    const marks = loadRadar();
    const idx = conv.index();
    const bySession = new Map();
    const since = localDay(new Date(Date.now() - days * 86400e3).toISOString());
    for (const [d, o] of conv.journal()) {
      if (d < since) continue;
      for (const [key, s] of Object.entries(o)) {
        const cur = bySession.get(key);
        if (!cur || d > cur.date) bySession.set(key, { ...s, date: d, key });
      }
    }
    const items = [];
    for (const s of bySession.values()) {
      if (!['ongoing', 'blocked'].includes(s.status)) continue;
      if (project && !sameProj(s.project, project)) continue;
      const mk = marks[s.key];
      if (mk && mk.date >= s.date) continue; // 标过"已收尾/不用管"，之后没有新进展
      const e = idx[s.key];
      items.push({ ref: conv.refOf(s.key), project: s.project || '', title: e?.title || s.title || '', summary: s.summary, points: s.points || [], status: s.status,
        date: s.date, age: Math.floor((Date.now() - Date.parse(`${s.date}T23:59:59+08:00`)) / 86400e3), device: s.device || e?.device, tool: s.tool || e?.tool });
    }
    items.sort((a, b) => (a.status === 'blocked' ? 0 : 1) - (b.status === 'blocked' ? 0 : 1) || b.date.localeCompare(a.date));
    // 停了的项目：30 天内有过会话、最近 7 天一段都没有
    const last = {};
    for (const [d, o] of conv.journal()) for (const s of Object.values(o)) if (s.project && (!last[s.project] || d > last[s.project])) last[s.project] = d;
    const d7 = localDay(new Date(Date.now() - 7 * 86400e3).toISOString());
    const d30 = localDay(new Date(Date.now() - 30 * 86400e3).toISOString());
    const cnt = {};
    for (const [d, o] of conv.journal()) if (d >= d30) for (const s of Object.values(o)) if (s.project) cnt[s.project] = (cnt[s.project] || 0) + 1;
    const stalled = Object.entries(last).filter(([p, d]) => d < d7 && d >= d30 && (cnt[p] || 0) >= 5).sort((a, b) => b[1].localeCompare(a[1])).map(([p, d]) => ({ project: p, last: d }));
    return { items, stalled };
  }
  async function markTodo(ref, action, who) {
    const key = refMap().get(String(ref || ''));
    if (!key) throw new UserError('没有这个会话');
    if (!['done', 'ignore', 'reopen'].includes(action)) throw new UserError('action 只能是 done / ignore / reopen');
    return serial(async () => {
      const marks = loadRadar();
      if (action === 'reopen') delete marks[key];
      else marks[key] = { action, date: localDay(nowIso()), at: nowIso(), by: who };
      fs.writeFileSync(radarFile, JSON.stringify(marks, null, 1));
      return { ok: true };
    });
  }
  function renderTodos(r, limit = 20) {
    if (!r.items.length && !r.stalled.length) return '没有悬着的事。';
    const lines = [];
    if (r.items.length) {
      lines.push(`还没收尾的事 ${r.items.length} 件（日志里最后状态是"进行中/卡住"的会话；ref 可交给 conversation_get）：`);
      for (const t of r.items.slice(0, limit)) {
        lines.push(`- ${t.status === 'blocked' ? '【卡住】' : ''}${t.project ? `[${t.project}] ` : ''}${t.summary}（${t.date}，${t.age} 天前，${t.device}/${tl(t.tool)}，ref:${t.ref}）`);
        if (t.points.length) lines.push(`  · ${t.points.slice(0, 3).join('；')}`);
      }
      if (r.items.length > limit) lines.push(`…还有 ${r.items.length - limit} 件`);
    }
    if (r.stalled.length) lines.push('', `停了的项目（30 天内干过、最近 7 天没动）：${r.stalled.map((s) => `${s.project}（最后 ${s.last}）`).join('、')}`);
    return lines.join('\n');
  }

  // ---------------------------------------------------------------- 交接包
  function handoff({ project = '', days = 14, query = '' } = {}) {
    const p = String(project || '').trim();
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!p && !words.length) throw new UserError('给个项目名（如 myapp）或关键词');
    const n = Math.min(Math.max(parseInt(days, 10) || 14, 1), 180);
    const since = localDay(new Date(Date.now() - n * 86400e3).toISOString());
    const hit = (txt) => words.every((w) => String(txt || '').toLowerCase().includes(w));
    const mem = active().filter((e) => (p ? sameProj(e.meta.project, p) : true) && (!words.length || hit(`${e.meta.title}\n${e.body}\n${e.meta.subject || ''}`))).sort(byUpdated);
    const of = (t) => mem.filter((e) => e.meta.type === t);
    const segs = [];
    for (const [d, o] of conv.journal()) {
      if (d < since) continue;
      for (const [key, s] of Object.entries(o)) {
        if (p && !sameProj(s.project, p)) continue;
        if (words.length && !hit(`${s.summary} ${(s.points || []).join(' ')} ${s.title || ''}`)) continue;
        segs.push({ ...s, date: d, key, ref: conv.refOf(key) });
      }
    }
    segs.sort((a, b) => b.date.localeCompare(a.date) || String(b.first).localeCompare(String(a.first)));
    const open = todos({ project: p, days: Math.max(n, 30) }).items.filter((t) => !words.length || hit(`${t.summary} ${t.title}`));
    const sessions = new Map();
    for (const s of segs) {
      const cur = sessions.get(s.key) || { ref: s.ref, title: conv.index()[s.key]?.title || s.title, first: s.date, last: s.date, device: s.device, tool: s.tool, n: 0 };
      cur.first = s.date < cur.first ? s.date : cur.first; cur.last = s.date > cur.last ? s.date : cur.last; cur.n += s.n || 0;
      sessions.set(s.key, cur);
    }
    const name = p || `「${words.join(' ')}」`;
    const fmtD = (iso) => localDay(iso);
    const out = [
      `# 交接包：${name}（${since} → ${localDay(nowIso())}）`,
      '',
      `> 由共享记忆自动生成（${localDay(nowIso())}）。接手前先通读；记忆和日志会滞后于现场，和实际文件、配置、日志冲突时以现场为准，并指出冲突。`,
      '> 要看某次对话的原话：`conversation_get` 加下面的 ref；要查更多：`memory_search` / `memory_timeline`。',
      '',
    ];
    const statuses = of('status');
    if (statuses.length) {
      out.push('## 现状', '');
      for (const e of statuses.slice(0, 8)) out.push(`### ${e.meta.title}`, `（${fmtD(e.meta.updated)} · ${e.meta.author}/${e.meta.client} · ${e.meta.id}）`, '', short(e.body, 1400), '');
    }
    if (open.length) {
      out.push('## 还没收尾的事', '');
      for (const t of open.slice(0, 12)) out.push(`- ${t.status === 'blocked' ? '【卡住】' : ''}${t.summary}（${t.date}，ref:${t.ref}）${t.points.length ? `\n  - ${t.points.slice(0, 3).join('\n  - ')}` : ''}`);
      out.push('');
    }
    if (of('decision').length) { out.push('## 拍板的决定', '', ...of('decision').slice(0, 15).map((e) => `- ${e.meta.title}（${fmtD(e.meta.updated)}）：${short(e.body, 220)}`), ''); }
    if (of('pitfall').length) { out.push('## 踩过的坑（别再踩）', '', ...of('pitfall').slice(0, 15).map((e) => `- ${e.meta.title}：${short(e.body, 220)}`), ''); }
    if (segs.length) {
      out.push(`## 最近 ${n} 天做了什么（工作日志）`, '');
      for (const s of segs.slice(0, 40)) out.push(`- ${s.date} ${s.summary}（${s.device}/${tl(s.tool)}，ref:${s.ref}）${s.points?.length ? `\n  - ${s.points.slice(0, 4).join('\n  - ')}` : ''}`);
      out.push('');
    }
    if (sessions.size) {
      out.push('## 相关会话（原话用 conversation_get）', '');
      for (const s of [...sessions.values()].sort((a, b) => b.last.localeCompare(a.last)).slice(0, 15)) out.push(`- ref:${s.ref}「${short(s.title, 50)}」${s.first === s.last ? s.first : `${s.first} → ${s.last}`}，${s.device}/${tl(s.tool)}`);
      out.push('');
    }
    const refs = [...of('reference'), ...of('fact')];
    if (refs.length) { out.push('## 参考与事实', '', ...refs.slice(0, 15).map((e) => `- ${e.meta.title}${e.meta.type === 'reference' ? `：${short(e.body, 160)}` : ''}`), ''); }
    const prefs = active().filter((e) => e.meta.type === 'preference' || e.meta.type === 'feedback').sort(byUpdated).slice(0, 12);
    if (prefs.length) { out.push('## 用户的偏好（照做）', '', ...prefs.map((e) => `- ${e.meta.title}`), ''); }
    if (out.length < 8) out.push('（这段时间里没有找到相关的记忆和日志。换个项目名、关键词或拉长天数试试。）');
    return out.join('\n');
  }

  // ---------------------------------------------------------------- 周报
  function weekly() {
    const end = localDay(new Date(Date.now() - 86400e3).toISOString());
    const start = localDay(new Date(Date.now() - 7 * 86400e3).toISOString());
    const days = [];
    for (const [d, o] of conv.journal()) if (d >= start && d <= end) days.push([d, Object.values(o)]);
    const segs = days.flatMap(([d, xs]) => xs.map((s) => ({ ...s, date: d })));
    const byProj = new Map();
    for (const s of segs) { const p = s.project || '其他'; if (!byProj.has(p)) byProj.set(p, []); byProj.get(p).push(s); }
    const busiest = days.sort((a, b) => b[1].length - a[1].length)[0];
    const ex = conv.vizExtra();
    const ms = ex.milestones.filter((m) => m.date >= start && m.date <= end);
    const td = todos({ days: 30 });
    const newMem = active().filter((e) => localDay(e.meta.created) >= start).length;
    const W = '日一二三四五六';
    const lines = [`【上周工作周报】${start.slice(5)} ~ ${end.slice(5)}`, `· ${segs.length} 段会话，${segs.reduce((a, s) => a + (s.n || 0), 0).toLocaleString()} 条消息${busiest ? `；最忙的是 ${busiest[0].slice(5)}（周${W[new Date(`${busiest[0]}T12:00:00Z`).getUTCDay()]}，${busiest[1].length} 段）` : ''}；新增记忆 ${newMem} 条`];
    lines.push('· 各项目：');
    for (const [p, xs] of [...byProj.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 8)) {
      lines.push(`  - ${p}（${xs.length} 段）：${xs.sort((a, b) => (b.n || 0) - (a.n || 0)).slice(0, 2).map((s) => short(s.summary, 44)).join('；')}`);
    }
    if (ms.length) lines.push(`· 干成的事（${ms.length} 件）：`, ...ms.slice(-8).map((m) => `  - ${m.date.slice(5)} ${m.project ? `[${m.project}] ` : ''}${short(m.summary, 60)}`));
    if (td.items.length) lines.push(`· 还悬着（${td.items.length} 件，卡住的先列）：`, ...td.items.slice(0, 8).map((t) => `  - ${t.status === 'blocked' ? '【卡住】' : ''}${t.project ? `[${t.project}] ` : ''}${short(t.summary, 56)}（${t.age} 天没动）`));
    if (td.stalled.length) lines.push(`· 停了的项目：${td.stalled.map((s) => `${s.project}（最后 ${s.last.slice(5)}）`).join('、')}`);
    lines.push(`· 看大屏：${CFG.public_url}/  · 待办雷达在大屏里可以标"已收尾"`);
    return lines.join('\n');
  }

  // ---------------------------------------------------------------- 记忆管理
  let dupCache = null;
  function manageData() {
    const all = [...store.values()].filter((e) => e.meta.state === 'active' || e.meta.state === 'proposed');
    const sig = all.map((e) => `${e.meta.id}:${e.meta.updated}:${e.meta.state}`).join('|').length + ':' + all.length;
    if (!dupCache || dupCache.sig !== sig) {
      const g = all.map((e) => ({ e, g: grams(e.meta.title) }));
      const groups = [];
      const used = new Set();
      for (let i = 0; i < g.length; i++) {
        if (used.has(i)) continue;
        const grp = [i];
        for (let j = i + 1; j < g.length; j++) {
          if (used.has(j)) continue;
          if (g[i].e.meta.type !== g[j].e.meta.type) continue;
          if (jaccard(g[i].g, g[j].g) >= 0.55) grp.push(j);
        }
        if (grp.length > 1) { grp.forEach((k) => used.add(k)); groups.push(grp.map((k) => g[k].e.meta.id)); }
      }
      dupCache = { sig, groups };
    }
    const row = (e) => ({ id: e.meta.id, type: e.meta.type, state: e.meta.state, title: e.meta.title, project: e.meta.project || '', subject: e.meta.subject || '',
      origin: e.meta.origin, source: `${e.meta.author}/${e.meta.client}`, updated: e.meta.updated, created: e.meta.created, body: short(e.body, 600), tags: e.meta.tags || [] });
    return {
      entries: all.sort(byUpdated).map(row),
      duplicates: dupCache.groups,
      stale: all.filter((e) => e.meta.state === 'active' && e.meta.type === 'status' && ageDays(e.meta.updated) > 30).map((e) => e.meta.id),
      proposed: all.filter((e) => e.meta.state === 'proposed').map((e) => e.meta.id),
    };
  }
  async function manageAction(b, viewer, api) {
    const who = { device: viewer, client: 'browser' };
    const ids = (Array.isArray(b.ids) ? b.ids : [b.id]).filter(Boolean).map(String);
    const reason = String(b.reason || '').slice(0, 200);
    switch (b.action) {
      case 'edit': return api.updateEntry({ id: ids[0], title: b.title, body: b.body, project: b.project, subject: b.subject }, who).then((e) => ({ ok: true, id: e.meta.id }));
      case 'approve': case 'reject': return api.decide(ids, b.action, `browser:${viewer}`).then((n) => ({ ok: true, n }));
      case 'retire':
      case 'merge': {
        // merge：保留第一条，其余作废并指向它；工具自己记的（native）也允许在这里手动作废（源文件改了会重新出现）
        const keep = b.action === 'merge' ? ids[0] : null;
        const targets = b.action === 'merge' ? ids.slice(1) : ids;
        if (!targets.length) throw new UserError('没有要处理的条目');
        return serial(async () => {
          let n = 0;
          for (const id of targets) {
            const e = store.get(id);
            if (!e || e.meta.state === 'retired') continue;
            Object.assign(e.meta, keep
              ? { state: 'superseded', superseded_by: keep, updated: nowIso(), updated_by: `${viewer}/browser` }
              : { state: 'retired', retired_reason: reason || '在管理台手动作废', updated: nowIso(), updated_by: `${viewer}/browser` });
            if (e.meta.origin === 'native' && !keep) e.meta.retired_reason += '（工具自己记的：源文件改了会重新出现）';
            await writeEntry(e);
            n++;
          }
          if (n) await commit(`${keep ? `合并到 ${keep}` : '作废'} ${n} 条（管理台 ${viewer}）`, `${viewer}/browser`);
          return { ok: true, n };
        });
      }
      default: throw new UserError('不认识的操作');
    }
  }

  // ---------------------------------------------------------------- 审计
  function audit({ days = 7 } = {}) {
    const since = Date.now() - Math.min(Math.max(parseInt(days, 10) || 7, 1), 90) * 86400e3;
    const ev = readJsonl(usageFile(), since).filter((u) => u.op.startsWith('tool:') || u.op.startsWith('cli:') || u.op === 'browse' || u.op === 'viz' || u.op === 'wrapped');
    const by = {};
    const ops = {};
    for (const u of ev) {
      const k = `${u.device}/${u.client}`;
      (by[k] ||= { calls: 0, writes: 0, last: null }).calls++;
      if (/remember|update|retire/.test(u.op)) by[k].writes++;
      if (!by[k].last || u.t > by[k].last) by[k].last = u.t;
      const op = u.op.replace(/^(tool|cli):/, '');
      ops[op] = (ops[op] || 0) + 1;
    }
    const rej = readJsonl(path.join(CFG.state, 'rejections.jsonl'), since);
    return { since: new Date(since).toISOString(), total: ev.length, byClient: Object.entries(by).sort((a, b) => b[1].calls - a[1].calls), ops: Object.entries(ops).sort((a, b) => b[1] - a[1]), events: ev.slice(-300).reverse(), rejections: rej.slice(-30).reverse() };
  }

  // ---------------------------------------------------------------- 知识图谱
  // 实体：项目（记忆和日志里的项目名）、机器、客户现场、版本号；同一条记忆或同一段日志里一起出现就连一条边
  const DEFAULT_ENTITIES = {
    machine: [], // 在 config.json 的 graph_entities.machine 里配你的机器名
    site: [],
  };
  let graphCache = null;
  function graph() {
    const sig = `${store.size}:${[...store.values()].reduce((a, e) => a + (Date.parse(e.meta.updated) || 0), 0)}:${conv.journal().size}`;
    if (graphCache?.sig === sig) return graphCache.data;
    const ents = CFG.graph_entities || DEFAULT_ENTITIES;
    const projs = projects().filter((x) => x.n >= 3).map((x) => x.p);
    const dict = [
      ...projs.map((p) => ({ kind: 'project', name: p, re: new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') })),
      ...(ents.machine || []).map((m) => ({ kind: 'machine', name: m, re: new RegExp(`(^|[^A-Za-z0-9-])${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9-])`, 'i') })),
      ...(ents.site || []).map((s) => ({ kind: 'site', name: s, re: new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') })),
    ];
    const nodes = new Map();
    const edges = new Map();
    const docs = [];
    for (const e of active()) docs.push({ text: `${e.meta.title}\n${e.body}`, project: e.meta.project, date: localDay(e.meta.updated), ev: { id: e.meta.id, title: e.meta.title, type: e.meta.type } });
    for (const [d, o] of conv.journal()) for (const [key, s] of Object.entries(o)) docs.push({ text: `${s.summary} ${(s.points || []).join(' ')}`, project: s.project, date: d, ev: { ref: conv.refOf(key), title: s.summary, type: 'journal' } });
    for (const doc of docs) {
      const found = new Map();
      if (doc.project && projs.includes(doc.project)) found.set(`project:${doc.project}`, { kind: 'project', name: doc.project });
      for (const x of dict) if (x.re.test(doc.text)) found.set(`${x.kind}:${x.name}`, { kind: x.kind, name: x.name });
      // 版本号挂在项目上：项目名后面紧跟的版本（如 MyApp 2.9.21；提交号不算）
      // 三段式版本号；IP 地址的片段（127.0.0.1、10.0.0.12）不算
      for (const m of doc.text.matchAll(/(?<![\d.])(\d+\.\d+\.\d+)(?![\d.]*\d)/g)) {
        if (/^(100|192|10|172)\./.test(m[1])) continue;
        const proj = doc.project || [...found.values()].find((f) => f.kind === 'project')?.name;
        if (proj) found.set(`version:${proj} ${m[1]}`, { kind: 'version', name: `${proj} ${m[1]}`, project: proj });
      }
      const ks = [...found.keys()];
      for (const k of ks) {
        const n = nodes.get(k) || { ...found.get(k), id: k, count: 0, last: '' };
        n.count++; if (doc.date > n.last) n.last = doc.date;
        nodes.set(k, n);
      }
      for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) {
        const k = ks[i] < ks[j] ? `${ks[i]}|${ks[j]}` : `${ks[j]}|${ks[i]}`;
        const ed = edges.get(k) || { a: k.split('|')[0], b: k.split('|')[1], w: 0, last: '', ev: [] };
        ed.w++; if (doc.date > ed.last) ed.last = doc.date;
        ed.ev.push({ ...doc.ev, date: doc.date });
        edges.set(k, ed);
      }
    }
    // 版本节点只留每个项目最近的 4 个，边只留权重 ≥2 的（版本和项目的边例外）
    const keepVer = new Set();
    const verBy = {};
    for (const n of nodes.values()) if (n.kind === 'version') (verBy[n.project] ||= []).push(n);
    for (const arr of Object.values(verBy)) arr.sort((a, b) => b.last.localeCompare(a.last)).slice(0, 4).forEach((n) => keepVer.add(n.id));
    const nodeOk = (id) => nodes.get(id) && (nodes.get(id).kind !== 'version' || keepVer.has(id));
    const es = [...edges.values()].filter((e) => nodeOk(e.a) && nodeOk(e.b) && (e.w >= 2 || e.a.startsWith('version:') || e.b.startsWith('version:')))
      .map((e) => ({ ...e, ev: e.ev.sort((x, y) => y.date.localeCompare(x.date)).slice(0, 6) }));
    const used = new Set(es.flatMap((e) => [e.a, e.b]));
    const ns = [...nodes.values()].filter((n) => nodeOk(n.id) && (used.has(n.id) || n.kind === 'project'));
    const data = { nodes: ns, edges: es };
    graphCache = { sig, data };
    return data;
  }
  function entity(name) {
    const g = graph();
    const q = String(name || '').toLowerCase().trim();
    if (!q) return '给个名字：项目名、机器名、客户现场或版本号。';
    const node = g.nodes.find((n) => n.name.toLowerCase() === q) || g.nodes.find((n) => n.name.toLowerCase().includes(q));
    if (!node) return `知识图谱里没有「${name}」。现有的实体有：${[...new Set(g.nodes.filter((n) => n.kind !== 'version').map((n) => n.name))].slice(0, 50).join('、')}`;
    const KIND = { project: '项目', machine: '机器', site: '客户现场', version: '版本' };
    const rel = g.edges.filter((e) => e.a === node.id || e.b === node.id).map((e) => ({ other: g.nodes.find((n) => n.id === (e.a === node.id ? e.b : e.a)), e })).filter((x) => x.other).sort((a, b) => b.e.w - a.e.w);
    const lines = [`「${node.name}」（${KIND[node.kind]}）：出现在 ${node.count} 条记忆/日志里，最近一次 ${node.last}`];
    const vers = rel.filter((x) => x.other.kind === 'version').sort((a, b) => b.e.last.localeCompare(a.e.last));
    if (vers.length) lines.push(`版本（按最近提到排序）：${vers.slice(0, 12).map((x) => `${x.other.name}（${x.e.last}）`).join('、')}`);
    for (const k of ['project', 'machine', 'site']) {
      const xs = rel.filter((x) => x.other.kind === k);
      if (xs.length) lines.push(`相关${KIND[k]}：${xs.slice(0, 12).map((x) => `${x.other.name}（${x.e.w} 次，最近 ${x.e.last}）`).join('、')}`);
    }
    const ev = rel.flatMap((x) => x.e.ev).sort((a, b) => b.date.localeCompare(a.date));
    const seen = new Set();
    lines.push('最近的相关记录：');
    for (const v of ev) {
      const k = v.id || v.ref;
      if (seen.has(k)) continue;
      seen.add(k);
      lines.push(`- ${v.date} ${short(v.title, 80)}（${v.id ? `id=${v.id}` : `ref:${v.ref}`}）`);
      if (seen.size >= 10) break;
    }
    return lines.join('\n');
  }

  // ---------------------------------------------------------------- 按意思搜（本地向量）
  const vecFile = path.join(CFG.state, 'vectors.json');
  let vec = readJSON(vecFile, { model: '', items: {} }); // key -> { h, v: base64(float32) }
  let vecBusy = false;
  const embedUrl = CFG.embed_url || '';
  async function embed(texts) {
    const res = await fetch(`${embedUrl}/embed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ texts }), signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`向量服务 ${res.status}`);
    const j = await res.json();
    vec.model = j.model || vec.model;
    return j.vectors;
  }
  const toB64 = (arr) => Buffer.from(new Float32Array(arr).buffer).toString('base64');
  const fromB64 = (s) => { const b = Buffer.from(s, 'base64'); return new Float32Array(b.buffer, b.byteOffset, b.length / 4); };
  function docsForIndex() {
    const out = [];
    for (const e of active()) out.push({ key: `m:${e.meta.id}`, text: `${TYPE_LABEL[e.meta.type] || ''} ${e.meta.project || ''} ${e.meta.title}\n${short(e.body, 400)}` });
    for (const [d, o] of conv.journal()) for (const [key, s] of Object.entries(o)) out.push({ key: `j:${d}|${key}`, text: `${s.project || ''} ${s.summary} ${(s.points || []).join('；')}` });
    return out;
  }
  async function reindex() {
    if (!embedUrl || vecBusy) return { skipped: true };
    vecBusy = true;
    try {
      const docs = docsForIndex();
      const want = new Set(docs.map((d) => d.key));
      for (const k of Object.keys(vec.items)) if (!want.has(k)) delete vec.items[k];
      const todo = docs.filter((d) => { const h = crypto.createHash('sha1').update(d.text).digest('hex').slice(0, 12); d.h = h; return vec.items[d.key]?.h !== h; });
      for (let i = 0; i < todo.length; i += 64) {
        const batch = todo.slice(i, i + 64);
        const vs = await embed(batch.map((d) => d.text));
        batch.forEach((d, k) => { vec.items[d.key] = { h: d.h, v: toB64(vs[k]) }; });
        if (i % 640 === 0) fs.writeFileSync(vecFile, JSON.stringify(vec));
      }
      fs.writeFileSync(vecFile, JSON.stringify(vec));
      cacheVec = null;
      return { indexed: todo.length, total: Object.keys(vec.items).length };
    } finally { vecBusy = false; }
  }
  let cacheVec = null;
  function vectors() {
    if (!cacheVec) cacheVec = Object.entries(vec.items).map(([k, x]) => [k, fromB64(x.v)]);
    return cacheVec;
  }
  async function semantic(query, { limit = 10, kind = '' } = {}) {
    if (!embedUrl) return null;
    let qv;
    try { qv = (await embed([String(query)]))[0]; } catch { return null; }
    const q = new Float32Array(qv);
    const scored = [];
    for (const [k, v] of vectors()) {
      if (kind && !k.startsWith(kind)) continue;
      let s = 0;
      for (let i = 0; i < q.length; i++) s += q[i] * v[i];
      scored.push([k, s]);
    }
    scored.sort((a, b) => b[1] - a[1]);
    const out = [];
    for (const [k, s] of scored.slice(0, limit)) {
      if (k.startsWith('m:')) {
        const e = store.get(k.slice(2));
        if (e) out.push({ kind: 'memory', score: s, id: e.meta.id, type: e.meta.type, title: e.meta.title, project: e.meta.project || '', date: localDay(e.meta.updated), source: `${e.meta.author}/${e.meta.client}` });
      } else {
        const [d, key] = k.slice(2).split('|');
        const seg = conv.journal().get(d)?.[key];
        if (seg) out.push({ kind: 'journal', score: s, ref: conv.refOf(key), date: d, title: seg.summary, project: seg.project || '', source: `${seg.device}/${seg.tool}` });
      }
    }
    return out;
  }
  function renderSemantic(rs, query) {
    if (!rs) return null;
    if (!rs.length) return `按意思没找到和「${query}」相关的。`;
    return [`按意思找到（越靠前越相关）：`, ...rs.map((r, i) => `${i + 1}. ${r.kind === 'memory' ? `[${TYPE_LABEL[r.type] || r.type}]` : '[日志]'}${r.project ? ` [${r.project}]` : ''} ${r.title}（${r.date} · ${r.source} · ${r.kind === 'memory' ? `id=${r.id}` : `ref:${r.ref}`}）`)].join('\n');
  }
  function semanticStatus() { return { enabled: Boolean(embedUrl), model: vec.model, items: Object.keys(vec.items).length, busy: vecBusy }; }

  return { projects, todos, markTodo, renderTodos, handoff, weekly, manageData, manageAction, audit, graph, entity, reindex, semantic, renderSemantic, semanticStatus };
}
