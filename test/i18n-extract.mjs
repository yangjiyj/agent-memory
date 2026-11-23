// 测试辅助（不是测试文件）：不依赖解析器，从 JS 源码里抽出字符串字面量和模板字面量，
// 再把含 HTML 的字符串拆成"页面上真的会出现的文字片段"。词典覆盖检查（i18n-coverage.test.mjs）用它。
//
// extractJs(src) → [{ line, kind: 'str' | 'tpl', text, depth }]
//   · 注释和正则字面量里的内容不抽；
//   · 模板字面量里的 ${…} 用 \u0000 占位，${…} 里面的字符串/模板另外各抽一条。
// htmlRuns(text) → { texts: [文字片段], attrs: [title/placeholder/aria-label/alt 的值] }
//   · 不含 "<" 的字符串整条当作一个文字片段。

const KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'throw', 'else', 'do', 'yield', 'await', 'instanceof']);
const ESC = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };

export function extractJs(src) {
  const out = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  let depth = 0; // 在几层 ${…} 里面：0 = 顶层字符串，>0 = 嵌在别的模板的表达式里

  function readString(q) {
    const at = line;
    i++;
    let s = '';
    while (i < n && src[i] !== q) {
      const c = src[i];
      if (c === '\\') {
        const d = src[i + 1];
        if (d === 'u') {
          if (src[i + 2] === '{') { const e = src.indexOf('}', i); s += String.fromCodePoint(parseInt(src.slice(i + 3, e), 16)); i = e + 1; } else { s += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16)); i += 6; }
        } else if (d === 'x') { s += String.fromCharCode(parseInt(src.slice(i + 2, i + 4), 16)); i += 4; } else if (d === '\n') { line++; i += 2; } else { s += d in ESC ? ESC[d] : d; i += 2; }
      } else { if (c === '\n') line++; s += c; i++; }
    }
    i++;
    out.push({ line: at, kind: 'str', text: s, depth });
  }

  function readTemplate() {
    const at = line;
    i++;
    let s = '';
    while (i < n && src[i] !== '`') {
      const c = src[i];
      if (c === '\\') {
        const d = src[i + 1];
        if (d === 'u') {
          if (src[i + 2] === '{') { const e = src.indexOf('}', i); s += String.fromCodePoint(parseInt(src.slice(i + 3, e), 16)); i = e + 1; } else { s += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16)); i += 6; }
        } else if (d === 'x') { s += String.fromCharCode(parseInt(src.slice(i + 2, i + 4), 16)); i += 4; } else { if (d === '\n') line++; s += d in ESC ? ESC[d] : d; i += 2; }
      } else if (c === '$' && src[i + 1] === '{') {
        i += 2; s += '\u0000';
        depth++; scanCode(true); depth--;
      } else { if (c === '\n') line++; s += c; i++; }
    }
    i++;
    out.push({ line: at, kind: 'tpl', text: s, depth });
  }

  function readRegex() {
    i++;
    let cls = false;
    while (i < n) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '\n') break; // 不是正则（保险）
      if (c === '[') cls = true; else if (c === ']') cls = false; else if (c === '/' && !cls) break;
      i++;
    }
    i++;
    while (i < n && /[a-z]/i.test(src[i])) i++;
  }

  // stopAtBrace：在模板的 ${ 里，遇到与之配对的 } 就返回
  function scanCode(stopAtBrace) {
    let depth = 0;
    let prev = 'op';
    while (i < n) {
      const c = src[i];
      if (c === '\n') { line++; i++; continue; }
      if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
      if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); const chunk = src.slice(i, e < 0 ? n : e + 2); line += (chunk.match(/\n/g) || []).length; i = e < 0 ? n : e + 2; continue; }
      if (c === '"' || c === "'") { readString(c); prev = 'val'; continue; }
      if (c === '`') { readTemplate(); prev = 'val'; continue; }
      if (c === '/') { if (prev === 'val') { i++; prev = 'op'; } else { readRegex(); prev = 'val'; } continue; }
      if (c === '{') { depth++; i++; prev = 'op'; continue; }
      if (c === '}') { i++; if (stopAtBrace && depth === 0) return; depth--; prev = 'val'; continue; }
      if (/[A-Za-z0-9_$]/.test(c)) {
        let j = i; while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
        prev = KEYWORDS.has(src.slice(i, j)) ? 'op' : 'val'; i = j; continue;
      }
      if (c === ')' || c === ']') { prev = 'val'; i++; continue; }
      if (c === '.' && /\d/.test(src[i + 1] || '')) { prev = 'val'; i++; continue; }
      prev = 'op'; i++;
    }
  }

  scanCode(false);
  return out;
}

// HTML 片段 → 文字和属性。CJK 判断留给调用者。
export function htmlRuns(text) {
  const texts = []; const attrs = [];
  if (!text.includes('<')) { texts.push(text); return { texts, attrs }; }
  const re = /<[a-zA-Z/!][^>]*>/g;
  let last = 0; let m;
  while ((m = re.exec(text))) {
    if (m.index > last) texts.push(text.slice(last, m.index));
    for (const a of m[0].matchAll(/\b(?:title|placeholder|aria-label|alt)=(?:"([^"]*)"|'([^']*)')/g)) attrs.push(a[1] ?? a[2]);
    last = m.index + m[0].length;
  }
  if (last < text.length) texts.push(text.slice(last));
  return { texts, attrs };
}

// 从 .html 里取出内联 <script> 的内容（保持行号偏移不重要，只返回源码拼起来）
export function inlineScripts(html) {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
}

export const CJK = /[㐀-鿿＀-￯　-〿]/;
