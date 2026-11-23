/* 接入与系统管理页：devices（设备）、mcp、jobs（任务）、settings（设置）。 */
(function () {
  'use strict';
  const h = Console.esc;
  const api = (path, opts) => Console.api(path, opts);
  const A = '/console/api/';

  // ---------------- 公共小件 ----------------
  const fmtN = (n) => Number(n || 0).toLocaleString('zh-CN');
  const absTime = (iso) => (iso ? new Date(Date.parse(iso) + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : '');
  const agoOf = (iso) => (iso ? Console.date.ago(iso) : '从未');
  const timeTag = (iso) => (iso ? `<span title="${h(absTime(iso))}">${h(agoOf(iso))}</span>` : '<span>从未</span>');
  const cmpVer = (a, b) => {
    const x = String(a).split(/[.\-]/).map((s) => parseInt(s, 10) || 0); const y = String(b).split(/[.\-]/).map((s) => parseInt(s, 10) || 0);
    for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; }
    return 0;
  };
  const sameSet = (a, b) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); } catch {
      const t = document.createElement('textarea');
      t.value = text; t.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
      document.body.appendChild(t); t.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      t.remove();
      if (!ok) { Console.toast('复制失败，请手动选中复制', 'err'); return; }
    }
    Console.toast('已复制', 'ok');
  }
  const copyBtn = (text) => `<button class="btn" type="button" data-copy="${h(text)}">复制</button>`;
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-copy]');
    if (b) copyText(b.dataset.copy);
  });

  // 弹窗：actions 里 onClick 返回 false 时不关闭
  function modal({ title, html, actions, danger, wide }) {
    const wrap = document.createElement('div');
    wrap.className = 'adm-modal-wrap';
    wrap.innerHTML = `<div class="adm-modal ${danger ? 'danger' : ''}" role="dialog" aria-modal="true" style="${wide ? 'width:min(720px,100%)' : ''}"><h3>${h(title)}</h3><div class="mb">${html}</div><div class="acts"></div></div>`;
    const acts = wrap.querySelector('.acts');
    const close = () => { document.removeEventListener('keydown', onKey, true); wrap.remove(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    for (const a of actions) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = `btn ${a.cls || ''}`; b.textContent = a.label;
      b.onclick = async () => { const r = a.onClick ? await a.onClick(b, close) : undefined; if (r !== false) close(); };
      acts.appendChild(b);
    }
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(wrap);
    (acts.querySelector('.go,.warn') || acts.lastElementChild)?.focus();
    return { el: wrap, close };
  }
  const confirmBox = ({ title, html, ok, danger }) => new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    const m = modal({ title, html, danger, actions: [
      { label: '取消', onClick: () => fin(false) },
      { label: ok, cls: danger ? 'warn' : 'go', onClick: () => fin(true) },
    ] });
    // 点背景或按 Esc 关闭也算取消
    new MutationObserver((_, o) => { if (!document.body.contains(m.el)) { o.disconnect(); fin(false); } }).observe(document.body, { childList: true });
  });

  // 右侧抽屉
  let drawerCur = null;
  function drawer(html) {
    drawerCur?.close();
    const scrim = document.createElement('div'); scrim.className = 'adm-scrim';
    const el = document.createElement('aside'); el.className = 'adm-drawer'; el.innerHTML = html;
    const close = () => { document.removeEventListener('keydown', onKey); scrim.remove(); el.remove(); if (drawerCur === api2) drawerCur = null; api2.onClose?.(); };
    const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.adm-modal-wrap')) close(); };
    const api2 = { el, close };
    scrim.onclick = close;
    el.querySelector('.adm-x').onclick = close;
    document.addEventListener('keydown', onKey);
    document.body.append(scrim, el);
    drawerCur = api2;
    return api2;
  }

  const switchBtn = (id, on, label, cls = '') => `<button type="button" class="adm-sw ${cls}" role="switch" aria-checked="${on ? 'true' : 'false'}" aria-label="${h(label)}" id="${id}"></button>`;
  const flip = (b, v) => b.setAttribute('aria-checked', String(v === undefined ? b.getAttribute('aria-checked') !== 'true' : v));
  const isOn = (b) => b.getAttribute('aria-checked') === 'true';

  // ======================================================================
  // 设备
  // ======================================================================
  (function devices() {
    const IDENT = { gateway: '网关', join: '加入码', token: '令牌' };
    const ROLE = { device: '设备', reporter: '报表', extractor: '抽取', admin: '管理' };
    const state = { devices: [], def: 3, latest: null, gf: '' }; // gf：按组筛选，'' = 全部，NOGROUP = 没分组的
    const NOGROUP = '\u0001';
    let root = null; let loading = null; let openName = null; let editing = null;

    const statusOf = (d) => {
      const p = d.policy;
      if (p.paused) return { k: 'off', text: d.last_seen ? `已暂停 · ${agoOf(d.last_seen)}` : '已暂停', stale: false };
      if (!d.last_seen) return { k: 'bad', text: '没同步过', stale: true };
      const hrs = (Date.now() - Date.parse(d.last_seen)) / 3600e3;
      if (hrs > (p.stale_hours || state.def)) return { k: 'bad', text: agoOf(d.last_seen), stale: true };
      return { k: 'ok', live: hrs < 0.25, text: agoOf(d.last_seen), stale: false };
    };
    const real = () => state.devices.filter((d) => d.role === 'device');
    const nameOf = (d) => d.label || Console.dev(d.name);
    const groupsOf = () => [...new Set(real().map((d) => d.group).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh'));
    const groupCell = (d) => `<td class="adm-gc" data-name="${h(d.name)}"><button type="button" class="adm-gb${d.group ? '' : ' none'}" title="修改分组" aria-label="修改 ${h(nameOf(d))} 的分组">${d.group ? h(d.group) : '—'}</button></td>`;

    // 行内改分组：点一下变成输入框（候选是已有的组），回车或点别处保存，Esc 放弃，清空 = 不分组
    function editGroup(cell) {
      if (editing) return;
      const d = state.devices.find((x) => x.name === cell.dataset.name);
      if (!d) return;
      editing = d.name;
      cell.innerHTML = `<input class="inp adm-gi" list="adm-gl" maxlength="20" value="${h(d.group || '')}" aria-label="分组"><datalist id="adm-gl">${groupsOf().map((g) => `<option value="${h(g)}"></option>`).join('')}</datalist>`;
      const inp = cell.querySelector('input');
      inp.focus(); inp.select();
      let done = false;
      const finish = async (save) => {
        if (done) return;
        done = true;
        const v = inp.value.trim();
        let saved = false;
        if (save && v !== (d.group || '')) {
          inp.disabled = true;
          try {
            await api(`${A}devices/${encodeURIComponent(d.name)}`, { body: { group: v || null } });
            Console.toast(v ? `${nameOf(d)} 已放进「${v}」` : `${nameOf(d)} 已移出分组`, 'ok');
            saved = true;
          } catch (e) { Console.toast(e.message, 'err'); }
        }
        editing = null;
        if (saved) { try { await load(); } catch { render(); } } else render();
      };
      inp.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      inp.addEventListener('blur', () => finish(true));
    }

    const agentPills = (d) => {
      const keys = Object.keys({ ...d.wiring, ...d.agents }).filter((k) => {
        if (k === 'cli' || k === 'test') return false;
        const a = d.agents[k];
        return d.wiring[k] || (a && (a.sessions || a.memories || a.calls));
      });
      keys.sort((a, b) => (Console.toolOrder.indexOf(a) + 99) % 99 - (Console.toolOrder.indexOf(b) + 99) % 99);
      if (!keys.length) return '<span class="muted">—</span>';
      const pill = (k) => {
        const live = d.agents[k]?.lastMsg && Date.now() - Date.parse(d.agents[k].lastMsg) < 20 * 60000;
        return `<span class="pill dim ${live ? 'live' : ''}">${h(Console.tool(k))}</span>`;
      };
      return `<div class="adm-ag">${keys.slice(0, 5).map(pill).join('')}${keys.length > 5 ? `<span class="pill dim" title="${h(keys.slice(5).map(Console.tool).join('、'))}">+${keys.length - 5}</span>` : ''}</div>`;
    };

    function render() {
      if (editing) return; // 正在行内改分组：别把输入框刷掉，改完会重画
      const groups = groupsOf();
      if (state.gf && state.gf !== NOGROUP && !groups.includes(state.gf)) state.gf = '';
      const noGroup = real().filter((d) => !d.group).length;
      const gf = root.querySelector('.adm-gf');
      gf.hidden = groups.length < 2; // 分组少于 2 个不显示筛选
      if (groups.length < 2) state.gf = '';
      const chip = (g, label, n) => `<button type="button" data-g="${h(g)}" class="${state.gf === g ? 'on' : ''}">${h(label)} ${n}</button>`;
      gf.innerHTML = groups.length < 2 ? '' : chip('', '全部', real().length) + groups.map((g) => chip(g, g, real().filter((d) => d.group === g).length)).join('') + (noGroup ? chip(NOGROUP, '未分组', noGroup) : '');
      const gname = (d) => d.group || '\uffff'; // 没分组的排在最后
      const list = real().filter((d) => !state.gf || (state.gf === NOGROUP ? !d.group : d.group === state.gf)).map((d) => ({ d, s: statusOf(d) }))
        .sort((a, b) => (groups.length ? gname(a.d).localeCompare(gname(b.d), 'zh') : 0) || Number(b.s.stale) - Number(a.s.stale) || (Date.parse(b.d.last_seen || 0) || 0) - (Date.parse(a.d.last_seen || 0) || 0));
      const others = state.devices.filter((d) => d.role !== 'device');
      const verPill = (v) => {
        if (!v) return '<span class="muted">—</span>';
        if (state.latest && cmpVer(v, state.latest) !== 0) return `<span class="pill adm-new" title="最新版本 ${h(state.latest)}">${h(v)}</span>`;
        return `<span class="mono">${h(v)}</span>`;
      };
      const row = ({ d, s }) => {
        const nm = nameOf(d);
        const hp = d.policy.hide_projects;
        return `<tr class="adm-row ${d.policy.paused ? 'dim' : ''} ${openName === d.name ? 'sel' : ''}" tabindex="0" data-name="${h(d.name)}">
          <td class="nm"><b>${h(nm)}</b>${nm !== d.name ? `<small>${h(d.name)}</small>` : ''}</td>
          ${groupCell(d)}
          <td><span class="pill dim">${h(IDENT[d.identity] || d.identity)}</span></td>
          <td>${verPill(d.version)}</td>
          <td><span class="adm-st ${s.k === 'bad' ? 'bad' : s.k === 'off' ? 'off' : ''}"><i class="adm-dot ${s.k} ${s.live ? 'live' : ''}"></i>${h(s.text)}</span></td>
          <td>${agentPills(d)}</td>
          <td>${d.policy.readonly ? '<span class="pill warn">只读</span>' : '<span class="muted">读写</span>'}</td>
          <td>${hp.length ? `<span class="pill warn" title="${h(hp.join('、'))}">隐藏 ${hp.length} 个</span>` : '<span class="muted">全部</span>'}</td></tr>`;
      };
      const otherRow = (d) => `<tr><td class="nm"><b>${h(d.name)}</b></td><td><span class="pill dim">${h(ROLE[d.role] || d.role)}</span></td><td><span class="pill dim">${h(IDENT[d.identity] || d.identity)}</span></td><td class="muted">${h(absTime(d.created))}</td><td class="muted">${d.last_seen ? timeTag(d.last_seen) : '—'}</td></tr>`;
      root.querySelector('.adm-dev-list').innerHTML = list.length
        ? `<div class="adm-wrap"><table class="adm-tbl"><tr><th>设备</th><th>分组</th><th>身份</th><th>设备端</th><th>最近同步</th><th>智能体</th><th>写入</th><th>可见项目</th></tr>${list.map(row).join('')}</table></div>`
        : '<div class="empty">还没有设备</div>';
      const op = root.querySelector('.adm-dev-others');
      op.hidden = !others.length;
      if (others.length) op.querySelector('.adm-wrap').innerHTML = `<table class="adm-tbl"><tr><th>名称</th><th>角色</th><th>身份</th><th>创建</th><th>最近使用</th></tr>${others.map(otherRow).join('')}</table>`;
    }

    function badge() { Console.badge('devices', real().filter((d) => statusOf(d).stale).length); }

    async function load() {
      if (loading) return loading;
      loading = (async () => {
        const [r, hl] = await Promise.all([api(`${A}devices`), api('/health').catch(() => null)]);
        state.devices = r.devices || []; state.def = r.default_stale_hours || 3;
        state.latest = hl?.agent_version || state.devices.map((d) => d.version).filter(Boolean).sort(cmpVer).pop() || null;
        badge();
        if (root) render();
      })().finally(() => { loading = null; });
      return loading;
    }

    // ---- 设备抽屉 ----
    async function openDevice(name) {
      const d = state.devices.find((x) => x.name === name);
      if (!d) return;
      openName = name; render();
      const p = d.policy;
      const sel = new Set(p.hide_projects);
      const nm = nameOf(d);
      const dr = drawer(`<header><div><h3>${h(nm)}</h3>${nm !== d.name ? `<small>${h(d.name)}</small>` : ''}</div><button class="adm-x" type="button" aria-label="关闭">×</button></header>
        <div class="body">
          <dl class="adm-facts"><dt>身份</dt><dd>${h(IDENT[d.identity] || d.identity)}</dd>${d.version ? `<dt>设备端</dt><dd>${h(d.version)}</dd>` : ''}${d.hostname ? `<dt>主机</dt><dd>${h(d.hostname)}${d.os ? ` · ${h(d.os)}` : ''}</dd>` : ''}<dt>加入</dt><dd>${h(absTime(d.created))}</dd></dl>
          <div class="adm-opt"><b>只读</b>${switchBtn('adm-dev-ro', p.readonly, '只读', 'warn')}<div class="why" hidden>这台机器上的智能体不能再写入记忆，只能读取。</div></div>
          <div class="adm-opt"><b>暂停<span class="sub">不再告警没同步</span></b>${switchBtn('adm-dev-pa', p.paused, '暂停')}</div>
          <div class="adm-opt"><b>隐藏项目</b><span class="adm-def" id="adm-dev-hn"></span><div class="why" hidden>这台机器上的智能体看不到这些项目的记忆。</div>
            <div class="adm-pick" style="grid-column:1/-1"><input class="inp" type="search" placeholder="筛选项目" aria-label="筛选项目"><div class="box"><span class="adm-def">读取中…</span></div></div></div>
          <div class="adm-opt"><b>同步超时</b><div class="adm-field-row"><input class="inp" id="adm-dev-sh" type="number" min="1" max="8760" step="1" placeholder="${state.def}" value="${p.stale_hours || ''}"><span class="adm-def">小时 · 留空 = 默认 ${state.def}</span></div></div>
        </div>
        <footer><span class="err" hidden></span><button class="btn" type="button" data-act="cancel">取消</button><button class="btn go" type="button" data-act="save">保存</button></footer>`);
      dr.onClose = () => { openName = null; if (root) render(); };
      const el = dr.el; const ro = el.querySelector('#adm-dev-ro'); const pa = el.querySelector('#adm-dev-pa'); const sh = el.querySelector('#adm-dev-sh');
      const whys = el.querySelectorAll('.why'); const box = el.querySelector('.box'); const filt = el.querySelector('.adm-pick input'); const err = el.querySelector('footer .err');
      let projects = []; let order = [];
      const sync = () => {
        whys[0].hidden = !isOn(ro); whys[1].hidden = !sel.size;
        el.querySelector('#adm-dev-hn').textContent = sel.size ? `已隐藏 ${sel.size} 个` : '全部可见';
        err.hidden = true;
      };
      const drawPick = () => {
        const q = filt.value.trim().toLowerCase();
        const names = order.filter((n) => !q || n.toLowerCase().includes(q));
        const cnt = Object.fromEntries(projects.map((x) => [x.p, x.n]));
        box.innerHTML = names.length ? names.map((n) => `<button type="button" class="${sel.has(n) ? 'on' : ''}" data-p="${h(n)}" title="${cnt[n] ? `${cnt[n]} 条记忆` : ''}">${h(n)}</button>`).join('') : '<span class="adm-def">没有匹配的项目</span>';
      };
      ro.onclick = () => { flip(ro); sync(); };
      pa.onclick = () => flip(pa);
      sh.oninput = () => { err.hidden = true; };
      filt.oninput = drawPick;
      box.onclick = (e) => { const b = e.target.closest('[data-p]'); if (!b) return; const n = b.dataset.p; if (sel.has(n)) sel.delete(n); else sel.add(n); drawPick(); sync(); };
      el.querySelector('[data-act=cancel]').onclick = dr.close;
      sync();
      try { projects = await api('/browse/projects', { ttl: 60000 }); if (!Array.isArray(projects)) projects = []; } catch { projects = []; }
      order = [...new Set([...sel, ...projects.map((x) => x.p)])]; // 打开时已隐藏的排前面，之后位置不再变
      drawPick();

      el.querySelector('[data-act=save]').onclick = async (ev) => {
        const body = {};
        if (isOn(ro) !== p.readonly) body.readonly = isOn(ro);
        if (isOn(pa) !== p.paused) body.paused = isOn(pa);
        const hp = [...sel];
        if (!sameSet(hp, p.hide_projects)) body.hide_projects = hp;
        const shv = sh.value.trim() === '' ? null : Number(sh.value);
        if (shv !== (p.stale_hours || null)) body.stale_hours = shv;
        if (!Object.keys(body).length) { dr.close(); return; }
        const risks = [];
        if (body.readonly === true) risks.push('只读：这台机器上的智能体不能再写入记忆。');
        const added = hp.filter((x) => !p.hide_projects.includes(x));
        if (added.length) risks.push(`隐藏项目：这台机器上的智能体看不到「${added.map(h).join('、')}」的记忆。`);
        if (risks.length && !(await confirmBox({ title: `限制 ${nm}`, html: `<ul>${risks.map((r) => `<li>${r}</li>`).join('')}</ul>`, ok: '确认限制', danger: true }))) return;
        ev.target.disabled = true;
        try {
          await api(`${A}devices/${encodeURIComponent(name)}`, { body });
          Console.toast(`${nm} 已更新`, 'ok');
          dr.close();
          await load();
        } catch (e) { err.textContent = e.message; err.hidden = false; ev.target.disabled = false; }
      };
    }

    // ---- 添加设备 ----
    function addDevice() {
      let days = 0;
      const m = modal({ title: '添加设备', wide: true, html: `<p>加入码有效期</p><div class="chips adm-days">${[0, 7, 30, 90].map((n) => `<button type="button" data-d="${n}" class="${n === 0 ? 'on' : ''}">${n ? `${n} 天` : '长期'}</button>`).join('')}</div><p class="adm-note">设备加入后一直有效，期限只管这个码还能不能用来加新机器。</p><div class="adm-out"></div><div class="adm-codes"></div>`,
        actions: [{ label: '关闭' }, { label: '生成加入码', cls: 'go', onClick: gen }] });
      const codes = m.el.querySelector('.adm-codes');
      async function listCodes() {
        try {
          const { codes: list } = await api(`${A}join-codes`);
          codes.innerHTML = list.length ? `<span class="adm-lab">还在生效的加入码</span>${list.map((c) => `<div class="adm-jc"><span>${h(absTime(c.created))} 生成</span><span>${c.expires ? `${h(absTime(c.expires))} 到期` : '长期'}</span><span>加入了 ${c.uses} 台</span><button class="btn" type="button" data-id="${h(c.id)}">作废</button></div>`).join('')}` : '';
        } catch { codes.innerHTML = ''; }
      }
      codes.onclick = async (e) => {
        const b = e.target.closest('[data-id]'); if (!b) return;
        b.disabled = true;
        try { await api(`${A}join-code/revoke`, { body: { id: b.dataset.id } }); Console.toast('加入码已作废', 'ok'); }
        catch (err) { Console.toast(err.message, 'err'); }
        listCodes();
      };
      listCodes();
      m.el.querySelector('.adm-days').onclick = (e) => {
        const b = e.target.closest('[data-d]'); if (!b) return;
        days = Number(b.dataset.d);
        m.el.querySelectorAll('.adm-days button').forEach((x) => x.classList.toggle('on', x === b));
      };
      async function gen(btn) {
        btn.disabled = true;
        const out = m.el.querySelector('.adm-out');
        try {
          const j = await api(`${A}join-code`, { body: { days } });
          out.innerHTML = `<p>${j.expires ? `这个加入码 ${h(absTime(j.expires))} 到期。` : '这个加入码长期有效，不用了可以在下面作废。'}</p>
            <span class="adm-lab">macOS / Linux</span><div class="adm-code"><code>${h(j.sh)}</code>${copyBtn(j.sh)}</div>
            <span class="adm-lab">Windows PowerShell</span><div class="adm-code"><code>${h(j.ps1)}</code>${copyBtn(j.ps1)}</div>`;
          btn.textContent = '重新生成';
          listCodes();
        } catch (e) { out.innerHTML = `<p style="color:#f08a8a">${h(e.message)}</p>`; }
        btn.disabled = false;
        return false;
      }
    }

    Console.page('devices', {
      mount(el) {
        root = el;
        el.innerHTML = `<section class="panel"><div class="ph"><h2>设备</h2><div class="chips adm-gf" hidden></div><button class="btn go" type="button" id="adm-dev-add">添加设备</button></div><div class="adm-dev-list"><div class="empty">读取中…</div></div></section>
          <section class="panel adm-dev-others" hidden><div class="ph"><h2>令牌</h2></div><div class="adm-wrap"></div></section>`;
        el.querySelector('#adm-dev-add').onclick = addDevice;
        const open = (e) => { const tr = e.target.closest('.adm-row'); if (tr) openDevice(tr.dataset.name); };
        el.addEventListener('click', (e) => {
          const gb = e.target.closest('.adm-gb');
          if (gb) { editGroup(gb.parentElement); return; }
          if (e.target.closest('.adm-gc')) return; // 分组格里的点击（输入框）不打开抽屉
          const chip = e.target.closest('.adm-gf button');
          if (chip) { state.gf = chip.dataset.g; render(); return; }
          open(e);
        });
        el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { if (e.target.closest('.adm-gc')) return; if (e.target.closest('.adm-row')) { e.preventDefault(); open(e); } } });
        Console.every('devices', 60000, load);
      },
      async show() { try { await load(); } catch (e) { root.querySelector('.adm-dev-list').innerHTML = `<div class="empty">${h(e.message)}</div>`; } },
      hide() { drawerCur?.close(); },
    });
    // 侧栏徽标：没同步的设备数，不进页面也要有
    const refreshBadge = () => { if (!document.hidden) load().catch(() => {}); };
    Console.ready.then(refreshBadge);
    setInterval(refreshBadge, 120000);
  })();

  // ======================================================================
  // MCP
  // ======================================================================
  (function mcp() {
    let root = null; let data = null; let filter = 'all';
    const open = new Set();

    function render() {
      if (!data) return;
      const tools = data.tools || [];
      const max = Math.max(1, ...tools.map((t) => t.calls_7d));
      const cnt = { all: tools.length, read: tools.filter((t) => t.kind === 'read').length, write: tools.filter((t) => t.kind === 'write').length };
      const shown = tools.filter((t) => filter === 'all' || t.kind === filter)
        .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'read' ? -1 : 1) || b.calls_7d - a.calls_7d || a.name.localeCompare(b.name));
      const addr = (label, v) => `<div class="adm-code"><div><small>${h(label)}</small><code>${h(v)}</code></div>${copyBtn(v)}</div>`;
      const rows = shown.map((t) => `<tr class="${t.disabled ? 'off' : ''} ${open.has(t.name) ? 'adm-open' : ''}" data-name="${h(t.name)}">
        <td class="mono">${h(t.name)}${t.disabled ? ' <span class="pill bad">已停用</span>' : ''}</td>
        <td><div class="adm-desc" title="${h(t.description)}">${h(t.description)}</div></td>
        <td>${t.kind === 'write' ? '<span class="pill warn">写</span>' : '<span class="pill adm-blue">读</span>'}</td>
        <td><div class="adm-use"><b>${fmtN(t.calls_7d)}</b><div class="tr">${t.calls_7d ? `<i class="${t.kind === 'write' ? 'w' : ''}" style="width:${Math.max(4, Math.round((t.calls_7d / max) * 100))}%"></i>` : ''}</div></div></td>
        <td class="muted" style="white-space:nowrap">${t.last_call ? timeTag(t.last_call) : '—'}</td>
        <td>${switchBtn('', !t.disabled, `启用 ${t.name}`)}</td></tr>`).join('');
      root.querySelector('.adm-mcp').innerHTML = `<div class="adm-addrs">${addr('HTTP', data.http)}${addr('stdio', data.stdio)}</div>
        <section class="panel"><div class="ph"><h2>工具</h2><div class="chips" style="margin:0">${[['all', '全部'], ['read', '读'], ['write', '写']].map(([k, l]) => `<button type="button" data-f="${k}" class="${filter === k ? 'on' : ''}">${l} ${cnt[k]}</button>`).join('')}</div></div>
        <div class="adm-wrap">${shown.length ? `<table class="adm-tbl"><tr><th>工具</th><th>用途</th><th></th><th class="num">7 天调用</th><th>最近一次</th><th>启用</th></tr>${rows}</table>` : '<div class="empty">没有工具</div>'}</div></section>`;
    }

    async function load() { data = await api(`${A}mcp`); render(); }

    async function toggle(name, disabled, btn) {
      btn.disabled = true;
      try {
        await api(`${A}mcp/tool`, { body: { name, disabled } });
        Console.toast(`${name} 已${disabled ? '停用' : '启用'}`, 'ok');
        await load();
      } catch (e) { Console.toast(e.message, 'err'); btn.disabled = false; }
    }

    Console.page('mcp', {
      mount(el) {
        root = el;
        el.innerHTML = '<div class="adm-mcp"><div class="empty">读取中…</div></div>';
        el.addEventListener('click', async (e) => {
          const f = e.target.closest('[data-f]');
          if (f) { filter = f.dataset.f; render(); return; }
          const tr = e.target.closest('tr[data-name]');
          if (!tr) return;
          const name = tr.dataset.name;
          const sw = e.target.closest('.adm-sw');
          if (sw) {
            if (isOn(sw)) {
              const ok = await confirmBox({ title: `停用 ${name}`, danger: true, ok: '停用', html: `<p>所有机器上的所有智能体都调不了这个工具，直到重新启用。</p>` });
              if (!ok) return;
              toggle(name, true, sw);
            } else toggle(name, false, sw);
            return;
          }
          if (e.target.closest('.adm-desc')) { if (open.has(name)) open.delete(name); else open.add(name); tr.classList.toggle('adm-open'); }
        });
      },
      async show() { try { await load(); } catch (e) { root.querySelector('.adm-mcp').innerHTML = `<div class="empty">${h(e.message)}</div>`; } },
    });
  })();

  // ======================================================================
  // 任务
  // ======================================================================
  (function jobs() {
    let root = null; let first = true;
    const chars = (n) => (n >= 1e8 ? { v: n / 1e8, u: '亿字', d: 1 } : n >= 1e4 ? { v: n / 1e4, u: '万字', d: 0 } : { v: n, u: '字', d: 0 });
    const num = (v, unit = '', bad = false, d = 0) => `<b class="${bad ? 'bad' : ''}"><span data-cu="${Number(v) || 0}" data-d="${d}">${(Number(v) || 0).toFixed(d)}</span>${unit ? `<small>${h(unit)}</small>` : ''}</b>`;
    const stat = (v, label, opt = {}) => `<div>${num(v, opt.unit, opt.bad, opt.d)}<span>${h(label)}</span></div>`;
    const meta = (rows) => { const r = rows.filter((x) => x[1]); return r.length ? `<div class="adm-meta">${r.map(([l, v]) => `<span>${h(l)}<b>${v}</b></span>`).join('')}</div>` : ''; };
    const T = (iso) => (iso ? timeTag(iso) : '');

    const cards = (j) => {
      const out = [];
      const s = j.sync; const e = j.extract; const g = j.journal; const v = j.vectors; const a = j.archive; const r = j.repo; const w = j.watch;
      // 设备同步
      if (!s || !s.devices?.length) out.push({ k: 'off', t: '设备同步', em: '没有设备', body: '<p class="adm-note">还没有接入设备</p>' });
      else {
        const paused = s.devices.filter((d) => d.paused).length; const fine = s.devices.filter((d) => !d.paused && !d.stale).length;
        const names = s.devices.filter((d) => d.stale).map((d) => `<span class="pill bad" title="${h(d.name)}">${h(Console.dev(d.name))}</span>`).join('');
        out.push({ k: s.stale_count ? 'warn' : 'ok', t: '设备同步', em: s.stale_count ? '要注意' : '正常',
          body: `<div class="adm-nums">${stat(fine, '正常')}${stat(s.stale_count, '没同步', { bad: s.stale_count > 0 })}${paused ? stat(paused, '已暂停') : ''}</div>${names}${meta([['最近一次同步', T(s.last_seen)]])}` });
      }
      // 会话抽取
      if (!e || (!e.total && !e.last_uploaded)) out.push({ k: 'off', t: '会话抽取', em: '没开', body: '<p class="adm-note">还没有会话进入抽取</p>' });
      else out.push({ k: e.error ? 'warn' : 'ok', t: '会话抽取', em: e.error ? '要注意' : '正常',
        body: `<div class="adm-nums">${stat(e.pending, '待处理')}${stat(e.error, '出错', { bad: e.error > 0 })}${stat(e.proposed, '待审候选')}</div>${meta([['已处理', `${fmtN(e.done)} / ${fmtN(e.total)}`], ['最近上传', T(e.last_uploaded)], ['最近处理', T(e.last_processed)], ['最近自动通过', T(e.last_auto_approve)]])}` });
      // 工作日志
      if (!g || (!g.days && !g.pending)) out.push({ k: 'off', t: '工作日志', em: '没开', body: '<p class="adm-note">还没有生成过工作日志</p>' });
      else out.push({ k: 'ok', t: '工作日志', em: '正常',
        body: `<div class="adm-nums">${stat(g.days, '已写天数')}${stat(g.pending, '待处理')}</div>${meta([['今天 / 昨天', `${fmtN(g.today_segments)} 段 / ${fmtN(g.yesterday_segments)} 段`], ['最近生成', T(g.last_result)]])}` });
      // 向量索引
      if (!v || !v.enabled) out.push({ k: 'off', t: '向量索引', em: '没开', body: `<p class="adm-note">没开，按意思搜暂不可用</p>${v?.items ? meta([['已有条目', fmtN(v.items)]]) : ''}` });
      else out.push({ k: 'ok', t: '向量索引', em: v.busy ? '正在建' : '正常', body: `<div class="adm-nums">${stat(v.items, '条目')}</div>${meta([['模型', h(v.model || '')]])}` });
      // 对话存档盘
      if (!a) out.push({ k: 'off', t: '对话存档盘', em: '没开', body: '<p class="adm-note">没有存档盘信息</p>' });
      else { const c = chars(a.chars || 0); out.push({ k: a.mounted ? 'ok' : 'warn', t: '对话存档盘', em: a.mounted ? '正常' : '没挂载',
        body: `<div class="adm-nums">${stat(a.sessions, '会话')}${stat(c.v, '总量', { unit: c.u, d: c.d })}</div>${a.mounted ? '' : '<p class="adm-note">存档盘没挂载，新对话暂时存不进去</p>'}` }); }
      // 记忆仓库
      const lc = r?.last_commit;
      out.push(lc ? { k: 'ok', t: '记忆仓库', em: '正常', body: `<div class="adm-nums"><div><b style="font-size:20px">${T(lc.time)}</b><span>最近提交</span></div></div>${meta([['作者', h(lc.author || '')], ['内容', `<span title="${h(lc.subject || '')}">${h(lc.subject || '')}</span>`]])}` }
        : { k: 'off', t: '记忆仓库', em: '没开', body: '<p class="adm-note">还没有提交记录</p>' });
      // 巡检
      const n = w?.problems?.length || 0;
      out.push(w ? { k: n ? 'warn' : 'ok', t: '巡检', em: n ? `${n} 个问题` : '正常', body: n ? `<div class="adm-nums">${stat(n, '问题', { bad: true })}</div>` : '<p class="adm-note">没有发现问题</p>' }
        : { k: 'off', t: '巡检', em: '没开', body: '<p class="adm-note">没有巡检结果</p>' });
      return out;
    };

    function render(j) {
      const probs = j.watch?.problems || [];
      const alerts = probs.length ? `<section class="panel adm-alerts"><div class="ph"><h2>需要处理</h2></div><ul>${probs.map((p) => `<li><i class="adm-dot warn"></i><span>${h(p.text)}</span></li>`).join('')}</ul></section>` : '';
      root.querySelector('.adm-jobs').innerHTML = `${alerts}<div class="adm-cards ${first ? '' : 'still'}">${cards(j).map((c, i) => `<section class="adm-card ${c.k}" style="animation-delay:${i * 50}ms"><h3><i class="adm-dot ${c.k}"></i>${h(c.t)}<em>${h(c.em)}</em></h3>${c.body}</section>`).join('')}</div>`;
      root.querySelectorAll('[data-cu]').forEach((n) => {
        const t = Number(n.dataset.cu); const d = Number(n.dataset.d);
        if (first && t > 0) Console.countUp(n, t, (x) => x.toFixed(d)); else n.textContent = t.toFixed(d);
      });
      first = false;
    }
    async function load() { render(await api(`${A}jobs`)); }
    Console.page('jobs', {
      mount(el) {
        root = el; el.innerHTML = '<div class="adm-jobs"><div class="empty">读取中…</div></div>';
        Console.every('jobs', 60000, load);
      },
      async show() { try { await load(); } catch (e) { root.querySelector('.adm-jobs').innerHTML = `<div class="empty">${h(e.message)}</div>`; } },
    });
  })();

  // ======================================================================
  // 设置
  // ======================================================================
  (function settings() {
    const KEYS = ['public_url', 'embed_url', 'stale_hours', 'auto_approve_days', 'digest_budget', 'auto_register_deny', 'device_labels', 'graph_entities'];
    let root = null; let orig = null; let defaults = {}; let inputs = {}; let saving = false; let serverErr = '';

    const sortObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
    const numOrNull = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : Number(v));
    function norm(key, v) {
      switch (key) {
        case 'public_url': case 'embed_url': return String(v ?? '').trim().replace(/\/+$/, '');
        case 'stale_hours': case 'auto_approve_days': return numOrNull(v);
        case 'digest_budget': return numOrNull(v) ?? defaults.digest_budget;
        case 'auto_register_deny': return (v || []).map((s) => String(s).trim()).filter(Boolean);
        case 'device_labels': return sortObj(Object.fromEntries(Object.entries(v || {}).map(([k, x]) => [k, String(x).trim()])));
        default: return { machine: [...(v?.machine || [])], site: [...(v?.site || [])] };
      }
    }
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    // 标签输入：回车、逗号或失焦时加入一项
    function tagInput(box, ph, onChange) {
      let list = [];
      const draw = () => {
        box.innerHTML = `${list.map((t, i) => `<span class="t">${h(t)}<button type="button" data-i="${i}" aria-label="删除 ${h(t)}">×</button></span>`).join('')}<input type="text" placeholder="${list.length ? '' : h(ph)}" aria-label="${h(ph)}">`;
      };
      const add = (txt) => { const items = txt.split(/[\n,，]/).map((s) => s.trim()).filter(Boolean); let ch = false; for (const t of items) if (!list.includes(t)) { list.push(t); ch = true; } if (ch) { draw(); onChange(); } return ch; };
      box.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-i]');
        if (b) { list.splice(Number(b.dataset.i), 1); draw(); onChange(); box.querySelector('input').focus(); } else box.querySelector('input').focus();
      });
      box.addEventListener('keydown', (e) => {
        const i = e.target; if (i.tagName !== 'INPUT') return;
        if (e.key === 'Enter' || e.key === ',' || e.key === '，') { e.preventDefault(); add(i.value); i.value = ''; box.querySelector('input').focus(); } else if (e.key === 'Backspace' && !i.value && list.length) { list.pop(); draw(); onChange(); box.querySelector('input').focus(); }
      });
      box.addEventListener('focusout', (e) => { if (e.target.tagName === 'INPUT' && e.target.value.trim()) { const v = e.target.value; e.target.value = ''; add(v); } });
      box.addEventListener('paste', (e) => { const t = e.clipboardData?.getData('text'); if (t && /[\n,，]/.test(t)) { e.preventDefault(); add(t); box.querySelector('input').focus(); } });
      draw();
      return { get: () => [...list], set: (l) => { list = [...l]; draw(); } };
    }

    function labelRow(k = '', v = '') {
      return `<div class="r"><input class="inp" list="adm-set-devs" placeholder="设备名" value="${h(k)}" aria-label="设备名"><input class="inp" placeholder="显示名" value="${h(v)}" aria-label="显示名"><button type="button" class="adm-x" aria-label="删除" data-del>×</button></div>`;
    }

    function read() {
      const lab = {};
      root.querySelectorAll('.adm-kv .r').forEach((r) => {
        const [a, b] = r.querySelectorAll('input');
        if (a.value.trim() || b.value.trim()) lab[a.value.trim()] = b.value;
      });
      return {
        public_url: norm('public_url', inputs.public_url.value), embed_url: norm('embed_url', inputs.embed_url.value),
        stale_hours: norm('stale_hours', inputs.stale_hours.value), auto_approve_days: norm('auto_approve_days', inputs.auto_approve_days.value), digest_budget: norm('digest_budget', inputs.digest_budget.value),
        auto_register_deny: norm('auto_register_deny', inputs.auto_register_deny.value.split('\n')),
        device_labels: norm('device_labels', lab),
        graph_entities: norm('graph_entities', { machine: inputs.machine.get(), site: inputs.site.get() }),
      };
    }
    const dirtyKeys = () => {
      if (!orig || !root) return [];
      const cur = read();
      return KEYS.filter((k) => !same(cur[k], orig[k]));
    };
    const dirty = () => dirtyKeys().length > 0;

    function refresh(clearErr = true) {
      if (clearErr) serverErr = '';
      const d = dirtyKeys();
      const bar = root.querySelector('.adm-save');
      bar.hidden = !d.length && !serverErr;
      bar.classList.toggle('bad', Boolean(serverErr));
      bar.querySelector('.msg').textContent = serverErr || `${d.length} 项未保存`;
      root.querySelectorAll('.adm-f[data-k]').forEach((f) => f.classList.toggle('ch', d.includes(f.dataset.k)));
      Console.badge('settings', d.length);
    }

    function fill(s) {
      const v = s.settings; defaults = s.defaults || {};
      orig = {};
      for (const k of KEYS) orig[k] = norm(k, v[k]);
      inputs.public_url.value = v.public_url || ''; inputs.embed_url.value = v.embed_url || '';
      inputs.stale_hours.value = v.stale_hours ?? ''; inputs.auto_approve_days.value = v.auto_approve_days ?? ''; inputs.digest_budget.value = v.digest_budget ?? defaults.digest_budget ?? '';
      inputs.auto_register_deny.value = (v.auto_register_deny || []).join('\n');
      for (const k of ['stale_hours', 'auto_approve_days', 'digest_budget']) inputs[k].placeholder = defaults[k] ?? '';
      const kv = root.querySelector('.adm-kv .rows');
      kv.innerHTML = Object.entries(v.device_labels || {}).map(([k, x]) => labelRow(k, x)).join('');
      inputs.machine.set(v.graph_entities?.machine || []); inputs.site.set(v.graph_entities?.site || []);
      refresh();
    }

    async function load() { fill(await api(`${A}settings`)); }

    async function save(btn) {
      const cur = read(); const keys = dirtyKeys();
      if (!keys.length) return;
      if (keys.includes('device_labels')) {
        const names = [...root.querySelectorAll('.adm-kv .r input:first-child')].map((i) => i.value.trim()).filter(Boolean);
        if (new Set(names).size !== names.length) { serverErr = '设备显示名里有重复的设备名'; refresh(false); return; }
      }
      const body = {};
      for (const k of keys) {
        let v = cur[k];
        if (k === 'device_labels' && !Object.keys(v).length) v = null;
        if (k === 'graph_entities' && !v.machine.length && !v.site.length) v = null;
        body[k] = v;
      }
      saving = true; btn.disabled = true;
      try {
        await api(`${A}settings`, { body });
        await load();
        Console.toast('已保存，已当场生效', 'ok');
        if (keys.includes('device_labels')) Console.loadData(true).catch(() => {});
      } catch (e) { serverErr = e.message; refresh(false); } finally { saving = false; btn.disabled = false; }
    }

    const field = (key, label, control, note) => `<div class="adm-f" data-k="${key}"><${key === 'device_labels' || key === 'graph_entities' ? 'div class="lb"' : 'label'}${/^(public_url|embed_url|stale_hours|auto_approve_days|digest_budget|auto_register_deny)$/.test(key) ? ` for="adm-set-${key}"` : ''}>${label}</${key === 'device_labels' || key === 'graph_entities' ? 'div' : 'label'}><div>${control}</div>${note ? `<div class="note">${note}</div>` : ''}</div>`;
    const numIn = (k, unit, defKey, ph) => `<div class="adm-field-row"><input class="inp n" id="adm-set-${k}" type="number" min="0" step="1" placeholder="${h(ph || '')}">${unit ? `<span class="adm-def">${unit}</span>` : ''}${defKey ? `<span class="adm-def">· 默认 <span class="adm-set-def" data-def="${defKey}"></span></span>` : ''}</div>`;

    Console.page('settings', {
      mount(el) {
        root = el;
        el.innerHTML = `<div class="adm-form">
          <section class="panel"><div class="ph"><h2>地址</h2></div>
            ${field('public_url', '公开地址', '<input class="inp w" id="adm-set-public_url" type="url" placeholder="https://hub.example:3190">', '会出现在安装命令和 MCP 接入地址里，设备按它连回中心')}
            ${field('embed_url', '向量服务', '<input class="inp w" id="adm-set-embed_url" type="url" placeholder="留空 = 不开按意思搜">')}</section>
          <section class="panel"><div class="ph"><h2>时间与额度</h2></div>
            ${field('stale_hours', '同步超时', numIn('stale_hours', '小时', 'stale_hours'))}
            ${field('auto_approve_days', '候选自动通过', numIn('auto_approve_days', '天', 'auto_approve_days'))}
            ${field('digest_budget', '摘要大小', numIn('digest_budget', '字节', 'digest_budget'))}</section>
          <section class="panel"><div class="ph"><h2>接入</h2></div>
            ${field('auto_register_deny', '不自动接入的设备名', '<textarea class="inp" id="adm-set-auto_register_deny" rows="5" spellcheck="false" placeholder="每行一个正则，不分大小写"></textarea>', '正则写错整个保存会被拒')}</section>
          <section class="panel"><div class="ph"><h2>显示与图谱</h2></div>
            ${field('device_labels', '设备显示名', '<div class="adm-kv"><div class="rows" style="display:grid;gap:6px"></div><button class="btn add" type="button" data-add>添加一项</button></div><datalist id="adm-set-devs"></datalist>')}
            ${field('graph_entities', '图谱里要认的名字', '<div class="adm-tagrow"><span>机器</span><div class="adm-tags" data-t="machine"></div></div><div class="adm-tagrow"><span>现场</span><div class="adm-tags" data-t="site"></div></div>')}</section>
          <div class="adm-save" hidden><span class="msg"></span><button class="btn" type="button" data-act="revert">还原</button><button class="btn go" type="button" data-act="save">保存</button></div></div>`;
        for (const k of ['public_url', 'embed_url', 'stale_hours', 'auto_approve_days', 'digest_budget', 'auto_register_deny']) inputs[k] = el.querySelector(`#adm-set-${k}`);
        inputs.machine = tagInput(el.querySelector('[data-t=machine]'), '输入后回车', () => refresh());
        inputs.site = tagInput(el.querySelector('[data-t=site]'), '输入后回车', () => refresh());
        const kv = el.querySelector('.adm-kv .rows');
        el.addEventListener('input', () => refresh());
        el.addEventListener('click', (e) => {
          if (e.target.closest('[data-add]')) { kv.insertAdjacentHTML('beforeend', labelRow()); kv.lastElementChild.querySelector('input').focus(); refresh(); }
          const del = e.target.closest('[data-del]'); if (del) { del.closest('.r').remove(); refresh(); }
          const a = e.target.closest('[data-act]');
          if (a?.dataset.act === 'revert') { load(); }
          if (a?.dataset.act === 'save') save(a);
        });
        // 切页和关页时提醒
        document.addEventListener('click', async (e) => {
          if (!Console.visible('settings') || !dirty() || saving) return;
          const a = e.target.closest('.nav a, .top a, .brand');
          if (!a) return;
          e.preventDefault(); e.stopPropagation();
          const ok = await confirmBox({ title: '有未保存的修改', html: '<p>离开后这些修改会丢掉。</p>', ok: '离开', danger: true });
          if (!ok) return;
          await load();
          const href = a.getAttribute('href') || '';
          if (href.startsWith('#')) location.hash = href; else location.href = href;
        }, true);
        addEventListener('beforeunload', (e) => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } });
      },
      async show() {
        const sel = root.querySelectorAll('.adm-set-def');
        try {
          if (!orig || !dirty()) await load();
          sel.forEach((n) => { n.textContent = defaults[n.dataset.def] ?? ''; });
          const dl = root.querySelector('#adm-set-devs');
          if (dl && !dl.childElementCount) api(`${A}devices`).then((r) => { dl.innerHTML = (r.devices || []).filter((d) => d.role === 'device').map((d) => `<option value="${h(d.name)}"></option>`).join(''); }).catch(() => {});
        } catch (e) { root.querySelector('.adm-form').insertAdjacentHTML('afterbegin', `<div class="empty">${h(e.message)}</div>`); }
      },
    });
  })();
})();
