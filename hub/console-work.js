/* 工作类页面：时间线（日历、当天泳道、作息、大事记、回放）、项目（河流、排行、流向图、交接包）、待办（待办雷达）。
 * 图都按容器宽度画，所以只在页面显示时画，窗口尺寸变化时重画。 */
(function () {
  const { esc, dev, tool, date, tip, SEQ } = Console; // OTHER 随主题变（getter），用到时读 Console.OTHER，别在这里解构
  const el = Console.svg;
  const colorOf = (p) => Console.color(p);
  const { WEEK, addDays, wd, today: todayStr, minutesOf, hm: fmtHM, weekStart } = date;
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  const loadExtra = () => Console.api('/browse/viz-extra', { ttl: 300000 });

  // ======================================================================
  // 时间线
  // ======================================================================
  (function timeline() {
    let root = null;
    const $ = (id) => root.querySelector(`#${id}`);
    let DATA = null; let EXTRA = null; let currentDay = null; let drawnKey = null;
    let SEARCH = null; const CAL_CELLS = new Map(); const HOT = [];
    const loadHot = () => { for (let i = 0; i < 5; i++) HOT[i] = Console.css(`--hot${i + 1}`); }; loadHot();
    let playing = null; let punchTool = 'all'; let msProject = ''; let showSeq = 0;

    // ---------------- 工作日历 ----------------
    function renderCalendar() {
      const box = $('cal'); box.innerHTML = ''; CAL_CELLS.clear();
      const dates = Object.keys(DATA.days).sort();
      if (!dates.length) { box.innerHTML = '<div class="empty">还没有数据</div>'; return; }
      let start = dates[0]; while (wd(start) !== 1) start = addDays(start, -1);
      const end = todayStr();
      const weeks = Math.ceil((Date.parse(`${end}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / 86400e3 / 7) + 1;
      const W = Math.max(box.clientWidth, 600); const left = 30; const top = 20;
      const gap = 3; const cell = Math.max(8, Math.min(20, Math.floor((W - left - 10) / weeks) - gap));
      const H = top + 7 * (cell + gap) + 30;
      const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` }, box);
      const vals = dates.map((d) => DATA.days[d].s).sort((a, b) => a - b);
      const q = (p) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))];
      const cuts = [0.15, 0.32, 0.5, 0.66, 0.8, 0.92].map(q);
      const shade = (v) => { let i = 0; while (i < cuts.length && v > cuts[i]) i++; return SEQ[i]; };
      ['一', '三', '五', '日'].forEach((t, i) => { const r = [0, 2, 4, 6][i]; el('text', { x: 0, y: top + r * (cell + gap) + cell * 0.8 }, svg).textContent = t; });
      let lastMonth = '';
      const cells = [];
      for (let w = 0; w < weeks; w++) {
        for (let r = 0; r < 7; r++) {
          const d = addDays(start, w * 7 + r);
          if (d > end) continue;
          const x = left + w * (cell + gap); const y = top + r * (cell + gap);
          if (r === 0 && d.slice(0, 7) !== lastMonth) {
            lastMonth = d.slice(0, 7);
            el('text', { x, y: 12 }, svg).textContent = `${parseInt(d.slice(5, 7), 10)}月`;
          }
          const row = DATA.days[d];
          const hits = SEARCH ? SEARCH.dates[d] || 0 : 0;
          const fill = SEARCH ? (hits ? HOT[Math.min(HOT.length - 1, hits - 1)] : (row ? Console.rgba('--wash-rgb', 0.06) : Console.rgba('--wash-rgb', 0.025))) : (row ? shade(row.s) : Console.rgba('--wash-rgb', 0.04));
          const rect = el('rect', { x, y, width: cell, height: cell, rx: 3, fill, opacity: 0, 'data-d': d, style: 'cursor:pointer;transition:opacity .4s' }, svg);
          if (SEARCH ? hits : (row && row.s >= cuts[4])) rect.setAttribute('filter', SEARCH ? `drop-shadow(0 0 4px ${Console.rgba('--glow-hot-rgb', 0.8)})` : `drop-shadow(0 0 3px ${Console.rgba('--glow-sky-rgb', 0.6)})`);
          cells.push(rect);
          CAL_CELLS.set(d, rect);
          rect.addEventListener('mousemove', (e) => {
            const ps = row ? Object.entries(row.p).sort((a, b) => b[1] - a[1]).slice(0, 4) : [];
            const head = `<div class="h">${d}（周${WEEK[wd(d)]}）</div>`;
            const searchLine = SEARCH ? `<div class="r" style="color:var(--t-hot)">${hits ? `${hits} 个会话提到「${esc(SEARCH.q)}」` : `没提到「${esc(SEARCH.q)}」`}</div>` : '';
            tip.show(e, `${head}${searchLine}${row ? `<div class="r">会话段<em>${row.s}</em></div><div class="r">消息<em>${row.m.toLocaleString()}</em></div>${ps.map(([p, n]) => `<div class="r"><b style="background:${colorOf(p)}"></b>${esc(p)}<em>${n}</em></div>`).join('')}` : '<div class="r">没有会话</div>'}`);
          });
          rect.addEventListener('mouseleave', tip.hide);
          rect.addEventListener('click', () => Console.go(`timeline/${d}`));
        }
      }
      cells.forEach((c, i) => setTimeout(() => c.setAttribute('opacity', 1), 3 * i));
      // 图例：少 → 多（搜词时换成橙色：提到的会话数）
      const ramp = SEARCH ? HOT : SEQ;
      const ly = H - 12; const lx = W - 10 - ramp.length * 14 - 60;
      el('text', { x: lx, y: ly + 9 }, svg).textContent = SEARCH ? '1' : '少';
      ramp.forEach((c, i) => el('rect', { x: lx + 16 + i * 14, y: ly, width: 11, height: 11, rx: 2, fill: c }, svg));
      el('text', { x: lx + 20 + ramp.length * 14, y: ly + 9 }, svg).textContent = SEARCH ? `${ramp.length}+ 个会话` : '多';
      box._mark = (d) => cells.forEach((c) => { const on = c.getAttribute('data-d') === d; c.setAttribute('stroke', on ? Console.css('--text-primary') : 'none'); c.setAttribute('stroke-width', on ? 2 : 0); });
      if (currentDay) box._mark(currentDay);
    }

    // ---------------- 搜词点亮 ----------------
    async function doSearch(ev) {
      ev.preventDefault();
      const q = $('sq').value.trim();
      if (!q) { clearSearch(); return; }
      $('shint').textContent = `正在找「${q}」…`;
      let r;
      try { r = await Console.api('/browse/viz-search', { query: { q } }); } catch (e) { $('shint').textContent = ''; Console.toast(e.message, 'err'); return; }
      SEARCH = r;
      const ds = Object.keys(r.dates);
      $('shint').innerHTML = ds.length
        ? `「${esc(r.q)}」出现在 <b>${r.days}</b> 天、<b>${r.sessions}</b> 个会话里，最早 ${ds[0]}，最近 ${ds[ds.length - 1]}<a id="sclear">清除</a>`
        : `没找到「${esc(r.q)}」<a id="sclear">清除</a>`;
      $('sclear').onclick = clearSearch;
      renderCalendar();
      if (ds.length) Console.go(`timeline/${ds[ds.length - 1]}`);
    }
    function clearSearch() {
      SEARCH = null; $('sq').value = ''; $('shint').textContent = '';
      renderCalendar();
    }

    // ---------------- 当天泳道 ----------------
    async function loadDay(d, scroll) {
      currentDay = d;
      $('dayLabel').textContent = `${d}  周${WEEK[wd(d)]}`;
      $('cal')._mark?.(d);
      let j;
      try { j = await Console.api('/browse/viz-day', { query: { date: d } }); } catch (e) { Console.toast(e.message, 'err'); return; }
      if (currentDay !== d) return;
      renderLanes(j.segments);
      if (scroll) $('lanes').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    function renderLanes(segs) {
      const TOP = Console.top();
      const box = $('lanes'); box.innerHTML = ''; $('cards').innerHTML = '';
      const used = [...new Set(segs.map((s) => s.project || (s.summary ? '其他' : '未写日志')))];
      $('dayLegend').innerHTML = used.sort((a, b) => (TOP.indexOf(a) + 1 || 99) - (TOP.indexOf(b) + 1 || 99)).map((p) => `<span><b style="background:${colorOf(p)}"></b>${esc(p)}</span>`).join('');
      if (!segs.length) { box.innerHTML = '<div class="empty">这天没有会话</div>'; return; }
      const timed = segs.filter((s) => !s.approx && s.first);
      const untimed = segs.filter((s) => s.approx || !s.first);
      const lanesKey = [...new Set(timed.map((s) => `${s.device}|${s.tool}`))].sort();
      // 同一条泳道里时间重叠的会话分到上下几行，不互相盖住
      const subRow = new Map(); const laneRows = {};
      for (const k of lanesKey) {
        const ends = [];
        for (const s of timed.filter((x) => `${x.device}|${x.tool}` === k).sort((a, b) => a.first.localeCompare(b.first))) {
          let r = ends.findIndex((e) => e < s.first);
          if (r < 0) { r = ends.length; ends.push(''); }
          ends[r] = s.last; subRow.set(s, r);
        }
        laneRows[k] = Math.max(1, ends.length);
      }
      const rowH = 16; const lanePad = 7;
      const laneTop = {}; let acc = 0;
      for (const k of lanesKey) { laneTop[k] = acc; acc += laneRows[k] * rowH + (laneRows[k] - 1) * 3 + lanePad * 2; }
      const W = Math.max(box.clientWidth, 640); const left = 170; const right = 14; const top = 26;
      // 旧导出没有逐条时间的段：画成一排排圆点，放不下就换行
      const perRow = Math.max(1, Math.floor((W - left - 20) / 18));
      const dotRows = Math.ceil(untimed.length / perRow);
      const untimedH = untimed.length ? 16 + dotRows * 18 : 0;
      const H = top + (lanesKey.length ? acc : 0) + untimedH + 8;
      const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` }, box);
      const defs = el('defs', {}, svg);
      const f = el('filter', { id: 'glow', x: '-20%', y: '-60%', width: '140%', height: '220%' }, defs);
      el('feGaussianBlur', { stdDeviation: 3, result: 'b' }, f);
      const fm = el('feMerge', {}, f); el('feMergeNode', { in: 'b' }, fm); el('feMergeNode', { in: 'SourceGraphic' }, fm);
      const X = (min) => left + (W - left - right) * (min / 1440);
      for (let h = 0; h <= 24; h += 3) {
        el('line', { x1: X(h * 60), x2: X(h * 60), y1: top - 6, y2: top + (lanesKey.length ? acc : 0), stroke: Console.rgba('--slate-rgb', 0.12) }, svg);
        el('text', { x: X(h * 60), y: 14, 'text-anchor': 'middle' }, svg).textContent = `${String(h).padStart(2, '0')}:00`;
      }
      // 现在几点（看今天时）
      if (currentDay === todayStr()) {
        const nx = X(minutesOf(new Date().toISOString()));
        el('line', { x1: nx, x2: nx, y1: top - 8, y2: top + (lanesKey.length ? acc : 0), stroke: Console.rgba('--rose-rgb', 1), 'stroke-dasharray': '3 3' }, svg);
      }
      lanesKey.forEach((k, i) => {
        const [d, t] = k.split('|');
        const y = top + laneTop[k]; const h = laneRows[k] * rowH + (laneRows[k] - 1) * 3 + lanePad * 2;
        if (i % 2 === 0) el('rect', { x: left, y, width: W - left - right, height: h, fill: Console.rgba('--wash-rgb', 0.018) }, svg);
        el('text', { x: 0, y: y + h / 2 + 4, style: 'fill:var(--text-primary);font-size:12px' }, svg).textContent = `${dev(d)} · ${tool(t)}`;
      });
      const cardOf = new Map();
      const addCard = (s, i) => {
        const p = s.project || (s.summary ? '其他' : '未写日志');
        const div = document.createElement('div'); div.className = 'card';
        div.innerHTML = `<div class="t"><b style="background:${colorOf(p)}"></b>${esc(p)} · ${esc(dev(s.device))} · ${esc(tool(s.tool))}${s.approx || !s.first ? '' : ` · ${fmtHM(s.first)}–${fmtHM(s.last)}`}</div>`
          + `<div class="s">${esc(s.summary || `（日志还没写）${s.title || ''}`)}</div>`
          + (s.points?.length ? `<ul>${s.points.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '')
          + `<div class="m">「${esc(s.title || '')}」 · ${s.n} 条 · ref:${s.ref}</div>`;
        $('cards').appendChild(div); cardOf.set(i, div);
      };
      timed.sort((a, b) => a.first.localeCompare(b.first)).forEach((s, i) => {
        const k = `${s.device}|${s.tool}`;
        const x0 = X(minutesOf(s.first)); const x1 = Math.max(x0 + 6, X(minutesOf(s.last)));
        const y = top + laneTop[k] + lanePad + subRow.get(s) * (rowH + 3); const p = s.project || (s.summary ? '其他' : '未写日志');
        const r = el('rect', { x: x0, y, width: 0, height: rowH, rx: 4, fill: colorOf(p), filter: 'url(#glow)', style: 'cursor:pointer;transition:width .9s cubic-bezier(.2,.8,.2,1)' }, svg);
        setTimeout(() => r.setAttribute('width', x1 - x0), 30 + i * 25);
        addCard(s, i);
        r.addEventListener('mousemove', (e) => {
          tip.show(e, `<div class="h">${esc(s.summary || s.title || '（日志还没写）')}</div><div class="r"><b style="background:${colorOf(p)}"></b>${esc(p)}<em>${fmtHM(s.first)}–${fmtHM(s.last)}</em></div><div class="r">${esc(dev(s.device))} · ${esc(tool(s.tool))}<em>${s.n} 条</em></div>${s.points?.length ? `<div class="r" style="margin-top:4px">${esc(s.points.slice(0, 3).join('；'))}</div>` : ''}`);
          cardOf.get(i)?.classList.add('hl');
        });
        r.addEventListener('mouseleave', () => { tip.hide(); cardOf.get(i)?.classList.remove('hl'); });
        r.addEventListener('click', () => cardOf.get(i)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
      });
      if (untimed.length) {
        const y = top + (lanesKey.length ? acc : 0) + 6;
        el('text', { x: 0, y: y + 12 }, svg).textContent = '时间不详（旧导出）';
        untimed.forEach((s, j) => {
          const p = s.project || (s.summary ? '其他' : '未写日志');
          const c = el('circle', { cx: left + 10 + (j % perRow) * 18, cy: y + 8 + Math.floor(j / perRow) * 18, r: 6, fill: colorOf(p), style: 'cursor:pointer' }, svg);
          const idx = 1000 + j; addCard(s, idx);
          c.addEventListener('mousemove', (e) => { tip.show(e, `<div class="h">${esc(s.summary || s.title)}</div><div class="r"><b style="background:${colorOf(p)}"></b>${esc(p)}<em>${s.n} 条</em></div><div class="r">${esc(dev(s.device))} · ${esc(tool(s.tool))}</div>`); cardOf.get(idx)?.classList.add('hl'); });
          c.addEventListener('mouseleave', () => { tip.hide(); cardOf.get(idx)?.classList.remove('hl'); });
        });
      }
    }

    // ---------------- 作息打卡（7 × 24） ----------------
    function renderPunch() {
      if (!EXTRA) return;
      const tools = Object.entries(EXTRA.punch.byTool).map(([t, a]) => [t, a.reduce((x, y) => x + y, 0)]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 6);
      $('punchTools').innerHTML = [['all', '全部'], ...tools.map(([t]) => [t, tool(t)])].map(([k, l]) => `<button data-k="${k}" class="${k === punchTool ? 'on' : ''}">${esc(l)}</button>`).join('');
      $('punchTools').querySelectorAll('button').forEach((b) => { b.onclick = () => { punchTool = b.dataset.k; renderPunch(); }; });
      const arr = punchTool === 'all' ? EXTRA.punch.all : EXTRA.punch.byTool[punchTool];
      const box = $('punch'); box.innerHTML = '';
      const W = Math.max(box.clientWidth, 520); const left = 30; const top = 8; const bottom = 22;
      const cw = (W - left - 6) / 24; const ch = Math.min(30, cw * 1.05); const H = top + 7 * ch + bottom;
      const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` }, box);
      const max = Math.max(...arr) || 1;
      const days = ['一', '二', '三', '四', '五', '六', '日'];
      days.forEach((d, r) => { el('text', { x: 0, y: top + r * ch + ch / 2 + 4 }, svg).textContent = `周${d}`; });
      for (let h = 0; h < 24; h += 3) el('text', { x: left + h * cw + cw / 2, y: H - 6, 'text-anchor': 'middle' }, svg).textContent = `${h}`;
      const total = arr.reduce((a, b) => a + b, 0);
      arr.forEach((n, i) => {
        const r = Math.floor(i / 24); const h = i % 24;
        const cx = left + h * cw + cw / 2; const cy = top + r * ch + ch / 2;
        el('rect', { x: cx - cw / 2 + 1, y: cy - ch / 2 + 1, width: cw - 2, height: ch - 2, rx: 3, fill: h < 5 ? Console.rgba('--violet-rgb', 0.06) : Console.rgba('--wash-rgb', 0.02) }, svg);
        if (!n) return;
        const rad = Math.max(1.5, (Math.min(cw, ch) / 2 - 1.5) * Math.sqrt(n / max));
        const k = n / max;
        const c = el('circle', { cx, cy, r: 0, fill: k > 0.66 ? SEQ[5] : k > 0.33 ? SEQ[3] : SEQ[2], style: `transition:r .7s cubic-bezier(.2,.8,.2,1) ${(h * 12 + r * 30)}ms;${k > 0.66 ? `filter:drop-shadow(0 0 5px ${Console.rgba('--glow-sky-rgb', 0.8)})` : ''}` }, svg);
        requestAnimationFrame(() => c.setAttribute('r', rad));
        const hit = el('rect', { x: cx - cw / 2, y: cy - ch / 2, width: cw, height: ch, fill: 'transparent' }, svg);
        hit.addEventListener('mousemove', (e) => tip.show(e, `<div class="h">周${days[r]} ${String(h).padStart(2, '0')}:00–${String(h + 1).padStart(2, '0')}:00</div><div class="r">你发的消息<em>${n.toLocaleString()}</em></div><div class="r">占这个范围的<em>${((100 * n) / total).toFixed(1)}%</em></div>`));
        hit.addEventListener('mouseleave', tip.hide);
      });
      const peak = arr.reduce((a, n, i) => (n > arr[a] ? i : a), 0);
      const night = arr.filter((_, i) => i % 24 < 5).reduce((a, b) => a + b, 0);
      const weekend = arr.slice(5 * 24).reduce((a, b) => a + b, 0);
      $('punchNote').textContent = `最常在周${days[Math.floor(peak / 24)]} ${peak % 24} 点干活；凌晨 0–5 点的消息占 ${((100 * night) / (total || 1)).toFixed(1)}%（紫色底的格子）；周末占 ${((100 * weekend) / (total || 1)).toFixed(1)}%`;
    }

    // ---------------- 大事记 ----------------
    function renderMilestones() {
      if (!EXTRA) return;
      const TOP = Console.top();
      const all = EXTRA.milestones;
      const projs = [...new Set(all.map((m) => m.project).filter(Boolean))].sort((a, b) => (TOP.indexOf(a) + 1 || 99) - (TOP.indexOf(b) + 1 || 99)).slice(0, 8);
      $('msChips').innerHTML = [['', '全部'], ...projs.map((p) => [p, p])].map(([k, l]) => `<button data-k="${esc(k)}" class="${k === msProject ? 'on' : ''}">${k ? `<b style="background:${colorOf(k)}"></b>` : ''}${esc(l)}</button>`).join('');
      $('msChips').querySelectorAll('button').forEach((b) => { b.onclick = () => { msProject = b.dataset.k; renderMilestones(); }; });
      const list = all.filter((m) => !msProject || m.project === msProject).slice().reverse();
      $('msCount').textContent = `${list.length} 件`;
      let lastMon = '';
      $('ms').innerHTML = list.map((m) => {
        const mon = m.date.slice(0, 7);
        const head = mon !== lastMon ? `<div class="mon">${mon.replace('-', ' 年 ')} 月</div>` : '';
        lastMon = mon;
        const c = colorOf(m.project || '其他');
        return `${head}<div class="it" data-d="${m.date}" style="cursor:pointer"><span class="dt">${m.date.slice(5)}</span><span class="dot" style="background:${c};color:${c}"></span><span class="tx">${esc(m.summary)}<em>${esc(m.project || '其他')} · ${esc(dev(m.device))} · ${esc(tool(m.tool))}</em></span></div>`;
      }).join('') || '<div class="empty">没有</div>';
      $('ms').querySelectorAll('.it').forEach((n) => { n.onclick = () => Console.go(`timeline/${n.dataset.d}`); });
    }

    // ---------------- 时光回放 ----------------
    function stopReplay(finish) {
      if (!playing) return;
      clearInterval(playing.timer); playing = null;
      $('play').textContent = '▶ 时光回放'; $('play').classList.remove('on');
      $('replay').classList.remove('on');
      for (const c of CAL_CELLS.values()) { c.setAttribute('opacity', 1); c.style.transition = 'opacity .4s'; }
      if (finish) Console.go(`timeline/${todayStr()}`);
    }
    function startReplay() {
      if (SEARCH) clearSearch();
      const dates = Object.keys(DATA.days).sort();
      if (!dates.length) return;
      for (const c of CAL_CELLS.values()) { c.style.transition = 'opacity .25s'; c.setAttribute('opacity', 0.06); }
      $('play').textContent = '■ 停止'; $('play').classList.add('on');
      $('replay').classList.add('on');
      $('calPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
      let d = dates[0]; let segs = 0; let msgs = 0; const end = todayStr();
      playing = { timer: setInterval(() => {
        const row = DATA.days[d];
        if (row) { segs += row.s; msgs += row.m; }
        const c = CAL_CELLS.get(d);
        if (c) c.setAttribute('opacity', 1);
        $('rDate').textContent = `${d} 周${WEEK[wd(d)]}`;
        $('rKpi').textContent = `累计 ${segs.toLocaleString()} 段会话 · ${(msgs / 1e4).toFixed(1)} 万条消息`;
        const hl = EXTRA?.highlights?.[d] || [];
        if (hl.length) $('rLines').innerHTML = hl.map((x) => `<div class="ln"><b style="background:${colorOf(x.p || '其他')}"></b><span>${esc(x.t)}</span></div>`).join('');
        if (d >= end) { setTimeout(() => stopReplay(true), 1200); clearInterval(playing.timer); return; }
        d = addDays(d, 1);
      }, 110) };
    }

    // ---------------- 页面 ----------------
    const lastDay = () => { const days = Object.keys(DATA.days).sort(); return DATA.days[todayStr()] ? todayStr() : days[days.length - 1]; };
    function draw() {
      const key = `${DATA.generated}:${root.clientWidth}:${EXTRA ? 1 : 0}`;
      if (key === drawnKey) return;
      drawnKey = key;
      if (playing) stopReplay(false);
      renderCalendar(); renderPunch(); renderMilestones();
    }
    async function ensureExtra() {
      if (EXTRA) return;
      $('punch').innerHTML = '<div class="empty">正在统计作息…</div>';
      try { EXTRA = await loadExtra(); } catch (e) { $('punch').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
      drawnKey = null; draw();
    }

    Console.page('timeline', {
      mount(el0) {
        root = el0;
        root.innerHTML = `
          <section class="panel" id="calPanel">
            <div class="ph">
              <h2>工作日历</h2>
              <div class="tools">
                <form id="sform" autocomplete="off"><input class="inp" id="sq" placeholder="搜一个词，看哪些天做过：部署、登录页、2.9.20…"><button>点亮</button></form>
                <button id="play" class="play">▶ 时光回放</button>
              </div>
            </div>
            <div class="hint" id="shint"></div>
            <div id="cal"></div>
            <div class="replay" id="replay"><div class="rd" id="rDate"></div><div class="rk" id="rKpi"></div><div id="rLines"></div></div>
          </section>
          <section class="panel">
            <div class="ph">
              <h2>当天在做什么</h2>
              <div class="daynav"><button id="prev">‹ 前一天</button><span class="d" id="dayLabel">—</span><button id="next">后一天 ›</button><button id="today">今天</button></div>
            </div>
            <div class="legend" id="dayLegend"></div>
            <div id="lanes"></div>
            <div class="cards" id="cards"></div>
          </section>
          <div class="row2 even">
            <section class="panel">
              <div class="ph"><h2>作息打卡</h2></div>
              <div class="chips" id="punchTools"></div>
              <div id="punch"></div>
              <div class="hint" id="punchNote" style="margin-top:6px"></div>
            </section>
            <section class="panel">
              <div class="ph"><h2>大事记</h2><span class="hint" id="msCount"></span></div>
              <div class="chips" id="msChips"></div>
              <div class="ms" id="ms"></div>
            </section>
          </div>`;
        $('sform').addEventListener('submit', doSearch);
        $('play').onclick = () => (playing ? stopReplay(false) : startReplay());
        $('prev').onclick = () => currentDay && Console.go(`timeline/${addDays(currentDay, -1)}`);
        $('next').onclick = () => currentDay && Console.go(`timeline/${addDays(currentDay, 1)}`);
        $('today').onclick = () => Console.go(`timeline/${todayStr()}`);
      },
      async show(params) {
        const seq = ++showSeq; const stale = () => seq !== showSeq || !Console.visible('timeline');
        DATA = await Console.loadData();
        if (!DATA || stale()) return;
        draw();
        const wantReplay = params.arg === 'replay';
        if (isDate(params.arg)) await loadDay(params.arg, true);
        else if (!currentDay) await loadDay(lastDay());
        else if (!wantReplay) await loadDay(currentDay);
        if (!EXTRA) await ensureExtra();
        if (wantReplay && !playing && !stale()) startReplay();
      },
      hide() { showSeq++; if (playing) stopReplay(false); tip.hide(); },
      resize() { if (!DATA) return; drawnKey = null; draw(); if (currentDay) loadDay(currentDay); },
      theme() { loadHot(); if (!DATA) return; drawnKey = null; draw(); if (currentDay) loadDay(currentDay); },
    });
  })();

  // ======================================================================
  // 项目
  // ======================================================================
  (function projects() {
    let root = null;
    const $ = (id) => root.querySelector(`#${id}`);
    let DATA = null;

    function renderRiver() {
      const TOP = Console.top();
      const box = $('river'); box.innerHTML = '';
      const series = [...TOP, '其他'];
      const weeks = new Map();
      for (const [d, row] of Object.entries(DATA.days)) {
        const w = weekStart(d);
        if (!weeks.has(w)) weeks.set(w, Object.fromEntries(series.map((s) => [s, 0])));
        const acc = weeks.get(w);
        for (const [p, n] of Object.entries(row.p)) acc[TOP.includes(p) ? p : '其他'] += n;
      }
      const ws = [...weeks.keys()].sort();
      if (!ws.length) { $('riverLegend').innerHTML = ''; return; }
      const W = Math.max(box.clientWidth, 600); const H = 300; const left = 34; const right = 10; const top = 10; const bottom = 24;
      const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` }, box);
      const tot = ws.map((w) => series.reduce((a, s) => a + weeks.get(w)[s], 0));
      const max = Math.max(...tot) || 1;
      const X = (i) => left + (W - left - right) * (ws.length === 1 ? 0.5 : i / (ws.length - 1));
      const Y = (v) => H - bottom - (H - top - bottom) * (v / max);
      for (let g = 0; g <= 4; g++) {
        const v = Math.round((max * g) / 4); const y = Y(v);
        el('line', { x1: left, x2: W - right, y1: y, y2: y, stroke: Console.rgba('--slate-rgb', 0.1) }, svg);
        el('text', { x: left - 6, y: y + 4, 'text-anchor': 'end' }, svg).textContent = v;
      }
      let lastM = '';
      ws.forEach((w, i) => { if (w.slice(0, 7) !== lastM) { lastM = w.slice(0, 7); el('text', { x: X(i), y: H - 6, 'text-anchor': 'middle' }, svg).textContent = `${parseInt(w.slice(5, 7), 10)}月`; } });
      const defs = el('defs', {}, svg);
      const base = ws.map(() => 0);
      series.forEach((s, si) => {
        const color = s === '其他' ? Console.OTHER : colorOf(s);
        const gid = `rg${si}`;
        const lg = el('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
        el('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': 0.95 }, lg);
        el('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': 0.55 }, lg);
        const lo = base.slice();
        const hi = ws.map((w, i) => base[i] + weeks.get(w)[s]);
        const pts = (arr) => arr.map((v, i) => [X(i), Y(v)]);
        const smooth = (p) => p.map((q, i) => (i === 0 ? `M${q[0]},${q[1]}` : `C${(p[i - 1][0] + q[0]) / 2},${p[i - 1][1]} ${(p[i - 1][0] + q[0]) / 2},${q[1]} ${q[0]},${q[1]}`)).join('');
        const up = pts(hi); const down = pts(lo).reverse();
        const d = `${smooth(up)}L${down[0][0]},${down[0][1]}${smooth(down).slice(1).replace(/^[^C]*/, '')}Z`;
        const path = el('path', { d, fill: `url(#${gid})`, stroke: 'var(--surface)', 'stroke-width': 1, opacity: 0, style: 'transition:opacity .8s' }, svg);
        setTimeout(() => path.setAttribute('opacity', 1), 80 * si);
        for (let i = 0; i < ws.length; i++) base[i] = hi[i];
      });
      $('riverLegend').innerHTML = series.map((s) => `<span><b style="background:${s === '其他' ? Console.OTHER : colorOf(s)}"></b>${esc(s)}</span>`).join('');
      // 十字线 + 提示
      const cross = el('line', { y1: top, y2: H - bottom, stroke: Console.rgba('--text-rgb', 0.5), 'stroke-dasharray': '3 3', opacity: 0 }, svg);
      const hit = el('rect', { x: left, y: top, width: W - left - right, height: H - top - bottom, fill: 'transparent' }, svg);
      hit.addEventListener('mousemove', (e) => {
        const r = svg.getBoundingClientRect();
        const i = Math.max(0, Math.min(ws.length - 1, Math.round(((e.clientX - r.left - left) / (W - left - right)) * (ws.length - 1))));
        cross.setAttribute('x1', X(i)); cross.setAttribute('x2', X(i)); cross.setAttribute('opacity', 1);
        const acc = weeks.get(ws[i]);
        const rows = series.filter((s) => acc[s]).sort((a, b) => acc[b] - acc[a]);
        tip.show(e, `<div class="h">${ws[i]} 这周 · ${tot[i]} 段</div>${rows.map((s) => `<div class="r"><b style="background:${s === '其他' ? Console.OTHER : colorOf(s)}"></b>${esc(s)}<em>${acc[s]}</em></div>`).join('')}`);
      });
      hit.addEventListener('mouseleave', () => { tip.hide(); cross.setAttribute('opacity', 0); });
    }

    function renderRank() {
      const list = DATA.projects.filter((x) => x.p !== '未写日志' && x.p !== '其他').slice(0, 12);
      const max = list[0]?.n || 1;
      $('rank').innerHTML = list.map((x) => `<div class="b"><span class="lab">${esc(x.p)}</span><span class="track"><span class="fill" style="background:${colorOf(x.p)};color:${colorOf(x.p)}" data-w="${(100 * x.n) / max}"></span></span><span class="n">${x.n}</span></div>`).join('');
      requestAnimationFrame(() => setTimeout(() => $('rank').querySelectorAll('.fill').forEach((f) => { f.style.width = `${f.dataset.w}%`; }), 60));
    }

    function renderSankey() {
      const TOP = Console.top();
      const box = $('sankey'); box.innerHTML = '';
      const fold = (p) => (TOP.includes(p) ? p : '其他');
      const L1 = new Map(); const L2 = new Map();
      for (const { a, b, n } of DATA.devTool) L1.set(`${a}|${b}`, (L1.get(`${a}|${b}`) || 0) + n);
      for (const { a, b, n } of DATA.toolProj) { const k = `${a}|${fold(b)}`; L2.set(k, (L2.get(k) || 0) + n); }
      if (!L1.size || !L2.size) { box.innerHTML = '<div class="empty">还没有数据</div>'; return; }
      const sum = (m, idx) => { const o = new Map(); for (const [k, v] of m) { const key = k.split('|')[idx]; o.set(key, (o.get(key) || 0) + v); } return o; };
      const cols = [sum(L1, 0), sum(L1, 1), sum(L2, 1)];
      const W = Math.max(box.clientWidth, 600); const H = 460; const pad = 10; const nodeW = 12; const top = 8; const labelW = 150;
      const xs = [labelW, (W - nodeW) / 2, W - labelW - nodeW];
      const k = Math.min(...cols.map((c) => (H - top * 2 - pad * (c.size - 1)) / [...c.values()].reduce((a, v) => a + v, 0)));
      const pos = cols.map((c, ci) => {
        const order = [...c.entries()].sort((a, b) => (ci === 2 ? ((a[0] === '其他') - (b[0] === '其他')) || b[1] - a[1] : b[1] - a[1]));
        const total = order.reduce((a, [, v]) => a + v * k, 0) + pad * (order.length - 1);
        let y = top + (H - top * 2 - total) / 2;
        const m = new Map();
        for (const [name, v] of order) { m.set(name, { y, h: Math.max(2, v * k), v, outY: y, inY: y }); y += v * k + pad; }
        return m;
      });
      const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` }, box);
      const defs = el('defs', {}, svg);
      const nodeColor = (ci, name) => (ci === 0 ? Console.css('--kind-machine') : ci === 1 ? Console.css('--brand-b') : (name === '其他' ? Console.OTHER : colorOf(name)));
      let gi = 0;
      const drawLinks = (m, from, to) => {
        const entries = [...m.entries()].map(([kk, v]) => { const [a, b] = kk.split('|'); return { a, b, v }; })
          .sort((x, y) => pos[from].get(x.a).y - pos[from].get(y.a).y || pos[to].get(x.b).y - pos[to].get(y.b).y);
        for (const l of entries) {
          const s = pos[from].get(l.a); const t = pos[to].get(l.b); if (!s || !t) continue;
          const w = Math.max(1, l.v * k);
          const y0 = s.outY + w / 2; s.outY += w;
          const y1 = t.inY + w / 2; t.inY += w;
          const x0 = xs[from] + nodeW; const x1 = xs[to]; const xm = (x0 + x1) / 2;
          const id = `sg${gi++}`;
          const lg = el('linearGradient', { id, gradientUnits: 'userSpaceOnUse', x1: x0, x2: x1, y1: 0, y2: 0 }, defs);
          el('stop', { offset: '0%', 'stop-color': nodeColor(from, l.a) }, lg);
          el('stop', { offset: '100%', 'stop-color': nodeColor(to, l.b) }, lg);
          const p = el('path', { d: `M${x0},${y0}C${xm},${y0} ${xm},${y1} ${x1},${y1}`, fill: 'none', stroke: `url(#${id})`, 'stroke-width': w, 'stroke-opacity': 0.32, style: 'transition:stroke-opacity .2s;cursor:pointer' }, svg);
          const label = `${from === 0 ? dev(l.a) : tool(l.a)} → ${to === 1 ? tool(l.b) : l.b}`;
          p.addEventListener('mousemove', (e) => { p.setAttribute('stroke-opacity', 0.75); tip.show(e, `<div class="h">${esc(label)}</div><div class="r">会话段<em>${l.v.toLocaleString()}</em></div>`); });
          p.addEventListener('mouseleave', () => { p.setAttribute('stroke-opacity', 0.32); tip.hide(); });
        }
      };
      drawLinks(L1, 0, 1);
      drawLinks(L2, 1, 2);
      pos.forEach((m, ci) => {
        for (const [name, n] of m) {
          el('rect', { x: xs[ci], y: n.y, width: nodeW, height: n.h, rx: 3, fill: nodeColor(ci, name), style: `filter:drop-shadow(0 0 6px ${Console.rgba('--glow-sky-rgb', 0.45)})` }, svg);
          const lab = ci === 0 ? dev(name) : ci === 1 ? tool(name) : name;
          const t = el('text', { x: ci === 2 ? xs[ci] + nodeW + 8 : xs[ci] - 8, y: n.y + n.h / 2 + 4, 'text-anchor': ci === 2 ? 'start' : 'end', style: 'fill:var(--text-primary);font-size:12px' }, svg);
          t.textContent = `${lab}  `;
          const ts = el('tspan', { style: 'fill:var(--text-muted)' }, t); ts.textContent = n.v.toLocaleString();
          if (ci === 1) { t.setAttribute('x', xs[ci] + nodeW + 8); t.setAttribute('text-anchor', 'start'); }
        }
      });
    }

    // ---------------- 一键交接包 ----------------
    async function initHandoff() {
      let ps = [];
      try { ps = await Console.api('/browse/projects'); } catch (e) { Console.toast(e.message, 'err'); }
      $('hoProj').innerHTML = `<option value="">（按关键词）</option>${ps.slice(0, 40).map((x) => `<option value="${esc(x.p)}">${esc(x.p)}（${x.n}）</option>`).join('')}`;
      if (ps[0]) $('hoProj').value = ps[0].p;
      applyProject();
      $('hoShare').onclick = () => Console.share?.open($('hoProj').value);
      const syncShare = () => { $('hoShare').disabled = !$('hoProj').value; };
      $('hoProj').addEventListener('change', syncShare); syncShare();
      $('hoForm').onsubmit = async (e) => {
        e.preventDefault();
        $('hoOut').value = '生成中…';
        try {
          $('hoOut').value = await Console.api('/browse/handoff', { query: { project: $('hoProj').value, days: $('hoDays').value, query: $('hoQ').value } });
        } catch (err) { $('hoOut').value = ''; Console.toast(err.message, 'err'); }
      };
      $('hoCopy').onclick = async () => {
        $('hoOut').select();
        try { await navigator.clipboard.writeText($('hoOut').value); } catch { document.execCommand('copy'); }
        $('hoCopy').textContent = '已复制'; setTimeout(() => { $('hoCopy').textContent = '复制'; }, 1500);
      };
    }

    // #/projects/<项目名>（全局搜索跳进来）：交接包里选中这个项目并滚到那一块；下拉是异步填的，没填好就等 initHandoff 回头再调
    let wantProject = '';
    function applyProject() {
      const sel = root && $('hoProj');
      if (!wantProject || !sel || sel.options.length < 2) return;
      if (![...sel.options].some((o) => o.value === wantProject)) sel.insertAdjacentHTML('beforeend', `<option value="${esc(wantProject)}">${esc(wantProject)}</option>`);
      sel.value = wantProject; wantProject = '';
      const panel = sel.closest('.panel');
      panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
      panel.classList.add('gs-flash'); setTimeout(() => panel.classList.remove('gs-flash'), 1800);
    }

    function draw() { renderRiver(); renderRank(); renderSankey(); }
    Console.page('projects', {
      mount(el0) {
        root = el0;
        root.innerHTML = `
          <div class="row2">
            <section class="panel">
              <div class="ph"><h2>项目河流</h2></div>
              <div class="legend" id="riverLegend"></div>
              <div id="river"></div>
            </section>
            <section class="panel">
              <div class="ph"><h2>项目排行</h2></div>
              <div class="bars" id="rank"></div>
            </section>
          </div>
          <section class="panel">
            <div class="ph"><h2>机器 → 智能体 → 项目</h2></div>
            <div id="sankey"></div>
          </section>
          <section class="panel">
            <div class="ph"><h2>交接包</h2></div>
            <form class="ho" id="hoForm"><select id="hoProj"></select><select id="hoDays"><option value="7">最近 7 天</option><option value="14" selected>最近 14 天</option><option value="30">最近 30 天</option><option value="60">最近 60 天</option></select><input class="inp" id="hoQ" placeholder="可选：再加个关键词"><button>生成</button><button type="button" id="hoCopy">复制</button><button type="button" id="hoShare">分享</button></form>
            <textarea class="inp" id="hoOut" readonly placeholder="生成后在这里，点「复制」贴给新会话或新智能体"></textarea>
          </section>`;
        initHandoff();
      },
      async show(params) { wantProject = params?.arg || ''; DATA = await Console.loadData(); if (DATA) draw(); applyProject(); },
      hide() { tip.hide(); },
      resize() { if (DATA) draw(); },
    });
  })();

  // ======================================================================
  // 待办
  // ======================================================================
  (function todos() {
    let root = null;
    const $ = (id) => root.querySelector(`#${id}`);
    let todoProj = '';
    async function loadTodos() {
      let r;
      try { r = await Console.api('/browse/todos'); } catch (e) { $('todos').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
      Console.badge('todos', r.items.length);
      const projs = [...new Set(r.items.map((t) => t.project).filter(Boolean))];
      if (todoProj && !projs.includes(todoProj)) todoProj = '';
      $('todoChips').innerHTML = [['', `全部 ${r.items.length}`], ...projs.map((p) => [p, `${p} ${r.items.filter((t) => t.project === p).length}`])].map(([k, l]) => `<button data-k="${esc(k)}" class="${k === todoProj ? 'on' : ''}">${k ? `<b style="background:${colorOf(k)}"></b>` : ''}${esc(l)}</button>`).join('');
      $('todoChips').querySelectorAll('button').forEach((b) => { b.onclick = () => { todoProj = b.dataset.k; loadTodos(); }; });
      const list = r.items.filter((t) => !todoProj || t.project === todoProj);
      $('todoHint').textContent = r.stalled.length ? `停了的项目：${r.stalled.map((x) => x.project).join('、')}` : '';
      $('todos').innerHTML = list.map((t) => `<div class="t"><div><div class="s">${t.status === 'blocked' ? '<span class="pill bad">卡住</span>' : '<span class="pill warn">进行中</span>'}${t.project ? `<span class="pill dim">${esc(t.project)}</span>` : ''}${esc(t.summary)}</div>`
        + `<div class="m">${esc(t.date)}（${t.age} 天前）· ${esc(dev(t.device))} · ${esc(tool(t.tool))} ·「${esc(t.title)}」${t.points.length ? `<br>${esc(t.points.slice(0, 3).join('；'))}` : ''}</div></div>`
        + `<div class="btns"><button data-r="${t.ref}" data-a="done">✓ 已收尾</button><button data-r="${t.ref}" data-a="ignore">不用管</button><button data-d="${t.date}">看那天</button></div></div>`).join('') || '<div class="empty">没有悬着的事</div>';
      $('todos').querySelectorAll('button[data-r]').forEach((b) => {
        b.onclick = async () => {
          b.disabled = true;
          try { await Console.api('/browse/todo', { body: { ref: b.dataset.r, action: b.dataset.a } }); } catch (e) { Console.toast(e.message, 'err'); }
          loadTodos();
        };
      });
      $('todos').querySelectorAll('button[data-d]').forEach((b) => { b.onclick = () => Console.go(`timeline/${b.dataset.d}`); });
    }
    Console.page('todos', {
      mount(el0) {
        root = el0;
        root.innerHTML = `
          <section class="panel">
            <div class="ph"><h2>待办雷达</h2><span class="hint" id="todoHint"></span></div>
            <div class="chips" id="todoChips"></div>
            <div class="todo" id="todos"><div class="empty">读取中…</div></div>
          </section>`;
        Console.every('todos', 120000, loadTodos);
      },
      show() { loadTodos(); },
      theme() { loadTodos(); },
    });
  })();
})();
