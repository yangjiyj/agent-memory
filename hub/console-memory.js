/* 记忆页：lib（记忆库）、triage（待整理）、convs（对话存档）。样式在 console-memory.css，类名都带 mem- 前缀。 */
(function () {
  'use strict';
  const { esc, dev, tool, zh, date } = Console;
  const $ = (id) => document.getElementById(id);
  const TYPES = Object.keys(zh.type);

  // ---------------- 公共小件 ----------------
  const dayOf = (iso) => date.localDay(Date.parse(iso));
  const shortDay = (iso) => { const d = dayOf(iso); return d.slice(0, 4) === date.today().slice(0, 4) ? d.slice(5) : d; };
  const ago = (iso) => { const d = Math.floor((Date.now() - Date.parse(iso)) / 86400e3); return d < 1 ? '今天' : `${d} 天前`; };
  const srcText = (e) => { const [a, c] = e.source ? e.source.split('/') : [e.author, e.client]; return `${dev(a)} · ${tool(c)}`; };
  const stPill = (s) => (s === 'active' ? '' : `<span class="pill ${s === 'proposed' ? 'warn' : s === 'retired' ? 'bad' : 'dim'}">${esc(zh.state[s] || s)}</span>`);
  const typePill = (t) => `<span class="pill">${esc(zh.type[t] || t)}</span>`;
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function hl(text, words) {
    const ws = (words || []).filter(Boolean).map(escRe);
    if (!ws.length) return esc(text);
    return String(text).split(new RegExp(`(${ws.join('|')})`, 'gi')).map((p, i) => (i % 2 ? `<mark>${esc(p)}</mark>` : esc(p))).join('');
  }

  // 确认框：返回 Promise，取消得到 null；有 input 时确定后得到输入的文字，否则得到 true
  function ask({ title, text, input, okText = '确定', danger }) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'mem-modal';
      wrap.innerHTML = `<div class="mem-dlg" role="dialog" aria-modal="true"><h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}`
        + `${input ? `<label class="mem-fld"><span>${esc(input.label)}</span><input class="inp" value="${esc(input.value || '')}" maxlength="200"></label>` : ''}`
        + `<div class="mem-dact"><button class="btn" data-x>取消</button><button class="btn ${danger ? 'warn' : ''}" data-ok>${esc(okText)}</button></div></div>`;
      document.body.appendChild(wrap);
      const inp = wrap.querySelector('input'); const ok = wrap.querySelector('[data-ok]');
      const done = (v) => { document.removeEventListener('keydown', key, true); wrap.remove(); resolve(v); };
      const sync = () => { if (inp) ok.disabled = !inp.value.trim(); };
      const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } else if (e.key === 'Enter' && !ok.disabled) { e.preventDefault(); done(inp ? inp.value.trim() : true); } };
      document.addEventListener('keydown', key, true);
      wrap.onclick = (e) => { if (e.target === wrap) done(null); };
      wrap.querySelector('[data-x]').onclick = () => done(null);
      ok.onclick = () => done(inp ? inp.value.trim() : true);
      if (inp) { inp.oninput = sync; sync(); inp.focus(); inp.select(); } else ok.focus();
    });
  }

  async function manage(body) {
    try { const r = await Console.api('/browse/manage-action', { body }); refreshBadge(); return r; } catch (e) { Console.toast(`失败：${e.message}`, 'err'); return null; }
  }
  async function refreshBadge() {
    try { const c = await Console.api('/browse/manage-counts'); Console.badge('triage', c.total); return c; } catch { return null; }
  }
  Console.ready.then(() => { refreshBadge(); setInterval(() => { if (!document.hidden) refreshBadge(); }, 60000); });

  // ======================================================================
  // 记忆库
  // ======================================================================
  (function lib() {
    const ROW = 60;
    let root = null; let ALL = []; let BYID = new Map(); let loading = null; let loaded = false;
    const st = { q: '', mode: 'kw', type: '', proj: '', src: '', origin: '', state: 'active' };
    let view = []; let sel = new Set(); let curId = ''; let editing = false;
    let semOn = false; let semRes = null; let semBusy = false; let semTimer = 0; let semSeq = 0;
    const texts = new Map();

    const rowOfEntry = (e) => ({ kind: 'memory', id: e.id, title: e.title, type: e.type, state: e.state, project: e.project, src: srcText(e), date: e.updated, pick: e.state === 'active' || e.state === 'proposed' });
    const matchFilters = (e) => (!st.state || e.state === st.state) && (!st.src || `${e.author}/${e.client}` === st.src) && (!st.origin || e.origin === st.origin)
      && (!st.type || e.type === st.type) && (!st.proj || (e.project || '（无）') === st.proj);

    function count(list, key) { const m = new Map(); for (const e of list) { const k = key(e) || '（无）'; m.set(k, (m.get(k) || 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1]); }
    function fillSelect(id, pairs, label, all) {
      const s = $(id); const cur = s.value;
      s.innerHTML = `<option value="">${all}</option>${pairs.map(([k, n]) => `<option value="${esc(k)}">${esc(label ? label(k) : k)}（${n}）</option>`).join('')}`;
      s.value = [...s.options].some((o) => o.value === cur) ? cur : '';
    }
    function fillFilters() {
      const act = ALL.filter((e) => e.state === 'active');
      fillSelect('mem-lib-type', count(act, (e) => e.type), (k) => zh.type[k] || k, '全部类型');
      fillSelect('mem-lib-proj', count(act, (e) => e.project), null, '全部项目');
      fillSelect('mem-lib-src', count(act, (e) => `${e.author}/${e.client}`), (k) => { const [a, c] = k.split('/'); return `${dev(a)} · ${tool(c)}`; }, '全部来源');
      fillSelect('mem-lib-origin', count(act, (e) => e.origin), (k) => zh.origin[k] || k, '全部方式');
      st.type = $('mem-lib-type').value; st.proj = $('mem-lib-proj').value; st.src = $('mem-lib-src').value; st.origin = $('mem-lib-origin').value;
    }

    async function loadAll(force) {
      if (loaded && !force) return;
      if (loading) return loading;
      loading = Console.api('/browse/data').then((d) => {
        ALL = d.entries.map((e) => ({ ...e, hay: `${e.title}\n${e.subject}\n${e.project}\n${(e.tags || []).join(' ')}\n${e.snippet}`.toLowerCase() }));
        BYID = new Map(ALL.map((e) => [e.id, e]));
        loaded = true; fillFilters();
      }).finally(() => { loading = null; });
      return loading;
    }

    // ---- 列表（虚拟滚动：只画看得见的几十行）----
    function buildView() {
      if (st.mode === 'sem') {
        view = (semRes || []).filter((r) => { const e = r.kind === 'memory' ? BYID.get(r.id) : null; return !e || matchFilters(e); }).map((r) => {
          if (r.kind === 'journal') return { kind: 'journal', ref: r.ref, title: r.title, project: r.project, src: r.source ? `${dev(r.source.split('/')[0])} · ${tool(r.source.split('/')[1])}` : '', date: r.date, score: r.score, tag: '对话日志' };
          const e = BYID.get(r.id);
          return e ? { ...rowOfEntry(e), score: r.score } : { kind: 'memory', id: r.id, title: r.title, type: r.type, state: 'active', project: r.project, src: r.source, date: r.date, score: r.score };
        });
      } else {
        const ws = st.q.toLowerCase().split(/\s+/).filter(Boolean);
        view = ALL.filter((e) => matchFilters(e) && (!ws.length || ws.every((w) => e.hay.includes(w)))).map(rowOfEntry);
      }
    }
    function rowHtml(r, i) {
      const key = r.kind === 'journal' ? `j:${r.ref}` : r.id;
      const meta = r.kind === 'journal'
        ? `<span class="pill dim">对话日志</span>${esc([r.project, r.src, r.date].filter(Boolean).join(' · '))}`
        : `${typePill(r.type)}${stPill(r.state)}${esc([r.project, r.src, r.date ? shortDay(r.date) : ''].filter(Boolean).join(' · '))}${r.score ? ` <i>相似 ${Math.round(r.score * 100)}%</i>` : ''}`;
      return `<div class="mem-row ${r.kind === 'memory' && r.id === curId ? 'on' : ''}" style="top:${i * ROW}px" data-key="${esc(key)}" data-i="${i}">`
        + `${st.mode === 'kw' && r.pick ? `<label class="mem-ck"><input type="checkbox" data-ck="${esc(r.id)}" ${sel.has(r.id) ? 'checked' : ''}></label>` : '<span class="mem-ck"></span>'}`
        + `<div class="mem-rt"><div class="mem-title">${esc(r.title)}</div><div class="mem-meta">${meta}</div></div></div>`;
    }
    function paint() {
      const sc = $('mem-lib-scroll'); const sp = $('mem-lib-space');
      if (!sc || !sc.clientHeight) return;
      const first = Math.max(0, Math.floor(sc.scrollTop / ROW) - 6);
      const last = Math.min(view.length, first + Math.ceil(sc.clientHeight / ROW) + 12);
      let h = '';
      for (let i = first; i < last; i++) h += rowHtml(view[i], i);
      sp.innerHTML = h;
    }
    function refresh(resetScroll) {
      buildView();
      const sc = $('mem-lib-scroll');
      $('mem-lib-space').style.height = `${view.length * ROW}px`;
      if (resetScroll) sc.scrollTop = 0;
      const empty = $('mem-lib-empty');
      if (semBusy) { empty.hidden = false; empty.textContent = '搜索中…'; }
      else if (!view.length) { empty.hidden = false; empty.textContent = st.mode === 'sem' && !st.q.trim() ? '输入一句话，按意思找相近的记忆' : '没有符合的'; }
      else empty.hidden = true;
      $('mem-lib-count').textContent = view.length ? `${view.length} 条` : '';
      const picks = view.filter((r) => r.pick);
      const all = $('mem-lib-all');
      all.disabled = st.mode !== 'kw' || !picks.length;
      all.checked = picks.length > 0 && picks.every((r) => sel.has(r.id));
      syncBulk();
      paint();
    }
    function syncBulk() { const b = $('mem-lib-bulk'); b.hidden = !sel.size; b.textContent = `作废选中的（${sel.size}）`; }
    function scrollToCur() {
      const i = view.findIndex((r) => r.kind === 'memory' && r.id === curId);
      const sc = $('mem-lib-scroll');
      if (i < 0 || !sc.clientHeight) return;
      if (i * ROW < sc.scrollTop || (i + 1) * ROW > sc.scrollTop + sc.clientHeight) sc.scrollTop = Math.max(0, i * ROW - sc.clientHeight / 3);
    }

    // ---- 按意思搜 ----
    async function runSemantic() {
      const q = st.q.trim(); const seq = ++semSeq;
      if (!q) { semRes = []; semBusy = false; refresh(true); return; }
      semBusy = true; refresh(true);
      try { const r = await Console.api('/browse/semantic', { query: { q } }); if (seq !== semSeq) return; semRes = r.results || []; }
      catch (e) { if (seq !== semSeq) return; semRes = []; Console.toast(`搜索失败：${e.message}`, 'err'); }
      semBusy = false; refresh(true);
    }
    function setMode(m) {
      st.mode = m;
      root.querySelectorAll('.mem-seg button').forEach((b) => b.classList.toggle('on', b.dataset.m === m));
      $('mem-lib-q').placeholder = m === 'sem' ? '用一句话描述要找的内容' : '搜标题和正文，空格分隔多个词';
      if (m === 'sem') runSemantic(); else { semSeq++; semBusy = false; refresh(true); }
    }

    // ---- 详情 ----
    async function loadText(id) {
      if (texts.has(id)) return texts.get(id);
      const t = await Console.api(`/browse/entry/${encodeURIComponent(id)}`);
      const i = String(t).indexOf('\n---\n');
      const out = { head: i < 0 ? '' : t.slice(0, i), body: i < 0 ? String(t) : t.slice(i + 5).trim() };
      texts.set(id, out); return out;
    }
    async function renderDetail() {
      const box = $('mem-lib-detail'); const id = curId;
      root.querySelector('.mem-split').dataset.open = id ? '1' : '';
      if (!id) { box.innerHTML = '<div class="empty">选一条看全文</div>'; return; }
      const e = BYID.get(id);
      editing = false;
      box.innerHTML = `<button class="btn mem-back" data-act="back">← 列表</button>${e ? headHtml(e) : '<div class="empty">读取中…</div>'}<pre class="mem-body">读取中…</pre>`;
      let t;
      try { t = await loadText(id); } catch (err) { if (id === curId) box.querySelector('.mem-body').textContent = err.status === 404 ? '没有这条记忆' : `读取失败：${err.message}`; return; }
      if (id !== curId) return;
      const pre = box.querySelector('.mem-body');
      const src = provOf(t.body);
      if (pre) pre.textContent = src ? src.text : t.body;
      if (pre && src) pre.insertAdjacentHTML('afterend', `<a class="mem-src" href="#/convs/${src.ref}?date=${src.date}">出处：对话 ${src.ref} · ${src.date}</a>`);
      histMount(box, id);
    }

    // ---- 出处和修改历史（接口在 admin-tools.mjs）----
    // 从对话存成的记忆，正文最后一行固定是「出处：对话 <8 位 ref> · <日期>」：详情里把它渲染成可点的链接，正文里不重复显示
    const SRC = /\n*出处：对话 ([0-9a-f]{8}) · (\d{4}-\d{2}-\d{2})\s*$/;
    function provOf(body) { const m = SRC.exec(body || ''); return m ? { ref: m[1], date: m[2], text: body.slice(0, m.index).trimEnd() } : null; }
    let histFor = ''; let H = null;
    const verWho = (v) => (v.client === 'console' || v.client === 'browser' ? `${dev(v.device)} · 控制台` : v.device === 'review' ? `审批 · ${dev(String(v.client).replace(/^browser:/, ''))}` : v.client ? `${dev(v.device)} · ${tool(v.client)}` : dev(v.device));
    function diffHtml(diff, truncated) {
      return String(diff || '').split('\n').map((l) => `<span class="${l.startsWith('@@') ? 'h' : l.startsWith('+') ? 'a' : l.startsWith('-') ? 'd' : 'c'}">${esc(l) || ' '}</span>`).join('') + (truncated ? '<span class="h">…差异太长，后面省略</span>' : '');
    }
    function histMount(box, id) {
      box.insertAdjacentHTML('beforeend', '<section class="mem-hist" id="mem-hist"></section>');
      histPaint();
      if (histFor === id) histLoad(id);
    }
    function histPaint() {
      const box = $('mem-hist'); if (!box) return;
      if (histFor !== curId) { box.innerHTML = '<button class="btn" data-act="hist">历史</button>'; return; }
      if (!H || H.id !== curId) { box.innerHTML = '<div class="mem-hh"><b>历史</b></div><div class="empty">读取中…</div>'; return; }
      box.innerHTML = `<div class="mem-hh"><b>历史</b><span class="hint">${H.total} 版${H.more ? `，列出最近 ${H.versions.length} 版` : ''}</span><button class="btn" data-act="hist">收起</button></div>`
        + H.versions.map((v) => {
          const off = v.current || !H.restorable;
          return `<div class="mem-ver ${v.current ? 'cur' : ''}"><span class="v-n">v${v.n}</span><span class="v-t">${esc(shortDay(v.time))} ${esc(date.hm(v.time))}</span><span class="v-by">${esc(verWho(v))}</span>`
            + `<span class="pill ${v.current ? 'ok' : 'dim'}">${v.current ? '当前 · ' : ''}${esc(v.action)}</span>`
            + `<span class="v-act" ${off ? `title="${esc(v.current ? '已经是当前版本' : H.reason)}"` : ''}><button class="btn" data-act="vdiff" data-sha="${v.sha}">差异</button>`
            + `<button class="btn" data-act="vrestore" data-sha="${v.sha}" ${off ? 'disabled' : ''}>恢复</button></span></div><pre class="mem-diff" hidden data-for="${v.sha}"></pre>`;
        }).join('');
    }
    async function histLoad(id) {
      try {
        const h = await Console.api(`/console/api/memory/${encodeURIComponent(id)}/history`);
        if (id !== curId || histFor !== id) return;
        H = h;
      } catch (e) {
        const box = $('mem-hist');
        if (id === curId && box) box.innerHTML = `<div class="mem-hh"><b>历史</b></div><div class="empty">读取失败：${esc(e.message)}</div>`;
        return;
      }
      histPaint();
    }
    async function histAct(a, btn) {
      const id = curId;
      if (a === 'hist') { histFor = histFor === id ? '' : id; H = null; histPaint(); if (histFor) await histLoad(id); return; }
      const sha = btn.dataset.sha;
      if (a === 'vdiff') {
        const pre = $('mem-hist').querySelector(`pre[data-for="${sha}"]`);
        if (!pre.hidden) { pre.hidden = true; return; }
        pre.hidden = false;
        if (pre.dataset.done) return;
        pre.textContent = '读取中…';
        try { const r = await Console.api(`/console/api/memory/${encodeURIComponent(id)}/history/${sha}`); pre.innerHTML = diffHtml(r.diff, r.truncated); pre.dataset.done = '1'; } catch (e) { pre.textContent = `读取失败：${e.message}`; }
        return;
      }
      const v = H.versions.find((x) => x.sha === sha);
      const ok = await ask({ title: `恢复到 ${shortDay(v.time)} ${date.hm(v.time)} 的版本`, text: '会新增一个版本，现在的内容仍留在历史里，可以再恢复回来。', okText: '恢复' });
      if (!ok) return;
      try { await Console.api(`/console/api/memory/${encodeURIComponent(id)}/restore`, { body: { sha } }); } catch (e) { Console.toast(`恢复失败：${e.message}`, 'err'); return; }
      Console.toast('已恢复，产生了一个新版本', 'ok');
      texts.delete(id); H = null;
      try { await loadAll(true); } catch { /* 列表读不到也先把详情刷新 */ }
      refresh(); renderDetail();
    }
    function headHtml(e) {
      const native = e.origin === 'native';
      const rows = [['来源', srcText(e)], ['方式', zh.origin[e.origin] || e.origin], ['项目', e.project], ['主题', e.subject], ['更新', `${dayOf(e.updated)}（${ago(e.updated)}）`], ['编号', e.id]].filter((r) => r[1]);
      const acts = [];
      if (e.state === 'proposed') acts.push('<button class="btn" data-act="approve">保留</button><button class="btn warn" data-act="reject">不要</button>');
      if ((e.state === 'active' || e.state === 'proposed') && !native) acts.push('<button class="btn" data-act="edit">编辑</button>');
      if (e.state === 'active') acts.push('<button class="btn warn" data-act="retire">作废</button>');
      return `<h3 class="mem-dtitle">${esc(e.title)}</h3><div class="mem-pills">${typePill(e.type)}${stPill(e.state)}</div>`
        + `<dl class="mem-dl">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`
        + (acts.length || (native && e.state === 'active') ? `<div class="mem-acts">${acts.join('')}${native && e.state === 'active' ? '<span class="hint">工具自己记的，只能作废；要改请改那台机器上的源文件</span>' : ''}</div>` : '');
    }
    async function startEdit() {
      const id = curId; const e = BYID.get(id); const box = $('mem-lib-detail');
      let t; try { t = await loadText(id); } catch (err) { Console.toast(`读不到全文，先别改：${err.message}`, 'err'); return; }
      if (!t.body) { Console.toast('读不到全文，先别改', 'err'); return; }
      const pre = box.querySelector('.mem-body');
      if (!pre || e.id !== curId) return;
      editing = true;
      pre.outerHTML = `<div class="mem-edit"><input class="inp" id="mem-lib-e-title" value="${esc(e.title)}" maxlength="200" aria-label="标题"><input class="inp" id="mem-lib-e-proj" value="${esc(e.project)}" placeholder="项目（英文短名）" aria-label="项目">`
        + `<textarea class="inp" id="mem-lib-e-body" rows="14" aria-label="正文"></textarea><div class="mem-acts"><button class="btn" data-act="save">保存</button><button class="btn" data-act="cancel">取消</button></div></div>`;
      $('mem-lib-e-body').value = t.body; $('mem-lib-e-title').focus();
    }
    async function onAct(a, btn) {
      const id = curId; const e = BYID.get(id);
      if (a === 'back') { Console.go('lib'); return; }
      if (a === 'hist' || a === 'vdiff' || a === 'vrestore') return histAct(a, btn);
      if (!e) return;
      if (a === 'edit') return startEdit();
      if (a === 'cancel') return renderDetail();
      if (a === 'save') {
        const title = $('mem-lib-e-title').value.trim(); const body = $('mem-lib-e-body').value;
        if (!title) { Console.toast('标题不能为空', 'err'); return; }
        const r = await manage({ action: 'edit', id, title, project: $('mem-lib-e-proj').value.trim(), body });
        if (!r) return;
        texts.delete(id); Object.assign(e, { title, project: $('mem-lib-e-proj').value.trim(), snippet: body.slice(0, 400), updated: new Date().toISOString() });
        e.hay = `${e.title}\n${e.subject}\n${e.project}\n${(e.tags || []).join(' ')}\n${e.snippet}`.toLowerCase();
        Console.toast('已保存', 'ok'); fillFilters(); refresh(); renderDetail(); return;
      }
      if (a === 'approve' || a === 'reject') {
        const r = await manage({ action: a, ids: [id] });
        if (r) { e.state = a === 'approve' ? 'active' : 'retired'; Console.toast(a === 'approve' ? '已保留' : '已放弃这条候选', 'ok'); refresh(); renderDetail(); }
        return;
      }
      if (a === 'retire') {
        const reason = await ask({ title: `作废「${e.title}」`, text: `不会真删：条目变为「已作废」，在状态筛选里选「已作废」可以找回。${e.origin === 'native' ? '这是工具自己记的，源文件改了会重新出现。' : ''}`, input: { label: '原因', value: '过时/重复' }, okText: '作废', danger: true });
        if (!reason) return;
        const r = await manage({ action: 'retire', ids: [id], reason });
        if (r) { e.state = 'retired'; sel.delete(id); Console.toast('已作废', 'ok'); refresh(); renderDetail(); }
      }
    }
    async function bulkRetire() {
      const ids = [...sel]; if (!ids.length) return;
      const reason = await ask({ title: `作废选中的 ${ids.length} 条`, text: '不会真删：这些条目变为「已作废」，在状态筛选里选「已作废」可以找回。', input: { label: '原因', value: '过时/重复' }, okText: `作废 ${ids.length} 条`, danger: true });
      if (!reason) return;
      const r = await manage({ action: 'retire', ids, reason });
      if (!r) return;
      for (const id of ids) { const e = BYID.get(id); if (e && e.state !== 'retired') e.state = 'retired'; }
      sel.clear(); Console.toast(`已作废 ${r.n ?? ids.length} 条`, 'ok'); refresh(); if (curId) renderDetail();
    }

    // ---- 页面 ----
    Console.page('lib', {
      mount(el) {
        root = el;
        const sel5 = (id, label) => `<select class="inp" id="${id}" aria-label="${label}"><option value="">${label}</option></select>`;
        el.innerHTML = `<section class="panel mem-bar"><div class="mem-search"><input class="inp" id="mem-lib-q" type="search" autocomplete="off" aria-label="搜索">`
          + `<div class="mem-seg"><button data-m="kw" class="on">关键词</button><button data-m="sem" id="mem-lib-sem">按意思</button></div><span class="hint" id="mem-lib-semnote" hidden></span></div>`
          + `<div class="mem-filters">${sel5('mem-lib-type', '全部类型')}${sel5('mem-lib-proj', '全部项目')}${sel5('mem-lib-src', '全部来源')}${sel5('mem-lib-origin', '全部方式')}`
          + `<select class="inp" id="mem-lib-state" aria-label="状态"><option value="active">有效的</option><option value="proposed">待审候选</option><option value="superseded">已被取代</option><option value="retired">已作废</option><option value="">全部状态</option></select></div></section>`
          + `<div class="mem-split"><section class="panel mem-listp"><div class="mem-lh"><label class="mem-all"><input type="checkbox" id="mem-lib-all" aria-label="全选"><span id="mem-lib-count"></span></label><button class="btn warn" id="mem-lib-bulk" hidden></button></div>`
          + `<div class="mem-vscroll scroll" id="mem-lib-scroll"><div class="empty" id="mem-lib-empty">读取中…</div><div class="mem-vspace" id="mem-lib-space"></div></div></section>`
          + `<section class="panel mem-detail scroll" id="mem-lib-detail"></section></div>`;
        $('mem-lib-q').addEventListener('input', (e) => {
          st.q = e.target.value;
          if (st.mode === 'sem') { clearTimeout(semTimer); semTimer = setTimeout(runSemantic, 450); } else refresh(true);
        });
        $('mem-lib-q').addEventListener('keydown', (e) => { if (e.key === 'Enter' && st.mode === 'sem') { clearTimeout(semTimer); runSemantic(); } });
        el.querySelectorAll('.mem-seg button').forEach((b) => { b.onclick = () => { if (!b.disabled && st.mode !== b.dataset.m) setMode(b.dataset.m); }; });
        for (const [id, k] of [['mem-lib-type', 'type'], ['mem-lib-proj', 'proj'], ['mem-lib-src', 'src'], ['mem-lib-origin', 'origin'], ['mem-lib-state', 'state']]) {
          $(id).onchange = (e) => { st[k] = e.target.value; refresh(true); };
        }
        const sc = $('mem-lib-scroll'); let raf = 0;
        sc.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; paint(); }); });
        sc.addEventListener('click', (ev) => {
          const ck = ev.target.closest('[data-ck]');
          if (ck) { if (ck.checked) sel.add(ck.dataset.ck); else sel.delete(ck.dataset.ck); syncBulk(); const picks = view.filter((r) => r.pick); $('mem-lib-all').checked = picks.length > 0 && picks.every((r) => sel.has(r.id)); return; }
          if (ev.target.closest('.mem-ck')) return;
          const row = ev.target.closest('.mem-row'); if (!row) return;
          const r = view[Number(row.dataset.i)];
          if (r.kind === 'journal') Console.go(`convs/${r.ref}`); else Console.go(`lib/${r.id}`);
        });
        $('mem-lib-all').onchange = (e) => {
          const picks = view.filter((r) => r.pick);
          if (e.target.checked) picks.forEach((r) => sel.add(r.id)); else picks.forEach((r) => sel.delete(r.id));
          syncBulk(); paint();
        };
        $('mem-lib-bulk').onclick = bulkRetire;
        $('mem-lib-detail').addEventListener('click', async (ev) => { const b = ev.target.closest('[data-act]'); if (!b || b.disabled) return; b.disabled = true; try { await onAct(b.dataset.act, b); } finally { b.disabled = false; } });
        window.addEventListener('am-lib-stale', () => { loaded = false; }); // 别处新写了记忆（对话存成记忆、合并）：下次进来重新读
        window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && Console.visible('lib') && curId && !document.querySelector('.mem-modal') && !editing) Console.go('lib'); });
        Console.api('/browse/semantic').then((r) => {
          semOn = Boolean(r.status?.enabled);
          const b = $('mem-lib-sem');
          if (!semOn) { b.disabled = true; $('mem-lib-semnote').hidden = false; $('mem-lib-semnote').textContent = '向量服务没开（config 里没有 embed_url）'; b.title = '向量服务没开'; }
        }).catch(() => {});
      },
      async show(params) {
        try { await loadAll(); } catch (e) { $('mem-lib-empty').hidden = false; $('mem-lib-empty').textContent = `读取失败：${e.message}`; return; }
        const q = params.query.q;
        if (q !== undefined && q !== st.q) { st.q = q; $('mem-lib-q').value = q; }
        curId = params.arg || '';
        const e = BYID.get(curId);
        if (e && st.state && e.state !== st.state) { st.state = ''; $('mem-lib-state').value = ''; }
        const keep = $('mem-lib-scroll').scrollTop;
        refresh(false);
        if (curId) scrollToCur(); else $('mem-lib-scroll').scrollTop = keep;
        paint();
        renderDetail();
      },
      resize() { paint(); },
    });
  })();

  // ======================================================================
  // 待整理
  // ======================================================================
  (function triage() {
    const TABS = [['proposed', '待审候选'], ['dup', '疑似重复'], ['stale', '过期现状']];
    const PAGE = 40;
    let root = null; let D = null; let loadedAt = 0; let counts = null; let tab = null; let loading = null;
    const shown = { proposed: PAGE, dup: PAGE, stale: PAGE };
    const byId = () => new Map(D.entries.map((e) => [e.id, e]));
    const numOf = (t) => (D ? (t === 'proposed' ? D.proposed.length : t === 'dup' ? D.duplicates.length : D.stale.length) : counts ? counts[t === 'dup' ? 'duplicates' : t] : null);

    async function load(force) {
      if (loading) return loading;
      if (D && !force && Date.now() - loadedAt < 60e3) return;
      loading = Console.api('/browse/manage-data').then((d) => { D = d; loadedAt = Date.now(); Console.badge('triage', d.proposed.length + d.duplicates.length + d.stale.length); }).finally(() => { loading = null; });
      return loading;
    }
    function drop(ids) {
      const s = new Set(ids);
      D.entries = D.entries.filter((e) => !s.has(e.id));
      D.proposed = D.proposed.filter((id) => !s.has(id)); D.stale = D.stale.filter((id) => !s.has(id));
      D.duplicates = D.duplicates.map((g) => g.filter((id) => !s.has(id))).filter((g) => g.length > 1);
    }
    async function after(ids) {
      if (ids) drop(ids);
      render();
      const c = await refreshBadge(); if (c) counts = c;
    }

    const card = (e, acts, extra = '') => `<div class="mem-card" data-id="${esc(e.id)}"><div class="mem-ct"><span class="mem-title">${esc(e.title)}</span></div>`
      + `<div class="mem-meta">${typePill(e.type)}${esc([e.project, srcText(e), `更新 ${ago(e.updated)}`].filter(Boolean).join(' · '))}</div>`
      + `<div class="mem-snip" data-x>${esc(e.body)}</div>${extra}<div class="mem-acts">${acts}<a class="mem-open" href="#/lib/${esc(e.id)}">打开</a></div></div>`;

    function render() {
      const tabs = root.querySelector('.mem-tabs');
      tabs.innerHTML = TABS.map(([k, n]) => { const c = numOf(k); return `<button data-tab="${k}" class="${tab === k ? 'on' : ''}">${n}${c ? `<b>${c}</b>` : ''}</button>`; }).join('');
      const body = $('mem-tri-body');
      if (!D) { body.innerHTML = '<div class="empty">读取中…</div>'; return; }
      const m = byId();
      if (tab === 'proposed') {
        const list = D.proposed.map((id) => m.get(id)).filter(Boolean);
        body.innerHTML = list.length ? list.slice(0, shown.proposed).map((e) => card(e, '<button class="btn" data-a="approve">保留</button><button class="btn warn" data-a="reject">不要</button>')).join('') + more(list.length, 'proposed') : '<div class="empty">没有待审候选</div>';
      } else if (tab === 'stale') {
        const list = D.stale.map((id) => m.get(id)).filter(Boolean);
        body.innerHTML = list.length ? list.slice(0, shown.stale).map((e) => card(e, `${e.origin === 'native' ? '' : '<button class="btn" data-a="valid">仍有效</button>'}<button class="btn warn" data-a="retire">作废</button>`)).join('') + more(list.length, 'stale') : '<div class="empty">没有过期的现状</div>';
      } else {
        const groups = D.duplicates.map((g) => g.map((id) => m.get(id)).filter(Boolean)).filter((g) => g.length > 1);
        body.innerHTML = groups.length ? groups.slice(0, shown.dup).map((g, gi) => `<div class="mem-card mem-grp" data-g="${gi}">${g.map((e, k) => `<label class="mem-gr"><input type="radio" name="mem-g${gi}" value="${esc(e.id)}" ${k === 0 ? 'checked' : ''}>`
          + `<div><div class="mem-title">${esc(e.title)}</div><div class="mem-meta">${typePill(e.type)}${esc([e.project, srcText(e), ago(e.updated)].filter(Boolean).join(' · '))}</div><div class="mem-snip" data-x>${esc(e.body)}</div></div></label>`).join('')}`
          + `<div class="mem-acts"><button class="btn" data-a="merge">合并，保留选中的</button></div></div>`).join('') + more(groups.length, 'dup') : '<div class="empty">没有疑似重复的</div>';
      }
    }
    const more = (n, k) => (n > shown[k] ? `<div class="mem-more"><button class="btn" data-more="${k}">再显示 ${Math.min(PAGE, n - shown[k])} 条（还有 ${n - shown[k]}）</button></div>` : '');

    async function onClick(ev) {
      const t = ev.target.closest('[data-tab]');
      if (t) { Console.go(`triage/${t.dataset.tab}`); return; }
      const mb = ev.target.closest('[data-more]');
      if (mb) { shown[mb.dataset.more] += PAGE; render(); return; }
      const sn = ev.target.closest('[data-x]');
      if (sn && !ev.target.closest('button,a,input')) { sn.classList.toggle('open'); return; }
      const b = ev.target.closest('[data-a]'); if (!b) return;
      const a = b.dataset.a; const card = b.closest('.mem-card');
      if (a === 'merge') {
        const gi = Number(card.dataset.g);
        const m = byId();
        const g = D.duplicates.map((x) => x.map((id) => m.get(id)).filter(Boolean)).filter((x) => x.length > 1)[gi];
        const keep = card.querySelector('input[type=radio]:checked').value;
        const others = g.map((e) => e.id).filter((id) => id !== keep);
        const ok = await ask({ title: `合并 ${g.length} 条`, text: `保留「${m.get(keep).title}」，其余 ${others.length} 条标为「已被取代」并指向它。不会真删，在记忆库的状态筛选里选「已被取代」可以找回。`, okText: '合并', danger: true });
        if (!ok) return;
        b.disabled = true;
        const r = await manage({ action: 'merge', ids: [keep, ...others] });
        if (r) { Console.toast(`已合并，${r.n ?? others.length} 条被取代`, 'ok'); await after(others); } else b.disabled = false;
        return;
      }
      const id = card.dataset.id; const e = byId().get(id);
      if (a === 'approve' || a === 'reject') {
        b.disabled = true;
        const r = await manage({ action: a, ids: [id] });
        if (r) { Console.toast(a === 'approve' ? '已保留' : '已放弃这条候选', 'ok'); await after([id]); } else b.disabled = false;
      } else if (a === 'valid') {
        b.disabled = true;
        const r = await manage({ action: 'edit', id, title: e.title });
        if (r) { Console.toast('已确认仍有效', 'ok'); D.stale = D.stale.filter((x) => x !== id); await after(); } else b.disabled = false;
      } else if (a === 'retire') {
        const reason = await ask({ title: `作废「${e.title}」`, text: `不会真删：条目变为「已作废」，在记忆库的状态筛选里选「已作废」可以找回。${e.origin === 'native' ? '这是工具自己记的，源文件改了会重新出现。' : ''}`, input: { label: '原因', value: '过时' }, okText: '作废', danger: true });
        if (!reason) return;
        const r = await manage({ action: 'retire', ids: [id], reason });
        if (r) { Console.toast('已作废', 'ok'); await after([id]); }
      }
    }

    Console.page('triage', {
      mount(el) {
        root = el;
        el.innerHTML = '<section class="panel"><div class="mem-tabs"></div><div id="mem-tri-body"></div></section>';
        el.addEventListener('click', onClick);
      },
      async show(params) {
        const want = TABS.some(([k]) => k === params.arg) ? params.arg : null;
        if (want) tab = want;
        if (!counts) { try { counts = await Console.api('/browse/manage-counts'); Console.badge('triage', counts.total); } catch { /* 数字读不到不影响页面 */ } }
        if (!tab) tab = TABS.find(([k]) => numOf(k) > 0)?.[0] || 'proposed';
        render();
        try { await load(); } catch (e) { $('mem-tri-body').innerHTML = `<div class="empty">读取失败：${esc(e.message)}</div>`; return; }
        if (!want && !params.arg) { /* 保持当前标签 */ }
        render();
      },
    });
  })();

  // ======================================================================
  // 对话存档
  // ======================================================================
  (function convs() {
    let root = null; let words = []; let hits = null; let total = 0; let searching = false; let seq = 0;
    let R = null; // 正在读的会话：{ ref, session, date, messages, next, hit, loading }
    const F = { q: '', device: '', tool: '', from: '', to: '' };

    async function fillOptions() {
      try {
        const a = await Console.api('/browse/viz-agents', { ttl: 60000 });
        const devs = a.devices.filter((d) => Object.keys(d.cells || {}).some((k) => k !== 'cli')).map((d) => d.name).sort((x, y) => dev(x).localeCompare(dev(y)));
        const tools = Console.toolOrder.filter((t) => a.devices.some((d) => d.cells?.[t]));
        $('mem-cv-device').innerHTML = `<option value="">全部设备</option>${devs.map((d) => `<option value="${esc(d)}">${esc(dev(d))}</option>`).join('')}`;
        $('mem-cv-tool').innerHTML = `<option value="">全部智能体</option>${tools.map((t) => `<option value="${esc(t)}">${esc(tool(t))}</option>`).join('')}`;
        $('mem-cv-device').value = F.device; $('mem-cv-tool').value = F.tool;
      } catch { /* 筛选项读不到就只剩关键词 */ }
    }

    async function search() {
      F.q = $('mem-cv-q').value.trim(); F.device = $('mem-cv-device').value; F.tool = $('mem-cv-tool').value; F.from = $('mem-cv-from').value; F.to = $('mem-cv-to').value;
      if (!F.q) { hits = null; renderList(); return; }
      const my = ++seq; searching = true; renderList();
      try {
        const r = await Console.api('/console/api/conv/search', { query: { q: F.q, device: F.device, tool: F.tool, from: F.from, to: F.to, limit: 30 } });
        if (my !== seq) return;
        hits = r.hits; words = r.words || []; total = r.total;
      } catch (e) { if (my !== seq) return; hits = []; total = 0; Console.toast(`搜索失败：${e.message}`, 'err'); }
      searching = false; renderList();
    }
    function renderList() {
      const box = $('mem-cv-list');
      if (searching) { box.innerHTML = '<div class="empty">搜索中…</div>'; return; }
      if (hits === null) { box.innerHTML = '<div class="empty">输入关键词，搜所有设备上的对话原文</div>'; return; }
      if (!hits.length) { box.innerHTML = '<div class="empty">没搜到</div>'; return; }
      box.innerHTML = `<div class="mem-sum">${total} 个会话命中${total > hits.length ? `，列出最近 ${hits.length} 个` : ''}</div>`
        + hits.map((h) => `<div class="mem-hit ${R && R.ref === h.ref ? 'on' : ''}" data-ref="${esc(h.ref)}"><div class="mem-title">${esc(h.title || '（无标题）')}</div>`
          + `<div class="mem-meta">${esc(dev(h.device))} · ${esc(h.tool_label || tool(h.tool))} · ${esc(shortDay(h.last))}</div>`
          + h.found.map((f) => `<div class="mem-sn" data-day="${esc(f.day)}" data-at="${f.index}"><i>${esc(f.day.slice(5))} ${esc(f.time)} ${f.role === 'user' ? '用户' : '助手'}</i>${hl(f.snippet, words)}</div>`).join('') + '</div>').join('');
    }

    // ---- 读原文 ----
    function msgHtml(m, showDay) {
      return `<div class="mem-msg ${m.role === 'user' ? 'u' : 'a'} ${R.hit === m.index ? 'hit' : ''}" data-i="${m.index}" data-day="${esc(m.day)}"><div class="mem-mh"><b>${m.role === 'user' ? '用户' : '助手'}</b><span>${showDay ? `${esc(m.day.slice(5))} ` : ''}${esc(m.time)}</span></div>`
        + `<div class="mem-mt">${hl(m.text, words)}</div>${m.truncated ? '<button class="btn" data-full>展开全文</button>' : ''}</div>`;
    }
    function renderReader() {
      const box = $('mem-cv-read');
      root.querySelector('.mem-split').dataset.open = R ? '1' : '';
      if (!R) { box.innerHTML = '<div class="empty">选一个会话读原文</div>'; return; }
      if (!R.session) { box.innerHTML = `<button class="btn mem-back" data-act="back">← 列表</button><div class="empty">${R.error ? esc(R.error) : '读取中…'}</div>`; return; }
      const s = R.session;
      const days = [{ date: '', n: s.n, label: '全部' }, ...s.days.map((d) => ({ ...d, label: d.date.slice(5) }))];
      const jr = s.journal.filter((j) => !R.date || j.date === R.date);
      box.innerHTML = `<button class="btn mem-back" data-act="back">← 列表</button><h3 class="mem-dtitle">${esc(s.title || '（无标题）')}</h3>`
        + `<div class="mem-meta">${esc(dev(s.device))} · ${esc(s.tool_label || tool(s.tool))} · ${esc(dayOf(s.first))} 至 ${esc(dayOf(s.last))} · ${s.n} 条消息${s.cwd ? ` · ${esc(s.cwd)}` : ''}</div>`
        + (days.length > 2 ? `<div class="chips mem-days">${days.map((d) => `<button data-day="${esc(d.date)}" class="${R.date === d.date ? 'on' : ''}">${esc(d.label)}${d.date ? ` <i>${d.n}</i>` : ''}</button>`).join('')}</div>` : '')
        + (jr.length ? `<div class="mem-jr">${jr.map((j) => `<div><i>${esc(j.date.slice(5))}</i>${esc(j.summary)}</div>`).join('')}</div>` : '')
        + (R.from > 1 ? '<div class="mem-more"><button class="btn" data-act="fromstart">从头读</button></div>' : '')
        + `<div class="mem-msgs">${R.messages.map((m) => msgHtml(m, !R.date)).join('') || `<div class="empty">${R.loading ? '读取中…' : '这一天没有消息'}</div>`}</div>`
        + (R.next ? `<div class="mem-more"><button class="btn" data-act="more" ${R.loading ? 'disabled' : ''}>${R.loading ? '读取中…' : '加载更多'}</button></div>` : '');
      const hit = box.querySelector('.mem-msg.hit');
      if (hit && R.scrollHit) { R.scrollHit = false; box.scrollTop += hit.getBoundingClientRect().top - box.getBoundingClientRect().top - 110; }
    }
    async function openRef(ref, date, hit) {
      const from = hit ? Math.max(1, hit - 2) : 0;
      R = { ref, session: null, date: date || '', messages: [], next: null, hit: hit || 0, from, loading: false, scrollHit: Boolean(hit) };
      renderReader(); renderList();
      await fetchMsgs(true);
    }
    async function fetchMsgs(first) {
      const my = R; R.loading = true;
      try {
        const r = await Console.api(`/console/api/conv/${encodeURIComponent(R.ref)}`, { query: { date: R.date, from: first ? (R.from || '') : R.next } });
        if (R !== my) return;
        R.session = r.session; R.messages = first ? r.messages : R.messages.concat(r.messages); R.next = r.next || null;
      } catch (e) { if (R !== my) return; R.error = e.status === 404 ? '没有这个会话' : `读取失败：${e.message}`; }
      R.loading = false; renderReader();
      $('mem-cv-read').scrollTop = first && !R.hit ? 0 : $('mem-cv-read').scrollTop;
    }
    async function expand(btn) {
      const node = btn.closest('.mem-msg'); const idx = Number(node.dataset.i);
      btn.disabled = true; btn.textContent = '读取中…';
      try {
        const r = await Console.api(`/console/api/conv/${encodeURIComponent(R.ref)}`, { query: { from: idx, full: 1, date: R.date } });
        const m = r.messages.find((x) => x.index === idx) || r.messages[0];
        const mine = R.messages.find((x) => x.index === idx);
        if (m && mine) { mine.text = m.text; mine.truncated = false; }
        node.querySelector('.mem-mt').innerHTML = hl(mine ? mine.text : m.text, words); btn.remove();
      } catch (e) { btn.disabled = false; btn.textContent = '展开全文'; Console.toast(`读取失败：${e.message}`, 'err'); }
    }

    // ---- 选中一段文字存成记忆（接口在 admin-tools.mjs）----
    let sbtn = null; let sdat = null; let stimer = 0; let sraf = 0;
    const hideSel = () => { if (sbtn) sbtn.hidden = true; sdat = null; };
    const elOf = (n) => (n && n.nodeType === 1 ? n : n?.parentElement);
    function readSel() {
      const s = getSelection();
      if (!R?.session || !s || s.isCollapsed || !s.rangeCount) return null;
      const box = $('mem-cv-read');
      const a = elOf(s.anchorNode)?.closest('.mem-mt'); const f = elOf(s.focusNode)?.closest('.mem-mt');
      if (!a || !f || !box.contains(a) || !box.contains(f)) return null;
      const text = s.toString().trim();
      if (!text) return null;
      const r = s.getRangeAt(0);
      const msg = elOf(r.startContainer)?.closest('.mem-msg');
      return { text, ref: R.session.ref, day: msg?.dataset.day || R.date || dayOf(R.session.first), rect: r.getBoundingClientRect() };
    }
    function showSel() {
      const d = readSel();
      if (!d) { hideSel(); return; }
      if (!sbtn) {
        sbtn = document.createElement('button');
        sbtn.className = 'btn mem-sel-btn'; sbtn.textContent = '存成记忆';
        sbtn.addEventListener('mousedown', (e) => e.preventDefault()); // 不让点按钮把选区点没了
        sbtn.onclick = () => { const x = sdat; hideSel(); if (x) saveForm(x); };
        document.body.appendChild(sbtn);
      }
      sdat = d; sbtn.hidden = false;
      const w = sbtn.offsetWidth || 86; const h = sbtn.offsetHeight || 30;
      let top = d.rect.bottom + 8;
      if (top + h > innerHeight - 8) top = Math.max(8, d.rect.top - h - 8);
      sbtn.style.left = `${Math.min(Math.max(8, d.rect.left), innerWidth - w - 8)}px`; sbtn.style.top = `${top}px`;
    }
    const soon = (ms) => { clearTimeout(stimer); stimer = setTimeout(showSel, ms); };
    function savedToast(id) {
      Console.toast('已存成记忆', 'ok');
      const n = document.querySelector('.toasts')?.lastElementChild;
      if (!n) return;
      const m = n.cloneNode(false); // 带链接的提示多留几秒，来得及点
      m.className = 'toast ok'; m.innerHTML = `已存成记忆<a href="#/lib/${esc(id)}">看这条</a>`;
      n.replaceWith(m);
      setTimeout(() => { m.style.transition = 'opacity .3s'; m.style.opacity = 0; setTimeout(() => m.remove(), 320); }, 8000);
    }
    function saveForm(x) {
      const projects = (Console.data()?.projects || []).map((p) => p.p).filter((p) => p && p !== '其他' && p !== '未写日志');
      const wrap = document.createElement('div');
      wrap.className = 'mem-modal';
      wrap.innerHTML = '<form class="mem-dlg mem-sv" role="dialog" aria-modal="true"><h3>存成记忆</h3>'
        + `<div class="mem-sv-row"><label class="mem-fld"><span>类型</span><select class="inp" name="type">${TYPES.map((t) => `<option value="${t}" ${t === 'fact' ? 'selected' : ''}>${esc(zh.type[t])}</option>`).join('')}</select></label>`
        + `<label class="mem-fld"><span>项目</span><input class="inp" name="project" list="mem-sv-projects" maxlength="60" autocomplete="off"><datalist id="mem-sv-projects">${projects.map((p) => `<option value="${esc(p)}">`).join('')}</datalist></label></div>`
        + '<label class="mem-fld"><span>标题</span><input class="inp" name="title" maxlength="200" autocomplete="off"></label>'
        + '<label class="mem-fld" data-subj hidden><span>主题键</span><input class="inp" name="subject" maxlength="120" placeholder="如 myapp/prod-version" autocomplete="off"></label>'
        + '<label class="mem-fld"><span>正文</span><textarea class="inp" name="body" rows="8"></textarea></label>'
        + `<div class="mem-sv-src">出处：对话 ${esc(x.ref)} · ${esc(x.day)}</div><div class="mem-sv-err" hidden></div>`
        + '<div class="mem-dact"><button type="button" class="btn" data-x>取消</button><button type="submit" class="btn" data-ok disabled>保存</button></div></form>';
      document.body.appendChild(wrap);
      const f = wrap.querySelector('form'); const err = wrap.querySelector('.mem-sv-err'); const ok = wrap.querySelector('[data-ok]');
      f.elements.body.value = x.text;
      const sync = () => {
        wrap.querySelector('[data-subj]').hidden = f.elements.type.value !== 'status';
        ok.disabled = !f.elements.title.value.trim() || (f.elements.type.value === 'status' && !f.elements.subject.value.trim());
      };
      const done = () => { document.removeEventListener('keydown', key, true); wrap.remove(); };
      const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(); } };
      document.addEventListener('keydown', key, true);
      f.addEventListener('input', sync); f.elements.type.addEventListener('change', sync);
      wrap.querySelector('[data-x]').onclick = done;
      f.onsubmit = async (ev) => {
        ev.preventDefault();
        if (ok.disabled) return;
        ok.disabled = true; err.hidden = true;
        const body = { ref: x.ref, date: x.day, type: f.elements.type.value, title: f.elements.title.value.trim(), body: f.elements.body.value, project: f.elements.project.value.trim() };
        if (body.type === 'status') body.subject = f.elements.subject.value.trim();
        try {
          const r = await Console.api('/console/api/memory/from-conv', { body });
          done(); getSelection()?.removeAllRanges();
          window.dispatchEvent(new Event('am-lib-stale'));
          savedToast(r.id);
        } catch (e) { err.textContent = e.message; err.hidden = false; sync(); }
      };
      Console.api('/console/api/memory/conv-hint', { query: { ref: x.ref, date: x.day } }).then((h) => { if (h.project && !f.elements.project.value) f.elements.project.value = h.project; }).catch(() => {});
      f.elements.title.focus(); sync();
    }

    Console.page('convs', {
      hide() { hideSel(); },
      mount(el) {
        root = el;
        document.addEventListener('selectionchange', () => { if (Console.visible('convs')) soon(250); });
        el.innerHTML = `<section class="panel mem-bar"><form class="mem-search" id="mem-cv-form"><input class="inp" id="mem-cv-q" type="search" autocomplete="off" placeholder="搜对话原文，空格分隔多个词" aria-label="搜索对话">`
          + `<button class="btn" type="submit">搜索</button></form><div class="mem-filters"><select class="inp" id="mem-cv-device" aria-label="设备"><option value="">全部设备</option></select>`
          + `<select class="inp" id="mem-cv-tool" aria-label="智能体"><option value="">全部智能体</option></select>`
          + `<input class="inp" type="date" id="mem-cv-from" aria-label="开始日期"><span class="mem-to">至</span><input class="inp" type="date" id="mem-cv-to" aria-label="结束日期"></div></section>`
          + `<div class="mem-split"><section class="panel mem-listp"><div class="mem-vscroll scroll" id="mem-cv-list"></div></section><section class="panel mem-detail scroll" id="mem-cv-read"></section></div>`;
        $('mem-cv-form').onsubmit = (e) => { e.preventDefault(); search(); };
        for (const id of ['mem-cv-device', 'mem-cv-tool', 'mem-cv-from', 'mem-cv-to']) $(id).onchange = () => { if ($('mem-cv-q').value.trim()) search(); };
        $('mem-cv-list').addEventListener('click', (ev) => {
          const sn = ev.target.closest('.mem-sn'); const h = ev.target.closest('.mem-hit'); if (!h) return;
          Console.go(`convs/${h.dataset.ref}`, sn ? { date: sn.dataset.day, hit: sn.dataset.at } : {});
        });
        $('mem-cv-read').addEventListener('click', (ev) => {
          const full = ev.target.closest('[data-full]'); if (full) { expand(full); return; }
          const d = ev.target.closest('.mem-days [data-day]');
          if (d && R) { R.date = d.dataset.day; R.hit = 0; R.from = 0; R.messages = []; R.next = null; fetchMsgs(true); renderReader(); return; }
          const a = ev.target.closest('[data-act]'); if (!a || !R) return;
          if (a.dataset.act === 'back') Console.go('convs');
          else if (a.dataset.act === 'more') { fetchMsgs(false); renderReader(); }
          else if (a.dataset.act === 'fromstart') { R.from = 0; R.hit = 0; R.messages = []; fetchMsgs(true); renderReader(); }
        });
        $('mem-cv-read').addEventListener('mouseup', () => soon(10));
        $('mem-cv-read').addEventListener('scroll', () => { if (sdat && !sraf) sraf = requestAnimationFrame(() => { sraf = 0; showSel(); }); });
        addEventListener('resize', () => { if (sdat) showSel(); });
        fillOptions(); renderList(); renderReader();
      },
      show(params) {
        const q = params.query.q;
        if (q !== undefined && q !== F.q) { $('mem-cv-q').value = q; search(); }
        if (!params.arg) { R = null; renderReader(); renderList(); return; }
        const hit = Number(params.query.hit) || 0; const dt = params.query.date || '';
        if (R && R.ref === params.arg && R.date === dt && R.hit === hit) return;
        openRef(params.arg, dt, hit);
      },
    });
  })();
})();
