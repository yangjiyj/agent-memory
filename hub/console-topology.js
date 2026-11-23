/* 拓扑页：设备 → 认证网关 → 中心 → 存储 / 抽取机 / 向量服务 / 报表 / 浏览器，一张会动的实时图。
 *
 * 数据：GET /console/api/topology（页面可见时每 30 秒）和 GET /console/api/topology/events（每 10 秒，只拉新的）。
 * 结构：节点是 HTML（文字清晰、能放标签），连线是 SVG；光点用 stroke-dasharray + CSS 动画做，
 *   页面里没有 JS 动画循环，离开页面或标签页切走时给容器加 tp-paused 就全停了。
 * 流量：设备连线上写入（设备→中心，青）和读取（中心→设备，琥珀）各有一串光点，密度按近 24 小时的量分档，线的粗细按总量分档。
 * 事件：新事件到达时在对应连线上放一道一次性的脉冲（Web Animations），终点节点闪一下；首次加载的那批和离开很久回来的那批不播。
 * 刷新：布局没变（设备、网关、各组件配没配都没变）就只更新节点文字、状态类和连线状态，不重画；窗口变宽窄才重排。
 * 心跳条：24 格，上排青 = 写入、下排琥珀 = 读取；悬停某一格看这一小时的写入/读取数。
 * 分组：设备的 group 相同的挨在一起，套一块底板（顶上标签点一下折叠）；折叠的组是一个汇总节点（组名、台数、合计 ↑↓、有超时设备就标红），
 *   它到中心（或网关）只有一条汇总线；折叠状态记在 localStorage。没有任何设备设了分组时，和没有这个功能时完全一样。
 * 回放：console-replay.js 通过 window.TopologyHooks 介入（回放中把实时数据改写成那一刻的样子，暂停轮询），本文件只留钩子。
 */
