#!/usr/bin/env node
/* agent-memory hub —— 跨机器、跨智能体共享记忆的中心服务。
 *
 * 设计要点：
 * - 零依赖（Node >= 18）。真实数据是 git 仓库里一条一个的 markdown 文件，
 *   每次写入都是一次 commit，历史和审计靠 git。
 * - 内存里保留全量条目，搜索是线性扫描（规模是几千条，足够快，也不会出索引损坏）。
 * - 各设备的同步程序把工具自带的记忆（如 Claude Code 的 memory 目录）推上来；
 *   没有自带记忆的工具（如 Codex）通过 MCP 的 memory_remember 主动写。
 * - 写入前拦截密钥、令牌、口令；被拒的记录进 state/rejections.jsonl，进日报。
 *
 * 用法：
 *   node server.mjs                      启动服务（读 AGENT_MEMORY_CONFIG，默认 /srv/agent-memory/config.json）
 *   node server.mjs add-device <名字> [device|reporter]   生成设备令牌（只打印一次）
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createCards, CARD_TOOLS } from './cards.mjs';
import { createPipeline } from './pipeline.mjs';
import { createConvLog } from './convlog.mjs';
import { createVault } from './vault.mjs';
import { createExtras } from './extras.mjs';
import { createAdmin } from './admin.mjs';
import { createShare } from './share.mjs';
import { sendBody, createStatic } from './perf.mjs';

const run = promisify(execFile);
const VERSION = '0.9.3';
const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.AGENT_MEMORY_CONFIG || '/srv/agent-memory/config.json';
const CFG = Object.assign(
  {
    listen: '0.0.0.0',
    port: 8790,
    repo: '/srv/agent-memory/repo',
    state: '/srv/agent-memory/state',
    tokens: '/srv/agent-memory/tokens.json',
    cards_dir: '/srv/agent-memory/cards',
    public_url: 'http://localhost:8790',
    digest_budget: 13800,
    archive_dir: '/srv/agent-memory/archive',
  },
  readJSON(CONFIG_PATH, {}),
);
const cards = createCards(CFG.cards_dir);

const TYPES = ['preference', 'feedback', 'decision', 'status', 'pitfall', 'fact', 'reference'];
const TYPE_LABEL = {
  preference: '偏好', feedback: '反馈', decision: '决定', status: '现状',
  pitfall: '坑', fact: '事实', reference: '参考',
};
const STATE_LABEL = { active: '有效', superseded: '已被取代', retired: '已作废' };
// Claude Code 原生 memory 的 metadata.type → 共享记忆类型
const NATIVE_TYPE = { user: 'preference', feedback: 'feedback', project: 'status', reference: 'reference' };
const LIMITS = { title: 200, body: 8000, nativeBody: 120000, subject: 120, project: 60, tags: 10 };
const STALE_DAYS = 14;

class UserError extends Error {}

// ------------------------------------------------------------- utilities ----

function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
const nowIso = () => new Date().toISOString();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const day = (iso) => (iso || '').slice(0, 10);
const ageDays = (iso) => (Date.now() - Date.parse(iso || 0)) / 86400e3;

function fmtLocal(iso) {
  // 统一按北京时间显示
  const d = new Date(Date.parse(iso) + 8 * 3600e3);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function newId() {
  const d = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
  return `m-${d}-${crypto.randomBytes(3).toString('hex')}`;
}

function optStr(v, max, field) {
  if (v === undefined || v === null) return '';
  const s = String(v).trim();
  if (s.length > max) throw new UserError(`${field} 太长（最多 ${max} 字）`);
  return s;
}

function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

// usage.jsonl 只追加：近 8 天的行缓存在内存里，每次只读新追加的那一段。
// 设备页、拓扑页、总览、周报都要扫它，原来每次整文件解析（几十 MB 时要几百毫秒）。
// 每行解析成对象，另带不可枚举的 ms（时间戳毫秒）和 at（这一行在文件里的字节位置，稳定，可当事件 id）。
const USAGE_KEEP = 8 * 86400e3;
const USAGE_TAIL = 32 << 20; // 第一次最多读文件尾部这么多
const UQ = { off: 0, rows: [], init: false, skip: false };
function usageTail() {
  const file = usageFile();
  let st;
  try { st = fs.statSync(file); } catch { UQ.rows = []; UQ.off = 0; UQ.init = false; return UQ.rows; }
  if (!UQ.init || st.size < UQ.off) { UQ.rows = []; UQ.off = Math.max(0, st.size - USAGE_TAIL); UQ.skip = UQ.off > 0; UQ.init = true; }
  if (st.size > UQ.off) {
    const buf = Buffer.alloc(st.size - UQ.off);
    let fd;
    try { fd = fs.openSync(file, 'r'); fs.readSync(fd, buf, 0, buf.length, UQ.off); } catch { return UQ.rows; } finally { if (fd !== undefined) fs.closeSync(fd); }
    const end = buf.lastIndexOf(10) + 1; // 只吃完整的行
    let pos = 0;
    if (UQ.skip) { const nl = buf.indexOf(10); if (nl < 0) return UQ.rows; pos = nl + 1; UQ.skip = false; }
    while (pos < end) {
      const nl = buf.indexOf(10, pos);
      try {
        const o = JSON.parse(buf.toString('utf8', pos, nl));
        const ms = Date.parse(o.t);
        if (typeof o.op === 'string' && Number.isFinite(ms)) { Object.defineProperties(o, { ms: { value: ms }, at: { value: UQ.off + pos } }); UQ.rows.push(o); } // 不可枚举：序列化和展开时不会带出去
      } catch { /* 跳过坏行 */ }
      pos = nl + 1;
    }
    UQ.off += end;
  }
  const cut = Date.now() - USAGE_KEEP;
  if (UQ.rows.length && UQ.rows[0].ms < cut - 3600e3) UQ.rows = UQ.rows.filter((r) => r.ms >= cut); // 攒够一小时再清一次，不用每次都过一遍
  return UQ.rows;
}

function readJsonl(file, sinceMs) {
  if (sinceMs && file === usageFile() && sinceMs >= Date.now() - USAGE_KEEP + 3600e3) return usageTail().filter((o) => o.ms >= sinceMs);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const o = JSON.parse(line);
      if (!sinceMs || Date.parse(o.t) >= sinceMs) out.push(o);
    } catch { /* 跳过坏行 */ }
  }
  return out;
}

// --------------------------------------------------------- secret guard ----

const SECRET_RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '私钥'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS Access Key'],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/, 'API Key（sk-…）'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub 令牌'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, 'Slack 令牌'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'JWT'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}/i, 'Bearer 令牌'],
  [/(密码|口令|passwd|password|pwd|secret|token|api[_-]?key|app[_-]?secret|access[_-]?key)\s*[:：=]\s*[`'"]?[A-Za-z0-9!@#$%^&*._+\-/=]{6,}/i, '口令或密钥赋值'],
];

const REDACT_RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[私钥已打码]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[令牌已打码]'],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, '[令牌已打码]'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, '[令牌已打码]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[令牌已打码]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[令牌已打码]'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/-]{20,}/gi, '$1 [已打码]'],
  [/((?:密码|口令|passwd|password|pwd|secret|token|api[_-]?key|app[_-]?secret|access[_-]?key)\s*[:：=]\s*[`'"]?)[A-Za-z0-9!@#$%^&*._+\-/=]{6,}/gi, '$1[已打码]'],
];

function redactSecrets(text) {
  let s = String(text);
  for (const [re, rep] of REDACT_RULES) s = s.replace(re, rep);
  return s.replace(/[A-Za-z0-9+/=_]{40,}/g, (m) => (/[a-z]/.test(m) && /[A-Z]/.test(m) && /[0-9]/.test(m) ? '[疑似密钥已打码]' : m));
}

function findSecret(text) {
  for (const [re, label] of SECRET_RULES) if (re.test(text)) return label;
  // 40 位以上、大小写字母和数字混合的串，多半是密钥（纯小写 hex 的提交号、哈希不算）
  for (const m of text.matchAll(/[A-Za-z0-9+/=_]{40,}/g)) {
    const s = m[0];
    if (/[a-z]/.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s)) return '疑似高熵密钥串';
  }
  return null;
}

// ------------------------------------------------------- entry storage ----

const FIELD_ORDER = [
  'id', 'type', 'title', 'subject', 'project', 'tags', 'state', 'origin', 'author', 'client',
  'native_key', 'content_hash', 'created', 'updated', 'updated_by', 'supersedes', 'superseded_by',
  'retired_reason',
];

function serializeEntry(meta, body) {
  const lines = ['---'];
  for (const k of FIELD_ORDER) {
    const v = meta[k];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
    lines.push(`${k}: ${JSON.stringify(v)}`); // JSON 是 YAML 子集，Obsidian 能读
  }
  lines.push('---', '', String(body || '').trim(), '');
  return lines.join('\n');
}

function parseEntry(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 1) continue;
    const k = line.slice(0, i).trim();
    const raw = line.slice(i + 1).trim();
    try { meta[k] = JSON.parse(raw); } catch { meta[k] = raw; }
  }
  if (!Array.isArray(meta.tags)) meta.tags = meta.tags ? [String(meta.tags)] : [];
  return { meta, body: m[2].trim() };
}

// 解析 Claude Code memory 文件的 frontmatter（name/description/metadata.type，兼容旧的顶层 type）
function parseNativeMemory(text) {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { fm: {}, body: text.replace(/^\uFEFF/, '').trim() };
  const fm = {};
  let parent = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const mm = /^(\s*)([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!mm) continue;
    const [, indent, k, v] = mm;
    const val = unquote(v);
    if (indent && parent) fm[`${parent}.${k}`] = val;
    else if (v.trim() === '') { parent = k; }
    else { fm[k] = val; parent = null; }
  }
  return { fm, body: m[2].trim() };
}

