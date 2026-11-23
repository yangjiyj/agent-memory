/* 全局搜索 + 问我的记忆：Cmd/Ctrl+K 弹出面板，同时搜页面、记忆、对话、项目、设备；Tab（或点"问"）切到问答。
 * 顶栏的入口由这里用 JS 注入；嵌入模式（?embed=1，大屏里的那种）不启用。
 * 接口：GET /console/api/search?q=、GET /console/api/ask/status、POST /console/api/ask（见 hub/admin-search.mjs）。
 * 跳转：记忆 #/lib/<id>，对话 #/convs/<ref>?date=&hit=，项目 #/projects/<名>，设备 #/devices，页面 #/<id>。
 */
(function () {
  'use strict';
  const { esc } = Console;

  // ---------------- 纯函数（测试里单独加载这个文件时也用得到，所以放在嵌入模式判断之前）----------------
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 转义后把命中词包上 <mark>
  function hl(text, words) {
    const ws = (words || []).filter(Boolean).map(escRe);
    if (!ws.length) return esc(text);
    return String(text ?? '').split(new RegExp(`(${ws.join('|')})`, 'gi')).map((p, i) => (i % 2 ? `<mark>${esc(p)}</mark>` : esc(p))).join('');
  }
  // 答案：先整体转义（模型的输出不可信），再把 **粗体**、`代码`、[n] 换成标签；只有存在于出处里的编号才变成可点的小块
  function renderAnswer(text, sources) {
    const valid = new Set((sources || []).map((s) => s.n));
    return esc(text)
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\[(\d{1,2}(?:\s*[,，、]\s*\d{1,2})*)\]/g, (m, list) => {
        const ns = list.split(/[,，、]/).map((x) => Number(x.trim()));
        if (!ns.every((n) => valid.has(n))) return m;
        return ns.map((n) => `<button type="button" class="gs-cite" data-n="${n}" aria-label="出处 ${n}">${n}</button>`).join('');
      });
  }
  const wordsOf = (q) => [...new Set(String(q || '').toLowerCase().split(/\s+/).filter(Boolean))];
  Console.searchKit = { hl, renderAnswer, wordsOf };

  if (Console.embed) return;

  // ---------------- 状态 ----------------
  const MAC = /Mac|iPhone|iPad/.test(navigator.platform || '') || /Mac OS X/.test(navigator.userAgent || '');
  const TYPE_ZH = Console.zh.type;
  const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>';
  let wrap = null; let input = null; let body = null; let segBtns = [];
  let mode = 'search'; // 'search' | 'ask'
  let rows = []; // 当前能用键盘选的行：{ go() }
  let sel = -1;
  let data = null; // 最近一次搜索结果
  let searchErr = ''; let searching = false;
  let ctl = null; let timer = 0; let seq = 0;
  let ask = { status: null, q: '', loading: false, answer: null, error: '', t0: 0 };
  const draft = { search: '', ask: '' };
  let restoreFocus = null;

  const open = () => !!wrap && wrap.classList.contains('on');

  // ---------------- 请求 ----------------
  async function getJSON(url, signal) {
    let r;
    try { r = await fetch(url, { signal }); } catch (e) { if (e.name === 'AbortError') throw e; throw new Error('连不上中心，请检查网络'); }
    const j = await r.json().catch(() => null);
    if (!r.ok) throw Object.assign(new Error((j && j.error) || `请求失败（${r.status}）`), { status: r.status });
    return j;
  }
  async function postJSON(url, body) {
    let r;
    try { r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); } catch { throw new Error('连不上中心，请检查网络'); }
    const j = await r.json().catch(() => null);
    if (!r.ok) throw Object.assign(new Error((j && j.error) || `请求失败（${r.status}）`), { status: r.status });
    return j;
  }

  // ---------------- 页面（本地匹配侧栏）----------------
  function pageList() {
    const out = []; let group = '';
    for (const n of document.querySelectorAll('#nav > *')) {
      if (n.tagName === 'H4') group = n.textContent.trim();
      else if (n.dataset?.id) out.push({ id: n.dataset.id, title: n.querySelector('span')?.textContent.trim() || n.dataset.id, group });
    }
    return out;
  }
  const matchPages = (words) => pageList().filter((p) => words.every((w) => `${p.title} ${p.id} ${p.group}`.toLowerCase().includes(w)));
  // 查询为空时的页面：最近去过的几个（不含当前页），不够 6 个用常用页补；不平铺 15 个
  const RECENT_KEY = 'am-gs-recent';
  const pageId = () => location.hash.replace(/^#\/?/, '').split(/[/?]/)[0];
  const recents = () => { try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; } };
  function noteVisit() {
    const id = pageId();
    if (!id || !pageList().some((p) => p.id === id)) return;
    try { localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recents().filter((x) => x !== id)].slice(0, 8))); } catch { /* 存不了就算了 */ }
  }
  function startPages() {
    const all = pageList(); const cur = pageId();
    const ids = [...recents(), 'overview', 'lib', 'timeline', 'projects', 'devices', 'settings'].filter((id, i, a) => id !== cur && a.indexOf(id) === i && all.some((p) => p.id === id));
    return ids.slice(0, 6).map((id) => all.find((p) => p.id === id));
  }

  // ---------------- 跳转 ----------------
  function jump(fn) { close(); fn(); }
  const goMemory = (id) => jump(() => Console.go(`lib/${encodeURIComponent(id)}`));
  const goConv = (ref, date, hit) => jump(() => Console.go(`convs/${encodeURIComponent(ref)}`, date ? { date, ...(hit ? { hit } : {}) } : {}));

  // ---------------- 渲染：搜索 ----------------
  const pillOf = (t) => `<span class="pill">${esc(TYPE_ZH[t] || t)}</span>`;
  const projPill = (p) => (p ? `<span class="pill dim">${esc(p)}</span>` : '');
  const shortDay = (d) => (String(d).slice(0, 4) === Console.date.today().slice(0, 4) ? String(d).slice(5) : d);

  function renderSearch() {
    const q = input.value.trim();
    const words = wordsOf(q);
    rows = [];
    const out = [];
    const group = (title, count, items) => {
      if (!items.length) return;
      out.push(`<div class="gs-g"><h4>${esc(title)}${count ? `<em>${esc(count)}</em>` : ''}</h4>${items.join('')}</div>`);
    };
    const row = (go, html, extra = '') => {
      const i = rows.push({ go }) - 1;
      return `<div class="gs-r ${extra}" role="option" id="gs-r${i}" data-i="${i}" aria-selected="false">${html}</div>`;
    };
    const line = (title, meta, snippet) => `<div class="t"><span class="tt">${title}</span><span class="m">${meta}</span></div>${snippet ? `<div class="s">${snippet}</div>` : ''}`;
    const more = (go, text) => row(go, `<div class="t"><span class="tt">${esc(text)}</span><span class="m">→</span></div>`, 'more');

    const pages = q ? matchPages(words) : startPages();
    group('页面', '', pages.slice(0, q ? 5 : 6).map((p) => row(() => jump(() => Console.go(p.id)), line(hl(p.title, words), '', ''))));

    // 新结果回来之前继续显示上一次的（变暗），不让列表在每次按键之间闪空
    const shown = data && q && (data.q === q || searching) ? data : null;
    if (shown) {
      const { q: dq } = shown;
      const words = wordsOf(dq);
      const m = shown.memories;
      group('记忆', m.total > m.items.length || m.capped ? `${m.total}${m.capped ? '+' : ''}` : '', [
        ...m.items.map((x) => row(() => goMemory(x.id), line(hl(x.title, words), `${pillOf(x.type)}${projPill(x.project)}<span class="d">${esc(shortDay(x.date))}</span>`, x.snippet ? hl(x.snippet, words) : ''))),
        ...(m.total > m.items.length || m.capped ? [more(() => jump(() => Console.go('lib', { q: dq })), `在记忆库里看全部 ${m.total}${m.capped ? '+' : ''} 条`)] : []),
      ]);
      const c = shown.convs;
      group('对话', c.total > c.items.length || c.more || c.partial ? `${c.total}${c.more ? '+' : ''}${c.partial ? ' · 没搜完' : ''}` : '', [
        ...c.items.map((x) => row(() => goConv(x.ref, x.date, x.hit), line(hl(x.title || '（无标题）', words),
          `${projPill(x.project)}<span class="pill dim">${esc(x.device_label || Console.dev(x.device))} · ${esc(x.tool_label || Console.tool(x.tool))}</span><span class="d">${esc(shortDay(x.date))}</span>`, hl(x.snippet, words)))),
        ...(c.total > c.items.length || c.more || c.partial ? [more(() => jump(() => Console.go('convs', { q: dq })), '在对话存档里看全部命中')] : []),
      ]);
      group('项目', '', shown.projects.items.map((x) => row(() => jump(() => Console.go(`projects/${encodeURIComponent(x.name)}`)), line(hl(x.name, words), `<span class="d">${x.count} 条</span>`, ''))));
      group('设备', '', shown.devices.items.map((x) => row(() => jump(() => Console.go('devices')), line(`${hl(x.label || x.name, words)}${x.label ? ` <span class="sub">${hl(x.name, words)}</span>` : ''}`,
        x.role !== 'device' ? `<span class="pill dim">${esc(x.role)}</span>` : (x.last_seen ? `<span class="d">${esc(Console.date.ago(x.last_seen))}</span>` : ''), ''))));
    }
    if (q && !searching && !searchErr && shown && shown.q === q && out.length === 0) out.push(`<div class="empty">没有找到「${esc(q)}」</div>`);
    if (searchErr) out.push(`<div class="gs-err">${esc(searchErr)}</div>`);
    body.classList.toggle('busy', searching);
    body.innerHTML = out.join('');
    sel = rows.length ? 0 : -1;
    paintSel();
  }

  // ---------------- 渲染：问 ----------------
  function renderAsk() {
    rows = [];
    const st = ask.status;
    if (!st) { body.innerHTML = '<div class="gs-load"><i></i><i></i><i></i></div>'; sel = -1; return; }
    if (!st.configured) {
      body.innerHTML = '<div class="gs-off"><b>问答还没配置</b><button class="btn" type="button" data-go-settings>去设置</button></div>';
      rows.push({ go: () => jump(() => Console.go('settings')) });
      sel = 0; paintSel();
      return;
    }
    const out = [];
    if (ask.loading) out.push(`<div class="gs-q">${esc(ask.q)}</div><div class="gs-load" role="status"><i></i><i></i><i></i><span>检索并回答中…</span></div>`);
    else if (ask.error) out.push(`<div class="gs-q">${esc(ask.q)}</div><div class="gs-err">${esc(ask.error)}</div>`);
    else if (ask.answer) {
      const a = ask.answer;
      out.push(`<div class="gs-q">${esc(ask.q)}</div><div class="gs-ans">${renderAnswer(a.answer, a.sources)}</div>`);
      if (a.sources.length) {
        // 被答案引用的出处一定显示；没被引用的折叠起来（至少凑够 3 条），点"另有 N 条"展开
        const cited = a.sources.filter((s) => s.cited);
        const rest = a.sources.filter((s) => !s.cited);
        const show = ask.expand ? a.sources : [...cited, ...rest.slice(0, Math.max(0, 3 - cited.length))].sort((x, y) => x.n - y.n);
        const folded = a.sources.length - show.length;
        const items = show.map((s) => {
          const i = rows.push({ go: () => (s.kind === 'memory' ? goMemory(s.id) : goConv(s.ref, s.date, s.hit)) }) - 1;
          return `<div class="gs-r src ${s.cited ? '' : 'un'}" role="option" id="gs-r${i}" data-i="${i}" data-n="${s.n}" aria-selected="false"><div class="t"><span class="tt"><b class="n">${s.n}</b>${esc(s.title || '（无标题）')}</span>`
            + `<span class="m"><span class="pill dim">${s.kind === 'memory' ? '记忆' : '对话'}</span>${projPill(s.project)}<span class="d">${esc(shortDay(s.date))}</span></span></div></div>`;
        });
        if (folded > 0) {
          const i = rows.push({ go: () => { ask.expand = true; renderAsk(); } }) - 1;
          items.push(`<div class="gs-r more" role="option" id="gs-r${i}" data-i="${i}" aria-selected="false"><div class="t"><span class="tt">另有 ${folded} 条检索到、没被引用的资料</span><span class="m">▾</span></div></div>`);
        }
        out.push(`<div class="gs-g"><h4>出处<em>${a.sources.length}</em></h4>${items.join('')}</div>`);
      }
      out.push(`<div class="gs-foot">${esc(st.model)}</div>`);
    }
    body.classList.remove('busy');
    body.innerHTML = out.join('');
    sel = -1; paintSel();
  }

  const render = () => (mode === 'ask' ? renderAsk() : renderSearch());

  function paintSel() {
    body.querySelectorAll('.gs-r').forEach((n) => { const on = Number(n.dataset.i) === sel; n.classList.toggle('on', on); n.setAttribute('aria-selected', on ? 'true' : 'false'); });
    input.setAttribute('aria-activedescendant', sel >= 0 ? `gs-r${sel}` : '');
    if (sel >= 0) body.querySelector(`.gs-r[data-i="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }
  function move(d) {
    if (!rows.length) return;
    sel = sel < 0 ? (d > 0 ? 0 : rows.length - 1) : (sel + d + rows.length) % rows.length;
    paintSel();
  }

  // ---------------- 搜索 / 问 的动作 ----------------
  function runSearch() {
    clearTimeout(timer);
    const q = input.value.trim();
    if (ctl) ctl.abort();
    if (!q) { data = null; searching = false; searchErr = ''; renderSearch(); return; }
    renderSearch(); // 页面一栏先本地刷出来
    timer = setTimeout(async () => {
      const my = ++seq; ctl = new AbortController(); searching = true; searchErr = '';
      body.classList.add('busy');
      try {
        const r = await getJSON(`/console/api/search?q=${encodeURIComponent(q)}`, ctl.signal);
        if (my !== seq) return;
        data = { q, ...r };
      } catch (e) {
        if (e.name === 'AbortError' || my !== seq) return;
        searchErr = e.message;
      }
      searching = false;
      renderSearch();
    }, 180);
  }

  async function ensureStatus() {
    if (ask.status) return;
    try { ask.status = await getJSON('/console/api/ask/status'); } catch (e) { ask.status = { configured: false, model: '', error: e.message }; }
  }

  async function submitAsk() {
    const q = input.value.trim();
    if (!q || ask.loading || !ask.status?.configured) return;
    ask = { ...ask, q, loading: true, answer: null, error: '', expand: false, t0: Date.now() };
    renderAsk();
    try { ask.answer = await postJSON('/console/api/ask', { q }); } catch (e) {
      ask.error = e.message;
      if (e.status === 409) ask.status = null; // 配置被改掉了：回到"未配置"
    }
    ask.loading = false;
    if (mode === 'ask') { if (ask.status) renderAsk(); else ensureStatus().then(renderAsk); }
  }

  function setMode(m) {
    mode = m;
    segBtns.forEach((b) => { const on = b.dataset.m === m; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
    box().dataset.mode = m;
    if (m === 'ask') {
      input.value = draft.ask;
      input.placeholder = '问我的记忆，回车提交';
      input.disabled = false;
      renderAsk();
      ensureStatus().then(() => {
        if (mode !== 'ask') return;
        input.disabled = !ask.status.configured;
        if (!ask.status.configured) input.placeholder = '未配置';
        renderAsk();
        if (ask.status.configured) input.focus();
      });
    } else {
      input.disabled = false;
      input.value = draft.search;
      input.placeholder = '搜记忆、对话、项目、设备、页面';
      renderSearch();
      input.focus();
      if (draft.search.trim() && !data) runSearch();
    }
  }
  const box = () => wrap.querySelector('.gs-box');

  // ---------------- 打开 / 关闭 ----------------
  function build() {
    wrap = document.createElement('div');
    wrap.className = 'gs-wrap';
    wrap.innerHTML = `<div class="gs-scrim"></div><div class="gs-box" role="dialog" aria-modal="true" aria-label="全局搜索" data-mode="search">
      <div class="gs-head">${ICON}<input class="gs-in" type="text" autocomplete="off" spellcheck="false" aria-label="搜索" aria-controls="gs-body" role="combobox" aria-expanded="true">
        <div class="gs-seg" role="group" aria-label="模式"><button type="button" data-m="search" class="on" aria-pressed="true">搜索</button><button type="button" data-m="ask" aria-pressed="false">问</button></div>
        <kbd class="gs-kbd">Esc</kbd></div>
      <div class="gs-body" id="gs-body" role="listbox"></div></div>`;
    document.body.appendChild(wrap);
    input = wrap.querySelector('.gs-in');
    body = wrap.querySelector('.gs-body');
    segBtns = [...wrap.querySelectorAll('.gs-seg button')];
    wrap.querySelector('.gs-scrim').onclick = () => close();
    wrap.addEventListener('wheel', (e) => { if (!body.contains(e.target)) e.preventDefault(); }, { passive: false });
    segBtns.forEach((b) => { b.onclick = () => { if (b.dataset.m !== mode) switchMode(); input.focus(); }; });
    input.addEventListener('input', () => { draft[mode] = input.value; if (mode === 'search') runSearch(); else { sel = -1; paintSel(); } });
    body.addEventListener('mousemove', (e) => { const r = e.target.closest('.gs-r'); if (r && Number(r.dataset.i) !== sel) { sel = Number(r.dataset.i); paintSel(); } });
    body.addEventListener('click', (e) => {
      const c = e.target.closest('.gs-cite');
      if (c) { const r = body.querySelector(`.gs-r[data-n="${c.dataset.n}"]`); if (r) rows[Number(r.dataset.i)].go(); return; }
      if (e.target.closest('[data-go-settings]')) { jump(() => Console.go('settings')); return; }
      const r = e.target.closest('.gs-r'); if (r) rows[Number(r.dataset.i)]?.go();
    });
  }

  function switchMode() {
    draft[mode] = input.value;
    setMode(mode === 'search' ? 'ask' : 'search');
  }

  function openPanel(m) {
    if (!wrap) build();
    if (open()) { if (m && m !== mode) switchMode(); input.focus(); return; }
    restoreFocus = document.activeElement;
    wrap.classList.add('on');
    setMode(m || 'search');
    input.focus(); input.select();
  }
  function close() {
    if (!open()) return;
    clearTimeout(timer);
    if (ctl) ctl.abort();
    searching = false;
    wrap.classList.remove('on');
    // 焦点还给打开前的元素；顶栏入口除外（回给它会冒出一圈键盘焦点环）
    if (restoreFocus && document.contains(restoreFocus) && restoreFocus !== document.body && !restoreFocus.classList.contains('gs-open')) { try { restoreFocus.focus({ preventScroll: true }); } catch { /* 元素不能聚焦就算了 */ } }
    restoreFocus = null;
  }

  // ---------------- 键盘 ----------------
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault(); e.stopPropagation();
      if (open()) close(); else openPanel();
      return;
    }
    if (!open()) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.isComposing || e.keyCode === 229) return; // 输入法选词时的回车、方向键不算
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); move(e.key === 'ArrowDown' ? 1 : -1); return; }
    if (e.key === 'Tab') { e.preventDefault(); switchMode(); input.focus(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (mode === 'ask' && sel < 0) submitAsk();
      else if (sel >= 0) rows[sel]?.go();
    }
  }, true);

  addEventListener('hashchange', () => { close(); noteVisit(); });
  Console.ready.then(noteVisit);

  // ---------------- 顶栏入口 ----------------
  const top = document.querySelector('.top');
  if (top) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'gs-open'; btn.setAttribute('aria-label', '搜索');
    btn.title = `搜索（${MAC ? '⌘K' : 'Ctrl+K'}）`;
    btn.innerHTML = `${ICON}<span class="lab">搜索</span><kbd>${MAC ? '⌘K' : 'Ctrl K'}</kbd>`;
    btn.onclick = () => openPanel();
    const sp = top.querySelector('.sp');
    if (sp) sp.after(btn); else top.appendChild(btn);
  }
})();
