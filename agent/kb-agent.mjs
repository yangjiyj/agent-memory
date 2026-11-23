#!/usr/bin/env node
/* agent-memory 设备端程序（零依赖，Node >= 18，Windows / macOS / Linux 通用）。
 *
 *   node kb-agent.mjs sync                 把本机工具的原生记忆推到中心，拉回共享摘要写进各工具的指令文件
 *   node kb-agent.mjs mcp --client <名字>  stdio MCP 代理（给 Claude Code / Codex 用），转发到中心的 /mcp
 *   node kb-agent.mjs search <关键词…>     命令行搜索
 *   node kb-agent.mjs get <id>
 *   node kb-agent.mjs remember --type decision --title "…" [--body "…"] [--subject …] [--project …]
 *   node kb-agent.mjs status | digest [--tool codex] | report
 *   node kb-agent.mjs setup                自动发现本机的 Claude Code / Codex / Hermes，配好同步来源、摘要目标和 MCP
 *   node kb-agent.mjs import <文件.json>   批量导入条目（知识卡片拆分结果）
 *   node kb-agent.mjs update               从中心下载最新版本替换自己
 *
 * 配置：~/.agent-memory/config.json（或环境变量 AGENT_MEMORY_HOME 指定目录）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';

const VERSION = '0.8.9';
const HOME_DIR = process.env.AGENT_MEMORY_HOME || path.join(os.homedir(), '.agent-memory');
const CONFIG_FILE = path.join(HOME_DIR, 'config.json');
const STATE_FILE = path.join(HOME_DIR, 'state.json');
const LOG_FILE = path.join(HOME_DIR, 'agent.log');
const LOCK_FILE = path.join(HOME_DIR, 'sync.lock');
const BEGIN = '<!-- AGENT-MEMORY:BEGIN（自动生成，勿手改） -->';
const END = '<!-- AGENT-MEMORY:END -->';

const expand = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

function loadConfig() {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '')); } catch (e) {
    throw new Error(`读不到配置 ${CONFIG_FILE}：${e.message}`);
  }
  if (!cfg.hub || !cfg.token) throw new Error('配置里缺少 hub 或 token');
  cfg.hub = cfg.hub.replace(/\/+$/, '');
  cfg.sources ||= [];
  cfg.targets ||= [];
  return cfg;
}

function log(msg) {
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1 << 20) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch { /* 日志失败不影响主流程 */ }
}

async function api(cfg, method, p, { body, client, timeout = 30000 } = {}) {
  const url = `${cfg.hub}${p}${client ? (p.includes('?') ? '&' : '?') + 'client=' + encodeURIComponent(client) : ''}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${cfg.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    const txt = await res.text();
    if (!res.ok) {
      let msg = txt;
      try { msg = JSON.parse(txt).error || txt; } catch { /* 原样 */ }
      throw new Error(`${method} ${p} → ${res.status} ${msg}`);
    }
    return txt;
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ sync ----

function collectClaudeMemory(root) {
  // ~/.claude/projects/<项目>/memory/*.md，MEMORY.md 是索引，跳过
  const out = [];
  const base = expand(root);
  let dirs = [];
  try { dirs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return out; }
  for (const d of dirs) {
    const memDir = path.join(base, d.name, 'memory');
    let files = [];
    try { files = fs.readdirSync(memDir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
      const full = path.join(memDir, f);
      try {
        const content = fs.readFileSync(full, 'utf8');
        const mtime = fs.statSync(full).mtime.toISOString();
        if (content.trim()) out.push({ key: `${d.name}/${f}`, content, mtime });
      } catch { /* 文件正在写，下次再同步 */ }
    }
  }
  return out;
}

// 一个文件里用分隔行（如 Hermes 的 §）分成多条记忆；每段的 key 带内容哈希，改了就是新条目、旧的自动作废
// 可以是单个 path，也可以是 files: [{ path, type_hint }]（同一工具的多个文件，如 Hermes 的 USER.md 和 MEMORY.md）
function collectSectionFile(source) {
  const files = source.files || [{ path: source.path, type_hint: source.type_hint }];
  const sep = source.separator || '§';
  const out = [];
  for (const spec of files) {
    const file = expand(spec.path);
    let text = '';
    let mtime;
    try {
      text = fs.readFileSync(file, 'utf8');
      mtime = fs.statSync(file).mtime.toISOString();
    } catch { continue; }
    const base = path.basename(file);
    // split: 'separator'（默认，按 § 这类分隔行）/ 'heading'（按 ## 标题）/ 'none'（整份一条）
    const parts = spec.split === 'none' ? [text]
      : spec.split === 'heading' ? (text.split(/^(?=## )/m).filter((s) => s.trim().startsWith('## ')).length ? text.split(/^(?=## )/m).filter((s) => s.trim().startsWith('## ')) : [text])
        : text.split(new RegExp(`^\\s*${sep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm'));
    for (const part of parts) {
      const content = part.trim();
      if (!content) continue;
      const h = sha(content).slice(0, 10);
      out.push({
        key: `${base}#${h}`, content, mtime,
        type_hint: spec.type_hint || source.type_hint, subject_hint: `${source.tool}-${base.replace(/\.md$/i, '').toLowerCase()}/${h}`,
      });
    }
  }
  return out;
}

function globFiles(p) {
  const full = expand(p);
  const pat = path.basename(full);
  if (!pat.includes('*')) return fs.existsSync(full) ? [full] : [];
  const re = new RegExp(`^${pat.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  try { return fs.readdirSync(path.dirname(full)).filter((n) => re.test(n)).map((n) => path.join(path.dirname(full), n)); } catch { return []; }
}

// 按 "## 标题" 分段的记忆文件（如 WorkBuddy 的 MEMORY.md）；没有二级标题就整份算一条
function collectHeadingFile(source) {
  const out = [];
  for (const file of [].concat(source.paths || source.path || []).flatMap(globFiles)) {
    let text = '';
    let mtime;
    try {
      text = fs.readFileSync(file, 'utf8');
      mtime = fs.statSync(file).mtime.toISOString();
    } catch { continue; }
    const base = path.basename(file);
    const parts = text.split(/^(?=## )/m).map((s) => s.trim()).filter((s) => s.startsWith('## '));
    for (const content of parts.length ? parts : [text.trim()].filter(Boolean)) {
      const h = sha(content).slice(0, 10);
      out.push({
        key: `${base}#${h}`, content, mtime,
        type_hint: source.type_hint, subject_hint: `${source.tool}-${base.replace(/\.md$/i, '').toLowerCase().slice(0, 40)}/${h}`,
      });
    }
  }
  return out;
}

function collect(source) {
  if (source.kind === 'claude-memory') return collectClaudeMemory(source.root || '~/.claude/projects');
  if (source.kind === 'section-file') return collectSectionFile(source);
  if (source.kind === 'heading-file') return collectHeadingFile(source);
  throw new Error(`不认识的 source.kind：${source.kind}`);
}

function walk(dir, skip = new Set(['.obsidian', '.git', '.trash'])) {
  const out = [];
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (skip.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, skip));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

// ------------------------------------------------------- codex sessions ----

// 上传会话前尽力打码：口令、各类令牌和密钥。中心抽完候选就删原文，候选写入前还会再查一遍
const REDACT_RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[私钥已打码]'],
  [/\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[abposr]-[A-Za-z0-9-]{10,})/g, '[令牌已打码]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[令牌已打码]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [已打码]'],
  [/((?:密码|口令|passwd|password|pwd|secret|token|api[_-]?key|app[_-]?secret|access[_-]?key)\s*(?:是|为|[:：=])?\s*)[`'"]?(?=[^\s`'"，。,;；]*[A-Za-z0-9])[^\s`'"，。,;；]{3,}/gi, '$1[已打码]'],
];
function redact(text) {
  let s = String(text);
  for (const [re, rep] of REDACT_RULES) s = s.replace(re, rep);
  return s;
}

const NOISE_USER =/^(# AGENTS\.md instructions|<environment_context>|<user_instructions>|<turn_aborted>|<permissions instructions>|<user_shell_command>)/;

function parseCodexSession(file) {
  const meta = {};
  const msgs = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const p = o.payload || {};
    if (o.type === 'session_meta' && !meta.id) {
      Object.assign(meta, { id: p.id || p.session_id, started: p.timestamp || o.timestamp, cwd: p.cwd, originator: p.originator || '' });
      continue;
    }
    if (o.type !== 'response_item' || p.type !== 'message' || (p.role !== 'user' && p.role !== 'assistant')) continue;
    const text = (p.content || []).map((c) => c.text || '').join('\n').trim();
    if (!text || (p.role === 'user' && NOISE_USER.test(text))) continue;
    msgs.push({ role: p.role, text, ts: o.timestamp });
  }
  return { meta, msgs };
}

// 只留用户和助手的话；每条截断；总量超了就先丢最早的助手消息（结论一般在后面）
function compactMessages(msgs, budget = 100000) {
  const out = msgs.map((m) => {
    const max = m.role === 'user' ? 2000 : 3000;
    return m.text.length > max ? { ...m, text: `${m.text.slice(0, max)}…（截断）` } : m;
  });
  let total = out.reduce((a, m) => a + m.text.length, 0);
  for (let i = 0; i < out.length && total > budget; i++) {
    if (out[i].role === 'assistant') { total -= out[i].text.length; out[i] = null; }
  }
  return out.filter(Boolean);
}

async function syncCodexSessions(cfg, src, state) {
  const tool = src.tool || 'codex';
  // 补传旧会话时临时放宽：AM_SESSION_DAYS=75 AM_SESSION_MAX=1000 node kb-agent.mjs sync
  const days = parseInt(process.env.AM_SESSION_DAYS, 10) || (src.days ?? 14);
  const idleMin = src.idle_minutes ?? 60;
  const now = Date.now();
  state.codex ||= { files: {}, owner: {} };
  const files = walk(expand(src.root || '~/.codex/sessions'))
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f, st: fs.statSync(f) }))
    .filter(({ st }) => now - st.mtimeMs <= days * 86400e3 && now - st.mtimeMs >= idleMin * 60e3)
    .sort((a, b) => a.st.mtimeMs - b.st.mtimeMs); // 老的先处理，分叉会话里重复的历史归给原会话
  let sent = 0;
  let skipped = 0;
  for (const { f, st } of files) {
    const sig = `${st.size}:${Math.floor(st.mtimeMs)}`;
    if (state.codex.files[f] === sig) continue;
    const { meta, msgs } = parseCodexSession(f);
    // codex exec 是脚本或别的智能体派出去的批处理（审校、标注、子任务车道），结论会回到发起它的会话里，不上传
    if (meta.originator === 'codex_exec' && src.skip_exec !== false) {
      state.codex.files[f] = sig;
      skipped++;
      continue;
    }
    const sid = meta.id || path.basename(f, '.jsonl');
    const kept = [];
    for (const m of msgs) {
      const h = sha(`${m.role}\n${m.text}`);
      const owner = state.codex.owner[h];
      if (owner && owner !== sid) continue;
      state.codex.owner[h] = sid;
      kept.push(m);
    }
    const users = kept.filter((m) => m.role === 'user');
    if (!users.length || kept.reduce((a, m) => a + m.text.length, 0) < 400) {
      state.codex.files[f] = sig;
      skipped++;
      continue;
    }
    const titleLine = users.flatMap((m) => m.text.split('\n')).map((l) => l.trim())
      .find((l) => l.length > 3 && !/^(#|<|```|!\[|\[image|image attachment|files mentioned|distinguish instructions in attached)/i.test(l));
    const title = redact(titleLine || sid).slice(0, 80);
    await api(cfg, 'POST', '/v1/sessions', {
      body: { tool, session_id: sid, started: meta.started, cwd: meta.cwd, title, messages: compactMessages(kept).map((m) => ({ ...m, text: redact(m.text) })) },
      timeout: 120000,
    });
    state.codex.files[f] = sig;
    sent++;
    if (sent >= (parseInt(process.env.AM_SESSION_MAX, 10) || (src.max_per_run ?? 30))) break;
  }
  const owners = Object.keys(state.codex.owner);
  if (owners.length > 30000) for (const k of owners.slice(0, owners.length - 30000)) delete state.codex.owner[k];
  if (sent || skipped) log(`sync ${tool} sessions: eligible=${files.length} sent=${sent} skipped=${skipped}`);
  return sent;
}

// --------------------------------------------------------- conversations ----
// 0.8：所有智能体的对话（只留用户和助手说的话，打码后）增量上传到中心长期存档，
// 中心每晚给每个会话每天写一段工作日志，任何机器上的智能体都能问"哪天干了什么"。
// 不用配置：按目录自动发现；某台机器不想传某个工具，在 config.json 里写 "conversations": { "disabled": ["hermes"] }，全关写 false。

const CONV_STATE_FILE = path.join(HOME_DIR, 'conv-state.json');
const CONV_MSG_MAX = 30000; // 单条消息上限（字符）
const CONV_REQ_MAX = 1500000; // 单次请求上限（字符）
const CONV_INJECTED = /^(# AGENTS\.md instructions|<(app-context|collaboration_mode|environment_context|permissions instructions|plugins_instructions|skills_instructions|codex_internal_context|recommended_plugins|subagent_notification|system-reminder|local-command-stdout|local-command-stderr|local-command-caveat|task-notification|realtime_delegation|turn_aborted|codex_delegation|user_instructions|user_shell_command|INSTRUCTIONS)\b)/;

function convText(text, role) {
  let s = String(text || '').replace(/<system-reminder[^>]*>[\s\S]*?<\/system-reminder>/g, '');
  if (role === 'user') {
    s = s.replace(/<\/?(user_query|long_text_quote)[^>]*>/g, '').replace(/^\[message_id: [^\]]*\]\s*/, '');
    // Claude 的斜杠命令：<command-name>/foo</command-name><command-args>x</command-args> → "/foo x"
    if (/^\s*<command-(name|message)>/.test(s)) {
      const name = /<command-name>([^<]*)<\/command-name>/.exec(s)?.[1] || '';
      const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(s)?.[1] || '';
      s = `${name} ${args}`;
    }
  }
  s = s.trim();
  if (!s || (role === 'user' && (CONV_INJECTED.test(s) || /^\[Request interrupted by user/.test(s)))) return '';
  return s.length > CONV_MSG_MAX ? `${s.slice(0, CONV_MSG_MAX)}…（截断）` : s;
}

function blockText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((b) => (typeof b === 'string' ? b : (b && (b.type === undefined || /^(text|input_text|output_text)$/.test(b.type)) ? (b.text || '') : ''))).filter(Boolean).join('\n');
  }
  if (c && typeof c === 'object' && typeof c.text === 'string') return c.text;
  return '';
}

