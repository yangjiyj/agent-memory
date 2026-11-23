/* 控制台管理接口，挂在 /console/api/ 下。
 *
 * - 身份校验和 /browse 一样（browseViewer）；通不过一律 403。
 * - 所有写操作记审计：usage.jsonl 里 op 为 console:<动作>。
 * - 出错返回 4xx 和中文 error；配置和令牌永远不返回（gate_secret、令牌哈希都不出现）。
 *
 * 接口一览（相对 /console/api/）：
 *   GET  devices            POST devices/<名字>     改策略
 *   POST join-code          生成加入码（days 0 = 长期有效）
 *   GET  join-codes         还在生效的加入码（不含码本身）
 *   POST join-code/revoke   作废一个加入码
 *   GET  mcp                POST mcp/tool           停用/启用 MCP 工具
 *   GET  jobs               后台工作的最近情况
 *   GET  topology           拓扑页的全部数据（设备、网关、中心、存储、抽取机、向量服务、巡检问题，以及近 24 小时读写流量）
 *   GET  topology/events    拓扑页的事件流：?since=<ISO>&limit=<n，默认 30，最多 100>&project=<项目名，只给这个项目的对话>
 *   GET  settings           POST settings           白名单配置项
 *   GET  conv/search        GET  conv/<ref>         对话存档
 *   GET  shares             POST shares             只读分享链接：列出 / 生成（项目时间线或交接包，有效期 1/7/30 天）
 *   POST shares/revoke      作废一个分享链接（见 admin-access.mjs）
 *
 * 浏览者那台设备设了 hide_projects 时，上面各接口都不给被隐藏项目的内容（口径见 server.mjs 的 scopeOf，和 MCP 工具里的 visible() 一致）；
 * 这样的浏览者也不能改任何设备的 hide_projects（否则自己清掉就绕过去了）。
 *   GET  boot               首屏汇总：?page=<页面 id>，一次返回外壳启动和该页首屏要的 GET 数据 { prime: { "<URL>": 内容 } }（清单见 perf.mjs）
 */

import fs from 'node:fs';
import { bootPlan } from './perf.mjs';
// 各功能的接口放在自己的 admin-<名字>.mjs 里，在这里 import；每组只改自己那一行（占位行之间隔着空行，合并时互不冲突）
// [B] import 位
//
// [C] import 位
import { createInsight } from './admin-insight.mjs';
//
// [D] import 位
//
// [E] import 位
import { createSearch } from './admin-search.mjs';
//
import { createAccess } from './admin-access.mjs'; // [F] import 位

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
  // 问我的记忆（OpenAI 兼容的对话接口）：地址可以是接口根（…/v1）也可以是完整的 …/chat/completions；空串等于清除
  ask_url: {
    allowNull: true,
    check: (v) => {
      if (typeof v !== 'string') throw bad('ask_url 必须是字符串');
      if (!v.trim()) return undefined;
      const u = httpUrl(v.trim(), 'ask_url');
      const parsed = new URL(u);
      if (parsed.username || parsed.password) throw bad('ask_url 里不要带账号密码，密钥填在 ask_key');
      return u;
    },
  },
  ask_model: {
    allowNull: true,
    check: (v) => {
      if (typeof v !== 'string') throw bad('ask_model 必须是字符串');
      if (v.trim().length > 80) throw bad('ask_model 最长 80 个字');
      return v.trim() || undefined;
    },
  },
  // secret：只写不读。GET /settings 里不给值，只给 ask_key_set；错误信息、审计里也不回显
  ask_key: {
    allowNull: true,
    secret: true,
    check: (v) => {
      if (typeof v !== 'string' || !v.trim()) throw bad('ask_key 必须是非空字符串（要清除请传 null）');
      if (v.trim().length > 300) throw bad('ask_key 最长 300 个字符');
      return v.trim();
    },
  },
};

