/* 概览页：指标、工作星系、实时作战室、需要处理、共享记忆全景。
 * 同时在启动时拉一次"需要处理"的数字，给侧栏的待整理、待办徽标用（不用先打开那两个页面）。 */
(function () {
  const { esc, dev, tool, date, tip } = Console;
  const colorOf = (p) => Console.color(p);
  const ZH = Console.zh;
  let root = null;
  const $ = (id) => root.querySelector(`#${id}`);

  // ---------------- 需要处理（也供侧栏徽标）----------------
  let ATTN = null; let attnAt = 0; let attnP = null;
  const STALE_SYNC_H = 3;
  // 90 秒内复用上一次的结果，并发请求合并
  function loadAttention() {
    if (ATTN && Date.now() - attnAt < 90e3) return Promise.resolve(ATTN);
    if (!attnP) attnP = fetchAttention().finally(() => { attnP = null; });
    return attnP;
  }
  async function fetchAttention() {
    const [md, td, ag] = await Promise.all([
      Console.api('/browse/manage-counts').catch(() => null),
      Console.api('/browse/todos').catch(() => null),
      Console.api('/browse/viz-agents', { ttl: 20000 }).catch(() => null),
    ]);
    const prev = ATTN || {};
    ATTN = {
      proposed: md ? md.proposed : prev.proposed,
      dup: md ? md.duplicates : prev.dup,
      stale: md ? md.stale : prev.stale,
      todos: td ? td.items.length : prev.todos,
      unsynced: ag ? ag.devices.filter((x) => !x.legacy && (!x.last_seen || Date.now() - Date.parse(x.last_seen) > STALE_SYNC_H * 3600e3)).length : prev.unsynced,
    };
    Console.badge('triage', (ATTN.proposed || 0) + (ATTN.dup || 0) + (ATTN.stale || 0));
    Console.badge('todos', ATTN.todos || 0);
    attnAt = Date.now();
    return ATTN;
  }
  // 启动 5 秒后再拉，免得跟首屏抢中心的 CPU
  Console.ready.then(() => {
    setTimeout(loadAttention, 5000);
    setInterval(() => { if (!document.hidden) loadAttention(); }, 300000);
  });
  function renderAttention() {
    const a = ATTN || {};
    const items = [
      ['triage/proposed', a.proposed, '待审候选'],
      ['triage/dup', a.dup, '疑似重复'],
      ['triage/stale', a.stale, '过期现状'],
      ['todos', a.todos, '没收尾的事'],
      ['devices', a.unsynced, '没同步的设备'],
    ];
    $('attn').innerHTML = items.map(([r, n, l]) => `<a href="#/${r}" class="${n > 0 ? 'hot' : ''}"><b>${n ?? '–'}</b>${l}</a>`).join('');
  }

  // ---------------- 指标 ----------------
  function renderKpis() {
    const D = Console.data(); if (!D) return;
    const k = D.kpi;
    const items = [
      [k.sessions, (v) => Math.round(v).toLocaleString(), '个会话'],
      [k.messages, (v) => `${(v / 1e4).toFixed(1)}<small>万</small>`, '条你和智能体说的话'],
      [k.chars, (v) => `${(v / 1e6).toFixed(1)}<small>M 字</small>`, '对话原文（长期存档）'],
      [k.days, (v) => `${Math.round(v)}<small>天</small>`, '有工作日志的日子'],
      [D.memories.total, (v) => Math.round(v).toLocaleString(), '条有效记忆'],
      [k.devices, (v) => `${Math.round(v)}<small>台 · ${k.tools} 种</small>`, '机器 · 智能体'],
    ];
    $('kpis').innerHTML = items.map(() => '<div class="kpi"><div class="v">0</div><div class="l"></div></div>').join('');
    [...$('kpis').children].forEach((n, i) => { n.querySelector('.l').textContent = items[i][2]; Console.countUp(n.querySelector('.v'), items[i][0], items[i][1]); });
  }

  // ---------------- 工作星系（canvas 伪 3D：每个会话一颗星，按项目聚成旋涡星团）----------------
  const GAL = { yaw: 0.6, pitch: 0.42, zoom: 1, drag: null, pts: [], proj: [], hover: -1, labels: [], bg: [], loadedAt: 0 };
  let galCv; let galG;
  const dprOf = () => devicePixelRatio || 1;
  const clusterColor = (c) => (c === '其他' ? Console.css('--other-lt') : colorOf(c));
  const blend = () => (Console.theme?.resolved() === 'light' ? 'source-over' : 'lighter'); // 浅底上不能用叠加（lighter 会洗成一片白）
  function buildGalaxy(data) {
    const TOP = Console.top();
    const clusters = [...TOP, '其他'];
    const groups = new Map(clusters.map((c) => [c, []]));
    for (const r of data.rows) groups.get(TOP.includes(r[1]) ? r[1] : '其他').push(r);
    const maxN = Math.max(...[...groups.values()].map((a) => a.length), 1);
    const gauss = () => { let u = 0; let v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    GAL.pts = []; GAL.labels = [];
    clusters.forEach((c, ci) => {
      const list = groups.get(c).sort((a, b) => String(a[4]).localeCompare(String(b[4])));
      const isCore = c === '其他';
      const a0 = (ci / Math.max(1, clusters.length - 1)) * Math.PI * 2;
      const R = isCore ? 0 : 400;
      const cx = Math.cos(a0) * R; const cz = Math.sin(a0) * R;
      const size = 34 + 100 * Math.sqrt(list.length / maxN);
      const color = clusterColor(c);
      GAL.labels.push({ c, n: list.length, x: cx, y: -size * 0.35 - 18, z: cz, color });
      list.forEach((r, k) => {
        const t = list.length > 1 ? k / (list.length - 1) : 0;
        const arm = k % 2; const ang = Math.sqrt(t) * Math.PI * 3.2 + arm * Math.PI + a0;
        const rad = 6 + size * Math.sqrt(t) + gauss() * (3 + 6 * t);
        GAL.pts.push({ x: cx + Math.cos(ang) * rad + gauss() * 4, y: gauss() * (10 * (1 - t) + 3), z: cz + Math.sin(ang) * rad + gauss() * 4,
          color, cl: c, s: 0.45 + Math.log2((r[5] || 1) + 1) * 0.2, r });
      });
    });
    galLegend();
    GAL.loadedAt = Date.now();
  }
  const galLegend = () => { $('galLegend').innerHTML = GAL.labels.map((l) => `<span><b style="background:${l.color}"></b>${esc(l.c)} ${l.n}</span>`).join(''); };
  // 换主题：星点、簇标签、图例按簇名重新取色（位置不动）
  function recolorGalaxy() {
    for (const p of GAL.pts) p.color = clusterColor(p.cl);
    for (const l of GAL.labels) l.color = clusterColor(l.c);
    if (GAL.labels.length) galLegend();
  }
  async function loadGalaxy() { buildGalaxy(await Console.api('/browse/viz-galaxy')); }
  const F = 900;
  function drawGalaxy() {
    const g = galG; const dpr = dprOf(); const W = galCv.width; const H = galCv.height;
    if (!GAL.drag) GAL.yaw += 0.0018;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    for (const b of GAL.bg) { g.fillStyle = Console.rgba('--star-rgb', b.a * 0.5); g.beginPath(); g.arc(b.x * W, b.y * H, b.r * dpr, 0, 6.283); g.fill(); }
    const cy = Math.cos(GAL.yaw); const sy = Math.sin(GAL.yaw); const cp = Math.cos(GAL.pitch); const sp = Math.sin(GAL.pitch);
    const k = Math.min(W * 0.62, H) / 900 * GAL.zoom;
    const project = (p) => {
      const x1 = p.x * cy + p.z * sy; const z1 = -p.x * sy + p.z * cy;
      const y2 = p.y * cp - z1 * sp; const z2 = p.y * sp + z1 * cp;
      const sc = F / (F + z2) * k;
      return [W / 2 + x1 * sc, H * 0.46 + y2 * sc, sc, z2];
    };
    g.globalCompositeOperation = blend();
    GAL.proj = new Array(GAL.pts.length);
    for (let i = 0; i < GAL.pts.length; i++) {
      const p = GAL.pts[i]; const [x, y, sc] = project(p);
      GAL.proj[i] = [x, y];
      const rr = p.s * sc * dpr * 1.6;
      g.globalAlpha = 0.07; g.fillStyle = p.color; g.beginPath(); g.arc(x, y, rr * 3.2, 0, 6.283); g.fill();
      g.globalAlpha = i === GAL.hover ? 1 : 0.75; g.beginPath(); g.arc(x, y, i === GAL.hover ? rr * 2.2 : rr, 0, 6.283); g.fill();
    }
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    const fam = '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    g.textAlign = 'center';
    for (const l of GAL.labels) {
      const [x, y] = project(l);
      g.font = `${12 * dpr}px ${fam}`; g.fillStyle = Console.rgba('--text-rgb', 0.92); g.fillText(l.c, x, y - 6 * dpr);
      g.font = `${10.5 * dpr}px ${fam}`; g.fillStyle = Console.rgba('--text2-rgb', 0.75); g.fillText(`${l.n} 个会话`, x, y + 8 * dpr);
    }
  }
  function initGalaxy() {
    galCv = $('galaxy'); galG = galCv.getContext('2d');
    GAL.bg = Array.from({ length: 260 }, () => ({ x: Math.random(), y: Math.random(), r: Math.random() * 1.1 + 0.2, a: Math.random() * 0.6 + 0.2 }));
    const cv = galCv; const dpr = dprOf();
    const at = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr]; };
    cv.addEventListener('mousedown', (e) => { GAL.drag = { x: e.clientX, y: e.clientY, yaw: GAL.yaw, pitch: GAL.pitch, moved: false }; });
    addEventListener('mouseup', () => { setTimeout(() => { GAL.drag = null; }, 0); });
    cv.addEventListener('mousemove', (e) => {
      if (GAL.drag) {
        const dx = e.clientX - GAL.drag.x; const dy = e.clientY - GAL.drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) GAL.drag.moved = true;
        GAL.yaw = GAL.drag.yaw + dx * 0.006; GAL.pitch = Math.max(-1.3, Math.min(1.3, GAL.drag.pitch + dy * 0.004));
        tip.hide(); return;
      }
      const [mx, my] = at(e); let best = -1; let bd = (9 * dpr) ** 2;
      for (let i = 0; i < GAL.proj.length; i++) { const q = GAL.proj[i]; if (!q) continue; const d = (q[0] - mx) ** 2 + (q[1] - my) ** 2; if (d < bd) { bd = d; best = i; } }
      GAL.hover = best;
      if (best < 0) { tip.hide(); return; }
      const r = GAL.pts[best].r;
      tip.show(e, `<div class="h">${esc(r[6] || '（无标题）')}</div><div class="r"><b style="background:${GAL.pts[best].color}"></b>${esc(r[1] || '其他')}<em>${esc(r[4])}</em></div><div class="r">${esc(dev(r[3]))} · ${esc(tool(r[2]))}<em>${r[5]} 条</em></div><div class="r" style="color:var(--text-muted)">点一下看这天</div>`);
    });
    cv.addEventListener('mouseleave', () => { GAL.hover = -1; tip.hide(); });
    cv.addEventListener('click', () => { if (GAL.drag?.moved) return; if (GAL.hover >= 0) { const r = GAL.pts[GAL.hover].r; if (r[4]) Console.go(`timeline/${r[4]}`); } });
    cv.addEventListener('wheel', (e) => { e.preventDefault(); GAL.zoom = Math.max(0.5, Math.min(3, GAL.zoom * (e.deltaY < 0 ? 1.1 : 0.9))); }, { passive: false });
  }

  // ---------------- 实时作战室：中心 + 各台机器，正在干活的机器有光点流向中心 ----------------
  const LIVE = { data: null, nodes: [], particles: [], t: 0 };
  let liveCv; let liveG;
  async function loadLive() {
    let d;
    try { d = await Console.api('/browse/viz-live'); } catch { return; }
    LIVE.data = d;
    const names = Object.keys(d.sync).sort((a, b) => (dev(a) !== a ? 0 : 1) - (dev(b) !== b ? 0 : 1) || a.localeCompare(b));
    LIVE.nodes = names.map((n, i) => {
      const tools = Object.entries(d.devices[n] || {}).sort((a, b) => String(b[1].last).localeCompare(String(a[1].last)));
      const active = tools.filter(([, t]) => t.age <= 20);
      const syncAge = d.sync[n].last_seen ? (Date.now() - Date.parse(d.sync[n].last_seen)) / 60000 : 1e9;
      return { n, i, total: names.length, tools, active, syncOk: syncAge < 15, syncAge, pr: active[0] ? (active[0][1].project || '其他') : '', color: active[0] ? colorOf(active[0][1].project || '其他') : Console.OTHER };
    });
    $('liveBar').innerHTML = `<div><b>${d.today.segments}</b> <span>段会话（今天）</span></div><div><b>${d.today.messages.toLocaleString()}</b> <span>条消息</span></div><div><b>${LIVE.nodes.filter((x) => x.active.length).length}</b><span> / ${LIVE.nodes.length} 台正在干活</span></div>`;
    $('feed').innerHTML = d.recent.map((r) => `<div><i>${esc(date.ago(r.t))}</i><span>${esc(dev(r.device))} · ${esc(tool(r.tool))} <em>「${esc(r.title)}」</em></span></div>`).join('');
  }
  function drawLive() {
    if (!LIVE.nodes.length) return;
    const g = liveG; const dpr = dprOf(); const cv = liveCv;
    LIVE.t += 1;
    const W = cv.width; const H = cv.height; const cx = W / 2; const cyy = H / 2;
    g.clearRect(0, 0, W, H);
    const rx = W * 0.38; const ry = H * 0.36;
    const pos = LIVE.nodes.map((nd) => { const a = (nd.i / nd.total) * Math.PI * 2 - Math.PI / 2; return [cx + Math.cos(a) * rx, cyy + Math.sin(a) * ry]; });
    LIVE.nodes.forEach((nd, i) => {
      const [x, y] = pos[i];
      g.strokeStyle = nd.active.length ? `${nd.color}aa` : Console.rgba('--slate-rgb', 0.16); g.lineWidth = (nd.active.length ? 1.6 : 1) * dpr;
      g.setLineDash(nd.syncOk ? [] : [4 * dpr, 4 * dpr]);
      g.beginPath(); g.moveTo(x, y); g.lineTo(cx, cyy); g.stroke();
      g.setLineDash([]);
      if (nd.active.length && Math.random() < 0.12) LIVE.particles.push({ i, t: 0, v: 0.008 + Math.random() * 0.01, c: nd.color });
    });
    g.globalCompositeOperation = blend();
    LIVE.particles = LIVE.particles.filter((p) => p.t < 1);
    for (const p of LIVE.particles) {
      p.t += p.v; const [x, y] = pos[p.i] || [cx, cyy];
      const px = x + (cx - x) * p.t; const py = y + (cyy - y) * p.t;
      g.fillStyle = p.c; g.globalAlpha = 0.9 * (1 - p.t * 0.6); g.beginPath(); g.arc(px, py, 2.4 * dpr, 0, 6.283); g.fill();
      g.globalAlpha = 0.2; g.beginPath(); g.arc(px, py, 7 * dpr, 0, 6.283); g.fill();
    }
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    const fam = '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    const pulse = 1 + 0.08 * Math.sin(LIVE.t / 18);
    const grd = g.createRadialGradient(cx, cyy, 0, cx, cyy, 46 * dpr * pulse);
    grd.addColorStop(0, Console.rgba('--hub-core-rgb', 0.95)); grd.addColorStop(0.35, Console.rgba('--hub-glow-rgb', 0.55)); grd.addColorStop(1, Console.rgba('--hub-glow-rgb', 0));
    g.fillStyle = grd; g.beginPath(); g.arc(cx, cyy, 46 * dpr * pulse, 0, 6.283); g.fill();
    g.font = `600 ${12 * dpr}px ${fam}`; g.textAlign = 'center'; g.fillStyle = Console.css('--hub-text');
    g.fillText('共享记忆', cx, cyy - 2 * dpr);
    g.font = `${10 * dpr}px ${fam}`; g.fillText(`${LIVE.data?.memories || ''} 条`, cx, cyy + 11 * dpr);
    LIVE.nodes.forEach((nd, i) => {
      const [x, y] = pos[i];
      if (nd.active.length) {
        const rr = (12 + 6 * Math.sin(LIVE.t / 12 + i)) * dpr;
        g.strokeStyle = nd.color; g.globalAlpha = 0.5; g.lineWidth = 2 * dpr; g.beginPath(); g.arc(x, y, rr + 6 * dpr, 0, 6.283); g.stroke(); g.globalAlpha = 1;
      }
      g.fillStyle = nd.active.length ? nd.color : Console.css('--node-idle'); g.beginPath(); g.arc(x, y, 9 * dpr, 0, 6.283); g.fill();
      g.fillStyle = nd.syncOk ? Console.css('--ok') : Console.css('--bad'); g.beginPath(); g.arc(x + 8 * dpr, y - 8 * dpr, 3 * dpr, 0, 6.283); g.fill();
      const below = y > cyy;
      g.textAlign = 'center'; g.fillStyle = Console.css('--text-primary'); g.font = `600 ${11.5 * dpr}px ${fam}`;
      const ly = below ? y + 24 * dpr : y - 18 * dpr;
      g.fillText(dev(nd.n), x, ly);
      g.font = `${10.5 * dpr}px ${fam}`; g.fillStyle = Console.rgba('--text2-rgb', 0.9);
      const t0 = nd.tools[0];
      const sub = nd.active.length ? `${tool(nd.active[0][0])} · ${nd.active[0][1].project || '在干活'}` : t0 ? `${tool(t0[0])} ${date.ago(t0[1].last)}` : (nd.syncOk ? '在线' : '没同步');
      g.fillText(sub, x, ly + (below ? 13 : -13) * dpr);
    });
  }

  // ---------------- 共享记忆全景 ----------------
  function renderMemory(d) {
    const m = d.memory;
    $('memHint').textContent = `最近 7 天新增 ${m.added7} 条 · 最近 7 天智能体查了 ${m.calls7} 次`;
    const SLOTS = Console.SLOTS;
    const donut = (pairs) => {
      const total = pairs.reduce((a, x) => a + x[1], 0) || 1; let a0 = -Math.PI / 2; const R = 54; const r = 34; const cx = 64; const cy = 64;
      const pt = (ang, rad) => `${cx + Math.cos(ang) * rad},${cy + Math.sin(ang) * rad}`;
      const arcs = pairs.map((x, i) => {
        const a1 = a0 + (x[1] / total) * Math.PI * 2; const large = a1 - a0 > Math.PI ? 1 : 0; const g = 0.012;
        const d2 = `M${pt(a0 + g, R)} A${R},${R} 0 ${large} 1 ${pt(a1 - g, R)} L${pt(a1 - g, r)} A${r},${r} 0 ${large} 0 ${pt(a0 + g, r)} Z`;
        a0 = a1;
        return `<path d="${d2}" fill="${SLOTS[i % 7]}"><title>${esc(ZH.origin[x[0]] || x[0])}：${x[1]}</title></path>`;
      }).join('');
      return `<svg width="128" height="128" viewBox="0 0 128 128" style="flex:none;filter:drop-shadow(0 0 8px var(--glow))">${arcs}</svg>`;
    };
    const bars = (pairs, label, color) => { const max = (pairs[0] && pairs[0][1]) || 1; return pairs.map((x) => `<div class="b"><span class="lab">${esc(label(x[0]))}</span><span class="track"><span class="fill" style="background:${color};color:${color};width:${(100 * x[1]) / max}%"></span></span><span class="n">${x[1]}</span></div>`).join(''); };
    const srcLabel = (k) => { const ab = k.split('/'); return `${dev(ab[0])} · ${tool(ab[1])}`; };
    $('mem').innerHTML = `<div><h3>有效记忆</h3><div class="tot">${m.total.toLocaleString()}</div>`
      + `<div class="st">${m.byState.map((x) => `<span class="pill ${x[0] === 'active' ? 'ok' : x[0] === 'proposed' ? 'warn' : 'dim'}">${esc(ZH.state[x[0]] || x[0])} ${x[1]}</span>`).join('')}</div>`
      + `<div style="display:flex;gap:12px;align-items:center">${donut(m.byOrigin)}<div class="legend" style="flex-direction:column;gap:4px">${m.byOrigin.map((x, i) => `<span><b style="background:${SLOTS[i % 7]}"></b>${esc(ZH.origin[x[0]] || x[0])} ${x[1]}</span>`).join('')}</div></div></div>`
      + `<div class="bars"><h3>按类型</h3>${bars(m.byType, (k) => ZH.type[k] || k, 'var(--s1)')}<h3 style="margin-top:12px">按项目</h3>${bars(m.byProject.filter((x) => x[0] !== '（无）').slice(0, 7), (k) => k, 'var(--s7)')}</div>`
      + `<div class="bars"><h3>按来源（机器 · 智能体）</h3>${bars(m.bySource.slice(0, 12), srcLabel, 'var(--s3)')}</div>`
      + `<div class="rec"><h3>最近更新的记忆</h3>${m.recent.map((e) => `<div><i>${esc(ZH.type[e.type] || e.type)}</i><span>${esc(e.title)}<em>${esc(e.project ? `${e.project} · ` : '')}${esc(date.ago(e.updated))}</em></span></div>`).join('')}</div>`;
  }
  async function loadMemory() { try { renderMemory(await Console.api('/browse/viz-agents', { ttl: 20000 })); } catch (e) { console.warn(e); } }

  // ---------------- 页面 ----------------
  let raf = 0;
  const fit = () => {
    const dpr = dprOf();
    for (const cv of [galCv, liveCv]) { if (cv) { cv.width = cv.clientWidth * dpr; cv.height = cv.clientHeight * dpr; } }
  };
  const loop = () => { raf = requestAnimationFrame(loop); if (document.hidden) return; drawGalaxy(); drawLive(); };

  Console.page('overview', {
    mount(el) {
      root = el;
      el.innerHTML = `
        <section class="kpis" id="kpis"></section>
        <div class="row2 hero">
          <section class="panel">
            <div class="ph"><h2>工作星系</h2></div>
            <div class="legend" id="galLegend"></div>
            <canvas id="galaxy"></canvas>
          </section>
          <section class="panel">
            <div class="ph"><h2>实时作战室</h2></div>
            <div class="livebar" id="liveBar"></div>
            <canvas id="live"></canvas>
            <div class="feed" id="feed"></div>
          </section>
        </div>
        <section class="panel">
          <div class="ph"><h2>需要处理</h2></div>
          <div class="attn" id="attn"></div>
        </section>
        <section class="panel">
          <div class="ph"><h2>共享记忆全景</h2><span class="hint" id="memHint"></span></div>
          <div class="memwrap" id="mem"><div class="empty">读取中…</div></div>
        </section>`;
      liveCv = $('live'); liveG = liveCv.getContext('2d');
      initGalaxy();
      Console.every('overview', 30000, loadLive);
      Console.every('overview', 60000, loadMemory);
      Console.every('overview', 120000, () => loadAttention().then(renderAttention));
      Console.every('overview', 300000, loadGalaxy);
    },
    show() {
      fit();
      renderAttention();
      Console.loadData().then(renderKpis).catch(() => {});
      loadAttention().then(renderAttention);
      loadLive(); loadMemory();
      if (Date.now() - GAL.loadedAt > 300000) loadGalaxy().catch(() => {});
      cancelAnimationFrame(raf);
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches) raf = requestAnimationFrame(loop); else { drawGalaxy(); drawLive(); }
    },
    hide() { cancelAnimationFrame(raf); raf = 0; GAL.hover = -1; tip.hide(); },
    resize() { fit(); },
    theme() {
      recolorGalaxy();
      for (const nd of LIVE.nodes) nd.color = nd.pr ? colorOf(nd.pr) : Console.OTHER;
      loadMemory();
      if (!raf) { drawGalaxy(); drawLive(); }
    },
  });
})();
