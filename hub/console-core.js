/*
 * agent-memory 控制台内核：页面注册、哈希路由、公共函数。
 * 页面模块（console-*.js）只通过全局 `Console` 和这里的函数跟外壳打交道，不直接碰别的页面。
 *
 * ── 页面怎么写 ─────────────────────────────────────────────────────────────
 *   Console.page('devices', {
 *     title: '设备',                 // 可选，顶栏标题；缺省用侧栏里的名字
 *     mount(el, params) { … },       // 第一次打开这个页面时调用一次；el 此时已经可见（clientWidth 有值），在这里搭 DOM、绑事件
 *     show(params) { … },            // 可选。每次进入页面、以及页面内路由参数变化（如 #/lib/<id>）时调用；mount 之后紧接着也会调一次
 *     hide() { … },                  // 可选。离开页面时调用，停掉动画循环
 *     resize() { … },                // 可选。窗口尺寸变化（防抖后）时只对当前可见页调用，按 clientWidth 画图的页面在这里重画
 *   });
 *   · 页面 id 固定为侧栏里那 14 个：overview lib triage graph timeline projects todos convs devices agents mcp audit jobs settings
 *   · 页面隐藏时 clientWidth 为 0：所有按容器宽度画图的代码都要放在 show/resize 里画，不要在脚本加载时画。
 *   · 同一个文档里所有页面共用，元素 id 要全局唯一；在 el 里用 el.querySelector 取节点最稳。
 *   · params：{ id, args: ['2026-11-01'], arg: '2026-11-01', query: { q: '…' } }，来自 #/<id>/<arg…>?<query>
 *     已约定的子路由：timeline/<日期>、timeline/replay、triage/<proposed|dup|stale>、lib/<记忆 id>、convs/<ref>
 *
 * ── 公共函数（全部挂在 Console 上）─────────────────────────────────────────
 *   Console.page(id, def)              注册页面（见上）
 *   Console.api(path, opts)            GET/POST JSON；出错抛 Error（message 是服务端给的中文原因，e.status 是状态码）
 *                                      opts: { method, body（对象，自动转 JSON 并用 POST）, query（对象，拼到 ? 后面）, ttl（毫秒，GET 结果缓存）}
 *                                      返回值：响应是 JSON 就返回对象，否则（text/plain）返回字符串
 *   Console.go(route, query?)          跳转：'lib'、'lib/abc'、'#/timeline/2026-11-01'、go('lib', { q: '部署' })
 *   Console.badge(id, n)               设置侧栏徽标；n 为 0/空 就隐藏
 *   Console.toast(msg, kind)           右下角提示；kind: 'ok' | 'err' | 缺省为普通
 *   Console.every(id, ms, fn)          页面 id 可见（且浏览器标签页没被切走）时每 ms 毫秒调用一次 fn；离开页面自动停，回来自动恢复。可在 mount 里注册一次。
 *   Console.loadData(force?)           共享的 /browse/viz-data（60 秒内复用）；返回 Promise<DATA>。Console.data() 同步取最近一次的值
 *   Console.ready                      Promise：外壳启动完、DATA 和设备显示名已加载（失败也会 resolve），页面脚本想在启动时干点事可以 .then
 *   Console.esc(s)                     HTML 转义
 *   Console.dev(name)                  设备显示名（config.json 的 device_labels），没有就原样
 *   Console.tool(id)                   智能体显示名（claude-code → Claude Code）
 *   Console.toolOrder                  智能体的常规排序
 *   Console.color(project)             项目颜色（按累计排名固定分配）；Console.top() 是排名前 7 的项目名
 *   Console.SLOTS / SEQ / OTHER / UNWRITTEN   调色板常量
 *   Console.zh                         { type, origin, state }：记忆类型、来源方式、状态的中文名
 *   Console.date                       { WEEK, today(), localDay(ms), addDays(d,n), wd(d), weekStart(d), minutesOf(iso), hm(iso), ago(iso) }（均按东八区）
 *   Console.tip                        { show(event, html), move(event), hide() } 悬停浮层；html 里可用 .h 标题行、.r 行（里面放 <b> 色块 和 <em> 数值）
 *   Console.svg(tag, attrs, parent)    建 SVG 元素
 *   Console.countUp(node, target, fmt) 数字滚动：fmt(v) 返回 innerHTML
 *
 * 样式：全部在 console.css。面板用 <section class="panel"><div class="ph"><h2>标题</h2>…</div>…</section>，
 *   指标用 .kpis/.kpi，按钮 .btn，输入 .inp，标签 .pill(.ok/.warn/.bad/.dim)，筛选 .chips，条形 .bars，空状态 .empty。
 */
