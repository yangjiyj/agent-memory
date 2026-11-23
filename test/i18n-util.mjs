// 测试辅助（不是测试文件）：在 node:vm 里加载引擎和词典，不需要浏览器。
//   loadI18n({ lang: 'en' | 'zh', files: ['console-i18n.js', …], store: { 'am.lang': 'en' }, navigator: 'en-US', sandbox: {…} }) → sandbox（sandbox.AMI18n 就是引擎）
// 词典文件默认是 console-i18n-ui.js 和 console-i18n-srv.js；传 files 可以只加载引擎。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

export const HUB = path.resolve(import.meta.dirname, '../hub');
export const ENGINE = 'console-i18n.js';
export const DICTS = ['console-i18n-ui.js', 'console-i18n-srv.js'];

export function loadI18n({ lang, files = [ENGINE, ...DICTS], store, navigator = 'en-US', sandbox = {} } = {}) {
  const data = { ...(store || {}) };
  if (lang && !store) data['am.lang'] = lang;
  const sb = {
    console,
    localStorage: { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); } },
    navigator: { language: navigator },
    ...sandbox,
  };
  sb.window = sb;
  vm.createContext(sb);
  for (const f of files) {
    if (!fs.existsSync(path.join(HUB, f))) continue; // 词典文件还没写出来时只加载已有的
    vm.runInContext(fs.readFileSync(path.join(HUB, f), 'utf8'), sb, { filename: f });
  }
  return sb;
}

// 一个很小的假 DOM，够引擎的 apply() 用：文本节点、元素、属性、父子关系
export function fakeDom() {
  const mk = (type, props) => Object.assign({ nodeType: type, childNodes: [], parentNode: null }, props);
  class El {
    constructor(tag) { this.nodeType = 1; this.tagName = tag.toUpperCase(); this.childNodes = []; this.parentNode = null; this.attrs = {}; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    hasAttribute(k) { return k in this.attrs; }
    append(...kids) { for (const k of kids) { const n = typeof k === 'string' ? text(k) : k; n.parentNode = this; this.childNodes.push(n); } return this; }
  }
  const text = (s) => mk(3, { nodeValue: s });
  const el = (tag, attrs = {}, ...kids) => { const e = new El(tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e.append(...kids); };
  const dump = (n) => (n.nodeType === 3 ? n.nodeValue : `<${n.tagName.toLowerCase()}${Object.entries(n.attrs).map(([k, v]) => ` ${k}="${v}"`).join('')}>${n.childNodes.map(dump).join('')}</${n.tagName.toLowerCase()}>`);
  return { el, text, dump };
}