function unquote(v) {
  v = v.trim();
  if (v.startsWith('"') && v.endsWith('"')) { try { return JSON.parse(v); } catch { /* fallthrough */ } }
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

const store = new Map(); // id -> { meta, body }
const entriesDir = () => path.join(CFG.repo, 'entries');
const entryFile = (id) => path.join(entriesDir(), `${id}.md`);

async function git(...args) {
  return run('git', ['-C', CFG.repo, ...args], { maxBuffer: 32 << 20 });
}

async function ensureRepo() {
  await fsp.mkdir(entriesDir(), { recursive: true });
  await fsp.mkdir(CFG.state, { recursive: true });
  if (!fs.existsSync(path.join(CFG.repo, '.git'))) {
    await run('git', ['init', '-q', '-b', 'main', CFG.repo]);
    await git('config', 'user.name', 'agent-memory');
    await git('config', 'user.email', 'hub@agent-memory');
    await fsp.writeFile(
      path.join(CFG.repo, 'README.md'),
      '# agent-memory\n\n跨机器、跨智能体的共享记忆，一条一个文件，见 `entries/`。\n由 hub 服务写入，请勿手改；要改请通过 MCP 工具或命令行。\n',
    );
    await git('add', '-A');
    await git('commit', '-q', '-m', 'init');
  }
}

async function loadStore() {
  store.clear();
  for (const name of await fsp.readdir(entriesDir())) {
    if (!name.endsWith('.md')) continue;
    const parsed = parseEntry(await fsp.readFile(path.join(entriesDir(), name), 'utf8'));
    if (parsed?.meta?.id) store.set(parsed.meta.id, parsed);
  }
}

async function writeEntry(entry) {
  const file = entryFile(entry.meta.id);
  const tmp = `${file}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, serializeEntry(entry.meta, entry.body));
  await fsp.rename(tmp, file);
  store.set(entry.meta.id, entry);
}

async function commit(message, author, paths = ['entries']) {
  await git('add', '-A', '--', ...paths);
  const st = await git('status', '--porcelain', '--', ...paths);
  if (!st.stdout.trim()) return false;
  const email = author.replace(/[^A-Za-z0-9._-]+/g, '-');
  await git('commit', '-q', '-m', message, `--author=${author} <${email}@agent-memory>`);
  return true;
}

// 所有写操作串行执行，避免并发写同一文件和 git 冲突
let chain = Promise.resolve();
function serial(fn) {
  const p = chain.then(fn);
  chain = p.catch(() => {});
  return p;
}

// --------------------------------------------------------------- tokens ----

function loadTokens() {
  return readJSON(CFG.tokens, { devices: {} });
}

function authenticate(req, url) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token) return null;
  const hash = sha256(token);
  const { devices } = loadTokens();
  for (const [device, info] of Object.entries(devices || {})) {
    if (info.sha256 && crypto.timingSafeEqual(Buffer.from(info.sha256), Buffer.from(hash))) {
      const client = String(url.searchParams.get('client') || req.headers['x-agent-client'] || 'unknown')
        .replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40) || 'unknown';
      const peer = gatePeer(req);
      if (peer && (info.role || 'device') === 'device') bindPeer(device, peer);
      return { device, role: info.role || 'device', client };
    }
  }
  return null;
}

// ------------------------------------------- identity from the gateway ----
// 网关（gateway/am-gate.py）认出调用方后加 X-AM-Peer 等头，并带暗号 X-AM-Gate；暗号不对的一律不信

function gatePeer(req) {
  const secret = CFG.gate_secret;
  const got = String(req.headers['x-am-gate'] || '');
  if (!secret || got.length !== secret.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(secret))) return null;
  const name = String(req.headers['x-am-peer'] || '').toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  if (!name) return null;
  const alt = String(req.headers['x-am-peer-alt'] || '').toLowerCase();
  const key = `${req.headers['x-am-peer-kind'] === 'vm' ? 'vm' : 'tailnet'}:${name}`;
  // 同一台机器的另一个身份（装了 Tailscale 的虚拟机：vm:名 和 tailnet:名）
  const keys = [key, ...(/^(vm|tailnet):[a-z0-9.-]{1,40}$/.test(alt) ? [alt] : [])];
  return { key, keys, name, os: String(req.headers['x-am-peer-os'] || '').slice(0, 20) };
}

const peersFile = () => path.join(CFG.state, 'peers.json');

// 记下"哪个设备在哪台机器上"，重装时据此沿用原设备名
function bindPeer(device, peer) {
  const all = readJSON(peersFile(), {});
  const cur = all[device];
  if (cur?.peer === peer.key && (peer.keys || []).every((k) => (cur.aliases || []).includes(k)) && Date.now() - Date.parse(cur.seen || 0) < 3600e3) return;
  // 同一台机器可能有时走 Tailscale、有时走虚拟机内网，几个身份都记下（最多 5 个）
  const aliases = [...new Set([...(peer.keys || [peer.key]), cur?.peer, ...(cur?.aliases || [])].filter(Boolean))].slice(0, 6);
  all[device] = { peer: peer.key, aliases, os: peer.os || cur?.os || '', seen: nowIso(), first: cur?.first || nowIso() };
  fs.mkdirSync(CFG.state, { recursive: true });
  fs.writeFileSync(peersFile(), JSON.stringify(all, null, 1));
}

// 浏览页的访问者：网关认出的身份必须绑定在一个已登记的设备上，且不在拒绝名单里
function browseViewer(req) {
  const peer = gatePeer(req);
  // 配置了 console_viewer（设备名）时，没有网关身份的浏览器按这台设备算：只用于可信内网和本地开发
  if (!peer) return CFG.console_viewer && loadTokens().devices?.[CFG.console_viewer] ? CFG.console_viewer : null;
  if ((CFG.auto_register_deny || []).some((re) => new RegExp(re, 'i').test(peer.name))) return null;
  const peers = readJSON(peersFile(), {});
  const { devices = {} } = loadTokens();
  return Object.keys(peers).find((d) => (devices[d]?.role || 'device') === 'device' && devices[d]
    && (peer.keys || [peer.key]).some((k) => peers[d].peer === k || (peers[d].aliases || []).includes(k))) || null;
}

function browseData(scope) {
  const entries = [...store.values()].filter((e) => scope.entry(e)).sort(byUpdated).map((e) => ({
    id: e.meta.id, type: e.meta.type, title: e.meta.title, subject: e.meta.subject || '', project: e.meta.project || '',
    tags: e.meta.tags || [], author: e.meta.author, client: e.meta.client, origin: e.meta.origin, state: e.meta.state,
    updated: e.meta.updated, snippet: String(e.body || '').slice(0, 400),
  }));
  return { entries };
}

// 自动登记：只认网关认出来的机器；客户现场等在拒绝名单里的不登记
function autoRegister(req) {
  const peer = gatePeer(req);
  if (!peer) throw new UserError('认不出这台机器：要经过认证网关（Tailscale 网络或宿主机的虚拟机）访问。不在 Tailscale 里的机器请用加入码。');
  const deny = (CFG.auto_register_deny || []).find((re) => new RegExp(re, 'i').test(peer.name));
  if (deny) {
    appendJsonl(path.join(CFG.state, 'auto-register.jsonl'), { t: nowIso(), peer: peer.key, result: 'denied', rule: deny });
    throw new UserError(`这台机器（${peer.name}）在不自动接入的名单里（客户现场等），没有登记。`);
  }
  const peers = readJSON(peersFile(), {});
  const { devices = {} } = loadTokens();
  let device = Object.keys(peers).find((d) => devices[d] && (peer.keys || [peer.key]).some((k) => peers[d].peer === k || (peers[d].aliases || []).includes(k)));
  if (!device) {
    device = peer.name;
    for (let i = 2; devices[device] && peers[device]?.peer !== peer.key; i++) device = `${peer.name}-${i}`;
  }
  const token = addDeviceToken(device, 'device', 'gateway');
  bindPeer(device, { ...peer, os: peer.os });
  appendJsonl(path.join(CFG.state, 'auto-register.jsonl'), { t: nowIso(), peer: peer.key, device, result: 'ok' });
  console.log(`auto-register: ${peer.key} -> ${device}`);
  return { device, token };
}

// ------------------------------------------------------------ operations ----

const usageFile = () => path.join(CFG.state, 'usage.jsonl');
const rejectFile = () => path.join(CFG.state, 'rejections.jsonl');
const heartbeatFile = () => path.join(CFG.state, 'heartbeats.json');

// extra 是可选的新字段，缺省就不写，旧行和旧读取方都不受影响：
//   hits 搜索命中条数（0 = 搜了但没搜到）、ids 命中/读到的记忆 id（最多 12 个）、p 限定的项目、dur 耗时毫秒、err 出错标记（1）。
// 耗时叫 dur 而不叫 ms：usageTail() 给每一行挂了不可枚举的 ms（时间戳毫秒），同名会被它盖掉。
// 第一次写带 dur 的行时，把"从哪一刻起有这些字段"落到 state/usage-meta.json（冷记忆要写明起算日期，不能冒充成从没用过）。
const usageMetaFile = () => path.join(CFG.state, 'usage-meta.json');
let usageMetaChecked = false;
function noteUsageMeta(since) {
  if (usageMetaChecked) return;
  usageMetaChecked = true;
  try {
    fs.mkdirSync(CFG.state, { recursive: true });
    fs.writeFileSync(usageMetaFile(), `${JSON.stringify({ since, fields: ['hits', 'ids', 'p', 'dur', 'err'] })}\n`, { flag: 'wx' });
  } catch { /* 已经有了；写不了也不影响记调用 */ }
}
function logUsage(who, op, detail, extra) {
  const row = { t: nowIso(), device: who.device, client: who.client, op, ...(detail ? { d: String(detail).replace(/\s+/g, ' ').slice(0, 120) } : {}) };
  const x = extra || {};
  if (Number.isInteger(x.hits) && x.hits >= 0) row.hits = x.hits;
  if (Array.isArray(x.ids) && x.ids.length) row.ids = x.ids.slice(0, 12).map(String);
  if (typeof x.p === 'string' && x.p.trim()) row.p = x.p.trim().slice(0, 60);
  if (Number.isFinite(x.dur)) { row.dur = Math.max(0, Math.round(x.dur)); noteUsageMeta(row.t); }
  if (x.err) row.err = 1;
  appendJsonl(usageFile(), row);
}

// 权限：tokens.json 里每台机器可以设 readonly（不能写记忆）、hide_projects（这些项目的记忆和日志对它不可见）
function devicePolicy(device) {
  const d = loadTokens().devices?.[device] || {};
  return { readonly: Boolean(d.readonly), hide: (d.hide_projects || []).map((x) => String(x).toLowerCase()) };
}
const hiddenFor = (who) => devicePolicy(who.device).hide;
const visible = (who, project) => { const h = hiddenFor(who); return !h.length || !h.includes(String(project || '').toLowerCase()); };

// 浏览者的可见范围：控制台（/console/api/*）、/browse/*、分享链接和各扩展接口过滤隐藏项目，都从这一个函数取口径。
// 口径同 MCP 工具里的 visible()：项目名按小写比，没有项目的内容可见；visibleTo(viewer, project) 就是它的 project()。
//   on        这台设备设了 hide_projects（没设时所有过滤都是空操作，返回和以前一模一样）
//   hide      被隐藏的项目名（小写）；hideKey 是缓存用的稳定串
//   project(p)  项目名可见吗      entry(e)  记忆条目可见吗      session(key)  对话会话可见吗（归属口径见 convlog.mjs 的 hiddenKeys）
function scopeOf(viewer) {
  const hide = hiddenFor({ device: viewer });
  const set = new Set(hide);
  const scope = {
    viewer, on: set.size > 0, hide, hideKey: [...set].sort().join('\n'),
    project: (p) => !set.size || !set.has(String(p || '').toLowerCase()),
    entry: (e) => scope.project(e.meta.project),
    session: (key) => conv.keyOk(scope, key),
  };
  return scope;
}

// 非设备令牌（报表、抽取机、历史导入）不发心跳，也不记工具调用：这里单记"最近一次请求"，拓扑页靠它判断它们在不在用。
// 内存里每次都更新；落盘（state/last-request.json）首次立即写，之后同一令牌最多 60 秒一次，退出时再补写一次。
const lastReqFile = () => path.join(CFG.state, 'last-request.json');
const lastReq = new Map();
const lastReqFlushed = {};
let lastReqDirty = false;
function flushLastReq() {
  lastReqDirty = false;
  const tmp = `${lastReqFile()}.tmp`;
  try {
    fs.mkdirSync(CFG.state, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(lastReq)));
    fs.renameSync(tmp, lastReqFile());
    for (const k of lastReq.keys()) lastReqFlushed[k] = Date.now();
  } catch (e) { console.error('last-request 落盘失败：', e.message); }
}
function noteRequest(who, p) {
  if (who.role === 'device') return;
  lastReq.set(who.device, { t: nowIso(), op: p });
  if (Date.now() - (lastReqFlushed[who.device] || 0) >= 60e3) flushLastReq(); else lastReqDirty = true;
}

function logReject(who, where, reason) {
  appendJsonl(rejectFile(), { t: nowIso(), device: who.device, client: who.client, where, reason });
}

function normTags(v) {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : String(v).split(/[,，\s]+/);
  const tags = arr.map((t) => String(t).trim()).filter(Boolean).slice(0, LIMITS.tags);
  return [...new Set(tags)];
}

async function remember(args, who) {
  const type = String(args.type || '').trim();
  if (!TYPES.includes(type)) throw new UserError(`type 必须是 ${TYPES.join(' / ')} 之一`);
  const title = optStr(args.title, LIMITS.title, 'title');
  if (!title) throw new UserError('title 不能为空（一行说清这条记忆是什么）');
  const body = optStr(args.body, LIMITS.body, 'body') || title;
  const subject = optStr(args.subject, LIMITS.subject, 'subject');
  const project = optStr(args.project, LIMITS.project, 'project');
  const tags = normTags(args.tags);
  if (type === 'status' && !subject) {
    throw new UserError('type=status 必须填 subject（主题键，如 myapp/prod-version）；同一 subject 的新现状会自动替代旧的');
  }
  const secret = findSecret([title, body, subject, project, ...tags].join('\n'));
  if (secret) {
    logReject(who, `remember:${title.slice(0, 60)}`, secret);
    throw new UserError(`拒收：内容里有${secret}。共享记忆不存密钥、令牌、口令和客户现场账号密码，去掉后再写。`);
  }
  return serial(async () => {
    const id = newId();
    const ts = nowIso();
    const toSupersede = new Set();
    if (args.supersedes) {
      for (const oid of normTags(args.supersedes)) {
        if (!store.has(oid)) throw new UserError(`supersedes 指向的条目 ${oid} 不存在`);
        toSupersede.add(oid);
      }
    }
    if (type === 'status') {
      for (const e of store.values()) {
        if (e.meta.state === 'active' && e.meta.type === 'status' && e.meta.subject === subject) toSupersede.add(e.meta.id);
      }
    }
    const superseded = [];
    for (const oid of toSupersede) {
      const e = store.get(oid);
      if (e.meta.state !== 'active') continue;
      e.meta.state = 'superseded';
      e.meta.superseded_by = id;
      e.meta.updated = ts;
      e.meta.updated_by = `${who.device}/${who.client}`;
      await writeEntry(e);
      superseded.push(oid);
    }
    const entry = {
      meta: {
        id, type, title, subject, project, tags, state: 'active', origin: 'explicit',
        author: who.device, client: who.client, created: ts, updated: ts,
        supersedes: superseded.length ? superseded : undefined,
      },
      body,
    };
    await writeEntry(entry);
    await commit(`remember(${type}): ${title}`, `${who.device}/${who.client}`);
    return { entry, superseded };
  });
}

async function updateEntry(args, who) {
  const e = store.get(String(args.id || ''));
  if (!e) throw new UserError('条目不存在');
  if (e.meta.origin === 'native') {
    throw new UserError('这条来自某个工具的原生记忆文件，会被下次同步覆盖，不能在这里改；要更正请用 memory_remember 写新条目并填 supersedes。');
  }
  const patch = {};
  if (args.title !== undefined) patch.title = optStr(args.title, LIMITS.title, 'title');
  if (args.body !== undefined) patch.body = optStr(args.body, LIMITS.body, 'body');
  if (args.subject !== undefined) patch.subject = optStr(args.subject, LIMITS.subject, 'subject');
  if (args.project !== undefined) patch.project = optStr(args.project, LIMITS.project, 'project');
  if (args.tags !== undefined) patch.tags = normTags(args.tags);
  const secret = findSecret(Object.values(patch).flat().join('\n'));
  if (secret) {
    logReject(who, `update:${e.meta.id}`, secret);
    throw new UserError(`拒收：内容里有${secret}。`);
  }
  return serial(async () => {
    const { body, ...metaPatch } = patch;
    Object.assign(e.meta, metaPatch, { updated: nowIso(), updated_by: `${who.device}/${who.client}` });
    if (body !== undefined) e.body = body || e.meta.title;
    await writeEntry(e);
    await commit(`update: ${e.meta.title}`, `${who.device}/${who.client}`);
    return e;
  });
}

async function retireEntry(args, who) {
  const e = store.get(String(args.id || ''));
  if (!e) throw new UserError('条目不存在');
  if (e.meta.origin === 'native') {
    throw new UserError('这条来自某个工具的原生记忆文件；删掉那个文件后会自动作废。');
  }
  const reason = optStr(args.reason, 200, 'reason');
  if (!reason) throw new UserError('作废要写原因');
  return serial(async () => {
    Object.assign(e.meta, { state: 'retired', retired_reason: reason, updated: nowIso(), updated_by: `${who.device}/${who.client}` });
    await writeEntry(e);
    await commit(`retire: ${e.meta.title}`, `${who.device}/${who.client}`);
    return e;
  });
}

async function nativeSync(payload, who) {
  const tool = String(payload.tool || '').replace(/[^A-Za-z0-9._-]/g, '');
  if (!tool) throw new UserError('缺少 tool');
  const files = Array.isArray(payload.files) ? payload.files : [];
  const prefix = `${who.device}:${tool}:`;
  return serial(async () => {
    const res = { added: 0, updated: 0, unchanged: 0, retired: 0, rejected: [] };
    for (const f of files) {
      const key = String(f.key || '');
      if (!key || key.length > 300 || key.includes('..')) { res.rejected.push({ key, reason: '非法路径' }); continue; }
      const content = String(f.content ?? '');
      const nk = prefix + key;
      const id = 'n-' + sha256(nk).slice(0, 14);
      const hash = sha256(content).slice(0, 16);
      const existing = store.get(id);
      if (existing && existing.meta.content_hash === hash && existing.meta.state !== 'retired') { res.unchanged++; continue; }
      if (content.length > LIMITS.nativeBody) { res.rejected.push({ key, reason: '文件过大' }); continue; }
      // 原生记忆文件里有疑似密钥：就地打码后保存（整份拒收会丢掉其中有用的知识），打码后还查得出来才拒收
      let stored = content;
      const secret = findSecret(content);
      if (secret) {
        stored = redactSecrets(content);
        const still = findSecret(stored);
        if (still) {
          res.rejected.push({ key, reason: still });
          logReject(who, `native:${tool}:${key}`, still);
          continue;
        }
        res.redacted = (res.redacted || 0) + 1;
        appendJsonl(path.join(CFG.state, 'redactions.jsonl'), { t: nowIso(), device: who.device, client: tool, where: key, reason: secret });
      }
      const { fm, body } = parseNativeMemory(stored);
      const ntype = String(fm['metadata.type'] || fm.type || '').trim();
      const hint = TYPES.includes(f.type_hint) ? f.type_hint : 'fact';
      const type = NATIVE_TYPE[ntype] || (TYPES.includes(ntype) ? ntype : hint);
      const name = String(fm.name || f.subject_hint || path.basename(key, '.md'));
      // 没有 frontmatter 的原生记忆（如 Hermes 的 USER.md 分段）用第一行当标题
      const firstLine = (body.split('\n').find((l) => l.trim()) || '').replace(/^#+\s*/, '').trim();
      const autoTitle = firstLine.length > 120 ? `${firstLine.slice(0, 118)}…` : firstLine;
      // 用文件自己的修改时间，"多久没更新"才有意义；不信任未来时间
      const mt = Date.parse(f.mtime);
      const ts = Number.isFinite(mt) && mt <= Date.now() + 60e3 ? new Date(mt).toISOString() : nowIso();
      await writeEntry({
        meta: {
          id, type,
          title: String(fm.description || (fm.name ? name : autoTitle) || name).slice(0, LIMITS.title),
          subject: name.slice(0, LIMITS.subject),
          tags: [], state: 'active', origin: 'native', author: who.device, client: tool,
          native_key: nk, content_hash: hash,
          created: existing?.meta.created || ts, updated: ts,
        },
        body: body || String(fm.description || name),
      });
      if (existing) res.updated++; else res.added++;
    }
    if (Array.isArray(payload.present)) {
      const keep = new Set(payload.present.map((k) => prefix + String(k)));
      const owned = [...store.values()].filter((e) => e.meta.origin === 'native' && e.meta.native_key?.startsWith(prefix) && e.meta.state === 'active');
      const gone = owned.filter((e) => !keep.has(e.meta.native_key));
      // 防整批作废：来源一下子没了或少了一大半，多半是换机器、目录没挂上、程序配置错，不是真删了。
      // 先不作废，记一笔进巡检告警；确认是真删了，设备上用 AM_FORCE_RETIRE=1 再同步一次
      const suspicious = gone.length >= 3 && (payload.present.length === 0 || gone.length > owned.length / 2);
      if (suspicious && !payload.force_retire) {
        res.retire_blocked = gone.length;
        appendJsonl(path.join(CFG.state, 'guard.jsonl'), { t: nowIso(), device: who.device, client: tool, would_retire: gone.length, owned: owned.length, present: payload.present.length });
        console.log(`guard: blocked retiring ${gone.length}/${owned.length} native entries of ${who.device}/${tool}`);
      } else {
        for (const e of gone) {
          Object.assign(e.meta, { state: 'retired', retired_reason: '原生记忆文件已删除', updated: nowIso() });
          await writeEntry(e);
          res.retired++;
        }
      }
    }
    if (res.added || res.updated || res.retired) {
      await commit(`native sync ${who.device}/${tool}: +${res.added} ~${res.updated} -${res.retired}`, `${who.device}/${tool}`);
    }
    for (const r of res.rejected) console.log(`native reject ${who.device}/${tool} ${r.reason} key=${r.key.slice(0, 200)} keylen=${r.key.length}`);
    return res;
  });
}

// 批量导入（如把知识卡片拆成的条目导进来）。同一 source + key 重复导入会更新而不是重复；
// replace=true 时，这次没出现的旧条目作废。
async function importEntries(payload, who) {
  const source = optStr(payload.source, 120, 'source');
  if (!source) throw new UserError('缺少 source（如 kb-card:项目-MyApp.md）');
  const list = Array.isArray(payload.entries) ? payload.entries : [];
  if (list.length > 500) throw new UserError('一次最多导入 500 条');
  return serial(async () => {
    const res = { added: 0, updated: 0, unchanged: 0, retired: 0, rejected: [] };
    const seen = new Set();
    for (const raw of list) {
      const key = String(raw.key || '').trim();
      try {
        if (!/^[A-Za-z0-9._/-]{1,80}$/.test(key)) throw new UserError('key 只能用字母数字 . _ / -，最多 80 字');
        if (seen.has(key)) throw new UserError('key 重复');
        seen.add(key);
        const type = String(raw.type || '').trim();
        if (!TYPES.includes(type)) throw new UserError(`type 不对：${type}`);
        const title = optStr(raw.title, LIMITS.title, 'title');
        if (!title) throw new UserError('title 为空');
        const body = optStr(raw.body, LIMITS.body, 'body') || title;
        const subject = optStr(raw.subject, LIMITS.subject, 'subject');
        if (type === 'status' && !subject) throw new UserError('status 缺 subject');
        const project = optStr(raw.project ?? payload.project, LIMITS.project, 'project');
        const tags = normTags(raw.tags);
        const refs = Array.isArray(raw.sources) ? raw.sources.map(String).slice(0, 10) : [];
        const fullBody = `${body}\n\n来源：${source}${refs.length ? '\n' + refs.map((s) => `- ${s}`).join('\n') : ''}`;
        const secret = findSecret([title, fullBody, subject, ...tags].join('\n'));
        if (secret) {
          logReject(who, `import:${source}:${key}`, secret);
          throw new UserError(`疑似${secret}`);
        }
        const id = 'i-' + sha256(`${source}#${key}`).slice(0, 14);
        const hash = sha256(JSON.stringify([type, title, fullBody, subject, project, tags, raw.as_of])).slice(0, 16);
        const existing = store.get(id);
        if (existing && existing.meta.content_hash === hash && existing.meta.state === 'active') { res.unchanged++; continue; }
        // updated 用信息本身的日期（as_of），"多久没更新"才准
        const asOf = Date.parse(raw.as_of);
        const ts = Number.isFinite(asOf) && asOf <= Date.now() + 60e3 ? new Date(asOf).toISOString() : nowIso();
        await writeEntry({
          meta: {
            id, type, title, subject, project, tags, state: 'active', origin: 'import',
            author: who.device, client: who.client, native_key: `${source}#${key}`, content_hash: hash,
            created: existing?.meta.created || nowIso(), updated: ts,
          },
          body: fullBody,
        });
        if (existing) res.updated++; else res.added++;
      } catch (e) {
        if (!(e instanceof UserError)) throw e;
        res.rejected.push({ key, reason: e.message });
      }
    }
    if (payload.replace) {
      for (const e of store.values()) {
        if (e.meta.origin === 'import' && e.meta.state === 'active' && e.meta.native_key?.startsWith(`${source}#`)
          && !seen.has(e.meta.native_key.slice(source.length + 1))) {
          Object.assign(e.meta, { state: 'retired', retired_reason: '重新导入时已不在来源里', updated: nowIso() });
          await writeEntry(e);
          res.retired++;
        }
      }
    }
    if (res.added || res.updated || res.retired) {
      await commit(`import ${source}: +${res.added} ~${res.updated} -${res.retired}`, `${who.device}/${who.client}`);
    }
    return res;
  });
}

