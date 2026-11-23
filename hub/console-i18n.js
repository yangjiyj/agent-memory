/*
 * agent-memory 控制台界面语言引擎（中 / English）。要最先加载（console.html 里在 console-core.js 之前），
 * 不依赖 Console，大屏、审批页、年报这类独立页面也直接引用它。
 *
 * ── 怎么用 ─────────────────────────────────────────────────────────────────
 *   window.AMI18n = { lang, locale, t, add, rule, pat, apply, setLang, pl, wd, nav, addNav, missed }
 *   · lang        'zh' | 'en'。存在 localStorage 的 am.lang；没存过就看 navigator.language：以 zh 开头用中文，否则英文。
 *   · t(zh)       翻译一句中文。精确词典 → 规则 → 按 " · "、"；"、"，"、"、" 拆开逐段翻 → 原样返回。zh 下直接返回原串。
 *   · add({中文: English, …})
 *                 精确词典；键两端的空白会被忽略，译文自带的首尾空格会保留（"条" → " items"，用来接在 <b>数字</b> 后面）。
 *                 键也可以写成 "标签|中文" 或 "标签.类名|中文"（如 'h2|设备'）：同一个汉字在不同位置译法不同时用，按文本节点的父元素找，找不到再用普通词条。
 *   · rule(正则, 模板或函数[, guarded])
 *                 带数字、名字、日期的句式。正则要写成整句锚定（^…$），不要写吞一切的 (.+)。
 *                 模板：$1…$9 原样插入第 n 个捕获；$t1 把第 n 个捕获再翻译一遍（$l1 再翻译并把首字母变小写，用在句中）；$w1 把"一二三…"变成 Mon Tue…；
 *                 {1|memory|memories} 按第 1 个捕获的数字取单数或复数。函数：(match, t) => string。
 *   · pat(中文句式, 模板)
 *                 rule 的简写，句式里 {n} 是数字（可带逗号和小数点）、{w} 是星期汉字（日一二三四五六）、{*} 是任意一段、{t} 是必须能翻成不带汉字的一段（系统给的词、时间、日期；翻不动的是用户数据，这条规则就放弃），其余字符照字面匹配。
 *                 句式里必须有汉字（保证不会吞用户数据）。模板同上。
 *   · addNav({页面 id: 英文名}) / nav(id, 中文名)  侧栏和顶栏的页面名（同一个汉字在表头里是单数、页面名是复数，所以单独一张表）。
 *   · apply(root) 立刻翻译 root 下面所有文本节点和 title/placeholder/aria-label/alt（按钮的 value）。
 *   · setLang(l)  存下语言并整页刷新（路由 hash 保留）。顶栏的 "中 / EN" 按钮调用它。
 *   · missed()    英文下翻译不了、仍带汉字的串（开发和扫描用，包含用户数据）。
 *   · 画布文字：英文下 CanvasRenderingContext2D 的 fillText / strokeText / measureText 会先过 t()；alert / confirm / prompt 同理。
 *   · 顺序：精确词典 → 句首句尾的 "·" → 按 " · "、"；"、"，"、"、" 拆开逐段翻 → 规则（先登记的先试，宽的放最后）；超过 600 字的长文（用户数据）不翻。
 *   zh 下什么都不做：不建词典、不监听 DOM；只设好顶栏的语言按钮。
 *   en 下用 MutationObserver 盯着整个文档，新增和改动的文本节点、属性随时翻译；
 *   script / style / textarea 里的、带 data-i18n-skip 的元素里的不动；翻译过的节点不会再翻（也不会死循环）。
 *
 * ── 术语表（zh → en，两个词典文件都照这个；括号里是地方窄时的短写）──────────────────────
 *   记忆 memory · 记忆库 Library · 待整理 Triage · 待审候选 Proposed（状态名，和内部的 proposed 一致）· 疑似重复 possible duplicates · 过期现状 stale status
 *   知识图谱 Knowledge graph · 摘要 Digest · 时间线 Timeline · 项目 project · 待办 Todos · 对话存档 Conversations（页面名）/ conversation archive（拓扑节点里 Archive）
 *   工作日志 work journal（节点里 Journals）· 拓扑 Topology · 设备 device · 设备端 device client · 智能体 agent · 接入 Connect · 系统 System
 *   审计 Audit · 任务 Jobs · 设置 Settings · 概览 Overview · 大屏 Wall · 年度报告 Wrapped
 *   作废 retire · 取代 supersede · 合并 merge · 保留 keep · 不要 discard · 置顶 pin · 排除 exclude
 *   加入码 join code · 令牌 token · 网关 gateway · 认证网关 Gateway（节点里放不下 Auth gateway）· 中心 hub · 抽取 extract · 抽取机 extractor
 *   向量服务 vector service · 按意思搜 semantic search · 关键词 keyword · 巡检 health check · 交接包 handoff pack · 记忆仓库 repository（节点里 Repo）
 *   分享链接 share link · 同步 sync · 只读 read-only · 读写 read-write · 隐藏项目 hidden projects · 会话 session · 会话段 session segment
 *   回放 replay · 作战室 war room · 星系 galaxy · 工具 tool · 出处 source · 差异 diff · 版本 version · 候选 candidate
 */
