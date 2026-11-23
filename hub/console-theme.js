/* 主题：浅色 / 深色 / 跟随系统。顶栏的切换按钮、记住选择、系统偏好变了自动跟着变。
 * console.html 的 <head> 里有一行内联脚本抢在样式表之前把 data-theme 设好（防闪烁），这里管之后的事：
 *   Console.theme.get()       当前的选择：'auto' | 'light' | 'dark'（存在本机 localStorage 的 am.theme，默认 auto）
 *   Console.theme.set(v)      改选择：立即生效、记住，并在 window 上发 am-theme 事件（detail: { theme: 实际生效的 'light'|'dark', choice }）
 *   Console.theme.resolved()  实际生效的 'light' | 'dark'（auto 时看系统的 prefers-color-scheme）
 * 嵌入模式（?embed=1，大屏里的拓扑）永远是深色：不理会选择、不显示按钮。
 * 页面里颜色是画图时才读的，换主题后当前页会被调 theme()（见 console-core.js）。 */
(function () {
  const KEY = 'am.theme';
  const MODES = ['auto', 'light', 'dark'];
  const TEXT = { auto: '跟随系统', light: '浅色', dark: '深色', head: '主题', now: '现为', next: '点一下改为' }; // 界面文案都在这里
  const ICON = {
    auto: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>',
    light: '<circle cx="12" cy="12" r="3.8"/><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6L18 18M18 6l-1.4 1.4M7.4 16.6L6 18"/>',
    dark: '<path d="M19.5 14.2A8 8 0 1 1 9.8 4.5a6.4 6.4 0 0 0 9.7 9.7z"/>',
  };
  const root = document.documentElement;
  const embed = Boolean(Console.embed);
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

  const read = () => { try { const v = localStorage.getItem(KEY); return MODES.includes(v) ? v : 'auto'; } catch { return 'auto'; } };
  let choice = read();
  const resolve = () => (embed ? 'dark' : choice === 'auto' ? (mq && mq.matches ? 'dark' : 'light') : choice);
  let sig = ''; // 上次画的状态（选择|实际），没变就不发事件
  let btn = null;

  function paint() {
    const r = resolve();
    root.dataset.theme = r;
    if (btn) {
      const next = MODES[(MODES.indexOf(choice) + 1) % MODES.length];
      const tip = `${TEXT.head}：${TEXT[choice]}${choice === 'auto' ? `（${TEXT.now}${TEXT[r]}）` : ''}，${TEXT.next}${TEXT[next]}`;
      btn.title = tip; btn.setAttribute('aria-label', tip);
      btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[choice]}</svg>`;
    }
    return r;
  }
  function apply(emit) {
    const r = paint();
    const next = `${choice}|${r}`;
    const changed = next !== sig;
    sig = next;
    if (emit && changed) window.dispatchEvent(new CustomEvent('am-theme', { detail: { theme: r, choice } }));
  }

  Console.theme = {
    get: () => choice,
    resolved: resolve,
    set(v) {
      if (!MODES.includes(v)) return;
      choice = v;
      try { localStorage.setItem(KEY, v); } catch { /* 存不了就只在这次页面里有效 */ }
      apply(true);
    },
  };

  // 顶栏的按钮：图标三态，点一下 跟随系统 → 浅色 → 深色 → 跟随系统
  const top = document.querySelector('.top');
  if (top && !embed) {
    btn = document.createElement('button');
    btn.type = 'button'; btn.id = 'theme'; btn.className = 'theme-btn';
    btn.onclick = () => Console.theme.set(MODES[(MODES.indexOf(choice) + 1) % MODES.length]);
    const sp = top.querySelector('.sp');
    if (sp) sp.after(btn); else top.appendChild(btn);
  }
  apply(false);

  if (!embed) {
    // 系统偏好变了：只有选的是"跟随系统"才跟着变
    const onSystem = () => { if (choice === 'auto') apply(true); };
    if (mq) { if (mq.addEventListener) mq.addEventListener('change', onSystem); else if (mq.addListener) mq.addListener(onSystem); }
    // 别的标签页改了选择：这边同步
    addEventListener('storage', (e) => { if (e.key === KEY || e.key === null) { const v = read(); if (v !== choice) { choice = v; apply(true); } } });
  }
})();