function toIso(t) {
  if (t === undefined || t === null || t === '') return undefined;
  let n = typeof t === 'number' ? t : (/^\d+(\.\d+)?$/.test(String(t)) ? Number(t) : NaN);
  if (Number.isFinite(n)) {
    if (n < 1e12) n *= 1000; // 秒
    const d = new Date(n);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function* jsonlRecords(file) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try { yield JSON.parse(line); } catch { /* 正在写的半行或坏行 */ }
  }
}

function parseClaudeConv(file) {
  const out = { sid: path.basename(file, '.jsonl'), title: '', cwd: '', started: '', msgs: [] };
  let aiTitle = '';
  for (const o of jsonlRecords(file)) {
    if (o.type === 'custom-title' && o.customTitle) out.title = o.customTitle;
    else if (o.type === 'summary' && o.summary) aiTitle ||= o.summary;
    else if (o.type === 'ai-title' && o.aiTitle) aiTitle = o.aiTitle;
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    if (o.isSidechain || o.isMeta || o.isCompactSummary || o.isVisibleInTranscriptOnly || o.isApiErrorMessage) continue;
    if (o.type === 'user' && o.turnOrigin === 'task_notification') continue;
    out.cwd ||= o.cwd || '';
    out.started ||= o.timestamp || '';
    out.entry ||= o.entrypoint || '';
    const text = convText(blockText(o.message?.content), o.type);
    if (text) out.msgs.push({ role: o.type, text: o.turnOrigin === 'peer' ? `[来自另一个会话] ${text}` : text, ts: toIso(o.timestamp) });
  }
  out.title ||= aiTitle;
  // 脚本用 claude -p / SDK 自动跑的（测评、批处理），不是人在聊：不存
  if (/^sdk-/.test(out.entry) || CONV_AUTO_CWD.test(out.cwd)) return { skip: '脚本自动跑的会话' };
  return out;
}

// 临时目录里的会话基本都是脚本拉起的
const CONV_AUTO_CWD = /^(\/tmp\/|\/private\/tmp\/|\/var\/folders\/|[A-Za-z]:\\Users\\[^\\]+\\AppData\\Local\\Temp\\)/;

// WorkBuddy / CodeBuddy：type=message，role=user/assistant，content 是 input_text/output_text
function parseBuddyConv(file) {
  const out = { sid: path.basename(file, '.jsonl'), title: '', cwd: '', started: '', msgs: [] };
  for (const o of jsonlRecords(file)) {
    if (o.type === 'ai-title' && o.aiTitle) out.title = o.aiTitle;
    if (o.type !== 'message' || (o.role !== 'user' && o.role !== 'assistant')) continue;
    out.cwd ||= o.cwd || '';
    out.started ||= toIso(o.timestamp) || '';
    const text = convText(blockText(o.content), o.role);
    if (text) out.msgs.push({ role: o.role, text, ts: toIso(o.timestamp) });
  }
  return out;
}

function codexOriginator(file) {
  // 只读开头一小段判断是不是 codex exec 批处理会话（批处理的文件可能很大，不必整份解析）
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const first = buf.subarray(0, n).toString('utf8').split('\n')[0];
    try { return JSON.parse(first).payload?.originator || ''; } catch { return ''; }
  } finally { fs.closeSync(fd); }
}

function parseGeminiConv(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = { sid: j.sessionId || path.basename(file, '.json'), title: '', cwd: '', started: toIso(j.startTime) || '', msgs: [] };
  for (const m of j.messages || []) {
    const role = m.type === 'user' ? 'user' : (m.type === 'gemini' || m.type === 'model' || m.type === 'assistant') ? 'assistant' : null;
    if (!role) continue;
    const text = convText(blockText(m.content), role);
    if (text) out.msgs.push({ role, text, ts: toIso(m.timestamp) });
  }
  return out;
}

let sqliteMod;
async function sqliteAll(db, sql) {
  if (sqliteMod === undefined) {
    try {
      const warn = process.emitWarning;
      process.emitWarning = () => {}; // 屏蔽 node:sqlite 的"实验特性"警告
      try { sqliteMod = await import('node:sqlite'); } finally { process.emitWarning = warn; }
    } catch { sqliteMod = null; }
  }
  if (sqliteMod?.DatabaseSync) {
    const d = new sqliteMod.DatabaseSync(db, { readOnly: true });
    try { return d.prepare(sql).all(); } finally { d.close(); }
  }
  // 老版本 Node 没有 node:sqlite：用 python3 读
  const py = 'import sqlite3,json,sys\nd=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True)\nd.row_factory=sqlite3.Row\nprint(json.dumps([dict(r) for r in d.execute(sys.argv[2]).fetchall()],ensure_ascii=False,default=str))';
  const r = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', py, db, sql], { encoding: 'utf8', maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`读 ${path.basename(db)} 失败：${String(r.stderr || r.error?.message || '').trim().split('\n').pop()}`);
  return JSON.parse(r.stdout);
}

const sq = (s) => `'${String(s).replace(/'/g, "''")}'`;
const fileSig = (st) => `${st.size}:${Math.floor(st.mtimeMs)}`;