// ------------------------------------------------- one-time device install ----

const invitesFile = () => path.join(CFG.state, 'invites.json');

function createInvite(device) {
  const token = addDeviceToken(device, 'device');
  const code = crypto.randomBytes(12).toString('hex');
  const inv = readJSON(invitesFile(), {});
  for (const [k, v] of Object.entries(inv)) if (Date.parse(v.expires) < Date.now()) delete inv[k];
  inv[sha256(code)] = { device, token, expires: new Date(Date.now() + 24 * 3600e3).toISOString() };
  fs.mkdirSync(CFG.state, { recursive: true });
  fs.writeFileSync(invitesFile(), JSON.stringify(inv, null, 1), { mode: 0o600 });
  return code;
}

function consumeInvite(code) {
  const inv = readJSON(invitesFile(), {});
  const k = sha256(String(code));
  const it = inv[k];
  if (!it) return null;
  delete inv[k];
  fs.writeFileSync(invitesFile(), JSON.stringify(inv, null, 1), { mode: 0o600 });
  return Date.parse(it.expires) >= Date.now() ? it : null;
}

function renderInstall(it) {
  const tmpl = fs.readFileSync(path.join(APP_DIR, 'install.sh.tmpl'), 'utf8');
  const agent = fs.readFileSync(path.join(APP_DIR, 'kb-agent.mjs'), 'utf8');
  return tmpl
    .split('__HUB__').join(CFG.public_url)
    .split('__DEVICE__').join(it.device)
    .split('__TOKEN__').join(it.token)
    .split('__AGENT_SOURCE__').join(agent.trimEnd());
}

// ------------------------------------------------------ reusable join code ----
// 一个加入码在有效期内可以给任意多台机器用；每台机器登记时按主机名起设备名、各发各的令牌。
// 期限只管这个码还能不能用来登记新机器，已经加入的设备不受影响。days 为 0 是长期有效（expires 为 null），要收回就作废。

const joinFile = () => path.join(CFG.state, 'join.json');
const joinAlive = (it) => Boolean(it) && (!it.expires || Date.parse(it.expires) >= Date.now());
const joinExpiry = (days) => (days > 0 ? new Date(Date.now() + days * 86400e3).toISOString() : null);

function saveJoinCodes(all) {
  fs.mkdirSync(CFG.state, { recursive: true });
  fs.writeFileSync(joinFile(), JSON.stringify(all, null, 1), { mode: 0o600 });
}

function createJoinCode(days = 7) {
  const code = crypto.randomBytes(12).toString('hex');
  const all = readJSON(joinFile(), {});
  for (const [k, v] of Object.entries(all)) if (!joinAlive(v)) delete all[k];
  all[sha256(code)] = { created: nowIso(), expires: joinExpiry(days), uses: 0 };
  saveJoinCodes(all);
  return code;
}

function joinCodeOk(code) {
  return joinAlive(readJSON(joinFile(), {})[sha256(String(code))]);
}

// 还在生效的加入码。库里只存了码的哈希，所以这里给不出码本身，id 是哈希的前 12 位
function listJoinCodes() {
  return Object.entries(readJSON(joinFile(), {})).filter(([, v]) => joinAlive(v))
    .map(([k, v]) => ({ id: k.slice(0, 12), created: v.created, expires: v.expires || null, uses: v.uses || 0 }))
    .sort((a, b) => (a.created < b.created ? 1 : -1));
}

function revokeJoinCode(id) {
  const all = readJSON(joinFile(), {});
  const key = Object.keys(all).find((k) => k.slice(0, 12) === id && joinAlive(all[k]));
  if (!key) return false;
  delete all[key];
  saveJoinCodes(all);
  return true;
}

function registerJoin(code, name) {
  const all = readJSON(joinFile(), {});
  const it = all[sha256(String(code))];
  if (!joinAlive(it)) throw new UserError('加入码无效或已过期');
  if (it.uses >= 200) throw new UserError('这个加入码登记的机器太多了，换一个新的');
  const base = String(name || 'device').toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'device';
  const { devices = {} } = loadTokens();
  let device = base;
  for (let i = 2; devices[device]; i++) device = `${base}-${i}`;
  const token = addDeviceToken(device, 'device', 'join');
  it.uses++;
  fs.writeFileSync(joinFile(), JSON.stringify(all, null, 1), { mode: 0o600 });
  console.log(`join: registered device ${device}`);
  return { device, token };
}

// 设备用哪个地址下载脚本，就把哪个地址写进它的配置（同一个加入码，Tailscale 地址和宿主机内网地址都能用）
function baseUrlOf(req) {
  const host = String(req?.headers?.host || '');
  return /^[A-Za-z0-9.-]+(:[0-9]{1,5})?$/.test(host) ? `http://${host}` : CFG.public_url;
}

