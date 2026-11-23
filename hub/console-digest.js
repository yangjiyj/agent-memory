/* 摘要页：预览某台设备上某个智能体启动时实际拿到的摘要，管理哪些记忆置顶、哪些排除，标出没信息量和重复的。
 * 接口：GET /console/api/digest?device=&tool=、POST /console/api/digest/rule；合并走已有的 /browse/manage-action。样式在 console-tools.css，类名带 dg- 前缀。 */
(function () {
  'use strict';
  const { esc, dev, tool, zh, date } = Console;

  const SECTIONS = ['偏好与反馈', '项目现状', '决定与坑', '参考与事实'];
  const FILTERS = [['all', '全部'], ['listed', '已列出'], ['unlisted', '没列出'], ['pinned', '置顶'], ['excluded', '排除'], ['vague', '没信息量'], ['dup', '重复']];
  const PAGE = 30;
  const WHY = { generic: '通用词，说不清记了什么', short: '过短', label: '只是个栏目名', unrelated: '标题和正文对不上' };
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  const day = (iso) => date.localDay(Date.parse(iso));

  let root = null; let D = null; let loading = null;
  const st = { device: '', tool: '', filter: 'all', open: [true, true, true, true], shown: [PAGE, PAGE, PAGE, PAGE], text: false, dupShown: PAGE };

  const q = (sel) => root.querySelector(sel);
  const test = {
    all: () => true, listed: (x) => x.listed, unlisted: (x) => !x.listed && !x.excluded, pinned: (x) => x.pinned, excluded: (x) => x.excluded,
    vague: (x) => x.flags.includes('vague'), dup: (x) => x.flags.includes('dup'),
  };

  async function load() {
    if (loading) return loading;
    loading = Console.api('/console/api/digest', { query: { device: st.device, tool: st.tool } }).then((d) => {
      D = d; st.device = d.device; st.tool = d.tool;
      render();
    }).catch((e) => {
      // 记着的设备/智能体已经不存在了：回到默认再来一次
      if (e.status === 400 && (st.device || st.tool)) { st.device = ''; st.tool = ''; loading = null; return load(); }
      q('#dg-body').innerHTML = `<div class="empty">读取失败：${esc(e.message)}</div>`;
    }).finally(() => { loading = null; });
    return loading;
  }

  // ---- 渲染 ----
  function pickers() {
    const devs = D.options.devices;
    q('#dg-dev').innerHTML = devs.map((d) => `<option value="${esc(d.name)}">${esc(d.label || dev(d.name))}</option>`).join('');
    q('#dg-dev').value = D.device;
    const tools = devs.find((d) => d.name === D.device)?.tools || [];
    const list = tools.includes(D.tool) ? tools : [D.tool, ...tools];
    q('#dg-tool').innerHTML = list.map((t) => `<option value="${esc(t)}">${esc(tool(t))}</option>`).join('');
    q('#dg-tool').value = D.tool;
  }
  function stats() {
    const { budget, counts } = D;
    const pct = Math.min(100, Math.round((budget.used / budget.limit) * 100));
    q('#dg-meter').innerHTML = `<div class="dg-mt"><b>${kb(budget.used)}</b><span>/ ${kb(budget.limit)}</span></div>`
      + `<div class="dg-track" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i class="${budget.used > budget.limit ? 'over' : ''}" style="width:${pct}%"></i></div>`;
    const cell = (n, l, f) => `<button class="dg-cell ${st.filter === f ? 'on' : ''}" data-f="${f}"><b>${n}</b><span>${l}</span></button>`;
    q('#dg-nums').innerHTML = cell(counts.listed, '已列出', 'listed') + cell(counts.unlisted, '没列出', 'unlisted') + cell(counts.pinned, '置顶', 'pinned') + cell(counts.excluded, '排除', 'excluded');
    q('#dg-text-btn').classList.toggle('on', st.text);
    q('#dg-text').hidden = !st.text;
    if (st.text) q('#dg-text pre').textContent = D.text;
  }
  function chips() {
    const n = { all: D.counts.active, listed: D.counts.listed, unlisted: D.counts.unlisted, pinned: D.counts.pinned, excluded: D.counts.excluded, vague: D.counts.vague, dup: D.counts.dup_groups };
    q('#dg-chips').innerHTML = FILTERS.map(([k, l]) => `<button data-f="${k}" class="${st.filter === k ? 'on' : ''}">${l}${n[k] || k === 'all' ? ` <i>${n[k]}${k === 'dup' ? ' 组' : ''}</i>` : ''}</button>`).join('');
  }
  function row(x) {
    const flags = [];
    if (x.flags.includes('vague')) flags.push(`<a class="pill warn" href="#/lib/${esc(x.id)}" title="${esc(WHY[x.vague_why] || '')}">没信息量 · 改标题</a>`);
    if (x.flags.includes('dup')) flags.push(`<button class="pill warn dg-pb" data-merge="${x.dup}">重复 · 合并</button>`);
    const state = x.excluded ? '<span class="pill dim">已排除</span>' : x.pinned ? '<span class="pill ok">置顶</span>' : !x.listed ? '<span class="pill dim">没列出</span>' : '';
    return `<div class="dg-row ${x.excluded ? 'ex' : ''} ${x.listed ? '' : 'off'}" data-id="${esc(x.id)}">`
      + `<div class="dg-rt"><a class="mem-title dg-t" href="#/lib/${esc(x.id)}">${esc(x.title)}</a>`
      + `<div class="mem-meta"><span class="pill">${esc(zh.type[x.type] || x.type)}</span>${esc([x.project, day(x.updated).slice(5)].filter(Boolean).join(' · '))}${state ? ` ${state}` : ''}${flags.length ? ` ${flags.join('')}` : ''}</div></div>`
      + `<div class="dg-ra">${x.excluded ? '' : `<button class="btn" data-rule="${x.pinned ? 'unpin' : 'pin'}">${x.pinned ? '取消置顶' : '置顶'}</button>`}`
      + `<button class="btn ${x.excluded ? '' : 'warn'}" data-rule="${x.excluded ? 'include' : 'exclude'}">${x.excluded ? '放回' : '排除'}</button></div></div>`;
  }
  const more = (n, k) => `<div class="mem-more"><button class="btn" data-more="${k}">再显示 ${Math.min(PAGE, n)} 条（还有 ${n}）</button></div>`;

  function body() {
    const box = q('#dg-body');
    if (st.filter === 'dup') {
      const groups = new Map();
      for (const x of D.items.filter(test.dup)) (groups.get(x.dup) || groups.set(x.dup, []).get(x.dup)).push(x);
      const list = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
      box.innerHTML = list.length ? list.slice(0, st.dupShown).map(([g, xs]) => `<div class="dg-grp"><div class="dg-gh"><b>${xs.length} 条近似</b><button class="btn" data-merge="${g}">合并</button></div>${xs.map(row).join('')}</div>`).join('')
        + (list.length > st.dupShown ? more(list.length - st.dupShown, 'dup') : '') : '<div class="empty">没有重复的</div>';
      return;
    }
    const fn = test[st.filter];
    let html = '';
    for (let s = 0; s < 4; s++) {
      const all = D.items.filter((x) => x.section === s);
      const xs = all.filter(fn);
      if (!xs.length) continue;
      const listed = all.filter((x) => x.listed).length;
      html += `<div class="dg-sec ${st.open[s] ? 'open' : ''}"><button class="dg-sh" data-sec="${s}"><i class="dg-car"></i><b>${SECTIONS[s]}</b><span>列出 ${listed} / ${all.length}${st.filter !== 'all' ? ` · 符合 ${xs.length}` : ''}</span></button>`;
      if (st.open[s]) html += xs.slice(0, st.shown[s]).map(row).join('') + (xs.length > st.shown[s] ? more(xs.length - st.shown[s], s) : '');
      html += '</div>';
    }
    box.innerHTML = html || '<div class="empty">没有符合的</div>';
  }
  function render() {
    if (!D) return;
    pickers(); stats(); chips(); body();
  }

  // ---- 操作 ----
  async function rule(id, action) {
    try { await Console.api('/console/api/digest/rule', { body: { id, action } }); } catch (e) { Console.toast(`失败：${e.message}`, 'err'); return; }
    await load();
  }

  function mergeDialog(gid) {
    const xs = D.items.filter((x) => x.dup === gid).sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
    if (xs.length < 2) return;
    const wrap = document.createElement('div');
    wrap.className = 'mem-modal';
    wrap.innerHTML = `<div class="mem-dlg dg-dlg" role="dialog" aria-modal="true"><h3>合并 ${xs.length} 条近似的记忆</h3>`
      + `<div class="dg-pick">${xs.map((x, i) => `<label class="mem-gr"><input type="radio" name="dg-keep" value="${esc(x.id)}" ${i === 0 ? 'checked' : ''}><div><div class="mem-title">${esc(x.title)}</div>`
        + `<div class="mem-meta"><span class="pill">${esc(zh.type[x.type] || x.type)}</span>${esc([x.project, day(x.updated)].filter(Boolean).join(' · '))}</div></div></label>`).join('')}</div>`
      + '<div class="mem-dact"><button class="btn" data-x>取消</button><button class="btn warn" data-ok>合并，保留选中的</button></div></div>';
    document.body.appendChild(wrap);
    const done = () => { document.removeEventListener('keydown', key, true); wrap.remove(); };
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(); } };
    document.addEventListener('keydown', key, true);
    wrap.onclick = (e) => { if (e.target === wrap) done(); };
    wrap.querySelector('[data-x]').onclick = done;
    const ok = wrap.querySelector('[data-ok]');
    ok.onclick = async () => {
      const keep = wrap.querySelector('input:checked').value;
      ok.disabled = true;
      try {
        const r = await Console.api('/browse/manage-action', { body: { action: 'merge', ids: [keep, ...xs.map((x) => x.id).filter((id) => id !== keep)] } });
        Console.toast(`已合并，${r.n ?? xs.length - 1} 条被取代`, 'ok');
        done();
        window.dispatchEvent(new Event('am-lib-stale'));
        await load();
      } catch (e) { ok.disabled = false; Console.toast(`失败：${e.message}`, 'err'); }
    };
    ok.focus();
  }

  Console.page('digest', {
    title: '摘要',
    mount(el) {
      root = el;
      el.innerHTML = '<section class="panel dg-bar"><select class="inp" id="dg-dev" aria-label="设备"></select><select class="inp" id="dg-tool" aria-label="智能体"></select><span class="sp"></span>'
        + '<button class="btn" id="dg-text-btn">摘要原文</button></section>'
        + '<section class="panel dg-stat"><div class="dg-meter" id="dg-meter"></div><div class="dg-nums" id="dg-nums"></div></section>'
        + '<section class="panel dg-text" id="dg-text" hidden><pre class="mem-body scroll"></pre></section>'
        + '<section class="panel dg-list"><div class="chips" id="dg-chips"></div><div id="dg-body"><div class="empty">读取中…</div></div></section>';
      q('#dg-dev').onchange = (e) => { st.device = e.target.value; st.tool = ''; load(); };
      q('#dg-tool').onchange = (e) => { st.tool = e.target.value; load(); };
      q('#dg-text-btn').onclick = () => { st.text = !st.text; stats(); };
      el.addEventListener('click', (ev) => {
        const f = ev.target.closest('[data-f]');
        if (f) { st.filter = st.filter === f.dataset.f && f.dataset.f !== 'all' ? 'all' : f.dataset.f; st.shown = [PAGE, PAGE, PAGE, PAGE]; st.dupShown = PAGE; stats(); chips(); body(); return; }
        const sec = ev.target.closest('[data-sec]');
        if (sec) { const s = Number(sec.dataset.sec); st.open[s] = !st.open[s]; body(); return; }
        const m = ev.target.closest('[data-more]');
        if (m) { if (m.dataset.more === 'dup') st.dupShown += PAGE; else st.shown[Number(m.dataset.more)] += PAGE; body(); return; }
        const mg = ev.target.closest('[data-merge]');
        if (mg) { mergeDialog(Number(mg.dataset.merge)); return; }
        const r = ev.target.closest('[data-rule]');
        if (r && !r.disabled) { r.disabled = true; rule(r.closest('.dg-row').dataset.id, r.dataset.rule); }
      });
    },
    async show(params) {
      if (params.query.device) st.device = params.query.device;
      if (params.query.tool) st.tool = params.query.tool;
      await load();
    },
  });
})();
