/* 拓扑时间回放：画布和事件带之间一条近 24 小时的时间轴，可拖、可播放、可回到现在。
 *
 * 数据：GET /console/api/topology/history?hours=48&bucket=15，一次取回，之后拖动不再请求（每 5 分钟在实时状态下悄悄刷新一次）。
 *   前 24 小时只用来算"滚动 24 小时"，时间轴只能拖最近 24 小时（96 格，每格 15 分钟），拖到的位置都落在格子的末尾。
 * 介入方式：console-topology.js 暴露 window.TopologyHooks。回放中 HK.now = 那一刻，HK.view 把实时数据改写成那一刻的样子：
 *   设备状态（在线/超时）、↑↓ 数字、心跳条、连线的光点密度和粗细、事件带都按那一刻；抽取机、报表的最近活动按那一刻之前的事件；
 *   中心的记忆数、存档、向量服务这类"当前存量"不回溯，保持现在的值。回放中不轮询事件、实时刷新也不覆盖画面，回到现在才恢复。
 * 播放：按"每秒走多少分钟"推进，到头自动回到现在；播放中新进入的事件在连线上放脉冲。
 * 大屏（?embed=1）：自动循环——实时停一会，回到 6 小时前快放到现在，再回实时；有人碰了时间轴就不再自动。
 */