function renderJoin(kind, code, base = CFG.public_url) {
  const tmpl = fs.readFileSync(path.join(APP_DIR, kind === 'ps1' ? 'join.ps1.tmpl' : 'join.sh.tmpl'), 'utf8');
  const agent = fs.readFileSync(path.join(APP_DIR, 'kb-agent.mjs'), 'utf8');
  return tmpl
    .split('__HUB__').join(base)
    .split('__JOIN__').join(code ? `${base}/join/${code}` : `${base}/auto`)
    .split('__AGENT_SOURCE__').join(agent.trimEnd());
}

function joinCommands(code, base = CFG.public_url) {
  const u = `${base}/join/${code}`;
  return {
    sh: `curl -fsSL ${u}/sh | bash`,
    ps1: `irm ${u}/ps1 | iex`,
  };
}

// 生成加入码和安装命令（命令行 join-code 和控制台接口共用）
function newJoinCode(days = 7, base = CFG.public_url) {
  const code = createJoinCode(days);
  return { code, days, expires: joinExpiry(days), ...joinCommands(code, base), page: `${base}/join/${code}` };
}

// 改设备的巡检和权限参数（命令行 device-set 和控制台接口共用）。changes 里没出现的键不动；
// stale_hours 给数字、paused/readonly 给 true、hide_projects 给非空数组是设置，其余（null、false、空数组）是清除
function deviceSet(name, changes) {
  const tokens = loadTokens();
  const d = tokens.devices?.[name];
  if (!d) throw new UserError(`没有设备 ${name}`);
  for (const k of Object.keys(changes)) if (!['stale_hours', 'paused', 'readonly', 'hide_projects'].includes(k)) throw new UserError(`不认识的参数 ${k}`);
  for (const [k, v] of Object.entries(changes)) {
    if (k === 'hide_projects') { if (v?.length) d.hide_projects = v; else delete d.hide_projects; }
    else if (k === 'stale_hours') { if (v) d.stale_hours = v; else delete d.stale_hours; }
    else if (v === true) d[k] = true;
    else delete d[k];
  }
  const tmp = `${CFG.tokens}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(tokens, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, CFG.tokens);
  return { stale_hours: d.stale_hours || null, paused: Boolean(d.paused), readonly: Boolean(d.readonly), hide_projects: d.hide_projects || [] };
}

function heartbeat(payload, who) {
  const hb = readJSON(heartbeatFile(), {});
  hb[who.device] = {
    last_seen: nowIso(),
    agent_version: String(payload.agent_version || '').slice(0, 20),
    hostname: String(payload.hostname || '').slice(0, 60),
    sources: payload.sources && typeof payload.sources === 'object' ? payload.sources : {},
    // 每个智能体的接入状态（设备端 0.8.8 起报）：插件 on/off/none、说明/摘要块、记忆同步
    wiring: payload.wiring && typeof payload.wiring === 'object' ? payload.wiring : (hb[who.device]?.wiring || {}),
  };
  const tmp = heartbeatFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(hb, null, 1));
  fs.renameSync(tmp, heartbeatFile());
  return hb[who.device];
}

// ---------------------------------------------------------------- search ----

function search({ query, type, project, limit, include_inactive } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const max = Math.min(Math.max(parseInt(limit, 10) || 8, 1), 30);
  const pool = [...store.values()].filter((e) =>
    (include_inactive || e.meta.state === 'active')
    && (!type || e.meta.type === type)
    && (!project || (e.meta.project || '').toLowerCase().includes(String(project).toLowerCase())));
  if (!q) return { total: pool.length, items: pool.sort(byUpdated).slice(0, max).map((e) => ({ e, score: 0 })) };
  const terms = q.split(/\s+/).filter(Boolean);
  const scored = pool.map((e) => scoreEntry(e, terms));
  let hits = scored.filter((s) => s.matched === terms.length);
  if (!hits.length) hits = scored.filter((s) => s.matched > 0); // 退一步：任一关键词
  if (!hits.length && /[一-鿿]/.test(q)) {
    // 中文整句没空格时，按二字片段重合度兜底
    const grams = bigrams(q.replace(/\s+/g, ''));
    if (grams.length) {
      hits = pool.map((e) => {
        const hay = haystack(e);
        const n = grams.filter((g) => hay.includes(g)).length;
        return { e, score: n, matched: n / grams.length >= 0.5 ? 1 : 0 };
      }).filter((s) => s.matched);
    }
  }
  hits.sort((a, b) => b.matched - a.matched || b.score - a.score || byUpdated(a.e, b.e));
  return { total: pool.length, items: hits.slice(0, max), terms };
}

function haystack(e) {
  return [e.meta.title, e.meta.subject, e.meta.project, (e.meta.tags || []).join(' '), e.body].join('\n').toLowerCase();
}

function bigrams(s) {
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return [...out];
}

function scoreEntry(e, terms) {
  const f = {
    title: (e.meta.title || '').toLowerCase(),
    subject: (e.meta.subject || '').toLowerCase(),
    project: (e.meta.project || '').toLowerCase(),
    tags: (e.meta.tags || []).join(' ').toLowerCase(),
    body: (e.body || '').toLowerCase(),
  };
  let score = 0;
  let matched = 0;
  for (const t of terms) {
    let s = 0;
    if (f.title.includes(t)) s += 6;
    if (f.subject.includes(t)) s += 4;
    if (f.tags.includes(t)) s += 3;
    if (f.project.includes(t)) s += 2;
    if (f.body.includes(t)) s += Math.min(f.body.split(t).length - 1, 3);
    if (s) matched++;
    score += s;
  }
  if (e.meta.state !== 'active') score -= 3;
  return { e, score, matched };
}

function byUpdated(a, b) {
  return Date.parse(b.meta.updated || 0) - Date.parse(a.meta.updated || 0);
}

function snippet(e, terms) {
  const lines = (e.body || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const hit = terms?.length ? lines.find((l) => terms.some((t) => l.toLowerCase().includes(t))) : null;
  const s = hit || lines[0] || '';
  return s.length > 160 ? s.slice(0, 160) + '…' : s;
}

// ------------------------------------------------------------ rendering ----

function entryLine(e) {
  const m = e.meta;
  const state = m.state !== 'active' ? ` · ${STATE_LABEL[m.state] || m.state}` : '';
  return `[${TYPE_LABEL[m.type] || m.type}] ${m.title} · id=${m.id} · ${m.author}/${m.client} · ${day(m.updated)}${state}`;
}

function renderSearch(r, q) {
  if (!r.items.length) return `没找到和「${q}」相关的记忆（共 ${r.total} 条有效记忆）。可以换 1–2 个更短的关键词，或用 memory_recent 看最近写入的。`;
  const out = [`找到 ${r.items.length} 条（共 ${r.total} 条有效记忆）：`];
  r.items.forEach(({ e }, i) => {
    out.push(`${i + 1}. ${entryLine(e)}`);
    const extra = [e.meta.subject && `subject: ${e.meta.subject}`, e.meta.project && `project: ${e.meta.project}`].filter(Boolean).join(' · ');
    if (extra) out.push(`   ${extra}`);
    const sn = snippet(e, r.terms);
    if (sn && sn !== e.meta.title) out.push(`   ${sn}`);
  });
  out.push('用 memory_get 加 id 看全文。');
  return out.join('\n');
}

function renderEntry(e) {
  const m = e.meta;
  const head = [
    `# ${m.title}`,
    `id: ${m.id} | 类型: ${TYPE_LABEL[m.type] || m.type} | 状态: ${STATE_LABEL[m.state] || m.state} | 作者: ${m.author}/${m.client} | 更新: ${fmtLocal(m.updated)}`,
  ];
  const extra = [m.subject && `subject: ${m.subject}`, m.project && `project: ${m.project}`, m.tags?.length && `tags: ${m.tags.join(', ')}`].filter(Boolean);
  if (extra.length) head.push(extra.join(' | '));
  if (m.superseded_by) head.push(`已被 ${m.superseded_by} 取代`);
  if (m.supersedes?.length) head.push(`取代了 ${[].concat(m.supersedes).join(', ')}`);
  if (m.retired_reason) head.push(`作废原因：${m.retired_reason}`);
  if (m.origin === 'native') head.push(`来源：${m.client} 原生记忆（${m.native_key.split(':').slice(2).join(':')}）`);
  return `${head.join('\n')}\n---\n${e.body}`;
}

