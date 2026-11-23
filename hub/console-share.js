/* 只读分享链接：项目页（交接包旁）的"分享"弹窗。
 * 选时间线或交接包、选有效期（1/7/30 天）→ 生成 → 显示完整链接和复制按钮（完整链接只在这一次显示）；
 * 同一处列出这个项目还有效的链接，可以作废。样式在 console-share.css，类名都带 sh- 前缀。
 * 对外只有一个入口：Console.share.open(项目名)。
 */
(function () {
  'use strict';
  const { esc, dev, date } = Console;
  const KIND = { timeline: '时间线', handoff: '交接包' };
  const DAYS = [1, 7, 30];
  const expText = (iso) => `${date.localDay(Date.parse(iso)).slice(5)} ${date.hm(iso)} 到期`;

  // 复制：http 打开的控制台没有 navigator.clipboard，退回选中 + execCommand；两条路都不通就返回 false
  async function copyText(text, input) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* 不是安全上下文或没授权 */ }
    input.focus(); input.select();
    try { return document.execCommand('copy'); } catch { return false; }
  }

  function open(project) {
    if (!project) return;
    const st = { kind: 'timeline', days: 7 };
    const wrap = document.createElement('div');
    wrap.className = 'mem-modal';
    wrap.innerHTML = `<div class="mem-dlg sh-dlg" role="dialog" aria-modal="true"><h3>分享 · <span class="sh-proj">${esc(project)}</span></h3>`
      + `<div class="sh-row" data-g="kind">${Object.entries(KIND).map(([k, l]) => `<button type="button" data-v="${k}" class="${k === st.kind ? 'on' : ''}">${l}</button>`).join('')}</div>`
      + `<div class="sh-row" data-g="days">${DAYS.map((d) => `<button type="button" data-v="${d}" class="${d === st.days ? 'on' : ''}">${d} 天</button>`).join('')}</div>`
      + '<div class="sh-act"><button class="btn" data-gen>生成链接</button></div>'
      + '<div class="sh-out" hidden><input class="inp" readonly aria-label="分享链接"><button class="btn" data-copy>复制</button></div>'
      + '<div class="sh-note" hidden>关闭后不再显示完整链接</div>'
      + '<div class="sh-list"></div>'
      + '<div class="mem-dact"><button class="btn" data-x>关闭</button></div></div>';
    document.body.appendChild(wrap);
    const q = (s) => wrap.querySelector(s);
    const out = q('.sh-out'); const link = q('.sh-out input'); const copy = q('[data-copy]'); const gen = q('[data-gen]'); const list = q('.sh-list');

    const done = () => { document.removeEventListener('keydown', key, true); wrap.remove(); };
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(); } };
    document.addEventListener('keydown', key, true);
    wrap.onclick = (e) => { if (e.target === wrap) done(); };
    q('[data-x]').onclick = done;

    wrap.querySelectorAll('.sh-row').forEach((row) => {
      row.onclick = (e) => {
        const b = e.target.closest('button[data-v]');
        if (!b) return;
        st[row.dataset.g] = row.dataset.g === 'days' ? Number(b.dataset.v) : b.dataset.v;
        row.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      };
    });

    async function refresh() {
      let r;
      try { r = await Console.api('/console/api/shares', { query: { project } }); } catch (e) { Console.toast(e.message, 'err'); return; }
      const live = r.shares.filter((s) => s.status === 'active');
      list.innerHTML = live.length ? `<h4>有效的链接 ${live.length}</h4>${live.map((s) => `<div class="sh-it"><span class="k">${esc(KIND[s.kind] || s.kind)}</span><span class="e">${esc(expText(s.expires))}</span><span class="c">${esc(dev(s.creator))}</span><button class="btn warn" data-id="${esc(s.id)}">作废</button></div>`).join('')}` : '';
      list.querySelectorAll('button[data-id]').forEach((b) => {
        b.onclick = async () => {
          b.disabled = true;
          try { await Console.api('/console/api/shares/revoke', { body: { id: b.dataset.id } }); } catch (e) { Console.toast(e.message, 'err'); }
          refresh();
        };
      });
    }

    gen.onclick = async () => {
      gen.disabled = true;
      try {
        const r = await Console.api('/console/api/shares', { body: { project, kind: st.kind, days: st.days } });
        link.value = r.url;
        out.hidden = false; q('.sh-note').hidden = false;
        copy.textContent = '复制';
      } catch (e) { Console.toast(e.message, 'err'); }
      gen.disabled = false;
      refresh();
    };
    link.onclick = () => link.select();
    copy.onclick = async () => {
      if (!await copyText(link.value, link)) { Console.toast('没复制上，链接已选中，请手动复制', 'err'); return; }
      copy.textContent = '已复制'; setTimeout(() => { copy.textContent = '复制'; }, 1500);
    };

    gen.focus();
    refresh();
  }

  Console.share = { open };
})();
