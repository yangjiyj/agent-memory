/* 用量洞察：待整理页新增的两栏（记忆缺口、冷记忆）的接口，挂在 /console/api/insight/ 下。
 *
 *   GET  insight/gaps              近 30 天搜过但 0 命中的查询（同义归并，带次数、最近一次、谁搜的）
 *   GET  insight/cold?days=30      近 days 天（7–365）没被读到过的有效记忆；记录还没攒够 days 天时只说明在攒数据
 *   POST insight/ignore            { key, ignored? } 忽略 / 恢复一条缺口（ignored 缺省为 true）；状态存在 state/insight-ignore.json
 *
 * 数据来自 usage.jsonl 里带新字段的行（hits 命中条数、ids 搜到的记忆 id、p 限定的项目、dur 耗时、err 出错），
 * 这些字段从 state/usage-meta.json 里的 since 起才有；之前的旧行没有，既不算 0 命中，也不算"读到"。
 * usageTail() 只留 8 天，不够看 30 天以上，这里自己增量扫一份（只留搜索行和"读到的 id"，不留整行）。
 *
 * "读到"的口径：tool:memory_get 和 cli:get 读取成功（d 是条目 id），以及 tool:memory_search / cli:search 的结果里带出的 id（ids）。
 * 出错的读取不算；控制台里人点开详情不算（那是整理，不是智能体在用）；digest / handoff / recent 里带出的条目不算。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DAY = 86400e3;
const WINDOW = 30 * DAY; // 缺口只看近 30 天
const SIM = 0.6; // 两个查询的特征集合 Jaccard ≥ 这个值就算同一类
const CHUNK = 8 << 20;
const FIRST_SCAN_MAX = 256 << 20; // 第一次最多读文件尾部这么多
const MAX_IGNORED = 500;

// 哪些工具的 0 命中算"缺口"，各自单列（不同语料不能互相抵掉）
const CORPUS = {
  'tool:memory_search': 'memory', 'cli:search': 'memory',
  'tool:conversation_search': 'conversation', 'cli:conversation_search': 'conversation',
  'tool:kb_search': 'kb', 'tool:memory_timeline': 'timeline',
};

// ---------------------------------------------------------------- 同义归并 ----
// 每个查询变成一组"特征"：NFKC 归一、转小写、标点当空格、去掉常见的虚词（失败/怎么/如何…）；
// 汉字连续段拆成相邻两字，其余（字母数字）按词；词序、标点、大小写都不影响。
// 特征集合 Jaccard ≥ 0.6 的归为一组：先按次数从多到少排，每个查询并入第一个够像的"组头"，否则自己当组头（不传递，不会越滚越远）。
const STOP_ZH = ['为什么', '怎么办', '怎么样', '有没有', '怎么', '怎样', '如何', '什么', '哪里', '是否', '能否', '可以', '一下', '关于', '相关', '查询', '搜索', '查找', '查看', '请问', '问题', '失败', '报错', '错误', '异常'];
const STOP_EN = new Set(['the', 'a', 'an', 'of', 'to', 'for', 'in', 'on', 'and', 'or', 'how', 'what', 'why', 'is', 'are', 'do', 'does', 'with', 'about', 'error', 'errors', 'failed', 'failure', 'issue', 'problem']);
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const isCjk = (s) => /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(s);

export function featuresOf(query) {
  const base = String(query).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (!base) return [];
  const toks = base.split(' ');
  const build = (strip) => {
    const set = new Set();
    for (let t of toks) {
      if (strip) {
        for (const w of STOP_ZH) t = t.split(w).join('');
        if (STOP_EN.has(t)) continue;
      }
      for (const m of t.matchAll(CJK)) {
        const s = m[0];
        if (!isCjk(s) || s.length <= 2) set.add(s);
        else for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
      }
    }
    return set;
  };
  let set = build(true);
  if (!set.size) set = build(false); // 全是虚词（如只搜"失败"）就照原样
  return [...set].sort();
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
}

const hash12 = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

export function createInsight(ctx, kit) {
  const { CFG, store, usageFile, usageMetaFile, readJSON, nowIso, send, readBody, redactSecrets } = ctx;
  const ignoreFile = () => path.join(CFG.state, 'insight-ignore.json');
  const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

  // ---------------------------------------------------------- 增量扫描 usage.jsonl ----
  // rows：近 30 天带 hits 的搜索行；reads：条目 id → 最近一次被读到的时间（不设窗口，只有 id 和一个数，很小）
  const S = { init: false, file: '', off: 0, skip: false, truncated: false, first: null, rows: [], reads: new Map(), trimmed: 0 };

  function take(line) {
    let o;
    try { o = JSON.parse(line); } catch { return; }
    const ms = Date.parse(o?.t);
    if (typeof o?.op !== 'string' || !Number.isFinite(ms)) return;
    if (S.first === null || ms < S.first) S.first = ms;
    if (!o.err) {
      let ids = null;
      if (o.op === 'tool:memory_get' || o.op === 'cli:get') ids = typeof o.d === 'string' && o.d.trim() ? [o.d.trim()] : null;
      else if ((o.op === 'tool:memory_search' || o.op === 'cli:search') && Array.isArray(o.ids)) ids = o.ids;
      for (const id of ids || []) if (typeof id === 'string' && (S.reads.get(id) ?? 0) < ms) S.reads.set(id, ms);
    }
    const corpus = CORPUS[o.op];
    if (corpus && Number.isInteger(o.hits) && o.hits >= 0 && typeof o.d === 'string' && o.d.trim() && ms >= Date.now() - WINDOW - DAY) {
      S.rows.push({ ms, device: String(o.device || ''), corpus, q: o.d.replace(/\s+/g, ' ').trim(), hits: o.hits, p: typeof o.p === 'string' ? o.p : '' });
    }
  }

  function scan() {
    const file = usageFile();
    let st;
    try { st = fs.statSync(file); } catch { S.init = false; S.rows = []; S.reads = new Map(); S.first = null; return; }
    if (!S.init || S.file !== file || st.size < S.off) {
      S.rows = []; S.reads = new Map(); S.first = null; S.file = file; S.init = true;
      S.off = Math.max(0, st.size - FIRST_SCAN_MAX);
      S.truncated = S.skip = S.off > 0;
    }
    if (st.size > S.off) {
      let fd;
      try {
        fd = fs.openSync(file, 'r');
        while (S.off < st.size) {
          const want = Math.min(CHUNK, st.size - S.off);
          const buf = Buffer.alloc(want);
          const n = fs.readSync(fd, buf, 0, want, S.off);
          if (n <= 0) break;
          let end = buf.lastIndexOf(10, n - 1) + 1;
          if (!end) { if (S.off + n >= st.size) break; end = n; } // 最后一行还没写完就等下次；整块没换行（不该有）就跳过
          let pos = 0;
          if (S.skip) { // 从文件尾部中间开始读：先丢掉第一行（可能是半行）
            const nl = buf.indexOf(10);
            S.skip = false;
            if (nl >= 0 && nl < end) pos = nl + 1; else { S.off += end; continue; }
          }
          for (const line of buf.toString('utf8', pos, end).split('\n')) if (line.includes('"dur":')) take(line); // 只有新格式的行带 dur
          S.off += end;
        }
      } catch { /* 读不了就用已有的 */ } finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    if (Date.now() - S.trimmed > 3600e3) { S.trimmed = Date.now(); const cut = Date.now() - WINDOW - DAY; S.rows = S.rows.filter((r) => r.ms >= cut); }
  }

  // 从哪一刻起有新字段：usage-meta.json 的 since；扫描只读了文件尾部时，以实际扫到的最早一行为准
  function sinceMs() {
    scan();
    let m = Date.parse(readJSON(usageMetaFile(), null)?.since);
    if (!Number.isFinite(m)) m = S.first;
    if (m !== null && S.truncated && S.first !== null) m = Math.max(m, S.first);
    return m;
  }

  // ---------------------------------------------------------- 忽略状态 ----
  const loadIgnore = () => { const j = readJSON(ignoreFile(), {}); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; };
  function saveIgnore(obj) {
    const keys = Object.keys(obj);
    if (keys.length > MAX_IGNORED) for (const k of keys.sort((a, b) => String(obj[a].at).localeCompare(String(obj[b].at))).slice(0, keys.length - MAX_IGNORED)) delete obj[k];
    const tmp = `${ignoreFile()}.tmp-${process.pid}`;
    try {
      fs.mkdirSync(CFG.state, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
      fs.renameSync(tmp, ignoreFile());
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw new kit.HttpError(500, `保存失败：${e.message}`);
    }
  }

  // ---------------------------------------------------------- 记忆缺口 ----
  // 返回所有（含被忽略的）组；每组带 key（组头的特征哈希）、memberKeys、memberFeats（给忽略匹配用）
  function buildGroups(viewer) {
    scan();
    const from = Date.now() - WINDOW;
    const byCorpus = new Map();
    for (const r of S.rows) {
      if (r.ms < from || (r.p && !kit.visibleTo(viewer, r.p))) continue;
      if (!byCorpus.has(r.corpus)) byCorpus.set(r.corpus, []);
      byCorpus.get(r.corpus).push(r);
    }
    const groups = [];
    for (const [corpus, rs] of byCorpus) {
      const keys = new Map();
      for (const r of rs) {
        const arr = featuresOf(r.q);
        if (!arr.length) continue;
        const fk = arr.join('\u0001');
        let k = keys.get(fk);
        if (!k) keys.set(fk, k = { arr, feat: new Set(arr), count: 0, last: 0, hitLast: 0, raw: new Map(), devs: new Set() });
        if (r.hits === 0) {
          k.count++; k.last = Math.max(k.last, r.ms); k.devs.add(r.device);
          const w = k.raw.get(r.q) || { count: 0, last: 0 };
          w.count++; w.last = Math.max(w.last, r.ms); k.raw.set(r.q, w);
        } else k.hitLast = Math.max(k.hitLast, r.ms);
      }
      const all = [...keys.values()];
      const zero = all.filter((k) => k.count > 0).sort((a, b) => b.count - a.count || b.last - a.last);
      const hit = all.filter((k) => k.hitLast > 0);
      const heads = [];
      for (const k of zero) {
        const h = heads.find((x) => jaccard(x.feat, k.feat) >= SIM);
        if (h) h.members.push(k); else heads.push({ feat: k.feat, arr: k.arr, members: [k] });
      }
      for (const h of heads) {
        const last = Math.max(...h.members.map((m) => m.last));
        if (hit.some((k) => k.hitLast > last && h.members.some((m) => jaccard(k.feat, m.feat) >= SIM))) continue; // 后来搜到了：已补上
        const raw = new Map();
        const devs = new Set();
        let count = 0;
        for (const m of h.members) {
          count += m.count;
          for (const d of m.devs) devs.add(d);
          for (const [text, w] of m.raw) { const x = raw.get(text) || { count: 0, last: 0 }; x.count += w.count; x.last = Math.max(x.last, w.last); raw.set(text, x); }
        }
        const variants = [...raw].map(([text, w]) => ({ text, count: w.count, last: w.last })).sort((a, b) => b.count - a.count || b.last - a.last);
        groups.push({
          corpus, key: `${corpus}:${hash12(h.arr.join(' '))}`, text: variants[0].text, count, last, devices: [...devs].sort(), variants,
          arr: h.arr, memberKeys: h.members.map((m) => `${corpus}:${hash12(m.arr.join(' '))}`), memberFeats: h.members.map((m) => m.feat),
        });
      }
    }
    return groups;
  }

  // 一组被哪条忽略记录盖住（组头或任何一种写法和被忽略的组头够像）
  const ignoredBy = (g, ign) => Object.entries(ign).find(([k, e]) => e?.corpus === g.corpus && Array.isArray(e.feat)
    && (k === g.key || g.memberKeys.includes(k) || g.memberFeats.some((f) => jaccard(f, new Set(e.feat)) >= SIM)))?.[0] || null;

  function gaps(viewer) {
    const since = sinceMs();
    const ign = loadIgnore();
    const shown = [];
    const hidden = new Set();
    for (const g of buildGroups(viewer)) {
      const by = ignoredBy(g, ign);
      if (by) hidden.add(by); else shown.push(g);
    }
    shown.sort((a, b) => b.count - a.count || b.last - a.last);
    return {
      now: nowIso(), since: since === null ? null : new Date(since).toISOString(), window_days: WINDOW / DAY,
      groups: shown.map((g) => ({
        key: g.key, corpus: g.corpus, text: redactSecrets(g.text), count: g.count, last: new Date(g.last).toISOString(),
        devices: g.devices.slice(0, 8), device_count: g.devices.length,
        variants: g.variants.slice(0, 8).map((v) => ({ text: redactSecrets(v.text), count: v.count })),
      })),
      ignored: [...hidden].map((k) => ({ key: k, corpus: ign[k].corpus, text: redactSecrets(ign[k].text || ''), at: ign[k].at || null })),
      ignored_count: hidden.size,
    };
  }

  function setIgnore(body, viewer) {
    if (!kit.isObj(body)) throw kit.bad('请求体必须是 JSON 对象');
    if (typeof body.key !== 'string' || !body.key.trim() || body.key.length > 200) throw kit.bad('key 必须是 1–200 个字的字符串');
    if (body.ignored !== undefined && typeof body.ignored !== 'boolean') throw kit.bad('ignored 必须是 true 或 false');
    const key = body.key.trim();
    const ign = loadIgnore();
    if (body.ignored === false) {
      if (!ign[key]) throw new kit.HttpError(404, '这一条没有被忽略过');
      const text = ign[key].text;
      delete ign[key];
      saveIgnore(ign);
      kit.audit(viewer, 'insight-restore', clip(redactSecrets(text), 60));
      return { ok: true };
    }
    const g = buildGroups(viewer).find((x) => (x.key === key || x.memberKeys.includes(key)) && !ignoredBy(x, ign));
    if (!g) throw new kit.HttpError(404, '没有这条缺口（可能已被忽略，或已经不在近 30 天里）');
    ign[g.key] = { corpus: g.corpus, text: g.text, feat: g.arr.slice(0, 80), at: nowIso() };
    saveIgnore(ign);
    kit.audit(viewer, 'insight-ignore', clip(redactSecrets(g.text), 60));
    return { ok: true };
  }

  // ---------------------------------------------------------- 冷记忆 ----
  function cold(viewer, days) {
    const since = sinceMs();
    const now = Date.now();
    const observed = since === null ? 0 : Math.max(0, (now - since) / DAY);
    const out = { now: nowIso(), since: since === null ? null : new Date(since).toISOString(), days, observed_days: Math.round(observed * 10) / 10, accumulating: since === null || observed < days, total: 0, shown: 0, groups: [] };
    if (out.accumulating) return out;
    const cut = now - days * DAY;
    const items = [];
    for (const e of store.values()) {
      if (e.meta.state !== 'active' || !kit.visibleTo(viewer, e.meta.project)) continue;
      const born = Math.max(Date.parse(e.meta.created) || 0, Date.parse(e.meta.updated) || 0);
      if (born > cut) continue; // 新写或新改的，还没到该被读到的时候
      const last = S.reads.get(e.meta.id) ?? null;
      if (last !== null && last >= cut) continue;
      items.push({ id: e.meta.id, type: e.meta.type, title: e.meta.title, project: e.meta.project || '', created: e.meta.created || null, updated: e.meta.updated || null, last_read: last === null ? null : new Date(last).toISOString(), born, lastMs: last });
    }
    // 没读到过的在前，其次是最后一次读到最早的，再按写的时间老的在前
    items.sort((a, b) => (a.lastMs !== null) - (b.lastMs !== null) || (a.lastMs ?? 0) - (b.lastMs ?? 0) || a.born - b.born);
    const top = items.slice(0, 300);
    const by = new Map();
    for (const { born, lastMs, project, ...it } of top) {
      if (!by.has(project)) by.set(project, []);
      by.get(project).push(it);
    }
    const countOf = new Map();
    for (const it of items) countOf.set(it.project, (countOf.get(it.project) || 0) + 1);
    out.total = items.length;
    out.shown = top.length;
    out.groups = [...by].map(([project, list]) => ({ project, count: countOf.get(project), items: list })).sort((a, b) => b.count - a.count || a.project.localeCompare(b.project));
    return out;
  }

  return {
    async handle(req, res, url, sub, viewer) {
      if (!sub.startsWith('insight/')) return undefined;
      const only = (m) => { if (req.method !== m) throw new kit.HttpError(405, `这个接口只支持 ${m}`); };
      if (sub === 'insight/gaps') { only('GET'); send(res, 200, gaps(viewer)); return true; }
      if (sub === 'insight/cold') {
        only('GET');
        const raw = url.searchParams.get('days');
        const days = kit.intIn(raw === null ? 30 : Number(raw), 7, 365, 'days');
        send(res, 200, cold(viewer, days));
        return true;
      }
      if (sub === 'insight/ignore') { only('POST'); send(res, 200, setIgnore(await readBody(req), viewer)); return true; }
      return undefined;
    },
  };
}