function digest(who, targetTool) {
  const tool = targetTool || who.client;
  const mine = (e) => e.meta.origin === 'native' && e.meta.author === who.device && e.meta.client === tool;
  const active = [...store.values()].filter((e) => e.meta.state === 'active' && !mine(e)).sort(byUpdated);
  const short = (s, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const proj = (e) => (e.meta.project ? `[${e.meta.project}] ` : '');
  // 每节有自己的额度，避免现状条目挤掉决定、坑和参考
  const sections = [
    {
      title: '偏好与反馈（一直有效，照做）',
      max: 3600,
      items: active.filter((e) => e.meta.type === 'preference' || e.meta.type === 'feedback'),
      line: (e) => `- ${short(e.meta.title, 110)}`,
    },
    {
      title: '项目现状（按更新时间，只列标题）',
      max: 5000,
      items: active.filter((e) => e.meta.type === 'status' && ageDays(e.meta.updated) <= 60),
      line: (e) => {
        const stale = ageDays(e.meta.updated) > STALE_DAYS ? ` ⚠${Math.floor(ageDays(e.meta.updated))}天未更新` : '';
        return `- ${proj(e)}${short(e.meta.title, 80)}（${day(e.meta.updated).slice(5)}）${stale}`;
      },
    },
    {
      title: `最近 ${STALE_DAYS} 天的决定与坑`,
      max: 2000,
      items: active.filter((e) => (e.meta.type === 'decision' || e.meta.type === 'pitfall') && ageDays(e.meta.updated) <= STALE_DAYS),
      line: (e) => `- [${TYPE_LABEL[e.meta.type]}] ${proj(e)}${short(e.meta.title, 70)}`,
    },
    {
      title: '参考与事实',
      max: 1200,
      items: active.filter((e) => e.meta.type === 'reference' || e.meta.type === 'fact'),
      line: (e) => `- ${proj(e)}${short(e.meta.title, 60)}`,
    },
  ];
  // 不放生成时间：内容不变时摘要逐字节不变，设备端就不会反复改写指令文件
  const latest = active.length ? fmtLocal(active[0].meta.updated) : '—';
  const head = [
    '# 共享记忆摘要',
    '',
    `> 来自所有机器和智能体，${active.length} 条有效记忆，最近一条更新于 ${latest}（北京时间）。`,
    '> 只有标题；细节用 MCP 工具 `memory_search` / `memory_get` 查。本机这个工具自己的原生记忆不重复列出。',
    '',
  ].join('\n');
  let out = head;
  let omitted = 0;
  // 最近 3 天在做什么（来自对话存档的工作日志），放在偏好后面
  const recent = conv ? conv.recentSection(1800) : '';
  for (const [i, s] of sections.entries()) {
    if (i === 1 && recent) out += `\n## 最近 3 天在做什么（各机器各智能体的会话日志；细节用 memory_timeline 查）\n${recent}`;
    let block = '';
    for (const e of s.items) {
      const line = s.line(e) + '\n';
      if (Buffer.byteLength(block + line) > s.max || Buffer.byteLength(out + block + line) > CFG.digest_budget) { omitted++; continue; }
      block += line;
    }
    if (block) out += `\n## ${s.title}\n${block}`;
  }
  if (omitted) out += `\n…还有 ${omitted} 条没列出，用 memory_search 查。\n`;
  if (!active.length) out += '\n（暂时还没有来自其他机器或工具的记忆。）\n';
  return out;
}

const RULES_COMMON = `## 共享记忆（agent-memory）

- 这是跨机器（台式机、笔记本、服务器…）、跨智能体（Claude Code、Codex、Hermes…）共享的记忆，下面的摘要每 10 分钟自动更新。
- **查**：涉及项目现状、以前的决定、踩过的坑、我的偏好时，先用 MCP 工具 \`memory_search\`（2–4 个关键词，空格分隔）查，再用 \`memory_get\` 看全文。记忆会滞后于现场；和实际文件、配置、日志冲突时以现场为准，并指出冲突。
- **问"哪天干了什么、某事哪天做的、上周某项目做了哪些"**：用 \`memory_timeline\`（按天列出所有机器、所有智能体的会话日志），要找原话用 \`conversation_search\`，读原文用 \`conversation_get\`。
- **换会话接着干、交接给别的智能体**：先用 \`memory_handoff\`（项目名）生成交接包；问"还有什么没做完"用 \`memory_todos\`；问某个项目/机器/客户现场/版本的来龙去脉用 \`memory_entities\`。`;

const RULES_WRITE = {
  'claude-code': '- **写**：照常按你自己的 memory 规则写本地记忆，它会自动同步到共享记忆。需要别的智能体马上看到的结论，也可以直接调 `memory_remember`。',
  workbuddy: '- **写**：照常写你自己的 MEMORY.md / memory 记忆，它会自动同步到共享记忆。项目现状、拍板的决定、踩过的坑这类别的机器也要知道的，直接调 `memory_remember`（项目现状用 type=status 并填 subject，如 `myapp/prod-version`）。你的对话本身也会自动存档，每天写成工作日志。',
  default: '- **写**：你没有会自动同步的本地记忆。得出值得跨机器记住的结论、决定、踩坑，或者我明确说"记住"时，调用 `memory_remember`。项目现状用 type=status 并填 subject（如 `myapp/prod-version`），新的会自动替代同一 subject 的旧现状；更正旧条目用 supersedes。',
};

const RULES_TAIL = '- **知识卡片**：按主题整理的长文档（项目、SOP、设备、个人背景）用同一个 MCP 的 `kb_search` / `kb_sections` / `kb_read` 查；卡片是只读的长文档，当前状态以记忆为准。\n- **不写**：进度流水、临时状态、只和本机有关的细节；任何密钥、令牌、口令、客户现场账号密码（服务端会拒收）。\n- MCP 不可用时用命令行（结果一样）：`node ~/.agent-memory/kb-agent.mjs search 关键词`、`… get <id>`、`… timeline --days 7`（或 `--date 11-20`、`--project myapp`）、`… convsearch 关键词`、`… conv <ref> --date 11-20`、`… remember --type decision --title "…" --body "…"`。';

// 机器人（OpenClaw 等）每条消息都带着指令文件，只给用法、不带摘要；WorkBuddy 每轮都读 USER.md，同样只给用法
const BOT_TOOLS = new Set(['openclaw', 'workbuddy']);

// 某些工具需要额外的一两句说明时写在这里（按工具名）
const RULES_EXTRA = {};

function rules(tool) {
  const common = BOT_TOOLS.has(tool) ? RULES_COMMON.replace('，下面的摘要每 10 分钟自动更新', '；要了解偏好、项目现状时用下面的工具查') : RULES_COMMON;
  return [common, RULES_EXTRA[tool], RULES_WRITE[tool] || RULES_WRITE.default, RULES_TAIL].filter(Boolean).join('\n');
}

function status() {
  const hb = readJSON(heartbeatFile(), {});
  const { devices } = loadTokens();
  const counts = {};
  for (const e of store.values()) counts[e.meta.state] = (counts[e.meta.state] || 0) + 1;
  return {
    version: VERSION,
    entries: counts,
    conversations: conv ? conv.stats() : null,
    devices: Object.entries(devices || {}).map(([name, info]) => ({
      name, role: info.role || 'device', last_seen: hb[name]?.last_seen || null, sources: hb[name]?.sources || {}, peer: readJSON(peersFile(), {})[name]?.peer || null,
    })),
  };
}

function report(hours = 24) {
  const since = Date.now() - hours * 3600e3;
  const all = [...store.values()];
  // 候选（还没审、或审批时不要的）不算"新增"，单独在会话抽取那几行里报
  const created = all.filter((e) => Date.parse(e.meta.created) >= since && e.meta.state !== 'proposed' && !(e.meta.origin === 'extract' && e.meta.state === 'retired'));
  const changed = all.filter((e) => Date.parse(e.meta.created) < since && Date.parse(e.meta.updated) >= since);
  const lines = [];
  const active = all.filter((e) => e.meta.state === 'active').length;
  lines.push(`【共享记忆日报】${fmtLocal(nowIso()).slice(5, 10)}`);
  lines.push(`· 有效记忆 ${active} 条；过去 ${hours} 小时新增 ${created.length} 条，改动 ${changed.length} 条`);
  const byWho = {};
  for (const e of created) byWho[`${e.meta.author}/${e.meta.client}`] = (byWho[`${e.meta.author}/${e.meta.client}`] || 0) + 1;
  if (Object.keys(byWho).length) lines.push(`  新增来自：${Object.entries(byWho).map(([k, v]) => `${k} ${v}`).join('，')}`);
  for (const e of created.sort(byUpdated).slice(0, 8)) lines.push(`  - [${TYPE_LABEL[e.meta.type]}] ${e.meta.title}`);
  if (created.length > 8) lines.push(`  …另有 ${created.length - 8} 条`);
  if (pipe) lines.push(...pipe.reportLines(since));
  if (conv) lines.push(...conv.reportLines());

  const hb = readJSON(heartbeatFile(), {});
  const { devices } = loadTokens();
  const devLines = [];
  for (const [name, info] of Object.entries(devices || {})) {
    if ((info.role || 'device') !== 'device') continue;
    const seen = hb[name]?.last_seen;
    if (!seen) devLines.push(`  ⚠ ${name}：从没同步过`);
    else {
      const h = (Date.now() - Date.parse(seen)) / 3600e3;
      devLines.push(h > 26 ? `  ⚠ ${name}：${Math.floor(h / 24)} 天 ${Math.floor(h % 24)} 小时没同步` : `  ✅ ${name}：${h < 1 ? Math.round(h * 60) + ' 分钟' : Math.round(h) + ' 小时'}前同步`);
    }
  }
  if (devLines.length) lines.push('· 设备', ...devLines);

  const usage = readJsonl(usageFile(), since).filter((u) => u.op.startsWith('tool:') || u.op.startsWith('cli:'));
  const byOp = {};
  for (const u of usage) {
    const k = u.op.replace(/^(tool|cli):(memory_)?/, '');
    byOp[k] = (byOp[k] || 0) + 1;
  }
  lines.push(usage.length
    ? `· 智能体调用 ${usage.length} 次：${Object.entries(byOp).map(([k, v]) => `${k} ${v}`).join('，')}`
    : '· 智能体调用 0 次（没有智能体查过或写过共享记忆）');

  const rej = readJsonl(rejectFile(), since);
  if (rej.length) {
    lines.push(`· ⚠ 拒收 ${rej.length} 条（疑似含密钥/口令，没有存）：`);
    for (const r of rej.slice(0, 5)) lines.push(`  - ${r.device}/${r.client} ${r.where}：${r.reason}`);
  }
  const red = readJsonl(path.join(CFG.state, 'redactions.jsonl'), since);
  if (red.length) {
    const files = [...new Set(red.map((r) => `${r.device}:${r.where.split('/').pop()}`))];
    lines.push(`· 打码后保存了 ${files.length} 个原生记忆文件（原文里有疑似密钥/口令，建议清理源文件）：${files.slice(0, 6).join('、')}${files.length > 6 ? ' 等' : ''}`);
  }
  const stale = all.filter((e) => e.meta.state === 'active' && e.meta.type === 'status' && ageDays(e.meta.updated) > STALE_DAYS && ageDays(e.meta.updated) <= STALE_DAYS + 1);
  if (stale.length) lines.push(`· 今天起 ${stale.length} 条项目现状超过 ${STALE_DAYS} 天没更新：${stale.map((e) => e.meta.title).slice(0, 3).join('；')}`);
  const guard = readJsonl(path.join(CFG.state, 'guard.jsonl'), since);
  if (guard.length) {
    const g = [...new Map(guard.map((x) => [`${x.device}/${x.client}`, x])).values()];
    lines.push(`· ⚠ 拦下了 ${g.length} 次整批作废（来源突然没了，没删记忆）：${g.map((x) => `${x.device}/${x.client} 少了 ${x.would_retire} 条`).join('；')}`);
  }
  return lines.join('\n');
}

// 大屏"智能体状态"和"记忆全景"：每台机器每个智能体怎么接的、记了多少、存了多少对话、最近 7 天查了几次共享记忆
function agentsOverview(scope) {
  const hb = readJSON(heartbeatFile(), {});
  const { devices } = loadTokens();
  const all = [...store.values()].filter((e) => !scope?.on || scope.entry(e));
  const active = all.filter((e) => e.meta.state === 'active');
  const since7 = Date.now() - 7 * 86400e3;
  const usage = readJsonl(usageFile(), since7).filter((u) => u.op.startsWith('tool:') || u.op.startsWith('cli:'));
  const idx = conv.index();
  const cells = {};
  const cell = (d, t) => ((cells[d] ||= {})[t] ||= { memories: 0, sessions: 0, lastMsg: null, calls: 0, lastCall: null, writes: 0 });
  for (const e of active) if (e.meta.origin === 'native' || e.meta.origin === 'explicit') cell(e.meta.author, e.meta.client).memories++;
  for (const [key, e] of Object.entries(idx)) {
    if (scope?.on && !scope.session(key)) continue;
    const c = cell(e.device, e.tool);
    c.sessions++;
    if (e.last && (!c.lastMsg || e.last > c.lastMsg)) c.lastMsg = e.last;
  }
  for (const u of usage) {
    const c = cell(u.device, u.client === 'cli' ? 'cli' : u.client);
    c.calls++;
    if (!c.lastCall || u.t > c.lastCall) c.lastCall = u.t;
    if (/remember|update|retire/.test(u.op)) c.writes++;
  }
  const devs = Object.entries(devices || {}).filter(([, v]) => (v.role || 'device') === 'device').map(([name]) => ({
    name, version: hb[name]?.agent_version || '', last_seen: hb[name]?.last_seen || null, wiring: hb[name]?.wiring || {}, sources: hb[name]?.sources || {}, cells: cells[name] || {},
  }));
  // 历史导入里的旧机器（没有令牌）也列出来，只有对话
  for (const name of Object.keys(cells)) if (!devs.some((d) => d.name === name)) devs.push({ name, version: '', last_seen: null, wiring: {}, sources: {}, cells: cells[name], legacy: true });
  const count = (list, key) => Object.entries(list.reduce((m, e) => { const k = key(e) || '（无）'; m[k] = (m[k] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]);
  const byState = count(all, (e) => e.meta.state);
  const recent = active.slice().sort(byUpdated).slice(0, 12).map((e) => ({ id: e.meta.id, type: e.meta.type, title: e.meta.title, project: e.meta.project || '', source: `${e.meta.author}/${e.meta.client}`, origin: e.meta.origin, updated: e.meta.updated }));
  return {
    devices: devs,
    memory: {
      total: active.length, byState, byType: count(active, (e) => e.meta.type), byOrigin: count(active, (e) => e.meta.origin),
      bySource: count(active, (e) => `${e.meta.author}/${e.meta.client}`).slice(0, 14), byProject: count(active, (e) => e.meta.project).slice(0, 12),
      added7: active.filter((e) => Date.parse(e.meta.created) >= since7).length,
      staleStatus: active.filter((e) => e.meta.type === 'status' && ageDays(e.meta.updated) > STALE_DAYS).length,
      proposed: all.filter((e) => e.meta.state === 'proposed').length,
      recent,
      calls7: usage.length,
    },
  };
}

// 巡检：只列需要处理的问题，没问题返回空数组。每个问题带稳定的 key，告警脚本据此去重、报"已恢复"
function watch() {
  const problems = [];
  const hb = readJSON(heartbeatFile(), {});
  const { devices } = loadTokens();
  for (const [name, info] of Object.entries(devices || {})) {
    if ((info.role || 'device') !== 'device' || info.paused) continue;
    const limit = info.stale_hours || CFG.stale_hours || 3;
    const seen = hb[name]?.last_seen;
    const h = seen ? (Date.now() - Date.parse(seen)) / 3600e3 : Infinity;
    if (h > limit) {
      problems.push({ key: `stale:${name}`, text: seen ? `设备 ${name} 已经 ${h >= 48 ? `${Math.floor(h / 24)} 天` : `${Math.floor(h)} 小时`}没同步（阈值 ${limit} 小时）` : `设备 ${name} 登记后一次都没同步过` });
    }
  }
  for (const g of readJsonl(path.join(CFG.state, 'guard.jsonl'), Date.now() - 6 * 3600e3)) {
    problems.push({ key: `guard:${g.device}/${g.client}`, text: `${g.device}/${g.client} 的来源突然少了 ${g.would_retire} 条（原有 ${g.owned}），已拦下没作废；确认是真删了就在那台机器上 AM_FORCE_RETIRE=1 再同步一次` });
  }
  if (pipe) problems.push(...pipe.watchProblems());
  if (conv) problems.push(...conv.watchProblems());
  return [...new Map(problems.map((p) => [p.key, p])).values()];
}

// ------------------------------------------------------------------- MCP ----

const TYPE_ENUM = { type: 'string', enum: TYPES };

const TOOLS = [
  {
    name: 'memory_search',
    description: '在跨机器、跨智能体的共享记忆里搜索：项目现状、以前的决定、踩过的坑、用户偏好和反馈。关键词用空格分隔（同时命中优先，子串匹配，中英文都行）。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '2–4 个关键词，空格分隔' },
        type: { ...TYPE_ENUM, description: '只看某类：preference 偏好 / feedback 反馈 / decision 决定 / status 现状 / pitfall 坑 / fact 事实 / reference 参考' },
        project: { type: 'string', description: '只看某个项目' },
        limit: { type: 'integer', description: '最多返回几条（默认 8，最多 30）' },
        include_inactive: { type: 'boolean', description: '是否包括已被取代、已作废的（默认否）' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_get',
    description: '按 id 读一条共享记忆的全文。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'memory_remember',
    description: '写一条共享记忆，所有机器上的智能体随后都能查到。只写值得长期复用的：结论、决定、踩坑、用户偏好/反馈、项目现状。不写进度流水和临时状态；不写密钥、令牌、口令、客户现场账号密码（会被拒收）。项目现状用 type=status 并填 subject（如 myapp/prod-version），会自动替代同一 subject 的旧现状。',
    inputSchema: {
      type: 'object',
      properties: {
        type: { ...TYPE_ENUM, description: 'preference 偏好 / feedback 反馈 / decision 决定 / status 现状 / pitfall 坑 / fact 事实 / reference 参考' },
        title: { type: 'string', description: '一行说清这条记忆（最多 200 字）' },
        body: { type: 'string', description: '正文：事实本身，再加"为什么"和"怎么用"（最多 8000 字）' },
        subject: { type: 'string', description: '主题键，status 必填，如 myapp/prod-version' },
        project: { type: 'string', description: '所属项目，如 myapp、api、infra' },
        tags: { type: 'array', items: { type: 'string' } },
        supersedes: { type: 'string', description: '这条要取代的旧条目 id（可选）' },
      },
      required: ['type', 'title'],
    },
  },
  {
    name: 'memory_update',
    description: '修改一条用 memory_remember 写的条目（原生记忆同步来的条目不能改）。只传要改的字段。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' },
        subject: { type: 'string' }, project: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
    },
  },
  {
    name: 'memory_retire',
    description: '作废一条错误或不再成立的条目（保留历史，不再出现在搜索和摘要里）。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, reason: { type: 'string' } }, required: ['id', 'reason'] },
  },
  {
    name: 'memory_recent',
    description: '看最近新增或更新的共享记忆。',
    inputSchema: {
      type: 'object',
      properties: { hours: { type: 'integer', description: '回看多少小时（默认 72）' }, limit: { type: 'integer', description: '最多几条（默认 20）' } },
    },
  },
  {
    name: 'memory_digest',
    description: '读共享记忆摘要：偏好与反馈、各项目最新现状、最近的决定与坑。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_handoff',
    description: '生成交接包（接力提示词）：某个项目（或关键词）最近一段时间的现状、还没收尾的事、拍板的决定、踩过的坑、工作日志、相关会话 ref、用户偏好，拼成一份可以直接交给新会话/新智能体的说明。换会话接着干、交接给别的智能体时用。',
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: '项目英文短名，如 myapp、api、agent-memory' }, query: { type: 'string', description: '没有项目名时用关键词' }, days: { type: 'integer', description: '看最近几天的日志（默认 14）' } } },
  },
  {
    name: 'memory_todos',
    description: '待办雷达：所有机器、所有智能体里还没收尾的事（工作日志最后状态是"进行中/卡住"的会话），以及停了的项目。问"还有什么没做完""哪些事悬着"时用。',
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: '只看某个项目' }, days: { type: 'integer', description: '看最近几天（默认 60）' } } },
  },
  {
    name: 'memory_entities',
    description: '知识图谱：查一个项目、机器、客户现场或版本号和谁有关、出现过哪些版本、最近的相关记录。如"客户 A 现场现在什么版本""server-1 上跑了哪些项目"。',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: '实体名，如 myapp、server-1、客户 A、2.9.21' } }, required: ['name'] },
  },
  {
    name: 'memory_timeline',
    description: '工作日志时间线：按天列出所有机器、所有智能体（Claude Code、Codex、WorkBuddy、Hermes、OpenClaw…）的会话，每段有一两句"做了什么"。用来回答"哪天干了什么""上周某项目做了哪些""某件事是哪天做的"。默认最近 7 天；ref 可交给 conversation_get 读原文。',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: '只看某一天：2026-11-20、11-20、今天、昨天' },
        from: { type: 'string', description: '起始日期（含）' },
        to: { type: 'string', description: '结束日期（含），默认今天' },
        days: { type: 'integer', description: '没给 from 时往前看几天（默认 7，最多 400）' },
        project: { type: 'string', description: '只看某个项目（英文短名，如 myapp、api、agent-memory；也匹配会话标题和目录）' },
        query: { type: 'string', description: '关键词过滤（在日志和会话标题里找，空格分隔全部命中）' },
        device: { type: 'string', description: '只看某台机器' },
        tool: { type: 'string', description: '只看某个智能体，如 claude-code、codex、workbuddy、hermes、openclaw' },
        detail: { type: 'boolean', description: '是否列出每段的要点（默认是）' },
      },
    },
  },
  {
    name: 'conversation_search',
    description: '在所有机器、所有智能体的原始对话（只有用户和助手说的话）里搜关键词，找"我在哪说过/哪次提到过"。空格分隔全部命中，返回会话、日期和片段；读上下文用 conversation_get。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，空格分隔，全部命中' },
        from: { type: 'string', description: '起始日期' },
        to: { type: 'string', description: '结束日期' },
        device: { type: 'string' },
        tool: { type: 'string' },
        role: { type: 'string', enum: ['user', 'assistant'], description: '只搜用户说的或助手说的' },
        limit: { type: 'integer', description: '最多几个会话（默认 10）' },
      },
      required: ['query'],
    },
  },
  {
    name: 'conversation_get',
    description: '读一个会话的原始对话（用户和助手说的话），ref 来自 memory_timeline 或 conversation_search。可按日期只看某一天，长会话分页。',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: '会话 ref（8 位）' },
        date: { type: 'string', description: '只看这一天的消息' },
        from: { type: 'integer', description: '从第几条开始（分页）' },
        role: { type: 'string', enum: ['user', 'assistant'] },
        full: { type: 'boolean', description: '长消息不截断' },
      },
      required: ['ref'],
    },
  },
];