(function () {
  const G = typeof window !== 'undefined' ? window : globalThis;
  if (G.AMI18n) return;
  const CJK = new RegExp('[\\u3400-\\u9fff\\uff00-\\uffef\\u3000-\\u303f]'); // 汉字、全角标点、中文标点
  const KEY = 'am.lang';
  const SKIP_TAGS = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, NOSCRIPT: 1 };
  const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const WDZH = '日一二三四五六';

  function detect() {
    let v = null;
    try { v = G.localStorage && G.localStorage.getItem(KEY); } catch { /* 隐私模式读不到 */ }
    if (v === 'zh' || v === 'en') return v;
    const nav = String((typeof navigator !== 'undefined' && (navigator.language || (navigator.languages || [])[0])) || '').toLowerCase();
    return nav.startsWith('zh') ? 'zh' : 'en';
  }
  const lang = detect();
  const EN = lang === 'en';

  const I = { lang, locale: EN ? 'en-US' : 'zh-CN', WD };
  G.AMI18n = I;

  // ---------------- 语言按钮（zh / en 都要有）----------------
  I.setLang = function setLang(l) {
    try { G.localStorage.setItem(KEY, l === 'en' ? 'en' : 'zh'); } catch { /* 存不了就算了，刷新后仍按浏览器语言 */ }
    if (G.location) G.location.reload();
  };
  // 顶栏的语言按钮：控制台的 .top（链接样式）、大屏的 header .hbar（按钮样式）；没有这两个容器的页面（年报、审批页）不放
  function injectSwitch() {
    const d = G.document;
    if (!d || !d.querySelector) return false;
    const top = d.querySelector('.top');
    const hbar = top ? null : d.querySelector('header .hbar');
    const host = top || hbar;
    if (!host || host.querySelector('.am-lang')) return !!host;
    const st = d.createElement('style');
    st.textContent = '.am-lang { white-space: nowrap; cursor: pointer; } .am-lang b { font-weight: 400; opacity: .55; } .am-lang b.on { font-weight: 700; opacity: 1; }' + (top ? ' .top .am-lang b.on { color: var(--text-primary); } @media (max-width: 480px) { .top { gap: 6px; padding-left: 10px; padding-right: 10px; } .top a.lk { padding: 5px 9px; font-size: 12px; white-space: nowrap; } .top h1 { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } }' : '');
    d.head.appendChild(st);
    const a = d.createElement(top ? 'a' : 'button');
    if (top) { a.className = 'lk am-lang'; a.href = '#'; a.setAttribute('role', 'button'); } else { a.className = 'play am-lang'; a.type = 'button'; }
    a.setAttribute('data-i18n-skip', '');
    a.title = EN ? 'Language' : '界面语言'; a.setAttribute('aria-label', a.title);
    a.innerHTML = `<b${EN ? '' : ' class="on"'}>中</b> / <b${EN ? ' class="on"' : ''}>EN</b>`;
    a.addEventListener('click', (e) => { e.preventDefault(); I.setLang(EN ? 'zh' : 'en'); });
    host.insertBefore(a, (top ? top.querySelector('a.lk') : hbar.querySelector('#cruise')) || null);
    return true;
  }
  if (G.document) {
    if (EN) G.document.documentElement.lang = 'en';
    if (!injectSwitch() && G.document.addEventListener) G.document.addEventListener('DOMContentLoaded', injectSwitch);
  }

  // ---------------- zh：到此为止 ----------------
  if (!EN) {
    const noop = () => {};
    Object.assign(I, { t: (s) => s, add: noop, rule: noop, pat: noop, apply: noop, addNav: noop, nav: (id, zh) => zh, pl: (n, a, b) => (Number(n) === 1 ? a : b), wd: (c) => c, missed: () => [] });
    return;
  }

  // ---------------- en：词典、规则、翻译 ----------------
  const dict = new Map();
  const rules = [];
  const dupes = []; // 同一个键被不同（或相同）的译文加过两次：测试里断言为空
  const bad = []; // 登记时发现的写法问题：测试里断言为空
  const misses = new Set();
  const memo = new Map();

  let gen = 0; // 词典每变一次加一：之前翻不动的节点下次碰到会再试
  let hasCtx = false; // 词典里有没有 "标签|中文" 这种带上下文的键
  I.add = function add(obj) {
    gen++;
    for (const k of Object.keys(obj)) {
      const key = k.replace(/\s+/g, ' ').trim();
      if (!CJK.test(key)) bad.push(`词典键里没有汉字：${k}`);
      if (/^[a-z0-9.-]+\|/.test(key)) hasCtx = true;
      if (dict.has(key)) dupes.push(key);
      dict.set(key, obj[k]);
    }
    memo.clear();
  };
  I.rule = function rule(re, out, guarded) { // guarded：正则里没有汉字，由函数自己保证翻不动就返回 null
    gen++;
    if (Object.prototype.toString.call(re) !== '[object RegExp]') { bad.push(`rule 的第一个参数必须是正则：${re}`); return; }
    if (!re.source.startsWith('^') || !re.source.endsWith('$')) bad.push(`rule 要整句锚定（^…$）：${re.source}`);
    if (!guarded && !CJK.test(re.source)) bad.push(`rule 里没有汉字，会吞用户数据：${re.source}`);
    rules.push({ re, out });
    memo.clear();
  };
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  I.pat = function pat(zh, out) {
    let g = 0; const sys = []; // sys：{t} 捕获的组号——必须能翻成不带汉字的才算（系统给的词、日期），翻不动说明是用户数据，这条规则就不要
    const src = zh.replace(/\s+/g, ' ').trim().split(/(\{n\}|\{w\}|\{\*\}|\{t\})/).map((p) => {
      if (p === '{n}') { g++; return '(-?\\d[\\d,.]*)'; }
      if (p === '{w}') { g++; return `([${WDZH}])`; }
      if (p === '{*}') { g++; return '(.+?)'; }
      if (p === '{t}') { g++; sys.push(g); return '(.+?)'; }
      return esc(p);
    }).join('');
    const re = new RegExp(`^${src}$`);
    if (!sys.length) { I.rule(re, out); return; }
    I.rule(re, (m, t) => (sys.some((i) => CJK.test(t(m[i]))) ? null : fill(out, m, t)));
  };
  I.pl = (n, one, many) => (Number(String(n).replace(/,/g, '')) === 1 ? one : many);
  I.wd = (c) => { const i = WDZH.indexOf(c); return i < 0 ? c : WD[i]; };
  const navs = {};
  I.addNav = (obj) => Object.assign(navs, obj); // 侧栏和顶栏的页面名（同一个汉字在表头里是单数，页面名是复数）
  I.nav = (id, zh) => navs[id] || tr(zh);
  I.missed = () => [...misses];
  I._dupes = dupes; I._bad = bad; I._size = () => ({ dict: dict.size, rules: rules.length });

  const lc = (s) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s); // 句中引用：Today → today，MCP 这类缩写不动
  const fill = (out, m, tr) => {
    if (typeof out === 'function') return out(m, tr);
    return out
      .replace(/\{(\d)\|([^|}]*)\|([^}]*)\}/g, (_, i, a, b) => I.pl(m[+i], a, b))
      .replace(/\$([twl]?)(\d)/g, (_, k, i) => { const v = m[+i] ?? ''; return k === 't' ? tr(v) : k === 'w' ? I.wd(v) : k === 'l' ? lc(tr(v)) : v; });
  };
  // 拆分用的分隔符：前两个（" · "、"；"）拆开后翻得动的段翻、翻不动的段当成用户数据原样留着（至少要有一段翻得动）；
  // 后两个（"，"、"、"）出现在句子里，必须每段都翻得动才算。
  // " · " 前后的空格不一定齐："）· "、" ·「" 也算分隔。
  const JOIN = [[/ · |(?<=[）)])· | ·(?=[「（(])/, ' · ', true], ['；', '; ', true], ['，', ', ', false], ['、', ', ', false]];

  // 顺序：精确词典 → 开头的 "· " → 用 " · "、"；"、"，"、"、" 拆开、每段都翻得动才算 → 规则。
  // 拆分放在规则前面：整句规则里的 {*} 会把带分隔符的一长串吞进去，拆开逐段翻更准。
  function lookup(core, ctx) {
    if (ctx) { // 同一个汉字在不同位置译法不同：先找 "标签.类名|中文"，再找 "标签|中文"
      const c1 = dict.get(`${ctx}|${core}`);
      if (c1 !== undefined) return c1;
      const c2 = dict.get(`${ctx.split('.')[0]}|${core}`);
      if (c2 !== undefined) return c2;
    }
    const hit = dict.get(core);
    if (hit !== undefined) return hit;
    if (core.length > 600) return null; // 长文是用户数据（对话、记忆正文），不值得逐段试
    const edge = /^(·\s+)?([\s\S]*?)(\s+·)?$/.exec(core); // 开头或结尾挂着的 "·"（它后面或前面是别的元素）
    if (edge[1] || edge[3]) { const r = lookupTrim(edge[2]); if (r !== null) return `${edge[1] || ''}${r}${edge[3] || ''}`; }
    for (const [sep, to, partial] of JOIN) {
      const src = core.split(sep);
      if (src.length < 2 || src.filter((p) => CJK.test(p)).length > 8) continue; // 带汉字的段太多是长文（用户数据），不值得逐段试
      const out = src.map(lookupTrim);
      if (partial ? out.some((r, i) => r !== null && r !== src[i]) : out.every((r) => r !== null)) return out.map((r, i) => r ?? src[i]).join(to);
    }
    for (const r of rules) {
      const m = r.re.exec(core);
      if (!m) continue;
      const v = fill(r.out, m, tr);
      if (v != null) return v; // 函数规则返回 null/undefined = 这句不归我，接着试下一条
    }
    return null;
  }
  // 拆开的各段：整段没有汉字就原样，有汉字必须翻得动
  function lookupTrim(p) {
    if (!CJK.test(p)) return p;
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(p);
    const r = lookup(m[2].replace(/\s+/g, ' '));
    return r === null ? null : m[1] + r + m[3];
  }
  function tr(s, ctx) {
    if (typeof s !== 'string' || !CJK.test(s)) return s;
    const mk = ctx ? `${ctx}\u0001${s}` : s;
    const cached = memo.get(mk);
    if (cached !== undefined) return cached;
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
    const r = lookup(m[2].replace(/\s+/g, ' '), ctx);
    let out = s;
    if (r !== null) out = m[1] + r + m[3];
    if (CJK.test(out) && misses.size < 800) misses.add(s);
    if (memo.size > 6000) memo.clear();
    memo.set(mk, out);
    return out;
  }
  I.t = tr;

  // ---------------- DOM ----------------
  const done = new WeakMap(); // 文本节点 → { out: 翻译结果, gen: 词典版本 }
  // attrOnly：只看 data-i18n-skip（textarea 里的文字是用户输入不翻，但它的 placeholder 要翻）
  const skipped = (node, attrOnly) => {
    for (let n = node; n; n = n.parentNode) {
      if (n.nodeType !== 1) continue;
      if ((!attrOnly && SKIP_TAGS[n.tagName]) || (n.hasAttribute && n.hasAttribute('data-i18n-skip'))) return true;
    }
    return false;
  };
  // 文本节点所在元素的 "标签.第一个类名"
  const ctxOf = (el) => { if (!el || el.nodeType !== 1) return null; const c = String((el.getAttribute && el.getAttribute('class')) || '').split(/\s+/)[0]; return `${el.tagName.toLowerCase()}.${c}`; };
  function text(node) {
    const v = node.nodeValue;
    if (!v || !CJK.test(v)) return;
    const d = done.get(node);
    if (d && d.out === v && d.gen === gen) return; // 翻译过的结果、或者翻不动的原文：不重复翻，也不会引起死循环
    const out = tr(v, hasCtx ? ctxOf(node.parentNode) : null);
    done.set(node, { out, gen });
    if (out !== v) node.nodeValue = out;
  }
  function attr(el, name) {
    const v = el.getAttribute(name);
    if (!v || !CJK.test(v)) return;
    const out = tr(v);
    if (out !== v) el.setAttribute(name, out);
  }
  function attrs(el) {
    for (const a of ATTRS) attr(el, a);
    if (el.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(el.getAttribute('type') || '')) attr(el, 'value');
  }
  function walk(root) {
    const stack = [root];
    while (stack.length) {
      const n = stack.pop();
      if (n.nodeType === 3) { text(n); continue; }
      if (n.nodeType !== 1 && n.nodeType !== 9 && n.nodeType !== 11) continue;
      if (n.nodeType === 1) {
        if (n.hasAttribute('data-i18n-skip')) continue;
        attrs(n);
        if (SKIP_TAGS[n.tagName]) continue; // textarea 等：属性翻、里面的文字不翻
      }
      const kids = n.childNodes;
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
  }
  I.apply = function apply(root) {
    if (!root) return;
    if (root.nodeType === 3) { if (!skipped(root)) text(root); return; }
    if (root.nodeType === 1 && skipped(root.parentNode)) return;
    walk(root);
  };

  // ---------------- 全局 alert / confirm / prompt ----------------
  for (const k of ['alert', 'confirm', 'prompt']) {
    const f = G[k];
    if (typeof f === 'function') G[k] = function dialog(msg, ...rest) { return f.call(G, tr(String(msg ?? '')), ...rest); };
  }

  // ---------------- 画布文字（fillText 不在 DOM 里）----------------
  const C2D = G.CanvasRenderingContext2D;
  if (C2D && C2D.prototype) {
    for (const k of ['fillText', 'strokeText', 'measureText']) {
      const f = C2D.prototype[k];
      if (typeof f === 'function') C2D.prototype[k] = function canvasText(t, ...rest) { return f.call(this, typeof t === 'string' ? tr(t) : t, ...rest); };
    }
  }

  // ---------------- 观察器 ----------------
  // 等所有脚本（含词典）执行完、DOMContentLoaded 时先把已有的 DOM 翻一遍，再开始盯后续变动
  const D = G.document;
  if (D && typeof G.MutationObserver === 'function') {
    const start = () => {
      I.apply(D.documentElement);
      const obs = new G.MutationObserver((recs) => {
        for (const r of recs) {
          if (r.type === 'childList') { for (const n of r.addedNodes) I.apply(n); } else if (r.type === 'characterData') {
            if (!skipped(r.target)) text(r.target);
          } else if (r.type === 'attributes') {
            const el = r.target;
            if (!skipped(el, true)) attrs(el);
          }
        }
        obs.takeRecords(); // 我们自己改文字产生的变动记录，丢掉
      });
      obs.observe(D.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...ATTRS, 'value'] });
    };
    if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', start); else start();
  }
})();
