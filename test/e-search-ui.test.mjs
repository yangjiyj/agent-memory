// E 组：前端脚本的纯函数部分（答案渲染、命中高亮）和静态资源。真正的键盘交互用浏览器验证（见汇报），这里不依赖浏览器。
// 运行：node --test test/e-search-ui.test.mjs

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { startHub, TOKENS } from './helpers.mjs';

const HUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hub');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 嵌入模式下脚本只导出纯函数、不碰 DOM：给它一个最小的 Console 就能加载
function loadKit() {
  const Console = { esc, embed: true, zh: { type: {} } };
  vm.runInNewContext(fs.readFileSync(path.join(HUB, 'console-search.js'), 'utf8'), { Console, window: {}, document: {}, navigator: {}, addEventListener() {} });
  return Console.searchKit;
}

describe('全局搜索前端：答案渲染', () => {
  const kit = loadKit();
  const sources = [{ n: 1 }, { n: 2 }, { n: 3 }];

  it('[n] 变成可点的出处按钮，[1][2] 和 [1, 2] 都认；不存在的编号保持原样', () => {
    const h = kit.renderAnswer('用幂等键 [1]，对话里也说过 [2][3]；另见 [1, 2]；没有的 [9] 和 [1, 9]。', sources);
    assert.equal((h.match(/class="gs-cite"/g) || []).length, 1 + 2 + 2);
    assert.match(h, /<button type="button" class="gs-cite" data-n="1"[^>]*>1<\/button>/);
    assert.match(h, /\[9\]/);
    assert.match(h, /\[1, 9\]/);
  });

  it('模型输出整体转义：HTML、脚本、属性注入都不能生效', () => {
    const evil = '<img src=x onerror=alert(1)> <script>alert(2)</script> "quoted" \'single\' [1]';
    const h = kit.renderAnswer(evil, sources);
    assert.ok(!/<img|<script/i.test(h));
    assert.match(h, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(h, /&lt;script&gt;/);
    assert.match(h, /data-n="1"/);
    // 编号只能是 1–2 位数字，拼不出别的属性
    assert.ok(!/data-n="[^"]*[^0-9"]/.test(kit.renderAnswer('[1" onclick="x]', sources)));
  });

  it('**粗体** 和 `代码` 渲染，内容仍是转义过的', () => {
    const h = kit.renderAnswer('**重点<b>** 和 `a<b>c`', sources);
    assert.match(h, /<b>重点&lt;b&gt;<\/b>/);
    assert.match(h, /<code>a&lt;b&gt;c<\/code>/);
  });

  it('没有出处时 [n] 原样保留', () => {
    assert.equal(kit.renderAnswer('见 [1]', []), '见 [1]');
  });

  it('高亮：命中词包 <mark>，其余转义；词里的正则符号不会炸', () => {
    assert.equal(kit.hl('a<b 幂等键 (x)', ['幂等键']), 'a&lt;b <mark>幂等键</mark> (x)');
    assert.equal(kit.hl('C++ (test)', ['c++', '(test)']), '<mark>C++</mark> <mark>(test)</mark>');
    assert.equal(kit.hl('plain', []), 'plain');
    assert.deepEqual([...kit.wordsOf('  Foo   bar foo ')], ['foo', 'bar']); // 跨 vm 的数组原型不同，先展开
  });
});

describe('全局搜索前端：资源', () => {
  let hub;
  before(async () => { hub = await startHub({ tokens: TOKENS, peers: ['my-laptop'] }); });
  after(() => hub.stop());

  it('console.html 引入样式和脚本；样式、脚本都能取到（带身份）', async () => {
    const html = (await hub.web('GET', '/console')).text;
    assert.match(html, /href="\/console\/console-search\.css"/);
    assert.match(html, /src="\/console\/console-search\.js"/);
    for (const f of ['console-search.css', 'console-search.js']) {
      const r = await hub.web('GET', `/console/${f}`);
      assert.equal(r.status, 200, f);
      assert.ok(r.text.length > 2000, f);
    }
    assert.equal((await hub.web('GET', '/console/console-search.js', undefined, {})).status, 403, '没有身份取不到');
  });

  it('脚本：嵌入模式不启用；Ctrl/Cmd+K；Esc、上下、回车、Tab；输入法选词时回车不算；顶栏入口用 JS 注入', () => {
    const js = fs.readFileSync(path.join(HUB, 'console-search.js'), 'utf8');
    assert.match(js, /if \(Console\.embed\) return;/);
    assert.match(js, /e\.metaKey \|\| e\.ctrlKey/);
    for (const k of ["'Escape'", "'ArrowDown'", "'ArrowUp'", "'Tab'", "'Enter'"]) assert.ok(js.includes(k), k);
    assert.match(js, /isComposing/);
    assert.match(js, /querySelector\('\.top'\)/);
    assert.match(js, /\/console\/api\/search\?q=/);
    assert.match(js, /\/console\/api\/ask\/status/);
    assert.match(js, /AbortController/, '防抖 + 取消过期请求');
    const html = fs.readFileSync(path.join(HUB, 'console.html'), 'utf8');
    assert.ok(!html.includes('gs-open'), '顶栏结构不在 console.html 里改');
  });

  it('设置页有问答三项：密钥是 password 输入，只写不读', () => {
    const js = fs.readFileSync(path.join(HUB, 'console-admin.js'), 'utf8');
    assert.match(js, /id="adm-set-ask_key" type="password"/);
    assert.match(js, /已设置，留空不改/);
    assert.match(js, /ask_key_set/);
    assert.match(js, /id="adm-set-ask_url"/);
    assert.match(js, /id="adm-set-ask_model"/);
  });
});