const toolDisabled = (name) => Array.isArray(CFG.disabled_tools) && CFG.disabled_tools.includes(name);

function text(t, isError = false) {
  return { content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) };
}

// 统一在这里计时、判错、记一行：工具返回 isError 或抛异常算 err；搜索类工具由 runTool 在 stat 里填 hits / ids / p。
async function callTool(name, args, who) {
  const t0 = performance.now();
  const stat = {};
  let res = null;
  try {
    res = await runTool(name, args, who, stat);
    return res;
  } finally {
    try {
      logUsage(who, `tool:${name}`, args.query || args.id || args.ref || args.title || args.name || args.project || args.date || '', {
        hits: stat.hits, ids: stat.ids, p: stat.p, dur: performance.now() - t0, err: !res || res.isError || stat.err,
      });
    } catch (e) { console.error('记调用失败：', e.message); }
  }
}

async function runTool(name, args, who, stat) {
  if (toolDisabled(name)) return text(`工具 ${name} 已被管理员停用。`, true);
  if (['memory_remember', 'memory_update', 'memory_retire'].includes(name) && devicePolicy(who.device).readonly) return text('这台机器在共享记忆里设成了只读，不能写。', true);
  try {
    switch (name) {
      case 'memory_search': {
        const r = search(args);
        r.items = r.items.filter(({ e }) => visible(who, e.meta.project));
        stat.hits = r.items.length; // 只算关键词命中；按意思补的几条永远有（取最近的 5 条），不算命中
        stat.ids = r.items.map(({ e }) => e.meta.id);
        if (typeof args.project === 'string') stat.p = args.project;
        let out = renderSearch(r, args.query || '');
        // 关键词之外再按意思找几条（本地向量服务 embed_url），去掉已经列过的
        if (extras && args.query) {
          const seen = new Set(r.items.map(({ e }) => e.meta.id));
          const sem = await extras.semantic(args.query, { limit: 8 });
          const more = (sem || []).filter((x) => (x.kind !== 'memory' || !seen.has(x.id)) && visible(who, x.project)).slice(0, 5);
          if (more.length) out += `\n\n${extras.renderSemantic(more, args.query)}`;
        }
        return text(out);
      }
      case 'memory_handoff': return text(extras.handoff(args));
      case 'memory_todos': return text(extras.renderTodos(extras.todos(args)));
      case 'memory_entities': return text(extras.entity(args.name));
      case 'memory_get': {
        const e = store.get(String(args.id || '').trim());
        return e && visible(who, e.meta.project) ? text(renderEntry(e)) : text(`没有 id 为 ${args.id} 的条目`, true);
      }
      case 'memory_remember': {
        const { entry, superseded } = await remember(args, who);
        return text(`已写入 ${entry.meta.id}：[${TYPE_LABEL[entry.meta.type]}] ${entry.meta.title}${superseded.length ? `\n取代了：${superseded.join(', ')}` : ''}`);
      }
      case 'memory_update': {
        const e = await updateEntry(args, who);
        return text(`已更新 ${e.meta.id}：${e.meta.title}`);
      }
      case 'memory_retire': {
        const e = await retireEntry(args, who);
        return text(`已作废 ${e.meta.id}：${e.meta.title}`);
      }
      case 'memory_recent': {
        const hours = Math.min(Math.max(parseInt(args.hours, 10) || 72, 1), 24 * 90);
        const limit = Math.min(Math.max(parseInt(args.limit, 10) || 20, 1), 50);
        const since = Date.now() - hours * 3600e3;
        const items = [...store.values()].filter((e) => Date.parse(e.meta.updated) >= since).sort(byUpdated).slice(0, limit);
        return text(items.length ? [`最近 ${hours} 小时有 ${items.length} 条：`, ...items.map((e, i) => `${i + 1}. ${entryLine(e)}`)].join('\n') : `最近 ${hours} 小时没有新的记忆。`);
      }
      case 'memory_digest':
        return text(digest(who));
      case 'memory_timeline':
        if (typeof args.project === 'string') stat.p = args.project;
        return text(conv.timeline(args, stat));
      case 'conversation_search': return text(conv.search(args, stat));
      case 'conversation_get': return text(conv.get(args));
      case 'kb_map': return text(cards.map());
      case 'kb_search': return text(cards.search(args, stat));
      case 'kb_sections': return text(cards.sections(args));
      case 'kb_read': return text(cards.read(args));
      default:
        return text(`未知工具 ${name}`, true);
    }
  } catch (e) {
    if (e instanceof UserError || name.startsWith('kb_')) return text(e.message, true);
    console.error(`tool ${name} failed:`, e);
    return text(`服务端出错：${e.message}`, true);
  }
}

async function handleRpc(msg, who) {
  if (Array.isArray(msg)) return (await Promise.all(msg.map((m) => handleRpc(m, who)))).filter(Boolean);
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;
  const ok = (result) => (isNotification ? null : { jsonrpc: '2.0', id, result });
  const err = (code, message) => (isNotification ? null : { jsonrpc: '2.0', id, error: { code, message } });
  try {
    switch (method) {
      case 'initialize':
        return ok({
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'agent-memory', version: VERSION },
          instructions: '跨机器、跨智能体共享记忆。涉及项目现状、以前的决定、踩过的坑、用户偏好时先 memory_search；得出值得长期复用的结论时 memory_remember。',
        });
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: [...TOOLS, ...CARD_TOOLS].filter((t) => !toolDisabled(t.name)) });
      case 'tools/call': return ok(await callTool(params?.name, params?.arguments || {}, who));
      case 'resources/list': return ok({ resources: [] });
      case 'resources/templates/list': return ok({ resourceTemplates: [] });
      case 'prompts/list': return ok({ prompts: [] });
      default:
        if (method?.startsWith('notifications/')) return null;
        return err(-32601, `method not found: ${method}`);
    }
  } catch (e) {
    return err(-32603, e.message);
  }
}

// ------------------------------------------------------------------ HTTP ----

function send(res, code, body, type = 'application/json; charset=utf-8') {
  // ≥ 1KB 的文本/JSON 按 Accept-Encoding 压缩（br 优先，其次 gzip），见 perf.mjs
  sendBody(res, code, typeof body === 'string' ? body : JSON.stringify(body), type);
}

// 内部子请求（控制台首屏汇总接口用）：走和浏览器单独请求完全相同的 route（身份校验、过滤都一样），只把响应收下来；
// 带上原请求的头（网关身份），但不带 Accept-Encoding 和条件请求头，所以拿到的永远是原文
async function internalGet(req, target) {
  const headers = { ...req.headers };
  for (const k of ['accept-encoding', 'if-none-match', 'if-modified-since', 'range', 'content-length', 'content-type']) delete headers[k];
  const sub = { method: 'GET', url: target, headers, socket: req.socket };
  const chunks = [];
  let type = '';
  const subRes = {
    req: sub, statusCode: 200,
    writeHead(code, h = {}) { this.statusCode = code; type = String(h['content-type'] || ''); return this; },
    end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); },
  };
  try {
    await route(sub, subRes, new URL(target, 'http://localhost'));
  } catch (e) {
    if (!(e instanceof UserError)) console.error(e);
    return { status: e instanceof UserError ? 400 : 500, body: null };
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!/json/i.test(type)) return { status: subRes.statusCode, body: text };
  try { return { status: subRes.statusCode, body: JSON.parse(text) }; } catch { return { status: 500, body: null }; }
}

// 设备端离线快照：全部有效记忆（不含候选），用 etag 避免重复下载
let exportCache = null;
function exportSnapshot() {
  const active = [...store.values()].filter((e) => e.meta.state === 'active');
  const sig = sha256(active.map((e) => `${e.meta.id}:${e.meta.updated}:${e.meta.content_hash || ''}`).sort().join('|')).slice(0, 16);
  if (exportCache?.etag === sig) return exportCache;
  const entries = active.sort(byUpdated).map((e) => ({
    id: e.meta.id, type: e.meta.type, title: e.meta.title, subject: e.meta.subject || '', project: e.meta.project || '',
    tags: e.meta.tags || [], author: e.meta.author, client: e.meta.client, updated: e.meta.updated, body: e.body,
  }));
  exportCache = { etag: sig, entries };
  return exportCache;
}

