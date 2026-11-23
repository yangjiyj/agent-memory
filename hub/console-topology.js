/* 拓扑页：设备 → 认证网关 → 中心 → 存储 / 抽取机 / 向量服务 / 报表 / 浏览器，一张会动的实时图。
 *
 * 数据：GET /console/api/topology，页面可见时每 30 秒刷新一次。
 * 结构：节点是 HTML（文字清晰、能放标签），连线是 SVG；光点用 stroke-dasharray + CSS 动画做，
 *   页面里没有 JS 动画循环，离开页面或标签页切走时给容器加 tp-paused 就全停了。
 * 刷新：布局没变（设备、网关、各组件配没配都没变）就只更新节点文字、状态类和连线状态，不重画；窗口变宽窄才重排。
 */
(function () {
  'use strict';
  const h = Console.esc;
  const { date, tip } = Console;
  const FRESH = 15 * 60e3; // 这个时间内同步过：连线流动
  const ACTIVE = 60 * 60e3; // 抽取机、报表这个时间内有活动：连线流动
  const MIN_W = 980; // 比这窄就横向滚动
  const RGB = { dev: '57,135,229', gate: '36,196,138', hub: '144,133,233', repo: '232,170,60', arc: '232,170,60', ext: '221,96,140', vec: '80,200,230', rep: '134,182,239', web: '205,226,251' };
  const GROUP = { gateway: 0, join: 1, token: 2 };
  const IDENT = { gateway: '网关', join: '加入码', token: '令牌' };
  const VIA = { gateway: '网关', config: '控制台配置' };
  const GOTO = { hub: 'mcp', repo: 'jobs', arc: 'jobs', ext: 'jobs', vec: 'jobs' };
  const GOTO_TEXT = { dev: '设备页', hub: 'MCP 页', repo: '任务页', arc: '任务页', ext: '任务页', vec: '任务页' };

  let root; let stage; let scroller; let probBox; let svg; let defs; let edgeLayer;
  let D = null; let LAY = null; let sig = ''; let uid = 0;
  let nodeEl = {}; let edgeEl = {}; let drawerId = null; let drawerEl = null; let loading = null; let lastErr = '';

  const fmtN = (n) => Number(n || 0).toLocaleString('zh-CN');
  const abs = (iso) => (iso ? new Date(Date.parse(iso) + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : '');
  const ago = (iso) => (iso ? date.ago(iso) : '从未');
  const age = (iso) => (iso ? Date.now() - Date.parse(iso) : Infinity);
  const nameOf = (d) => d.label || Console.dev(d.name) || d.name;
  const toolOrder = (t) => { const i = Console.toolOrder.indexOf(t); return i < 0 ? 99 : i; };

  // ---------------- 状态 ----------------
  function devState(d) {
    if (d.paused) return 'paused';
    if (d.stale) return 'stale';
    if (d.live) return 'live';
    return age(d.last_seen) < FRESH ? 'ok' : 'idle';
  }
  const DEV_TEXT = { paused: '已暂停', stale: '超时没同步', live: '正在干活', ok: '同步中', idle: '空闲' };

  // 巡检问题归到节点上
  function problemNode(key) {
    let m;
    if ((m = /^stale:(.+)$/.exec(key)) || (m = /^guard:([^/]+)\//.exec(key))) return D.devices.some((d) => d.name === m[1]) ? `dev:${m[1]}` : 'hub';
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

  function layout(W, availH) {
    const gateOn = D.gate.enabled;
    const devs = D.devices.slice().sort((a, b) => (gateOn ? (GROUP[a.identity] ?? 3) - (GROUP[b.identity] ?? 3) : 0) || a.name.localeCompare(b.name));
    const viaGate = (d) => gateOn && d.identity === 'gateway';
    const n = devs.length;
    const two = n > 10;
    const nh = two ? 44 : n > 6 ? 52 : 62;
    const gap = two ? 8 : 10;
    const rows = two ? Math.ceil(n / 2) : Math.max(n, 1);
    const devW = two ? 172 : 236; const colGap = 16;
    const leftW = two ? devW * 2 + colGap : devW;
    const stagger = two ? (nh + gap) / 2 : 0;
    const blockH = rows * nh + (rows - 1) * gap + stagger;
    const PAD = 24;
    const H = Math.round(Math.max(580, Math.min(availH, 900), blockH + PAD * 2));
    const gateW = 124; const gateH = 96; const hubW = 214; const hubH = 236; const rightW = 228; const rightH = 84;
    const free = W - 2 * PAD - (leftW + gateW + hubW + rightW);
    const gx = Math.max(60, free / 3);
    const xg = PAD + leftW + gx; const xh = xg + gateW + gx; const xr = xh + hubW + gx;
    const top0 = (H - blockH) / 2;
    const hubCY = H / 2 - 36;
    const nodes = {};
    devs.forEach((d, i) => {
      const col = two ? (i < rows ? 0 : 1) : 0; const row = two ? (i < rows ? i : i - rows) : i;
      nodes[`dev:${d.name}`] = { kind: 'dev', x: PAD + col * (devW + colGap), y: top0 + row * (nh + gap) + (two && col === 0 ? stagger : 0), w: devW, h: nh, two, via: viaGate(d) };
    });
    nodes.hub = { kind: 'hub', x: xh, y: hubCY - hubH / 2, w: hubW, h: hubH };
    const sw = 118; const sx = xh + hubW / 2 - sw - 6; const sy = hubCY + hubH / 2 + 56;
    nodes.repo = { kind: 'repo', x: sx, y: sy, w: sw, h: 76 };
    nodes.arc = { kind: 'arc', x: sx + sw + 12, y: sy, w: sw, h: 76 };
    const gr = Math.max(18, Math.min(56, (H - 2 * PAD - 4 * rightH) / 3));
    let ry = hubCY - (4 * rightH + 3 * gr) / 2;
    ry = Math.max(PAD, Math.min(ry, H - PAD - (4 * rightH + 3 * gr)));
    ['ext', 'vec', 'rep', 'web'].forEach((id, i) => { nodes[id] = { kind: id, x: xr, y: ry + i * (rightH + gr), w: rightW, h: rightH }; });

    // 网关放在不挡绕行连线的位置：试每个高度，数绕行曲线有几个采样点落进网关框里
    const bypass = devs.filter((d) => !viaGate(d));
    const viaList = devs.filter(viaGate);
    const cyOf = (id) => nodes[id].y + nodes[id].h / 2;
    const rightX = (id) => nodes[id].x + nodes[id].w;
    const guess = bypass.map((d) => [rightX(`dev:${d.name}`), cyOf(`dev:${d.name}`)]);
    const want = viaList.length ? viaList.reduce((a, d) => a + cyOf(`dev:${d.name}`), 0) / viaList.length : hubCY;
    let best = null;
    for (let cy = PAD + gateH / 2; cy <= H - PAD - gateH / 2; cy += 8) {
      let hit = 0;
      for (const [x1, y1] of guess) for (let k = 1; k < 28; k++) {
        const [px, py] = bezAt(x1, y1, xh, hubCY, k / 28);
        if (px > xg - 10 && px < xg + gateW + 10 && py > cy - gateH / 2 - 10 && py < cy + gateH / 2 + 10) hit++;
      }
      const cost = hit * 1000 + Math.abs(cy - want);
      if (!best || cost < best.cost) best = { cy, cost };
    }
    nodes.gate = { kind: 'gate', x: xg, y: best.cy - gateH / 2, w: gateW, h: gateH };

    // 中心左边的接入点：按来源的高度从上到下排，连线不交叉
    const srcs = [...bypass.map((d) => ({ id: `dev:${d.name}`, y: cyOf(`dev:${d.name}`) })), ...(gateOn ? [{ id: 'gate', y: best.cy }] : [])].sort((a, b) => a.y - b.y);
    const sp = Math.min(14, (hubH - 52) / Math.max(1, srcs.length - 1));
    const anchor = {};
    srcs.forEach((s, i) => { anchor[s.id] = hubCY + (i - (srcs.length - 1) / 2) * sp; });

    const edges = [];
    const gs = viaList.length;
    viaList.forEach((d, i) => {
      const id = `dev:${d.name}`; const g = nodes.gate;
      edges.push({ id: `e:${id}`, x1: rightX(id), y1: cyOf(id), x2: g.x, y2: gs === 1 ? best.cy : g.y + 16 + (i * (gateH - 32)) / (gs - 1), from: 'dev', to: 'gate' });
    });
    bypass.forEach((d) => {
      const id = `dev:${d.name}`;
      edges.push({ id: `e:${id}`, x1: rightX(id), y1: cyOf(id), x2: xh, y2: anchor[id], from: 'dev', to: 'hub' });
    });
    if (gateOn) edges.push({ id: 'e:gate', x1: xg + gateW, y1: best.cy, x2: xh, y2: anchor.gate, from: 'gate', to: 'hub' });
    ['ext', 'vec', 'rep', 'web'].forEach((id, i) => {
      edges.push({ id: `e:${id}`, x1: xh + hubW, y1: hubCY + (i - 1.5) * 18, x2: xr, y2: cyOf(id), from: 'hub', to: id });
    });
    for (const id of ['repo', 'arc']) {
      const n2 = nodes[id];
      edges.push({ id: `e:${id}`, x1: n2.x + n2.w / 2, y1: hubCY + hubH / 2, x2: n2.x + n2.w / 2, y2: n2.y, from: 'hub', to: id, straight: true });
    }
    const W2 = Math.max(W, xr + rightW + PAD);
    const sigStr = JSON.stringify([Math.round(W2), H, gateOn, !!D.extractors.length, !!D.reporters.length, D.vectors.enabled, devs.map((d) => [d.name, viaGate(d)])]);
    return { W: W2, H, nodes, edges, devs, sig: sigStr };
  }

  // ---------------- 建 DOM ----------------
  function build() {
    stage.innerHTML = '';
    nodeEl = {}; edgeEl = {};
    stage.style.width = `${LAY.W}px`; stage.style.height = `${LAY.H}px`;
    svg = Console.svg('svg', { class: 'tp-svg', width: LAY.W, height: LAY.H, viewBox: `0 0 ${LAY.W} ${LAY.H}`, 'aria-hidden': 'true' }, stage);
    defs = Console.svg('defs', {}, svg);
    edgeLayer = Console.svg('g', {}, svg);
    for (const e of LAY.edges) {
      const g = Console.svg('g', { class: 'tp-e idle' }, edgeLayer);
      g.style.setProperty('--cr', RGB[e.from === 'dev' ? 'dev' : e.from]);
      g.style.animationDelay = '0s';
      const gid = `tp-g${++uid}`;
      const lg = Console.svg('linearGradient', { id: gid, gradientUnits: 'userSpaceOnUse', x1: e.x1, y1: e.y1, x2: e.x2 + (e.straight ? 0.01 : 0), y2: e.y2 }, defs);
      Console.svg('stop', { offset: 0, 'stop-color': `rgb(${RGB[e.from]})` }, lg);
      Console.svg('stop', { offset: 1, 'stop-color': `rgb(${RGB[e.to]})` }, lg);
      const d = e.straight ? `M${e.x1} ${e.y1}L${e.x2} ${e.y2}` : bez(e.x1, e.y1, e.x2, e.y2);
      const base = Console.svg('path', { d, class: 'tp-base', stroke: `url(#${gid})` }, g);
      const halo = Console.svg('path', { d, class: 'tp-dots tp-halo' }, g);
      const core = Console.svg('path', { d, class: 'tp-dots tp-core' }, g);
      const delay = `-${(Math.random() * 3).toFixed(2)}s`;
      halo.style.animationDelay = delay; core.style.animationDelay = delay;
      edgeEl[e.id] = { g, state: 'idle' };
    }
    for (const [id, n] of Object.entries(LAY.nodes)) {
      const el = document.createElement('div');
      el.className = `tp-n tp-${n.kind}`;
      el.dataset.id = id;
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      Object.assign(el.style, { left: `${n.x}px`, top: `${n.y}px`, width: `${n.w}px`, height: `${n.h}px` });
      el.style.setProperty('--cr', RGB[n.kind]);
      el.addEventListener('mouseenter', (ev) => tip.show(ev, tipOf(id)));
      el.addEventListener('mousemove', (ev) => tip.move(ev));
      el.addEventListener('mouseleave', () => tip.hide());
      el.addEventListener('click', () => openDrawer(id));
      el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openDrawer(id); } });
      stage.appendChild(el);
      nodeEl[id] = { el, html: '', cls: '' };
    }
  }

  // ---------------- 节点内容 ----------------
  const dot = (k) => `<i class="tp-dot ${k}"></i>`;
  // 标签按宽度放：放不下的折成 +N（中文按 11px、英文按 6px 估）
  const tagW = (t) => [...t].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 11 : 6), 0) + 18;
  function agentTags(d, room) {
    const list = d.agents.slice().sort((a, b) => toolOrder(a.tool) - toolOrder(b.tool));
    if (!list.length) return '';
    let used = 0; let shown = 0;
    for (const a of list) {
      const w = tagW(Console.tool(a.tool)) + 4;
      const more = list.length - shown - 1 > 0 ? 30 : 0;
      if (used + w + more > room && shown) break;
      used += w; shown++;
    }
    const tg = (a) => `<span class="tp-tg ${a.live ? 'live' : ''}">${h(Console.tool(a.tool))}</span>`;
    return list.slice(0, shown).map(tg).join('') + (list.length > shown ? `<span class="tp-tg">+${list.length - shown}</span>` : '');
  }
  function nodeHtml(id) {
    if (id.startsWith('dev:')) {
      const d = D.devices.find((x) => x.name === id.slice(4)); const st = devState(d);
      return `<div class="r1">${dot(st)}<b>${h(nameOf(d))}</b>${d.readonly ? '<em>只读</em>' : ''}</div><div class="r2">${agentTags(d, LAY.nodes[id].w - 26)}</div>`;
    }
    switch (id) {
      case 'gate':
        return D.gate.enabled
          ? `<div class="r1">${dot('ok')}<b>认证网关</b></div><div class="big"><b>${fmtN(D.gate.devices)}</b> 台</div><div class="cap">经网关认出身份</div>`
          : '<div class="r1"><b>认证网关</b></div><div class="cap off">未启用</div>';
      case 'hub':
        return `<div class="r1"><b>中心</b><em>v${h(D.hub.version)}</em></div><div class="bigger">${fmtN(D.hub.memories)}</div><div class="cap">条有效记忆</div><div class="hr"></div><div class="m"><b>${fmtN(D.hub.calls_7d)}</b> 次调用 · 近 7 天</div>`;
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
      c.push(st); if (n.two) c.push('two'); if (LAY.nodes[id].h < 50) c.push('tight');
    } else if (id === 'gate' && !D.gate.enabled) c.push('off');
    else if (id === 'ext' && !D.extractors.length) c.push('off');
    else if (id === 'vec' && !D.vectors.enabled) c.push('off');
    else if (id === 'rep' && !D.reporters.length) c.push('off');
    else if (id === 'arc' && !D.storage.archive.mounted) c.push('bad');
    if (probs[id]) c.push('bad');
    if (id === drawerId) c.push('sel');
    return c.join(' ');
  }

  // ---------------- 连线状态 ----------------
  function edgeStates() {
    const st = {};
    const fresh = (d) => !d.paused && !d.stale && age(d.last_seen) < FRESH;
    for (const d of D.devices) {
      const s = devState(d);
      st[`e:dev:${d.name}`] = s === 'paused' ? 'paused' : s === 'stale' ? 'stale' : s === 'live' ? 'live' : s === 'ok' ? 'ok' : 'idle';
    }
    const via = D.devices.filter((d) => d.identity === 'gateway' && !d.paused);
    if (D.gate.enabled) st['e:gate'] = via.some((d) => d.live) ? 'live' : via.some(fresh) ? 'ok' : 'idle';
    const recent = (list) => list.some((x) => age(x.last_active) < ACTIVE);
    st['e:ext'] = !D.extractors.length ? 'off' : recent(D.extractors) ? 'ok' : 'idle';
    st['e:vec'] = !D.vectors.enabled ? 'off' : D.vectors.busy ? 'ok' : 'idle';
    st['e:rep'] = !D.reporters.length ? 'off' : recent(D.reporters) ? 'ok' : 'idle';
    st['e:web'] = 'ok';
    const any = D.devices.some((d) => d.live);
    const anyFresh = D.devices.some(fresh);
    st['e:repo'] = any ? 'live' : anyFresh ? 'ok' : 'idle';
    st['e:arc'] = !D.storage.archive.mounted ? 'stale' : any ? 'live' : anyFresh ? 'ok' : 'idle';
    return st;
  }

  // ---------------- 更新（只改变了的部分）----------------
  function update() {
    const probs = problemsOf();
    for (const id of Object.keys(nodeEl)) {
      const rec = nodeEl[id];
      const html = nodeHtml(id); const cls = nodeClass(id, probs);
      if (html !== rec.html) { rec.el.innerHTML = html; rec.html = html; }
      if (cls !== rec.cls) { rec.el.className = cls; rec.cls = cls; }
    }
    const es = edgeStates();
    for (const [id, rec] of Object.entries(edgeEl)) {
      const s = es[id] || 'idle';
      if (s !== rec.state) { rec.g.setAttribute('class', `tp-e ${s}`); rec.state = s; }
    }
    // 顶部的问题条
    const list = D.problems || [];
    const html = list.map((p) => `<button type="button" class="tp-chip" data-node="${h(problemNode(p.key))}">${h(p.text)}</button>`).join('');
    if (probBox.dataset.h !== html) { probBox.innerHTML = html; probBox.dataset.h = html; }
    probBox.hidden = !list.length;
    if (drawerId) renderDrawer();
  }

  function render() {
    const availH = window.innerHeight - 170; // 顶栏、问题条和边距的估计值；固定估计，免得问题条数量变了就重排
    const lay = layout(Math.max(MIN_W, scroller.clientWidth), availH);
    if (lay.sig !== sig) { LAY = lay; sig = lay.sig; build(); }
    else LAY = lay; // 位置不变，只是换一份最新的描述
    update();
  }

  // ---------------- 提示和详情 ----------------
  const row = (label, val, color) => `<div class="r">${color ? `<b style="background:${color}"></b>` : ''}${label}<em>${val}</em></div>`;
  function tipOf(id) {
    const c = `rgb(${RGB[LAY.nodes[id].kind]})`;
    if (id.startsWith('dev:')) {
      const d = D.devices.find((x) => x.name === id.slice(4));
      return `<div class="h">${h(nameOf(d))}</div>${row('状态', DEV_TEXT[devState(d)], c)}${row('最近同步', h(ago(d.last_seen)))}${row('接入', h(IDENT[d.identity] || d.identity))}${d.live ? row('最近对话', h(ago(d.last_msg))) : ''}`;
    }
    const T = {
      gate: () => `<div class="h">认证网关</div>${D.gate.enabled ? row('经网关认出身份', `${fmtN(D.gate.devices)} 台`, c) : row('状态', '未启用', c)}`,
      hub: () => `<div class="h">中心 v${h(D.hub.version)}</div>${row('有效记忆', fmtN(D.hub.memories), c)}${row('近 7 天调用', fmtN(D.hub.calls_7d))}${row('设备端', h(D.hub.agent_version || '—'))}`,
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
  function drawerBody(id) {
    if (id.startsWith('dev:')) {
      const d = D.devices.find((x) => x.name === id.slice(4));
      if (!d) return null;
      const st = devState(d);
      const agents = d.agents.slice().sort((a, b) => toolOrder(a.tool) - toolOrder(b.tool))
        .map((a) => `<div class="ag"><span class="tp-tg ${a.live ? 'live' : ''}">${h(Console.tool(a.tool))}</span><em>${a.last_msg ? h(ago(a.last_msg)) : '没有对话'}</em></div>`).join('');
      return { title: nameOf(d), sub: d.name !== nameOf(d) ? d.name : '', html: kv([
        ['状态', `${dot(st)} ${DEV_TEXT[st]}`],
        ['最近同步', `<span title="${h(abs(d.last_seen))}">${h(ago(d.last_seen))}</span>`],
        ['接入方式', h(IDENT[d.identity] || d.identity) + (d.identity === 'gateway' && !D.gate.enabled ? '（网关没启用）' : '')],
        ['设备端版本', h(d.version || '—')],
        d.readonly ? ['权限', '只读'] : null,
      ]) + (agents ? `<h4>智能体</h4>${agents}` : '') };
    }
    const T = {
      hub: () => ({ title: '中心', sub: `v${D.hub.version}`, html: kv([['有效记忆', fmtN(D.hub.memories)], ['近 7 天调用', fmtN(D.hub.calls_7d)], ['设备端版本', h(D.hub.agent_version || '—')], ['公开地址', `<span class="mono">${h(D.hub.public_url)}</span>`]]) }),
      gate: () => ({ title: '认证网关', sub: '', html: D.gate.enabled
        ? kv([['状态', `${dot('ok')} 已启用`], ['经网关认出身份', `${fmtN(D.gate.devices)} 台`]]) + (D.gate.devices ? `<h4>设备</h4>${D.devices.filter((d) => d.identity === 'gateway').map((d) => `<div class="ag"><span>${h(nameOf(d))}</span></div>`).join('')}` : '')
        : kv([['状态', '未启用']]) }),
      repo: () => { const c = D.storage.repo.last_commit; return { title: '记忆仓库', sub: '', html: kv([['条目', fmtN(D.storage.repo.entries)], c ? ['最近提交', `<span title="${h(abs(c.time))}">${h(ago(c.time))}</span>`] : null, c ? ['提交说明', h(c.subject)] : null]) }; },
      arc: () => { const a = D.storage.archive; return { title: '对话存档', sub: '', html: kv([['状态', `${dot(a.mounted ? 'ok' : 'stale')} ${a.mounted ? '已挂上' : '没挂上'}`], ['会话', fmtN(a.sessions)]]) }; },
      ext: () => ({ title: '抽取机', sub: '', html: D.extractors.length
        ? kv([['待写日志', `${fmtN(D.pending.journal)} 段`], ['待审候选', fmtN(D.pending.proposed)], ['待抽取会话', fmtN(D.pending.sessions)], D.pending.errors ? ['抽取失败', fmtN(D.pending.errors)] : null])
          + `<h4>令牌</h4>${D.extractors.map((x) => `<div class="ag"><span>${h(x.label || x.name)}</span><em>${x.last_active ? h(ago(x.last_active)) : '没有记录'}</em></div>`).join('')}`
        : kv([['状态', '未配置']]) }),
      vec: () => ({ title: '向量服务', sub: '', html: D.vectors.enabled ? kv([['状态', `${dot(D.vectors.busy ? 'live' : 'ok')} ${D.vectors.busy ? '正在建索引' : '已开'}`], ['已建向量', fmtN(D.vectors.items)], ['模型', h(D.vectors.model || '—')]]) : kv([['状态', '未配置']]) }),
      rep: () => ({ title: '报表', sub: '', html: D.reporters.length ? `<h4>令牌</h4>${D.reporters.map((x) => `<div class="ag"><span>${h(x.label || x.name)}</span><em>${x.last_active ? h(ago(x.last_active)) : '没有记录'}</em></div>`).join('')}` : kv([['状态', '未配置']]) }),
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
  function openDrawer(id) {
    if (!nodeEl[id]) return;
    tip.hide();
    drawerId = id;
    if (!drawerEl) {
      drawerEl = document.createElement('aside');
      drawerEl.className = 'tp-drawer';
      drawerEl.addEventListener('click', (e) => {
        if (e.target.closest('.tp-x')) closeDrawer();
        const g = e.target.closest('[data-go]');
        if (g) { closeDrawer(); Console.go(g.dataset.go); }
      });
      document.body.appendChild(drawerEl);
    }
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
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawerId && Console.visible('topology')) closeDrawer(); });
  document.addEventListener('mousedown', (e) => { if (drawerId && drawerEl && !drawerEl.contains(e.target) && !e.target.closest('.tp-n, .tp-chip')) closeDrawer(); });
  document.addEventListener('visibilitychange', () => { root?.classList.toggle('tp-paused', document.hidden || !Console.visible('topology')); });

  // ---------------- 加载 ----------------
  async function load() {
    if (loading) return loading;
    loading = (async () => {
      try {
        D = await Console.api('/console/api/topology');
        lastErr = '';
        render();
      } catch (e) {
        if (!D) { stage.innerHTML = `<div class="empty">${h(e.message)}</div>`; sig = ''; }
        else if (e.message !== lastErr) Console.toast(`拓扑刷新失败：${e.message}`, 'err');
        lastErr = e.message;
      }
    })().finally(() => { loading = null; });
    return loading;
  }

  Console.page('topology', {
    title: '拓扑',
    mount(el) {
      root = el;
      el.innerHTML = '<div class="tp"><div class="tp-prob" hidden></div><section class="panel tp-panel"><div class="tp-scroll"><div class="tp-stage"></div></div></section></div>';
      probBox = el.querySelector('.tp-prob'); scroller = el.querySelector('.tp-scroll'); stage = el.querySelector('.tp-stage');
      probBox.addEventListener('click', (e) => { const b = e.target.closest('[data-node]'); if (b) openDrawer(b.dataset.node); });
      Console.every('topology', 30000, load);
    },
    show() { root.classList.remove('tp-paused'); return load(); },
    hide() { root.classList.add('tp-paused'); closeDrawer(); tip.hide(); },
    resize() { if (D) render(); },
  });
})();
