/* 只读分享链接（中心 0.10）：把某个项目的时间线或交接包做成一个 /s/<令牌> 链接，给没有控制台权限的人看。
 *
 * 安全约束（缺一不可）：
 * - 令牌是 32 字节随机数（base64url，43 个字符）；盘上（state/shares.json）只存它的 sha256，丢了没法倒推出链接，
 *   明文只在创建那一次的响应里出现（控制台接口 POST /console/api/shares，见 admin-access.mjs）。
 * - 必须带有效期（1、7、30 天），可列出、可作废；无效、过期、作废、创建者已经看不到该项目、格式不对，一律返回完全相同的 404。
 * - 未认证访问限速：每个 IP 每分钟失败 30 次后返回 429。
 * - 响应带 Cache-Control: no-store、X-Robots-Tag: noindex, nofollow, noarchive、Referrer-Policy: no-referrer，页面里有 <meta name="robots">；
 *   页面自包含（没有外部资源、没有脚本、没有指向控制台的链接）。
 *
 * 分享版内容边界：只有项目名、日期、设备显示名（device_labels）、智能体、工作日志的 summary（一两句话）和"进行中/卡住"状态。
 * 不给：对话原文、会话标题和 ref、工作日志里的 points（更细的要点）、记忆条目的标题和正文（所以交接包里没有现状/决定/坑/参考/偏好）、
 * 记忆 id、会话所在目录。内容在打开链接时按工作日志实时生成，不是创建时的快照；
 * 同时按"创建者现在看得到什么"裁剪：创建者之后被设了 hide_projects，他看不到的会话和项目不会出现在链接里（项目本身被隐藏则整条链接失效）。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AUTO_CWD } from './convlog.mjs';

const TZ = 8 * 3600e3;
const DAY = 86400e3;
const localDay = (ms) => new Date(ms + TZ).toISOString().slice(0, 10);
const localMinute = (ms) => new Date(ms + TZ).toISOString().slice(0, 16).replace('T', ' ');
const WEEK = '日一二三四五六';
const weekday = (d) => `周${WEEK[new Date(`${d}T12:00:00Z`).getUTCDay()]}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TOOL_LABEL = {
  'claude-code': 'Claude Code', codex: 'Codex', workbuddy: 'WorkBuddy', 'workbuddy-ai': 'WorkBuddy AI', codebuddy: 'CodeBuddy', hermes: 'Hermes',
  openclaw: 'OpenClaw', opencode: 'OpenCode', gemini: 'Gemini', qwen: 'Qwen', cursor: 'Cursor', windsurf: 'Windsurf', 'claude-desktop': 'Claude 桌面版',
};
const STATUS = { ongoing: '进行中', blocked: '卡住' };

export const SHARE_KINDS = { timeline: '时间线', handoff: '交接包' };
export const SHARE_DAYS = [1, 7, 30];
const WINDOW_DAYS = { timeline: 30, handoff: 14 }; // 页面里往回看多少天的工作日志
const SEG_MAX = { timeline: 200, handoff: 80 };
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const RATE = { fails: 30, windowMs: 60e3 };

const HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  pragma: 'no-cache',
  'x-robots-tag': 'noindex, nofollow, noarchive',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
const NOT_FOUND = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow, noarchive"><meta name="referrer" content="no-referrer"><title>404</title></head><body style="font:15px sans-serif;padding:24px">链接无效或已失效。</body></html>';
const TOO_MANY = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow, noarchive"><title>429</title></head><body style="font:15px sans-serif;padding:24px">请求太频繁，稍后再试。</body></html>';

const CSS = `
*{box-sizing:border-box}
html,body{margin:0;background:#0b1020;color:#e8ecf6}
body{font:15px/1.65 -apple-system,"PingFang SC","Microsoft YaHei","Segoe UI",sans-serif;min-height:100vh}
main{max-width:780px;margin:0 auto;padding:36px 20px 56px}
header{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;padding-bottom:14px;border-bottom:1px solid rgba(110,150,255,.16)}
h1{margin:0;font-size:26px;font-weight:700;letter-spacing:.3px;word-break:break-all}
.kind{font-size:13px;color:#86b6ef;border:1px solid rgba(134,182,239,.35);border-radius:999px;padding:1px 12px}
.meta{margin:12px 0 0;display:flex;flex-wrap:wrap;gap:6px 18px;font-size:13px;color:#a3aecb}
h2{margin:30px 0 10px;font-size:15px;font-weight:600;color:#a3aecb;letter-spacing:.5px}
ul{list-style:none;margin:0;padding:0;border:1px solid rgba(110,150,255,.16);border-radius:12px;background:rgba(17,25,48,.72);overflow:hidden}
li{padding:11px 16px;border-top:1px solid rgba(110,150,255,.10)}
li:first-child{border-top:0}
.who{display:block;font-size:12.5px;color:#6f7a99;margin-bottom:2px}
.st{display:inline-block;margin-right:8px;font-size:12px;line-height:18px;padding:0 8px;border-radius:999px;color:#fab219;border:1px solid rgba(250,178,25,.45)}
.st.bad{color:#f08a8a;border-color:rgba(208,59,59,.55)}
h3{margin:22px 0 8px;font-size:13px;font-weight:500;color:#6f7a99}
.empty{margin:30px 0;color:#6f7a99;text-align:center}
@media(max-width:520px){main{padding:24px 14px 40px}h1{font-size:22px}li{padding:10px 13px}}
`;

export function createShare(ctx) {
  const { CFG, readJSON, conv, extras } = ctx;
  const now = ctx.now || (() => Date.now());
  const file = () => path.join(CFG.state, 'shares.json');
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const iso = (ms) => new Date(ms).toISOString();

  // ---------------------------------------------------------------- 存取（每次读盘，改了文件当场生效）
  const load = () => { const l = readJSON(file(), []); return Array.isArray(l) ? l : []; };
  function save(list) {
    fs.mkdirSync(CFG.state, { recursive: true });
    const tmp = `${file()}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, file());
  }
  const statusOf = (r) => (r.revoked ? 'revoked' : Date.parse(r.expires) <= now() ? 'expired' : 'active');
  // 对外的视图：没有哈希，更没有令牌
  const view = (r) => ({ id: r.id, project: r.project, kind: r.kind, created: r.created, expires: r.expires, creator: r.creator, status: statusOf(r) });

  function create({ project, kind, days, creator }) {
    const t = now();
    const token = crypto.randomBytes(32).toString('base64url');
    const rec = { id: crypto.randomBytes(6).toString('hex'), hash: sha(token), project, kind, created: iso(t), expires: iso(t + days * DAY), creator, revoked: null };
    const list = load().filter((r) => Date.parse(r.expires) > t - 30 * DAY); // 过期超过 30 天的记录顺手清掉
    list.push(rec);
    save(list);
    return { token, share: view(rec) };
  }
  const list = () => load().map(view).sort((a, b) => b.created.localeCompare(a.created));
  const get = (id) => { const r = load().find((x) => x.id === id); return r ? view(r) : null; };
  function revoke(id) {
    const all = load();
    const r = all.find((x) => x.id === id);
    if (!r || statusOf(r) !== 'active') return false;
    r.revoked = iso(now());
    save(all);
    return true;
  }
  function byToken(token) {
    if (!TOKEN_RE.test(token)) return null;
    const h = sha(token);
    const hb = Buffer.from(h);
    let found = null;
    for (const r of load()) { // 不提前退出：比较时间和命中位置无关
      if (typeof r.hash === 'string' && r.hash.length === h.length && crypto.timingSafeEqual(Buffer.from(r.hash), hb)) found = r;
    }
    return found && statusOf(found) === 'active' ? found : null;
  }

  // ---------------------------------------------------------------- 内容
  function collect(rec) {
    const scope = ctx.scopeOf?.(rec.creator); // 创建者现在的可见范围
    const p = String(rec.project).toLowerCase();
    const since = localDay(now() - (WINDOW_DAYS[rec.kind] - 1) * DAY);
    const labels = CFG.device_labels || {};
    const idx = conv.index();
    const segs = [];
    for (const [d, o] of conv.journal()) {
      if (d < since) continue;
      for (const [key, s] of Object.entries(o)) {
        if (String(s.project || '').toLowerCase() !== p || !s.summary) continue;
        const e = idx[key];
        if (e && AUTO_CWD.test(e.cwd || '')) continue;
        if (scope?.on && !conv.keyOk(scope, key)) continue;
        const device = s.device || e?.device || '';
        const tool = s.tool || e?.tool || '';
        segs.push({ date: d, device: labels[device] || device, tool: TOOL_LABEL[tool] || tool, summary: s.summary, status: s.status, first: s.first || '' });
      }
    }
    segs.sort((a, b) => b.date.localeCompare(a.date) || String(b.first).localeCompare(String(a.first)));
    const shown = segs.slice(0, SEG_MAX[rec.kind]);
    let open = [];
    if (rec.kind === 'handoff') {
      open = extras.todos({ project: rec.project, days: 30 }, scope).items.map((t) => ({
        date: t.date, device: labels[t.device] || t.device || '', tool: TOOL_LABEL[t.tool] || t.tool || '', summary: t.summary, status: t.status,
      }));
    }
    return { since, segs: shown, total: segs.length, open };
  }

  function render(rec, data) {
    const who = (s) => [s.device, s.tool].filter(Boolean).join(' · ');
    const item = (s) => `<li>${who(s) ? `<span class="who">${esc(who(s))}</span>` : ''}${STATUS[s.status] ? `<span class="st${s.status === 'blocked' ? ' bad' : ''}">${STATUS[s.status]}</span>` : ''}${esc(s.summary)}</li>`;
    const byDay = new Map();
    for (const s of data.segs) { if (!byDay.has(s.date)) byDay.set(s.date, []); byDay.get(s.date).push(s); }
    const days = (tag) => [...byDay.entries()].map(([d, xs]) => `<${tag}>${esc(d.slice(5))} ${weekday(d)}</${tag}><ul>${xs.map(item).join('')}</ul>`).join('');
    const parts = [];
    if (rec.kind === 'handoff' && data.open.length) parts.push(`<h2>还没收尾</h2><ul>${data.open.slice(0, 20).map((s) => `<li>${who(s) ? `<span class="who">${esc(`${s.date.slice(5)} · ${who(s)}`)}</span>` : ''}${STATUS[s.status] ? `<span class="st${s.status === 'blocked' ? ' bad' : ''}">${STATUS[s.status]}</span>` : ''}${esc(s.summary)}</li>`).join('')}</ul>`);
    if (data.segs.length) parts.push(rec.kind === 'handoff' ? `<h2>最近 ${WINDOW_DAYS.handoff} 天做了什么</h2>${days('h3')}` : days('h2'));
    const people = new Set(data.segs.map((s) => s.device).filter(Boolean));
    const meta = [`${data.since.slice(5)} 起`, `${data.segs.length} 段工作`, ...(rec.kind === 'handoff' && people.size ? [`参与 ${[...people].slice(0, 6).join('、')}`] : []), `链接到期 ${localMinute(Date.parse(rec.expires))}`];
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex, nofollow, noarchive"><meta name="referrer" content="no-referrer">
<title>${esc(rec.project)} · ${SHARE_KINDS[rec.kind]}</title><style>${CSS}</style></head>
<body><main><header><h1>${esc(rec.project)}</h1><span class="kind">${SHARE_KINDS[rec.kind]}</span></header>
<div class="meta">${meta.map((m) => `<span>${esc(m)}</span>`).join('')}</div>
${parts.join('') || '<div class="empty">这段时间没有工作日志</div>'}
</main></body></html>`;
  }

  // ---------------------------------------------------------------- 公开页 /s/<令牌>
  const fails = new Map(); // ip -> { t0, n }
  function clientIp(req) {
    // 经认证网关来的请求，真实地址在网关写的 X-AM-Peer-IP 里（暗号对得上才信）；直连就用连接的对端地址
    const gated = CFG.gate_secret && req.headers['x-am-gate'] === CFG.gate_secret;
    return String((gated && req.headers['x-am-peer-ip']) || req.socket.remoteAddress || '').replace(/^::ffff:/, '').slice(0, 60);
  }
  const limited = (ip) => { const f = fails.get(ip); return Boolean(f) && now() - f.t0 < RATE.windowMs && f.n >= RATE.fails; };
  function noteFail(ip) {
    const t = now();
    const f = fails.get(ip);
    if (!f || t - f.t0 >= RATE.windowMs) fails.set(ip, { t0: t, n: 1 }); else f.n++;
    if (fails.size > 5000) for (const [k, v] of fails) if (t - v.t0 >= RATE.windowMs) fails.delete(k);
  }
  function handle(req, res, url) {
    const ip = clientIp(req);
    const isHead = req.method === 'HEAD';
    const out = (status, body, extra) => { res.writeHead(status, { ...HEADERS, ...(extra || {}) }); res.end(isHead ? undefined : body); };
    if (limited(ip)) return out(429, TOO_MANY, { 'retry-after': '60' });
    const fail = () => { noteFail(ip); return out(404, NOT_FOUND); };
    if (req.method !== 'GET' && !isHead) return fail();
    const m = /^\/s\/([^/]+)\/?$/.exec(url.pathname);
    const rec = m ? byToken(m[1]) : null;
    if (!rec) return fail();
    const scope = ctx.scopeOf?.(rec.creator);
    if (scope?.on && !scope.project(rec.project)) return fail(); // 创建者现在看不到这个项目了：链接一并失效
    return out(200, render(rec, collect(rec)));
  }

  return { handle, create, list, get, revoke };
}