// 一个"来源"列出本机所有会话：{ id, sig, mtime, load() }；sig 没变的会话不重新解析
function convSources(state) {
  const home = os.homedir();
  const filesUnder = (dir, test, depth) => {
    const out = [];
    const rec = (d, lv) => {
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) { if (lv < depth) rec(full, lv + 1); } else if (e.isFile() && test(e.name)) out.push(full);
      }
    };
    rec(dir, 0);
    return out;
  };
  const fileItems = (tool, files, parse) => files.map((f) => {
    let st;
    try { st = fs.statSync(f); } catch { return null; }
    return { id: `${tool}:${f}`, sig: fileSig(st), mtime: st.mtimeMs, load: () => parse(f) };
  }).filter(Boolean);
  return [
    { tool: 'claude-code', list: () => fileItems('claude-code', filesUnder(path.join(home, '.claude', 'projects'), (n) => n.endsWith('.jsonl'), 1), parseClaudeConv) },
    {
      tool: 'codex',
      list: () => fileItems('codex', [
        ...filesUnder(path.join(home, '.codex', 'sessions'), (n) => n.endsWith('.jsonl'), 4),
        ...filesUnder(path.join(home, '.codex', 'archived_sessions'), (n) => n.endsWith('.jsonl'), 4),
      ], (f) => {
        // codex exec 是脚本或别的智能体派出去的批处理，结论会回到发起它的会话里，不存
        if (codexOriginator(f) === 'codex_exec') return { skip: 'codex exec 批处理' };
        const { meta, msgs } = parseCodexSession(f);
        const kept = msgs.map((m) => ({ ...m, ts: toIso(m.ts), text: convText(m.text, m.role) })).filter((m) => m.text);
        // 分叉/恢复的会话会把原会话的历史整段带过来：同一时间同一句话只算在第一次出现的会话里
        state.owner ||= {};
        const sid = meta.id || path.basename(f, '.jsonl');
        const mine = kept.filter((m) => {
          const h = sha(`${m.role}\n${m.ts || ''}\n${m.text}`);
          const owner = state.owner[h];
          if (owner && owner !== sid) return false;
          state.owner[h] = sid;
          return true;
        });
        const title = mine.find((m) => m.role === 'user')?.text.split('\n').find((l) => l.trim().length > 3) || '';
        return { sid, title, cwd: meta.cwd || '', started: toIso(meta.started) || '', msgs: mine };
      }),
    },
    { tool: 'workbuddy', list: () => fileItems('workbuddy', [...filesUnder(path.join(home, '.workbuddy', 'projects'), (n) => n.endsWith('.jsonl'), 1), ...filesUnder(path.join(home, '.workbuddy-ai', 'projects'), (n) => n.endsWith('.jsonl'), 1)], parseBuddyConv) },
    { tool: 'codebuddy', list: () => fileItems('codebuddy', filesUnder(path.join(home, '.codebuddy', 'projects'), (n) => n.endsWith('.jsonl'), 1), parseBuddyConv) },
    { tool: 'gemini', list: () => fileItems('gemini', filesUnder(path.join(home, '.gemini', 'tmp'), (n) => /^session-.*\.json$/.test(n), 3), parseGeminiConv) },
    { tool: 'qwen', list: () => fileItems('qwen', filesUnder(path.join(home, '.qwen', 'tmp'), (n) => /^session-.*\.json$/.test(n), 3), parseGeminiConv) },
    {
      // Hermes：全部会话在 ~/.hermes/state.db；健康检查、一次性调用这类不是人在聊的不存
      tool: 'hermes',
      list: async () => {
        const db = path.join(home, '.hermes', 'state.db');
        let rows = null;
        if (fs.existsSync(db)) {
          const q = (cols) => `select s.id, s.source, ${cols} s.started_at, count(m.id) n, max(m.id) mx from sessions s join messages m on m.session_id = s.id where m.role in ('user','assistant') group by s.id`;
          try { rows = await sqliteAll(db, q('s.title, s.cwd,')); } catch { try { rows = await sqliteAll(db, q('')); } catch { rows = null; } }
        }
        if (!rows) {
          // 老版本 Hermes：~/.hermes/sessions/session_*.json（messages 数组）
          return fileItems('hermes', filesUnder(path.join(home, '.hermes', 'sessions'), (n) => /^session_.*\.json$/.test(n), 0), (f) => {
            const j = JSON.parse(fs.readFileSync(f, 'utf8'));
            if (!Array.isArray(j.messages)) return { skip: '不是会话文件' };
            return {
              sid: j.session_id || path.basename(f, '.json'), title: '', cwd: j.cwd || '', started: toIso(j.session_start) || '',
              msgs: j.messages.filter((m) => m && (m.role === 'user' || m.role === 'assistant')).map((m) => ({ role: m.role, text: convText(blockText(m.content), m.role), ts: toIso(m.timestamp) })).filter((m) => m.text),
            };
          });
        }
        return rows.filter((r) => !/^(healthcheck|oneshot|cron|subagent|delegat)/i.test(r.source || '')).map((r) => ({
          id: `hermes:${r.id}`, sig: `${r.n}:${r.mx}`, mtime: Number(r.started_at) * 1000,
          load: async () => {
            const ms = await sqliteAll(db, `select role, content, timestamp from messages where session_id = ${sq(r.id)} and role in ('user','assistant') order by id`);
            return {
              sid: r.id, title: r.title || '', cwd: r.cwd || '', started: toIso(r.started_at) || '',
              msgs: ms.map((m) => ({ role: m.role, text: convText(m.content, m.role), ts: toIso(m.timestamp) })).filter((m) => m.text),
            };
          },
        }));
      },
    },
    {
      // OpenClaw：新版把会话文本放在每个 agent 的 openclaw-agent.sqlite（session_transcript_fts_content：c0 正文、c1 会话、c3 角色、c4 毫秒时间）；老版是 sessions/*.jsonl
      tool: 'openclaw',
      list: async () => {
        const base = path.join(home, '.openclaw', 'agents');
        let agents = [];
        try { agents = fs.readdirSync(base); } catch { return []; }
        const out = [];
        for (const a of agents) {
          const db = path.join(base, a, 'agent', 'openclaw-agent.sqlite');
          if (fs.existsSync(db)) {
            let rows = [];
            try { rows = await sqliteAll(db, "select c1 sid, count(*) n, max(c4) mx, min(c4) mn from session_transcript_fts_content where c3 in ('user','assistant') group by c1"); } catch { rows = null; }
            if (rows) {
              for (const r of rows) {
                out.push({
                  id: `openclaw:${a}:${r.sid}`, sig: `${r.n}:${r.mx}`, mtime: Number(r.mx),
                  load: async () => {
                    const ms = await sqliteAll(db, `select c3 role, c4 ts, c0 text from session_transcript_fts_content where c1 = ${sq(r.sid)} and c3 in ('user','assistant') order by c4, id`);
                    const msgs = ms.map((m) => ({ role: m.role, text: convText(m.text, m.role), ts: toIso(m.ts) })).filter((m) => m.text);
                    return { sid: `${a}:${r.sid}`, title: '', cwd: '', started: toIso(r.mn) || '', msgs };
                  },
                });
              }
              continue;
            }
          }
          out.push(...fileItems('openclaw', filesUnder(path.join(base, a, 'sessions'), (n) => n.endsWith('.jsonl') && !n.includes('.trajectory.'), 0), (f) => {
            const o = { sid: `${a}:${path.basename(f, '.jsonl')}`, title: '', cwd: '', started: '', msgs: [] };
            for (const r of jsonlRecords(f)) {
              if (r.type === 'session') { o.cwd ||= r.cwd || ''; o.started ||= toIso(r.timestamp) || ''; continue; }
              if (r.type !== 'message' || !r.message || (r.message.role !== 'user' && r.message.role !== 'assistant')) continue;
              const text = convText(blockText(r.message.content), r.message.role);
              if (text) o.msgs.push({ role: r.message.role, text, ts: toIso(r.timestamp) });
            }
            return o;
          }));
        }
        return out;
      },
    },
    {
      // OpenCode：~/.local/share/opencode/opencode.db（session / message.data.role / part.data.text）
      tool: 'opencode',
      list: async () => {
        const db = path.join(home, '.local', 'share', 'opencode', 'opencode.db');
        if (!fs.existsSync(db)) return [];
        const rows = await sqliteAll(db, 'select s.id, s.title, s.directory, s.time_created, count(p.id) n, max(p.time_updated) mx from session s join part p on p.session_id = s.id group by s.id');
        return rows.map((r) => ({
          id: `opencode:${r.id}`, sig: `${r.n}:${r.mx}`, mtime: Number(r.mx),
          load: async () => {
            const ps = await sqliteAll(db, `select m.id mid, m.time_created ts, m.data md, p.data pd from message m join part p on p.message_id = m.id where m.session_id = ${sq(r.id)} order by m.time_created, p.time_created, p.id`);
            const msgs = [];
            let cur = null;
            for (const x of ps) {
              let role = '';
              let part = {};
              try { role = JSON.parse(x.md).role; part = JSON.parse(x.pd); } catch { continue; }
              if ((role !== 'user' && role !== 'assistant') || part.type !== 'text' || part.synthetic) continue;
              if (cur && cur.mid === x.mid) cur.text += `\n${part.text || ''}`;
              else { cur = { mid: x.mid, role, text: part.text || '', ts: toIso(x.ts) }; msgs.push(cur); }
            }
            return {
              sid: r.id, title: r.title || '', cwd: r.directory || '', started: toIso(r.time_created) || '',
              msgs: msgs.map((m) => ({ role: m.role, text: convText(m.text, m.role), ts: m.ts })).filter((m) => m.text),
            };
          },
        }));
      },
    },
  ];
}

// 把一个会话的新消息追加到中心；中心条数和本地对不上时按中心说的对齐，本地变少了（文件被改写）就整份重传
async function pushConv(cfg, tool, conv, prev) {
  const msgs = conv.msgs;
  const hashOf = (m) => sha(`${m.role}\n${m.text}`);
  let base = prev?.sent || 0;
  let replace = !prev;
  if (prev && (base > msgs.length || (base && prev.h && hashOf(msgs[base - 1]) !== prev.h))) { base = 0; replace = true; }
  const titleLine = (conv.title || msgs.find((m) => m.role === 'user')?.text.split('\n').find((l) => l.trim().length > 3) || conv.sid).trim();
  const meta = { tool, session_id: String(conv.sid), title: redact(titleLine).slice(0, 100), cwd: conv.cwd || '', started: conv.started || msgs[0]?.ts || '' };
  if (!replace && base === msgs.length) return { sent: base, h: prev?.h, chars: 0 };
  let chars = 0;
  for (let attempt = 0, i = base; i < msgs.length || replace;) {
    const chunk = [];
    let size = 0;
    while (i < msgs.length && (!chunk.length || size + msgs[i].text.length < CONV_REQ_MAX) && chunk.length < 2000) {
      chunk.push(msgs[i]);
      size += msgs[i].text.length;
      i++;
    }
    const req = {
      body: { ...meta, base: replace ? 0 : i - chunk.length, replace, messages: chunk.map((m) => ({ role: m.role, text: redact(m.text), ts: m.ts })) },
      timeout: 120000,
    };
    let raw;
    // 连接复用时偶尔碰上对端刚关掉空闲连接（fetch failed），隔一秒重试一次
    try { raw = await api(cfg, 'POST', '/v1/conv/append', req); } catch (e) {
      if (!/fetch failed|ECONNRESET|socket/i.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 1000));
      raw = await api(cfg, 'POST', '/v1/conv/append', req);
    }
    const res = JSON.parse(raw);
    if (!res.ok) {
      // 中心条数和本地不一致：按中心的条数接着传；中心要求整份替换（历史导入件）或中心比本地还多，就整份重来
      if (++attempt > 3) throw new Error(`中心条数对不上（中心 ${res.count}，本地 ${msgs.length}）`);
      if (res.replace || res.count > msgs.length) { i = 0; replace = true; } else { i = res.count; replace = false; }
      continue;
    }
    chars += size;
    replace = false;
  }
  return { sent: msgs.length, h: msgs.length ? hashOf(msgs[msgs.length - 1]) : '', chars };
}

