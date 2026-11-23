/* 控制台管理接口，挂在 /console/api/ 下。
 *
 * - 身份校验和 /browse 一样（browseViewer）；通不过一律 403。
 * - 所有写操作记审计：usage.jsonl 里 op 为 console:<动作>。
 * - 出错返回 4xx 和中文 error；配置和令牌永远不返回（gate_secret、令牌哈希都不出现）。
 *
 * 接口一览（相对 /console/api/）：
 *   GET  devices            POST devices/<名字>     改策略
 *   POST join-code          生成加入码
 *   GET  mcp                POST mcp/tool           停用/启用 MCP 工具
 *   GET  jobs               后台工作的最近情况
 *   GET  settings           POST settings           白名单配置项
 *   GET  conv/search        GET  conv/<ref>         对话存档
 */

import fs from 'node:fs';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (message) => new HttpError(400, message);

const DAY = 86400e3;
const WRITE_TOOLS = new Set(['memory_remember', 'memory_update', 'memory_retire']);
const DEVICE_NAME = /^[A-Za-z0-9._-]{2,40}$/;
const DATE_ARG = /^(?:(\d{4})-(\d{2})-(\d{2})|(\d{1,2})-(\d{1,2})|今天|昨天)$/;
const DEFAULTS = { stale_hours: 3, auto_approve_days: 3, digest_budget: 13800 };

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
const intIn = (v, min, max, label) => {
  if (!isInt(v) || v < min || v > max) throw bad(`${label} 必须是 ${min}–${max} 之间的整数`);
  return v;
};
const strList = (v, label, { max = 100, len = 200 } = {}) => {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && x.trim())) throw bad(`${label} 必须是字符串数组（不能有空项）`);
  if (v.length > max) throw bad(`${label} 最多 ${max} 项`);
  const out = [...new Set(v.map((x) => x.trim()))];
  if (out.some((x) => x.length > len)) throw bad(`${label} 里每项最多 ${len} 个字`);
  return out;
};
const httpUrl = (v, label) => {
  let u;
  try { u = new URL(v); } catch { throw bad(`${label} 不是合法的地址`); }
  if (!/^https?:$/.test(u.protocol) || v.length > 300) throw bad(`${label} 必须是 http:// 或 https:// 开头的地址`);
  return v.replace(/\/+$/, '');
};

// 设置页开放的键：校验并规整值；allowNull 的键可以传 null 清掉，回到默认
const SETTINGS = {
  public_url: { check: (v) => httpUrl(v, 'public_url') },
  embed_url: { allowNull: true, check: (v) => { if (typeof v !== 'string') throw bad('embed_url 必须是字符串'); return v === '' ? '' : httpUrl(v, 'embed_url'); } },
  stale_hours: { allowNull: true, check: (v) => intIn(v, 1, 8760, 'stale_hours') },
  auto_approve_days: { allowNull: true, check: (v) => intIn(v, 0, 365, 'auto_approve_days') },
  digest_budget: { check: (v) => intIn(v, 1000, 200000, 'digest_budget') },
  auto_register_deny: {
    allowNull: true,
    check: (v) => {
      const list = strList(v, 'auto_register_deny');
      for (const re of list) { try { new RegExp(re, 'i'); } catch { throw bad(`auto_register_deny 里的「${re}」不是合法的正则`); } }
      return list;
    },
  },
  device_labels: {
    allowNull: true,
    check: (v) => {
      if (!isObj(v)) throw bad('device_labels 必须是 {设备名: 显示名} 对象');
      const out = {};
      for (const [k, label] of Object.entries(v)) {
        if (!DEVICE_NAME.test(k)) throw bad(`device_labels 里的设备名「${k}」不合法（只能用字母数字 . _ -）`);
        if (typeof label !== 'string' || !label.trim() || label.length > 40) throw bad(`device_labels 里「${k}」的显示名必须是 1–40 字的字符串`);
        out[k] = label.trim();
      }
      return out;
    },
  },
  graph_entities: {
    allowNull: true,
    check: (v) => {
      if (!isObj(v)) throw bad('graph_entities 必须是 {machine: [...], site: [...]} 对象');
      const out = {};
      for (const [k, list] of Object.entries(v)) {
        if (!['machine', 'site'].includes(k)) throw bad(`graph_entities 只能有 machine 和 site，不认识「${k}」`);
        out[k] = strList(list, `graph_entities.${k}`, { max: 200, len: 60 });
      }
      return out;
    },
  },
};

