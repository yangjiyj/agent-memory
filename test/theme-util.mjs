// H 组（主题）测试共用：读 hub/ 下的样式和脚本、取出令牌块、算对比度。不依赖浏览器。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hub');
export const read = (f) => fs.readFileSync(path.join(HUB, f), 'utf8');
export const CSS_FILES = fs.readdirSync(HUB).filter((f) => /^console[\w-]*\.css$/.test(f)).sort();
export const JS_FILES = fs.readdirSync(HUB).filter((f) => /^console[\w-]*\.js$/.test(f)).sort();
export const stripCssComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
// 脚本去掉注释（行注释只认前面是空白或行首的，避免误伤字符串里的 http://）
export const stripJsComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[\s;{}(),])\/\/[^\n]*/g, '$1');

// 令牌块：深色 = 所有 `:root {…}`，浅色 = `:root[data-theme="light"] {…}`。返回 Map<名字, 值>
export function tokenBlocks() {
  const dark = new Map(); const light = new Map();
  for (const f of CSS_FILES) {
    const css = stripCssComments(read(f));
    for (const m of css.matchAll(/:root(\[data-theme="light"\])?\s*\{([^}]*)\}/g)) {
      const into = m[1] ? light : dark;
      for (const d of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) into.set(d[1], d[2].trim());
    }
  }
  return { dark, light };
}
// 去掉令牌块后的样式文本（检查"不再写死颜色"用）
export const cssWithoutTokenBlocks = (f) => stripCssComments(read(f)).replace(/:root(\[data-theme="light"\])?\s*\{[^}]*\}/g, '');

// ---------------- 颜色和对比度 ----------------
export const hex = (h) => { h = h.replace('#', ''); if (h.length === 3) h = [...h].map((c) => c + c).join(''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
export const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export const ratio = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
export const over = (fg, a, bg) => fg.slice(0, 3).map((c, i) => c * a + bg[i] * (1 - a));
// 令牌值 → [r, g, b, a]：支持 #十六进制、"r, g, b"、rgba(r, g, b, a)
export function color(v) {
  v = String(v).trim();
  if (v.startsWith('#')) return [...hex(v), 1];
  let m = /^rgba?\(([^)]+)\)$/.exec(v);
  if (m) { const p = m[1].split(',').map(parseFloat); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
  m = /^(\d+)\s*,\s*(\d+)\s*,\s*(\d+)$/.exec(v);
  if (m) return [+m[1], +m[2], +m[3], 1];
  throw new Error(`认不出的颜色：${v}`);
}
