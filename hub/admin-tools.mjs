/* D 组：记忆工具接口，挂在 /console/api/ 下（由 admin.mjs 的扩展位接进来，身份校验、审计、错误格式都用核心的）。
 *
 *   GET  memory/<id>/history          这条记忆的所有版本：sha、时间、改动者、动作（git 历史，最多 100 版）
 *   GET  memory/<id>/history/<sha>    该版本对这条记忆的差异（unified diff 文本，放在 diff 字段）
 *   POST memory/<id>/restore          {sha} 恢复到某一版：走 updateEntry，产生一个新版本，不改写历史
 *   POST memory/from-conv             {ref,date,type,title,body,project[,subject]} 把对话里的一段存成记忆（走 remember，带出处）
 *   GET  memory/conv-hint?ref=&date=  存成记忆表单的预填（项目）
 *   GET  digest?device=&tool=         预览某台设备上某个智能体启动时实际拿到的摘要，附逐条状态、预算、标记
 *   POST digest/rule                  {id, action: pin|unpin|exclude|include} 置顶/排除出摘要（写 state/digest-rules.json）
 *
 * 改动者口径：版本的"改动者"取该次 git 提交的作者名。commit() 把作者写成「设备名/客户端」（如 my-laptop/claude-code）；
 * 抽取机是「设备/extractor」，控制台里的审批是「review/browser:设备」，管理台合并/作废是「设备/browser」，
 * 控制台里"恢复旧版本"和"对话存成记忆"是「设备/console」，中心自己的维护提交是「agent-memory」。
 * 一次提交可能同时改很多条（原生同步、导入、批量审批、合并），差异只取这一条的那一段。
 *
 * 出处的存储格式：正文最后一行固定为  出处：对话 <8 位会话 ref> · <YYYY-MM-DD>
 * （和前一段空一行；智能体 memory_get 时也能看到；记忆详情页识别后渲染成可点的链接）。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,79}$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;
const REF_RE = /^[0-9a-f]{8}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_VERSIONS = 100;
const MAX_DIFF = 60000;
const MAX_PINS = 50;
const BODY_MAX = 8000; // 同 server.mjs 的 LIMITS.body
// 出处行：正文最后一行
export const SOURCE_RE = /(?:^|\n)出处：对话 ([0-9a-f]{8}) · (\d{4}-\d{2}-\d{2})\s*$/;
export const sourceLine = (ref, date) => `出处：对话 ${ref} · ${date}`;
export const parseSource = (body) => { const m = SOURCE_RE.exec(String(body || '')); return m ? { ref: m[1], date: m[2] } : null; };

// ------------------------------------------------------------------------------------------------------------------
// 摘要里"没信息量"和"重复"的判定（纯函数，导出给测试）
// ------------------------------------------------------------------------------------------------------------------

const normTitle = (s) => String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

// 通用词：标题只由这些词组成，说明不了任何事
const GENERIC_EN = new Set(['memory', 'memories', 'block', 'blocks', 'note', 'notes', 'memo', 'memos', 'todo', 'todos', 'misc', 'miscellaneous', 'general', 'info', 'information',
  'other', 'others', 'untitled', 'draft', 'test', 'temp', 'tmp', 'data', 'config', 'configuration', 'settings', 'summary', 'overview', 'readme', 'log', 'logs', 'task', 'tasks',
  'reminder', 'reminders', 'context', 'preference', 'preferences', 'rule', 'rules', 'guideline', 'guidelines', 'stuff', 'things', 'infrastructure', 'infra', 'server', 'servers',
  'device', 'devices', 'machine', 'machines', 'project', 'projects', 'status', 'list', 'record', 'records', 'knowledge', 'base']);
const GENERIC_ZH = new Set(['笔记', '备注', '备忘', '备忘录', '记录', '记事', '杂项', '杂记', '其他', '其它', '说明', '概述', '概览', '总结', '汇总', '待办', '待办事项', '待处理', '事项', '关键报错', '报错',
  '服务状态', '状态', '基础设施', '设备台账', '台账', '机器', '设备', '项目', '配置', '偏好', '规则', '规范', '纪律', '信息', '资料', '文档', '清单', '列表', '注意事项', '须知', '要点', '重点',
  '经验', '教训', '问题', '工作', '日志', '日常', '常用', '基础', '环境', '服务', '服务器', '个人信息', '用户偏好', '知识库']);
// 纯汉字的短标题以这些词结尾、又没有谓语（"要/不/用/必须…"），多半只是个栏目名：代码生成纪律、设备台账
const LABEL_SUFFIX = ['纪律', '规范', '规则', '台账', '设施', '状态', '报错', '事项', '配置', '笔记', '备忘', '记录', '说明', '偏好', '清单', '信息', '总结', '汇总', '概述', '概览', '须知',
  '要点', '经验', '教训', '资料', '文档', '日志', '列表', '约定', '惯例', '备注'];
const PREDICATE = /[要不别勿必须禁得应先再用走是有无会能可把被让做写跑给以为对在到只都也就]/;

// 返回 null（正常）或原因：generic 通用词 / short 过短 / label 栏目名 / unrelated 标题和正文对不上
export function vagueReason(title, body = '') {
  const raw = String(title || '').trim();
  const t = normTitle(raw);
  if (!t) return 'short';
  if (GENERIC_ZH.has(t)) return 'generic';
  const words = raw.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const han = (t.match(/\p{Script=Han}/gu) || []).length;
  if (!han && words.length && words.every((w) => GENERIC_EN.has(w))) return 'generic';
  if (han <= 2 && t.length <= 3) return 'short';
  if (!han && raw.split(/\s+/).filter(Boolean).length <= 1) return 'short';
  if (han === t.length && t.length <= 8 && LABEL_SUFFIX.some((s) => t.endsWith(s)) && !PREDICATE.test(t)) return 'label';
  // 短标题、正文一大段，但标题里的字一个都没在正文里出现过
  const nb = normTitle(body);
  if (t.length <= 12 && nb.length >= 40) {
    const grams = [];
    for (let i = 0; i < t.length - 1; i++) grams.push(t.slice(i, i + 2));
    const latin = words.filter((w) => w.length >= 2);
    const hit = grams.some((g) => nb.includes(g)) || latin.some((w) => nb.includes(w));
    if (!hit) return 'unrelated';
  }
  return null;
}

// 标题里的英文词（项目名、产品名、工具名）：两条的英文词不一样，说的就不是同一件事
const latinKey = (s) => [...String(s || '').toLowerCase().matchAll(/[a-z][a-z0-9]{2,}/g)].map((m) => m[0]).sort().join(' ');
const gramsOf = (s) => {
  const t = normTitle(s);
  const g = new Set();
  const core = t.replace(/\d+/g, ''); // 日期、版本号不参与相似度
  for (let i = 0; i < core.length - 1; i++) g.add(core.slice(i, i + 2));
  return { t, g, lat: latinKey(s) };
};

// 近似重复：同一类（摘要的同一节）里，标题归一化后相同，或字词集合（二字组）高度重叠（Jaccard ≥ 0.4 且共有 ≥ 4 组、两条都不太短）。
// 在很多标题里都出现的二字组（项目名前缀、"先灰度再全量"这类句式）不算，免得句式一样的条目被当成同一件事；日期和版本号也不算。
// 两条都写了项目且项目不同、或标题里的英文词不一样的，不算重复（各项目都有一条「值班注意事项」是正常的）。
// items: [{ id, title, cls, project? }]，返回 [[id, …], …]（每组至少 2 条，组内保持输入顺序）
export function dupGroups(items) {
  const rows = items.map((it) => ({ ...it, ...gramsOf(it.title) }));
  const df = new Map();
  for (const r of rows) for (const x of r.g) df.set(x, (df.get(x) || 0) + 1);
  const common = Math.max(5, Math.ceil(rows.length * 0.015));
  for (const r of rows) r.k = new Set([...r.g].filter((x) => df.get(x) < common));
  const parent = rows.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const join = (a, b) => { const x = find(a); const y = find(b); if (x !== y) parent[y] = x; };
  const byCls = new Map();
  rows.forEach((r, i) => { if (r.t) (byCls.get(r.cls) || byCls.set(r.cls, []).get(r.cls)).push(i); });
  for (const idx of byCls.values()) {
    for (let a = 0; a < idx.length; a++) {
      const A = rows[idx[a]];
      for (let b = a + 1; b < idx.length; b++) {
        const B = rows[idx[b]];
        if ((A.project && B.project && A.project !== B.project) || A.lat !== B.lat) continue;
        if (A.t === B.t) { join(idx[a], idx[b]); continue; }
        if (A.t.length < 6 || B.t.length < 6 || A.k.size < 4 || B.k.size < 4) continue;
        const lo = Math.min(A.k.size, B.k.size); const hi = Math.max(A.k.size, B.k.size);
        if (lo / hi < 0.4) continue; // Jaccard 不会超过 lo/hi
        let n = 0;
        for (const x of A.k) if (B.k.has(x)) n++;
        if (n >= 4 && n / (A.k.size + B.k.size - n) >= 0.4) join(idx[a], idx[b]);
      }
    }
  }
  const groups = new Map();
  rows.forEach((r, i) => { const k = find(i); (groups.get(k) || groups.set(k, []).get(k)).push(r.id); });
  return [...groups.values()].filter((g) => g.length > 1);
}

// ------------------------------------------------------------------------------------------------------------------

export function createTools(ctx, kit) {
  const { CFG, readJSON, send, readBody, UserError, loadTokens, heartbeatFile, store, git, conv, updateEntry, remember, digest, parseEntry } = ctx;
  const { HttpError, bad, isObj, audit, visibleTo, hiddenOf, scopeOf } = kit;

  const rulesFile = () => path.join(CFG.state, 'digest-rules.json');
  const only = (req, m) => { if (req.method !== m) throw new HttpError(405, `这个接口只支持 ${m}`); };
  const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  const readonly = (viewer) => Boolean(loadTokens().devices?.[viewer]?.readonly);
  const needWrite = (viewer) => { if (readonly(viewer)) throw new HttpError(403, '这台机器在共享记忆里设成了只读，不能写。'); };
  const idOf = (raw) => { const id = decode(raw); if (!ID_RE.test(id)) throw bad('id 不对'); return id; };
  const entryFile = (id) => `entries/${id}.md`;

  // 条目必须存在且浏览者看得见；看不见和不存在一样回 404，不泄露它在不在
  function entryOf(id, viewer) {
    const e = store.get(id);
    if (!e || !visibleTo(viewer, e.meta.project)) throw new HttpError(404, '没有这条记忆');
    return e;
  }

  // ---- 修改历史 ----
  const STATE_ZH = { superseded: '已被取代', retired: '已作废' };
  function restorable(e) {
    if (e.meta.origin === 'native') return { ok: false, reason: '这条来自工具自己的原生记忆文件，会被下次同步覆盖，不能恢复旧版本' };
    if (e.meta.state !== 'active' && e.meta.state !== 'proposed') return { ok: false, reason: `这条记忆${STATE_ZH[e.meta.state] || '已不是有效状态'}，不能再改` };
    return { ok: true, reason: '' };
  }

  async function gitOut(...args) {
    try { return (await git(...args)).stdout; } catch { return null; }
  }

  async function allShas(id) {
    const out = await gitOut('log', '--no-color', '--format=%H', '--', entryFile(id));
    return out === null ? [] : out.split('\n').filter(Boolean);
  }

  function actionOf(subject, author, first) {
    const s = subject || '';
    const byConsole = /\/console$/.test(author);
    if (s === 'init') return '初始化';
    if (/^remember\(/.test(s)) return first ? (byConsole ? '对话存成记忆' : '新建') : '被新条目取代';
    if (/^update: /.test(s)) return byConsole ? '恢复旧版本' : '编辑';
    if (/^retire: /.test(s)) return '作废';
    if (/^native sync /.test(s)) return first ? '原生同步（新建）' : '原生同步';
    if (/^import /.test(s)) return first ? '导入（新建）' : '导入';
    if (/^extract /.test(s)) return '会话抽取';
    if (/^保留 \d+ 条候选/.test(s)) return '审批：保留';
    if (/^不要 \d+ 条候选/.test(s)) return '审批：不要';
    if (/^合并到 /.test(s)) return '合并';
    if (/^作废 \d+ 条/.test(s)) return '作废';
    if (/^fix: /.test(s)) return '修正';
    return '其他';
  }

  async function history(id, viewer) {
    const e = entryOf(id, viewer);
    const file = entryFile(id);
    const out = await gitOut('log', '--no-color', '-n', String(MAX_VERSIONS), '--format=%H%x09%aI%x09%an%x09%s', '--', file);
    const total = Number((await gitOut('rev-list', '--count', 'HEAD', '--', file) || '0').trim()) || 0;
    const rows = (out || '').split('\n').filter(Boolean).map((line) => {
      const [sha, time, author, ...subject] = line.split('\t');
      return { sha, time, author, subject: subject.join('\t') };
    });
    const r = restorable(e);
    const versions = rows.map((v, i) => {
      const slash = v.author.indexOf('/');
      const first = rows.length === total && i === rows.length - 1; // 只有拿到全部历史时，最后一条才确定是创建
      return {
        sha: v.sha, short: v.sha.slice(0, 7), time: Number.isFinite(Date.parse(v.time)) ? new Date(v.time).toISOString() : v.time,
        by: v.author, device: slash < 0 ? v.author : v.author.slice(0, slash), client: slash < 0 ? '' : v.author.slice(slash + 1),
        action: actionOf(v.subject, v.author, first), subject: v.subject, current: i === 0,
        n: total - i,
      };
    });
    return { id, title: e.meta.title, state: e.meta.state, origin: e.meta.origin, total, more: total > rows.length, restorable: r.ok, reason: r.reason, versions };
  }

  // sha（7–40 位）→ 完整 sha：必须是这条记忆的某个版本（改过这个文件的提交）
  async function resolveVersion(id, sha) {
    const all = await allShas(id);
    const hits = all.filter((h) => h.startsWith(sha));
    if (hits.length > 1) throw bad('这个 sha 前缀不唯一，多写几位');
    if (!hits.length) throw new HttpError(404, '这条记忆没有这个版本');
    return { full: hits[0], all };
  }
  async function readAt(rev, id) {
    const raw = await gitOut('show', `${rev}:${entryFile(id)}`);
    return raw === null ? null : parseEntry(raw);
  }

  async function versionDiff(id, sha, viewer) {
    entryOf(id, viewer);
    const { full, all } = await resolveVersion(id, sha);
    // 这一版或上一版属于浏览者看不见的项目（项目改过名）：不给差异
    for (const rev of [full, `${full}^`]) {
      const v = await readAt(rev, id);
      if (v && !visibleTo(viewer, v.meta.project)) throw new HttpError(404, '这条记忆没有这个版本');
    }
    const info = (await gitOut('log', '-n', '1', '--no-color', '--format=%aI%x09%an%x09%s', full)) || '';
    const [time, author, ...subject] = info.trim().split('\t');
    const raw = (await gitOut('show', '--no-color', '--format=', '--unified=3', full, '--', entryFile(id))) || '';
    const at = raw.search(/^@@/m);
    let diff = at < 0 ? '' : raw.slice(at).replace(/\n+$/, '');
    const truncated = diff.length > MAX_DIFF;
    if (truncated) diff = diff.slice(0, MAX_DIFF);
    return { id, sha: full, short: full.slice(0, 7), time: time ? new Date(time).toISOString() : null, by: author || '', subject: subject.join('\t'), action: actionOf(subject.join('\t'), author || '', all[all.length - 1] === full), diff, truncated };
  }

  const sameFields = (a, b) => a.title === b.title && a.body === b.body && (a.subject || '') === (b.subject || '') && (a.project || '') === (b.project || '')
    && JSON.stringify(a.tags || []) === JSON.stringify(b.tags || []);

  async function restore(id, body, viewer) {
    if (!isObj(body)) throw bad('请求体必须是 JSON 对象');
    needWrite(viewer);
    const e = entryOf(id, viewer);
    const r = restorable(e);
    if (!r.ok) throw bad(`${r.reason}。`);
    if (typeof body.sha !== 'string' || !SHA_RE.test(body.sha)) throw bad('sha 不对（7–40 位小写十六进制）');
    const { full } = await resolveVersion(id, body.sha);
    const old = await readAt(full, id);
    if (!old || !old.meta.title) throw bad('这一版读不出内容，不能恢复');
    if (!visibleTo(viewer, old.meta.project)) throw new HttpError(404, '这条记忆没有这个版本');
    if (sameFields({ ...old.meta, body: old.body }, { ...e.meta, body: e.body })) throw bad('这一版和当前内容一样，不用恢复。');
    try {
      await updateEntry({ id, title: old.meta.title, body: old.body, subject: old.meta.subject || '', project: old.meta.project || '', tags: old.meta.tags || [] }, { device: viewer, role: 'device', client: 'console' });
    } catch (err) {
      if (err instanceof UserError) throw bad(`这一版不能恢复：${err.message}`);
      throw err;
    }
    audit(viewer, 'memory-restore', `${id} ← ${full.slice(0, 7)}`);
    const head = ((await gitOut('log', '-n', '1', '--format=%H', '--', entryFile(id))) || '').trim();
    const cur = store.get(id);
    return { ok: true, id, restored_from: full.slice(0, 7), version: head.slice(0, 7), entry: { id, title: cur.meta.title, project: cur.meta.project || '', subject: cur.meta.subject || '', updated: cur.meta.updated } };
  }

  // ---- 对话存成记忆 ----
  const mountedOrFail = () => { if (!conv().mounted()) throw new HttpError(503, '对话存档盘没挂上，暂时查不了。'); };
  function checkDate(date, label = 'date') {
    const d = typeof date === 'string' && DATE_RE.test(date) ? new Date(`${date}T00:00:00Z`) : null;
    if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) throw bad(`${label} 必须是 YYYY-MM-DD 的有效日期`);
    return date;
  }
  // 会话必须存在、浏览者看得见（会话任何一天的工作日志归在被隐藏的项目里，就当不存在）、date 必须是它有消息的某一天
  function sessionOf(ref, date, viewer) {
    if (typeof ref !== 'string' || !REF_RE.test(ref)) throw bad('ref 必须是 8 位小写十六进制的会话编号');
    checkDate(date);
    mountedOrFail();
    const c = conv();
    const idx = c.index();
    const key = Object.keys(idx).find((k) => c.refOf(k) === ref);
    if (!key || !scopeOf(viewer).session(key)) throw new HttpError(404, '没有这个会话'); // 口径同 /console/api/conv/<ref>：访问控制那套对会话的归属判断
    const e = idx[key];
    const projects = [];
    for (const d of Object.keys(e.days || {}).sort()) { const p = c.journal().get(d)?.[key]?.project; if (p) projects.push({ d, p }); }
    if (projects.some(({ p }) => !visibleTo(viewer, p))) throw new HttpError(404, '没有这个会话');
    if (!e.days?.[date]) throw bad(`这个会话在 ${date} 没有消息`);
    const project = projects.find((x) => x.d === date)?.p || projects[projects.length - 1]?.p || '';
    return { key, e, project };
  }

  function convHint(q, viewer) {
    const s = sessionOf(q.get('ref'), q.get('date'), viewer);
    return { ref: q.get('ref'), date: q.get('date'), project: s.project, title: s.e.title || '' };
  }

  async function fromConv(body, viewer) {
    if (!isObj(body)) throw bad('请求体必须是 JSON 对象');
    needWrite(viewer);
    sessionOf(body.ref, body.date, viewer);
    const trailer = `\n\n${sourceLine(body.ref, body.date)}`;
    const title = typeof body.title === 'string' ? body.title : '';
    const text = (typeof body.body === 'string' ? body.body : '').trim() || title.trim();
    if (text.length + trailer.length > BODY_MAX) throw bad(`正文太长（最多 ${BODY_MAX - trailer.length} 字，出处行占 ${trailer.length} 字）`);
    let res;
    try {
      res = await remember({ type: body.type, title, body: `${text}${trailer}`, project: body.project, subject: body.subject }, { device: viewer, role: 'device', client: 'console' });
    } catch (err) {
      if (err instanceof UserError) throw bad(err.message);
      throw err;
    }
    const id = res.entry.meta.id;
    audit(viewer, 'memory-from-conv', `${id} ← ${body.ref} ${body.date}`);
    return { ok: true, id, source: { ref: body.ref, date: body.date }, superseded: res.superseded || [] };
  }

  // ---- 摘要 ----
  const NOT_TOOLS = new Set(['cli', 'test', 'unknown', 'browser', 'console']);
  // 每台设备上"有这个智能体"：心跳里的接线和来源、它写过的原生/主动记忆、对话存档里的会话
  function deviceTools() {
    const tokens = loadTokens().devices || {};
    const hb = readJSON(heartbeatFile(), {});
    const map = new Map(Object.entries(tokens).filter(([, d]) => (d.role || 'device') === 'device').map(([name]) => [name, new Set([...Object.keys(hb[name]?.wiring || {}), ...Object.keys(hb[name]?.sources || {})])]));
    for (const e of store.values()) if ((e.meta.origin === 'native' || e.meta.origin === 'explicit') && map.has(e.meta.author)) map.get(e.meta.author).add(e.meta.client);
    if (conv().mounted()) for (const s of Object.values(conv().index())) if (map.has(s.device)) map.get(s.device).add(s.tool);
    for (const set of map.values()) for (const n of NOT_TOOLS) set.delete(n);
    return map;
  }

  let dupCache = { sig: '', groups: [] };
  function dupsOf(entries) {
    const sig = crypto.createHash('sha1').update(entries.map((e) => `${e.meta.id}:${e.meta.project || ''}:${e.meta.title}`).join('|')).digest('hex');
    if (dupCache.sig !== sig) {
      dupCache = { sig, groups: dupGroups(entries.map((e) => ({ id: e.meta.id, title: e.meta.title, cls: sectionOf(e.meta.type), project: e.meta.project || '' }))) };
    }
    return dupCache.groups;
  }
  const SECTION = { preference: 0, feedback: 0, status: 1, decision: 2, pitfall: 2, fact: 3, reference: 3 };
  const sectionOf = (type) => SECTION[type] ?? 3;

  function rulesRaw() {
    const r = readJSON(rulesFile(), {});
    const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
    return { pin: list(r?.pin), exclude: list(r?.exclude) };
  }

  // 预览里去掉浏览者看不见的项目：每条记忆占一行，直接删行；"最近 3 天在做什么"那节按「项目：…」分段，删掉被隐藏项目的段
  function redactText(text, info, hiddenEntries, hidden, scope) {
    let out = text;
    for (const id of hiddenEntries) {
      const line = info.lines.get(id);
      if (line) out = out.replace(`${line}\n`, '');
    }
    if (hidden.size && info.recentBlock && out.includes(info.recentBlock)) {
      // "最近 3 天"整节按浏览者的可见范围重新生成（会话归属的口径同访问控制）
      const head = info.recentBlock.slice(0, info.recentBlock.indexOf('\n', 1) + 1);
      const scoped = conv().recentSection(1800, 3, scope);
      out = out.replace(info.recentBlock, scoped ? `${head}${scoped}` : '');
    }
    return out;
  }

  function digestView(q, viewer) {
    const tools = deviceTools();
    const devices = [...tools.keys()];
    if (!devices.length) throw bad('还没有登记任何设备');
    const device = q.get('device') || (tools.has(viewer) ? viewer : devices[0]);
    if (!tools.has(device)) throw bad(`没有设备 ${device}`);
    const known = tools.get(device);
    const tool = q.get('tool') || (known.has('claude-code') ? 'claude-code' : [...known].sort()[0]) || 'claude-code';
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(tool) || (known.size || q.get('tool')) && !known.has(tool)) throw bad(`设备 ${device} 上没有这个智能体：${tool}`);

    const info = {};
    const text = digest({ device, role: 'device', client: tool }, tool, info);
    const rules = rulesRaw();
    const pins = new Set(rules.pin); const excl = new Set(rules.exclude);
    const hidden = new Set(hiddenOf(viewer) || []);
    const seen = info.active.filter((e) => visibleTo(viewer, e.meta.project));
    const hiddenIds = info.active.filter((e) => !visibleTo(viewer, e.meta.project)).map((e) => e.meta.id);
    const dup = new Map();
    dupsOf(seen.filter((e) => !excl.has(e.meta.id))).forEach((g, gi) => g.forEach((id) => dup.set(id, gi + 1)));
    const body = new Map(seen.map((e) => [e.meta.id, e.body]));
    let items = seen.map((e) => {
      const id = e.meta.id;
      const why = vagueReason(e.meta.title, body.get(id));
      const flags = [...(why ? ['vague'] : []), ...(dup.has(id) ? ['dup'] : [])];
      return {
        id, title: e.meta.title, type: e.meta.type, project: e.meta.project || '', section: info.sectionOf[e.meta.type] ?? 3, updated: e.meta.updated,
        flags, ...(why ? { vague_why: why } : {}), ...(dup.has(id) ? { dup: dup.get(id) } : {}),
        pinned: pins.has(id), excluded: excl.has(id), listed: info.listed.has(id),
      };
    });
    const order = new Map(seen.map((e, i) => [e.meta.id, i]));
    items = items.sort((a, b) => a.section - b.section || Number(b.pinned) - Number(a.pinned) || order.get(a.id) - order.get(b.id));
    const listed = items.filter((x) => x.listed).length;
    return {
      device, tool,
      options: {
        devices: devices.map((name) => ({ name, label: (CFG.device_labels || {})[name] || '', tools: [...tools.get(name)].sort() })),
      },
      text: redactText(text, info, hiddenIds, hidden, scopeOf(viewer)),
      budget: { limit: CFG.digest_budget, used: info.bytes },
      omitted: info.omitted,
      titles: info.titles,
      counts: {
        active: items.length, listed, unlisted: items.length - listed, omitted: info.omitted,
        pinned: items.filter((x) => x.pinned).length, excluded: items.filter((x) => x.excluded).length,
        vague: items.filter((x) => x.flags.includes('vague')).length, dup_groups: new Set(items.filter((x) => x.dup).map((x) => x.dup)).size,
        dup_items: items.filter((x) => x.dup).length,
      },
      items,
    };
  }

  const ACTIONS = new Set(['pin', 'unpin', 'exclude', 'include']);
  function setRule(body, viewer) {
    if (!isObj(body)) throw bad('请求体必须是 JSON 对象');
    needWrite(viewer);
    if (typeof body.id !== 'string' || !ID_RE.test(body.id)) throw bad('id 不对');
    if (!ACTIONS.has(body.action)) throw bad('action 只能是 pin、unpin、exclude、include 之一');
    const e = entryOf(body.id, viewer);
    if ((body.action === 'pin' || body.action === 'exclude') && e.meta.state !== 'active') throw bad('只有有效的记忆能置顶或排除出摘要');
    const cur = rulesRaw();
    const pin = new Set(cur.pin); const exclude = new Set(cur.exclude);
    if (body.action === 'pin') { exclude.delete(body.id); pin.add(body.id); }
    else if (body.action === 'exclude') { pin.delete(body.id); exclude.add(body.id); }
    else if (body.action === 'unpin') pin.delete(body.id);
    else exclude.delete(body.id);
    // 只有有效的记忆才需要规则：作废、被取代的自动清掉（也就不占置顶名额）
    const live = (id) => store.get(id)?.meta.state === 'active';
    const next = { pin: [...pin].filter(live), exclude: [...exclude].filter(live) };
    if (next.pin.length > MAX_PINS) throw bad(`最多置顶 ${MAX_PINS} 条，先取消几条再置顶`);
    fs.mkdirSync(CFG.state, { recursive: true });
    const tmp = `${rulesFile()}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 1)}\n`);
    fs.renameSync(tmp, rulesFile());
    audit(viewer, 'digest-rule', `${body.action} ${body.id}`);
    return { ok: true, id: body.id, pinned: pin.has(body.id), excluded: exclude.has(body.id), pin_count: next.pin.length, exclude_count: next.exclude.length };
  }

  // ---- 路由 ----
  async function handle(req, res, url, sub, viewer) {
    let m;
    if ((m = /^memory\/([^/]+)\/history$/.exec(sub))) { only(req, 'GET'); send(res, 200, await history(idOf(m[1]), viewer)); return true; }
    if ((m = /^memory\/([^/]+)\/history\/([^/]+)$/.exec(sub))) {
      only(req, 'GET');
      const sha = decode(m[2]);
      const id = idOf(m[1]);
      if (!SHA_RE.test(sha)) throw bad('sha 不对（7–40 位小写十六进制）');
      send(res, 200, await versionDiff(id, sha, viewer));
      return true;
    }
    if ((m = /^memory\/([^/]+)\/restore$/.exec(sub))) { only(req, 'POST'); send(res, 200, await restore(idOf(m[1]), await readBody(req), viewer)); return true; }
    if (sub === 'memory/from-conv') { only(req, 'POST'); send(res, 200, await fromConv(await readBody(req), viewer)); return true; }
    if (sub === 'memory/conv-hint') { only(req, 'GET'); send(res, 200, convHint(url.searchParams, viewer)); return true; }
    if (sub === 'digest') { only(req, 'GET'); send(res, 200, digestView(url.searchParams, viewer)); return true; }
    if (sub === 'digest/rule') { only(req, 'POST'); send(res, 200, setRule(await readBody(req), viewer)); return true; }
    return undefined;
  }

  return { handle };
}
