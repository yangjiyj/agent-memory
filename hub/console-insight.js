/* 用量洞察：待整理页的两个新栏——记忆缺口（近 30 天搜过但 0 命中的查询）和冷记忆（很久没被读到的有效记忆）。
 * 通过 console-memory.js 留的入口 Console.triageTabs 追加，不进侧栏徽标。样式在 console-insight.css，类名带 ins- 前缀。
 * 数据来自 /console/api/insight/*（hub/admin-insight.mjs）。 */
(function () {
  'use strict';
  const { esc, dev, date } = Console;
  const A = '/console/api/insight/';
  const PAGE = 30;
  const GROUP_PAGE = 10;
  const CORPUS = { conversation: '对话', kb: '卡片', timeline: '时间线' }; // 记忆里的搜索不加标签
  const fresh = (t) => Date.now() - t < 60e3;
  const mmdd = (iso) => date.localDay(Date.parse(iso)).slice(5);
  const ago = (iso) => { const d = Math.floor((Date.now() - Date.parse(iso)) / 86400e3); return d < 1 ? '今天' : `${d} 天前`; };

  let rerender = null; // 待整理页交给我们的重画函数（warm 时拿到），数据回来后用它刷新栏标题上的数字
const live = (body, id) => body.isConnected && body.dataset.ext === id; // 加载回来时用户可能已经切走了

  // ======================================================================
  // 记忆缺口
  // ======================================================================
  const G = { data: null, at: 0, loading: null, err: '', shown: PAGE, openIgnored: false };

  function loadGaps(force) {
    if (G.loading) return G.loading;
    if (G.data && !force && fresh(G.at)) return Promise.resolve();
    G.loading = Console.api(`${A}gaps`).then((d) => { G.data = d; G.at = Date.now(); G.err = ''; })
      .catch((e) => { G.err = e.message; G.at = Date.now(); }).finally(() => { G.loading = null; });
    return G.loading;
  }

  const who = (g) => {
    const names = g.devices.map(dev);
    return g.device_count === 1 ? esc(names[0]) : `<span title="${esc(names.join('、'))}${g.device_count > names.length ? '…' : ''}">${g.device_count} 台</span>`;
  };

  function paintGaps(body) {
    if (!live(body, 'gaps')) return;
    const d = G.data;
    if (!d) { body.innerHTML = `<div class="empty">${G.err ? `读取失败：${esc(G.err)}` : '读取中…'}</div>`; return; }
    const rows = d.groups.slice(0, G.shown).map((g) => {
      const alts = g.variants.filter((v) => v.text !== g.text);
      return `<div class="mem-card ins-row"><div class="ins-main">
        <div class="ins-q"><span>${esc(g.text)}</span>${CORPUS[g.corpus] ? `<span class="pill dim">${CORPUS[g.corpus]}</span>` : ''}</div>
        <div class="ins-meta">${g.count} 次 · ${who(g)} · 最近 ${esc(ago(g.last))}</div>
        ${alts.length ? `<div class="ins-alt">也有：${alts.slice(0, 3).map((v) => esc(v.text)).join(' · ')}${alts.length > 3 ? ` 等 ${alts.length} 种` : ''}</div>` : ''}
      </div><button class="btn" data-ins-ign="${esc(g.key)}">忽略</button></div>`;
    }).join('');
    const more = d.groups.length > G.shown ? `<div class="mem-more"><button class="btn" data-ins-more>再显示 ${Math.min(PAGE, d.groups.length - G.shown)} 条（还有 ${d.groups.length - G.shown}）</button></div>` : '';
    const foot = d.ignored_count
      ? `<div class="ins-foot"><button class="ins-link" data-ins-showign>已忽略 ${d.ignored_count} 条 ${G.openIgnored ? '▴' : '▾'}</button>${G.openIgnored
        ? d.ignored.map((x) => `<div class="ins-ign"><span>${esc(x.text)}${CORPUS[x.corpus] ? ` <span class="pill dim">${CORPUS[x.corpus]}</span>` : ''}</span><button class="btn" data-ins-restore="${esc(x.key)}">恢复</button></div>`).join('') : ''}</div>`
      : '';
    body.innerHTML = (rows ? rows + more : `<div class="empty">${d.since ? '近 30 天没有搜不到的查询' : '还没有搜索记录'}</div>`) + foot;
  }

  async function gapAction(body, fn, ok) {
    try { await fn(); Console.toast(ok, 'ok'); } catch (e) { Console.toast(e.message, 'err'); }
    await loadGaps(true);
    paintGaps(body);
    rerender?.();
  }

  // ======================================================================
  // 冷记忆
  // ======================================================================
  const C = { data: null, at: 0, loading: null, err: '', days: 30, open: null, more: {} };
  const DAYS = [30, 60, 90];

  function loadCold(force) {
    if (C.loading) return C.loading;
    if (C.data && C.data.days === C.days && !force && fresh(C.at)) return Promise.resolve();
    const days = C.days;
    C.loading = Console.api(`${A}cold`, { query: { days } }).then((d) => { C.data = d; C.at = Date.now(); C.err = ''; })
      .catch((e) => { C.err = e.message; C.data = null; C.at = Date.now(); }).finally(() => { C.loading = null; });
    return C.loading;
  }

  const chips = () => `<div class="chips">${DAYS.map((n) => `<button type="button" data-ins-days="${n}" class="${C.days === n ? 'on' : ''}">${n} 天</button>`).join('')}</div>`;

  function paintCold(body) {
    if (!live(body, 'cold')) return;
    const d = C.data;
    if (!d) { body.innerHTML = `<div class="empty">${C.err ? `读取失败：${esc(C.err)}` : '读取中…'}</div>`; return; }
    const stale = d.days !== C.days; // 正在换天数，先保留旧的
    if (d.accumulating) {
      body.innerHTML = `<div class="ins-head"><span></span>${chips()}</div><div class="empty ins-acc">${d.since
        ? `读取记录从 <b>${esc(mmdd(d.since))}</b> 起，已攒 ${Math.floor(d.observed_days)} 天；攒满 ${d.days} 天后这里才会列出`
        : '还没有读取记录'}</div>`;
      return;
    }
    if (C.open === null) C.open = d.groups[0]?.project ?? '';
    const sinceTxt = mmdd(d.since);
    const groups = d.groups.map((g) => {
      const isOpen = C.open === g.project;
      const n = C.more[g.project] || GROUP_PAGE;
      const items = isOpen ? g.items.slice(0, n).map((it) => `<div class="ins-item"><div class="ins-it"><span class="pill">${esc(Console.zh.type[it.type] || it.type)}</span><a href="#/lib/${esc(it.id)}">${esc(it.title)}</a></div>
        <div class="ins-im">更新于 ${esc(ago(it.updated))} · ${it.last_read ? `最后读到 ${esc(mmdd(it.last_read))}` : `自 ${esc(sinceTxt)} 起没读到过`}</div></div>`).join('')
        + (g.items.length > n ? `<div class="mem-more"><button class="btn" data-ins-gmore="${esc(g.project)}">再显示 ${Math.min(GROUP_PAGE, g.items.length - n)} 条（还有 ${g.items.length - n}）</button></div>` : '') : '';
      return `<section class="ins-grp"><button class="ins-gh ${isOpen ? 'on' : ''}" data-ins-grp="${esc(g.project)}"><i>${isOpen ? '▾' : '▸'}</i><span>${esc(g.project || '未归项目')}</span><b>${g.count}</b></button>${items}</section>`;
    }).join('');
    body.innerHTML = `<div class="ins-head"><span>${stale ? '读取中…' : `从 <b>${esc(sinceTxt)}</b> 起记录读取 · ${d.days} 天内没被读到的有效记忆 <b>${d.total}</b> 条${d.shown < d.total ? `（列出最早的 ${d.shown} 条）` : ''}`}</span>${chips()}</div>`
      + (groups || '<div class="empty">近这段时间每条有效记忆都被读到过</div>');
  }

  // ======================================================================
  // 挂到待整理页（同一个 body，一个点击入口按 data-ins-* 分发）
  // ======================================================================
  function bind(body) {
    if (body.dataset.insBound) return;
    body.dataset.insBound = '1';
    body.addEventListener('click', async (ev) => {
      const t = ev.target.closest('[data-ins-ign],[data-ins-restore],[data-ins-more],[data-ins-showign],[data-ins-days],[data-ins-grp],[data-ins-gmore]');
      if (!t) return;
      const ds = t.dataset;
      if (ds.insIgn) { t.disabled = true; await gapAction(body, () => Console.api(`${A}ignore`, { body: { key: ds.insIgn } }), '已忽略，在栏底可恢复'); return; }
      if (ds.insRestore) { t.disabled = true; await gapAction(body, () => Console.api(`${A}ignore`, { body: { key: ds.insRestore, ignored: false } }), '已恢复'); return; }
      if (ds.insMore !== undefined) { G.shown += PAGE; paintGaps(body); return; }
      if (ds.insShowign !== undefined) { G.openIgnored = !G.openIgnored; paintGaps(body); return; }
      if (ds.insDays) { C.days = Number(ds.insDays); C.open = null; C.more = {}; paintCold(body); await loadCold(true); paintCold(body); rerender?.(); return; }
      if (ds.insGrp !== undefined) { C.open = C.open === ds.insGrp ? false : ds.insGrp; paintCold(body); return; }
      if (ds.insGmore !== undefined) { C.more[ds.insGmore] = (C.more[ds.insGmore] || GROUP_PAGE) + GROUP_PAGE; paintCold(body); }
    });
  }

  const tabs = Console.triageTabs;
  if (!tabs) return; // console-memory.js 没加载就什么都不挂
  tabs.push({
    id: 'gaps', title: '记忆缺口',
    count: () => (G.data && G.data.groups.length) || null,
    warm(render) { rerender = render; loadGaps().then(render); },
    show(body) { bind(body); paintGaps(body); if (!fresh(G.at)) loadGaps().then(() => { paintGaps(body); rerender?.(); }); },
  }, {
    id: 'cold', title: '冷记忆',
    count: () => (C.data && !C.data.accumulating && C.data.days === C.days && C.data.total) || null,
    warm(render) { rerender = render; loadCold().then(render); },
    show(body) { bind(body); paintCold(body); if (!fresh(C.at) || (C.data && C.data.days !== C.days)) loadCold().then(() => { paintCold(body); rerender?.(); }); },
  });
})();
