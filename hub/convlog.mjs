/* 对话存档 + 工作日志（中心 0.7）
 *
 * - 设备把所有智能体的对话（只留用户和助手说的话，设备端已打码，这里再打一遍）增量上传，
 *   原文长期存在机械盘 CFG.archive_dir（默认 /srv/agent-memory/archive，建议放机械盘）。
 * - 每个会话每天算一段；抽取机给每段写一两句工作日志，存在记忆仓库 journal/YYYY-MM/YYYY-MM-DD.json（跟记忆一起进 git、一起备份）。
 * - 查询：timeline（哪天干了什么）、search（搜原文）、get（读原文）；摘要里加"最近 3 天在做什么"。
 * - 时间一律按北京时间分天。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const TZ = 8 * 3600e3;
export const localDay = (iso) => new Date(Date.parse(iso) + TZ).toISOString().slice(0, 10);
const localTime = (iso) => new Date(Date.parse(iso) + TZ).toISOString().slice(11, 16);
const WEEK = '日一二三四五六';
const weekday = (d) => `周${WEEK[new Date(`${d}T12:00:00Z`).getUTCDay()]}`;
const short = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 150);
// 临时目录里的会话基本是脚本拉起的（测评、批处理）：不写日志、不进时间线（原文仍在存档里，搜得到）
export const AUTO_CWD = /^(\/tmp\/|\/private\/tmp\/|\/var\/folders\/|[A-Za-z]:\\Users\\[^\\]+\\AppData\\Local\\Temp\\)/;
const TOOL_LABEL = {
  'claude-code': 'Claude Code', codex: 'Codex', workbuddy: 'WorkBuddy', codebuddy: 'CodeBuddy', hermes: 'Hermes',
  openclaw: 'OpenClaw', opencode: 'OpenCode', gemini: 'Gemini', qwen: 'Qwen',
};

export function createConvLog(ctx) {
  const { CFG, nowIso, redactSecrets, findSecret, UserError, readJSON, commit, serial } = ctx;
  const root = CFG.archive_dir || '/srv/agent-memory/archive';
  const indexFile = path.join(root, 'conv-index.json');
  const journalRoot = path.join(CFG.repo, 'journal');
  const metaFile = path.join(CFG.state, 'convlog.json');
  const mounted = () => fs.existsSync(path.join(root, '.am-archive'));
  let index = mounted() ? readJSON(indexFile, {}) : {};
  const meta = readJSON(metaFile, {});

  // ------------------------------------------------------------ index ----

  let saveTimer = null;
  function writeIndex() {
    saveTimer = null;
    if (!mounted()) return;
    const tmp = `${indexFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(index));
    fs.renameSync(tmp, indexFile);
  }
  function saveIndex() { if (!saveTimer) saveTimer = setTimeout(writeIndex, 3000); }
  function flush() { if (saveTimer) { clearTimeout(saveTimer); writeIndex(); } }
  function saveMeta() { fs.writeFileSync(metaFile, JSON.stringify(meta)); }

  const keyOf = (device, tool, sid) => `${device}__${tool}__${sid}`.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200);
  const refOf = (key) => crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
  let refMap = null;
  function resolve(ref) {
    const r = String(ref || '').trim().replace(/^ref:/, '');
    if (index[r]) return r;
    if (!refMap || !refMap.has(r)) refMap = new Map(Object.keys(index).map((k) => [refOf(k), k]));
    return refMap.get(r) || null;
  }
  const validTs = (t) => {
    const n = Date.parse(t);
    return Number.isFinite(n) && n > Date.parse('2020-01-01') && n < Date.now() + 86400e3 ? new Date(n).toISOString() : undefined;
  };

  // 设备增量上传：base 必须等于中心已有条数，否则回告实际条数让设备对齐；replace 时整份重来
  function append(p, who) {
    recentCache = null;
    if (!mounted()) throw new UserError('对话存档盘没挂上，稍后再传');
    const device = who.role === 'admin' && p.device ? String(p.device).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40) : who.device;
    const tool = String(p.tool || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40);
    const sid = String(p.session_id || '').slice(0, 160);
    if (!device || !tool || !sid) throw new UserError('缺少 tool 或 session_id');
    const key = keyOf(device, tool, sid);
    let e = index[key];
    // 设备后来判定不该存的会话（脚本自动跑的、临时目录里的）：连同已写的日志一起删掉
    if (p.drop) return e ? drop(key) : { ok: true, dropped: false };
    const have = e?.n || 0;
    // 历史导入的会话：设备端还有原文时整份替换（导入件的消息切法和设备端不同，不能接着续）
    if (e?.legacy && !p.legacy && !p.replace) return { ok: false, count: have, replace: true };
    if (p.legacy && e && !e.legacy) return { ok: true, count: have, skipped: '设备已上传过' };
    if (!p.replace && p.base !== have) return { ok: false, count: have };
    const msgs = (Array.isArray(p.messages) ? p.messages : []).slice(0, 5000)
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && m.text.trim())
      .map((m) => ({ role: m.role, text: redactSecrets(m.text.slice(0, 40000)), ts: validTs(m.ts) }));
    const rel = path.join('conv', safe(device), safe(tool), `${safe(sid)}.jsonl`);
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (p.replace || !e) {
      e = { device, tool, sid, file: rel, n: 0, chars: 0, days: {}, first: null, last: null };
      fs.writeFileSync(file, '');
    }
    e.legacy = Boolean(p.legacy);
    // 旧导出件里有的没有逐条时间，是按开始、结束时间均匀摊的：只认日期，不显示几点
    if (p.approx_ts) e.approx = true; else delete e.approx;
    if (p.title) e.title = redactSecrets(String(p.title).replace(/\s+/g, ' ').trim().slice(0, 120));
    if (p.cwd) e.cwd = String(p.cwd).slice(0, 300);
    if (validTs(p.started)) e.started = validTs(p.started);
    let lastTs = e.last || e.started || nowIso();
    const lines = [];
    for (const m of msgs) {
      const ts = m.ts || lastTs;
      lastTs = ts;
      const d = localDay(ts);
      const day = (e.days[d] ||= { n: 0, chars: 0, users: 0, first: ts, last: ts });
      day.n++;
      day.chars += m.text.length;
      if (m.role === 'user') day.users++;
      if (ts < day.first) day.first = ts;
      if (ts > day.last) day.last = ts;
      e.n++;
      e.chars += m.text.length;
      if (!e.first || ts < e.first) e.first = ts;
      if (!e.last || ts > e.last) e.last = ts;
      lines.push(JSON.stringify({ r: m.role === 'user' ? 'u' : 'a', t: ts, x: m.text }));
    }
    if (lines.length) fs.appendFileSync(file, `${lines.join('\n')}\n`);
    if (lines.length) delete e.st; // 作息/字数统计作废，用到时再从存档算
    e.updated = nowIso();
    index[key] = e;
    refMap = null;
    // 旁边放一份元数据，索引坏了可以从存档重建
    fs.writeFileSync(`${file.slice(0, -6)}.meta.json`, JSON.stringify({ key, device, tool, sid, title: e.title, cwd: e.cwd, started: e.started, legacy: e.legacy, approx: e.approx }));
    saveIndex();
    return { ok: true, count: e.n };
  }

  function drop(key) {
    const e = index[key];
    delete index[key];
    refMap = null;
    for (const f of [path.join(root, e.file), path.join(root, `${e.file.slice(0, -6)}.meta.json`)]) fs.rmSync(f, { force: true });
    saveIndex();
    const dates = Object.keys(e.days).filter((d) => journal.get(d)?.[key]);
    if (!dates.length) return { ok: true, dropped: true };
    return serial(async () => {
      for (const d of dates) {
        const obj = journal.get(d);
        delete obj[key];
        fs.writeFileSync(journalFile(d), `${JSON.stringify(obj, null, 1)}\n`);
      }
      await commit(`journal: 删掉 ${key} 的 ${dates.length} 段（设备判定不是人在聊）`, 'agent-memory/journal', ['journal']);
      return { ok: true, dropped: true };
    });
  }

  function readMessages(e) {
    let raw = '';
    try { raw = fs.readFileSync(path.join(root, e.file), 'utf8'); } catch { return []; }
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try { const o = JSON.parse(line); out.push({ role: o.r === 'u' ? 'user' : 'assistant', ts: o.t, text: o.x }); } catch { /* 坏行跳过 */ }
    }
    return out;
  }

  // 索引丢了：从存档旁的 meta.json + jsonl 重建
  function rebuildIndex() {
    const next = {};
    const convDir = path.join(root, 'conv');
    const walkDir = (d) => { let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } return ents.flatMap((x) => (x.isDirectory() ? walkDir(path.join(d, x.name)) : [path.join(d, x.name)])); };
    for (const f of walkDir(convDir).filter((x) => x.endsWith('.meta.json'))) {
      const m = readJSON(f, null);
      if (!m?.key) continue;
      const e = { device: m.device, tool: m.tool, sid: m.sid, title: m.title, cwd: m.cwd, started: m.started, legacy: m.legacy, approx: m.approx, file: path.relative(root, `${f.slice(0, -10)}.jsonl`), n: 0, chars: 0, days: {}, first: null, last: null };
      for (const msg of readMessages(e)) {
        const d = localDay(msg.ts);
        const day = (e.days[d] ||= { n: 0, chars: 0, users: 0, first: msg.ts, last: msg.ts });
        day.n++; day.chars += msg.text.length; if (msg.role === 'user') day.users++;
        if (msg.ts < day.first) day.first = msg.ts;
        if (msg.ts > day.last) day.last = msg.ts;
        e.n++; e.chars += msg.text.length;
        if (!e.first || msg.ts < e.first) e.first = msg.ts;
        if (!e.last || msg.ts > e.last) e.last = msg.ts;
      }
      next[m.key] = e;
    }
    index = next;
    refMap = null;
    writeIndex();
    return Object.keys(index).length;
  }
  if (mounted() && !Object.keys(index).length && fs.existsSync(path.join(root, 'conv'))) rebuildIndex();

  // ---------------------------------------------------------- journal ----

  const journal = new Map(); // date -> { key: segment }
  const journalFile = (d) => path.join(journalRoot, d.slice(0, 7), `${d}.json`);
  function loadJournal() {
    let months = [];
    try { months = fs.readdirSync(journalRoot); } catch { return; }
    for (const m of months) {
      let files = [];
      try { files = fs.readdirSync(path.join(journalRoot, m)); } catch { continue; }
      for (const f of files) if (f.endsWith('.json')) journal.set(f.slice(0, 10), readJSON(path.join(journalRoot, m, f), {}));
    }
  }
  loadJournal();

  const today = () => localDay(nowIso());

  // 等着写日志的段：今天以前的段（或今天已经闲了 90 分钟的段），没写过或写完之后又多了消息
  function pending({ limit = 50, includeToday = false } = {}) {
    const t = today();
    const out = [];
    for (const [key, e] of Object.entries(index)) {
      if (AUTO_CWD.test(e.cwd || '')) continue;
      for (const [d, day] of Object.entries(e.days)) {
        if (d > t || !day.users) continue;
        if (d === t && !(includeToday && Date.now() - Date.parse(day.last) > 90 * 60e3)) continue;
        const j = journal.get(d)?.[key];
        if (j && j.n >= day.n) continue;
        out.push({ key, date: d, device: e.device, tool: e.tool, title: e.title || '', n: day.n, chars: day.chars, redo: Boolean(j) });
      }
    }
    // 新的先写（最近的工作最常被问到），补历史排在后面
    out.sort((a, b) => b.date.localeCompare(a.date) || a.key.localeCompare(b.key));
    return { total: out.length, items: out.slice(0, Math.min(Math.max(limit, 1), 2000)) };
  }

  function item(key, date) {
    const e = index[key];
    if (!e || !e.days[date]) return null;
    const msgs = readMessages(e).filter((m) => localDay(m.ts) === date);
    // 同一会话之前几天的日志，帮模型接上下文
    const prev = Object.keys(e.days).filter((d) => d < date).sort().slice(-3)
      .map((d) => journal.get(d)?.[key]).filter(Boolean).map((j) => `${j.date}：${j.summary}`);
    return { key, date, device: e.device, tool: e.tool, title: e.title || '', cwd: e.cwd || '', started: e.started || e.first, prev, messages: msgs };
  }

  const PROJECT_RE = /^[a-z0-9][a-z0-9._-]{0,40}$/;
  async function result(p, who) {
    const items = Array.isArray(p.items) ? p.items.slice(0, 200) : [];
    return serial(async () => {
      const touched = new Set();
      let n = 0;
      for (const it of items) {
        const e = index[it.key];
        const day = e?.days[it.date];
        if (!day) continue;
        const clean = (s, max) => redactSecrets(String(s || '').replace(/\s+/g, ' ').trim()).slice(0, max);
        const summary = clean(it.summary, 300);
        if (!summary) continue;
        const points = (Array.isArray(it.points) ? it.points : []).map((x) => clean(x, 160)).filter(Boolean).slice(0, 6);
        const project = PROJECT_RE.test(String(it.project || '').toLowerCase().trim()) ? String(it.project).toLowerCase().trim() : '';
        const seg = {
          date: it.date, device: e.device, tool: e.tool, title: e.title || '', project,
          first: day.first, last: day.last, n: Math.min(Number(it.n) || day.n, day.n), summary, points,
          status: clean(it.status, 20), at: nowIso(),
        };
        if (findSecret([summary, ...points].join('\n'))) continue;
        const obj = journal.get(it.date) || {};
        obj[it.key] = seg;
        journal.set(it.date, obj);
        touched.add(it.date);
        n++;
      }
      for (const d of touched) {
        const f = journalFile(d);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        const obj = journal.get(d);
        const sorted = Object.fromEntries(Object.entries(obj).sort((a, b) => String(a[1].first).localeCompare(String(b[1].first))));
        fs.writeFileSync(f, `${JSON.stringify(sorted, null, 1)}\n`);
      }
      if (n) {
        await commit(`journal: ${n} 段（${[...touched].sort().slice(0, 3).join('、')}${touched.size > 3 ? ' 等' : ''}）`, `${who.device}/journal`, ['journal']);
        meta.last_result = nowIso();
        saveMeta();
      }
      return { written: n };
    });
  }

  // --------------------------------------------------------- timeline ----

  function parseDate(s, fallback) {
    const v = String(s || '').trim();
    if (!v) return fallback;
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    if (/^\d{1,2}-\d{1,2}$/.test(v)) { const [m, d] = v.split('-'); return `${today().slice(0, 4)}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`; }
    if (v === '今天') return today();
    if (v === '昨天') return localDay(new Date(Date.now() - 86400e3).toISOString());
    return fallback;
  }

  // 一天里所有的段：写过日志的用日志，没写的用会话标题
  function segmentsOf(d) {
    const out = [];
    const j = journal.get(d) || {};
    for (const [key, e] of Object.entries(index)) {
      const day = e.days[d];
      if (!day || !day.users || AUTO_CWD.test(e.cwd || '')) continue;
      const seg = j[key];
      out.push({ key, ref: refOf(key), date: d, device: e.device, tool: e.tool, title: e.title || seg?.title || '', cwd: e.cwd || '',
        first: day.first, last: day.last, n: day.n, approx: Boolean(e.approx), project: seg?.project || '', summary: seg?.summary || '', points: seg?.points || [],
        status: seg?.status || '', stale: seg ? seg.n < day.n : false, written: Boolean(seg) });
    }
    for (const [key, seg] of Object.entries(j)) if (!index[key]) out.push({ key, ref: refOf(key), ...seg, written: true });
    return out.sort((a, b) => String(a.first).localeCompare(String(b.first)));
  }

  function timeline(args = {}) {
    const days = Math.min(Math.max(parseInt(args.days, 10) || 7, 1), 400);
    const to = parseDate(args.to || args.date, today());
    const from = parseDate(args.from || args.date, localDay(new Date(Date.parse(`${to}T12:00:00+08:00`) - (days - 1) * 86400e3).toISOString()));
    const words = String(args.query || '').toLowerCase().split(/\s+/).filter(Boolean);
    const proj = String(args.project || '').toLowerCase().trim();
    const dev = String(args.device || '').toLowerCase().trim();
    const tool = String(args.tool || '').toLowerCase().trim();
    const detail = args.detail !== false;
    const dates = new Set([...journal.keys()]);
    for (const e of Object.values(index)) for (const d of Object.keys(e.days)) dates.add(d);
    const list = [...dates].filter((d) => d >= from && d <= to).sort().reverse();
    const lines = [];
    let segs = 0;
    let truncated = false;
    for (const d of list) {
      const xs = segmentsOf(d).filter((s) => (!proj || s.project.includes(proj) || `${s.title} ${s.cwd}`.toLowerCase().includes(proj))
        && (!dev || s.device.toLowerCase().includes(dev)) && (!tool || s.tool.toLowerCase().includes(tool))
        && (!words.length || words.every((w) => `${s.title} ${s.summary} ${s.points.join(' ')} ${s.project} ${s.cwd}`.toLowerCase().includes(w))));
      if (!xs.length) continue;
      const block = [`## ${d}（${weekday(d)}）`];
      for (const s of xs) {
        const when = s.first && !s.approx ? `${localTime(s.first)}–${localTime(s.last)}` : '';
        const who = `${s.device}/${TOOL_LABEL[s.tool] || s.tool}`;
        if (s.summary) {
          block.push(`- ${when} ${s.project ? `[${s.project}] ` : ''}${s.summary}（${who}，「${short(s.title, 40)}」，${s.n} 条，ref:${s.ref}${s.stale ? '，日志之后还有新消息' : ''}）`);
          if (detail && s.points.length) block.push(`  · ${s.points.join('；')}`);
        } else {
          block.push(`- ${when} 「${short(s.title, 60)}」（${who}，${s.n} 条，ref:${s.ref}，日志还没写）`);
        }
        segs++;
      }
      const text = block.join('\n');
      if (lines.join('\n').length + text.length > 14000) { truncated = true; break; }
      lines.push(text);
    }
    if (!lines.length) return `${from} 到 ${to} 没有找到${proj || words.length || dev || tool ? '符合条件的' : ''}对话记录。（只收录接入以后的对话，更早的可以用导入脚本补。）`;
    return [
      `${from} 到 ${to}${proj ? `，项目 ${proj}` : ''}${dev ? `，设备 ${dev}` : ''}${tool ? `，工具 ${tool}` : ''}${words.length ? `，含「${words.join(' ')}」` : ''}：共 ${segs} 段会话（按天倒序；ref 可交给 conversation_get 读原文）`,
      '',
      ...lines,
      ...(truncated ? ['', '…范围太大，后面的没列出：缩小日期范围，或加 project / query 过滤。'] : []),
    ].join('\n');
  }

  // 摘要里的一节：最近 3 天按天、按项目归并，只用写好的日志和会话标题（不放条数，免得每 10 分钟都变）
  function recentSection(maxBytes = 1800, nDays = 3) {
    const out = [];
    for (let i = 0; i < nDays; i++) {
      const d = localDay(new Date(Date.now() - i * 86400e3).toISOString());
      const xs = segmentsOf(d);
      if (!xs.length) continue;
      const byProj = new Map();
      const loose = [];
      for (const s of xs) {
        if (s.summary && s.project) {
          const arr = byProj.get(s.project) || [];
          arr.push(s.summary);
          byProj.set(s.project, arr);
        } else if (s.summary) loose.push(s.summary);
        else if (s.title) loose.push(`「${short(s.title, 30)}」`);
      }
      const parts = [...byProj.entries()].map(([p, arr]) => `${p}：${arr.map((x) => short(x, 50)).slice(0, 3).join('；')}`);
      if (loose.length) parts.push(`其他：${[...new Set(loose)].map((x) => short(x, 36)).slice(0, 4).join('；')}`);
      out.push(`- ${d.slice(5)}（${weekday(d)}）${parts.join(' ｜ ')}`);
    }
    let block = '';
    for (const l of out) {
      const line = `${short(l, 600)}\n`;
      if (Buffer.byteLength(block + line) > maxBytes) break;
      block += line;
    }
    return block;
  }

  // ---------------------------------------------------- search / read ----

  // 搜原文：返回结构化结果（控制台接口用）；search() 把它排成给模型看的文本
  function searchData(args = {}) {
    if (!mounted()) return { error: '对话存档盘没挂上，暂时搜不了。' };
    const words = String(args.query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return { error: '请给关键词（空格分隔，全部命中）。' };
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 10, 1), 30);
    const from = parseDate(args.from, '0000-00-00');
    const to = parseDate(args.to, '9999-99-99');
    const dev = String(args.device || '').toLowerCase();
    const tool = String(args.tool || '').toLowerCase();
    const longest = [...words].sort((a, b) => b.length - a.length)[0];
    const g = spawnSync('grep', ['-rlFi', '--include=*.jsonl', '--', longest, path.join(root, 'conv')], { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 30000 });
    const byFile = new Map(Object.entries(index).map(([k, e]) => [path.resolve(root, e.file), k]));
    const hits = [];
    for (const f of (g.stdout || '').split('\n').filter(Boolean)) {
      const key = byFile.get(path.resolve(f.trim()));
      const e = key && index[key];
      if (!e || (dev && !e.device.toLowerCase().includes(dev)) || (tool && !e.tool.toLowerCase().includes(tool))) continue;
      const msgs = readMessages(e);
      const found = [];
      msgs.forEach((m, i) => {
        const d = localDay(m.ts);
        if (d < from || d > to || found.length >= 3) return;
        if (args.role && m.role !== args.role) return;
        const low = m.text.toLowerCase();
        if (!words.every((w) => low.includes(w))) return;
        const at = low.indexOf(longest);
        const s = Math.max(0, at - 70);
        found.push({ i: i + 1, ts: m.ts, role: m.role, snip: `${s ? '…' : ''}${m.text.slice(s, at + longest.length + 110).replace(/\s+/g, ' ')}…` });
      });
      if (found.length) hits.push({ key, e, found, last: found[found.length - 1].ts });
    }
    hits.sort((a, b) => String(b.last).localeCompare(String(a.last)));
    return {
      words, limit, total: hits.length,
      hits: hits.slice(0, limit).map((h) => ({
        ref: refOf(h.key), device: h.e.device, tool: h.e.tool, tool_label: TOOL_LABEL[h.e.tool] || h.e.tool, title: short(h.e.title, 50), last: h.last,
        found: h.found.map((f) => ({ index: f.i, ts: f.ts, day: localDay(f.ts), time: localTime(f.ts), role: f.role, snippet: f.snip })),
      })),
    };
  }

  function search(args = {}) {
    const r = searchData(args);
    if (r.error) return r.error;
    if (!r.total) return `原始对话里没搜到「${r.words.join(' ')}」。`;
    const lines = [`在 ${r.total} 个会话里搜到「${r.words.join(' ')}」${r.total > r.limit ? `，列出最近的 ${r.limit} 个` : ''}（用 conversation_get 加 ref 和日期读上下文）：`];
    r.hits.forEach((h, n) => {
      lines.push(`${n + 1}. ${h.device}/${h.tool_label}「${h.title}」ref:${h.ref}`);
      for (const f of h.found) lines.push(`   - ${f.day} ${f.time} 第 ${f.index} 条（${f.role === 'user' ? '用户' : '助手'}）：${f.snippet}`);
    });
    return lines.join('\n');
  }

  const blockOf = (m, body) => `[${m.index ?? m.i} ${m.role === 'user' ? '用户' : '助手'} ${localDay(m.ts).slice(5)} ${localTime(m.ts)}]\n${body}\n`;
  const CUT = '…（截断，加 full=true 看全文）';

  // 读一个会话：返回结构化结果（控制台接口用）；get() 把它排成给模型看的文本
  function getData(args = {}) {
    if (!mounted()) return { error: '对话存档盘没挂上，暂时读不了。' };
    const key = resolve(args.ref || args.key);
    if (!key) return { error: `没有这个会话：${args.ref || args.key || '（没给 ref）'}。ref 来自 memory_timeline 或 conversation_search 的结果。` };
    const e = index[key];
    let msgs = readMessages(e).map((m, i) => ({ ...m, i: i + 1 }));
    const date = parseDate(args.date, '');
    if (date) msgs = msgs.filter((m) => localDay(m.ts) === date);
    if (args.role === 'user' || args.role === 'assistant') msgs = msgs.filter((m) => m.role === args.role);
    const start = Math.max(parseInt(args.from, 10) || (msgs[0]?.i || 1), 1);
    const full = Boolean(args.full);
    const session = {
      ref: refOf(key), title: e.title || e.sid, device: e.device, tool: e.tool, tool_label: TOOL_LABEL[e.tool] || e.tool,
      first: e.first || null, last: e.last || null, n: e.n, cwd: e.cwd || '', legacy: Boolean(e.legacy),
      days: Object.entries(e.days).sort().map(([d, x]) => ({ date: d, n: x.n })),
      journal: Object.keys(e.days).sort().map((d) => journal.get(d)?.[key]).filter(Boolean).slice(-5).map((j) => ({ date: j.date, summary: j.summary })),
    };
    let size = headLines(session).join('\n').length;
    const out = [];
    let next = null;
    for (const m of msgs.filter((x) => x.i >= start)) {
      const max = full ? 20000 : (m.role === 'user' ? 4000 : 2500);
      const truncated = m.text.length > max;
      const body = truncated ? m.text.slice(0, max) : m.text;
      const len = blockOf(m, truncated ? body + CUT : body).length;
      if (size + len > 24000 && out.length) { next = m.i; break; }
      out.push({ index: m.i, role: m.role, ts: m.ts, day: localDay(m.ts), time: localTime(m.ts), text: body, truncated });
      size += len;
    }
    return { session, date: date || '', messages: out, next, empty: msgs.length === 0 };
  }

  function headLines(s) {
    const lines = [
      `会话「${s.title}」 ${s.device}/${s.tool_label} ref:${s.ref}`,
      `时间 ${s.first ? `${localDay(s.first)} ${localTime(s.first)}` : '?'} → ${s.last ? `${localDay(s.last)} ${localTime(s.last)}` : '?'}，共 ${s.n} 条${s.cwd ? `，目录 ${s.cwd}` : ''}${s.legacy ? '（来自旧知识库导出）' : ''}`,
      `按天：${s.days.map((x) => `${x.date.slice(5)} ${x.n} 条`).join('、')}`,
    ];
    if (s.journal.length) lines.push('日志：', ...s.journal.map((j) => `- ${j.date} ${j.summary}`));
    lines.push('');
    return lines;
  }

  function get(args = {}) {
    const r = getData(args);
    if (r.error) return r.error;
    const out = [...headLines(r.session)];
    for (const m of r.messages) out.push(blockOf(m, m.truncated ? m.text + CUT : m.text));
    if (r.next) out.push(`…后面还有，接着读用 from=${r.next}${r.date ? ` date=${r.date}` : ''}`);
    if (r.empty) out.push(r.date ? `${r.date} 这天这个会话没有消息。` : '（没有消息）');
    return out.join('\n');
  }

  // ------------------------------------------------------ 可视化大屏 ----

  let vizCache = null;
  // 全量汇总：每天的段数/消息数/各项目段数，机器→智能体→项目的流向，总数
  function vizData() {
    const sig = `${Object.keys(index).length}:${Object.values(index).reduce((a, e) => a + e.n, 0)}:${[...journal.values()].reduce((a, o) => a + Object.keys(o).length, 0)}:${meta.last_result || ''}`;
    if (vizCache?.sig === sig) return vizCache.data;
    const dates = new Set([...journal.keys()]);
    for (const e of Object.values(index)) for (const d of Object.keys(e.days)) dates.add(d);
    const days = {};
    const projTotal = {};
    const devTool = {};
    const toolProj = {};
    const devices = new Set();
    const tools = new Set();
    let msgs = 0;
    let chars = 0;
    let sessions = 0;
    for (const e of Object.values(index)) {
      if (AUTO_CWD.test(e.cwd || '')) continue;
      if (!Object.values(e.days).some((d) => d.users)) continue;
      sessions++;
      msgs += e.n;
      chars += e.chars;
      devices.add(e.device);
      tools.add(e.tool);
    }
    for (const d of [...dates].sort()) {
      const segs = segmentsOf(d);
      if (!segs.length) continue;
      const row = { s: segs.length, m: 0, u: 0, p: {} };
      for (const s of segs) {
        row.m += s.n || 0;
        const p = s.project || (s.summary ? '其他' : '未写日志');
        row.p[p] = (row.p[p] || 0) + 1;
        projTotal[p] = (projTotal[p] || 0) + 1;
        toolProj[`${s.tool}|${p}`] = (toolProj[`${s.tool}|${p}`] || 0) + 1;
        // 流向图两段都按"段"计，左右才守恒
        devTool[`${s.device}|${s.tool}`] = (devTool[`${s.device}|${s.tool}`] || 0) + 1;
      }
      days[d] = row;
    }
    const data = {
      generated: nowIso(),
      kpi: { sessions, messages: msgs, chars, days: Object.keys(days).length, devices: devices.size, tools: tools.size, journal_segments: [...journal.values()].reduce((a, o) => a + Object.keys(o).length, 0) },
      days,
      projects: Object.entries(projTotal).sort((a, b) => b[1] - a[1]).map(([p, n]) => ({ p, n })),
      devTool: Object.entries(devTool).map(([k, n]) => { const [a, b] = k.split('|'); return { a, b, n }; }),
      toolProj: Object.entries(toolProj).map(([k, n]) => { const [a, b] = k.split('|'); return { a, b, n }; }),
    };
    vizCache = { sig, data };
    return data;
  }

  // 每个会话的作息和字数统计（存进索引；有新消息时作废，用到时从存档重算，只算作废的那些）
  // hw：一周 168 个小时格（周一 0 点 = 0）里你发消息的次数；uc/ac：你/助手说的字数；night：凌晨 0–5 点你发的消息数；
  // late：最晚的一条（凌晨里最接近 5 点的）；short：你说的短句（≤8 字）次数
  function ensureStats(e) {
    if (e.st && e.st.nd) return e.st;
    const st = { hw: {}, uc: 0, ac: 0, un: 0, night: 0, late: null, short: {}, nd: {} };
    for (const m of readMessages(e)) {
      if (m.role !== 'user') { st.ac += m.text.length; continue; }
      st.uc += m.text.length;
      st.un++;
      const t = m.text.replace(/[\s。，,.!！?？~～…]+/g, '');
      if (t && t.length <= 8 && !/^\/|^\[/.test(t)) st.short[t] = (st.short[t] || 0) + 1;
      if (e.approx) continue;
      const local = new Date(Date.parse(m.ts) + TZ);
      const h = local.getUTCHours();
      const w = (local.getUTCDay() + 6) % 7; // 周一 = 0
      st.hw[w * 24 + h] = (st.hw[w * 24 + h] || 0) + 1;
      if (h < 5) {
        st.night++;
        st.nd[localDay(m.ts)] = 1;
        const mins = h * 60 + local.getUTCMinutes();
        if (!st.late || mins > st.late.mins) st.late = { mins, ts: m.ts, text: m.text.slice(0, 80) };
      }
    }
    st.short = Object.fromEntries(Object.entries(st.short).sort((a, b) => b[1] - a[1]).slice(0, 15));
    e.st = st;
    saveIndex();
    return st;
  }
  const liveEntries = () => Object.entries(index).filter(([, e]) => !AUTO_CWD.test(e.cwd || '') && Object.values(e.days).some((d) => d.users));

  // 大事记：日志里"上线、发布、交付、升级现场、合并 main、迁移完成"这类（前面带"未/没/待/尚未"的不算）
  const MILESTONE = /(上线|发布|交付|升级(?:到|至)?|合(?:入|并|进)\s*main|已合\s*main|迁移完成|搬到|部署到|正式启用|投入使用)/g;
  function milestones() {
    const out = [];
    const seen = new Set();
    for (const d of [...journal.keys()].sort()) {
      for (const [key, s] of Object.entries(journal.get(d))) {
        const e = index[key];
        if (e && AUTO_CWD.test(e.cwd || '')) continue;
        const text = s.summary || '';
        let ok = false;
        for (const m of text.matchAll(MILESTONE)) {
          const before = text.slice(Math.max(0, m.index - 3), m.index);
          if (!/[未没待否]|尚未|还未|无法/.test(before)) { ok = true; break; }
        }
        if (!ok) continue;
        const k = `${d}|${s.project || '其他'}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ date: d, project: s.project || '', summary: text, device: s.device, tool: s.tool, ref: refOf(key) });
      }
    }
    return out;
  }

  let extraCache = null;
  // 大屏的附加数据：作息打卡（全部 / 按智能体）、大事记、每天一两句代表性日志（回放用）
  function vizExtra() {
    vizData();
    const sig = vizCache.sig;
    if (extraCache?.sig === sig) return extraCache.data;
    const punch = { all: Array(168).fill(0), byTool: {} };
    for (const [, e] of liveEntries()) {
      const st = ensureStats(e);
      const arr = (punch.byTool[e.tool] ||= Array(168).fill(0));
      for (const [i, n] of Object.entries(st.hw)) { punch.all[i] += n; arr[i] += n; }
    }
    const highlights = {};
    for (const [d, o] of journal) {
      const xs = Object.entries(o).filter(([k]) => !index[k] || !AUTO_CWD.test(index[k].cwd || '')).map(([, s]) => s)
        .sort((a, b) => (b.n || 0) - (a.n || 0)).slice(0, 2).map((s) => ({ p: s.project || '', t: short(s.summary, 46) }));
      if (xs.length) highlights[d] = xs;
    }
    const data = { punch, milestones: milestones(), highlights };
    extraCache = { sig, data };
    return data;
  }

  // 搜一个词：哪些天、哪些会话提到过（日志、会话标题和原文都算）
  function searchDays(q) {
    const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5);
    if (!words.length) return { q: '', dates: {}, sessions: 0 };
    const dates = {};
    const sessions = new Set();
    const hit = (d, key) => { (dates[d] ||= new Set()).add(key); sessions.add(key); };
    for (const [d, o] of journal) {
      for (const [key, s] of Object.entries(o)) {
        const hay = `${s.summary} ${(s.points || []).join(' ')} ${s.title || ''} ${s.project || ''}`.toLowerCase();
        if (words.every((w) => hay.includes(w))) hit(d, key);
      }
    }
    if (mounted()) {
      const longest = [...words].sort((a, b) => b.length - a.length)[0];
      const g = spawnSync('grep', ['-rlFi', '--include=*.jsonl', '--', longest, path.join(root, 'conv')], { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 30000 });
      const byFile = new Map(Object.entries(index).map(([k, e]) => [path.resolve(root, e.file), k]));
      for (const f of (g.stdout || '').split('\n').filter(Boolean).slice(0, 1500)) {
        const key = byFile.get(path.resolve(f.trim()));
        const e = key && index[key];
        if (!e || AUTO_CWD.test(e.cwd || '')) continue;
        for (const m of readMessages(e)) {
          const low = m.text.toLowerCase();
          if (words.every((w) => low.includes(w))) hit(localDay(m.ts), key);
        }
      }
    }
    const out = Object.fromEntries(Object.entries(dates).sort().map(([d, s]) => [d, s.size]));
    return { q: words.join(' '), dates: out, sessions: sessions.size, days: Object.keys(out).length };
  }

  // 年度报告：一页页卡片要的数
  function wrapped() {
    const v = vizData();
    const ex = vizExtra();
    const daysSorted = Object.keys(v.days).sort();
    let uc = 0; let ac = 0; let un = 0; let night = 0; let late = null;
    const short = {};
    const toolSeg = {}; const devSeg = {};
    const nightDays = new Set();
    for (const [key, e] of liveEntries()) {
      const st = ensureStats(e);
      uc += st.uc; ac += st.ac; un += st.un; night += st.night;
      if (st.late && (!late || st.late.mins > late.mins)) late = { ...st.late, key, title: e.title, device: e.device, tool: e.tool };
      for (const d of Object.keys(st.nd)) nightDays.add(d);
      for (const [t, n] of Object.entries(st.short)) short[t] = (short[t] || 0) + n;
      for (const [d, x] of Object.entries(e.days)) if (x.users) { toolSeg[e.tool] = (toolSeg[e.tool] || 0) + 1; devSeg[e.device] = (devSeg[e.device] || 0) + 1; }
    }
    // 最长连续工作天数
    let best = { n: 0, from: '', to: '' }; let cur = { n: 0, from: '' }; let prev = '';
    for (const d of daysSorted) {
      const next = prev && localDay(new Date(Date.parse(`${prev}T12:00:00+08:00`) + 86400e3).toISOString());
      cur = prev && d === next ? { n: cur.n + 1, from: cur.from } : { n: 1, from: d };
      if (cur.n > best.n) best = { n: cur.n, from: cur.from, to: d };
      prev = d;
    }
    const busiest = daysSorted.reduce((a, d) => (!a || v.days[d].s > v.days[a].s ? d : a), '');
    const weekend = daysSorted.reduce((a, d) => a + ([0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay()) ? v.days[d].s : 0), 0);
    const totalSeg = daysSorted.reduce((a, d) => a + v.days[d].s, 0);
    const peakHour = ex.punch.all.reduce((a, n, i) => (n > ex.punch.all[a] ? i : a), 0);
    const hourTotals = Array(24).fill(0);
    ex.punch.all.forEach((n, i) => { hourTotals[i % 24] += n; });
    const projects = v.projects.filter((x) => x.p !== '其他' && x.p !== '未写日志').slice(0, 6).map((x) => {
      const ds = daysSorted.filter((d) => v.days[d].p[x.p]);
      const ms = ex.milestones.filter((m) => m.project === x.p);
      return { p: x.p, n: x.n, first: ds[0], last: ds[ds.length - 1], days: ds.length, milestones: ms.length, best: ms.slice(-2).map((m) => ({ date: m.date, summary: m.summary })) };
    });
    return {
      range: { from: daysSorted[0], to: daysSorted[daysSorted.length - 1], days: daysSorted.length },
      kpi: v.kpi, memories: null,
      words: { user: uc, assistant: ac, userMessages: un },
      busiest: busiest ? { date: busiest, s: v.days[busiest].s, m: v.days[busiest].m, top: (ex.highlights[busiest] || []), projects: Object.entries(v.days[busiest].p).sort((a, b) => b[1] - a[1]).slice(0, 4) } : null,
      streak: best,
      night: { messages: night, days: nightDays.size, late: late ? { time: `${String(Math.floor(late.mins / 60)).padStart(2, '0')}:${String(late.mins % 60).padStart(2, '0')}`, date: localDay(late.ts), text: late.text, title: late.title, device: late.device, tool: late.tool } : null },
      weekend: { segments: weekend, share: totalSeg ? weekend / totalSeg : 0 },
      peakHour: { weekday: Math.floor(peakHour / 24), hour: peakHour % 24, hours: hourTotals },
      tools: Object.entries(toolSeg).sort((a, b) => b[1] - a[1]),
      devices: Object.entries(devSeg).sort((a, b) => b[1] - a[1]),
      projects,
      milestones: { total: ex.milestones.length, recent: ex.milestones.slice(-6) },
      // 你最常说的短句（去掉单个字母数字、界面按钮这类）
      phrases: Object.entries(short).filter(([t]) => !/^[A-Za-z0-9]{1,3}$/.test(t) && !/^try ?again$/i.test(t)).sort((a, b) => b[1] - a[1]).slice(0, 12),
    };
  }

  // 星图：每个会话一个点（主项目、智能体、机器、开始日期、消息数、标题）
  function vizGalaxy() {
    const out = [];
    for (const [key, e] of liveEntries()) {
      const pc = {};
      for (const d of Object.keys(e.days)) { const p = journal.get(d)?.[key]?.project; if (p) pc[p] = (pc[p] || 0) + 1; }
      const p = Object.entries(pc).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
      out.push([refOf(key), p, e.tool, e.device, e.first ? localDay(e.first) : '', e.n, short(e.title || '', 40)]);
    }
    return { fields: ['ref', 'project', 'tool', 'device', 'date', 'n', 'title'], rows: out };
  }

  // 实时作战室：各机器各智能体最近一条消息的时间、在聊什么；最近动态
  function vizLive() {
    const now = Date.now();
    const byDev = {};
    const recent = [];
    for (const [key, e] of liveEntries()) {
      if (!e.last) continue;
      const age = (now - Date.parse(e.last)) / 60000;
      const d = (byDev[e.device] ||= {});
      const cur = d[e.tool];
      if (!cur || Date.parse(e.last) > Date.parse(cur.last)) {
        const p = journal.get(localDay(e.last))?.[key]?.project || '';
        d[e.tool] = { last: e.last, age: Math.round(age), title: short(e.title || '', 40), project: p, ref: refOf(key) };
      }
      if (age < 24 * 60) recent.push({ t: e.last, device: e.device, tool: e.tool, title: short(e.title || '', 44), ref: refOf(key), n: e.days[localDay(e.last)]?.n || 0 });
    }
    recent.sort((a, b) => String(b.t).localeCompare(String(a.t)));
    const t = today();
    let segs = 0; let msgs = 0;
    for (const [, e] of liveEntries()) { const x = e.days[t]; if (x?.users) { segs++; msgs += x.n; } }
    return { now: nowIso(), devices: byDev, recent: recent.slice(0, 14), today: { segments: segs, messages: msgs } };
  }

  // 近一段时间的消息时间：{ 设备: { 智能体: [毫秒时间戳…] } }，给拓扑页算读写流量和心跳条。
  // 只读"最后一条消息落在窗口里"的会话文件的尾部（存档是追加写的，时间基本递增），不够再加倍；
  // 不含自动任务会话（AUTO_CWD）。结果缓存 60 秒，有新上传就作废。
  let recentCache = null;
  function tailTimes(e, sinceMs) {
    let fd;
    try { fd = fs.openSync(path.join(root, e.file), 'r'); } catch { return []; }
    try {
      const size = fs.fstatSync(fd).size;
      let len = Math.min(size, 64 * 1024);
      for (;;) {
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        let text = buf.toString('utf8');
        if (len < size) { const nl = text.indexOf('\n'); text = nl < 0 ? '' : text.slice(nl + 1); }
        const ts = [];
        for (const line of text.split('\n')) {
          if (!line) continue;
          try { const ms = Date.parse(JSON.parse(line).t); if (Number.isFinite(ms)) ts.push(ms); } catch { /* 坏行跳过 */ }
        }
        if (len >= size || (ts.length && Math.min(...ts) < sinceMs)) return ts.filter((x) => x >= sinceMs);
        len = Math.min(size, len * 4);
      }
    } finally { fs.closeSync(fd); }
  }
  function recentMessages(sinceMs) {
    if (!recentCache || recentCache.since > sinceMs || Date.now() - recentCache.at > 60e3) {
      const since = sinceMs - 3600e3;
      const by = {};
      for (const e of Object.values(index)) {
        if (!e.last || Date.parse(e.last) < since || AUTO_CWD.test(e.cwd || '')) continue;
        const ts = tailTimes(e, since);
        if (ts.length) ((by[e.device] ||= {})[e.tool] ||= []).push(...ts);
      }
      recentCache = { at: Date.now(), since, by };
    }
    const out = {};
    for (const [d, tools] of Object.entries(recentCache.by)) {
      for (const [t, xs] of Object.entries(tools)) {
        const ys = xs.filter((x) => x >= sinceMs);
        if (ys.length) (out[d] ||= {})[t] = ys;
      }
    }
    return out;
  }

  // 近几天每个项目有哪些设备、哪些智能体参与过（项目名取工作日志里写的；一个会话跨几天只算一次），给拓扑页的项目筛选用。
  // 最近有活动的项目在前。
  function projectMembers(days = 7) {
    const by = new Map();
    for (let i = 0; i < days; i++) {
      const d = localDay(new Date(Date.now() - i * 86400e3).toISOString());
      for (const [key, seg] of Object.entries(journal.get(d) || {})) {
        if (!seg.project) continue;
        const e = index[key];
        if (e && AUTO_CWD.test(e.cwd || '')) continue;
        const device = e?.device || seg.device; const tool = e?.tool || seg.tool; const last = e?.days[d]?.last || seg.last;
        if (!device || !tool || !last) continue;
        const p = by.get(seg.project) || { last: '', keys: new Set(), members: new Map() };
        by.set(seg.project, p);
        const mk = `${device}\n${tool}`;
        const m = p.members.get(mk) || { device, tool, keys: new Set(), last: '' };
        p.members.set(mk, m);
        p.keys.add(key); m.keys.add(key);
        if (last > p.last) p.last = last;
        if (last > m.last) m.last = last;
      }
    }
    return [...by.entries()].map(([name, p]) => ({
      name, sessions: p.keys.size, last: p.last,
      members: [...p.members.values()].map((m) => ({ device: m.device, tool: m.tool, sessions: m.keys.size, last: m.last })).sort((a, b) => (a.last < b.last ? 1 : -1)),
    })).sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : a.name.localeCompare(b.name)));
  }

  // 最近有新消息的会话（一个会话一条，时间是它最近一条消息），给拓扑页的事件流用
  function recentSessions(sinceMs) {
    const out = [];
    for (const [key, e] of Object.entries(index)) {
      if (!e.last || !e.n || Date.parse(e.last) <= sinceMs || AUTO_CWD.test(e.cwd || '')) continue;
      out.push({ ref: refOf(key), device: e.device, tool: e.tool, last: e.last, project: journal.get(localDay(e.last))?.[key]?.project || '' });
    }
    return out;
  }

  // 某一天的全部段（泳道图和详情用）
  function vizDay(date) {
    const d = parseDate(date, today());
    return { date: d, weekday: weekday(d), segments: segmentsOf(d).map((s) => ({
      device: s.device, tool: s.tool, title: s.title, first: s.first, last: s.last, approx: s.approx, n: s.n,
      project: s.project || '', summary: s.summary, points: s.points, status: s.status, ref: s.ref,
    })) };
  }

  // ------------------------------------------------------- reporting ----

  function stats() {
    const t = today();
    const y = localDay(new Date(Date.now() - 86400e3).toISOString());
    let sessions = 0; let chars = 0; let ySegs = 0; let tSegs = 0;
    const byDev = {};
    for (const e of Object.values(index)) {
      sessions++;
      chars += e.chars;
      byDev[`${e.device}/${e.tool}`] = (byDev[`${e.device}/${e.tool}`] || 0) + 1;
      if (e.days[y]?.users) ySegs++;
      if (e.days[t]?.users) tSegs++;
    }
    const pend = pending({ limit: 1 }).total;
    return { mounted: mounted(), sessions, chars, by_source: byDev, yesterday_segments: ySegs, today_segments: tSegs,
      journal_days: journal.size, journal_pending: pend, last_journal: meta.last_result || null };
  }

  function reportLines() {
    const s = stats();
    if (!s.sessions) return [];
    const y = localDay(new Date(Date.now() - 86400e3).toISOString());
    const ys = segmentsOf(y);
    const lines = [`· 对话存档：${s.sessions} 个会话（${(s.chars / 1e6).toFixed(1)}M 字）；昨天 ${ys.length} 段会话，日志已写 ${ys.filter((x) => x.written).length} 段；待写日志 ${s.journal_pending} 段`];
    const byProj = new Map();
    for (const x of ys) if (x.summary) byProj.set(x.project || '其他', [...(byProj.get(x.project || '其他') || []), x.summary]);
    for (const [p, arr] of byProj) lines.push(`  - ${p}：${arr.map((a) => short(a, 40)).slice(0, 3).join('；')}`);
    return lines;
  }

  function watchProblems() {
    const out = [];
    if (!mounted()) out.push({ key: 'archive:unmounted', text: '对话存档盘 /srv/agent-memory/archive 没挂上（看 .am-archive 标记文件），设备上传的对话会被拒收' });
    const s = stats();
    const oldPending = pending({ limit: 2000 }).items.filter((x) => x.date < localDay(new Date(Date.now() - 2 * 86400e3).toISOString())).length;
    if (oldPending && s.last_journal && Date.now() - Date.parse(s.last_journal) > 36 * 3600e3) {
      out.push({ key: 'journal:stalled', text: `工作日志 36 小时没写了，积压 ${oldPending} 段两天前的会话（worker 上的 agent-memory-journal 任务可能没在跑）` });
    }
    return out;
  }

  return { vizData, vizDay, vizExtra, vizGalaxy, vizLive, searchDays, wrapped, append, pending, item, result, timeline, recentSection, search, get, searchData, getData, stats, reportLines, watchProblems, flush, rebuildIndex, mounted, segmentsOf, recentMessages, recentSessions, projectMembers, readMessages, index: () => index, journal: () => journal, refOf };
}