async function syncConversations(cfg) {
  if (cfg.conversations === false) return null;
  const disabled = new Set(cfg.conversations?.disabled || []);
  let cs = {};
  try { cs = JSON.parse(fs.readFileSync(CONV_STATE_FILE, 'utf8')); } catch { /* 首次 */ }
  cs.items ||= {};
  // 新版本（采集规则可能变了）第一次运行：全部重新看一遍；条数没变的不会重传
  if (cs.version !== VERSION) {
    for (const v of Object.values(cs.items)) delete v.sig;
    cs.version = VERSION;
  }
  const started = Date.now();
  // 每次同步最多传这么多字、跑这么久，补历史时分几轮（10 分钟一轮）做完
  const budget = parseInt(process.env.AM_CONV_RUN_MAX, 10) || 12e6;
  const timeLimit = (parseInt(process.env.AM_CONV_SECONDS, 10) || 240) * 1000;
  let used = 0;
  let pushed = 0;
  let dirty = 0;
  const stats = {};
  const save = () => {
    const owners = Object.keys(cs.owner || {});
    if (owners.length > 150000) for (const k of owners.slice(0, owners.length - 150000)) delete cs.owner[k];
    const tmp = `${CONV_STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cs));
    fs.renameSync(tmp, CONV_STATE_FILE);
    dirty = 0;
  };
  let stopped = false;
  try {
    for (const src of convSources(cs)) {
      if (disabled.has(src.tool)) continue;
      let items = [];
      try { items = await src.list(); } catch (e) { log(`对话采集 ${src.tool}：列会话失败 ${e.message}`); continue; }
      // 最近动过的先传。进行中的会话也传（只取写完整的行，没写完的下次接着传），这样"今天在做什么"是新的
      items = items.filter((it) => cs.items[it.id]?.sig !== it.sig).sort((a, b) => b.mtime - a.mtime);
      for (const it of items) {
        if (used >= budget || Date.now() - started > timeLimit) { stopped = true; break; }
        const prev = cs.items[it.id];
        let conv;
        try { conv = await it.load(); } catch (e) { log(`对话采集 ${src.tool}：解析 ${it.id} 失败 ${e.message}`); continue; }
        if (!conv.skip && CONV_AUTO_CWD.test(conv.cwd || '')) conv.skip = '临时目录里的会话';
        if (conv.skip || !conv.msgs?.length) {
          // 以前传过、现在判定不该存（规则更新了）：让中心删掉
          if (prev?.sent && prev.sid) {
            try { await api(cfg, 'POST', '/v1/conv/append', { body: { tool: src.tool, session_id: prev.sid, drop: true } }); } catch (e) { log(`对话采集 ${src.tool}：删除 ${prev.sid} 失败 ${e.message}`); continue; }
          }
          cs.items[it.id] = { sig: it.sig, skip: conv.skip || '无消息' };
          dirty++;
          continue;
        }
        try {
          const r = await pushConv(cfg, src.tool, conv, prev?.sent !== undefined ? prev : null);
          cs.items[it.id] = { sig: it.sig, sid: String(conv.sid), sent: r.sent, h: r.h };
          used += r.chars;
          if (r.chars) { pushed++; stats[src.tool] = (stats[src.tool] || 0) + 1; }
          if (++dirty >= 20) save();
        } catch (e) {
          log(`对话采集 ${src.tool}：上传 ${conv.sid} 失败 ${e.message}`);
          if (/→ 5\d\d|ECONN|fetch failed|aborted|存档盘/.test(e.message)) { stopped = true; break; } // 中心不通就别一个个试了
        }
      }
      if (stopped) break;
    }
  } finally {
    if (dirty || pushed) save();
  }
  if (pushed) log(`对话上传：${Object.entries(stats).map(([k, v]) => `${k} ${v} 个`).join('，')}，共 ${(used / 1e6).toFixed(2)}M 字${stopped ? '（本轮额度用完，下轮接着传）' : ''}`);
  return pushed;
}

// ----------------------------------------------------------------- vault ----

// 0.8 起用 v2 视图（日志/对话/记忆/项目互相链接），按文件签名增量同步；中心不支持时退回整份视图
async function syncVault2(cfg, dir, state) {
  state.vault2 ||= {};
  const st = (state.vault2[dir] ||= { etag: '', sigs: {} });
  const res = await fetch(`${cfg.hub}/v1/vault2/manifest${st.etag && st.complete ? `?etag=${st.etag}` : ''}`, { headers: { authorization: `Bearer ${cfg.token}` } });
  if (res.status === 304) return true;
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`GET /v1/vault2/manifest → ${res.status}`);
  const { etag, files } = await res.json();
  fs.mkdirSync(dir, { recursive: true });
  writeIfChanged(path.join(dir, '.agent-memory-vault'), 'agent-memory 生成的只读视图，改了会被覆盖。\n');
  const want = Object.keys(files).filter((rel) => !rel.includes('..') && !path.isAbsolute(rel) && (st.sigs[rel] !== files[rel] || !fs.existsSync(path.join(dir, rel))));
  let changed = 0;
  const started = Date.now();
  st.complete = false;
  for (let i = 0; i < want.length && Date.now() - started < 240e3;) {
    const batch = want.slice(i, i + 200);
    const got = JSON.parse(await api(cfg, 'POST', '/v1/vault2/files', { body: { paths: batch }, timeout: 120000 }));
    const names = Object.keys(got);
    if (!names.length) break;
    for (const rel of names) {
      if (writeIfChanged(path.normalize(path.join(dir, rel)), got[rel].content)) changed++;
      st.sigs[rel] = got[rel].sig;
    }
    i += batch.filter((rel) => got[rel]).length === batch.length ? batch.length : names.length;
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  }
  // 中心已经没有的文件删掉（只删 .md，只在带标记的目录里）
  let removed = 0;
  for (const f of walk(dir)) {
    const rel = path.relative(dir, f).split(path.sep).join('/');
    if (f.endsWith('.md') && !(rel in files)) { fs.rmSync(f); delete st.sigs[rel]; removed++; }
  }
  for (const rel of Object.keys(st.sigs)) if (!(rel in files)) delete st.sigs[rel];
  st.complete = want.every((rel) => st.sigs[rel] === files[rel]);
  st.etag = etag;
  if (changed || removed) log(`vault ${dir}: ${changed} 个文件更新，${removed} 个删除${st.complete ? '' : '（没传完，下轮接着）'}`);
  return true;
}

async function syncVault(cfg, t, state) {
  const dir = expand(t.path);
  const marker = path.join(dir, '.agent-memory-vault');
  let existing = [];
  try { existing = fs.readdirSync(dir); } catch { /* 新目录 */ }
  if (existing.length && !fs.existsSync(marker)) {
    log(`vault skipped: ${dir} 已有别的文件且不是本程序建的，换个空目录`);
    return;
  }
  if (await syncVault2(cfg, dir, state)) return;
  state.vault ||= {};
  const etag = state.vault[dir] || '';
  const url = `${cfg.hub}/v1/vault${etag ? `?etag=${etag}` : ''}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${cfg.token}` } });
  if (res.status === 304) return;
  if (!res.ok) throw new Error(`GET /v1/vault → ${res.status}`);
  const { etag: next, files } = await res.json();
  fs.mkdirSync(dir, { recursive: true });
  writeIfChanged(marker, 'agent-memory 生成的只读视图，改了会被覆盖。\n');
  const want = new Set();
  let changed = 0;
  for (const [rel, content] of Object.entries(files)) {
    if (rel.includes('..') || path.isAbsolute(rel)) continue;
    const full = path.normalize(path.join(dir, rel));
    want.add(full);
    if (writeIfChanged(full, content)) changed++;
  }
  let removed = 0;
  for (const f of walk(dir)) {
    if (f.endsWith('.md') && !want.has(path.normalize(f))) { fs.rmSync(f); removed++; }
  }
  state.vault[dir] = next;
  log(`vault ${dir}: ${changed} 个文件更新，${removed} 个删除`);
}

function writeIfChanged(file, content) {
  let old = null;
  try { old = fs.readFileSync(file, 'utf8'); } catch { /* 新文件 */ }
  if (old === content) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
  return true;
}

// 指令文件里的命令行示例换成本机真实路径（有的机器 node 不在 PATH 里，比如安装时下载到 ~/.agent-memory 的那份）
function localCli(text) {
  const q = (p) => { const s = p.split(path.sep).join('/'); return /\s/.test(s) ? `"${s}"` : s; };
  return String(text).split('node ~/.agent-memory/kb-agent.mjs').join(`${q(process.execPath)} ${q(path.join(HOME_DIR, 'kb-agent.mjs'))}`);
}

function replaceBlock(file, block) {
  let old = '';
  try { old = fs.readFileSync(file, 'utf8'); } catch { /* 新文件 */ }
  const bom = old.startsWith('\uFEFF') ? '\uFEFF' : '';
  const bodyOld = bom ? old.slice(1) : old;
  const eol = bodyOld.includes('\r\n') ? '\r\n' : '\n';
  const wrapped = [BEGIN, block.trim(), END].join('\n').replace(/\r?\n/g, eol);
  const start = bodyOld.indexOf(BEGIN);
  const end = bodyOld.indexOf(END);
  let next;
  if (start >= 0 && end > start) next = bodyOld.slice(0, start) + wrapped + bodyOld.slice(end + END.length);
  else next = (bodyOld.trimEnd() ? bodyOld.trimEnd() + eol + eol : '') + wrapped + eol;
  return writeIfChanged(file, bom + next);
}

function acquireLock() {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  try {
    const st = fs.statSync(LOCK_FILE);
    if (Date.now() - st.mtimeMs < 10 * 60e3) return false; // 上一次还在跑
    fs.rmSync(LOCK_FILE, { force: true });
  } catch { /* 没有锁 */ }
  try { fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' }); return true; } catch { return false; }
}

async function sync() {
  let cfg = loadConfig();
  if (!acquireLock()) { log('sync skipped: another sync is running'); return; }
  try {
    let state = {};
    try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { /* 首次 */ }
    state.sources ||= {};
    if (state.agent_version !== VERSION) {
      // 新版本第一次运行：重跑一遍识别（接上新支持的工具），原生记忆全量重发一次（中心按内容去重）
      try {
        log(`新版本 ${VERSION} 首次运行：${setup(true).join('；')}`);
        cfg = loadConfig();
      } catch (e) {
        log(`新版本重跑识别失败：${e.message}`);
      }
      state.sources = {};
      state.agent_version = VERSION;
      state.known_tools = detectTools();
    }
    // 每次同步：发现新装的智能体就接上（只接新出现的；以前接过、后来你自己去掉的不会再加回来）
    try {
      const present = detectTools();
      state.known_tools ||= present;
      const fresh = present.filter((t) => !state.known_tools.includes(t));
      if (fresh.length) {
        log(`发现新装的智能体 ${fresh.join('、')}：${setup(true, new Set(fresh)).join('；')}`);
        cfg = loadConfig();
        state.known_tools = [...new Set([...state.known_tools, ...fresh])];
      }
      // 立刻存盘：后面同步就算失败，也不会下次再把这些当成"新装的"重配一遍
      fs.writeFileSync(STATE_FILE, JSON.stringify(state));
    } catch (e) {
      log(`识别新智能体失败：${e.message}`);
    }
    const summary = {};
    for (const src of cfg.sources) {
      if (src.kind === 'codex-sessions') {
        try {
          summary[`${src.tool || 'codex'}-sessions`] = await syncCodexSessions(cfg, src, state);
        } catch (e) {
          log(`codex sessions failed: ${e.message}`);
        }
        continue;
      }
      const files = collect(src);
      const known = state.sources[src.tool] || {};
      const changed = files.filter((f) => known[f.key] !== sha(f.content));
      const res = JSON.parse(await api(cfg, 'POST', '/v1/native/sync', {
        body: { tool: src.tool, files: changed, present: files.map((f) => f.key), force_retire: process.env.AM_FORCE_RETIRE === '1' },
        timeout: 120000,
      }));
      if (res.retire_blocked) log(`⚠ ${src.tool} 的来源比中心记录少了 ${res.retire_blocked} 条，中心没作废（防整批误删）；确认是真删了就用 AM_FORCE_RETIRE=1 再同步`);
      const next = {};
      // 因为含密钥被拒收的也记下哈希（内容不变就不重复提交）；因为太大等原因被拒的不记，下次重试
      const retry = new Set(res.rejected.filter((r) => r.reason === '文件过大' || r.reason === '非法路径').map((r) => r.key));
      for (const f of files) if (!retry.has(f.key)) next[f.key] = sha(f.content);
      state.sources[src.tool] = next;
      summary[src.tool] = files.length;
      const msg = `sync ${src.tool}: files=${files.length} sent=${changed.length} +${res.added} ~${res.updated} -${res.retired}`;
      log(res.rejected.length ? `${msg} rejected=${JSON.stringify(res.rejected)}` : msg);
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
    try { summary.conversations = await syncConversations(cfg); } catch (e) { log(`对话上传失败：${e.message}`); }
    try { const d = path.join(os.homedir(), '.workbuddy-ai'); if (fs.existsSync(d)) summary._layout_workbuddy_ai = fs.readdirSync(d).filter((n) => !n.startsWith('.')).slice(0, 40).join(','); } catch { /* 只是诊断 */ }
    let wiring = {};
    try { wiring = wiringReport(cfg); } catch (e) { log(`接入状态检查失败：${e.message}`); }
    await api(cfg, 'POST', '/v1/heartbeat', { body: { agent_version: VERSION, hostname: os.hostname(), sources: summary, wiring } });
    try { await flushOutbox(cfg); } catch (e) { log(`outbox 补写失败：${e.message}`); }
    try { if (await refreshSnapshot(cfg, state)) fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch (e) { log(`快照更新失败：${e.message}`); }
    await maybeSelfUpdate(cfg);
    for (const t of cfg.targets) {
      if (t.kind === 'vault') {
        try { await syncVault(cfg, t, state); } catch (e) { log(`vault failed: ${e.message}`); }
        fs.writeFileSync(STATE_FILE, JSON.stringify(state));
        continue;
      }
      if (t.kind === 'backup') {
        try { await pullBackup(cfg, t, state); } catch (e) { log(`备份失败：${e.message}`); }
        fs.writeFileSync(STATE_FILE, JSON.stringify(state));
        continue;
      }
      if (t.kind === 'rules') {
        const rules = await api(cfg, 'GET', `/v1/rules?tool=${encodeURIComponent(t.rules_tool || t.tool)}`);
        if (replaceBlock(expand(t.path), localCli(rules))) log(`updated rules ${expand(t.path)}`);
        continue;
      }
      const [rules, dig] = await Promise.all([
        api(cfg, 'GET', `/v1/rules?tool=${encodeURIComponent(t.tool)}`),
        api(cfg, 'GET', `/v1/digest?tool=${encodeURIComponent(t.tool)}`),
      ]);
      const content = localCli(`${rules.trim()}\n\n${dig.trim()}\n`);
      const file = expand(t.path);
      const changed = t.kind === 'block' ? replaceBlock(file, content) : writeIfChanged(file, content);
      if (changed) log(`updated ${t.kind} ${file}`);
    }
  } finally {
    fs.rmSync(LOCK_FILE, { force: true });
  }
}

// ------------------------------------------------------------- MCP proxy ----

// ------------------------------------------------- offline snapshot / outbox ----
// 中心连不上时：查询用本机快照回答，写入先存进 outbox，下次同步时补写

const SNAPSHOT_FILE = path.join(HOME_DIR, 'snapshot.json');
const OUTBOX_FILE = path.join(HOME_DIR, 'outbox.jsonl');
const MCP_CACHE_FILE = path.join(HOME_DIR, 'mcp-cache.json');
const TYPE_LABEL = { preference: '偏好', feedback: '反馈', decision: '决定', status: '现状', pitfall: '坑', fact: '事实', reference: '参考' };

async function refreshSnapshot(cfg, state) {
  const url = `${cfg.hub}/v1/export${state.snapshot_etag && fs.existsSync(SNAPSHOT_FILE) ? `?etag=${state.snapshot_etag}` : ''}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${cfg.token}`, 'accept-encoding': 'gzip' } });
  if (res.status === 304) return false;
  if (!res.ok) throw new Error(`GET /v1/export → ${res.status}`);
  const snap = await res.json();
  const tmp = `${SNAPSHOT_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(snap), { mode: 0o600 });
  fs.renameSync(tmp, SNAPSHOT_FILE);
  state.snapshot_etag = snap.etag;
  return true;
}

function loadSnapshot() {
  try { return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8')).entries || []; } catch { return []; }
}

function localSearch(args) {
  const entries = loadSnapshot();
  const terms = String(args.query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const max = Math.min(Math.max(parseInt(args.limit, 10) || 8, 1), 30);
  const pool = entries.filter((e) => (!args.type || e.type === args.type) && (!args.project || e.project.toLowerCase().includes(String(args.project).toLowerCase())));
  const scored = pool.map((e) => {
    const title = e.title.toLowerCase();
    const hay = [e.title, e.subject, e.project, e.tags.join(' '), e.body].join('\n').toLowerCase();
    let matched = 0;
    let score = 0;
    for (const t of terms) if (hay.includes(t)) { matched++; score += title.includes(t) ? 6 : 1; }
    return { e, matched, score };
  });
  let hits = scored.filter((s) => s.matched === terms.length && terms.length);
  if (!hits.length) hits = scored.filter((s) => s.matched > 0);
  hits.sort((a, b) => b.matched - a.matched || b.score - a.score || Date.parse(b.e.updated) - Date.parse(a.e.updated));
  if (!hits.length) return `（中心暂时连不上，以下是本机快照）没找到和「${args.query || ''}」相关的记忆（快照里共 ${entries.length} 条）。`;
  return [`（中心暂时连不上，以下来自本机快照，可能不是最新）找到 ${Math.min(hits.length, max)} 条：`,
    ...hits.slice(0, max).map(({ e }, i) => `${i + 1}. [${TYPE_LABEL[e.type] || e.type}] ${e.title} · id=${e.id} · ${e.author}/${e.client} · ${String(e.updated).slice(0, 10)}`),
    '用 memory_get 加 id 看全文。'].join('\n');
}

function offlineTool(name, args, client) {
  const entries = loadSnapshot();
  switch (name) {
    case 'memory_search': return localSearch(args);
    case 'memory_get': {
      const e = entries.find((x) => x.id === String(args.id || '').trim());
      return e ? `（本机快照）# ${e.title}\nid: ${e.id} | ${TYPE_LABEL[e.type] || e.type} | ${e.author}/${e.client} | ${String(e.updated).slice(0, 16)}\n---\n${e.body}` : `本机快照里没有 ${args.id}`;
    }
    case 'memory_recent': {
      const since = Date.now() - (parseInt(args.hours, 10) || 72) * 3600e3;
      const xs = entries.filter((e) => Date.parse(e.updated) >= since).slice(0, parseInt(args.limit, 10) || 20);
      return xs.length ? `（本机快照）${xs.map((e) => `- [${TYPE_LABEL[e.type] || e.type}] ${e.title} · id=${e.id}`).join('\n')}` : '（本机快照）这段时间没有新的记忆。';
    }
    case 'memory_remember': {
      fs.appendFileSync(OUTBOX_FILE, `${JSON.stringify({ t: new Date().toISOString(), client, args })}\n`, { mode: 0o600 });
      return '中心暂时连不上，这条已存在本机，中心恢复后的下一次同步（10 分钟内）会自动写入。';
    }
    default: return null;
  }
}

async function flushOutbox(cfg) {
  if (!fs.existsSync(OUTBOX_FILE)) return;
  const work = `${OUTBOX_FILE}.sending`;
  if (!fs.existsSync(work)) fs.renameSync(OUTBOX_FILE, work);
  const lines = fs.readFileSync(work, 'utf8').split('\n').filter(Boolean);
  const failed = [];
  let ok = 0;
  for (const l of lines) {
    let it;
    try { it = JSON.parse(l); } catch { continue; }
    try {
      await api(cfg, 'POST', '/v1/remember', { body: it.args, client: it.client || 'outbox' });
      ok++;
    } catch (e) {
      // 内容问题（如含密钥被拒）不再重试；连不上才留着下次再发
      if (/→ (400|403|413)/.test(e.message)) log(`outbox 丢弃一条（${e.message}）：${String(it.args?.title || '').slice(0, 60)}`);
      else failed.push(l);
    }
  }
  if (failed.length) fs.appendFileSync(OUTBOX_FILE, `${failed.join('\n')}\n`, { mode: 0o600 });
  fs.rmSync(work, { force: true });
  if (ok || failed.length) log(`outbox：补写 ${ok} 条，剩 ${failed.length} 条`);
}

// 每天拉一份完整仓库的 git bundle（恢复：git clone xxx.bundle repo）
async function pullBackup(cfg, t, state) {
  const today = new Date().toISOString().slice(0, 10);
  if (state.backup_day === today) return;
  const dir = expand(t.path);
  fs.mkdirSync(dir, { recursive: true });
  const res = await fetch(`${cfg.hub}/v1/backup`, { headers: { authorization: `Bearer ${cfg.token}` } });
  if (!res.ok) throw new Error(`GET /v1/backup → ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.subarray(0, 20).toString().startsWith('# v2 git bundle') && !buf.subarray(0, 20).toString().startsWith('# v3 git bundle')) throw new Error('下载的不是 git bundle');
  const file = path.join(dir, `agent-memory-${today}.bundle`);
  fs.writeFileSync(`${file}.tmp`, buf, { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
  const all = fs.readdirSync(dir).filter((n) => /^agent-memory-\d{4}-\d{2}-\d{2}\.bundle$/.test(n)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - (t.keep || 14)))) fs.rmSync(path.join(dir, old), { force: true });
  state.backup_day = today;
  log(`备份 ${file}（${(buf.length / 1048576).toFixed(1)}MB）`);
}

async function mcpProxy(client) {
  const cfg = loadConfig();
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let queue = Promise.resolve();
  const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(MCP_CACHE_FILE, 'utf8')); } catch { /* 首次 */ }
  const offline = (m) => {
    const ok = (result) => write({ jsonrpc: '2.0', id: m.id, result });
    if (m.method === 'initialize' && cache.initialize) return ok({ ...cache.initialize, protocolVersion: m.params?.protocolVersion || cache.initialize.protocolVersion });
    if (m.method === 'tools/list' && cache.tools) return ok({ tools: cache.tools });
    if (m.method === 'ping') return ok({});
    if (m.method === 'tools/call') {
      const t = offlineTool(m.params?.name, m.params?.arguments || {}, client);
      if (t !== null) return ok({ content: [{ type: 'text', text: t }] });
      return ok({ content: [{ type: 'text', text: `共享记忆中心暂时连不上（重试过一次；中心升级重启时会断几秒，过一会儿再试）。${m.params?.name || '这个工具'}没有离线副本；memory_search / memory_get / memory_recent 离线也能用本机快照查。` }], isError: true });
    }
    return false;
  };
  rl.on('line', (line) => {
    if (!line.trim()) return;
    queue = queue.then(async () => {
      let msg;
      try { msg = JSON.parse(line); } catch { return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
      try {
        let txt;
        try {
          txt = await api(cfg, 'POST', '/mcp', { body: msg, client, timeout: 45000 });
        } catch (e) {
          // 中心重启（升级时几秒）或网络抖一下：等 3 秒再试一次，再不行才走离线
          if (/→ \d{3}/.test(e.message)) throw e;
          await new Promise((r) => setTimeout(r, 3000));
          txt = await api(cfg, 'POST', '/mcp', { body: msg, client, timeout: 45000 });
        }
        if (txt.trim()) process.stdout.write(txt.trim().replace(/\r?\n/g, ' ') + '\n');
        // 在线时记下握手和工具列表，离线时照样能让会话加载工具
        if (!Array.isArray(msg) && (msg.method === 'initialize' || msg.method === 'tools/list')) {
          try {
            const r = JSON.parse(txt).result;
            if (r) {
              cache[msg.method === 'initialize' ? 'initialize' : 'tools'] = msg.method === 'initialize' ? r : r.tools;
              fs.writeFileSync(MCP_CACHE_FILE, JSON.stringify(cache));
            }
          } catch { /* 缓存失败不影响正常使用 */ }
        }
      } catch (e) {
        log(`mcp proxy error: ${e.message}`);
        // 中心通着、只是这次请求报错（参数不对之类）：把错误原样告诉智能体，别说成"连不上"
        if (/→ \d{3}/.test(e.message)) {
          for (const m of (Array.isArray(msg) ? msg : [msg])) {
            if (m && m.id !== undefined && m.id !== null) write({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `共享记忆中心返回错误：${e.message}` }], isError: true } });
          }
          return;
        }
        for (const m of (Array.isArray(msg) ? msg : [msg])) {
          if (!m || m.id === undefined || m.id === null) continue;
          if (offline(m) === false) write({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: `共享记忆中心连不上：${e.message}` } });
        }
      }
    });
  });
  // stdin 关闭后不强制 process.exit：Windows 上会在 fetch 连接关闭途中触发 libuv 断言；
  // 等队列处理完，keep-alive 连接超时后进程自然退出
  rl.on('close', () => { queue.finally(() => { process.exitCode = 0; }); });
}

// ----------------------------------------------------------------- setup ----

// 本机装了哪些智能体（按目录判断），每次同步都看一遍，发现新装的就接上
const TOOL_DIRS = [
  ['claude-code', '.claude'], ['codex', '.codex'], ['hermes', '.hermes'], ['workbuddy', '.workbuddy'], ['workbuddy-ai', '.workbuddy-ai'], ['codebuddy', '.codebuddy'],
  ['gemini', '.gemini'], ['qwen', '.qwen'], ['cursor', '.cursor'], ['windsurf', '.codeium/windsurf'], ['opencode', '.config/opencode'],
  ['openclaw', '.openclaw/openclaw.json'],
];

function desktopDirOf(home) {
  return process.platform === 'darwin' ? path.join(home, 'Library/Application Support/Claude')
    : process.platform === 'win32' ? path.join(process.env.APPDATA || '', 'Claude') : '';
}

// 本机每个智能体接共享记忆的情况（给大屏的"智能体状态"）：插件开没开、指令文件里有没有说明/摘要
function wiringReport(cfg) {
  const home = os.homedir();
  const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
  const jsonMcp = (f, get) => {
    const t = read(f);
    if (t === null) return 'none';
    try { const e = get(JSON.parse(t)); return !e ? 'none' : (e.disabled === true || e.enabled === false) ? 'off' : 'on'; } catch { return 'unknown'; }
  };
  const ms = (d) => d?.mcpServers?.['agent-memory'];
  const desktop = desktopDirOf(home);
  const mcp = {
    'claude-code': () => jsonMcp(path.join(home, '.claude.json'), ms),
    codex: () => {
      const t = read(path.join(home, '.codex', 'config.toml'));
      if (!t) return 'none';
      const at = t.search(/^\[mcp_servers\.agent[_-]memory\]/m);
      if (at < 0) return 'none';
      const rest = t.slice(at + 1);
      const sect = rest.slice(0, (rest.search(/^\[/m) + 1 || rest.length + 1) - 1);
      return /^\s*enabled\s*=\s*false/m.test(sect) ? 'off' : 'on';
    },
    workbuddy: () => jsonMcp(path.join(home, '.workbuddy', 'mcp.json'), ms),
    'workbuddy-ai': () => jsonMcp(path.join(home, '.workbuddy-ai', 'mcp.json'), ms),
    codebuddy: () => jsonMcp(path.join(home, '.codebuddy', 'mcp.json'), ms),
    gemini: () => jsonMcp(path.join(home, '.gemini', 'settings.json'), ms),
    qwen: () => jsonMcp(path.join(home, '.qwen', 'settings.json'), ms),
    cursor: () => jsonMcp(path.join(home, '.cursor', 'mcp.json'), ms),
    windsurf: () => jsonMcp(path.join(home, '.codeium', 'windsurf', 'mcp_config.json'), ms),
    opencode: () => jsonMcp(path.join(home, '.config', 'opencode', 'opencode.json'), (d) => d?.mcp?.['agent-memory']),
    openclaw: () => jsonMcp(path.join(home, '.openclaw', 'openclaw.json'), (d) => d?.mcp?.servers?.['agent-memory']),
    hermes: () => { const t = read(path.join(home, '.hermes', 'config.yaml')); return t === null ? 'none' : /^\s+agent-memory:\s*$/m.test(t) ? 'on' : 'none'; },
    'claude-desktop': () => (desktop ? jsonMcp(path.join(desktop, 'claude_desktop_config.json'), ms) : 'none'),
  };
  const out = {};
  for (const id of detectTools()) {
    if (id === 'obsidian') continue;
    const r = { mcp: mcp[id] ? mcp[id]() : 'none' };
    const t = cfg.targets.find((x) => x.tool === id);
    if (t) { const txt = read(expand(t.path)); r.notes = txt && txt.includes(BEGIN) ? (t.kind === 'rules' ? 'rules' : 'digest') : 'missing'; }
    r.memory = cfg.sources.some((x) => x.tool === id && x.kind !== 'codex-sessions');
    out[id] = r;
  }
  return out;
}

function detectTools() {
  const home = os.homedir();
  const ids = TOOL_DIRS.filter(([, p]) => fs.existsSync(path.join(home, p))).map(([id]) => id);
  const dd = desktopDirOf(home);
  if (dd && fs.existsSync(dd)) ids.push('claude-desktop');
  if (process.platform === 'darwin') ids.push('obsidian');
  return ids;
}

// 自动发现本机的工具，配好同步来源、摘要目标和 MCP。可重复执行；改文件前先备份。
// only：只处理这些工具（每次同步发现的新智能体）；不传就全部处理（安装和升级时）
function setup(quiet = false, only = null) {
  const cfg = loadConfig();
  const home = os.homedir();
  const allow = (id) => !only || only.has(id);
  const dirTool = (p) => (TOOL_DIRS.find(([, d]) => p === d || p.startsWith(`${d.split('/')[0]}/`) || p.startsWith(`${d}/`)) || [])[0];
  const has = (p) => fs.existsSync(path.join(home, p)) && allow(dirTool(p));
  const fwd = (p) => p.split(path.sep).join('/');
  const agentPath = fwd(path.join(HOME_DIR, 'kb-agent.mjs'));
  const nodePath = fwd(process.execPath);
  const backupDir = path.join(HOME_DIR, `backup-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}`);
  const backup = (file) => {
    if (!fs.existsSync(file)) return;
    fs.mkdirSync(backupDir, { recursive: true });
    fs.copyFileSync(file, path.join(backupDir, path.basename(file)));
  };
  const addSource = (s) => { if (!cfg.sources.some((x) => x.tool === s.tool && x.kind === s.kind)) cfg.sources.push(s); };
  const addTarget = (t) => { if (!cfg.targets.some((x) => x.tool === t.tool)) cfg.targets.push(t); };
  const done = [];

  if (has('.claude')) {
    addSource({ tool: 'claude-code', kind: 'claude-memory', root: '~/.claude/projects' });
    addTarget({ tool: 'claude-code', kind: 'block', path: '~/.claude/CLAUDE.md' });
    const cj = path.join(home, '.claude.json');
    let d = {};
    try { d = JSON.parse(fs.readFileSync(cj, 'utf8')); } catch { /* 还没有 */ }
    const want = { type: 'stdio', command: nodePath, args: [agentPath, 'mcp', '--client', 'claude-code'], env: {} };
    if (JSON.stringify(d.mcpServers?.['agent-memory']) !== JSON.stringify(want)) {
      backup(cj);
      d.mcpServers ||= {};
      d.mcpServers['agent-memory'] = want;
      fs.writeFileSync(`${cj}.tmp-am`, JSON.stringify(d, null, 2));
      fs.renameSync(`${cj}.tmp-am`, cj);
    }
    done.push('Claude Code：记忆同步 + CLAUDE.md 摘要块 + MCP');
  }
  if (has('.codex')) {
    addTarget({ tool: 'codex', kind: 'block', path: '~/.codex/AGENTS.md' });
    const toml = path.join(home, '.codex', 'config.toml');
    let t = '';
    try { t = fs.readFileSync(toml, 'utf8'); } catch { /* 还没有 */ }
    if (!t.includes('[mcp_servers.agent_memory]')) {
      backup(toml);
      const eol = t.includes('\r\n') ? '\r\n' : '\n';
      t = (t.trimEnd() ? t.trimEnd() + eol + eol : '') + [
        '[mcp_servers.agent_memory]',
        `command = '${nodePath}'`,
        `args = ['${agentPath}', 'mcp', '--client', 'codex']`,
        'startup_timeout_sec = 20',
      ].join(eol) + eol;
      fs.writeFileSync(toml, t);
    }
    done.push('Codex：AGENTS.md 摘要块 + MCP');
  }
  // Hermes 的记忆有两种布局：~/.hermes/memories/ 下，或直接在 ~/.hermes/ 下；USER.md 是对你的了解，MEMORY.md 是它记的环境和事实
  const hermesFiles = [
    ['.hermes/memories/USER.md', 'preference'], ['.hermes/memories/MEMORY.md', 'fact'],
    ['.hermes/USER.md', 'preference'], ['.hermes/MEMORY.md', 'fact'],
  ].filter(([p]) => has(p)).map(([p, t]) => ({ path: `~/${p}`, type_hint: t }));
  if (hermesFiles.length) {
    cfg.sources = cfg.sources.filter((s) => !(s.tool === 'hermes' && s.kind === 'section-file'));
    cfg.sources.push({ tool: 'hermes', kind: 'section-file', files: hermesFiles, separator: '§' });
    done.push(`Hermes：${hermesFiles.map((f) => path.basename(f.path)).join('、')} 分段同步`);
  }
  if (has('.hermes/config.yaml')) {
    const y = (() => { try { return fs.readFileSync(path.join(home, '.hermes/config.yaml'), 'utf8'); } catch { return ''; } })();
    if (/^\s+agent-memory:\s*$/m.test(y)) done.push('Hermes：MCP 已配');
    else {
      const cli = [path.join(home, '.local/bin/hermes'), '/opt/hermes-cloud/app/venv/bin/hermes', '/usr/local/bin/hermes', 'hermes']
        .find((c) => c === 'hermes' || fs.existsSync(c));
      backup(path.join(home, '.hermes/config.yaml'));
      // 旧版 Hermes 不认 --connect-timeout，--args 后面也不能带 -- 开头的参数，所以用 "mcp hermes" 的写法
      const r = spawnSync(cli, ['mcp', 'add', 'agent-memory', '--command', nodePath, '--args', agentPath, 'mcp', 'hermes'],
        { input: 'Y\n', encoding: 'utf8', timeout: 90000 });
      if (r.status === 0) done.push('Hermes：MCP（新开会话生效）');
      else {
        done.push('Hermes：MCP 没加上，可手动运行 hermes mcp add');
        log(`hermes mcp add 失败：${(r.stderr || r.stdout || r.error?.message || '').trim().split('\n').slice(-2).join(' | ')}`);
      }
    }
  }
  // 其他认 mcpServers JSON 的工具：只在本机装了的时候才动，解析不了的配置文件不碰
  const addMcpJson = (file, label, client, extra = {}) => {
    let d = {};
    if (fs.existsSync(file)) {
      try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { done.push(`${label}：配置文件不是标准 JSON，没改`); return; }
    }
    const cur = d.mcpServers?.['agent-memory'];
    // 用户手动停用的保持停用：只更新路径，不动开关
    const off = cur && (cur.disabled === true || cur.enabled === false);
    const want = { ...extra, command: nodePath, args: [agentPath, 'mcp', '--client', client], ...(cur?.disabled === true ? { disabled: true } : {}), ...(cur?.enabled === false ? { enabled: false } : {}) };
    if (JSON.stringify(cur) !== JSON.stringify(want)) {
      backup(file);
      d.mcpServers ||= {};
      d.mcpServers['agent-memory'] = want;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(d, null, 2));
    }
    done.push(off ? `${label}：MCP（你停用了，保持停用）` : `${label}：MCP`);
  };
  if (has('.codebuddy')) {
    // CodeBuddy（和 WorkBuddy 同一家）：mcp.json 格式一样；记忆在 memery/*_memery.md（原名就这么拼），按标题分段
    addMcpJson(path.join(home, '.codebuddy/mcp.json'), 'CodeBuddy', 'codebuddy', { type: 'stdio' });
    addSource({ tool: 'codebuddy', kind: 'heading-file', paths: ['~/.codebuddy/memery/*_memery.md'], type_hint: 'feedback' });
  }
  if (has('.gemini')) {
    addMcpJson(path.join(home, '.gemini/settings.json'), 'Gemini CLI', 'gemini');
    addTarget({ tool: 'gemini', kind: 'block', path: '~/.gemini/GEMINI.md' });
  }
  if (has('.qwen')) {
    addMcpJson(path.join(home, '.qwen/settings.json'), 'Qwen Code', 'qwen');
    addTarget({ tool: 'qwen', kind: 'block', path: '~/.qwen/QWEN.md' });
  }
  if (has('.cursor')) addMcpJson(path.join(home, '.cursor/mcp.json'), 'Cursor', 'cursor');
  if (has('.codeium/windsurf')) addMcpJson(path.join(home, '.codeium/windsurf/mcp_config.json'), 'Windsurf', 'windsurf');
  const desktopDir = desktopDirOf(home);
  if (desktopDir && fs.existsSync(desktopDir) && allow('claude-desktop')) addMcpJson(path.join(desktopDir, 'claude_desktop_config.json'), 'Claude 桌面版', 'claude-desktop');
  if (has('.config/opencode')) {
    // OpenCode 的格式不一样：mcp.<名字> = { type: "local", command: [...] }
    const f = path.join(home, '.config/opencode/opencode.json');
    let d = {};
    let ok = true;
    if (fs.existsSync(f)) { try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { ok = false; } }
    if (ok) {
      // 用户停用了（enabled:false）就保持停用
      const want = { type: 'local', command: [nodePath, agentPath, 'mcp', '--client', 'opencode'], enabled: d.mcp?.['agent-memory']?.enabled !== false };
      if (JSON.stringify(d.mcp?.['agent-memory']) !== JSON.stringify(want)) {
        backup(f);
        d.mcp ||= {};
        d.mcp['agent-memory'] = want;
        fs.writeFileSync(f, JSON.stringify(d, null, 2));
      }
      addTarget({ tool: 'opencode', kind: 'block', path: '~/.config/opencode/AGENTS.md' });
      done.push('OpenCode：AGENTS.md 摘要块 + MCP');
    } else done.push('OpenCode：opencode.json 不是标准 JSON，没改');
  }
  if (has('.codex/sessions')) {
    // Codex 没有自带记忆：最近 14 天、闲置 1 小时以上的会话压缩上传，由 home 夜里抽候选
    addSource({ tool: 'codex', kind: 'codex-sessions', root: '~/.codex/sessions', days: 14, idle_minutes: 60 });
    done.push('Codex：最近 14 天的会话压缩上传，夜里抽候选记忆');
  }
  // WorkBuddy：国内版 ~/.workbuddy，国际版 WorkBuddy AI ~/.workbuddy-ai。
  // 新版的身份文件（SOUL/IDENTITY/USER，每轮都注入）和用户级记忆 MEMORY.md 在 user-<账号>-personal/ 下，老版在根目录
  for (const [base, id, label] of [['.workbuddy', 'workbuddy', 'WorkBuddy'], ['.workbuddy-ai', 'workbuddy-ai', 'WorkBuddy AI']]) {
    if (!has(base)) continue;
    const dir = path.join(home, base);
    let personal = [];
    try { personal = fs.readdirSync(dir).filter((n) => /^user-.+-personal$/.test(n) && fs.statSync(path.join(dir, n)).isDirectory()); } catch { /* 没有 */ }
    personal.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
    addMcpJson(path.join(dir, 'mcp.json'), label, id, { type: 'stdio' });
    const mem = [`~/${base}/MEMORY.md`, `~/${base}/memory/*_memory.md`, ...personal.map((p) => `~/${base}/${p}/MEMORY.md`)];
    cfg.sources = cfg.sources.filter((s) => !(s.tool === id && s.kind === 'heading-file'));
    cfg.sources.push({ tool: id, kind: 'heading-file', paths: mem, type_hint: 'feedback' });
    // 每轮都读的 USER.md 末尾放一小段用法（先查共享记忆、旧知识卡片已冻结），不放摘要，省 token
    const userMd = personal.length ? `~/${base}/${personal[0]}/USER.md` : `~/${base}/USER.md`;
    cfg.targets = cfg.targets.filter((t) => t.tool !== id);
    cfg.targets.push({ tool: id, kind: 'rules', rules_tool: 'workbuddy', path: userMd });
    done.push(`${label}：MCP + 记忆同步 + ${userMd} 末尾加共享记忆用法`);
  }
  if (has('.openclaw/openclaw.json')) {
    // OpenClaw：工作区的 USER.md（整份一条）、MEMORY.md 和 memory/ 下的日记（按标题切）；梦境日记 DREAMS.md 是自动生成的，不同步
    const ws = '~/.openclaw/workspace';
    const files = [{ path: `${ws}/USER.md`, type_hint: 'preference', split: 'none' }, { path: `${ws}/MEMORY.md`, type_hint: 'fact', split: 'heading' }];
    try {
      for (const n of fs.readdirSync(path.join(home, '.openclaw/workspace/memory'))) {
        if (/^\d{4}-\d{2}-\d{2}.*\.md$/.test(n)) files.push({ path: `${ws}/memory/${n}`, type_hint: 'fact', split: 'heading' });
      }
    } catch { /* 没有 memory 目录 */ }
    cfg.sources = cfg.sources.filter((s) => s.tool !== 'openclaw');
    cfg.sources.push({ tool: 'openclaw', kind: 'section-file', files });
    // 机器人每条消息都带着 AGENTS.md，只放一小段用法说明，不放摘要（省 token），要细节用 MCP 查
    addTarget({ tool: 'openclaw', kind: 'rules', path: `${ws}/AGENTS.md` });
    let d0 = null;
    try { d0 = JSON.parse(fs.readFileSync(path.join(home, '.openclaw/openclaw.json'), 'utf8')); } catch { /* 下面再处理 */ }
    const cur0 = d0?.mcp?.servers?.['agent-memory'];
    // 用户停用了就保持停用
    const want = { command: nodePath, args: [agentPath, 'mcp', 'openclaw'], ...(cur0?.enabled === false ? { enabled: false } : {}), ...(cur0?.disabled === true ? { disabled: true } : {}) };
    const cfgFile = path.join(home, '.openclaw/openclaw.json');
    let d = null;
    try { d = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch { /* JSON5 之类，走命令行 */ }
    if (d && JSON.stringify(d.mcp?.servers?.['agent-memory']) === JSON.stringify(want)) done.push('OpenClaw：记忆同步 + MCP（已配）');
    else {
      backup(cfgFile);
      // 优先用 OpenClaw 自己的命令（会校验并热加载）；它要 Node 24+，用网关服务用的那个 node
      const entry = path.join(home, '.npm-global/lib/node_modules/openclaw/dist/index.js');
      const nodes = [process.execPath, ...(() => { try { return fs.readdirSync(path.join(home, '.local/share')).filter((n) => /^node-v2[4-9]/.test(n)).map((n) => path.join(home, '.local/share', n, 'bin/node')); } catch { return []; } })()];
      let ok = false;
      for (const n of nodes) {
        if (!fs.existsSync(entry) || !fs.existsSync(n)) continue;
        const r = spawnSync(n, [entry, 'mcp', 'set', 'agent-memory', JSON.stringify(want)], { encoding: 'utf8', timeout: 60000 });
        if (r.status === 0) {
          spawnSync(n, [entry, 'mcp', 'reload'], { encoding: 'utf8', timeout: 60000 });
          ok = true;
          break;
        }
      }
      if (!ok && d) {
        d.mcp ||= {};
        d.mcp.servers ||= {};
        d.mcp.servers['agent-memory'] = want;
        fs.writeFileSync(cfgFile, JSON.stringify(d, null, 2));
        ok = true;
      }
      done.push(ok ? 'OpenClaw：记忆同步 + MCP（网关重启或热加载后生效）' : 'OpenClaw：记忆同步；MCP 没配上，可手动 openclaw mcp set');
    }
  }
  if (process.platform === 'darwin' && allow('obsidian')) {
    addTarget({ tool: 'obsidian', kind: 'vault', path: '~/Documents/共享记忆' });
    done.push('Obsidian：只读视图同步到 ~/Documents/共享记忆（在 Obsidian 里"打开文件夹作为仓库"）');
    // Mac 一般不和中心在同一台机器上，正好做异地备份：每天拉一份完整的记忆仓库（含历史），留 14 份
    addTarget({ tool: 'backup', kind: 'backup', path: '~/.agent-memory/backups', keep: 14 });
    done.push('异地备份：每天把完整记忆仓库存一份到 ~/.agent-memory/backups');
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 1));
  if (!quiet) process.stdout.write(`设备 ${cfg.device} 已配置：\n${done.map((s) => `- ${s}`).join('\n') || '- 没发现支持的工具'}\n${fs.existsSync(backupDir) ? `改动前的备份：${backupDir}\n` : ''}`);
  return done;
}

// ------------------------------------------------------- join / schedule ----

const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

// 用加入链接登记本机（设备名取主机名）。已经登记过就沿用，不会重复登记
async function join(joinUrl) {
  // 两种：/auto（按 Tailscale 或虚拟机身份自动登记，不用码）、/join/<加入码>（不在 Tailscale 里的机器）
  const m = /^(https?:\/\/[^/]+)\/(join\/[0-9a-f]{24,}|auto)$/.exec(String(joinUrl || '').replace(/\/+$/, ''));
  if (!m) throw new Error('加入链接格式不对');
  const hub = m[1];
  const auto = m[2] === 'auto';
  fs.mkdirSync(HOME_DIR, { recursive: true });
  let cfg = null;
  try { cfg = JSON.parse(stripBom(fs.readFileSync(CONFIG_FILE, 'utf8'))); } catch { /* 新机器 */ }
  if (cfg?.token && cfg?.device) {
    Object.assign(cfg, { hub, sources: cfg.sources || [], targets: cfg.targets || [] });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 1));
    process.stdout.write(`这台机器已经是设备 ${cfg.device}，沿用原来的登记\n`);
    return;
  }
  const res = await fetch(auto ? `${hub}/v1/auto-register` : `${joinUrl.replace(/\/+$/, '')}/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    // 主机名不好认（如云主机自动生成的）时，加入前设 AM_DEVICE_NAME 指定设备名
    body: JSON.stringify({ name: process.env.AM_DEVICE_NAME || os.hostname(), platform: process.platform }),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`登记失败：${res.status} ${txt}`);
  const { device, token } = JSON.parse(txt);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ hub, device, token, sources: [], targets: [] }, null, 1), { mode: 0o600 });
  process.stdout.write(`已登记为设备 ${device}\n`);
}

// 按系统装"每 10 分钟同步一次"：Windows 计划任务 / macOS launchd / Linux systemd 用户定时器（不能常驻就用 crontab）
function schedule() {
  const node = process.execPath;
  const agent = path.join(HOME_DIR, 'kb-agent.mjs');
  const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const say = (s) => process.stdout.write(`${s}\n`);
  if (process.env.AM_NO_SCHEDULE) { say('（测试模式：跳过定时任务）'); return; }
  if (process.platform === 'win32') {
    const conhost = path.join(process.env.WINDIR || 'C:/Windows', 'System32', 'conhost.exe');
    const t = new Date(Date.now() + 60e3);
    const p2 = (n) => String(n).padStart(2, '0');
    const start = `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())}T${p2(t.getHours())}:${p2(t.getMinutes())}:00`;
    const user = `${process.env.USERDOMAIN || ''}\\${process.env.USERNAME || ''}`;
    const xml = [
      '<?xml version="1.0" encoding="UTF-16"?>',
      '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
      '<RegistrationInfo><Description>agent-memory: sync native memories and digest every 10 minutes</Description></RegistrationInfo>',
      `<Triggers><TimeTrigger><Repetition><Interval>PT10M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>${start}</StartBoundary><Enabled>true</Enabled></TimeTrigger></Triggers>`,
      `<Principals><Principal id="Author"><UserId>${xmlEsc(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>`,
      '<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT5M</ExecutionTimeLimit><Enabled>true</Enabled></Settings>',
      `<Actions Context="Author"><Exec><Command>${xmlEsc(conhost)}</Command><Arguments>${xmlEsc(`--headless "${node}" "${agent}" sync`)}</Arguments></Exec></Actions>`,
      '</Task>',
    ].join('\n');
    const f = path.join(HOME_DIR, 'task.xml');
    fs.writeFileSync(f, Buffer.from(String.fromCharCode(0xfeff) + xml, 'utf16le'));
    const r = spawnSync('schtasks', ['/Create', '/TN', 'AgentMemorySync', '/XML', f, '/F'], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`创建计划任务失败：${(r.stderr || r.stdout || '').trim()}`);
    say('已创建计划任务 AgentMemorySync（每 10 分钟，后台不弹窗）');
  } else if (process.platform === 'darwin') {
    const la = path.join(os.homedir(), 'Library/LaunchAgents');
    fs.mkdirSync(la, { recursive: true });
    const pl = path.join(la, 'com.agent-memory.sync.plist');
    fs.writeFileSync(pl, [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      '<key>Label</key><string>com.agent-memory.sync</string>',
      `<key>ProgramArguments</key><array><string>${xmlEsc(node)}</string><string>${xmlEsc(agent)}</string><string>sync</string></array>`,
      '<key>StartInterval</key><integer>600</integer><key>RunAtLoad</key><true/>',
      `<key>StandardOutPath</key><string>${xmlEsc(path.join(HOME_DIR, 'launchd.out'))}</string>`,
      `<key>StandardErrorPath</key><string>${xmlEsc(path.join(HOME_DIR, 'launchd.err'))}</string>`,
      '</dict></plist>', '',
    ].join('\n'));
    const uid = process.getuid();
    spawnSync('launchctl', ['bootout', `gui/${uid}/com.agent-memory.sync`]);
    const r = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, pl], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`launchd 加载失败：${(r.stderr || '').trim()}`);
    say('已加载 launchd 任务 com.agent-memory.sync（每 10 分钟）');
  } else {
    const me = os.userInfo().username;
    let useSystemd = spawnSync('systemctl', ['--user', 'show-environment'], { encoding: 'utf8' }).status === 0;
    if (useSystemd && !/Linger=yes/.test(spawnSync('loginctl', ['show-user', me, '-p', 'Linger'], { encoding: 'utf8' }).stdout || '')) {
      // 没开 linger 的话退出登录后定时器就停了：能开就开，开不了退回 crontab
      if (spawnSync('loginctl', ['enable-linger', me], { encoding: 'utf8' }).status !== 0) useSystemd = false;
    }
    if (useSystemd) {
      const u = path.join(os.homedir(), '.config/systemd/user');
      fs.mkdirSync(u, { recursive: true });
      fs.writeFileSync(path.join(u, 'agent-memory-sync.service'), `[Unit]\nDescription=agent-memory sync\n\n[Service]\nType=oneshot\nExecStart="${node}" "${agent}" sync\n`);
      fs.writeFileSync(path.join(u, 'agent-memory-sync.timer'), '[Unit]\nDescription=agent-memory sync every 10 minutes\n\n[Timer]\nOnBootSec=2min\nOnUnitActiveSec=10min\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n');
      spawnSync('systemctl', ['--user', 'daemon-reload']);
      const r = spawnSync('systemctl', ['--user', 'enable', '--now', 'agent-memory-sync.timer'], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`systemd 定时器启用失败：${(r.stderr || '').trim()}`);
      say('已启用 systemd 用户定时器 agent-memory-sync.timer（每 10 分钟）');
    } else {
      const cur = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
      if (cur.error) throw new Error('这台机器既没有可用的 systemd 用户服务，也没有 crontab，没法定时同步');
      const lines = (cur.status === 0 ? cur.stdout : '').split('\n').filter((l) => l.trim() && !l.includes('# agent-memory'));
      lines.push(`*/10 * * * * "${node}" "${agent}" sync >/dev/null 2>&1 # agent-memory`);
      const w = spawnSync('crontab', ['-'], { input: `${lines.join('\n')}\n`, encoding: 'utf8' });
      if (w.status !== 0) throw new Error(`写 crontab 失败：${(w.stderr || '').trim()}`);
      say('已加入 crontab（每 10 分钟）');
    }
  }
}

