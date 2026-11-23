/* 知识卡片查询（只读的长文档，按主题整理）。
 * 卡片目录由 home 定时同步到 VM（cards_dir）。只读，不改卡片。
 */

import fs from 'node:fs';
import path from 'node:path';

const READ_LINES = 400;
const MAX_CHARS = 28000;
const CACHE_MS = 5000;
const HEADING = /^(#{1,4})\s+(.+?)\s*$/;

export function createCards(rootDir) {
  let cacheAt = 0;
  let cacheDocs = null;

  function loadDocs() {
    const now = Date.now();
    if (cacheDocs && now - cacheAt < CACHE_MS) return cacheDocs;
    let entries = [];
    try {
      entries = fs.readdirSync(rootDir, { withFileTypes: true });
    } catch (err) {
      throw new Error(`卡片目录读不了（${rootDir}）：${err.message}`);
    }
    const docs = [];
    for (const e of entries) {
      if (!e.isFile() || !e.name.toLowerCase().endsWith('.md')) continue;
      const full = path.join(rootDir, e.name);
      try {
        const st = fs.statSync(full);
        const text = fs.readFileSync(full, 'utf8');
        docs.push({ name: e.name, size: st.size, mtime: st.mtimeMs, text, lines: text.split('\n') });
      } catch { /* 正在同步的文件，下次再读 */ }
    }
    docs.sort((a, b) => a.name.localeCompare(b.name));
    cacheDocs = docs;
    cacheAt = now;
    return docs;
  }

  function resolveDoc(card) {
    if (!card) throw new Error('缺少 card');
    const docs = loadDocs();
    const q = String(card).trim();
    let hits = docs.filter((d) => d.name === q || d.name === `${q}.md`);
    if (!hits.length) hits = docs.filter((d) => d.name.includes(q));
    if (!hits.length) {
      const base = path.basename(q).replace(/\.md$/, '');
      hits = docs.filter((d) => d.name.includes(base));
    }
    if (!hits.length) throw new Error(`没有卡片匹配「${card}」。现有：${docs.map((d) => d.name).slice(0, 40).join('、')}`);
    hits.sort((a, b) => a.name.length - b.name.length);
    return hits[0];
  }

  const headingsOf = (doc) => {
    const out = [];
    doc.lines.forEach((line, i) => {
      const m = HEADING.exec(line);
      if (m) out.push({ level: m[1].length, title: m[2].replace(/\s*#+\s*$/, ''), line: i + 1 });
    });
    return out;
  };
  const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n)}…`);
  const kb = (n) => `${(n / 1024).toFixed(1)}KB`;
  const ageOf = (ms) => {
    const h = (Date.now() - ms) / 3600e3;
    if (h < 1) return `${Math.max(1, Math.round(h * 60))} 分钟前`;
    if (h < 48) return `${Math.round(h)} 小时前`;
    return `${Math.round(h / 24)} 天前`;
  };

  function map() {
    const docs = loadDocs();
    const total = docs.reduce((a, d) => a + d.size, 0);
    return [
      `# 知识卡片：${docs.length} 张，共 ${kb(total)}`,
      '',
      '卡片是按主题追加的长文件，大的有几十万字：先 kb_sections 看目录，再 kb_read 读某一节，不要整卡读。',
      '卡片是只读的长文档；当前状态优先查 memory_search。',
      '',
      ...docs.map((d) => {
        const top = headingsOf(d).find((h) => h.level === 1);
        return `- ${d.name} | ${kb(d.size)} | ${d.lines.length} 行 | 更新于 ${ageOf(d.mtime)}${top ? ` | ${clip(top.title, 80)}` : ''}`;
      }),
    ].join('\n');
  }

  function search(args) {
    const q = String(args.query ?? '').trim().toLowerCase();
    if (!q) throw new Error('缺少 query');
    const ts = q.split(/\s+/).filter(Boolean);
    const limit = Math.min(20, Math.max(1, parseInt(args.limit, 10) || 8));
    const perCard = Math.min(20, Math.max(1, parseInt(args.hits, 10) || 6));
    const scored = [];
    for (const doc of loadDocs()) {
      const hay = doc.text.toLowerCase();
      if (!ts.every((t) => hay.includes(t))) continue;
      let count = 0;
      const samples = [];
      doc.lines.forEach((line, i) => {
        const low = line.toLowerCase();
        let n = 0;
        for (const t of ts) {
          let p = low.indexOf(t);
          while (p >= 0) { n++; p = low.indexOf(t, p + t.length); }
        }
        if (n) {
          count += n;
          if (samples.length < perCard) samples.push(`  L${i + 1}: ${clip(line.trim(), 240)}`);
        }
      });
      const sameLine = doc.lines.some((line) => { const low = line.toLowerCase(); return ts.every((t) => low.includes(t)); });
      scored.push({ doc, count, samples, sameLine });
    }
    scored.sort((a, b) => (a.sameLine !== b.sameLine ? (a.sameLine ? -1 : 1) : b.count - a.count));
    const picked = scored.slice(0, limit);
    if (!picked.length) return `没有卡片同时包含：${ts.join(' / ')}。换更少、更短的关键词，或先 kb_map 看卡片列表。`;
    const out = [`# 卡片搜索「${q}」：${scored.length} 张命中，显示 ${picked.length} 张`, ''];
    for (const it of picked) {
      out.push(`## ${it.doc.name}（命中 ${it.count} 处，${it.doc.lines.length} 行，更新于 ${ageOf(it.doc.mtime)}）`);
      out.push(...it.samples);
      if (it.count > it.samples.length) out.push(`  …还有 ${it.count - it.samples.length} 处`);
      out.push('');
    }
    out.push('下一步：kb_read({card, section}) 展开某节；要目录用 kb_sections({card})。');
    return out.join('\n');
  }

  function sections(args) {
    const doc = resolveDoc(args.card);
    const hs = headingsOf(doc);
    if (!hs.length) return `${doc.name} 没有标题，共 ${doc.lines.length} 行。`;
    const maxLevel = Math.min(4, Math.max(1, parseInt(args.level, 10) || 2));
    return [
      `# ${doc.name}：${hs.length} 个标题，${doc.lines.length} 行，${kb(doc.size)}，更新于 ${ageOf(doc.mtime)}`,
      '',
      ...hs.filter((h) => h.level <= maxLevel).map((h) => `${'  '.repeat(h.level - 1)}L${h.line} ${'#'.repeat(h.level)} ${clip(h.title, 140)}`),
      '',
      '读某一节：kb_read({card, section:"标题片段"})。',
    ].join('\n');
  }

  function read(args) {
    const doc = resolveDoc(args.card);
    const { lines } = doc;
    const total = lines.length;
    let start = Math.max(1, parseInt(args.from, 10) || 1);
    let end = total;
    if (args.section) {
      const needle = String(args.section).trim().toLowerCase();
      const hs = headingsOf(doc);
      const idx = hs.findIndex((h) => h.title.toLowerCase().includes(needle));
      if (idx < 0) throw new Error(`${doc.name} 里没有包含「${args.section}」的标题，用 kb_sections 看目录。`);
      const hit = hs[idx];
      start = hit.line;
      const next = hs.slice(idx + 1).find((h) => h.level <= hit.level);
      end = next ? next.line - 1 : total;
    }
    const limit = Math.min(2000, Math.max(1, parseInt(args.lines, 10) || READ_LINES));
    end = Math.min(end, start + limit - 1);
    const sectionEnd = end;
    const picked = [];
    let used = 0;
    let stopAt = start - 1;
    for (let i = start; i <= end; i++) {
      const line = lines[i - 1] ?? '';
      const cost = line.length + 8;
      if (picked.length && used + cost > MAX_CHARS) break;
      picked.push(`${i}\t${line}`);
      used += cost;
      stopAt = i;
    }
    end = Math.max(stopAt, start);
    const footer = [];
    if (end < total) footer.push(`后面还有：kb_read({card:"${doc.name}", from:${end + 1}})`);
    if (end < sectionEnd) footer.push(`这一节超过 ${MAX_CHARS} 字的单次上限，用 from:${end + 1} 接着读。`);
    return [`# ${doc.name} 第 ${start}-${end} 行，共 ${total} 行（${kb(doc.size)}，更新于 ${ageOf(doc.mtime)}）`, '', picked.join('\n'), footer.length ? `\n${footer.join('\n')}` : ''].join('\n');
  }

  return { map, search, sections, read, count: () => loadDocs().length };
}

