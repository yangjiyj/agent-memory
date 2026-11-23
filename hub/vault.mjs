/* Obsidian 视图 v2（中心 0.7）：按"日期、项目、会话、记忆"互相链接，图谱里能看出关联。
 *
 *   首页.md            入口
 *   日志/YYYY-MM-DD.md  每天：按项目列出各机器各智能体的会话日志，链到项目页和会话原文
 *   对话/YYYY-MM/…md    每个会话一篇：按天的日志 + 原文（用户的话全留，助手的话截短）
 *   项目/<项目>.md      项目页：现状、决定、坑、最近的日志、相关会话
 *   记忆/<类型>/…md     每条有效记忆一篇，链到项目
 *   偏好与反馈.md、最近更新.md、卡片/（冻结的旧知识卡片）
 *
 * 增量同步：manifest 给出每个文件的签名（由输入算，不必先生成内容），设备端只取签名变了的文件。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { localDay, AUTO_CWD } from './convlog.mjs';

const TZ = 8 * 3600e3;
const hhmm = (iso) => new Date(Date.parse(iso) + TZ).toISOString().slice(11, 16);
const WEEK = '日一二三四五六';
const weekday = (d) => `周${WEEK[new Date(`${d}T12:00:00Z`).getUTCDay()]}`;
const h = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
// 文件名里不能有的字符（系统的 + Obsidian 链接会断的 # ^ [ ] |）
const fname = (s, n = 50) => (String(s || '').replace(/[\\/:*?"<>|#^[\]\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n).trim() || '未命名');
const TOOL_LABEL = {
  'claude-code': 'Claude Code', codex: 'Codex', workbuddy: 'WorkBuddy', codebuddy: 'CodeBuddy', hermes: 'Hermes',
  openclaw: 'OpenClaw', opencode: 'OpenCode', gemini: 'Gemini', qwen: 'Qwen',
};
const tl = (t) => TOOL_LABEL[t] || t;
const quote = (s) => JSON.stringify(String(s ?? ''));

export function createVault(ctx) {
  const { CFG, store, conv, TYPE_LABEL, fmtLocal, byUpdated, ageDays } = ctx;
  let cache = null;

  function build() {
    const index = conv.index();
    const journal = conv.journal();
    const active = [...store.values()].filter((e) => e.meta.state === 'active').sort(byUpdated);
    let cardFiles = [];
    try { cardFiles = fs.readdirSync(CFG.cards_dir).filter((n) => n.endsWith('.md')); } catch { /* 没有卡片 */ }
    const cardSig = cardFiles.map((n) => { try { const st = fs.statSync(path.join(CFG.cards_dir, n)); return `${n}:${st.size}:${st.mtimeMs}`; } catch { return n; } }).join('|');
    const sig = h([
      active.map((e) => `${e.meta.id}:${e.meta.updated}`).join('|'),
      Object.entries(index).map(([k, e]) => `${k}:${e.n}:${e.title}`).join('|'),
      [...journal.entries()].map(([d, o]) => `${d}:${Object.values(o).map((s) => s.at).join(',')}`).join('|'),
      cardSig,
    ].join('#'));
    if (cache?.sig === sig) return cache;

    const files = new Map(); // rel -> { sig, gen }
    const add = (rel, s, gen) => files.set(rel, { sig: h(`v2|${rel}|${s}`), gen });

    // ---------- 会话 ----------
    const convRel = new Map(); // key -> 不带 .md 的路径（链接用）
    const convProj = new Map(); // key -> 主要项目
    const daySegs = new Map(); // date -> [seg]
    for (const [key, e] of Object.entries(index)) {
      const days = Object.keys(e.days).sort();
      if (!days.length || !Object.values(e.days).some((d) => d.users) || AUTO_CWD.test(e.cwd || '')) continue;
      const ref = conv.refOf(key);
      const rel = `对话/${days[0].slice(0, 7)}/${days[0]} ${fname(e.device, 20)} ${tl(e.tool)} ${fname(e.title || e.sid, 40)} ${ref}`;
      convRel.set(key, rel);
      const projCount = {};
      for (const d of days) {
        const j = journal.get(d)?.[key];
        if (j?.project) projCount[j.project] = (projCount[j.project] || 0) + 1;
        if (!e.days[d].users) continue;
        const seg = { key, ref, date: d, e, j, first: e.days[d].first, last: e.days[d].last, n: e.days[d].n };
        if (!daySegs.has(d)) daySegs.set(d, []);
        daySegs.get(d).push(seg);
      }
      const proj = Object.entries(projCount).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
      convProj.set(key, proj);
    }
    const projOfSeg = (s) => s.j?.project || convProj.get(s.key) || '';

    for (const [key, rel] of convRel) {
      const e = index[key];
      const days = Object.keys(e.days).sort();
      const jsig = days.map((d) => journal.get(d)?.[key]?.at || '').join(',');
      add(`${rel}.md`, `${e.n}:${e.title}:${jsig}:${convProj.get(key)}`, () => {
        const proj = convProj.get(key);
        const out = [
          '---',
          `设备: ${quote(e.device)}`,
          `工具: ${quote(tl(e.tool))}`,
          `开始: ${quote(e.first ? fmtLocal(e.first) : '')}`,
          `最后: ${quote(e.last ? fmtLocal(e.last) : '')}`,
          `消息数: ${e.n}`,
          proj ? `项目: ${quote(proj)}` : null,
          `ref: ${quote(conv.refOf(key))}`,
          `tags: [对话, ${quote(e.tool)}]`,
          '---',
          '',
          `# ${e.title || e.sid}`,
          '',
          `${e.device} · ${tl(e.tool)}${proj ? ` · [[项目/${fname(proj)}|${proj}]]` : ''}${e.cwd ? ` · \`${e.cwd}\`` : ''}${e.legacy ? ' · 来自旧知识库导出' : ''}`,
          '',
          '## 每天做了什么',
          '',
          ...days.filter((d) => e.days[d].users).map((d) => {
            const j = journal.get(d)?.[key];
            return `- [[日志/${d}|${d}]]（${e.days[d].n} 条）${j ? `：${j.summary}` : '：日志还没写'}`;
          }),
          '',
          '## 原文',
          '',
          '> 只有用户和助手说的话（工具调用省略，密钥已打码）；助手的长回复截短了，全文在任意智能体里用 `conversation_get` 加 ref 读。',
          '',
        ].filter((x) => x !== null);
        let lastDay = '';
        for (const m of conv.readMessages(e)) {
          const d = localDay(m.ts);
          if (d !== lastDay) { out.push(`### ${d}（${weekday(d)}）`, ''); lastDay = d; }
          const max = m.role === 'user' ? 6000 : 1500;
          const body = m.text.length > max ? `${m.text.slice(0, max)}…（截断）` : m.text;
          out.push(`**${m.role === 'user' ? '用户' : '助手'}**${e.approx ? '' : ` ${hhmm(m.ts)}`}`, '', body, '');
        }
        return out.join('\n');
      });
    }

    // ---------- 日志 ----------
    const allDays = [...new Set([...daySegs.keys(), ...journal.keys()])].sort();
    allDays.forEach((d, i) => {
      const segs = (daySegs.get(d) || []).sort((a, b) => String(a.first).localeCompare(String(b.first)));
      const prev = allDays[i - 1];
      const next = allDays[i + 1];
      add(`日志/${d}.md`, `${prev}:${next}:${segs.map((s) => `${s.key}:${s.n}:${s.j?.at || ''}:${projOfSeg(s)}`).join('|')}`, () => {
        const byProj = new Map();
        for (const s of segs) {
          const p = projOfSeg(s) || '其他';
          if (!byProj.has(p)) byProj.set(p, []);
          byProj.get(p).push(s);
        }
        const order = [...byProj.keys()].sort((a, b) => (a === '其他') - (b === '其他') || byProj.get(b).length - byProj.get(a).length);
        const out = [
          '---', `日期: ${d}`, `星期: ${weekday(d)}`, `会话数: ${segs.length}`, `项目: [${order.filter((p) => p !== '其他').map(quote).join(', ')}]`, 'tags: [日志]', '---', '',
          `# ${d}（${weekday(d)}）`, '',
          `${prev ? `[[日志/${prev}|← ${prev}]]` : ''}${prev && next ? ' · ' : ''}${next ? `[[日志/${next}|${next} →]]` : ''}`, '',
        ];
        for (const p of order) {
          out.push(p === '其他' ? '## 其他' : `## [[项目/${fname(p)}|${p}]]`, '');
          for (const s of byProj.get(p)) {
            const when = s.e.approx ? '' : `${hhmm(s.first)}–${hhmm(s.last)} `;
            const link = `[[${convRel.get(s.key)}|${s.e.title ? fname(s.e.title, 30) : '原文'}]]`;
            out.push(`- ${when}${s.j ? s.j.summary : `（日志还没写）${s.e.title || ''}`} —— ${s.e.device} · ${tl(s.e.tool)} · ${link}`);
            for (const pt of s.j?.points || []) out.push(`    - ${pt}`);
          }
          out.push('');
        }
        return out.join('\n');
      });
    });

    // ---------- 记忆 ----------
    const memRel = new Map();
    for (const e of active) {
      const m = e.meta;
      const rel = `记忆/${TYPE_LABEL[m.type] || m.type}/${fname(m.title, 60)} ${m.id.slice(-6)}`;
      memRel.set(m.id, rel);
      add(`${rel}.md`, `${m.updated}:${m.content_hash || h(e.body)}:${m.project}`, () => [
        '---',
        `类型: ${quote(TYPE_LABEL[m.type] || m.type)}`,
        m.project ? `项目: ${quote(m.project)}` : null,
        m.subject ? `主题: ${quote(m.subject)}` : null,
        `来源: ${quote(`${m.author}/${m.client}`)}`,
        `更新: ${quote(fmtLocal(m.updated))}`,
        `id: ${quote(m.id)}`,
        `tags: [记忆, ${quote(TYPE_LABEL[m.type] || m.type)}]`,
        '---',
        '',
        `# ${m.title}`,
        '',
        `${TYPE_LABEL[m.type] || m.type}${m.project ? ` · [[项目/${fname(m.project)}|${m.project}]]` : ''} · ${m.author}/${m.client} · 更新于 [[日志/${localDay(m.updated)}|${fmtLocal(m.updated)}]]`,
        '',
        e.body,
        '',
      ].filter((x) => x !== null).join('\n'));
    }

    // ---------- 项目 ----------
    const projects = new Set([...active.map((e) => e.meta.project).filter(Boolean), ...[...convProj.values()].filter(Boolean)]);
    for (const p of projects) {
      const mems = active.filter((e) => e.meta.project === p);
      const convs = [...convRel.keys()].filter((k) => convProj.get(k) === p).sort((a, b) => String(index[b].last).localeCompare(String(index[a].last)));
      const segs = [...daySegs.values()].flat().filter((s) => projOfSeg(s) === p).sort((a, b) => b.date.localeCompare(a.date));
      add(`项目/${fname(p)}.md`, `${mems.map((e) => `${e.meta.id}:${e.meta.updated}`).join('|')}#${segs.map((s) => `${s.key}:${s.date}:${s.j?.at || ''}`).join('|')}`, () => {
        const order = ['status', 'decision', 'pitfall', 'fact', 'reference', 'preference', 'feedback'];
        const out = ['---', `项目: ${quote(p)}`, `记忆数: ${mems.length}`, `会话数: ${convs.length}`, 'tags: [项目]', '---', '', `# ${p}`, ''];
        const recent = segs.filter((s) => ageDays(`${s.date}T12:00:00+08:00`) <= 60);
        if (recent.length) {
          out.push('## 最近在做什么（60 天内的日志）', '');
          let lastD = '';
          for (const s of recent.slice(0, 80)) {
            if (s.date !== lastD) { out.push(`- [[日志/${s.date}|${s.date}（${weekday(s.date)}）]]`); lastD = s.date; }
            out.push(`    - ${s.j ? s.j.summary : `（日志还没写）${s.e.title || ''}`}（${s.e.device} · ${tl(s.e.tool)} · [[${convRel.get(s.key)}|原文]]）`);
          }
          out.push('');
        }
        for (const t of order) {
          const xs = mems.filter((e) => e.meta.type === t);
          if (xs.length) out.push(`## ${TYPE_LABEL[t]}（${xs.length}）`, '', ...xs.map((e) => `- [[${memRel.get(e.meta.id)}|${fname(e.meta.title, 80)}]]（${fmtLocal(e.meta.updated).slice(0, 10)}）`), '');
        }
        if (convs.length) {
          out.push(`## 相关会话（${convs.length}）`, '', ...convs.slice(0, 300).map((k) => `- [[${convRel.get(k)}|${fname(index[k].title || index[k].sid, 60)}]]（${localDay(index[k].first)}，${index[k].device} · ${tl(index[k].tool)}）`), '');
        }
        return out.join('\n');
      });
    }

    // ---------- 偏好、最近更新、首页、卡片 ----------
    const prefs = active.filter((e) => e.meta.type === 'preference' || e.meta.type === 'feedback');
    add('偏好与反馈.md', prefs.map((e) => `${e.meta.id}:${e.meta.updated}`).join('|'), () => [
      '# 偏好与反馈', '', '一直有效的偏好和工作方式反馈（所有智能体都照做）。', '',
      ...prefs.map((e) => `- [[${memRel.get(e.meta.id)}|${fname(e.meta.title, 100)}]]`),
    ].join('\n'));
    const recentMem = active.filter((e) => ageDays(e.meta.updated) <= 30);
    add('最近更新.md', recentMem.map((e) => `${e.meta.id}:${e.meta.updated}`).join('|'), () => [
      '# 最近 30 天更新的记忆', '',
      ...recentMem.map((e) => `- ${fmtLocal(e.meta.updated).slice(5)} [${TYPE_LABEL[e.meta.type]}]${e.meta.project ? ` [[项目/${fname(e.meta.project)}|${e.meta.project}]]：` : ' '}[[${memRel.get(e.meta.id)}|${fname(e.meta.title, 80)}]]`),
    ].join('\n'));
    const lastDays = allDays.slice(-14).reverse();
    const projList = [...projects].sort();
    add('首页.md', `${lastDays.join(',')}:${projList.join(',')}:${active.length}:${convRel.size}`, () => [
      '# 共享记忆', '',
      '这个文件夹由 agent-memory 自动生成、每 10 分钟同步，**不要在这里改**（改了会被覆盖）。要补充或更正，让任意一个智能体用 `memory_remember` 写。', '',
      `- 有效记忆 ${active.length} 条，会话 ${convRel.size} 个，日志 ${allDays.length} 天`,
      '- [[偏好与反馈]] · [[最近更新]]',
      '- 打开"图谱视图"：日志（每天）↔ 项目 ↔ 会话原文 ↔ 记忆 是互相链着的；用标签 #日志 #项目 #对话 #记忆 筛选。',
      '',
      '## 最近两周', '',
      ...lastDays.map((d) => `- [[日志/${d}|${d}（${weekday(d)}）]]：${(daySegs.get(d) || []).length} 段会话`),
      '',
      '## 项目', '',
      projList.map((p) => `[[项目/${fname(p)}|${p}]]`).join(' · '),
      '',
      '## 卡片（只读的长文档）', '',
      ...cardFiles.map((n) => `- [[卡片/${n.replace(/\.md$/, '')}]]`),
    ].join('\n'));
    for (const n of cardFiles) {
      let st = null;
      try { st = fs.statSync(path.join(CFG.cards_dir, n)); } catch { continue; }
      add(`卡片/${n}`, `${st.size}:${st.mtimeMs}`, () => fs.readFileSync(path.join(CFG.cards_dir, n), 'utf8'));
    }

    const manifest = Object.fromEntries([...files.entries()].map(([rel, f]) => [rel, f.sig]));
    cache = { sig, etag: h(JSON.stringify(manifest)), manifest, files };
    return cache;
  }

  function manifest() {
    const c = build();
    return { etag: c.etag, files: c.manifest };
  }

  function fetchFiles(paths) {
    const c = build();
    const out = {};
    let size = 0;
    for (const rel of (Array.isArray(paths) ? paths : []).slice(0, 300)) {
      const f = c.files.get(rel);
      if (!f) continue;
      try { out[rel] = { sig: f.sig, content: f.gen() }; } catch (e) { out[rel] = { sig: '', content: `生成失败：${e.message}` }; }
      size += out[rel].content.length;
      if (size > 12e6) break; // 一次别太大，剩下的设备端下一批再要
    }
    return out;
  }

  return { manifest, fetchFiles };
}
