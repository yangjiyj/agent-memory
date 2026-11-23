/* 拓扑时间回放的历史接口，挂在 /console/api/ 下（扩展：由 admin.mjs 的 [B] 扩展位加载）。
 *
 *   GET topology/history?hours=24&bucket=15
 *     hours   回看多少小时，1–48，默认 24（前端取 48，前 24 小时只用来算"滚动 24 小时"，界面上只能拖最近 24 小时）
 *     bucket  每格多少分钟，1–60，默认 15。格数 count = ceil(hours*60/bucket)，不能超过 1500；
 *             不能整除时多出一格，时间从末尾往前排：to = 现在，from = to - count*bucket 分钟，第 i 格 = [from + i*bucket, from + (i+1)*bucket)
 *   返回：
 *     { now, from, to, bucket, hours, count,
 *       devices: [{ name, group,                 // 只列设备角色（抽取机、报表令牌不在）
 *                   up:   [count 个数],          // 写入量：新增对话消息 + remember/update/retire 调用，和 /topology 的 flow.up_24h 同口径
 *                   down: [count 个数],          // 读取量：其余 tool:/cli: 调用，和 flow.down_24h 同口径
 *                   state:[count 个],            // 每格末尾那一刻的状态：live 正在干活 / ok 刚同步 / idle 空闲 / stale 超时 / paused 已暂停 / none 设备还没加入
 *                   idle: [count 个数或 null] }],// 每格末尾距上次活动的分钟数（向下取整）；null = 之前没有任何记录（或设备还没加入）
 *       events: [count 个，没事件的格是 null，否则 { n, kinds: {read, write, talk, extract, report, console}, items: [最多 6 条，旧→新] }] }
 *     事件的字段和 topology/events 一致（id/t/kind/device/tool/text，对话事件可带 project），id 也是同一套。
 *   状态怎么推（历史里没有逐次心跳记录，只能按活动推）：活动 = 对话消息、读写调用、以及设备最近一次心跳；
 *     paused 按设备当前的暂停设置（历史上什么时候暂停过没有记录）；加入之前 none；没有任何活动记录或距上次活动超过阈值（设备自己的 stale_hours，没设用全局，默认 3 小时）stale；
 *     20 分钟内有新对话 live；15 分钟内有活动 ok；其余 idle。判断用的就是返回的 idle（整分钟）。
 *   带项目的事件（对话事件）按浏览者的 hide_projects 过滤（kit.visibleTo），被隐藏的不进 items，也不进 n 和 kinds。
 *     写入量/读取量是设备级的合计，和 /topology 一样不按项目过滤。
 */

const MIN = 60e3;
const HOUR = 3600e3;
const LIVE_MIN = 20; // 20 分钟内有新对话算"正在干活"（同 admin.mjs 的 LIVE_MS）
const FRESH_MIN = 15; // 15 分钟内有活动算"刚同步"（同拓扑页的 FRESH）
const DEFAULT_STALE_HOURS = 3; // 同 admin.mjs 的 DEFAULTS.stale_hours
const MAX_BUCKETS = 1500;
const ITEMS = 6; // 每格留几条事件