async function importFile(cfg, file, client) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!data.card || !Array.isArray(data.entries)) throw new Error('文件格式不对：要有 card 和 entries');
  return api(cfg, 'POST', '/v1/import', {
    body: { source: `kb-card:${data.card}`, project: data.project, entries: data.entries, replace: true },
    client, timeout: 120000,
  });
}

async function maybeSelfUpdate(cfg) {
  try {
    const h = JSON.parse(await api(cfg, 'GET', '/health'));
    if (h.agent_version && h.agent_version !== VERSION) {
      await selfUpdate(cfg, true);
      log(`自动升级 ${VERSION} → ${h.agent_version}（下次同步生效）`);
    }
  } catch (e) {
    log(`检查新版本失败：${e.message}`);
  }
}

async function selfUpdate(cfg, quiet = false) {
  const src = await api(cfg, 'GET', '/v1/agent');
  const m = /const VERSION = '([^']+)'/.exec(src);
  if (!m) throw new Error('下载的内容不像 kb-agent.mjs');
  const self = path.join(HOME_DIR, 'kb-agent.mjs');
  const changed = writeIfChanged(self, src);
  if (!quiet) process.stdout.write(changed ? `已更新到 ${m[1]}\n` : `已是最新 ${m[1]}\n`);
}

// ------------------------------------------------------------------- CLI ----