export const CARD_TOOLS = [
  {
    name: 'kb_map',
    description: '列出知识卡片（按主题整理的长文档：项目、SOP、设备、个人背景等），每张一行。不知道库里有什么时先看这个。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'kb_search',
    description: '在知识卡片全文里搜关键词（空格分隔，全部命中，子串匹配，中英文都行），返回命中的卡片和行号样例。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '2–4 个关键词' },
        limit: { type: 'integer', description: '最多几张卡（默认 8）' },
        hits: { type: 'integer', description: '每张卡最多几行样例（默认 6）' },
      },
      required: ['query'],
    },
  },
  {
    name: 'kb_sections',
    description: '看一张卡片的目录（标题和行号）。卡片可能几十万字，读之前先看目录。',
    inputSchema: {
      type: 'object',
      properties: { card: { type: 'string', description: '卡片名或其中一段' }, level: { type: 'integer', description: '显示到几级标题（默认 2）' } },
      required: ['card'],
    },
  },
  {
    name: 'kb_read',
    description: '读卡片的某一节（section 填标题片段）或某个行范围（from + lines）。输出带行号和续读提示。',
    inputSchema: {
      type: 'object',
      properties: {
        card: { type: 'string' },
        section: { type: 'string', description: '标题片段，只读这一节' },
        from: { type: 'integer', description: '起始行号（从 1 开始）' },
        lines: { type: 'integer', description: '最多读几行（默认 400）' },
      },
      required: ['card'],
    },
  },
];
