/* 接入类页面：智能体（每台机器上每个智能体的状态矩阵）、审计（谁查了、写了什么）。 */
(function () {
  const { esc, dev, tool, date } = Console;
  const ago = date.ago;

  // ======================================================================
  // 智能体
  // ======================================================================
  (function agents() {
    let root = null;
    function render(d) {
      const tools = Console.toolOrder.filter((t) => d.devices.some((x) => x.wiring[t] || x.cells[t]));
      const rows = d.devices.slice().sort((a, b) => (a.legacy ? 1 : 0) - (b.legacy ? 1 : 0) || (dev(a.name) !== a.name ? 0 : 1) - (dev(b.name) !== b.name ? 0 : 1) || a.name.localeCompare(b.name));
      const pillMcp = (m) => (m === 'on' ? '<span class="pill ok">✓ 插件</span>' : m === 'off' ? '<span class="pill warn">⏸ 插件停用</span>' : m === 'none' ? '<span class="pill bad">✕ 没插件</span>' : '');
      const pillNotes = (n) => (n === 'rules' ? '<span class="pill ok">✓ 用法说明</span>' : n === 'digest' ? '<span class="pill ok">✓ 摘要</span>' : n === 'missing' ? '<span class="pill bad">✕ 说明</span>' : '');
      const head = `<tr><th>机器</th>${tools.map((t) => `<th>${esc(tool(t))}</th>`).join('')}<th>命令行</th></tr>`;
      const body = rows.map((x) => {
        const sAge = x.last_seen ? (Date.now() - Date.parse(x.last_seen)) / 60000 : null;
        const sync = x.legacy ? '<span class="pill dim">旧机器，只有历史对话</span>'
          : (sAge !== null && sAge < 15 ? `<span class="pill ok">● ${esc(ago(x.last_seen))}同步</span>` : `<span class="pill bad">● ${x.last_seen ? `${esc(ago(x.last_seen))}同步` : '没同步过'}</span>`);
        const tds = tools.map((t) => {
          const w = x.wiring[t]; const c = x.cells[t];
          if (!w && !c) return '<td><div class="c na">—</div></td>';
          const live = c && c.lastMsg && Date.now() - Date.parse(c.lastMsg) < 20 * 60000;
          const pills = w ? pillMcp(w.mcp) + pillNotes(w.notes) + (w.memory ? '<span class="pill ok">✓ 记忆同步</span>' : '') : '';
          const nums = c ? `记忆 <em>${c.memories}</em> · 对话 <em>${c.sessions}</em> · 查询 <em>${c.calls}</em>` : '';
          const last = (c && c.lastMsg ? `最近对话 ${esc(ago(c.lastMsg))}` : '') + (c && c.lastCall ? ` · 上次查 ${esc(ago(c.lastCall))}` : '');
          return `<td><div class="c ${live ? 'now' : ''}">${pills}<div class="n">${nums}</div><div class="n">${last}</div></div></td>`;
        }).join('');
        const cli = x.cells.cli;
        return `<tr><td class="dev"><b>${esc(dev(x.name))}</b><small>${esc(x.name)}${x.version ? ` · ${esc(x.version)}` : ''}</small><div>${sync}</div></td>${tds}`
          + `<td><div class="c ${cli ? '' : 'na'}">${cli ? `查询 <em>${cli.calls}</em>${cli.writes ? ` · 写 ${cli.writes}` : ''}` : '—'}</div></td></tr>`;
      }).join('');
      root.querySelector('#agents').innerHTML = `<table>${head}${body}</table>`;
    }
    async function load() { try { render(await Console.api('/browse/viz-agents', { ttl: 20000 })); } catch (e) { console.warn(e); } }
    Console.page('agents', {
      mount(el) {
        root = el;
        root.innerHTML = '<section class="panel"><div class="ph"><h2>智能体状态</h2></div><div class="agrid" id="agents"><div class="empty">读取中…</div></div></section>';
        Console.every('agents', 60000, load);
      },
      show() { load(); },
    });
  })();

  // ======================================================================
  // 审计
  // ======================================================================
  (function audit() {
    let root = null;
    const OPZ = { memory_search: '搜记忆', memory_get: '读记忆', memory_remember: '写记忆', memory_update: '改记忆', memory_retire: '作废', memory_recent: '最近记忆', memory_digest: '读摘要', memory_timeline: '时间线', conversation_search: '搜原话', conversation_get: '读原文', memory_handoff: '交接包', memory_todos: '待办', memory_entities: '图谱', search: '搜记忆', get: '读记忆', remember: '写记忆', timeline: '时间线', handoff: '交接包', todos: '待办', entities: '图谱', browse: '打开浏览页', viz: '打开大屏', console: '打开控制台', wall: '打开大屏', wrapped: '打开年报', 'console:device-set': '改设备策略', 'console:join-code': '生成加入码', 'console:mcp-tool': '开关工具', 'console:settings': '改设置', 'manage:edit': '编辑记忆', 'manage:retire': '作废记忆', 'manage:merge': '合并重复', 'manage:approve': '保留候选', 'manage:reject': '不要候选', 'manage:reopen': '恢复记忆' };
    const who = (c) => (c === 'cli' ? '命令行' : c === 'browser' ? '浏览器' : tool(c));
    async function load() {
      let a;
      try { a = await Console.api('/browse/audit', { query: { days: 7 } }); } catch (e) { console.warn(e); return; }
      root.querySelector('#auHint').textContent = `最近 7 天 ${a.total} 次调用${a.rejections.length ? ` · 拒收疑似密钥 ${a.rejections.length} 次` : ''}`;
      const pol = Object.entries(a.policies).filter(([, v]) => v.readonly || v.hide.length);
      const fmtT = (iso) => new Date(Date.parse(iso) + 8 * 3600e3).toISOString().slice(5, 16).replace('T', ' ');
      root.querySelector('#audit').innerHTML = `<div><table><tr><th>机器 · 来源</th><th>调用</th><th>写入</th><th>最近</th></tr>${
        a.byClient.map(([k, v]) => { const ab = k.split('/'); return `<tr><td>${esc(dev(ab[0]))} · ${esc(who(ab[1]))}</td><td>${v.calls}</td><td>${v.writes}</td><td>${esc(ago(v.last))}</td></tr>`; }).join('')}</table>`
        + `<div class="chips" style="margin-top:10px">${a.ops.map(([k, n]) => `<button>${esc(OPZ[k] || k)} ${n}</button>`).join('')}</div>`
        + (pol.length ? `<div class="hint">权限：${pol.map(([k, v]) => esc(dev(k)) + (v.readonly ? ' 只读' : '') + (v.hide.length ? ` 看不到 ${esc(v.hide.join('、'))}` : '')).join('；')}</div>` : '<div class="hint">所有机器都能读写全部记忆</div>')
        + `</div><div class="ev scroll">${a.events.slice(0, 150).map((u) => { const op = u.op.replace(/^(tool|cli):/, ''); return `<div><i>${esc(fmtT(u.t))}</i><span>${esc(dev(u.device))} · ${esc(who(u.client))}</span><span>${esc(OPZ[op] || op)}</span><span>${esc(u.d || '')}</span></div>`; }).join('')}</div>`;
    }
    Console.page('audit', {
      mount(el) {
        root = el;
        root.innerHTML = '<section class="panel"><div class="ph"><h2>审计</h2><span class="hint" id="auHint"></span></div><div class="au" id="audit"><div class="empty">读取中…</div></div></section>';
        Console.every('audit', 120000, load);
      },
      show() { load(); },
    });
  })();
})();
