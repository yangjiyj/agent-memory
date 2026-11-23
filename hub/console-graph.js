/* 知识图谱页：项目、机器、客户现场、版本，一起出现在同一条记忆或日志里就连线（力导向，可拖动、点选）。 */
(function () {
  const { esc, tip } = Console;
  const colorOf = (p) => Console.color(p);
  let root = null;
  const $ = (id) => root.querySelector(`#${id}`);
  const KG = { nodes: [], edges: [], drag: null, hover: -1, sel: -1, alpha: 1, maxW: 1 };
  const KIND = { project: '项目', machine: '机器', site: '客户现场', version: '版本' };
  const HINT = '点图上的一个点，看它和谁有关、出现过哪些版本、最近的相关记录。';
  let cv; let g; let raf = 0; let loaded = false; let loadedAt = 0;
  const dpr = () => devicePixelRatio || 1;
  const kindColor = (n) => {
    if (n.kind === 'project') { const c = colorOf(n.name); return c === Console.OTHER || c === Console.UNWRITTEN ? Console.css('--other-lt') : c; }
    return Console.css(`--kind-${n.kind}`); // machine / site / version
  };
  const kindLegend = () => $('kgLegend').innerHTML = ['project', 'machine', 'site', 'version'].filter((k) => KG.nodes.some((n) => n.kind === k))
    .map((k) => `<span><b style="background:${Console.css(`--kind-${k}`)}"></b>${KIND[k]} ${KG.nodes.filter((n) => n.kind === k).length}</span>`).join('');

  async function load() {
    const g0 = await Console.api('/browse/graph');
    const idx = new Map(g0.nodes.map((n, i) => [n.id, i]));
    KG.nodes = g0.nodes.map((n) => ({ ...n, x: (Math.random() - 0.5) * 400, y: (Math.random() - 0.5) * 300, vx: 0, vy: 0, r: 3 + Math.sqrt(n.count) * 0.6, c: kindColor(n) }));
    KG.edges = g0.edges.map((e) => ({ a: idx.get(e.a), b: idx.get(e.b), w: e.w })).filter((e) => e.a !== undefined && e.b !== undefined);
    KG.maxW = Math.max(...KG.edges.map((e) => e.w), 1);
    kindLegend();
    KG.alpha = 1; KG.sel = -1; KG.hover = -1;
    $('kgSide').textContent = HINT;
    for (let i = 0; i < 250; i++) step();
    loaded = true; loadedAt = Date.now();
  }

  function step() {
    const N = KG.nodes; const alpha = KG.alpha;
    for (let i = 0; i < N.length; i++) for (let j = i + 1; j < N.length; j++) {
      const a = N[i]; const b = N[j]; let dx = a.x - b.x; let dy = a.y - b.y; const d2 = dx * dx + dy * dy || 1;
      if (d2 > 250000) continue;
      const f = 2600 / d2 * alpha; const d = Math.sqrt(d2); dx /= d; dy /= d;
      a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
    }
    for (const e of KG.edges) {
      const a = N[e.a]; const b = N[e.b]; const dx = b.x - a.x; const dy = b.y - a.y; const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const L = 95; const k = 0.01 * Math.min(1, 0.3 + e.w / KG.maxW) * alpha; const f = (d - L) * k;
      a.vx += dx / d * f; a.vy += dy / d * f; b.vx -= dx / d * f; b.vy -= dy / d * f;
    }
    for (const n of N) { if (n === KG.drag?.n) continue; n.vx -= n.x * 0.0025 * alpha; n.vy -= n.y * 0.0035 * alpha; n.vx *= 0.82; n.vy *= 0.82; n.x += n.vx; n.y += n.vy; }
    KG.alpha = Math.max(0.05, alpha * 0.995);
  }

  function frame() {
    raf = requestAnimationFrame(frame);
    if (!loaded || document.hidden) return;
    step();
    const d = dpr(); const W = cv.width; const H = cv.height; const cx = W / 2; const cy = H / 2;
    g.clearRect(0, 0, W, H);
    const sel = KG.sel >= 0 ? KG.sel : KG.hover;
    const nb = new Set(); if (sel >= 0) for (const e of KG.edges) { if (e.a === sel) nb.add(e.b); if (e.b === sel) nb.add(e.a); }
    for (const e of KG.edges) {
      const a = KG.nodes[e.a]; const b = KG.nodes[e.b]; const on = sel >= 0 && (e.a === sel || e.b === sel);
      g.strokeStyle = on ? Console.rgba('--text-rgb', 0.55) : sel >= 0 ? Console.rgba('--slate-rgb', 0.05) : Console.rgba('--slate-rgb', 0.06 + 0.22 * e.w / KG.maxW);
      g.lineWidth = (on ? 1.6 : 0.6 + 1.6 * e.w / KG.maxW) * d;
      g.beginPath(); g.moveTo(cx + a.x * d, cy + a.y * d); g.lineTo(cx + b.x * d, cy + b.y * d); g.stroke();
    }
    g.globalCompositeOperation = Console.theme?.resolved() === 'light' ? 'source-over' : 'lighter'; // 浅底上不能叠加
    KG.nodes.forEach((n, i) => {
      const dim = sel >= 0 && i !== sel && !nb.has(i);
      const x = cx + n.x * d; const y = cy + n.y * d; const r = n.r * d * (i === sel ? 1.4 : 1);
      g.fillStyle = n.c;
      g.globalAlpha = dim ? 0.06 : 0.12; g.beginPath(); g.arc(x, y, r * 2.2, 0, 6.283); g.fill();
      g.globalAlpha = dim ? 0.25 : 0.95; g.beginPath(); g.arc(x, y, r, 0, 6.283); g.fill();
    });
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    g.textAlign = 'center'; g.font = `${11 * d}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
    KG.nodes.forEach((n, i) => {
      const dim = sel >= 0 && i !== sel && !nb.has(i);
      if (dim || (n.kind === 'version' && i !== sel && !nb.has(i)) || (n.count < 6 && i !== sel && !nb.has(i) && sel < 0)) return;
      g.fillStyle = Console.rgba('--text-rgb', 0.9); g.fillText(n.name, cx + n.x * d, cy + n.y * d - n.r * d - 4 * d);
    });
  }

  const fit = () => { if (!cv) return; const d = dpr(); cv.width = cv.clientWidth * d; cv.height = cv.clientHeight * d; };

  function bind() {
    const at = (e) => { const r = cv.getBoundingClientRect(); const d = dpr(); return [((e.clientX - r.left) * d - cv.width / 2) / d, ((e.clientY - r.top) * d - cv.height / 2) / d]; };
    const pick = (mx, my) => { let best = -1; let bd = 14 * 14; KG.nodes.forEach((n, i) => { const d = (n.x - mx) ** 2 + (n.y - my) ** 2; if (d < Math.max(bd, n.r * n.r)) { bd = d; best = i; } }); return best; };
    cv.addEventListener('mousedown', (e) => { const [mx, my] = at(e); const i = pick(mx, my); if (i >= 0) KG.drag = { n: KG.nodes[i], i, moved: false }; });
    addEventListener('mouseup', () => { setTimeout(() => { KG.drag = null; }, 0); });
    cv.addEventListener('mousemove', (e) => {
      const [mx, my] = at(e);
      if (KG.drag) { KG.drag.n.x = mx; KG.drag.n.y = my; KG.drag.n.vx = 0; KG.drag.n.vy = 0; KG.drag.moved = true; KG.alpha = Math.max(KG.alpha, 0.3); return; }
      KG.hover = pick(mx, my);
      if (KG.hover >= 0) { const n = KG.nodes[KG.hover]; tip.show(e, `<div class="h">${esc(n.name)}</div><div class="r">${KIND[n.kind]}<em>${n.count} 次 · 最近 ${esc(n.last)}</em></div>`); } else tip.hide();
    });
    cv.addEventListener('mouseleave', () => { KG.hover = -1; tip.hide(); });
    cv.addEventListener('click', async () => {
      if (KG.drag && KG.drag.moved) return;
      KG.sel = KG.hover;
      if (KG.sel < 0) { $('kgSide').textContent = HINT; return; }
      const name = KG.nodes[KG.sel].name;
      $('kgSide').textContent = '读取中…';
      try { const t = await Console.api('/browse/entity', { query: { name } }); if (KG.nodes[KG.sel]?.name === name) $('kgSide').textContent = t; } catch (e) { $('kgSide').textContent = e.message; }
    });
  }

  Console.page('graph', {
    mount(el) {
      root = el;
      root.innerHTML = `
        <section class="panel">
          <div class="ph"><h2>知识图谱</h2></div>
          <div class="legend" id="kgLegend" style="margin-bottom:8px"></div>
          <div class="kg"><canvas id="kg"></canvas><div class="kgside" id="kgSide">${HINT}</div></div>
        </section>`;
      cv = $('kg'); g = cv.getContext('2d');
      bind();
    },
    async show() {
      fit();
      if (!loaded || Date.now() - loadedAt > 10 * 60e3) { try { await load(); } catch (e) { Console.toast(e.message, 'err'); } }
      cancelAnimationFrame(raf); raf = requestAnimationFrame(frame);
    },
    hide() { cancelAnimationFrame(raf); raf = 0; KG.hover = -1; tip.hide(); },
    resize() { fit(); },
    theme() { KG.nodes.forEach((n) => { n.c = kindColor(n); }); if (KG.nodes.length) kindLegend(); },
  });
})();
