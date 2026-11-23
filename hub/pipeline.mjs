/* 第三步：会话 → 候选条目 → 审批；以及给 Obsidian 用的只读视图导出。
 *
 * - 设备把没有原生记忆的工具（Codex）的会话压缩后上传（只留用户和助手说的话）。
 * - 抽取机（worker/extract.mjs）取待处理会话，调模型抽出候选条目（state=proposed）。
 * - 候选不进搜索和摘要；在审批页点"保留"才生效，N 天没处理自动保留。
 * - vault()：把有效记忆整理成按项目分页的 markdown，加上冻结的知识卡片，供设备端写到本地给 Obsidian 打开。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function createPipeline(ctx) {
  const {
    CFG, store, writeEntry, commit, serial, nowIso, sha256, findSecret, logReject, UserError,
    TYPES, TYPE_LABEL, LIMITS, newId, readJSON, appendJsonl, fmtLocal, byUpdated, ageDays, APP_DIR,
  } = ctx;
  const sessDir = path.join(CFG.state, 'sessions');
  const indexFile = path.join(sessDir, 'index.json');
  const reviewFile = path.join(CFG.state, 'review.json');
  const autoFile = path.join(CFG.state, 'auto-approve.jsonl');
  const index = readJSON(indexFile, {});

  function saveIndex() {
    fs.mkdirSync(sessDir, { recursive: true });
    const tmp = `${indexFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(index));
    fs.renameSync(tmp, indexFile);
  }
  const keyOf = (device, tool, sid) => `${device}__${tool}__${sid}`.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160);

  // ------------------------------------------------------------- sessions ----

  function uploadSession(p, who) {
    const tool = String(p.tool || '').replace(/[^A-Za-z0-9._-]/g, '');
    const sid = String(p.session_id || '').slice(0, 100);
    if (!tool || !sid) throw new UserError('缺少 tool 或 session_id');
    const messages = (Array.isArray(p.messages) ? p.messages : [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.text)
      .map((m) => ({ role: m.role, text: String(m.text).slice(0, 6000), ts: m.ts ? String(m.ts).slice(0, 30) : undefined }));
    if (!messages.length) throw new UserError('会话里没有消息');
    const key = keyOf(who.device, tool, sid);
    const hash = sha256(JSON.stringify(messages)).slice(0, 16);
    const cur = index[key];
    if (cur && cur.hash === hash) return { key, status: cur.status, unchanged: true };
    const title = String(p.title || '').slice(0, 120);
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, `${key}.json`), JSON.stringify({
      key, device: who.device, tool, session_id: sid, title, cwd: String(p.cwd || '').slice(0, 200), started: p.started || null, messages,
    }));
    index[key] = {
      device: who.device, tool, session_id: sid, title, started: p.started || null, uploaded: nowIso(), hash,
      status: 'pending', chars: messages.reduce((a, m) => a + m.text.length, 0), attempts: 0,
    };
    saveIndex();
    return { key, status: 'pending' };
  }

  function pendingSessions(limit = 20) {
    return Object.entries(index)
      .filter(([, v]) => v.status === 'pending')
      .sort((a, b) => String(a[1].started || a[1].uploaded).localeCompare(String(b[1].started || b[1].uploaded)))
      .slice(0, limit)
      .map(([key, v]) => ({ key, ...v }));
  }

  function sessionItem(key) {
    if (!index[key]) return null;
    return readJSON(path.join(sessDir, `${key}.json`), null);
  }

  async function sessionResult(p, who) {
    const key = String(p.key || '');
    const meta = index[key];
    if (!meta) throw new UserError('没有这个会话');
    if (p.error) {
      meta.attempts = (meta.attempts || 0) + 1;
      meta.status = meta.attempts >= 3 ? 'error' : 'pending';
      meta.error = String(p.error).slice(0, 300);
      meta.processed = nowIso();
      saveIndex();
      return { status: meta.status };
    }
    const cands = (Array.isArray(p.candidates) ? p.candidates : []).slice(0, 10);
    return serial(async () => {
      let replaced = 0;
      for (const e of store.values()) {
        // 同一会话重新抽取时，之前还没审的候选作废
        if (e.meta.state === 'proposed' && e.meta.native_key === `session:${key}`) {
          Object.assign(e.meta, { state: 'retired', retired_reason: '会话更新后重新抽取', updated: nowIso() });
          await writeEntry(e);
          replaced++;
        }
      }
      const res = { added: 0, rejected: [] };
      for (const c of cands) {
        const type = String(c.type || '').trim();
        const title = String(c.title || '').trim().slice(0, LIMITS.title);
        const body = String(c.body || '').trim().slice(0, LIMITS.body);
        const subject = String(c.subject || '').trim().slice(0, LIMITS.subject);
        const project = String(c.project || '').trim().slice(0, LIMITS.project);
        const tags = Array.isArray(c.tags) ? [...new Set(c.tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, LIMITS.tags) : [];
        if (!TYPES.includes(type) || !title) { res.rejected.push({ title, reason: 'type 或 title 不对' }); continue; }
        if (type === 'status' && !subject) { res.rejected.push({ title, reason: 'status 缺 subject' }); continue; }
        const fullBody = `${body || title}\n\n来源：${meta.device}/${meta.tool} 会话「${meta.title || meta.session_id}」（${String(meta.started || '').slice(0, 10)}）`;
        const secret = findSecret([title, fullBody, subject, ...tags].join('\n'));
        if (secret) {
          logReject({ device: meta.device, client: 'extract' }, `extract:${key}`, secret);
          res.rejected.push({ title, reason: secret });
          continue;
        }
        const ts = nowIso();
        // updated 用会话发生的时间（信息本身的日期），审批时据此判断谁更新
        const st = Date.parse(meta.started);
        const infoDate = Number.isFinite(st) && st <= Date.now() + 60e3 ? new Date(st).toISOString() : ts;
        await writeEntry({
          meta: {
            id: newId().replace(/^m-/, 'c-'), type, title, subject, project, tags, state: 'proposed', origin: 'extract',
            author: meta.device, client: meta.tool, native_key: `session:${key}`, created: ts, updated: infoDate,
          },
          body: fullBody,
        });
        res.added++;
      }
      Object.assign(meta, { status: 'done', processed: nowIso(), candidates: res.added });
      // 抽完就删会话原文，只留索引（里面可能有没打干净的敏感内容）
      fs.rmSync(path.join(sessDir, `${key}.json`), { force: true });
      delete meta.error;
      saveIndex();
      if (res.added || replaced) await commit(`extract ${key}: +${res.added} proposed`, `${who.device}/extractor`);
      return res;
    });
  }

  // 给抽取任务去重用：现有有效条目的一行摘要
  function titles() {
    return [...store.values()]
      .filter((e) => e.meta.state === 'active' || e.meta.state === 'proposed')
      .sort(byUpdated)
      .slice(0, 500)
      .map((e) => `[${TYPE_LABEL[e.meta.type]}]${e.meta.project ? ` [${e.meta.project}]` : ''}${e.meta.type === 'status' && e.meta.subject ? ` (subject: ${e.meta.subject}，${String(e.meta.updated).slice(0, 10)})` : ''}${e.meta.state === 'proposed' ? '（候选）' : ''} ${e.meta.title}`)
      .join('\n');
  }

  // --------------------------------------------------------------- review ----

  function reviewState() {
    let r = readJSON(reviewFile, null);
    if (!r || Date.now() - Date.parse(r.created) > 7 * 86400e3) {
      // 每周换一次链接，上一个链接再宽限一周
      r = { key: crypto.randomBytes(16).toString('hex'), created: nowIso(), prev: r?.key || null };
      fs.mkdirSync(CFG.state, { recursive: true });
      fs.writeFileSync(reviewFile, JSON.stringify(r), { mode: 0o600 });
    }
    return r;
  }
  const reviewUrl = () => `${CFG.public_url}/review/${reviewState().key}`;
  const reviewKeyOk = (k) => {
    const r = reviewState();
    return Boolean(k) && (k === r.key || k === r.prev);
  };
  const proposals = () => [...store.values()].filter((e) => e.meta.state === 'proposed').sort(byUpdated);

  async function decide(ids, action, by) {
    if (!['approve', 'reject'].includes(action)) throw new UserError('action 只能是 approve 或 reject');
    return serial(async () => {
      let n = 0;
      // 按信息日期从旧到新处理："全部保留"时，同一主题的现状以最新的会话为准
      const list = ids.map((id) => store.get(String(id)))
        .filter((e) => e && e.meta.state === 'proposed')
        .sort((a, b) => Date.parse(a.meta.updated) - Date.parse(b.meta.updated) || Date.parse(a.meta.created) - Date.parse(b.meta.created));
      for (const e of list) {
        const ts = nowIso();
        if (action === 'approve') {
          let newer = null;
          if (e.meta.type === 'status' && e.meta.subject) {
            for (const o of store.values()) {
              if (o === e || o.meta.state !== 'active' || o.meta.type !== 'status' || o.meta.subject !== e.meta.subject) continue;
              if (Date.parse(o.meta.updated) > Date.parse(e.meta.updated)) { newer = o; continue; }
              Object.assign(o.meta, { state: 'superseded', superseded_by: e.meta.id, updated_by: by });
              await writeEntry(o);
            }
          }
          // 已有更新的同主题现状：这条保留成历史，不顶替新的
          if (newer) Object.assign(e.meta, { state: 'superseded', superseded_by: newer.meta.id, updated_by: by });
          else Object.assign(e.meta, { state: 'active', updated_by: by });
        } else {
          Object.assign(e.meta, { state: 'retired', retired_reason: '审批时选了不要', updated: ts, updated_by: by });
        }
        await writeEntry(e);
        n++;
      }
      if (n) await commit(`${action === 'approve' ? '保留' : '不要'} ${n} 条候选（${by}）`, `review/${by}`);
      return n;
    });
  }

  async function autoApprove() {
    const days = CFG.auto_approve_days ?? 3;
    const ids = proposals().filter((e) => ageDays(e.meta.created) >= days).map((e) => e.meta.id);
    if (!ids.length) return 0;
    const n = await decide(ids, 'approve', 'auto');
    if (n) appendJsonl(autoFile, { t: nowIso(), n });
    return n;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function reviewPage(key) {
    const tmpl = fs.readFileSync(path.join(APP_DIR, 'review.html'), 'utf8');
    const items = proposals().map((e) => ({
      id: e.meta.id, type: TYPE_LABEL[e.meta.type] || e.meta.type, project: e.meta.project || '', title: e.meta.title,
      body: e.body, from: `${e.meta.author}/${e.meta.client}`, created: `会话 ${fmtLocal(e.meta.updated).slice(0, 10)}`,
    }));
    const data = JSON.stringify({ key, items, autoDays: CFG.auto_approve_days ?? 3 }).replace(/</g, '\\u003c');
    return tmpl.split('__DATA__').join(data).split('__COUNT__').join(escapeHtml(items.length));
  }

  // ---------------------------------------------------------------- vault ----

  let vaultCache = null;
  const safeName = (s) => String(s).replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名';

  function vault() {
    let cardFiles = [];
    try { cardFiles = fs.readdirSync(CFG.cards_dir).filter((n) => n.endsWith('.md')); } catch { /* 还没同步卡片 */ }
    const cardSig = cardFiles.map((n) => {
      const st = fs.statSync(path.join(CFG.cards_dir, n));
      return `${n}:${st.size}:${st.mtimeMs}`;
    }).join('|');
    const storeSig = [...store.values()].map((e) => `${e.meta.id}:${e.meta.updated}:${e.meta.state}`).sort().join('|');
    const sig = sha256(`${cardSig}#${storeSig}`);
    if (vaultCache?.sig === sig) return vaultCache;

    const active = [...store.values()].filter((e) => e.meta.state === 'active').sort(byUpdated);
    const entryMd = (e) => {
      const m = e.meta;
      const meta = [TYPE_LABEL[m.type], `更新 ${fmtLocal(m.updated)}`, `${m.author}/${m.client}`, m.subject && `主题 ${m.subject}`, `\`${m.id}\``].filter(Boolean).join(' · ');
      return `### ${m.title}\n\n> ${meta}\n\n${e.body}\n`;
    };
    const files = {};
    files['README.md'] = [
      '# 共享记忆（只读视图）',
      '',
      '这个文件夹由 agent-memory 自动生成并每 10 分钟同步，**不要在这里改**，改了会被覆盖。',
      '要补充或更正记忆，让任意一个智能体用 `memory_remember` 写，或在审批页处理候选。',
      '',
      '- [[偏好与反馈]]：一直有效的偏好和工作方式反馈',
      '- `项目/`：按项目整理的现状、决定、坑、事实、参考',
      '- [[其他记录]]：没有归到项目的记录（多是各工具原生记忆）',
      '- [[最近更新]]：最近 30 天的变动',
      '- `卡片/`：只读的主题卡片（长文档）',
      '',
      `共 ${active.length} 条有效记忆。`,
    ].join('\n');
    files['偏好与反馈.md'] = `# 偏好与反馈\n\n${active.filter((e) => e.meta.type === 'preference' || e.meta.type === 'feedback').map(entryMd).join('\n')}`;
    const byProject = {};
    const others = [];
    for (const e of active) {
      if (e.meta.type === 'preference' || e.meta.type === 'feedback') continue;
      if (e.meta.project) (byProject[e.meta.project] ||= []).push(e);
      else others.push(e);
    }
    const order = ['status', 'decision', 'pitfall', 'fact', 'reference'];
    for (const [proj, list] of Object.entries(byProject)) {
      const parts = [`# ${proj}`, ''];
      for (const t of order) {
        const xs = list.filter((e) => e.meta.type === t);
        if (xs.length) parts.push(`## ${TYPE_LABEL[t]}（${xs.length}）`, '', ...xs.map(entryMd), '');
      }
      files[`项目/${safeName(proj)}.md`] = parts.join('\n');
    }
    files['其他记录.md'] = `# 其他记录\n\n${others.map(entryMd).join('\n')}`;
    files['最近更新.md'] = [
      '# 最近 30 天的更新',
      '',
      ...active.filter((e) => ageDays(e.meta.updated) <= 30).map((e) => `- ${fmtLocal(e.meta.updated).slice(5)} [${TYPE_LABEL[e.meta.type]}]${e.meta.project ? ` ${e.meta.project}：` : ' '}${e.meta.title}`),
    ].join('\n');
    for (const n of cardFiles) {
      try { files[`卡片/${n}`] = fs.readFileSync(path.join(CFG.cards_dir, n), 'utf8'); } catch { /* 正在同步 */ }
    }
    const etag = sha256(JSON.stringify(files)).slice(0, 16);
    vaultCache = { sig, etag, files };
    return vaultCache;
  }

  // --------------------------------------------------------------- report ----

  function reportLines(sinceMs) {
    const lines = [];
    const props = proposals();
    const vals = Object.values(index);
    const done = vals.filter((v) => v.status === 'done' && Date.parse(v.processed) >= sinceMs);
    const errors = vals.filter((v) => v.status === 'error');
    const pend = vals.filter((v) => v.status === 'pending');
    const auto = (() => {
      try {
        return fs.readFileSync(autoFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
          .filter((o) => Date.parse(o.t) >= sinceMs).reduce((a, o) => a + o.n, 0);
      } catch { return 0; }
    })();
    if (vals.length || props.length) {
      lines.push(`· 会话抽取：处理 ${done.length} 个，抽出 ${done.reduce((a, v) => a + (v.candidates || 0), 0)} 条候选；排队 ${pend.length} 个${errors.length ? `；⚠ 失败 ${errors.length} 个` : ''}`);
      if (props.length) {
        lines.push(`· 待审候选 ${props.length} 条（${CFG.auto_approve_days ?? 3} 天不处理自动保留）：${reviewUrl()}`);
      }
      if (auto) lines.push(`· 自动保留了 ${auto} 条候选`);
    }
    return lines;
  }

  // 一次性修正：0.3.0 初版把候选的 updated 记成了抽取时间，改回正文里写的会话日期
  async function fixCandidateDates() {
    return serial(async () => {
      let n = 0;
      for (const e of store.values()) {
        if (e.meta.origin !== 'extract' || e.meta.updated !== e.meta.created) continue;
        const m = /（(\d{4}-\d{2}-\d{2})）\s*$/.exec(e.body);
        if (!m) continue;
        e.meta.updated = new Date(`${m[1]}T12:00:00+08:00`).toISOString();
        await writeEntry(e);
        n++;
      }
      if (n) await commit(`fix: ${n} 条候选的日期改为会话日期`, 'agent-memory');
      return n;
    });
  }

  function watchProblems() {
    const out = [];
    const vals = Object.entries(index);
    const errors = vals.filter(([, v]) => v.status === 'error');
    if (errors.length) out.push({ key: 'extract:errors', text: `会话抽取失败 ${errors.length} 个（重试 3 次都没成功），最近一个：${errors[errors.length - 1][1].error || '未知原因'}` });
    const backlog = vals.filter(([, v]) => v.status === 'pending' && Date.now() - Date.parse(v.uploaded) > 36 * 3600e3);
    if (backlog.length) out.push({ key: 'extract:backlog', text: `${backlog.length} 个会话上传超过 36 小时还没抽取，夜间抽取任务可能没在跑` });
    return out;
  }

  return {
    fixCandidateDates, watchProblems,
    uploadSession, pendingSessions, sessionItem, sessionResult, titles,
    reviewKeyOk, reviewPage, reviewUrl, decide, autoApprove, proposals, vault, reportLines,
  };
}