export function createTopologyHistory(ctx, kit) {
  const { CFG, loadTokens, readJSON, heartbeatFile, conv, send } = ctx;
  const { HttpError, bad, visibleTo } = kit;
  const { eventOf, talkEvent, isCall, isWrite, usageRows } = kit.topo;

  const intArg = (q, name, def, min, max, what) => {
    const raw = q.get(name);
    if (raw === null || raw === '') return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name}（${what}）必须是 ${min}–${max} 之间的整数`);
    return n;
  };

  function history(viewer, q) {
    const hours = intArg(q, 'hours', 24, 1, 48, '回看的小时数');
    const bucket = intArg(q, 'bucket', 15, 1, 60, '每格的分钟数');
    const count = Math.ceil((hours * 60) / bucket);
    if (count > MAX_BUCKETS) throw bad(`一共 ${count} 格，超过 ${MAX_BUCKETS} 格上限：把 bucket 调大，或把 hours 调小`);
    const B = bucket * MIN;
    const to = Date.now();
    const from = to - count * B;
    const idx = (ms) => Math.min(count - 1, Math.floor((ms - from) / B));

    const hb = readJSON(heartbeatFile(), {});
    const devs = Object.entries(loadTokens().devices || {}).filter(([, d]) => (d.role || 'device') === 'device');
    const limitOf = (d) => d.stale_hours || CFG.stale_hours || DEFAULT_STALE_HOURS;
    // 判断"距上次活动多久"要往窗口之前多看一段：最大的超时阈值，封顶 72 小时
    const lookFrom = from - Math.min(72, Math.max(DEFAULT_STALE_HOURS, ...devs.map(([, d]) => limitOf(d)))) * HOUR;

    const by = new Map(devs.map(([name, d]) => [name, { name, d, up: Array(count).fill(0), down: Array(count).fill(0), msgs: [], calls: [] }]));

    // 对话消息：每条算一次写入
    for (const [dev, tools] of Object.entries(conv().recentMessages(lookFrom))) {
      const x = by.get(dev);
      if (!x) continue;
      for (const xs of Object.values(tools)) {
        for (const ms of xs) {
          if (ms > to) continue;
          x.msgs.push(ms);
          if (ms >= from) x.up[idx(ms)]++;
        }
      }
    }

    // 调用记录：从文件尾往前读（行按时间追加），出了回看范围就停；同时收事件
    const evs = [];
    const rows = usageRows();
    for (let i = rows.length - 1; i >= 0; i--) {
      const u = rows[i];
      if (u.ms < lookFrom) break;
      if (u.ms > to) continue;
      const x = by.get(u.device);
      if (isCall(u.op) && x) {
        x.calls.push(u.ms);
        if (u.ms >= from) { if (isWrite(u.op)) x.up[idx(u.ms)]++; else x.down[idx(u.ms)]++; }
      }
      if (u.ms >= from) { const e = eventOf(u); if (e) evs.push(e); }
    }
    evs.reverse(); // 回到文件里的先后顺序，同一毫秒的保持原样
    for (const s of conv().recentSessions(from)) {
      if (Date.parse(s.last) > to) continue;
      if (s.project && !visibleTo(viewer, s.project)) continue;
      evs.push(talkEvent(s));
    }
    evs.sort((a, b) => Date.parse(a.t) - Date.parse(b.t)); // 稳定排序

    const events = Array(count).fill(null);
    for (const e of evs) {
      const i = idx(Date.parse(e.t));
      if (i < 0) continue;
      const c = (events[i] ||= { n: 0, kinds: {}, items: [] });
      c.n++; c.kinds[e.kind] = (c.kinds[e.kind] || 0) + 1;
      c.items.push(e);
      if (c.items.length > ITEMS) c.items.shift();
    }

    const devices = [...by.values()].map((x) => {
      const { d } = x;
      const seen = Date.parse(hb[x.name]?.last_seen);
      const act = [...x.msgs, ...x.calls, ...(Number.isFinite(seen) && seen <= to ? [seen] : [])].sort((a, b) => a - b);
      x.msgs.sort((a, b) => a - b);
      const created = Date.parse(d.created) || 0;
      const limitMin = limitOf(d) * 60;
      const state = []; const idle = [];
      let pa = -1; let pm = -1;
      for (let i = 0; i < count; i++) {
        const e = from + (i + 1) * B; // 这一格末尾那一刻
        while (pa + 1 < act.length && act[pa + 1] <= e) pa++;
        while (pm + 1 < x.msgs.length && x.msgs[pm + 1] <= e) pm++;
        const gap = pa >= 0 ? Math.floor((e - act[pa]) / MIN) : null;
        if (e <= created) { state.push('none'); idle.push(null); continue; }
        idle.push(gap);
        if (d.paused) state.push('paused');
        else if (gap === null || gap > limitMin) state.push('stale');
        else if (pm >= 0 && Math.floor((e - x.msgs[pm]) / MIN) < LIVE_MIN) state.push('live');
        else state.push(gap < FRESH_MIN ? 'ok' : 'idle');
      }
      return { name: x.name, group: d.group || '', up: x.up, down: x.down, state, idle };
    });

    return { now: new Date(to).toISOString(), from: new Date(from).toISOString(), to: new Date(to).toISOString(), bucket, hours, count, devices, events };
  }

  return {
    handle(req, res, url, sub, viewer) {
      if (sub !== 'topology/history') return undefined;
      if (req.method !== 'GET') throw new HttpError(405, '这个接口只支持 GET');
      send(res, 200, history(viewer, url.searchParams));
      return true;
    },
  };
}