export function createAdmin(ctx) {
  const {
    CFG, CONFIG_PATH, readJSON, readJsonl, usageFile, logUsage, nowIso, readBody, send, UserError, browseViewer, loadTokens, peersFile,
    heartbeatFile, agentsOverview, watch, git, tools, store, conv, extras, pipe, deviceSet, newJoinCode,
  } = ctx;

  // ---- 配置读写：先写临时文件再改名，原文件留一份 .bak，并当场更新内存里的 CFG ----
  function saveConfig(changes) {
    let current = {};
    let mode = 0o600;
    let existed = false;
    try {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      existed = true;
      mode = fs.statSync(CONFIG_PATH).mode & 0o777;
      try { current = JSON.parse(raw); } catch { throw new HttpError(500, '配置文件不是合法的 JSON，为了不覆盖它，没有保存。先手工修好配置文件。'); }
      if (!isObj(current)) throw new HttpError(500, '配置文件的内容不是 JSON 对象，没有保存。');
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (e.code !== 'ENOENT') throw new HttpError(500, `读不了配置文件：${e.message}`);
    }
    const next = { ...current };
    for (const [k, v] of Object.entries(changes)) { if (v === undefined) delete next[k]; else next[k] = v; }
    const tmp = `${CONFIG_PATH}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode });
      if (existed) fs.copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.bak`);
      fs.renameSync(tmp, CONFIG_PATH);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw new HttpError(500, `保存配置失败：${e.message}`);
    }
    for (const [k, v] of Object.entries(changes)) { if (v === undefined) delete CFG[k]; else CFG[k] = v; }
  }

  const audit = (viewer, action, detail) => logUsage({ device: viewer, client: 'console' }, `console:${action}`, detail);

  // ---- devices ----
  function devices() {
    const hb = readJSON(heartbeatFile(), {});
    const peers = readJSON(peersFile(), {});
    const cells = Object.fromEntries(agentsOverview().devices.map((d) => [d.name, d.cells]));
    const labels = CFG.device_labels || {};
    const list = Object.entries(loadTokens().devices || {}).map(([name, d]) => ({
      name,
      label: labels[name] || '',
      role: d.role || 'device',
      identity: peers[name] || d.via === 'gateway' ? 'gateway' : d.via === 'join' ? 'join' : 'token',
      created: d.created || null,
      version: hb[name]?.agent_version || '',
      hostname: hb[name]?.hostname || '',
      os: peers[name]?.os || '',
      last_seen: hb[name]?.last_seen || null,
      agents: cells[name] || {},
      wiring: hb[name]?.wiring || {},
      policy: { readonly: Boolean(d.readonly), hide_projects: d.hide_projects || [], paused: Boolean(d.paused), stale_hours: d.stale_hours || null },
    }));
    return { default_stale_hours: CFG.stale_hours || DEFAULTS.stale_hours, devices: list };
  }

  function setDevice(name, body, viewer) {
    if (!loadTokens().devices?.[name]) throw new HttpError(404, `没有设备 ${name}`);
    if (!isObj(body)) throw bad('请求体必须是 JSON 对象');
    const changes = {};
    for (const [k, v] of Object.entries(body)) {
      if (k === 'stale_hours') changes[k] = v === null ? null : intIn(v, 1, 8760, 'stale_hours');
      else if (k === 'readonly' || k === 'paused') {
        if (typeof v !== 'boolean') throw bad(`${k} 必须是 true 或 false`);
        changes[k] = v;
      } else if (k === 'hide_projects') changes[k] = strList(v, 'hide_projects', { max: 100, len: 60 });
      else throw bad(`不认识的字段 ${k}（可改：readonly、hide_projects、paused、stale_hours）`);
    }
    if (!Object.keys(changes).length) throw bad('没有要改的字段');
    const policy = deviceSet(name, changes);
    audit(viewer, 'device-set', `${name} ${Object.keys(changes).join(',')}`);
    return { ok: true, name, policy };
  }

  function joinCode(body, viewer) {
    const days = body?.days === undefined ? 7 : intIn(body.days, 1, 90, 'days');
    const j = newJoinCode(days);
    audit(viewer, 'join-code', `${days} 天`);
    return j;
  }

  // ---- mcp ----
  const disabledList = () => (Array.isArray(CFG.disabled_tools) ? CFG.disabled_tools : []);

  function mcp() {
    const all = readJsonl(usageFile(), 0).filter((u) => u.op.startsWith('tool:'));
    const since = Date.now() - 7 * DAY;
    const stat = {};
    for (const u of all) {
      const s = (stat[u.op.slice(5)] ||= { calls: 0, last: null });
      if (Date.parse(u.t) >= since) s.calls++;
      if (!s.last || u.t > s.last) s.last = u.t;
    }
    const off = new Set(disabledList());
    return {
      http: `${CFG.public_url}/mcp`,
      stdio: 'node kb-agent.mjs mcp --client <智能体名>',
      tools: tools().map((t) => ({
        name: t.name, description: t.description || '', kind: WRITE_TOOLS.has(t.name) ? 'write' : 'read',
        calls_7d: stat[t.name]?.calls || 0, last_call: stat[t.name]?.last || null, disabled: off.has(t.name),
      })),
    };
  }

  function setTool(body, viewer) {
    if (!isObj(body)) throw bad('请求体必须是 JSON 对象');
    if (typeof body.name !== 'string' || !tools().some((t) => t.name === body.name)) throw bad(`未知的工具：${typeof body.name === 'string' ? body.name : '（没给 name）'}`);
    if (typeof body.disabled !== 'boolean') throw bad('disabled 必须是 true 或 false');
    const set = new Set(disabledList());
    if (body.disabled) set.add(body.name); else set.delete(body.name);
    const list = [...set];
    saveConfig({ disabled_tools: list.length ? list : undefined });
    audit(viewer, 'mcp-tool', `${body.name} ${body.disabled ? '停用' : '启用'}`);
    return { ok: true, name: body.name, disabled: body.disabled, disabled_tools: list };
  }

  // ---- jobs ----
  async function jobs() {
    const hb = readJSON(heartbeatFile(), {});
    const syncDevices = Object.entries(loadTokens().devices || {}).filter(([, d]) => (d.role || 'device') === 'device').map(([name, d]) => {
      const seen = hb[name]?.last_seen || null;
      const limit = d.stale_hours || CFG.stale_hours || DEFAULTS.stale_hours;
      const paused = Boolean(d.paused);
      return { name, last_seen: seen, stale_hours: limit, paused, stale: !paused && (!seen || (Date.now() - Date.parse(seen)) / 3600e3 > limit) };
    });
    const cs = conv().stats();
    const autos = readJsonl(`${CFG.state}/auto-approve.jsonl`, 0);
    let last_commit = null;
    try {
      const [time, author, ...subject] = (await git('log', '-1', '--format=%cI%x09%an%x09%s')).stdout.trim().split('\t');
      if (time) last_commit = { time, author, subject: subject.join('\t') };
    } catch { /* 还没有提交 */ }
    return {
      now: nowIso(),
      sync: {
        devices: syncDevices,
        stale_count: syncDevices.filter((d) => d.stale).length,
        last_seen: syncDevices.map((d) => d.last_seen).filter(Boolean).sort().pop() || null,
      },
      extract: {
        ...pipe().stats(),
        proposed: [...store.values()].filter((e) => e.meta.state === 'proposed').length,
        last_auto_approve: autos.length ? autos[autos.length - 1].t : null,
      },
      journal: {
        pending: cs.journal_pending, last_result: cs.last_journal, days: cs.journal_days,
        today_segments: cs.today_segments, yesterday_segments: cs.yesterday_segments,
      },
      vectors: extras().semanticStatus(),
      archive: { mounted: cs.mounted, sessions: cs.sessions, chars: cs.chars },
      repo: { last_commit },
      watch: { problems: watch() },
    };
  }

  // ---- settings ----
  const settingsView = () => ({
    settings: Object.fromEntries(Object.keys(SETTINGS).map((k) => [k, CFG[k] === undefined ? null : CFG[k]])),
    defaults: DEFAULTS,
  });

  function setSettings(body, viewer) {
    if (!isObj(body)) throw bad('请求体必须是 JSON 对象');
    const keys = Object.keys(body);
    if (!keys.length) throw bad('没有要改的设置');
    const unknown = keys.filter((k) => !SETTINGS[k]);
    if (unknown.length) throw bad(`不能通过这里修改：${unknown.join('、')}（可改：${Object.keys(SETTINGS).join('、')}）`);
    const changes = {};
    for (const k of keys) {
      const rule = SETTINGS[k];
      if (body[k] === null) {
        if (!rule.allowNull) throw bad(`${k} 不能清空`);
        changes[k] = undefined;
      } else changes[k] = rule.check(body[k]);
    }
    saveConfig(changes);
    audit(viewer, 'settings', keys.join(','));
    return { ok: true, ...settingsView() };
  }

  // ---- conv ----
  function dateArg(q, name) {
    const v = q.get(name);
    if (v === null || v === '') return undefined;
    const m = DATE_ARG.exec(v);
    if (!m) throw bad(`${name} 的格式不对：用 2026-11-20、11-20、今天 或 昨天`);
    if (m[1]) {
      const d = new Date(`${v}T00:00:00Z`);
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw bad(`${name} 不是有效的日期`);
    } else if (m[4] && (+m[4] < 1 || +m[4] > 12 || +m[5] < 1 || +m[5] > 31)) throw bad(`${name} 不是有效的日期`);
    return v;
  }
  const roleArg = (q) => {
    const v = q.get('role');
    if (!v) return undefined;
    if (v !== 'user' && v !== 'assistant') throw bad('role 只能是 user 或 assistant');
    return v;
  };
  const mountedOrFail = () => { if (!conv().mounted()) throw new HttpError(503, '对话存档盘没挂上，暂时查不了。'); };

  function convSearch(q) {
    const query = (q.get('q') || '').trim();
    if (!query) throw bad('请给关键词（q，空格分隔，全部命中）');
    let limit;
    if (q.get('limit') !== null) {
      limit = Number(q.get('limit'));
      if (!isInt(limit) || limit < 1 || limit > 30) throw bad('limit 必须是 1–30 之间的整数');
    }
    mountedOrFail();
    return conv().searchData({ query, device: q.get('device') || '', tool: q.get('tool') || '', from: dateArg(q, 'from'), to: dateArg(q, 'to'), role: roleArg(q), limit });
  }

  function convGet(ref, q) {
    const date = dateArg(q, 'date');
    const role = roleArg(q);
    let from;
    if (q.get('from') !== null && q.get('from') !== '') {
      from = Number(q.get('from'));
      if (!isInt(from) || from < 1) throw bad('from 必须是正整数');
    }
    mountedOrFail();
    const r = conv().getData({ ref, date, role, from, full: q.get('full') === '1' || q.get('full') === 'true' });
    if (r.error) throw new HttpError(404, '没有这个会话');
    return r;
  }

  // ---- 路由 ----
  async function handle(req, res, url) {
    try {
      const viewer = browseViewer(req);
      if (!viewer) throw new HttpError(403, '只有已经接入共享记忆的机器能用控制台（按 Tailscale 或虚拟机身份认，或者配置 console_viewer）。');
      const sub = url.pathname.slice('/console/api/'.length).replace(/\/+$/, '');
      const q = url.searchParams;
      const method = req.method;
      const only = (m) => { if (method !== m) throw new HttpError(405, `这个接口只支持 ${m}`); };
      let m;
      if (sub === 'devices') { only('GET'); return send(res, 200, devices()); }
      if ((m = /^devices\/([^/]+)$/.exec(sub))) { only('POST'); return send(res, 200, setDevice(decodeURIComponent(m[1]), await readBody(req), viewer)); }
      if (sub === 'join-code') { only('POST'); return send(res, 200, joinCode(await readBody(req), viewer)); }
      if (sub === 'mcp') { only('GET'); return send(res, 200, mcp()); }
      if (sub === 'mcp/tool') { only('POST'); return send(res, 200, setTool(await readBody(req), viewer)); }
      if (sub === 'jobs') { only('GET'); return send(res, 200, await jobs()); }
      if (sub === 'settings') {
        if (method === 'GET') return send(res, 200, settingsView());
        only('POST');
        return send(res, 200, setSettings(await readBody(req), viewer));
      }
      if (sub === 'conv/search') { only('GET'); return send(res, 200, convSearch(q)); }
      if ((m = /^conv\/([A-Za-z0-9._:-]{1,200})$/.exec(sub))) { only('GET'); return send(res, 200, convGet(m[1], q)); }
      throw new HttpError(404, '没有这个接口');
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      if (e instanceof UserError) return send(res, 400, { error: e.message });
      throw e;
    }
  }

  return { handle };
}