(function () {
  'use strict';
  const h = Console.esc;
  const { date, tip } = Console;
  const FRESH = 15 * 60e3; // 这个时间内同步过：连线流动
  const ACTIVE = 60 * 60e3; // 抽取机、报表这个时间内有活动：连线流动
  const MIN_W = 980; // 比这窄就横向滚动
  const RGB = { dev: '57,135,229', grp: '57,135,229', gate: '36,196,138', hub: '144,133,233', repo: '232,170,60', arc: '232,170,60', ext: '221,96,140', vec: '80,200,230', rep: '134,182,239', web: '205,226,251', up: '84,214,240', dn: '255,184,76' };
  const EV_RGB = { read: RGB.dn, write: RGB.up, talk: '124,150,255', extract: RGB.ext, report: RGB.gate, console: RGB.web };
  const GROUP = { gateway: 0, join: 1, token: 2 };
  const IDENT = { gateway: '网关', join: '加入码', token: '令牌' };
  const VIA = { gateway: '网关', config: '控制台配置' };
  const GOTO = { hub: 'mcp', repo: 'jobs', arc: 'jobs', ext: 'jobs', vec: 'jobs' };
  const GOTO_TEXT = { dev: '设备页', hub: 'MCP 页', repo: '任务页', arc: '任务页', ext: '任务页', vec: '任务页' };
  const LANE = 4.5; // 两列时外列连线走总线，相邻两条的间距
  const NOAGENT = ['unknown', 'cli', 'browser', 'console'];
  const RM = window.matchMedia('(prefers-reduced-motion: reduce)');
  const SEG_TOP = 22; const SEG_BOT = 6; const SEG = SEG_TOP + SEG_BOT; // 展开的组：底板顶上一条标签、底下留边
  const ST_COLOR = { live: '#35d36b', ok: '#35d36b', idle: '#3f9a5f', stale: '#ef5b5b', paused: '#4a5470' };
  const CHEV = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
  // 时间回放（console-replay.js）通过这几个钩子介入渲染，默认都不起作用：
  //   now：回放中 = 那一刻的毫秒时间戳，所有"几分钟前"都按它算；null = 实时
  //   view(live)：回放中把实时数据改写成那一刻的样子；feed(proj)：回放中的事件带内容（新→旧）
  //   extraH()：回放条占的高度；mounted(box)：页面搭好后让回放条挂进去；hidden()：离开页面
  // 另外在加载后补上 refresh / live / reload / pulse / proj 几个回放用的入口
  const HK = (window.TopologyHooks = { now: null, view: null, feed: null, extraH: () => 0, mounted: null, hidden: null });
  const nowMs = () => HK.now ?? Date.now();
  // 折叠起来的组（记在 localStorage）
  const COLL_KEY = 'am.topology.collapsed';
  const coll = new Set();
  try { for (const g of JSON.parse(localStorage.getItem(COLL_KEY) || '[]')) coll.add(String(g)); } catch { /* 读不了就都展开 */ }

  let root; let box; let stage; let scroller; let probBox; let svg; let defs; let edgeLayer; let pulseLayer; let feedEl; let fsBtn;
  let D = null; let LIVE = null; let LAY = null; let sig = ''; let uid = 0;
  let nodeEl = {}; let edgeEl = {}; let plateEl = {}; let tipSub = null; let drawerId = null; let drawerEl = null; let loading = null; let lastErr = '';
  const pend = new Map(); // 抽屉里开关正在提交的值：设备名:字段 → { value }
  // 事件带
  let evRows = []; let evLast = ''; let evAt = 0; let evBusy = false; let feedSig = ''; let hoverId = null; let pulsing = 0;
  const evSeen = new Set(); const fresh = new Set();
  // 项目筛选：选中的项目名、它近 24 小时的对话（null = 还没取到）
  let proj = null; let pjRows = null; let pjBox;
  const pjOf = () => (proj && D?.projects?.find((p) => p.name === proj)) || null;
  const pjTools = (name) => { const p = pjOf(); return p ? p.members.filter((m) => m.device === name) : null; };
  const feedList = () => (HK.now != null && HK.feed ? HK.feed(proj) : proj ? pjRows || [] : evRows);

  const fmtN = (n) => Number(n || 0).toLocaleString('zh-CN');
  const fmtK = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n || 0));
  const abs = (iso) => (iso ? new Date(Date.parse(iso) + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : '');
  // 回放中"几分钟前"按回放的那一刻算
  const agoAt = (iso) => { const m = Math.round((nowMs() - Date.parse(iso)) / 60000); return m < 1 ? '刚刚' : m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.floor(m / 60)} 小时前` : `${Math.floor(m / 1440)} 天前`; };
  const ago = (iso) => (iso ? (HK.now == null ? date.ago(iso) : agoAt(iso)) : '从未');
  const age = (iso) => (iso ? nowMs() - Date.parse(iso) : Infinity);
  const nameOf = (d) => d.label || Console.dev(d.name) || d.name;
  const toolOrder = (t) => { const i = Console.toolOrder.indexOf(t); return i < 0 ? 99 : i; };
  const flowOf = (d) => d.flow || { up_24h: 0, down_24h: 0, hours: [], hours_down: [] };
  const members = (g) => D.devices.filter((d) => d.group === g);
  const sumFlow = (ms) => {
    const out = { up_24h: 0, down_24h: 0, hours: Array(24).fill(0), hours_down: Array(24).fill(0) };
    for (const d of ms) {
      const f = flowOf(d);
      out.up_24h += f.up_24h || 0; out.down_24h += f.down_24h || 0;
      for (let i = 0; i < 24; i++) { out.hours[i] += Number(f.hours?.[i]) || 0; out.hours_down[i] += Number(f.hours_down?.[i]) || 0; }
    }
    return out;
  };
  // 光点密度 0–3、线粗细 0–4：都按近 24 小时的次数分档
  const dens = (n) => (!n ? 0 : n < 10 ? 1 : n < 50 ? 2 : 3);
  const wlvl = (n) => (!n ? 0 : n < 10 ? 1 : n < 50 ? 2 : n < 200 ? 3 : 4);
  const arrows = (up, dn) => `<u class="up">↑${fmtK(up)}</u><u class="dn">↓${fmtK(dn)}</u>`;

  // ---------------- 状态 ----------------
  function devState(d) {
    if (d.paused) return 'paused';
    if (d.stale) return 'stale';
    if (d.live) return 'live';
    return age(d.last_seen) < FRESH ? 'ok' : 'idle';
  }
  const DEV_TEXT = { paused: '已暂停', stale: '超时没同步', live: '正在干活', ok: '同步中', idle: '空闲' };
  const devText = (d) => (d.none ? '还没加入' : DEV_TEXT[devState(d)]);
  // 一个组的整体状态：有超时的设备就标红（bad）；best 是最活跃的那台的状态，没有活的就是超时（有超时的话）或暂停；汇总线也用它
  function grpInfo(ms) {
    const sts = ms.map(devState);
    const bad = sts.filter((x) => x === 'stale').length;
    const best = ['live', 'ok', 'idle'].find((x) => sts.includes(x)) || (bad ? 'stale' : 'paused');
    return { bad, best, edge: best };
  }

  // 设备所在的节点：折叠起来的设备在它的汇总节点上
  const devNode = (name) => (LAY?.nodes[`dev:${name}`] ? `dev:${name}` : LAY?.fold?.[name] || `dev:${name}`);
  // 巡检问题归到节点上
  function problemNode(key) {
    let m;
    if ((m = /^stale:(.+)$/.exec(key)) || (m = /^guard:([^/]+)\//.exec(key))) return D.devices.some((d) => d.name === m[1]) ? devNode(m[1]) : 'hub';
    if (/^(extract|journal):/.test(key)) return D.extractors.length ? 'ext' : 'hub';
    if (/^archive:/.test(key)) return 'arc';
    return 'hub';
  }
  function problemsOf() {
    const by = {};
    for (const p of D.problems || []) (by[problemNode(p.key)] ||= []).push(p);
    return by;
  }

  // ---------------- 布局 ----------------
  const bez = (x1, y1, x2, y2) => { const dx = (x2 - x1) * 0.5; return `M${x1.toFixed(1)} ${y1.toFixed(1)}C${(x1 + dx).toFixed(1)} ${y1.toFixed(1)} ${(x2 - dx).toFixed(1)} ${y2.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`; };
  const bezAt = (x1, y1, x2, y2, t) => {
    const dx = (x2 - x1) * 0.5; const u = 1 - t;
    return [u * u * u * x1 + 3 * u * u * t * (x1 + dx) + 3 * u * t * t * (x2 - dx) + t * t * t * x2, u * u * u * y1 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y2];
  };
  const sampleBez = (x1, y1, x2, y2, n = 28) => Array.from({ length: n - 1 }, (_, k) => bezAt(x1, y1, x2, y2, (k + 1) / n));
  const fsOn = () => Boolean(box) && (document.fullscreenElement === box || box.classList.contains('tp-fs'));
  const feedRows = () => (window.innerHeight >= 1000 ? 8 : Console.embed && window.innerHeight < 720 ? 3 : 6);
  const feedH = () => 34 + feedRows() * 26;

  // availH：画布能用的最大高度。设备节点在 30–62 之间压缩高度（低于 44 去掉智能体标签），仍放不下才分两列。
  // 设了分组时：同组设备挨着排，外面套一块底板（顶上一条标签）；折叠起来的组是一个汇总节点，占一行。没有分组时和原来完全一样。
  function layout(W, availH) {
    const gateOn = D.gate.enabled;
    const viaGate = (d) => gateOn && d.identity === 'gateway';
    const all = D.devices.slice().sort((a, b) => (gateOn ? (GROUP[a.identity] ?? 3) - (GROUP[b.identity] ?? 3) : 0) || a.name.localeCompare(b.name));
    // items：左边的每一行，是一台设备，或一个折叠起来的组
    const items = [];
    if (!all.some((d) => d.group)) all.forEach((d) => items.push({ id: `dev:${d.name}`, via: viaGate(d) }));
    else {
      for (const g of [...new Set(all.map((d) => d.group).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh'))) {
        const ms = all.filter((d) => d.group === g);
        if (coll.has(g)) items.push({ id: `grp:${g}`, g, fold: true, via: ms.every(viaGate), names: ms.map((d) => d.name) });
        else ms.forEach((d) => items.push({ id: `dev:${d.name}`, g, via: viaGate(d) }));
      }
      all.filter((d) => !d.group).forEach((d) => items.push({ id: `dev:${d.name}`, via: viaGate(d) }));
    }
    const grouped = items.some((it) => it.g);
    const n = items.length;
    const PAD = 24;
    const segOf = (it) => (it && !it.fold ? it.g || null : null); // 展开的组才有底板
    const segCount = (list) => list.reduce((c, it, i) => c + (segOf(it) && segOf(it) !== segOf(list[i - 1]) ? 1 : 0), 0);
    const H0 = Math.round(Math.max(Console.embed ? 450 : 500, Math.min(availH, 900)));
    const gap = n > 6 ? 7 : 10;
    const nh1 = Math.floor((H0 - 2 * PAD + gap - segCount(items) * SEG) / Math.max(n, 1)) - gap;
    const two = nh1 < 30;
    const rows = two ? Math.ceil(n / 2) : Math.max(n, 1);
    const cols = two ? [items.slice(0, rows), items.slice(rows)] : [items];
    const upRows = two ? Math.floor(rows / 2) : 0; const downRows = two ? rows - upRows : 0;
    const marginTop = two ? 16 + upRows * LANE : PAD; const marginBottom = two ? 16 + downRows * LANE : PAD;
    const nh = two ? Math.max(30, Math.min(56, Math.floor((H0 - marginTop - marginBottom - Math.max(...cols.map(segCount)) * SEG + gap) / rows) - gap)) : Math.min(62, nh1);
    const devW = two ? 176 : 236;
    const colGap = two ? 14 + (grouped ? 8 : 0) + LANE * Math.max(upRows, downRows) : 0;
    const leftW = two ? devW * 2 + colGap : devW;
    // 每列从上往下排：一组的第一台前留标签条，最后一台后留底边
    const stacks = cols.map((list) => {
      let y = 0; const ys = [];
      list.forEach((it, i) => {
        if (i) y += gap;
        if (segOf(it) && segOf(it) !== segOf(list[i - 1])) y += SEG_TOP;
        ys.push(y); y += nh;
        if (segOf(it) && segOf(it) !== segOf(list[i + 1])) y += SEG_BOT;
      });
      return { ys, end: y };
    });
    const blockH = Math.max(rows * nh + (rows - 1) * gap, ...stacks.map((st) => st.end));
    const H = Math.round(Math.max(H0, blockH + marginTop + marginBottom));
    const gateW = 124; const gateH = 96; const hubW = 214; const hubH = 236; const rightW = 228; const rightH = 84;
    const free = W - 2 * PAD - (leftW + gateW + hubW + rightW);
    const gx = Math.max(two ? 40 : 60, free / 3);
    const xg = PAD + leftW + gx; const xh = xg + gateW + gx; const xr = xh + hubW + gx;
    const top0 = marginTop + (H - marginTop - marginBottom - blockH) / 2;
    const hubCY = H / 2 - 36;
    const nodes = {};
    const plates = [];
    cols.forEach((list, c) => {
      const x = PAD + c * (devW + colGap);
      list.forEach((it, i) => {
        nodes[it.id] = { kind: it.fold ? 'grp' : 'dev', x, y: top0 + stacks[c].ys[i], w: devW, h: nh, two, col: c, via: it.via, ...(it.fold ? { g: it.g } : {}) };
      });
      for (let i = 0; i < list.length; i++) { // 同组的连续几台共一块底板（两列时每列一块）
        const g = segOf(list[i]);
        if (!g || g === segOf(list[i - 1])) continue;
        let j = i;
        while (segOf(list[j + 1]) === g) j++;
        const y1 = top0 + stacks[c].ys[i] - SEG_TOP; const y2 = top0 + stacks[c].ys[j] + nh + SEG_BOT;
        plates.push({ id: `gp:${g}:${c}`, g, x: x - 6, y: y1, w: devW + 12, h: y2 - y1 });
      }
    });
    const fold = {}; // 折叠起来的设备 → 它所在的汇总节点
    for (const it of items) if (it.fold) for (const nm of it.names) fold[nm] = it.id;
    nodes.hub = { kind: 'hub', x: xh, y: hubCY - hubH / 2, w: hubW, h: hubH };
    const sw = 118; const sx = xh + hubW / 2 - sw - 6; const sy = hubCY + hubH / 2 + 56;
    nodes.repo = { kind: 'repo', x: sx, y: sy, w: sw, h: 76 };
    nodes.arc = { kind: 'arc', x: sx + sw + 12, y: sy, w: sw, h: 76 };
    const gr = Math.max(18, Math.min(56, (H - 2 * PAD - 4 * rightH) / 3));
    let ry = hubCY - (4 * rightH + 3 * gr) / 2;
    ry = Math.max(PAD, Math.min(ry, H - PAD - (4 * rightH + 3 * gr)));
    ['ext', 'vec', 'rep', 'web'].forEach((id, i) => { nodes[id] = { kind: id, x: xr, y: ry + i * (rightH + gr), w: rightW, h: rightH }; });

    // 两列时外列（左）的连线不能从内列节点后面穿过：走"总线"——先在两列之间的通道里竖着走到块的上方或下方，再横着绕过内列，最后弯进中心。
    // 上半的节点走上面、下半的走下面；越靠外侧的节点用越靠外的车道，这样互不交叉。
    const lane = {};
    const c0Right = PAD + devW; const c1Right = PAD + 2 * devW + colGap;
    if (two) {
      const c0 = items.map((it) => it.id).filter((id) => nodes[id].col === 0).sort((a, b) => nodes[a].y - nodes[b].y);
      const ups = c0.slice(0, Math.floor(c0.length / 2)); const downs = c0.slice(ups.length).reverse();
      ups.forEach((id, i) => { lane[id] = { up: true, i }; });
      downs.forEach((id, i) => { lane[id] = { up: false, i }; });
    }
    const cyOf = (id) => nodes[id].y + nodes[id].h / 2;
    const rightX = (id) => nodes[id].x + nodes[id].w;
    const route = (id, tx, ty) => {
      const x0 = rightX(id); const y0 = cyOf(id); const ln = lane[id];
      if (!ln) return { d: bez(x0, y0, tx, ty), pts: sampleBez(x0, y0, tx, ty), bus: false };
      const r = 3; const sy = ln.up ? -1 : 1;
      const xl = c0Right + (grouped ? 10 : 6) + ln.i * LANE; const yl = ln.up ? 6 + ln.i * LANE : H - 6 - ln.i * LANE;
      const xe = c1Right + Math.min(22, (tx - c1Right) * 0.3); const dx = (tx - xe) * 0.5;
      const d = `M${x0} ${y0.toFixed(1)}H${xl - r}Q${xl} ${y0.toFixed(1)} ${xl} ${(y0 + sy * r).toFixed(1)}V${(yl - sy * r).toFixed(1)}Q${xl} ${yl} ${xl + r} ${yl}H${xe}C${xe + dx} ${yl} ${tx - dx} ${ty.toFixed(1)} ${tx} ${ty.toFixed(1)}`;
      return { d, pts: [[xl, y0], [xl, yl], [xe, yl], ...sampleBez(xe, yl, tx, ty, 20)], bus: true };
    };

    // 网关放在不挡绕行连线的位置：试每个高度，数绕行曲线有几个采样点落进网关框里
    const bypass = items.filter((it) => !it.via);
    const viaList = items.filter((it) => it.via);
    const want = viaList.length ? viaList.reduce((a, it) => a + cyOf(it.id), 0) / viaList.length : hubCY;
    const guess = bypass.flatMap((it) => route(it.id, xh, hubCY).pts);
    let best = null;
    for (let cy = PAD + gateH / 2; cy <= H - PAD - gateH / 2; cy += 8) {
      let hit = 0;
      for (const [px, py] of guess) if (px > xg - 10 && px < xg + gateW + 10 && py > cy - gateH / 2 - 10 && py < cy + gateH / 2 + 10) hit++;
      const cost = hit * 1000 + Math.abs(cy - want);
      if (!best || cost < best.cost) best = { cy, cost };
    }
    nodes.gate = { kind: 'gate', x: xg, y: best.cy - gateH / 2, w: gateW, h: gateH };

    // 中心左边的接入点：从上到下排，连线不交叉。总线绕上方的排最上，绕下方的排最下，其余按来源高度
    const key = (id) => (lane[id] ? (lane[id].up ? -1e4 : 1e4) + cyOf(id) : cyOf(id));
    const srcs = [...bypass.map((it) => ({ id: it.id, y: key(it.id) })), ...(gateOn ? [{ id: 'gate', y: best.cy }] : [])].sort((a, b) => a.y - b.y);
    const sp = Math.min(14, (hubH - 52) / Math.max(1, srcs.length - 1));
    const anchor = {};
    srcs.forEach((s, i) => { anchor[s.id] = hubCY + (i - (srcs.length - 1) / 2) * sp; });

    const edges = [];
    const gs = viaList.length;
    viaList.forEach((it, i) => {
      const id = it.id; const g = nodes.gate;
      const ty = gs === 1 ? best.cy : g.y + 16 + (i * (gateH - 32)) / (gs - 1);
      edges.push({ id: `e:${id}`, x1: rightX(id), y1: cyOf(id), x2: g.x, y2: ty, from: 'dev', to: 'gate', ...route(id, g.x, ty) });
    });
    bypass.forEach((it) => {
      const id = it.id;
      edges.push({ id: `e:${id}`, x1: rightX(id), y1: cyOf(id), x2: xh, y2: anchor[id], from: 'dev', to: 'hub', ...route(id, xh, anchor[id]) });
    });
    if (gateOn) edges.push({ id: 'e:gate', x1: xg + gateW, y1: best.cy, x2: xh, y2: anchor.gate, from: 'gate', to: 'hub', d: bez(xg + gateW, best.cy, xh, anchor.gate) });
    ['ext', 'vec', 'rep', 'web'].forEach((id, i) => {
      const y1 = hubCY + (i - 1.5) * 18;
      edges.push({ id: `e:${id}`, x1: xh + hubW, y1, x2: xr, y2: cyOf(id), from: 'hub', to: id, d: bez(xh + hubW, y1, xr, cyOf(id)) });
    });
    for (const id of ['repo', 'arc']) {
      const n2 = nodes[id];
      const x = n2.x + n2.w / 2;
      edges.push({ id: `e:${id}`, x1: x, y1: hubCY + hubH / 2, x2: x, y2: n2.y, from: 'hub', to: id, straight: true, d: `M${x} ${hubCY + hubH / 2}L${x} ${n2.y}` });
    }
    const W2 = Math.max(W, xr + rightW + PAD);
    const sigStr = JSON.stringify([Math.round(W2), H, two, gateOn, !!D.extractors.length, !!D.reporters.length, D.vectors.enabled, items.map((it) => [it.id, it.via, it.g || ''])]);
    return { W: W2, H, nodes, edges, items, plates, fold, sig: sigStr };
  }

  // ---------------- 建 DOM ----------------
  function build() {
    stage.innerHTML = '';
    nodeEl = {}; edgeEl = {};
    stage.style.width = `${LAY.W}px`; stage.style.height = `${LAY.H}px`;
    plateEl = {};
    for (const p of LAY.plates) { // 分组底板在最底下（连线和节点都盖在上面），标签是一个按钮
      const el = document.createElement('div');
      el.className = 'tp-gp';
      Object.assign(el.style, { left: `${p.x}px`, top: `${p.y}px`, width: `${p.w}px`, height: `${p.h}px` });
      el.innerHTML = `<button type="button" class="tp-gl" aria-expanded="true" data-g="${h(p.g)}"></button>`;
      stage.appendChild(el);
      plateEl[p.id] = { el, h: '' };
    }
    svg = Console.svg('svg', { class: 'tp-svg', width: LAY.W, height: LAY.H, viewBox: `0 0 ${LAY.W} ${LAY.H}`, 'aria-hidden': 'true' }, stage);
    defs = Console.svg('defs', {}, svg);
    edgeLayer = Console.svg('g', {}, svg);
    pulseLayer = Console.svg('g', { class: 'tp-pulses' }, svg);
    for (const e of LAY.edges) {
      const g = Console.svg('g', { class: 'tp-e idle' }, edgeLayer);
      const gid = `tp-g${++uid}`;
      const lg = Console.svg('linearGradient', { id: gid, gradientUnits: 'userSpaceOnUse', x1: e.x1, y1: e.y1, x2: e.x2 + (e.straight ? 0.01 : 0), y2: e.y2 }, defs);
      Console.svg('stop', { offset: 0, 'stop-color': `rgb(${RGB[e.from]})` }, lg);
      Console.svg('stop', { offset: 1, 'stop-color': `rgb(${RGB[e.to]})` }, lg);
      const base = Console.svg('path', { d: e.d, class: 'tp-base', stroke: `url(#${gid})` }, g);
      const rec = { g, base, d: e.d, bus: Boolean(e.bus), state: '', cls: '' };
      if (e.from === 'dev' || e.from === 'gate') {
        // 写入（up）沿画的方向，读取（dn）反方向；两串光点上下错开 2.4 像素，不叠在一起
        for (const k of ['up', 'dn']) {
          const grp = Console.svg('g', { class: `tp-fl tp-${k}`, transform: `translate(0 ${k === 'up' ? -2.4 : 2.4})` }, g);
          const halo = Console.svg('path', { d: e.d, class: 'tp-dots tp-halo' }, grp);
          const core = Console.svg('path', { d: e.d, class: 'tp-dots tp-core' }, grp);
          const delay = `-${(Math.random() * 3).toFixed(2)}s`;
          halo.style.animationDelay = delay; core.style.animationDelay = delay;
          Console.svg('path', { d: 'M-4.5 -3.2L3.5 0L-4.5 3.2z', class: 'tp-arw' }, grp); // 减少动效时代替光点的方向标记，位置在下面摆
        }
      } else {
        const grp = Console.svg('g', { class: 'tp-neutral' }, g);
        g.style.setProperty('--cr', RGB[e.from]);
        const halo = Console.svg('path', { d: e.d, class: 'tp-dots tp-halo' }, grp);
        const core = Console.svg('path', { d: e.d, class: 'tp-dots tp-core' }, grp);
        const delay = `-${(Math.random() * 3).toFixed(2)}s`;
        halo.style.animationDelay = delay; core.style.animationDelay = delay;
      }
      edgeEl[e.id] = rec;
    }
    for (const rec of Object.values(edgeEl)) {
      const L = rec.base.getTotalLength();
      rec.len = L;
      if (!L) continue;
      const a = rec.base.getPointAtLength(L * 0.5); const b = rec.base.getPointAtLength(L * 0.5 + 1);
      const deg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
      rec.g.querySelectorAll('.tp-up .tp-arw').forEach((p) => p.setAttribute('transform', `translate(${a.x.toFixed(1)} ${a.y.toFixed(1)}) rotate(${deg.toFixed(1)})`));
      rec.g.querySelectorAll('.tp-dn .tp-arw').forEach((p) => p.setAttribute('transform', `translate(${a.x.toFixed(1)} ${a.y.toFixed(1)}) rotate(${(deg + 180).toFixed(1)})`));
    }
    for (const [id, n] of Object.entries(LAY.nodes)) {
      const el = document.createElement('div');
      el.className = `tp-n tp-${n.kind}`;
      el.dataset.id = id;
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      if (n.kind === 'grp') el.setAttribute('aria-expanded', 'false');
      Object.assign(el.style, { left: `${n.x}px`, top: `${n.y}px`, width: `${n.w}px`, height: `${n.h}px` });
      el.style.setProperty('--cr', RGB[n.kind]);
      const open = () => (n.kind === 'grp' ? toggleGroup(n.g) : openDrawer(id)); // 折叠的组：点一下展开
      el.addEventListener('mouseenter', (ev) => { tipSub = null; tip.show(ev, tipOf(id)); });
      el.addEventListener('mousemove', (ev) => hover(ev, id));
      el.addEventListener('mouseleave', () => { tipSub = null; tip.hide(); });
      el.addEventListener('click', open);
      el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } });
      stage.appendChild(el);
      nodeEl[id] = { el, html: '', cls: '' };
    }
    if (hoverId) highlight(hoverId);
  }

  // ---------------- 节点内容 ----------------
  const dot = (k) => `<i class="tp-dot ${k}"></i>`;
  // 标签按宽度放：放不下的折成 +N（中文按 11px、英文按 6px 估）
  const tagW = (t) => [...t].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 11 : 6), 0) + 18;
  function agentTags(d, room) {
    const mine = pjTools(d.name); // 选了项目：参与这个项目的智能体排前面并点亮，其余变暗
    const inPj = (a) => Boolean(mine) && mine.some((m) => m.tool === a.tool);
    const list = d.agents.slice().sort((a, b) => inPj(b) - inPj(a) || toolOrder(a.tool) - toolOrder(b.tool));
    if (!list.length) return '';
    let used = 0; let shown = 0;
    for (const a of list) {
      const w = tagW(Console.tool(a.tool)) + 4;
      const more = list.length - shown - 1 > 0 ? 30 : 0;
      if (used + w + more > room && shown) break;
      used += w; shown++;
    }
    const tg = (a) => `<span class="tp-tg ${a.live ? 'live' : ''}${mine ? (inPj(a) ? ' pj' : ' off') : ''}">${h(Console.tool(a.tool))}</span>`;
    return list.slice(0, shown).map(tg).join('') + (list.length > shown ? `<span class="tp-tg${mine ? ' off' : ''}">+${list.length - shown}</span>` : '');
  }
  // 24 格心跳条：最旧在前；上排青 = 写入、下排琥珀 = 读取，各按这台设备自己这一排的最大值归一，全 0 就是一排暗格
  function hbHtml(f, big) {
    const line = (arr, cls) => {
      const xs = Array.from({ length: 24 }, (_, i) => Number(arr?.[i]) || 0);
      const mx = Math.max(...xs);
      return xs.map((v) => (v ? `<i class="${cls}" style="opacity:${(0.3 + (0.7 * v) / mx).toFixed(2)}"></i>` : '<i class="z"></i>')).join('');
    };
    return `<div class="tp-hb ${big ? 'big' : ''}" aria-hidden="true">${line(f.hours, 'w')}${line(f.hours_down, 'r')}</div>`;
  }
  // 鼠标在心跳条上时提示这一格（一小时）的写入/读取数，其余地方是节点自己的提示
  function hbCell(ev) {
    const bar = ev.target.closest?.('.tp-hb');
    if (!bar) return null;
    const r = bar.getBoundingClientRect();
    return Math.max(0, Math.min(23, Math.floor(((ev.clientX - r.left) / r.width) * 24)));
  }
  function hbTip(f, j) {
    const end = Date.parse(D.now); const s0 = end - (24 - j) * 3600e3;
    const hm = (ms) => date.hm(new Date(ms).toISOString());
    return `<div class="h">${hm(s0)}–${hm(s0 + 3600e3)}</div>${row('写入', fmtN(f.hours?.[j]), `rgb(${RGB.up})`)}${row('读取', fmtN(f.hours_down?.[j]), `rgb(${RGB.dn})`)}`;
  }
  const flowFor = (id) => (id.startsWith('grp:') ? sumFlow(members(LAY.nodes[id].g)) : flowOf(D.devices.find((x) => `dev:${x.name}` === id)));
  function hover(ev, id) {
    const j = hbCell(ev);
    if (j === tipSub) { tip.move(ev); return; }
    tipSub = j;
    tip.show(ev, j === null ? tipOf(id) : hbTip(flowFor(id), j));
  }
  // 组的成员标签：放不下的折成 +N，超时的标红
  function memberTags(ms, room) {
    let used = 0; let shown = 0;
    for (const d of ms) {
      const w = tagW(nameOf(d)) + 4;
      const more = ms.length - shown - 1 > 0 ? 30 : 0;
      if (used + w + more > room && shown) break;
      used += w; shown++;
    }
    return ms.slice(0, shown).map((d) => `<span class="tp-tg${devState(d) === 'stale' ? ' bad' : ''}">${h(nameOf(d))}</span>`).join('') + (ms.length > shown ? `<span class="tp-tg">+${ms.length - shown}</span>` : '');
  }
  function toggleGroup(g) {
    if (coll.has(g)) coll.delete(g); else coll.add(g);
    try { localStorage.setItem(COLL_KEY, JSON.stringify([...coll])); } catch { /* 存不了就只在这次页面里有效 */ }
    tip.hide();
    if (D) render();
  }
  function nodeHtml(id) {
    if (id.startsWith('grp:')) {
      const nd = LAY.nodes[id]; const ms = members(nd.g); const { bad, best } = grpInfo(ms); const f = sumFlow(ms);
      return `<div class="r1">${dot(bad ? 'stale' : best)}<b>${h(nd.g)}</b><em>${ms.length} 台</em><span class="tp-fl">${arrows(f.up_24h, f.down_24h)}</span></div>${nd.h >= 44 ? `<div class="r2">${memberTags(ms, nd.w - 26)}</div>` : ''}${hbHtml(f)}`;
    }
    if (id.startsWith('dev:')) {
      const d = D.devices.find((x) => x.name === id.slice(4)); const st = devState(d); const f = flowOf(d);
      const nd = LAY.nodes[id];
      return `<div class="r1">${dot(st)}<b>${h(nameOf(d))}</b>${d.readonly ? '<em>只读</em>' : ''}<span class="tp-fl">${arrows(f.up_24h, f.down_24h)}</span></div>${nd.h >= 44 ? `<div class="r2">${agentTags(d, nd.w - 26)}</div>` : ''}${hbHtml(f)}`;
    }
    switch (id) {
      case 'gate':
        return D.gate.enabled
          ? `<div class="r1">${dot('ok')}<b>认证网关</b></div><div class="big"><b>${fmtN(D.gate.devices)}</b> 台</div><div class="cap">经网关认出身份</div>`
          : '<div class="r1"><b>认证网关</b></div><div class="cap off">未启用</div>';
      case 'hub':
        return `<div class="r1"><b>中心</b><em>v${h(D.hub.version)}</em></div><div class="bigger">${fmtN(D.hub.memories)}</div><div class="cap">条有效记忆</div><div class="hr"></div><div class="m"><b>${fmtN(D.hub.calls_7d)}</b> 次调用 · 近 7 天</div><div class="m tp-fl">${arrows(D.hub.up_24h || 0, D.hub.down_24h || 0)}</div>`;
      case 'repo': {
        const c = D.storage.repo.last_commit;
        return `<div class="r1"><b>记忆仓库</b></div><div class="big"><b>${fmtN(D.storage.repo.entries)}</b> 条</div><div class="cap">${c ? `${h(ago(c.time))}提交` : '还没有提交'}</div>`;
      }
      case 'arc': {
        const a = D.storage.archive;
        return `<div class="r1">${dot(a.mounted ? 'ok' : 'stale')}<b>对话存档</b></div>${a.mounted ? `<div class="big"><b>${fmtN(a.sessions)}</b> 个</div><div class="cap">会话</div>` : '<div class="cap bad">没挂上</div>'}`;
      }
      case 'ext': {
        if (!D.extractors.length) return '<div class="r1"><b>抽取机</b></div><div class="cap off">未配置</div>';
        const last = D.extractors.map((x) => x.last_active).filter(Boolean).sort().pop();
        return `<div class="r1">${dot(age(last) < ACTIVE ? 'live' : 'idle')}<b>抽取机</b></div><div class="cap">${last ? `${h(ago(last))}活动` : '还没有活动'}</div><div class="m">待写日志 <b>${fmtN(D.pending.journal)}</b> 段 · 待审候选 <b>${fmtN(D.pending.proposed)}</b></div>`;
      }
      case 'vec':
        if (!D.vectors.enabled) return '<div class="r1"><b>向量服务</b></div><div class="cap off">未配置</div>';
        return `<div class="r1">${dot(D.vectors.busy ? 'live' : 'ok')}<b>向量服务</b></div><div class="big"><b>${fmtN(D.vectors.items)}</b> 条</div><div class="cap">${D.vectors.busy ? '正在建索引' : '已建向量'}</div>`;
      case 'rep': {
        if (!D.reporters.length) return '<div class="r1"><b>报表</b></div><div class="cap off">未配置</div>';
        const last = D.reporters.map((x) => x.last_active).filter(Boolean).sort().pop();
        return `<div class="r1">${dot(age(last) < ACTIVE ? 'live' : 'idle')}<b>报表</b></div><div class="cap">${last ? `${h(ago(last))}活动` : '还没有活动'}</div>`;
      }
      case 'web': {
        const v = D.viewer;
        const dv = D.devices.find((x) => x.name === v.device);
        return `<div class="r1">${dot('live')}<b>浏览器</b></div><div class="cap">按 <b>${h(dv ? nameOf(dv) : v.device)}</b> 的身份</div><div class="m">${h(VIA[v.via] || v.via)}</div>`;
      }
      default: return '';
    }
  }
  function nodeClass(id, probs) {
    const n = LAY.nodes[id]; const c = ['tp-n', `tp-${n.kind}`];
    if (id.startsWith('dev:')) {
      const st = devState(D.devices.find((x) => x.name === id.slice(4)));
      c.push(st); if (n.two) c.push('two'); if (n.h < 44) c.push('compact');
      const mine = pjTools(id.slice(4));
      if (mine) c.push(mine.length ? 'pj' : 'dim');
    } else if (n.kind === 'grp') {
      const ms = members(n.g); const { bad, best } = grpInfo(ms);
      c.push(best); if (bad) c.push('bad'); if (n.two) c.push('two'); if (n.h < 44) c.push('compact');
      if (proj) c.push(ms.some((d) => pjTools(d.name)?.length) ? 'pj' : 'dim');
    } else if (id === 'gate' && !D.gate.enabled) c.push('off');
    else if (id === 'ext' && !D.extractors.length) c.push('off');
    else if (id === 'vec' && !D.vectors.enabled) c.push('off');
    else if (id === 'rep' && !D.reporters.length) c.push('off');
    else if (id === 'arc' && !D.storage.archive.mounted) c.push('bad');
    if (probs[id]) c.push('bad');
    if (id === drawerId) c.push('sel');
    return [...new Set(c)].join(' ');
  }

  // ---------------- 连线状态 ----------------
  // 每条线：state（流动快慢 / 超时 / 暂停 / 没配）、写入和读取的光点密度、粗细
  function edgeStates() {
    const st = {};
    const fresh2 = (d) => !d.paused && !d.stale && age(d.last_seen) < FRESH;
    const put = (id, s, up, dn) => { st[id] = { s, u: dens(up), d: dens(dn), w: wlvl(up + dn) }; };
    for (const d of D.devices) {
      const s = devState(d); const f = flowOf(d);
      put(`e:dev:${d.name}`, s, f.up_24h, f.down_24h);
    }
    for (const [nid, nd] of Object.entries(LAY.nodes)) { // 折叠的组：一条汇总线
      if (nd.kind !== 'grp') continue;
      const ms = members(nd.g); const f = sumFlow(ms);
      put(`e:${nid}`, grpInfo(ms).edge, f.up_24h, f.down_24h);
    }
    const via = D.devices.filter((d) => d.identity === 'gateway' && !d.paused);
    if (D.gate.enabled) {
      const up = via.reduce((a, d) => a + flowOf(d).up_24h, 0); const dn = via.reduce((a, d) => a + flowOf(d).down_24h, 0);
      put('e:gate', via.some((d) => d.live) ? 'live' : via.some(fresh2) ? 'ok' : 'idle', up, dn);
    }
    const recent = (list) => list.some((x) => age(x.last_active) < ACTIVE);
    put('e:ext', !D.extractors.length ? 'off' : recent(D.extractors) ? 'ok' : 'idle', 0, 0);
    put('e:vec', !D.vectors.enabled ? 'off' : D.vectors.busy ? 'ok' : 'idle', 0, 0);
    put('e:rep', !D.reporters.length ? 'off' : recent(D.reporters) ? 'ok' : 'idle', 0, 0);
    put('e:web', 'ok', 0, 0);
    const any = D.devices.some((d) => d.live);
    const anyFresh = D.devices.some(fresh2);
    put('e:repo', any ? 'live' : anyFresh ? 'ok' : 'idle', 0, 0);
    put('e:arc', !D.storage.archive.mounted ? 'stale' : any ? 'live' : anyFresh ? 'ok' : 'idle', 0, 0);
    return st;
  }

  // ---------------- 更新（只改变了的部分）----------------
  function update() {
    // 项目条：近 7 天有活动的项目，点一个只亮参与它的设备和智能体，再点一次取消
    const pjs = D.projects || [];
    if (proj && !pjs.some((p) => p.name === proj)) { proj = null; pjRows = null; }
    const pjHtml = pjs.map((p) => `<button type="button" class="tp-pc${p.name === proj ? ' on' : ''}" aria-pressed="${p.name === proj}" data-p="${h(p.name)}" style="--pc:${h(Console.color(p.name))}"><i></i>${h(p.name)}</button>`).join('');
    if (pjBox.dataset.h !== pjHtml) { pjBox.innerHTML = pjHtml; pjBox.dataset.h = pjHtml; }
    pjBox.hidden = !pjs.length;
    stage.style.setProperty('--pj', proj ? Console.color(proj) : 'transparent');
    const probs = problemsOf();
    for (const id of Object.keys(nodeEl)) {
      const rec = nodeEl[id];
      const html = nodeHtml(id); const cls = nodeClass(id, probs);
      if (html !== rec.html) { rec.el.innerHTML = html; rec.html = html; }
      if (cls !== rec.cls) { rec.el.className = cls; rec.cls = cls; }
    }
    for (const p of LAY.plates) { // 分组底板的标签：组名、台数、有超时的设备数
      const rec = plateEl[p.id];
      if (!rec) continue;
      const ms = members(p.g); const bad = ms.filter((d) => devState(d) === 'stale').length;
      const html = `${CHEV}<b>${h(p.g)}</b><em>${ms.length} 台${bad ? ` · ${bad} 超时` : ''}</em>`;
      if (html !== rec.h) { rec.el.firstElementChild.innerHTML = html; rec.h = html; }
      rec.el.classList.toggle('bad', bad > 0);
      rec.el.classList.toggle('dim', Boolean(proj) && !ms.some((d) => pjTools(d.name)?.length));
    }
    const es = edgeStates();
    for (const [id, rec] of Object.entries(edgeEl)) {
      const e = es[id] || { s: 'idle', u: 0, d: 0, w: 0 };
      const off = (id.startsWith('e:dev:') && pjTools(id.slice(6))?.length === 0) || (id.startsWith('e:grp:') && Boolean(proj) && !members(id.slice(6)).some((d) => pjTools(d.name)?.length));
      const cls = `tp-e ${e.s} u${e.u} d${e.d} w${e.w}${rec.bus ? ' bus' : ''}${off ? ' dim' : ''}`;
      if (cls !== rec.cls) { rec.g.setAttribute('class', cls); rec.cls = cls; }
    }
    // 顶部的问题条
    const list = D.problems || [];
    const stale = list.filter((p) => p.key.startsWith('stale:'));
    const shown = stale.length >= 3 ? list.filter((p) => !p.key.startsWith('stale:')) : list;
    const html = (stale.length >= 3 ? `<button type="button" class="tp-chip" data-go="devices">${stale.length} 台设备超时没同步</button>` : '')
      + shown.map((p) => `<button type="button" class="tp-chip" data-node="${h(problemNode(p.key))}">${h(p.text)}</button>`).join('');
    if (probBox.dataset.h !== html) { probBox.innerHTML = html; probBox.dataset.h = html; }
    probBox.hidden = !list.length;
    if (drawerId) renderDrawer();
    renderFeed();
  }

  function render() {
    // 画布高度 = 屏幕高度 − 它上面的东西（顶栏、工具条和问题条，按实测）− 下面的东西（事件带、页面底边距）
    const top = box.getBoundingClientRect().top + window.scrollY;
    const bar = box.querySelector('.tp-bar').offsetHeight + 8;
    const availH = fsOn() ? window.innerHeight - 28 - bar - feedH() - 8 - HK.extraH() : window.innerHeight - Math.max(top, 0) - bar - (Console.embed ? 0 : 56) - feedH() - 4 - HK.extraH();
    const lay = layout(Math.max(MIN_W, scroller.clientWidth), availH);
    if (lay.sig !== sig) { LAY = lay; sig = lay.sig; build(); }
    else LAY = lay; // 位置不变，只是换一份最新的描述
    if (drawerId && !LAY.nodes[drawerId]) { drawerId = null; drawerEl?.classList.remove('on'); } // 折叠了：抽屉里那台设备没有自己的节点了
    update();
  }

  // ---------------- 提示和详情 ----------------
  const row = (label, val, color) => `<div class="r">${color ? `<b style="background:${color}"></b>` : ''}${label}<em>${val}</em></div>`;
  function tipOf(id) {
    const c = `rgb(${RGB[LAY.nodes[id].kind]})`;
    if (id.startsWith('grp:')) {
      const g = LAY.nodes[id].g; const ms = members(g); const f = sumFlow(ms);
      return `<div class="h">${h(g)} · ${ms.length} 台</div>${ms.map((d) => row(h(nameOf(d)), devText(d), ST_COLOR[devState(d)])).join('')}${row('近 24 小时', `<span class="tp-fl">${arrows(f.up_24h, f.down_24h)}</span>`)}`;
    }
    if (id.startsWith('dev:')) {
      const d = D.devices.find((x) => x.name === id.slice(4)); const f = flowOf(d);
      return `<div class="h">${h(nameOf(d))}</div>${row('状态', devText(d), c)}${row('最近同步', h(ago(d.last_seen)))}${row('接入', h(IDENT[d.identity] || d.identity))}${d.live ? row('最近对话', h(ago(d.last_msg))) : ''}${row('近 24 小时', `<span class="tp-fl">${arrows(f.up_24h, f.down_24h)}</span>`)}${(pjTools(d.name) || []).length ? row(`${h(proj)} 近 7 天`, `${fmtN(pjTools(d.name).reduce((a, m) => a + m.sessions, 0))} 个会话`, Console.color(proj)) : ''}`;
    }
    const T = {
      gate: () => `<div class="h">认证网关</div>${D.gate.enabled ? row('经网关认出身份', `${fmtN(D.gate.devices)} 台`, c) : row('状态', '未启用', c)}`,
      hub: () => `<div class="h">中心 v${h(D.hub.version)}</div>${row('有效记忆', fmtN(D.hub.memories), c)}${row('近 7 天调用', fmtN(D.hub.calls_7d))}${row('近 24 小时', `<span class="tp-fl">${arrows(D.hub.up_24h || 0, D.hub.down_24h || 0)}</span>`)}${row('设备端', h(D.hub.agent_version || '—'))}`,
      repo: () => `<div class="h">记忆仓库</div>${row('条目', fmtN(D.storage.repo.entries), c)}${row('最近提交', h(D.storage.repo.last_commit ? ago(D.storage.repo.last_commit.time) : '—'))}`,
      arc: () => `<div class="h">对话存档</div>${row('状态', D.storage.archive.mounted ? '已挂上' : '没挂上', c)}${row('会话', fmtN(D.storage.archive.sessions))}`,
      ext: () => `<div class="h">抽取机</div>${D.extractors.length ? `${row('待写日志', `${fmtN(D.pending.journal)} 段`, c)}${row('待审候选', fmtN(D.pending.proposed))}${row('待抽取会话', fmtN(D.pending.sessions))}` : row('状态', '未配置', c)}`,
      vec: () => `<div class="h">向量服务</div>${D.vectors.enabled ? `${row('已建向量', fmtN(D.vectors.items), c)}${row('模型', h(D.vectors.model || '—'))}` : row('状态', '未配置', c)}`,
      rep: () => `<div class="h">报表</div>${D.reporters.length ? row('令牌', `${D.reporters.length} 个`, c) : row('状态', '未配置', c)}`,
      web: () => `<div class="h">浏览器</div>${row('设备', h(D.viewer.device), c)}${row('方式', h(VIA[D.viewer.via] || D.viewer.via))}`,
    };
    return (T[id] || (() => ''))();
  }

  const kv = (rows) => `<dl class="tp-kv">${rows.filter(Boolean).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
  const tokenRows = (list) => `<h4>令牌</h4>${list.map((x) => `<div class="ag"><span>${h(x.label || x.name)}</span><em>${x.last_active ? `${h(ago(x.last_active))}${x.last_op ? ` · ${h(x.last_op)}` : ''}` : '没有记录'}</em></div>`).join('')}`;
  const swHtml = (field, label, on, busy) => `<div class="tp-opt"><span>${label}</span><button type="button" class="tp-sw ${on ? 'on' : ''}" role="switch" aria-checked="${on}" aria-label="${label}" data-sw="${field}" ${busy ? 'disabled' : ''}></button></div>`;
  function drawerBody(id) {
    if (id.startsWith('dev:')) {
      const d = D.devices.find((x) => x.name === id.slice(4));
      if (!d) return null;
      const st = devState(d); const f = flowOf(d);
      const agents = d.agents.slice().sort((a, b) => toolOrder(a.tool) - toolOrder(b.tool))
        .map((a) => `<div class="ag"><span class="tp-tg ${a.live ? 'live' : ''}">${h(Console.tool(a.tool))}</span><span class="tp-fl">${D.replay ? '' : arrows(a.up_24h || 0, a.down_24h || 0)}</span><em>${a.last_msg ? h(ago(a.last_msg)) : '没有对话'}</em></div>`).join('');
      const val = (field, cur) => (pend.has(`${d.name}:${field}`) ? pend.get(`${d.name}:${field}`).value : cur);
      const busy = (field) => pend.has(`${d.name}:${field}`);
      return { title: nameOf(d), sub: d.name !== nameOf(d) ? d.name : '', html: kv([
        ['状态', `${dot(st)} ${devText(d)}`],
        d.group ? ['分组', h(d.group)] : null,
        ['最近同步', `<span title="${h(abs(d.last_seen))}">${h(ago(d.last_seen))}</span>`],
        ['接入方式', h(IDENT[d.identity] || d.identity) + (d.identity === 'gateway' && !D.gate.enabled ? '（网关没启用）' : '')],
        ['设备端版本', h(d.version || '—')],
        ['近 24 小时', `<span class="tp-fl">${arrows(f.up_24h, f.down_24h)}</span>`],
      ]) + hbHtml(f, true) + swHtml('paused', '暂停同步', val('paused', d.paused), busy('paused')) + swHtml('readonly', '只读', val('readonly', d.readonly), busy('readonly'))
        + (agents ? `<h4>智能体</h4>${agents}` : '') };
    }
    const T = {
      hub: () => ({ title: '中心', sub: `v${D.hub.version}`, html: kv([['有效记忆', fmtN(D.hub.memories)], ['近 7 天调用', fmtN(D.hub.calls_7d)], ['近 24 小时', `<span class="tp-fl">${arrows(D.hub.up_24h || 0, D.hub.down_24h || 0)}</span>`], ['设备端版本', h(D.hub.agent_version || '—')], ['公开地址', `<span class="mono">${h(D.hub.public_url)}</span>`]]) }),
      gate: () => ({ title: '认证网关', sub: '', html: D.gate.enabled
        ? kv([['状态', `${dot('ok')} 已启用`], ['经网关认出身份', `${fmtN(D.gate.devices)} 台`]]) + (D.gate.devices ? `<h4>设备</h4>${D.devices.filter((d) => d.identity === 'gateway').map((d) => `<div class="ag"><span>${h(nameOf(d))}</span></div>`).join('')}` : '')
        : kv([['状态', '未启用']]) }),
      repo: () => { const c = D.storage.repo.last_commit; return { title: '记忆仓库', sub: '', html: kv([['条目', fmtN(D.storage.repo.entries)], c ? ['最近提交', `<span title="${h(abs(c.time))}">${h(ago(c.time))}</span>`] : null, c ? ['提交说明', h(c.subject)] : null]) }; },
      arc: () => { const a = D.storage.archive; return { title: '对话存档', sub: '', html: kv([['状态', `${dot(a.mounted ? 'ok' : 'stale')} ${a.mounted ? '已挂上' : '没挂上'}`], ['会话', fmtN(a.sessions)]]) }; },
      ext: () => ({ title: '抽取机', sub: '', html: D.extractors.length
        ? kv([['待写日志', `${fmtN(D.pending.journal)} 段`], ['待审候选', fmtN(D.pending.proposed)], ['待抽取会话', fmtN(D.pending.sessions)], D.pending.errors ? ['抽取失败', fmtN(D.pending.errors)] : null]) + tokenRows(D.extractors)
        : kv([['状态', '未配置']]) }),
      vec: () => ({ title: '向量服务', sub: '', html: D.vectors.enabled ? kv([['状态', `${dot(D.vectors.busy ? 'live' : 'ok')} ${D.vectors.busy ? '正在建索引' : '已开'}`], ['已建向量', fmtN(D.vectors.items)], ['模型', h(D.vectors.model || '—')]]) : kv([['状态', '未配置']]) }),
      rep: () => ({ title: '报表', sub: '', html: D.reporters.length ? tokenRows(D.reporters) : kv([['状态', '未配置']]) }),
      web: () => ({ title: '浏览器', sub: '', html: kv([['设备', h(D.viewer.device)], ['方式', h(VIA[D.viewer.via] || D.viewer.via)]]) }),
    };
    return T[id]?.() || null;
  }
  function renderDrawer() {
    const b = drawerBody(drawerId);
    if (!b) { closeDrawer(); return; }
    const probs = (problemsOf()[drawerId] || []).map((p) => `<div class="tp-prb">${h(p.text)}</div>`).join('');
    const kind = LAY.nodes[drawerId].kind;
    const to = drawerId.startsWith('dev:') ? 'devices' : GOTO[drawerId];
    const html = `<header><div><h3>${h(b.title)}</h3>${b.sub ? `<small>${h(b.sub)}</small>` : ''}</div><button type="button" class="tp-x" aria-label="关闭">×</button></header>
      <div class="body">${probs}${b.html}</div>${to ? `<footer><button type="button" class="btn go" data-go="${to}">去${GOTO_TEXT[kind]}</button></footer>` : ''}`;
    if (drawerEl.dataset.h !== html) { drawerEl.innerHTML = html; drawerEl.dataset.h = html; }
  }
  const SW_TEXT = { paused: ['已暂停同步', '已恢复同步'], readonly: ['已设为只读', '已恢复读写'] };
  async function toggleSwitch(btn) {
    const d = D.devices.find((x) => `dev:${x.name}` === drawerId);
    if (!d) return;
    const field = btn.dataset.sw; const k = `${d.name}:${field}`;
    const next = btn.getAttribute('aria-checked') !== 'true';
    pend.set(k, { value: next });
    renderDrawer();
    try {
      await Console.api(`/console/api/devices/${encodeURIComponent(d.name)}`, { body: { [field]: next } });
      Console.toast(`${nameOf(d)} ${SW_TEXT[field][next ? 0 : 1]}`, 'ok');
      await load(true);
    } catch (e) {
      Console.toast(e.message, 'err');
    } finally {
      pend.delete(k);
      if (drawerId) renderDrawer();
    }
  }
  function openDrawer(id) {
    if (!nodeEl[id]) return;
    tip.hide();
    drawerId = id;
    if (!drawerEl) {
      drawerEl = document.createElement('aside');
      drawerEl.className = 'tp-drawer';
      drawerEl.addEventListener('mousemove', (e) => { // 抽屉里大心跳条的提示
        const j = hbCell(e);
        if (j === null) { if (tipSub !== null) { tipSub = null; tip.hide(); } return; }
        if (j === tipSub) { tip.move(e); return; }
        tipSub = j;
        const d = D?.devices.find((x) => `dev:${x.name}` === drawerId);
        if (d) tip.show(e, hbTip(flowOf(d), j));
      });
      drawerEl.addEventListener('mouseleave', () => { tipSub = null; tip.hide(); });
      drawerEl.addEventListener('click', (e) => {
        if (e.target.closest('.tp-x')) closeDrawer();
        const sw = e.target.closest('[data-sw]');
        if (sw && !sw.disabled) toggleSwitch(sw);
        const g = e.target.closest('[data-go]');
        if (g) { closeDrawer(); Console.go(g.dataset.go); }
      });
    }
    (fsOn() ? box : document.body).appendChild(drawerEl);
    drawerEl.dataset.h = '';
    renderDrawer();
    requestAnimationFrame(() => drawerEl?.classList.add('on'));
    update();
  }
  function closeDrawer() {
    if (!drawerId) return;
    drawerId = null;
    drawerEl?.classList.remove('on');
    if (D) update();
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !Console.visible('topology')) return;
    if (drawerId) { closeDrawer(); e.preventDefault(); }
    else if (box?.classList.contains('tp-fs')) { box.classList.remove('tp-fs'); onFsChange(); }
  });
  document.addEventListener('mousedown', (e) => { if (drawerId && drawerEl && !drawerEl.contains(e.target) && !e.target.closest('.tp-n, .tp-chip')) closeDrawer(); });
  document.addEventListener('visibilitychange', () => { root?.classList.toggle('tp-paused', document.hidden || !Console.visible('topology')); });

  // ---------------- 全屏 ----------------
  function onFsChange() {
    const on = fsOn();
    if (fsBtn) { fsBtn.setAttribute('aria-pressed', on); fsBtn.title = on ? '退出全屏' : '全屏'; fsBtn.setAttribute('aria-label', fsBtn.title); }
    Console.overlayHost(on ? box : null);
    if (drawerEl) (on ? box : document.body).appendChild(drawerEl);
    tip.hide();
    requestAnimationFrame(() => { if (D) render(); });
  }
  function toggleFs() {
    if (fsOn()) {
      box.classList.remove('tp-fs');
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else onFsChange();
      return;
    }
    if (box.requestFullscreen && document.fullscreenEnabled) box.requestFullscreen().catch(() => { box.classList.add('tp-fs'); onFsChange(); });
    else { box.classList.add('tp-fs'); onFsChange(); }
  }
  document.addEventListener('fullscreenchange', () => { if (box && !document.fullscreenElement) box.classList.remove('tp-fs'); onFsChange(); });

  // ---------------- 事件：路径、脉冲、高亮 ----------------
  // 每种事件走哪几段连线、方向（rev = 反着画的方向走）、哪些节点要闪。连线的"正向"都是设备→中心、中心→组件。
  function routeOf(ev) {
    const segs = []; let flash = []; let nodes = [];
    const has = (id) => Boolean(edgeEl[id]);
    const dev = devNode(ev.device);
    const viaGate = Boolean(LAY.nodes[dev]?.via) && has('e:gate');
    if (ev.kind === 'read' || ev.kind === 'write' || ev.kind === 'talk') {
      if (!has(`e:${dev}`)) return null;
      if (ev.kind === 'read') { if (viaGate) segs.push({ e: 'e:gate', rev: true }); segs.push({ e: `e:${dev}`, rev: true }); flash = [dev]; } else { segs.push({ e: `e:${dev}`, rev: false }); if (viaGate) segs.push({ e: 'e:gate', rev: false }); flash = ['hub']; }
      nodes = [dev, 'hub', ...(viaGate ? ['gate'] : [])];
    } else if (ev.kind === 'extract' && has('e:ext')) { segs.push({ e: 'e:ext', rev: false }, { e: 'e:ext', rev: true }); flash = ['ext']; nodes = ['ext', 'hub']; }
    else if (ev.kind === 'report' && has('e:rep')) { segs.push({ e: 'e:rep', rev: false }); flash = ['rep']; nodes = ['rep', 'hub']; }
    else if (ev.kind === 'console' && has('e:web')) { segs.push({ e: 'e:web', rev: true }); flash = ['hub']; nodes = ['web', 'hub']; }
    else return null;
    return { segs, flash, nodes };
  }
  function flashNode(id, kind) {
    const el = nodeEl[id]?.el;
    if (!el) return;
    el.style.setProperty('--fc', EV_RGB[kind]);
    el.classList.remove('tp-flash'); void el.offsetWidth; el.classList.add('tp-flash');
    setTimeout(() => el.classList.remove('tp-flash'), 900);
  }
  // 一道一次性的脉冲：沿连线从头跑到尾（rev 则反着），多段依次接力；减少动效时不放
  function playPulse(ev) {
    if (RM.matches || !pulseLayer || document.hidden) return false;
    const r = routeOf(ev);
    if (!r) return false;
    const color = `rgb(${EV_RGB[ev.kind]})`;
    let at = 0; const done = [];
    for (const s of r.segs) {
      const rec = edgeEl[s.e];
      const dur = Math.max(380, Math.min(1100, (rec.len || 300) * 2.2));
      for (const [cls, w] of [['tp-ph', 13], ['tp-pc', 4.6]]) {
        const p = Console.svg('path', { d: rec.d, class: `tp-pulse ${cls}`, pathLength: 100, stroke: color, 'stroke-width': w }, pulseLayer);
        const a = p.animate(s.rev ? [{ strokeDashoffset: -100 }, { strokeDashoffset: 7 }] : [{ strokeDashoffset: 7 }, { strokeDashoffset: -100 }], { duration: dur, delay: at, easing: 'cubic-bezier(.3,.1,.4,1)', fill: 'both' });
        done.push(a.finished.then(() => p.remove(), () => p.remove()));
      }
      at += dur * 0.85;
    }
    pulsing++;
    Promise.all(done).finally(() => { pulsing--; });
    for (const id of r.flash) setTimeout(() => flashNode(id, ev.kind), at);
    return true;
  }
  // 鼠标悬停某条事件：它走的路径亮着，其余变暗
  function highlight(id) {
    const ev = feedList().find((e) => e.id === id);
    const r = ev && routeOf(ev);
    if (!r) return;
    stage.classList.add('hl');
    for (const s of r.segs) edgeEl[s.e].g.classList.add('rt');
    for (const n of r.nodes) nodeEl[n]?.el.classList.add('rt');
  }
  function unhighlight() {
    stage?.classList.remove('hl');
    stage?.querySelectorAll('.rt').forEach((x) => x.classList.remove('rt'));
  }

  // ---------------- 事件带 ----------------
  function evWho(e) {
    const d = D?.devices.find((x) => x.name === e.device);
    if (d) return nameOf(d);
    const t = [...(D?.extractors || []), ...(D?.reporters || [])].find((x) => x.name === e.device);
    return t ? t.label || t.name : Console.dev(e.device) || e.device;
  }
  function renderFeed() {
    if (!feedEl) return;
    const rows = feedList().slice(0, feedRows());
    feedEl.hidden = !rows.length && !proj;
    const sg = `${proj || ''}|${proj && !pjRows ? '…' : ''}|${rows.map((e) => e.id).join(',')}`;
    const ul = feedEl.querySelector('ul');
    if (sg !== feedSig && proj && !rows.length) {
      ul.innerHTML = `<li class="none">${pjRows || HK.now != null ? '近 24 小时没有新对话' : '读取中…'}</li>`;
      feedSig = sg;
    } else if (sg !== feedSig) {
      ul.innerHTML = rows.map((e) => `<li data-id="${h(e.id)}" class="${fresh.has(e.id) ? 'new' : ''}"><i style="background:rgb(${EV_RGB[e.kind]})"></i><time data-t="${h(e.t)}">${h(ago(e.t))}</time><b>${h(evWho(e))}</b><span class="ag">${NOAGENT.includes(e.tool) || !e.tool ? '' : h(Console.tool(e.tool))}</span><span class="tx">${h(e.text)}</span></li>`).join('');
      feedSig = sg;
      fresh.clear();
    } else ul.querySelectorAll('time').forEach((t) => { t.textContent = ago(t.dataset.t); });
  }
  // 选中项目近 24 小时的对话（事件带在筛选时只显示这些）
  async function loadPj() {
    const p = proj;
    if (!p) return;
    try {
      const r = await Console.api('/console/api/topology/events', { query: { project: p, limit: 12 } });
      if (proj !== p) return;
      pjRows = r.events.slice().reverse();
    } catch (e) { if (proj === p && !pjRows) pjRows = []; }
    renderFeed();
    if (hoverId && !feedList().some((e) => e.id === hoverId)) { hoverId = null; unhighlight(); }
  }
  function pickProj(name) {
    proj = proj === name ? null : name;
    pjRows = null; hoverId = null; unhighlight(); tip.hide();
    update();
    loadPj();
  }
  async function pollEvents() {
    if (evBusy || !D || HK.now != null) return; // 回放中不轮询：事件带和脉冲由回放自己放
    evBusy = true;
    try {
      const first = !evAt;
      const catchUp = Date.now() - evAt > 45e3; // 离开页面很久才回来：只补列表，不播脉冲
      const r = await Console.api('/console/api/topology/events', { query: { since: evLast, limit: 30 } });
      evAt = Date.now();
      const news = r.events.filter((e) => !evSeen.has(e.id));
      for (const e of news) { evSeen.add(e.id); if (e.t > evLast) evLast = e.t; }
      if (evSeen.size > 600) { const keep = [...evSeen].slice(-300); evSeen.clear(); keep.forEach((x) => evSeen.add(x)); }
      if (!news.length) { renderFeed(); return; }
      evRows = [...news.slice().reverse(), ...evRows].slice(0, 12);
      if (proj && news.some((e) => e.project === proj)) loadPj();
      if (!first && !catchUp && !RM.matches) for (const e of news) fresh.add(e.id);
      renderFeed();
      if (hoverId && !feedList().some((e) => e.id === hoverId)) { hoverId = null; unhighlight(); }
      if (!first) load(); // 有新事件：节点上的"最近活动"、流量数字也跟着刷新，不等 30 秒那一轮
      if (!first && !catchUp) {
        let n = 0;
        news.filter((e) => !proj || e.project === proj).slice(-5).forEach((e, i) => {
          if (n >= 5 || pulsing >= 5) return;
          setTimeout(() => { if (pulsing < 5) playPulse(e); }, i * 160);
          n++;
        });
      }
    } catch (e) { /* 事件带拉不到不打扰：下一轮再试 */ } finally { evBusy = false; }
  }

  // ---------------- 加载 ----------------
  function load(force) {
    if (loading && !force) return loading;
    const run = async () => {
      try {
        LIVE = await Console.api('/console/api/topology');
        D = HK.view ? HK.view(LIVE) : LIVE;
        lastErr = '';
        render();
      } catch (e) {
        if (!D) { stage.innerHTML = `<div class="empty">${h(e.message)}</div>`; sig = ''; }
        else if (e.message !== lastErr) Console.toast(`拓扑刷新失败：${e.message}`, 'err');
        lastErr = e.message;
      }
    };
    const p = (loading ? loading.then(run, run) : run()).finally(() => { if (loading === p) loading = null; });
    loading = p;
    return p;
  }

  // 回放用的入口
  HK.refresh = () => { if (!LIVE) return; D = HK.view ? HK.view(LIVE) : LIVE; render(); };
  HK.live = () => LIVE;
  HK.reload = () => load(true);
  HK.pulse = (ev) => playPulse(ev);
  HK.proj = () => proj;

  const FS_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
  Console.page('topology', {
    title: '拓扑',
    mount(el) {
      root = el;
      el.innerHTML = `<div class="tp"><div class="tp-bar"><div class="tp-chips"><div class="tp-prob" hidden></div><div class="tp-pj" hidden></div></div><span class="tp-lg"><i class="up"></i>写入<i class="dn"></i>读取</span><button type="button" class="tp-fsb" aria-pressed="false">${FS_ICON}</button></div>
        <section class="panel tp-panel"><div class="tp-scroll"><div class="tp-stage"></div></div><div class="tp-ev" hidden><h4>刚刚发生</h4><ul></ul></div></section></div>`;
      box = el.querySelector('.tp'); probBox = el.querySelector('.tp-prob'); scroller = el.querySelector('.tp-scroll'); stage = el.querySelector('.tp-stage'); feedEl = el.querySelector('.tp-ev'); fsBtn = el.querySelector('.tp-fsb'); pjBox = el.querySelector('.tp-pj');
      pjBox.addEventListener('click', (e) => { const b = e.target.closest('.tp-pc'); if (b) pickProj(b.dataset.p); });
      fsBtn.title = '全屏'; fsBtn.setAttribute('aria-label', '全屏');
      stage.innerHTML = '<div class="empty">读取中…</div>';
      fsBtn.addEventListener('click', toggleFs);
      probBox.addEventListener('click', (e) => {
        const b = e.target.closest('.tp-chip'); if (!b) return;
        if (b.dataset.go) Console.go(b.dataset.go);
        else if (b.dataset.node.startsWith('grp:')) toggleGroup(b.dataset.node.slice(4)); // 超时的设备在折叠的组里：展开它
        else openDrawer(b.dataset.node);
      });
      stage.addEventListener('click', (e) => { const b = e.target.closest('.tp-gl'); if (b) toggleGroup(b.dataset.g); });
      feedEl.addEventListener('mouseover', (e) => { const li = e.target.closest('li[data-id]'); if (li && li.dataset.id !== hoverId) { unhighlight(); hoverId = li.dataset.id; highlight(hoverId); } });
      feedEl.addEventListener('mouseleave', () => { hoverId = null; unhighlight(); });
      Console.every('topology', 30000, load);
      Console.every('topology', 10000, pollEvents);
      HK.mounted?.(box);
    },
    async show() { root.classList.remove('tp-paused'); await load(); return pollEvents(); },
    hide() { root.classList.add('tp-paused'); HK.hidden?.(); closeDrawer(); tip.hide(); if (fsOn()) { box.classList.remove('tp-fs'); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); } },
    resize() { if (D) render(); },
  });
})();