(function () {
  'use strict';
  const Console = (window.Console = {});

  // ---------------- 导航表：14 个页面全部在这里，没实现的页面会显示"建设中" ----------------
  const I = (s) => `<svg viewBox="0 0 24 24" aria-hidden="true">${s}</svg>`;
  const NAV = [
    { id: 'overview', title: '概览', icon: I('<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>') },
    { group: '记忆', items: [
      { id: 'lib', title: '记忆库', icon: I('<path d="M5 4.5h11a3 3 0 0 1 3 3V20H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h11"/>') },
      { id: 'triage', title: '待整理', icon: I('<path d="M4 7l2 2 3.5-3.5M4 16l2 2 3.5-3.5M13 7.5h7M13 16.5h7"/>') },
      { id: 'graph', title: '知识图谱', icon: I('<circle cx="6" cy="7" r="2.3"/><circle cx="18" cy="6" r="2.3"/><circle cx="12" cy="18" r="2.3"/><path d="M8 8l8-1.2M7.2 9l3.6 7M16.8 8l-3.6 8"/>') },
    ] },
    { group: '工作', items: [
      { id: 'timeline', title: '时间线', icon: I('<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>') },
      { id: 'projects', title: '项目', icon: I('<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>') },
      { id: 'todos', title: '待办', icon: I('<circle cx="12" cy="12" r="8.5"/><path d="M8.2 12.2l2.6 2.6 5-5.4"/>') },
      { id: 'convs', title: '对话存档', icon: I('<path d="M4 5.5h16v10H10l-4.5 3.5V15.5H4z"/>') },
    ] },
    { group: '接入', items: [
      { id: 'devices', title: '设备', icon: I('<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M8 20h8M12 16.5V20"/>') },
      { id: 'agents', title: '智能体', icon: I('<rect x="5" y="8" width="14" height="10" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01"/>') },
      { id: 'mcp', title: 'MCP', icon: I('<path d="M9 3v5M15 3v5M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0zM12 17v4"/>') },
    ] },
    { group: '系统', items: [
      { id: 'audit', title: '审计', icon: I('<path d="M12 3.5l7 2.8v5.2c0 4.2-2.9 7.7-7 9-4.1-1.3-7-4.8-7-9V6.3z"/><path d="M9 12l2.2 2.2L15.2 10"/>') },
      { id: 'jobs', title: '任务', icon: I('<circle cx="12" cy="13" r="7.5"/><path d="M12 9.5V13l2.4 1.6M9.5 3h5"/>') },
      { id: 'settings', title: '设置', icon: I('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>') },
    ] },
  ];
  const ALL = NAV.flatMap((n) => n.items || [n]);
  const titleOf = (id) => ALL.find((x) => x.id === id)?.title || id;

  // ---------------- 公共小函数 ----------------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  Console.esc = esc;

  const TOOL = { 'claude-code': 'Claude Code', codex: 'Codex', workbuddy: 'WorkBuddy', 'workbuddy-ai': 'WorkBuddy AI', codebuddy: 'CodeBuddy', hermes: 'Hermes', openclaw: 'OpenClaw', opencode: 'OpenCode', gemini: 'Gemini', qwen: 'Qwen', cursor: 'Cursor', windsurf: 'Windsurf', 'claude-desktop': 'Claude 桌面版' };
  Console.toolOrder = ['claude-code', 'codex', 'workbuddy', 'workbuddy-ai', 'codebuddy', 'hermes', 'openclaw', 'opencode', 'gemini', 'qwen', 'cursor', 'windsurf', 'claude-desktop'];
  Console.tool = (t) => TOOL[t] || t;
  let DEVICE = {};
  Console.dev = (d) => DEVICE[d] || d;
  Console.zh = {
    type: { preference: '偏好', feedback: '反馈', decision: '决定', status: '现状', pitfall: '坑', fact: '事实', reference: '参考' },
    origin: { native: '工具自己记的', extract: '从会话里抽的', import: '旧卡片拆分', explicit: '智能体主动写' },
    state: { active: '有效', proposed: '待审候选', superseded: '已被取代', retired: '已作废' },
  };

  Console.SLOTS = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7'].map((v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim());
  Console.OTHER = '#5b6478';
  Console.UNWRITTEN = '#39425a';
  Console.SEQ = ['#104281', '#184f95', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4', '#cde2fb'];
  let TOP = []; let COLOR = {};
  Console.top = () => TOP;
  Console.color = (p) => COLOR[p] || (p === '未写日志' || !p ? Console.UNWRITTEN : Console.OTHER);

  const NS = 'http://www.w3.org/2000/svg';
  Console.svg = (tag, attrs = {}, parent) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (parent) parent.appendChild(n);
    return n;
  };

  const D8 = 8 * 3600e3;
  const date = {
    WEEK: '日一二三四五六',
    localDay: (ms) => new Date(ms + D8).toISOString().slice(0, 10),
    today: () => date.localDay(Date.now()),
    addDays: (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400e3).toISOString().slice(0, 10),
    wd: (d) => new Date(`${d}T12:00:00Z`).getUTCDay(),
    weekStart: (d) => { let x = d; while (date.wd(x) !== 1) x = date.addDays(x, -1); return x; },
    minutesOf: (iso) => ((Date.parse(iso) + D8) % 86400e3) / 60000,
    hm: (iso) => new Date(Date.parse(iso) + D8).toISOString().slice(11, 16),
    ago: (iso) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? '刚刚' : m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.floor(m / 60)} 小时前` : `${Math.floor(m / 1440)} 天前`; },
  };
  Console.date = date;

  // 悬停浮层
  const tipEl = document.createElement('div');
  tipEl.className = 'tip';
  document.body.appendChild(tipEl);
  Console.tip = {
    show(e, html) { tipEl.innerHTML = html; tipEl.style.opacity = 1; Console.tip.move(e); },
    move(e) {
      const w = tipEl.offsetWidth; const h = tipEl.offsetHeight;
      let x = e.clientX + 14; let y = e.clientY + 14;
      if (x + w > innerWidth - 8) x = e.clientX - w - 14;
      if (y + h > innerHeight - 8) y = e.clientY - h - 14;
      tipEl.style.left = `${Math.max(4, x)}px`; tipEl.style.top = `${Math.max(4, y)}px`;
    },
    hide() { tipEl.style.opacity = 0; },
  };

  Console.countUp = (node, target, fmt) => {
    const t0 = performance.now(); const dur = 1400;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur); const e = 1 - Math.pow(1 - k, 3);
      node.innerHTML = fmt(target * e);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  // 右下角提示
  let toastBox = null;
  Console.toast = (msg, kind) => {
    if (!toastBox) { toastBox = document.createElement('div'); toastBox.className = 'toasts'; document.body.appendChild(toastBox); }
    const n = document.createElement('div');
    n.className = `toast ${kind || ''}`; n.textContent = msg;
    toastBox.appendChild(n);
    setTimeout(() => { n.style.transition = 'opacity .3s'; n.style.opacity = 0; setTimeout(() => n.remove(), 320); }, kind === 'err' ? 6000 : 3000);
  };

  // ---------------- 接口 ----------------
  const cache = new Map();
  Console.api = async function api(path, opts = {}) {
    let url = path;
    if (opts.query) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.query)) if (v !== undefined && v !== null && v !== '') q.set(k, v);
      const s = q.toString();
      if (s) url += (url.includes('?') ? '&' : '?') + s;
    }
    const init = { method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'), headers: {} };
    if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); init.headers['content-type'] = 'application/json'; }
    const cacheable = opts.ttl && init.method === 'GET';
    if (cacheable) {
      const hit = cache.get(url);
      if (hit && Date.now() - hit.t < opts.ttl) return hit.p;
    }
    const run = (async () => {
      let r;
      try { r = await fetch(url, init); } catch { throw new Error('连不上中心，请检查网络'); }
      const ct = r.headers.get('content-type') || '';
      const data = ct.includes('json') ? await r.json().catch(() => null) : await r.text();
      if (!r.ok) {
        const msg = (data && typeof data === 'object' && data.error) || (r.status === 403 ? '没有权限' : `请求失败（${r.status}）`);
        const err = new Error(msg); err.status = r.status; throw err;
      }
      return data;
    })();
    if (cacheable) { const rec = { t: Date.now(), p: run }; cache.set(url, rec); run.catch(() => { if (cache.get(url) === rec) cache.delete(url); }); }
    return run;
  };

  // 共享的总览数据：日历、河流、排行、流向图、指标都用它
  let DATA = null; let dataAt = 0; let dataP = null;
  Console.data = () => DATA;
  Console.loadData = (force) => {
    if (!force && DATA && Date.now() - dataAt < 60e3) return Promise.resolve(DATA);
    if (dataP) return dataP;
    dataP = Console.api('/browse/viz-data').then((d) => {
      DATA = d; dataAt = Date.now();
      DEVICE = d.device_labels || {};
      TOP = d.projects.filter((x) => x.p !== '未写日志' && x.p !== '其他').slice(0, 7).map((x) => x.p);
      COLOR = {}; TOP.forEach((p, i) => { COLOR[p] = Console.SLOTS[i]; });
      return d;
    }).finally(() => { dataP = null; });
    return dataP;
  };
  let readyRes;
  Console.ready = new Promise((r) => { readyRes = r; });

  // ---------------- 页面注册与路由 ----------------
  const defs = new Map(); const mounted = new Set(); const els = new Map();
  Console.page = (id, def) => { defs.set(id, def || {}); };
  let cur = null; let curParams = null; let navToken = 0;

  const tickers = new Map(); const timers = new Map();
  const startTick = (id) => {
    stopTick(id);
    timers.set(id, (tickers.get(id) || []).map(({ ms, fn }) => setInterval(() => { if (!document.hidden && cur === id) { try { const r = fn(); if (r?.catch) r.catch(() => {}); } catch (e) { console.warn(e); } } }, ms)));
  };
  const stopTick = (id) => { (timers.get(id) || []).forEach(clearInterval); timers.delete(id); };
  Console.every = (id, ms, fn) => {
    if (!tickers.has(id)) tickers.set(id, []);
    tickers.get(id).push({ ms, fn });
    if (cur === id && mounted.has(id)) startTick(id);
  };

  function parse(hash) {
    const h = String(hash || '').replace(/^#\/?/, '');
    const [pathPart, q = ''] = h.split('?');
    const args = pathPart.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
    const id = ALL.some((x) => x.id === args[0]) ? args[0] : 'overview';
    return { id, args: args.slice(1), arg: args[1] || '', query: Object.fromEntries(new URLSearchParams(q)) };
  }
  Console.go = (route, query) => {
    let h = String(route || 'overview').replace(/^#?\/?/, '');
    if (query && Object.keys(query).length) h += (h.includes('?') ? '&' : '?') + new URLSearchParams(query);
    const next = `#/${h}`;
    if (location.hash === next) dispatch(); else location.hash = next;
  };
  Console.badge = (id, n) => {
    const b = document.querySelector(`.nav a[data-id="${id}"] .bd`);
    if (!b) return;
    n = Number(n) || 0;
    b.textContent = n > 99 ? '99+' : String(n);
    b.hidden = n <= 0;
  };

  async function dispatch() {
    document.getElementById('boot')?.remove();
    const params = parse(location.hash);
    const id = params.id; const token = ++navToken;
    if (cur && cur !== id) {
      stopTick(cur);
      const od = defs.get(cur);
      try { od?.hide?.(); } catch (e) { console.warn(e); }
      els.get(cur)?.classList.remove('on');
    }
    const first = cur !== id;
    cur = id; curParams = params;
    document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('on', a.dataset.id === id));
    document.getElementById('title').textContent = defs.get(id)?.title || titleOf(id);
    document.title = `${defs.get(id)?.title || titleOf(id)} · agent-memory`;
    document.body.classList.remove('drawer');
    const el = els.get(id);
    if (first) { el.classList.remove('on'); void el.offsetWidth; el.classList.add('on'); }
    const def = defs.get(id);
    if (!def) { if (!el.firstChild) el.innerHTML = '<div class="soon"><div><b>建设中</b></div></div>'; return; }
    try {
      if (!mounted.has(id)) { mounted.add(id); await def.mount?.(el, params); }
      if (token !== navToken) return;
      await def.show?.(params);
      if (token === navToken && first) startTick(id);
    } catch (e) {
      console.error(e);
      Console.toast(`页面出错：${e.message}`, 'err');
    }
  }
  Console.visible = (id) => cur === id;

  // ---------------- 外壳 ----------------
  function buildShell() {
    const nav = document.getElementById('nav');
    nav.innerHTML = NAV.map((n) => n.items
      ? `<h4>${n.group}</h4>${n.items.map(link).join('')}`
      : link(n)).join('');
    function link(x) { return `<a href="#/${x.id}" data-id="${x.id}">${x.icon}<span>${x.title}</span><i class="bd" hidden></i></a>`; }
    const box = document.getElementById('pages');
    for (const x of ALL) {
      const s = document.createElement('section');
      s.className = 'page'; s.id = `page-${x.id}`; s.dataset.page = x.id;
      box.appendChild(s); els.set(x.id, s);
    }
    document.getElementById('menu').onclick = () => document.body.classList.toggle('drawer');
    document.getElementById('scrim').onclick = () => document.body.classList.remove('drawer');
  }

  // 背景：缓慢漂移的星点和连线（纯装饰，标签页不可见时暂停）
  function stars() {
    const c = document.getElementById('stars'); const g = c.getContext('2d');
    let w = 0; let h = 0; let pts = []; const dpr = devicePixelRatio || 1;
    const reset = () => {
      w = c.width = innerWidth * dpr; h = c.height = innerHeight * dpr;
      c.style.width = `${innerWidth}px`; c.style.height = `${innerHeight}px`;
      const n = Math.min(160, Math.round((innerWidth * innerHeight) / 16000));
      pts = Array.from({ length: n }, () => ({ x: Math.random() * w, y: Math.random() * h, vx: (Math.random() - 0.5) * 0.18 * dpr, vy: (Math.random() - 0.5) * 0.18 * dpr, r: (Math.random() * 1.3 + 0.4) * dpr }));
    };
    reset(); addEventListener('resize', reset);
    const link = 130 * dpr;
    const frame = () => {
      requestAnimationFrame(frame);
      if (document.hidden) return;
      g.clearRect(0, 0, w, h);
      for (const p of pts) { p.x = (p.x + p.vx + w) % w; p.y = (p.y + p.vy + h) % h; }
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const dx = pts[i].x - pts[j].x; const dy = pts[i].y - pts[j].y; const d = Math.hypot(dx, dy);
          if (d < link) { g.strokeStyle = `rgba(134,182,239,${0.16 * (1 - d / link)})`; g.lineWidth = dpr * 0.6; g.beginPath(); g.moveTo(pts[i].x, pts[i].y); g.lineTo(pts[j].x, pts[j].y); g.stroke(); }
        }
      }
      for (const p of pts) { g.fillStyle = 'rgba(205,226,251,.75)'; g.beginPath(); g.arc(p.x, p.y, p.r, 0, Math.PI * 2); g.fill(); }
    };
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) requestAnimationFrame(frame);
  }

  Console.start = async function start() {
    buildShell();
    stars();
    try { await Console.loadData(); } catch (e) { Console.toast(`读取数据失败：${e.message}`, 'err'); }
    readyRes();
    addEventListener('hashchange', dispatch);
    let rt;
    addEventListener('resize', () => {
      clearTimeout(rt);
      rt = setTimeout(() => { if (cur && mounted.has(cur)) { try { defs.get(cur)?.resize?.(curParams); } catch (e) { console.warn(e); } } }, 200);
    });
    if (!location.hash) history.replaceState(null, '', '#/overview');
    dispatch();
  };
})();