(function () {
  'use strict';
  const HK = window.TopologyHooks;
  if (!HK) return;
  const h = Console.esc;
  const MIN = 60e3; const HOUR = 3600e3;
  const VIEW_H = 24; // 时间轴能拖多远
  const PRE_H = 24; // 再往前多取一天，只用来算"滚动 24 小时"
  const BUCKET = 15; // 每格分钟数
  const SPEEDS = [[5, '5 分钟/秒'], [15, '15 分钟/秒'], [30, '30 分钟/秒'], [60, '1 小时/秒']];
  const SPEED_KEY = 'am.topology.replay-speed';
  const AUTO_BACK = 24; // 大屏自动播放从 24 格（6 小时）前开始
  const AUTO_SPEED = 30;
  const RM = window.matchMedia('(prefers-reduced-motion: reduce)');
  const ICON = {
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 5.5v13M15.5 5.5v13"/></svg>',
  };

  let H = null; let by = null; let evT = null; let V = Math.round((VIEW_H * 60) / BUCKET); let I0 = 0; let W = V;
  let fetching = null; let fetchedAt = 0;
  let pos = null; let playing = false; let speed = 15; let lastTick = 0; let acc = 0; let timer = null; let want = null;
  let box = null; let bar = null; let q = {};
  let auto = false; let autoTimer = null; let autoRan = 0;

  const embed = Console.embed;
  if (embed) speed = AUTO_SPEED;
  else { try { const s = Number(localStorage.getItem(SPEED_KEY)); if (SPEEDS.some(([v]) => v === s)) speed = s; } catch { /* 用默认 */ } }

  const tAt = (j) => H.t0 + (I0 + j) * H.B; // 位置 j 对应的时刻：第 I0+j-1 格的末尾
  const jMin = () => Math.max(0, 1 - I0);
  const fmtT = (ms) => `${Console.date.localDay(ms).slice(5)} ${Console.date.hm(new Date(ms).toISOString())}`;
  const hm = (ms) => Console.date.hm(new Date(ms).toISOString());

  // ---------------- 数据 ----------------
  function prep(r) {
    const C = r.count; const B = r.bucket * MIN;
    const v = Math.min(C, Math.round((VIEW_H * 60) / r.bucket));
    by = new Map();
    for (const d of r.devices) {
      const cu = [0]; const cd = [0]; // 前缀和：任意一段的合计 = 两个数相减
      for (let i = 0; i < C; i++) { cu.push(cu[i] + d.up[i]); cd.push(cd[i] + d.down[i]); }
      by.set(d.name, { ...d, cu, cd });
    }
    evT = {}; // 种类\n设备 → 升序的事件时间：抽取机、报表的"最近活动"按它推
    for (const c of r.events) if (c) for (const e of c.items) if (e.kind === 'extract' || e.kind === 'report') (evT[`${e.kind}\n${e.device}`] ||= []).push(Date.parse(e.t));
    V = v; I0 = C - v; W = Math.round((24 * 60) / r.bucket);
    H = { ...r, t0: Date.parse(r.from), B };
    fetchedAt = Date.now();
    drawTrack();
    sync();
    return H;
  }
  // 回放中不重取（位置是相对这一份数据的）；实时状态下超过 5 分钟才重取
  function ensure(force) {
    if (!force && H && (pos !== null || Date.now() - fetchedAt < 5 * MIN)) return Promise.resolve(H);
    if (fetching) return fetching;
    fetching = Console.api('/console/api/topology/history', { query: { hours: VIEW_H + PRE_H, bucket: BUCKET } }).then(prep).finally(() => { fetching = null; });
    return fetching;
  }

  // 第 k 格末尾那一刻的"滚动 24 小时"：总量，以及按小时分的 24 格（最旧在前）
  function rolling(hd, k) {
    const lo = Math.max(0, k + 1 - W);
    const out = { up_24h: hd.cu[k + 1] - hd.cu[lo], down_24h: hd.cd[k + 1] - hd.cd[lo], hours: Array(24).fill(0), hours_down: Array(24).fill(0) };
    for (let i = lo; i <= k; i++) {
      const c = 23 - Math.floor(((k - i) * H.B) / HOUR);
      if (c < 0) continue;
      out.hours[c] += hd.up[i]; out.hours_down[c] += hd.down[i];
    }
    return out;
  }

  // 把实时数据改写成位置 pos 那一刻的样子
  function view(live) {
    const k = I0 + pos - 1; const T = tAt(pos);
    const nameOf = (d) => d.label || Console.dev(d.name) || d.name;
    let up = 0; let down = 0;
    const devices = live.devices.map((d) => {
      const hd = by.get(d.name);
      if (!hd) return d;
      const st = hd.state[k]; const idle = hd.idle[k];
      const seen = idle === null ? null : new Date(T - idle * MIN).toISOString();
      const flow = rolling(hd, k);
      up += flow.up_24h; down += flow.down_24h;
      return {
        ...d, flow, paused: st === 'paused' || st === 'none', none: st === 'none', stale: st === 'stale', live: st === 'live',
        last_seen: seen, last_msg: st === 'live' ? seen : null, agents: d.agents.map((a) => ({ ...a, live: false, last_msg: null })),
      };
    });
    const problems = devices.filter((d) => d.stale).map((d) => {
      const i = by.get(d.name).idle[k];
      return { key: `stale:${d.name}`, text: i === null ? `设备 ${nameOf(d)} 登记后一次都没同步过` : `设备 ${nameOf(d)} 已经 ${i >= 2880 ? `${Math.floor(i / 1440)} 天` : `${Math.floor(i / 60)} 小时`}没同步` };
    });
    const lastOf = (kind, name) => { let r = null; for (const ms of evT[`${kind}\n${name}`] || []) { if (ms <= T) r = ms; else break; } return r ? new Date(r).toISOString() : null; };
    return {
      ...live, now: new Date(T).toISOString(), replay: true, devices, problems, hub: { ...live.hub, up_24h: up, down_24h: down },
      extractors: live.extractors.map((x) => ({ ...x, last_active: lastOf('extract', x.name) })),
      reporters: live.reporters.map((x) => ({ ...x, last_active: lastOf('report', x.name) })),
    };
  }

  // 事件带：那一刻之前最近的 12 条（新→旧）
  HK.feed = (proj) => {
    const out = [];
    for (let i = I0 + pos - 1; i >= 0 && out.length < 12; i--) {
      const c = H.events[i];
      if (!c) continue;
      for (let m = c.items.length - 1; m >= 0 && out.length < 12; m--) if (!proj || c.items[m].project === proj) out.push(c.items[m]);
    }
    return out;
  };
  // 播放中刚进入的这一格里的事件：最新的三条放脉冲
  function emit(k) {
    if (RM.matches) return;
    (H.events[k]?.items || []).slice(-3).forEach((e, i) => setTimeout(() => { if (playing && pos !== null) HK.pulse(e); }, i * 200));
  }

  // ---------------- 位置和播放 ----------------
  function sync() {
    if (!bar) return;
    const j = pos === null ? V : pos;
    q.range.min = String(jMin()); q.range.max = String(V);
    if (want === null) q.range.value = String(j); // 正在等数据的拖动，别把滑块拽回去
    q.time.textContent = pos === null || !H ? '现在' : fmtT(tAt(pos));
    q.time.title = pos === null || !H ? '' : `${Console.date.ago(new Date(tAt(pos)).toISOString())}`;
    q.live.disabled = pos === null;
    q.play.innerHTML = playing ? ICON.pause : ICON.play;
    q.play.setAttribute('aria-label', playing ? '暂停' : '播放');
    q.speed.value = String(speed);
  }
  function setPlaying(on) {
    playing = on;
    clearInterval(timer); timer = null;
    if (on) { lastTick = performance.now(); acc = 0; timer = setInterval(step, 100); }
    sync();
  }
  function step() {
    const now = performance.now(); const dt = now - lastTick; lastTick = now;
    acc += (speed * dt) / 1000; // 这一小段走了多少分钟（speed 是每秒走几分钟，按真实经过的时间算，标签页被节流也不会变慢）
    const adv = Math.floor(acc / BUCKET);
    if (!adv) return;
    acc -= adv * BUCKET;
    if (pos + adv >= V) toLive(); else go(pos + adv, true);
  }
  function go(j, pulse) {
    j = Math.max(jMin(), Math.round(j));
    if (j >= V) { toLive(); return; }
    pos = j; HK.now = tAt(j); HK.view = view;
    box.classList.add('tp-replaying'); bar.classList.add('past');
    sync();
    HK.refresh();
    if (pulse) emit(I0 + j - 1);
  }
  function toLive() {
    const was = pos !== null;
    pos = null; HK.now = null; HK.view = null;
    box.classList.remove('tp-replaying'); bar?.classList.remove('past');
    setPlaying(false);
    if (was) { HK.refresh(); HK.reload(); } // 回到现在：马上取一次实时数据，轮询随即恢复
    if (auto) { autoRan = Date.now(); scheduleAuto(45e3); }
  }
  async function seek(j) {
    want = j;
    if (!H || pos === null) {
      try { await ensure(); } catch (e) { want = null; Console.toast(`回放数据读取失败：${e.message}`, 'err'); sync(); return; }
    }
    if (want === null) return;
    const t = want; want = null;
    go(t);
  }

  // ---------------- 大屏自动循环 ----------------
  function scheduleAuto(ms) { clearTimeout(autoTimer); autoTimer = setTimeout(runAuto, ms); }
  function cancelAuto() { auto = false; clearTimeout(autoTimer); }
  async function runAuto() {
    if (!auto) return;
    if (document.hidden || !Console.visible('topology') || playing || pos !== null) { scheduleAuto(5000); return; }
    try { await ensure(); } catch { scheduleAuto(30e3); return; }
    if (!auto || playing || pos !== null) return;
    autoRan = Date.now();
    go(Math.max(jMin(), V - AUTO_BACK));
    setPlaying(true);
  }

  // ---------------- 界面 ----------------
  function drawTicks(t0, t1) { // 每 6 小时（东八区）一个刻度
    let t = Math.ceil((t0 + 8 * HOUR) / (6 * HOUR)) * 6 * HOUR - 8 * HOUR;
    let html = '';
    for (; t < t1; t += 6 * HOUR) if (t > t0 + 30 * MIN) html += `<span style="left:${(((t - t0) / (t1 - t0)) * 100).toFixed(2)}%">${hm(t)}</span>`;
    q.ticks.innerHTML = html;
  }
  function drawTrack() {
    if (!bar) return;
    const tot = []; let mx = 0;
    for (let b = 0; b < V; b++) { // 第 b 根柱子 = 第 I0+b 格 = 位置 b 到 b+1 之间
      let u = 0; let d = 0;
      for (const x of by.values()) { u += x.up[I0 + b]; d += x.down[I0 + b]; }
      tot.push([u, d]); mx = Math.max(mx, u + d);
    }
    q.spark.innerHTML = tot.map(([u, d]) => {
      const t = u + d;
      if (!t) return '<i></i>';
      const wp = Math.round((u / t) * 100);
      return `<i style="height:${Math.max(12, Math.round((t / mx) * 100))}%;background:linear-gradient(to top,rgb(var(--tp-up)) ${wp}%,rgb(var(--tp-dn)) ${wp}%)"></i>`;
    }).join('');
    drawTicks(tAt(0), tAt(V));
  }

  HK.extraH = () => (bar ? bar.offsetHeight : 0);
  HK.hidden = () => { if (playing) setPlaying(false); };
  HK.mounted = (b) => {
    box = b;
    bar = document.createElement('div');
    bar.className = 'tp-rp';
    bar.innerHTML = `<button type="button" class="tp-rp-play" aria-label="播放">${ICON.play}</button>
      <div class="tp-rp-track"><div class="tp-rp-spark" aria-hidden="true"></div><input class="tp-rp-range" type="range" min="0" max="${V}" step="1" value="${V}" aria-label="时间轴"><div class="tp-rp-ticks" aria-hidden="true"></div></div>
      <time class="tp-rp-time">现在</time>
      <select class="inp tp-rp-speed" aria-label="播放速度">${SPEEDS.map(([v, l]) => `<option value="${v}">${h(l)}</option>`).join('')}</select>
      <button type="button" class="btn tp-rp-live" disabled>回到现在</button>`;
    b.querySelector('.tp-ev').before(bar);
    q = { play: bar.querySelector('.tp-rp-play'), range: bar.querySelector('.tp-rp-range'), spark: bar.querySelector('.tp-rp-spark'), ticks: bar.querySelector('.tp-rp-ticks'), time: bar.querySelector('.tp-rp-time'), speed: bar.querySelector('.tp-rp-speed'), live: bar.querySelector('.tp-rp-live') };
    drawTicks(Date.now() - VIEW_H * HOUR, Date.now());
    bar.addEventListener('pointerdown', cancelAuto);
    bar.addEventListener('keydown', cancelAuto);
    q.range.addEventListener('input', () => { const j = Number(q.range.value); setPlaying(false); seek(j); }); // 先读值：setPlaying 会同步滑块
    q.play.addEventListener('click', async () => {
      if (playing) { setPlaying(false); return; }
      try { await ensure(); } catch (e) { Console.toast(`回放数据读取失败：${e.message}`, 'err'); return; }
      if (pos === null || pos >= V - 1) go(jMin()); // 在现在（或已到头）按播放：从 24 小时前开始
      setPlaying(true);
    });
    q.live.addEventListener('click', toLive);
    q.speed.addEventListener('change', () => {
      speed = Number(q.speed.value);
      if (!embed) { try { localStorage.setItem(SPEED_KEY, String(speed)); } catch { /* 存不了就只在这次页面里有效 */ } }
    });
    sync();
    setTimeout(() => ensure().catch(() => {}), 600); // 先取好，时间轴上的活跃度小图就有了，第一次拖动也不用等
    Console.every('topology', 5 * MIN, () => { if (pos === null && !playing) ensure(true).catch(() => {}); });
    if (embed && !RM.matches) {
      auto = true;
      scheduleAuto(2500);
      // 大屏每次轮到拓扑这一屏会给它发一个 resize：实时状态下马上开始一轮（离上一轮结束不到 8 秒的不算）
      addEventListener('resize', () => { if (auto && !playing && pos === null && Date.now() - autoRan > 8000) scheduleAuto(300); });
    }
  };
})();