// 异地备份：整个记忆仓库打成 git bundle（含全部历史）
async function backupBundle(res) {
  const tmp = path.join(CFG.state, `backup-${process.pid}-${Date.now()}.bundle`);
  try {
    await git('bundle', 'create', tmp, '--all');
    const size = fs.statSync(tmp).size;
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': size, 'content-disposition': 'attachment; filename="agent-memory.bundle"' });
    await new Promise((resolve, reject) => fs.createReadStream(tmp).on('error', reject).on('end', resolve).pipe(res));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function forbiddenPage(res) {
  return send(res, 403, '<!doctype html><meta charset="utf-8"><p style="font:15px sans-serif;padding:24px">只有已经接入共享记忆的你自己的机器能打开这个页面（按 Tailscale 或虚拟机身份识别）。</p>', 'text/html; charset=utf-8');
}

// 页面和静态文件：按修改时间判断，改了文件刷新就生效；ETag/304、压缩、合并脚本和样式包都在 perf.mjs
const statics = createStatic(APP_DIR, { notFound: (res) => send(res, 404, { error: 'not found' }) });

function readBody(req, max = 8 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > max) { reject(new UserError('请求体太大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new UserError('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

async function route(req, res, url) {
  const p = url.pathname;
  if (p === '/health') return send(res, 200, { ok: true, version: VERSION, agent_version: agentVersion(), entries: store.size });
  // 只读分享链接：在身份校验之前，没有身份的请求也能打开（链接本身就是凭证，见 share.mjs）
  if (p.startsWith('/s/')) return share.handle(req, res, url);
  const rv = /^\/review\/([0-9a-f]{32})(\/decide)?\/?$/.exec(p);
  if (rv) {
    // 审批页：链接本身就是凭证（只发在日报里），每周换一次
    if (!pipe.reviewKeyOk(rv[1])) return send(res, 404, '<meta charset="utf-8">链接已过期，请用最新日报里的链接。', 'text/html; charset=utf-8');
    if (!rv[2] && req.method === 'GET') return send(res, 200, pipe.reviewPage(rv[1]), 'text/html; charset=utf-8');
    if (rv[2] && req.method === 'POST') {
      const b = await readBody(req);
      const n = await pipe.decide(Array.isArray(b.ids) ? b.ids : [], b.action, 'review');
      return send(res, 200, { ok: true, n });
    }
    return send(res, 405, { error: 'method not allowed' });
  }
  const jn = /^\/join\/([0-9a-f]{24})(?:\/(sh|ps1|register|node\/([a-z0-9-]+)))?\/?$/.exec(p);
  if (jn) {
    const [, code, action, plat] = jn;
    if (!joinCodeOk(code)) return send(res, 404, '# 加入码无效或已过期，找管理员要一个新的。\nexit 1\n', 'text/plain; charset=utf-8');
    if (!action && req.method === 'GET') {
      const c = joinCommands(code, baseUrlOf(req));
      return send(res, 200, `加入共享记忆（在要加入的机器上运行一行即可，设备名自动取主机名）：\n\nmacOS / Linux 终端：\n  ${c.sh}\n\nWindows PowerShell：\n  ${c.ps1}\n`, 'text/plain; charset=utf-8');
    }
    if ((action === 'sh' || action === 'ps1') && req.method === 'GET') return send(res, 200, renderJoin(action, code, baseUrlOf(req)), 'text/plain; charset=utf-8');
    if (action === 'register' && req.method === 'POST') {
      const b = await readBody(req);
      return send(res, 200, registerJoin(code, b.name));
    }
    if (plat && req.method === 'GET') {
      // 没有 Node 的机器从这里下载一份（不依赖外网）
      const dir = CFG.dist_dir || '/srv/agent-memory/dist';
      const file = (() => { try { return fs.readdirSync(dir).find((n) => n.startsWith('node-') && (n.endsWith(`-${plat}.tar.gz`) || n.endsWith(`-${plat}.zip`))); } catch { return null; } })();
      if (!file) return send(res, 404, { error: `没有 ${plat} 的 Node 安装包` });
      const full = path.join(dir, file);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': fs.statSync(full).size, 'content-disposition': `attachment; filename="${file}"` });
      fs.createReadStream(full).pipe(res);
      return;
    }
    return send(res, 405, { error: 'method not allowed' });
  }
  if (p.startsWith('/console/api/')) return admin.handle(req, res, url);
  // 短地址：浏览器里只打 IP:端口 就到大屏；/w 年报、/b 记忆浏览（页面本身仍然只对已接入的机器开放）
  // 旧地址都跳到控制台；/w 年报不变；/wall 是巡航大屏
  const SHORT = {
    '/': '/console', '/viz': '/console', '/v': '/console', '/browse/viz': '/console',
    '/b': '/console#/lib', '/browse': '/console#/lib', '/browse/': '/console#/lib',
    '/browse/manage': '/console#/triage',
    '/r': '/console#/timeline/replay',
    '/w': '/browse/wrapped', '/wrapped': '/browse/wrapped',
  };
  if (req.method === 'GET' && SHORT[p] && !req.headers.authorization) {
    res.writeHead(302, { location: SHORT[p], 'cache-control': 'no-store' });
    return res.end();
  }
  // 控制台（侧栏导航的单页应用）和巡航大屏：只给已接入的你自己的机器看，身份校验同 /browse
  if (p === '/console' || p.startsWith('/console/') || p === '/wall') {
    const viewer = browseViewer(req);
    if (!viewer) return forbiddenPage(res);
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
    if (p === '/console' || p === '/console/') {
      logUsage({ device: viewer, client: 'browser' }, 'console');
      return statics.html(res);
    }
    if (p === '/wall') {
      logUsage({ device: viewer, client: 'browser' }, 'wall');
      return statics.page(res, 'wall.html', 'text/html; charset=utf-8');
    }
    // 控制台静态文件：只放行 console*.css / console*.js
    const cf = /^\/console\/(console[\w-]*\.(css|js))$/.exec(p);
    if (cf) return statics.asset(res, cf[1]);
    return send(res, 404, { error: 'not found' });
  }
  // 记忆数据接口（控制台和大屏用）：只给已接入的你自己的机器看（凭网关认出的身份，且该身份绑定了一个设备）；不在名单里的机器打不开
  if (p === '/browse' || p.startsWith('/browse/')) {
    const viewer = browseViewer(req);
    if (!viewer) return forbiddenPage(res);
    // 浏览者设了 hide_projects 时，下面每个接口都按 scope 过滤：被隐藏项目的内容、名字、条目 id、会话 ref 都不给（没设的设备完全不变）
    const scope = scopeOf(viewer);
    if (p === '/browse/data') return send(res, 200, browseData(scope));
    if (p === '/browse/viz-data') {
      const active = [...store.values()].filter((e) => e.meta.state === 'active' && scope.entry(e));
      const byType = {};
      for (const e of active) byType[e.meta.type] = (byType[e.meta.type] || 0) + 1;
      return send(res, 200, { ...conv.vizData(scope), memories: { total: active.length, byType }, device_labels: CFG.device_labels || {} });
    }
    if (p === '/browse/viz-day') return send(res, 200, conv.vizDay(url.searchParams.get('date') || '', scope));
    if (p === '/browse/viz-extra') return send(res, 200, conv.vizExtra(scope));
    if (p === '/browse/viz-galaxy') return send(res, 200, conv.vizGalaxy(scope));
    if (p === '/browse/viz-agents') return send(res, 200, agentsOverview(scope));
    if (p === '/browse/projects') return send(res, 200, extras.projects(scope));
    if (p === '/browse/handoff') return send(res, 200, extras.handoff(Object.fromEntries(url.searchParams), scope), 'text/plain; charset=utf-8');
    if (p === '/browse/todos') return send(res, 200, extras.todos(Object.fromEntries(url.searchParams), scope));
    if (p === '/browse/todo' && req.method === 'POST') { const b = await readBody(req); return send(res, 200, await extras.markTodo(b.ref, b.action, viewer, scope)); }
    if (p === '/browse/graph') return send(res, 200, extras.graph(scope));
    if (p === '/browse/entity') return send(res, 200, extras.entity(url.searchParams.get('name') || '', scope), 'text/plain; charset=utf-8');
    if (p === '/browse/audit') {
      // 各设备的策略里，限制可见范围的浏览者只看到自己也看得到的项目名
      const policies = Object.fromEntries(Object.keys(loadTokens().devices || {}).map((k) => { const pol = devicePolicy(k); return [k, scope.on ? { ...pol, hide: pol.hide.filter((x) => scope.project(x)) } : pol]; }));
      return send(res, 200, { ...extras.audit(Object.fromEntries(url.searchParams), scope), policies });
    }
    if (p === '/browse/semantic') {
      const qq = url.searchParams.get('q') || '';
      const rs = qq ? await extras.semantic(qq, { limit: 20, scope }) : [];
      return send(res, 200, { status: extras.semanticStatus(), results: rs || [] });
    }
    if (p === '/browse/manage-counts') return send(res, 200, extras.manageCounts(scope));
    if (p === '/browse/manage-data') return send(res, 200, extras.manageData(scope));
    if (p === '/browse/manage-action' && req.method === 'POST') {
      const b = await readBody(req);
      logUsage({ device: viewer, client: 'browser' }, `manage:${b.action}`, (Array.isArray(b.ids) ? b.ids : [b.id]).join(','));
      return send(res, 200, await extras.manageAction(b, viewer, { updateEntry, decide: (ids, action, by) => pipe.decide(ids, action, by) }, scope));
    }
    if (p === '/browse/viz-live') {
      const hb = readJSON(heartbeatFile(), {});
      const { devices } = loadTokens();
      const sync = Object.fromEntries(Object.entries(devices || {}).filter(([, v]) => (v.role || 'device') === 'device').map(([k]) => [k, { last_seen: hb[k]?.last_seen || null, version: hb[k]?.agent_version || '' }]));
      return send(res, 200, { ...conv.vizLive(scope), sync, memories: [...store.values()].filter((e) => e.meta.state === 'active' && scope.entry(e)).length });
    }
    if (p === '/browse/viz-search') return send(res, 200, conv.searchDays(url.searchParams.get('q') || '', scope));
    // 年度工作报告（翻页卡片）
    if (p === '/browse/wrapped') {
      logUsage({ device: viewer, client: 'browser' }, 'wrapped');
      return send(res, 200, fs.readFileSync(path.join(APP_DIR, 'wrapped.html'), 'utf8'), 'text/html; charset=utf-8');
    }
    if (p === '/browse/wrapped-data') {
      const active = [...store.values()].filter((e) => e.meta.state === 'active' && scope.entry(e));
      return send(res, 200, { ...conv.wrapped(scope), device_labels: CFG.device_labels || {}, memories: { total: active.length, bySource: Object.entries(active.reduce((m, e) => { m[e.meta.client] = (m[e.meta.client] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]) } });
    }
    const be = /^\/browse\/entry\/([A-Za-z0-9-]+)$/.exec(p);
    if (be) {
      const e = store.get(be[1]);
      return e && scope.entry(e) ? send(res, 200, renderEntry(e), 'text/plain; charset=utf-8') : send(res, 404, '没有这条', 'text/plain; charset=utf-8');
    }
    return send(res, 404, { error: 'not found' });
  }
  // 固定安装地址（不用加入码）：在 Tailscale 网络里或宿主机的虚拟机里运行，自动按机器身份登记
  if (req.method === 'GET' && (p === '/install.sh' || p === '/install.ps1')) {
    // 不接入名单里的机器（auto_register_deny 匹配到的，比如不该接入的机器）：给一个什么都不做的脚本，不往那台机器上放任何东西
    const peer = gatePeer(req);
    if (peer && (CFG.auto_register_deny || []).some((re) => new RegExp(re, 'i').test(peer.name))) {
      appendJsonl(path.join(CFG.state, 'auto-register.jsonl'), { t: nowIso(), peer: peer.key, result: 'install-denied' });
      return send(res, 200, p.endsWith('.ps1') ? "Write-Host 'agent-memory: this machine is excluded'\n" : "echo 'agent-memory: this machine is excluded'\n", 'text/plain; charset=utf-8');
    }
    return send(res, 200, renderJoin(p.endsWith('.ps1') ? 'ps1' : 'sh', null, baseUrlOf(req)), 'text/plain; charset=utf-8');
  }
  if (req.method === 'POST' && p === '/v1/auto-register') return send(res, 200, autoRegister(req));
  const an = /^\/auto\/node\/([a-z0-9-]+)$/.exec(p);
  if (an && req.method === 'GET') {
    const dir = CFG.dist_dir || '/srv/agent-memory/dist';
    const file = (() => { try { return fs.readdirSync(dir).find((n) => n.startsWith('node-') && (n.endsWith(`-${an[1]}.tar.gz`) || n.endsWith(`-${an[1]}.zip`))); } catch { return null; } })();
    if (!file) return send(res, 404, { error: `没有 ${an[1]} 的 Node 安装包` });
    const full = path.join(dir, file);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': fs.statSync(full).size });
    fs.createReadStream(full).pipe(res);
    return;
  }
  if (req.method === 'GET' && p.startsWith('/install/')) {
    // 一次性安装链接：用过或过期就失效
    const it = consumeInvite(p.slice('/install/'.length));
    if (!it) return send(res, 404, '# 安装链接无效、已用过或已过期（24 小时）。\nexit 1\n', 'text/plain; charset=utf-8');
    console.log(`install link used for device ${it.device}`);
    return send(res, 200, renderInstall(it), 'text/x-shellscript; charset=utf-8');
  }
  const who = authenticate(req, url);
  if (!who) return send(res, 401, { error: 'unauthorized' });
  noteRequest(who, p);
  if (who.role === 'reporter' && !['/v1/report', '/v1/status', '/v1/watch', '/v1/weekly'].includes(p)) return send(res, 403, { error: 'forbidden' });
  // 历史导入用的 admin 令牌只能代别的设备追加对话
  if (who.role === 'admin' && !['/v1/conv/append', '/v1/status'].includes(p)) return send(res, 403, { error: 'forbidden' });
  const extractorOnly = ['/v1/sessions/pending', '/v1/sessions/item', '/v1/sessions/result', '/v1/titles', '/v1/journal/pending', '/v1/journal/item', '/v1/journal/result'];
  if (who.role === 'extractor' && ![...extractorOnly, '/v1/status'].includes(p)) return send(res, 403, { error: 'forbidden' });
  if (who.role !== 'extractor' && extractorOnly.includes(p)) return send(res, 403, { error: 'forbidden' });

  if (p === '/mcp') {
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only (stateless streamable HTTP)' });
    const reply = await handleRpc(await readBody(req), who);
    if (!reply || (Array.isArray(reply) && !reply.length)) { res.writeHead(202); return res.end(); }
    return send(res, 200, reply);
  }
  const q = Object.fromEntries(url.searchParams);
  switch (`${req.method} ${p}`) {
    case 'POST /v1/native/sync': return send(res, 200, await nativeSync(await readBody(req), who));
    case 'POST /v1/heartbeat': return send(res, 200, heartbeat(await readBody(req), who));
    case 'POST /v1/import': return send(res, 200, await importEntries(await readBody(req, 16 << 20), who));
    case 'GET /v1/agent': return send(res, 200, fs.readFileSync(path.join(APP_DIR, 'kb-agent.mjs'), 'utf8'), 'text/javascript; charset=utf-8');
    case 'POST /v1/sessions': return send(res, 200, pipe.uploadSession(await readBody(req, 16 << 20), who));
    case 'GET /v1/sessions/pending': return send(res, 200, pipe.pendingSessions(parseInt(q.limit, 10) || 20));
    case 'GET /v1/sessions/item': {
      const item = pipe.sessionItem(q.key || '');
      return item ? send(res, 200, item) : send(res, 404, { error: 'not found' });
    }
    case 'POST /v1/sessions/result': logUsage(who, 'extract:session'); return send(res, 200, await pipe.sessionResult(await readBody(req), who));
    case 'GET /v1/titles': return send(res, 200, pipe.titles(), 'text/plain; charset=utf-8');
    case 'POST /v1/conv/append': return send(res, 200, await conv.append(await readBody(req, 24 << 20), who));
    case 'GET /v1/journal/pending': return send(res, 200, conv.pending({ limit: parseInt(q.limit, 10) || 50, includeToday: q.today === '1' }));
    case 'GET /v1/journal/item': {
      const it = conv.item(q.key || '', q.date || '');
      return it ? send(res, 200, it) : send(res, 404, { error: 'not found' });
    }
    case 'POST /v1/journal/result': logUsage(who, 'extract:journal'); return send(res, 200, await conv.result(await readBody(req, 8 << 20), who));
    case 'GET /v1/weekly': logUsage(who, 'report:weekly'); return send(res, 200, extras.weekly(), 'text/plain; charset=utf-8');
    case 'GET /v1/handoff': logUsage(who, 'cli:handoff', q.project || q.query); return send(res, 200, extras.handoff(q), 'text/plain; charset=utf-8');
    case 'GET /v1/todos': logUsage(who, 'cli:todos', q.project); return send(res, 200, extras.renderTodos(extras.todos(q)), 'text/plain; charset=utf-8');
    case 'GET /v1/entity': logUsage(who, 'cli:entities', q.name); return send(res, 200, extras.entity(q.name), 'text/plain; charset=utf-8');
    case 'GET /v1/timeline': logUsage(who, 'cli:timeline'); return send(res, 200, conv.timeline(q), 'text/plain; charset=utf-8');
    case 'GET /v1/conv/search': {
      const t0 = performance.now();
      const st = {};
      const out = conv.search({ ...q, query: q.q || q.query }, st);
      logUsage(who, 'cli:conversation_search', q.q || q.query, { hits: st.hits, dur: performance.now() - t0, err: st.err });
      return send(res, 200, out, 'text/plain; charset=utf-8');
    }
    case 'GET /v1/conv/get': logUsage(who, 'cli:conversation_get'); return send(res, 200, conv.get(q), 'text/plain; charset=utf-8');
    case 'GET /v1/vault': {
      const v = pipe.vault();
      if (q.etag && q.etag === v.etag) { res.writeHead(304); return res.end(); }
      return send(res, 200, { etag: v.etag, files: v.files });
    }
    case 'GET /v1/vault2/manifest': {
      const m = vault2.manifest();
      if (q.etag && q.etag === m.etag) { res.writeHead(304); return res.end(); }
      return send(res, 200, m);
    }
    case 'POST /v1/vault2/files': return send(res, 200, vault2.fetchFiles((await readBody(req)).paths));
    case 'GET /v1/export': {
      const x = exportSnapshot();
      if (q.etag && q.etag === x.etag) { res.writeHead(304); return res.end(); }
      return send(res, 200, x);
    }
    case 'GET /v1/backup': return backupBundle(res);
    case 'GET /v1/watch': return send(res, 200, { problems: watch() });
    case 'GET /v1/digest': return send(res, 200, digest(who, q.tool), 'text/markdown; charset=utf-8');
    case 'GET /v1/rules': return send(res, 200, rules(q.tool || who.client), 'text/markdown; charset=utf-8');
    case 'GET /v1/status': return send(res, 200, status());
    case 'GET /v1/report': logUsage(who, 'report:report'); return send(res, 200, report(parseInt(q.hours, 10) || 24), 'text/plain; charset=utf-8');
    case 'GET /v1/search': {
      const t0 = performance.now();
      const qq = q.q || q.query || '';
      const r = search({ ...q, query: qq });
      logUsage(who, 'cli:search', qq, { hits: r.items.length, ids: r.items.map(({ e }) => e.meta.id), dur: performance.now() - t0 });
      return send(res, 200, renderSearch(r, qq), 'text/plain; charset=utf-8');
    }
    case 'POST /v1/remember': {
      logUsage(who, 'cli:remember');
      if (devicePolicy(who.device).readonly) return send(res, 403, { error: '这台机器设成了只读' });
      const { entry, superseded } = await remember(await readBody(req), who);
      return send(res, 200, { id: entry.meta.id, superseded });
    }
    default:
      if (req.method === 'GET' && p.startsWith('/v1/entries/')) {
        const t0 = performance.now();
        const eid = decodeURIComponent(p.slice('/v1/entries/'.length));
        const e = store.get(eid);
        logUsage(who, 'cli:get', eid, { dur: performance.now() - t0, err: !e });
        return e ? send(res, 200, renderEntry(e), 'text/plain; charset=utf-8') : send(res, 404, { error: 'not found' });
      }
      return send(res, 404, { error: 'not found' });
  }
}

let pipe = null;
let conv = null;
let vault2 = null;
let extras = null;
let admin = null;
let share = null;

// 设备端每次同步会比对这个版本号，不一样就自动下载新版替换自己
function agentVersion() {
  try { return /const VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(APP_DIR, 'kb-agent.mjs'), 'utf8'))?.[1] || null; } catch { return null; }
}

async function main() {
  await ensureRepo();
  await loadStore();
  pipe = createPipeline({
    CFG, store, writeEntry, commit, serial, nowIso, sha256, findSecret, logReject, UserError,
    TYPES, TYPE_LABEL, LIMITS, newId, readJSON, appendJsonl, fmtLocal, byUpdated, ageDays, APP_DIR,
  });
  await pipe.fixCandidateDates();
  for (const [k, v] of Object.entries(readJSON(lastReqFile(), {}))) if (v && typeof v.t === 'string') lastReq.set(k, { t: v.t, op: typeof v.op === 'string' ? v.op : null });
  conv = createConvLog({ CFG, nowIso, redactSecrets, findSecret, UserError, readJSON, commit, serial });
  vault2 = createVault({ CFG, store, conv, TYPE_LABEL, fmtLocal, byUpdated, ageDays });
  extras = createExtras({ CFG, store, conv, nowIso, readJSON, appendJsonl, serial, writeEntry, commit, byUpdated, ageDays, TYPE_LABEL, UserError, readJsonl, usageFile, findSecret, redactSecrets });
  share = createShare({ CFG, readJSON, conv, extras, scopeOf });
  admin = createAdmin({
    CFG, CONFIG_PATH, readJSON, readJsonl, usageFile, logUsage, nowIso, readBody, send, UserError, browseViewer, loadTokens, peersFile,
    heartbeatFile, agentsOverview, watch, git, store, deviceSet, newJoinCode, VERSION, agentVersion, redactSecrets, usageTail,
    lastRequest: (name) => lastReq.get(name) || null,
    tools: () => [...TOOLS, ...CARD_TOOLS], conv: () => conv, extras: () => extras, pipe: () => pipe,
    listJoinCodes, revokeJoinCode, internalGet,
    // 浏览者（设备名）按 hide_projects 能不能看某个项目；口径同 MCP 工具里的 visible()
    visibleTo: (viewer, project) => scopeOf(viewer).project(project), hiddenOf: (viewer) => hiddenFor({ device: viewer }),
    // 各功能需要的 server 内部函数在自己的占位行上加；占位行之间隔着空行，合并时互不冲突
    // [B] 参数位
    //
    // [C] 参数位
    usageMetaFile,
    //
    // [D] 参数位
    //
    // [E] 参数位
    searchMemory: search, byUpdated,
    //
    share, scopeOf, // [F] 参数位
  });
  const vecTick = () => extras.reindex().then((r) => { if (r.indexed) console.log(`向量：新建 ${r.indexed} 条，共 ${r.total} 条`); }).catch((e) => console.error('向量索引失败：', e.message));
  setTimeout(vecTick, 30e3);
  setInterval(vecTick, 10 * 60e3);
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { try { conv.flush(); if (lastReqDirty) flushLastReq(); } finally { process.exit(0); } });
  const tick = () => pipe.autoApprove().catch((e) => console.error('auto-approve failed:', e));
  tick();
  setInterval(tick, 3600e3);
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, 'http://localhost');
    try {
      await route(req, res, url);
    } catch (e) {
      if (e instanceof UserError) send(res, 400, { error: e.message });
      else { console.error(e); send(res, 500, { error: 'internal error' }); }
    } finally {
      if (url.pathname !== '/health') console.log(`${req.method} ${url.pathname.startsWith('/s/') ? '/s/…' : url.pathname} ${res.statusCode} ${Date.now() - started}ms`); // 分享链接的令牌不进日志
    }
  });
  server.listen(CFG.port, CFG.listen, () => {
    console.log(`agent-memory ${VERSION} listening on ${CFG.listen}:${CFG.port}, ${store.size} entries`);
  });
  statics.warm();
}

function addDeviceToken(name, role = 'device', via = '') {
  if (!/^[A-Za-z0-9._-]{2,40}$/.test(name || '')) throw new Error('设备名只能用字母数字 . _ -');
  const tokens = loadTokens();
  tokens.devices ||= {};
  const token = crypto.randomBytes(32).toString('hex');
  tokens.devices[name] = { sha256: sha256(token), role, created: nowIso(), ...(via ? { via } : {}) };
  fs.mkdirSync(path.dirname(CFG.tokens), { recursive: true });
  fs.writeFileSync(CFG.tokens, JSON.stringify(tokens, null, 1), { mode: 0o600 });
  return token;
}

const [, , cliCmd, cliArg1, cliArg2] = process.argv;
if (cliCmd === 'add-device') process.stdout.write(addDeviceToken(cliArg1, cliArg2) + '\n');
else if (cliCmd === 'invite') {
  // 生成一次性安装命令（24 小时内有效，用一次就失效）；会给该设备签发新令牌
  const code = createInvite(cliArg1);
  process.stdout.write(`curl -fsSL ${CFG.public_url}/install/${code} | bash\n`);
} else if (cliCmd === 'join-code') {
  // 生成可重复使用的加入命令（默认 7 天有效；join-code 0 是长期有效），给多台机器用
  const days = /^(0|forever)$/.test(cliArg1 || '') ? 0 : parseInt(cliArg1, 10) || 7;
  const j = newJoinCode(days);
  process.stdout.write(`${days ? `${days} 天内有效` : '长期有效'}，可以在任意多台机器上用：\nmacOS / Linux：${j.sh}\nWindows PowerShell：${j.ps1}\n说明页：${j.page}\n`);
} else if (cliCmd === 'device-set') {
  // 设巡检参数：device-set mac stale_hours=48 / device-set 某机 paused=true（停用、不告警）
  const changes = {};
  for (const kv of process.argv.slice(4)) {
    const [k, v] = kv.split('=');
    if (k === 'stale_hours') changes[k] = Math.max(1, parseInt(v, 10) || 3);
    else if (k === 'paused' || k === 'readonly') changes[k] = v === 'true';
    else if (k === 'hide_projects') changes[k] = v ? v.split(',').map((x) => x.trim()).filter(Boolean) : null;
    else changes[k] = undefined; // 不认识的参数，交给 deviceSet 报错
  }
  try {
    process.stdout.write(`${cliArg1}: ${JSON.stringify(deviceSet(cliArg1, changes))}\n`);
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
} else if (cliCmd === 'rename-device') {
  // 改设备名（令牌不变）：设备上 config.json 里的 device 字段只是显示用，可以不改
  const tokens = loadTokens();
  if (!tokens.devices?.[cliArg1]) { process.stderr.write(`没有设备 ${cliArg1}\n`); process.exit(1); }
  if (!/^[A-Za-z0-9._-]{2,40}$/.test(cliArg2 || '') || tokens.devices[cliArg2]) { process.stderr.write(`新名字 ${cliArg2} 不合法或已存在\n`); process.exit(1); }
  tokens.devices[cliArg2] = tokens.devices[cliArg1];
  delete tokens.devices[cliArg1];
  fs.writeFileSync(CFG.tokens, JSON.stringify(tokens, null, 1), { mode: 0o600 });
  const hb = readJSON(heartbeatFile(), {});
  if (hb[cliArg1]) { hb[cliArg2] = hb[cliArg1]; delete hb[cliArg1]; fs.writeFileSync(heartbeatFile(), JSON.stringify(hb, null, 1)); }
  process.stdout.write(`已把设备 ${cliArg1} 改名为 ${cliArg2}（之前它写的记忆作者名不变）\n`);
} else if (cliCmd === 'remove-device') {
  const tokens = loadTokens();
  if (!tokens.devices?.[cliArg1]) { process.stderr.write(`没有设备 ${cliArg1}\n`); process.exit(1); }
  delete tokens.devices[cliArg1];
  fs.writeFileSync(CFG.tokens, JSON.stringify(tokens, null, 1), { mode: 0o600 });
  const pe = readJSON(peersFile(), {});
  if (pe[cliArg1]) { delete pe[cliArg1]; fs.writeFileSync(peersFile(), JSON.stringify(pe, null, 1)); }
  process.stdout.write(`已删除设备 ${cliArg1} 的令牌（它写过的记忆保留）\n`);
} else main().catch((e) => { console.error(e); process.exit(1); });