export function createAdmin(ctx) {
  const {
    CFG, CONFIG_PATH, readJSON, readJsonl, usageFile, logUsage, nowIso, readBody, send, UserError, browseViewer, loadTokens, peersFile,
    heartbeatFile, agentsOverview, watch, git, tools, store, conv, extras, pipe, deviceSet, newJoinCode, VERSION, agentVersion,
    redactSecrets, lastRequest, usageTail,
  } = ctx;
  const { listJoinCodes, revokeJoinCode, scopeOf } = ctx;

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
      if (existed) {
        fs.copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.bak`);
        fs.chmodSync(`${CONFIG_PATH}.bak`, mode); // .bak 是上一版配置，里面有明文密钥：权限必须和配置文件一致（.bak 已存在时 copyFile 不一定改权限）
      }
      fs.renameSync(tmp, CONFIG_PATH);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw new HttpError(500, `保存配置失败：${e.message}`);
    }
    for (const [k, v] of Object.entries(changes)) { if (v === undefined) delete CFG[k]; else CFG[k] = v; }
  }

  const audit = (viewer, action, detail) => logUsage({ device: viewer, client: 'console' }, `console:${action}`, detail);

  // ---- devices ----
  // 各设备的 hide_projects：限制可见范围的浏览者只看到自己也看得到的项目名
  const hideList = (d, scope) => (d.hide_projects || []).filter((x) => !scope?.on || scope.project(x));
  function devices(scope) {
    const hb = readJSON(heartbeatFile(), {});
    const peers = readJSON(peersFile(), {});
    const cells = Object.fromEntries(agentsOverview(scope).devices.map((d) => [d.name, d.cells]));
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
      policy: { readonly: Boolean(d.readonly), hide_projects: hideList(d, scope), paused: Boolean(d.paused), stale_hours: d.stale_hours || null },
    }));
    return { default_stale_hours: CFG.stale_hours || DEFAULTS.stale_hours, devices: list };
  }

  function setDevice(name, body, viewer, scope) {
    if (!loadTokens().devices?.[name]) throw new HttpError(404, `没有设备 ${name}`);
    if (!isObj(body)) throw bad('请求体必须是 JSON 对象');
    const changes = {};
    for (const [k, v] of Object.entries(body)) {
      if (k === 'stale_hours') changes[k] = v === null ? null : intIn(v, 1, 8760, 'stale_hours');
      else if (k === 'readonly' || k === 'paused') {
        if (typeof v !== 'boolean') throw bad(`${k} 必须是 true 或 false`);
        changes[k] = v;
      } else if (k === 'hide_projects') {
        if (scope?.on) throw new HttpError(403, '这台机器的可见范围受限，不能修改隐藏项目。');
        changes[k] = strList(v, 'hide_projects', { max: 100, len: 60 });
      }
      else throw bad(`不认识的字段 ${k}（可改：readonly、hide_projects、paused、stale_hours）`);
    }
    if (!Object.keys(changes).length) throw bad('没有要改的字段');
    const policy = deviceSet(name, changes);
    audit(viewer, 'device-set', `${name} ${Object.keys(changes).join(',')}`);
    return { ok: true, name, policy: scope?.on ? { ...policy, hide_projects: hideList(policy, scope) } : policy };
  }

  function joinCode(body, viewer) {
    const days = body?.days === undefined ? 7 : intIn(body.days, 0, 90, 'days');
    const j = newJoinCode(days);
    audit(viewer, 'join-code', days ? `${days} 天` : '长期');
    return j;
  }

  function revokeCode(body, viewer) {
    const id = body?.id;
    if (typeof id !== 'string' || !/^[0-9a-f]{12}$/.test(id)) throw bad('id 不对');
    if (!revokeJoinCode(id)) throw new HttpError(404, '这个加入码已经失效或不存在');
    audit(viewer, 'join-revoke', id);
    return { ok: true };
  }

  // ---- mcp ----
  const disabledList = () => (Array.isArray(CFG.disabled_tools) ? CFG.disabled_tools : []);

  // 近 7 天的耗时（毫秒）和失败率。分位数用最近秩法：排好序取第 ceil(p×n) 个；失败率的分母只算带 dur 的新记录，没有就是 null
  const rank = (sorted, p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
  function latency(s) {
    const d = (s?.dur || []).slice().sort((a, b) => a - b);
    return {
      timed_7d: d.length, p50_ms: d.length ? rank(d, 0.5) : null, p95_ms: d.length ? rank(d, 0.95) : null,
      judged_7d: d.length, errors_7d: s?.errs || 0, err_rate: d.length ? s.errs / d.length : null,
    };
  }

  function mcp() {
    const all = readJsonl(usageFile(), 0).filter((u) => u.op.startsWith('tool:'));
    const since = Date.now() - 7 * DAY;
    const stat = {};
    for (const u of all) {
      const s = (stat[u.op.slice(5)] ||= { calls: 0, last: null, dur: [], errs: 0 });
      if (Date.parse(u.t) >= since) {
        s.calls++;
        if (Number.isFinite(u.dur)) { s.dur.push(u.dur); if (u.err) s.errs++; } // 带 dur 的新记录才有耗时，也才知道成没成功
      }
      if (!s.last || u.t > s.last) s.last = u.t;
    }
    const off = new Set(disabledList());
    return {
      http: `${CFG.public_url}/mcp`,
      stdio: 'node kb-agent.mjs mcp --client <智能体名>',
      tools: tools().map((t) => ({
        name: t.name, description: t.description || '', kind: WRITE_TOOLS.has(t.name) ? 'write' : 'read',
        calls_7d: stat[t.name]?.calls || 0, last_call: stat[t.name]?.last || null, disabled: off.has(t.name),
        ...latency(stat[t.name]),
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
  async function jobs(scope) {
    const hb = readJSON(heartbeatFile(), {});
    const syncDevices = Object.entries(loadTokens().devices || {}).filter(([, d]) => (d.role || 'device') === 'device').map(([name, d]) => {
      const seen = hb[name]?.last_seen || null;
      const limit = d.stale_hours || CFG.stale_hours || DEFAULTS.stale_hours;
      const paused = Boolean(d.paused);
      return { name, last_seen: seen, stale_hours: limit, paused, stale: !paused && (!seen || (Date.now() - Date.parse(seen)) / 3600e3 > limit) };
    });
    const cs = conv().stats(scope);
    const autos = readJsonl(`${CFG.state}/auto-approve.jsonl`, 0);
    let last_commit = null;
    try {
      const [time, author, ...subject] = (await git('log', '-1', '--format=%cI%x09%an%x09%s')).stdout.trim().split('\t');
      // 提交说明里带着记忆的标题（remember(类型): 标题 / update: 标题 / retire: 标题），限制可见范围的浏览者只给动作
      const subj = subject.join('\t');
      if (time) last_commit = { time, author, subject: scope?.on ? subj.replace(/^((?:remember\([a-z]+\)|update|retire)):[\s\S]*$/, '$1') : subj };
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

  // usage.jsonl 的近 8 天由 server.mjs 的 usageTail() 增量缓存；每行带 ms（毫秒时间戳）和 at（文件里的字节位置，当事件 id）
  const usageRows = usageTail;

  // 读取类 / 写入类：tool:memory_remember、cli:remember 这类算写入，其余 tool:*、cli:* 都算读取
  const isCall = (op) => op.startsWith('tool:') || op.startsWith('cli:');
  const isWrite = (op) => /^(tool|cli):(memory_)?(remember|update|retire)$/.test(op);

  // ---- topology ----
  // 一次给齐拓扑页要的数据：设备和任务状态直接复用 devices()、jobs()，这里只补中心、网关、令牌角色、浏览者和读写流量。
  const LIVE_MS = 20 * 60e3; // 20 分钟内有新对话算"正在干活"
  const hotAgent = (a) => a.sessions || a.memories || a.calls;

  // 近 24 小时每台设备的读写流量。
  // 上行 up = 写入量 = 对话存档里新增的消息数 + remember/update/retire 的调用次数（两者都是"设备往中心送了东西"）；
  // 下行 down = 读取类调用次数（search/get/timeline/todos/handoff/entities/conversation_*/kb_* 等）；
  // hours 是上行同口径按小时分的 24 格（最旧在前，最后一格是最近一小时），所以 sum(hours) === up_24h。
  function flows(now, scope) {
    const from = now - DAY;
    const bucket = (ms) => Math.min(23, Math.max(0, Math.floor((ms - from) / 3600e3)));
    const out = {};
    const of = (dev) => (out[dev] ||= { up_24h: 0, down_24h: 0, hours: Array(24).fill(0), agents: {} });
    const ag = (f, tool) => (f.agents[tool] ||= { up_24h: 0, down_24h: 0 });
    for (const [dev, tools] of Object.entries(conv().recentMessages(from, scope))) {
      const f = of(dev);
      for (const [tool, xs] of Object.entries(tools)) {
        for (const ms of xs) { if (ms > now) continue; f.up_24h++; f.hours[bucket(ms)]++; ag(f, tool).up_24h++; }
      }
    }
    const rows = usageRows();
    for (let i = rows.length - 1; i >= 0; i--) { // 行按时间追加，从尾往前读，出了 24 小时就停
      const u = rows[i];
      if (u.ms < from) break;
      if (u.ms > now || !isCall(u.op)) continue;
      const f = of(u.device);
      if (isWrite(u.op)) { f.up_24h++; f.hours[bucket(u.ms)]++; ag(f, u.client).up_24h++; } else { f.down_24h++; ag(f, u.client).down_24h++; }
    }
    return out;
  }

  async function topology(viewer, req) {
    const scope = scopeOf(viewer);
    const dv = devices(scope);
    const jb = await jobs(scope);
    const stale = Object.fromEntries(jb.sync.devices.map((d) => [d.name, d.stale]));
    const hb = readJSON(heartbeatFile(), {});
    const now = Date.now();
    const fl = flows(now, scope);
    const hubFlow = { up_24h: 0, down_24h: 0 };

    const list = dv.devices.filter((d) => d.role === 'device').map((d) => {
      const f = fl[d.name] || { up_24h: 0, down_24h: 0, hours: Array(24).fill(0), agents: {} };
      hubFlow.up_24h += f.up_24h; hubFlow.down_24h += f.down_24h;
      const agents = Object.keys({ ...d.wiring, ...d.agents }).filter((k) => {
        if (k === 'cli' || k === 'test') return false;
        const a = d.agents[k];
        return d.wiring[k] || (a && hotAgent(a));
      }).map((k) => {
        const last = d.agents[k]?.lastMsg || null;
        return { tool: k, last_msg: last, live: Boolean(last) && now - Date.parse(last) < LIVE_MS, up_24h: f.agents[k]?.up_24h || 0, down_24h: f.agents[k]?.down_24h || 0 };
      });
      const lastMsg = agents.map((a) => a.last_msg).filter(Boolean).sort().pop() || null;
      return {
        name: d.name, label: d.label, identity: d.identity, version: d.version, last_seen: d.last_seen,
        stale: Boolean(stale[d.name]), paused: d.policy.paused, readonly: d.policy.readonly,
        live: agents.some((a) => a.live), last_msg: lastMsg, agents,
        flow: { up_24h: f.up_24h, down_24h: f.down_24h, hours: f.hours },
      };
    });

    // 调用次数和各令牌最近一次调用
    const since7 = now - 7 * DAY;
    let calls7 = 0;
    const lastCall = {};
    for (const u of usageRows()) {
      if (isCall(u.op)) {
        if (u.ms >= since7) calls7++;
        if (!lastCall[u.device] || u.t > lastCall[u.device]) lastCall[u.device] = u.t;
      }
    }
    // 抽取机和报表的令牌不发心跳：最近活动取"令牌最近一次请求、心跳、回退值"里最新的；
    // 回退值：抽取机看最近一次抽取/写日志，报表看最近一次工具调用
    const extractorLast = [jb.extract.last_processed, jb.journal.last_result].filter(Boolean).sort().pop() || null;
    const byRole = (role, fallback) => Object.entries(loadTokens().devices || {}).filter(([, d]) => d.role === role).map(([name]) => {
      const last = lastRequest(name);
      return {
        name, label: (CFG.device_labels || {})[name] || '',
        last_active: [last?.t, hb[name]?.last_seen, fallback(name)].filter(Boolean).sort().pop() || null,
        last_op: last?.op || null,
      };
    });

    // 近 7 天各项目的参与者，只留还在设备列表里的；最多 12 个项目
    const known = new Set(list.map((d) => d.name));
    const projects = conv().projectMembers(7, scope).map((p) => {
      const members = p.members.filter((m) => known.has(m.device));
      return { name: p.name, sessions: members.reduce((a, m) => a + m.sessions, 0), last: members[0]?.last || p.last, members };
    }).filter((p) => p.members.length).slice(0, 12);

    const secret = Boolean(CFG.gate_secret);
    return {
      now: nowIso(),
      hub: {
        version: VERSION, agent_version: agentVersion(), public_url: CFG.public_url || '', calls_7d: calls7,
        memories: [...store.values()].filter((e) => e.meta.state === 'active' && scope.entry(e)).length,
        up_24h: hubFlow.up_24h, down_24h: hubFlow.down_24h,
      },
      gate: { enabled: secret, devices: secret ? list.filter((d) => d.identity === 'gateway').length : 0 },
      devices: list,
      projects,
      storage: { repo: { entries: scope.on ? [...store.values()].filter((e) => scope.entry(e)).length : store.size, last_commit: jb.repo.last_commit }, archive: jb.archive },
      extractors: byRole('extractor', () => extractorLast),
      reporters: byRole('reporter', (name) => lastCall[name] || null),
      pending: { sessions: jb.extract.pending, errors: jb.extract.error, journal: jb.journal.pending, proposed: jb.extract.proposed },
      vectors: jb.vectors,
      problems: jb.watch.problems,
      viewer: { device: viewer, via: secret && req.headers['x-am-gate'] === CFG.gate_secret ? 'gateway' : 'config' },
    };
  }

  // ---- topology/events ----
  // 事件流：usage.jsonl 的尾部（读写、报表、抽取、控制台操作）加上对话存档里最近有新消息的会话。
  // 浏览者设了 hide_projects 时：对话事件按会话归属的项目过滤（不给被隐藏项目的会话、也不接受 project=被隐藏项目）；
  // 调用记录里的细节（查询词、标题）归不到项目，这样的浏览者只看到"查了记忆""写了一条记忆"，不带引号里的内容。
  const short = (v, n = 40) => { const t = String(v || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
  const READ_TEXT = {
    search: '查了记忆', get: '读了一条记忆', timeline: '看了时间线', todos: '看了待办', handoff: '生成了交接包', entities: '查了实体',
    recent: '看了最近的记忆', digest: '取了记忆摘要', conversation_search: '搜了对话', conversation_get: '读了一段对话',
  };
  const WRITE_TEXT = { remember: '写了一条记忆', update: '更新了一条记忆', retire: '作废了一条记忆' };
  const CONSOLE_TEXT = {
    'console:settings': '改了设置', 'console:device-set': '改了设备策略', 'console:join-code': '生成了加入码', 'console:mcp-tool': '开关了 MCP 工具',
    'manage:approve': '通过了候选记忆', 'manage:reject': '驳回了候选记忆', 'manage:retire': '作废了记忆', 'manage:merge': '合并了记忆',
  };
  const REPORT_TEXT = { report: '拉了日报', weekly: '拉了周报' };
  const EXTRACT_TEXT = { session: '抽取了一个会话', journal: '写了一段工作日志' };
  const withD = (base, d, quote) => { const t = short(redactSecrets(d || '')); return t && quote ? `${base}「${t}」` : base; };

  function eventOf(u, plain) {
    const id = `u${u.at}`;
    const mk = (kind, text, tool) => ({ id, t: new Date(u.ms).toISOString(), kind, device: u.device, tool: tool || null, text });
    if (isCall(u.op)) {
      const name = u.op.replace(/^(tool|cli):/, '').replace(/^memory_/, '');
      if (isWrite(u.op)) return mk('write', withD(WRITE_TEXT[name], u.d, name === 'remember' && !plain), u.client);
      const quote = !plain && ['search', 'conversation_search', 'entities'].includes(name);
      return mk('read', withD(READ_TEXT[name] || (name.startsWith('kb_') ? '查了知识卡片' : '读了记忆'), u.d, quote), u.client);
    }
    if (u.op.startsWith('report:')) return mk('report', REPORT_TEXT[u.op.slice(7)] || '拉了报表');
    if (u.op.startsWith('extract:')) return mk('extract', EXTRACT_TEXT[u.op.slice(8)] || '处理了数据');
    if (u.op.startsWith('console:') || u.op.startsWith('manage:')) return mk('console', CONSOLE_TEXT[u.op] || '在控制台做了管理操作');
    return null;
  }

  function events(q, scope) {
    let since = null;
    if (q.get('since')) {
      since = Date.parse(q.get('since'));
      if (!Number.isFinite(since)) throw bad('since 不是合法的时间（用 ISO 格式，如 2026-11-23T08:00:00Z）');
    }
    let limit = 30;
    if (q.get('limit') !== null) {
      limit = Number(q.get('limit'));
      if (!isInt(limit) || limit < 1 || limit > 100) throw bad('limit 必须是 1–100 之间的整数');
    }
    const project = q.get('project');
    if (project !== null && !/^[a-z0-9][a-z0-9._-]{0,40}$/.test(project)) throw bad('project 不是合法的项目名');
    if (project !== null && !scope.project(project)) return { now: nowIso(), events: [] };
    const now = Date.now();
    const floor = Math.max(since ?? 0, now - DAY); // 最多回看 24 小时
    const out = [];
    // 从文件尾往前读，够 limit 条就停（合并后的最新 limit 条一定在两个来源各自的最新 limit 条里）；行在文件里按时间追加
    const rows = usageRows();
    for (let i = rows.length - 1; i >= 0 && out.length < limit && !project; i--) { // 调用记录里没有项目，按项目看时只给对话
      const u = rows[i];
      if (u.ms > now + 60e3) continue;
      if (u.ms <= floor) break;
      const e = eventOf(u, scope.on);
      if (e) out.push(e);
    }
    // 对话：一个会话一条，时间取它最近一条消息；同一会话之后又有新消息会换一个 id（带着时间）
    for (const s of conv().recentSessions(floor, scope)) {
      if (project && s.project !== project) continue;
      out.push({ id: `c${s.ref}:${Date.parse(s.last)}`, t: s.last, kind: 'talk', device: s.device, tool: s.tool, text: s.project ? `在 ${short(s.project)} 有新对话` : '有新对话', ...(s.project ? { project: s.project } : {}) });
    }
    out.sort((a, b) => Date.parse(a.t) - Date.parse(b.t) || (a.id < b.id ? -1 : 1));
    return { now: nowIso(), events: out.slice(-limit) };
  }

  // ---- settings ----
  // secret 的键（ask_key）永远不返回值，只给 <键>_set 表示有没有设置
  const settingsView = () => ({
    settings: {
      ...Object.fromEntries(Object.keys(SETTINGS).filter((k) => !SETTINGS[k].secret).map((k) => [k, CFG[k] === undefined ? null : CFG[k]])),
      ...Object.fromEntries(Object.keys(SETTINGS).filter((k) => SETTINGS[k].secret).map((k) => [`${k}_set`, Boolean(CFG[k])])),
    },
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

  function convSearch(q, scope) {
    const query = (q.get('q') || '').trim();
    if (!query) throw bad('请给关键词（q，空格分隔，全部命中）');
    let limit;
    if (q.get('limit') !== null) {
      limit = Number(q.get('limit'));
      if (!isInt(limit) || limit < 1 || limit > 30) throw bad('limit 必须是 1–30 之间的整数');
    }
    mountedOrFail();
    return conv().searchData({ query, device: q.get('device') || '', tool: q.get('tool') || '', from: dateArg(q, 'from'), to: dateArg(q, 'to'), role: roleArg(q), limit }, scope);
  }

  function convGet(ref, q, scope) {
    const date = dateArg(q, 'date');
    const role = roleArg(q);
    let from;
    if (q.get('from') !== null && q.get('from') !== '') {
      from = Number(q.get('from'));
      if (!isInt(from) || from < 1) throw bad('from 必须是正整数');
    }
    mountedOrFail();
    const r = conv().getData({ ref, date, role, from, full: q.get('full') === '1' || q.get('full') === 'true' }, scope);
    if (r.error) throw new HttpError(404, '没有这个会话');
    return r;
  }

  // ---- boot ----
  // 首屏汇总：外壳启动要的和该页首屏要的 GET 数据一次返回，省掉一串请求（清单见 perf.mjs 的 BOOT_SHELL / BOOT_PAGES）。
  // 每一项都经 internalGet 走和浏览器单独请求时同一套路由：身份校验、返回字段都一样，别的接口加了字段这里自动跟上；
  // 取失败的项直接略过，页面照常自己再取。清单是服务端写死的，客户端不能指定要取什么。
  async function boot(req, q) {
    const plan = bootPlan(q.get('page') || '');
    const got = await Promise.all(plan.map(async (u) => [u, await ctx.internalGet(req, u)]));
    return { prime: Object.fromEntries(got.filter(([, r]) => r.status === 200).map(([u, r]) => [u, r.body])) };
  }

  // ---- 扩展接口 ----
  // 每个 admin-<名字>.mjs 导出 createXxx(ctx, kit)，返回 { handle(req, res, url, sub, viewer) }：认领了这个请求就返回 true，否则返回 undefined。
  // kit 里是核心的小工具；出错抛 kit.HttpError / kit.bad，由下面的 handle 统一变成 4xx 和中文 error。
  // visibleTo(viewer, project)：浏览者按 hide_projects 能不能看这个项目（没有项目的内容都可见）；hiddenOf(viewer)：被隐藏的项目名（小写）
  // scopeOf(viewer)：一次取好浏览者的可见范围（{ on, project(p), entry(e), session(key) }），循环里用它，别在循环里反复调 visibleTo
  const kit = { HttpError, bad, isObj, isInt, intIn, strList, httpUrl, audit, saveConfig, DAY, visibleTo: ctx.visibleTo, hiddenOf: ctx.hiddenOf, scopeOf: ctx.scopeOf };
  const exts = [
    // [B] 扩展位
    //
    // [C] 扩展位
    createInsight(ctx, kit),
    //
    // [D] 扩展位
    //
    // [E] 扩展位
    createSearch(ctx, kit),
    //
    createAccess(ctx, kit), // [F] 扩展位
  ];

  // ---- 路由 ----
  async function handle(req, res, url) {
    try {
      const viewer = browseViewer(req);
      if (!viewer) throw new HttpError(403, '只有已经接入共享记忆的机器能用控制台（按 Tailscale 或虚拟机身份认，或者配置 console_viewer）。');
      const sub = url.pathname.slice('/console/api/'.length).replace(/\/+$/, '');
      const q = url.searchParams;
      const scope = scopeOf(viewer);
      const method = req.method;
      const only = (m) => { if (method !== m) throw new HttpError(405, `这个接口只支持 ${m}`); };
      let m;
      if (sub === 'devices') { only('GET'); return send(res, 200, devices(scope)); }
      if ((m = /^devices\/([^/]+)$/.exec(sub))) { only('POST'); return send(res, 200, setDevice(decodeURIComponent(m[1]), await readBody(req), viewer, scope)); }
      if (sub === 'join-code') { only('POST'); return send(res, 200, joinCode(await readBody(req), viewer)); }
      if (sub === 'join-codes') { only('GET'); return send(res, 200, { codes: listJoinCodes() }); }
      if (sub === 'join-code/revoke') { only('POST'); return send(res, 200, revokeCode(await readBody(req), viewer)); }
      if (sub === 'mcp') { only('GET'); return send(res, 200, mcp()); }
      if (sub === 'mcp/tool') { only('POST'); return send(res, 200, setTool(await readBody(req), viewer)); }
      if (sub === 'jobs') { only('GET'); return send(res, 200, await jobs(scope)); }
      if (sub === 'topology') { only('GET'); return send(res, 200, await topology(viewer, req)); }
      if (sub === 'topology/events') { only('GET'); return send(res, 200, events(q, scope)); }
      if (sub === 'boot') { only('GET'); return send(res, 200, await boot(req, q)); }
      if (sub === 'settings') {
        if (method === 'GET') return send(res, 200, settingsView());
        only('POST');
        return send(res, 200, setSettings(await readBody(req), viewer));
      }
      if (sub === 'conv/search') { only('GET'); return send(res, 200, convSearch(q, scope)); }
      if ((m = /^conv\/([A-Za-z0-9._:-]{1,200})$/.exec(sub))) { only('GET'); return send(res, 200, convGet(m[1], q, scope)); }
      for (const ext of exts) { if (await ext.handle(req, res, url, sub, viewer)) return; }
      throw new HttpError(404, '没有这个接口');
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      if (e instanceof UserError) return send(res, 400, { error: e.message });
      throw e;
    }
  }

  return { handle };
}