function parseFlags(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      flags[k] = v;
    } else rest.push(a);
  }
  return { flags, rest };
}

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  const { flags, rest } = parseFlags(argv);
  switch (cmd) {
    case 'sync':
      await sync();
      return;
    case 'mcp':
      // 也支持 "mcp <名字>"：有的工具（如旧版 Hermes）传不了以 -- 开头的参数
      await mcpProxy(flags.client || rest[0] || 'unknown');
      return;
    case 'search': {
      const cfg = loadConfig();
      const q = new URLSearchParams({ q: rest.join(' ') });
      for (const k of ['type', 'project', 'limit']) if (flags[k]) q.set(k, flags[k]);
      process.stdout.write(await api(cfg, 'GET', `/v1/search?${q}`, { client: flags.client || 'cli' }) + '\n');
      return;
    }
    case 'get': {
      const cfg = loadConfig();
      process.stdout.write(await api(cfg, 'GET', `/v1/entries/${encodeURIComponent(rest[0] || '')}`, { client: flags.client || 'cli' }) + '\n');
      return;
    }
    case 'remember': {
      const cfg = loadConfig();
      const body = { type: flags.type, title: flags.title, body: flags.body, subject: flags.subject, project: flags.project, tags: flags.tags, supersedes: flags.supersedes };
      process.stdout.write(await api(cfg, 'POST', '/v1/remember', { body, client: flags.client || 'cli' }) + '\n');
      return;
    }
    case 'digest': {
      const cfg = loadConfig();
      process.stdout.write(await api(cfg, 'GET', `/v1/digest?tool=${encodeURIComponent(flags.tool || 'cli')}`) + '\n');
      return;
    }
    case 'status': {
      const cfg = loadConfig();
      process.stdout.write(await api(cfg, 'GET', '/v1/status') + '\n');
      return;
    }
    case 'report': {
      const cfg = loadConfig();
      process.stdout.write(await api(cfg, 'GET', `/v1/report?hours=${flags.hours || 24}`) + '\n');
      return;
    }
    case 'setup':
      setup();
      return;
    case 'join':
      await join(rest[0]);
      return;
    case 'schedule':
      schedule();
      return;
    case 'import': {
      const cfg = loadConfig();
      for (const f of rest) process.stdout.write(`${f}: ${await importFile(cfg, f, flags.client || 'card-import')}\n`);
      return;
    }
    case 'update':
      await selfUpdate(loadConfig());
      return;
    case 'timeline': {
      // timeline [--date 11-20 | --from … --to … | --days 7] [--project x] [--query 词]
      const cfg = loadConfig();
      const q = new URLSearchParams();
      for (const k of ['date', 'from', 'to', 'days', 'project', 'query', 'device', 'tool']) if (flags[k] && flags[k] !== true) q.set(k, flags[k]);
      if (rest.length) q.set('query', rest.join(' '));
      process.stdout.write(await api(cfg, 'GET', `/v1/timeline?${q}`, { client: flags.client || 'cli' }) + '\n');
      return;
    }
    case 'convsearch': {
      const cfg = loadConfig();
      const q = new URLSearchParams({ q: rest.join(' ') });
      for (const k of ['from', 'to', 'device', 'tool', 'role', 'limit']) if (flags[k] && flags[k] !== true) q.set(k, flags[k]);
      process.stdout.write(await api(cfg, 'GET', `/v1/conv/search?${q}`, { client: flags.client || 'cli' }) + '\n');
      return;
    }
    case 'conv': {
      const cfg = loadConfig();
      const q = new URLSearchParams({ ref: rest[0] || '' });
      for (const k of ['date', 'from', 'role']) if (flags[k] && flags[k] !== true) q.set(k, flags[k]);
      if (flags.full) q.set('full', '1');
      process.stdout.write(await api(cfg, 'GET', `/v1/conv/get?${q}`, { client: flags.client || 'cli' }) + '\n');
      return;
    }
    case 'handoff': {
      // handoff --project myapp [--days 14] [关键词]：交接包（接力提示词）
      const cfg = loadConfig();
      const q = new URLSearchParams();
      for (const k of ['project', 'days']) if (flags[k] && flags[k] !== true) q.set(k, flags[k]);
      if (rest.length) q.set('query', rest.join(' '));
      process.stdout.write(await api(cfg, 'GET', `/v1/handoff?${q}`, { client: flags.client || 'cli' }) + '\n');
      return;
    }
    case 'todos': {
      const cfg = loadConfig();
      const q = new URLSearchParams();
      for (const k of ['project', 'days']) if (flags[k] && flags[k] !== true) q.set(k, flags[k]);
      process.stdout.write(await api(cfg, 'GET', `/v1/todos?${q}`, { client: flags.client || 'cli' }) + '\n');
      return;
    }
    case 'entity': {
      const cfg = loadConfig();
      process.stdout.write(await api(cfg, 'GET', `/v1/entity?name=${encodeURIComponent(rest.join(' '))}`, { client: flags.client || 'cli' }) + '\n');
      return;
    }
    case 'conv-push':
      // 立刻上传对话（不等定时任务），补历史时可放宽：AM_CONV_SECONDS=1800 AM_CONV_RUN_MAX=500000000
      process.stdout.write(`上传了 ${await syncConversations(loadConfig())} 个会话，详情看 ${LOG_FILE}\n`);
      return;
    default:
      process.stdout.write('用法：kb-agent.mjs sync | mcp --client <名字> | search <关键词…> | get <id> | remember --type … --title … | digest | status | report\n'
        + '       timeline [--date 11-20|--days 7] [--project x] [关键词] | convsearch <关键词…> | conv <ref> [--date d] | conv-push\n'
        + '       handoff --project x [--days 14] | todos [--project x] | entity <名字>\n');
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((e) => {
  log(`error: ${e.message}`);
  process.stderr.write(`agent-memory: ${e.message}\n`);
  process.exit(1);
});
