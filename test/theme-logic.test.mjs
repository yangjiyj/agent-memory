// H 组：console-theme.js 的三态逻辑（跟随系统/浅色/深色）。用 vm 沙箱 + 模拟的 localStorage 和 matchMedia，不依赖浏览器。
// 运行：node --test test/theme-logic.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { HUB } from './theme-util.mjs';

const SRC = fs.readFileSync(path.join(HUB, 'console-theme.js'), 'utf8');

// 搭一个最小的"浏览器"：documentElement.dataset、顶栏（含 .sp）、localStorage、matchMedia、window 事件
function env({ stored, systemDark = false, embed = false, storageThrows = false } = {}) {
  const events = [];
  const store = new Map(stored !== undefined ? [['am.theme', stored]] : []);
  const localStorage = storageThrows
    ? { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } }
    : { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  const mqListeners = [];
  const mq = { matches: systemDark, addEventListener: (t, f) => { if (t === 'change') mqListeners.push(f); } };
  const sp = { after(n) { top.children.splice(top.children.indexOf(sp) + 1, 0, n); } };
  const top = { children: [sp], querySelector: (s) => (s === '.sp' ? sp : null), appendChild: (n) => top.children.push(n) };
  const documentElement = { dataset: {} };
  const document = { documentElement, querySelector: (s) => (s === '.top' ? top : null), createElement: () => ({ attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }) };
  const listeners = {};
  const addEventListener = (t, f) => { (listeners[t] ||= []).push(f); };
  const window = { dispatchEvent: (e) => events.push(e), addEventListener };
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } }
  const Console = { embed };
  const ctx = vm.createContext({ Console, document, window, localStorage, matchMedia: () => mq, CustomEvent, addEventListener });
  vm.runInContext(SRC, ctx);
  const button = top.children.find((c) => c.id === 'theme');
  return {
    Console, events, store, mq, button, theme: documentElement.dataset,
    systemChange(dark) { mq.matches = dark; mqListeners.forEach((f) => f({ matches: dark })); },
    otherTab(v) { if (v === null) store.delete('am.theme'); else store.set('am.theme', v); (listeners.storage || []).forEach((f) => f({ key: 'am.theme' })); },
  };
}

describe('console-theme.js：默认跟随系统', () => {
  it('没有存储时是 auto：系统深色 → dark，系统浅色 → light', () => {
    const a = env({ systemDark: true });
    assert.equal(a.Console.theme.get(), 'auto');
    assert.equal(a.theme.theme, 'dark');
    assert.equal(a.Console.theme.resolved(), 'dark');
    const b = env({ systemDark: false });
    assert.equal(b.theme.theme, 'light');
    assert.equal(b.Console.theme.resolved(), 'light');
    assert.equal(a.events.length, 0, '加载时不发事件');
  });

  it('按钮注入在顶栏 .sp 后面，title 写明当前状态和点一下会变成什么', () => {
    const e = env({ systemDark: true });
    assert.ok(e.button, '顶栏里有主题按钮');
    assert.equal(e.button.type, 'button');
    assert.match(e.button.title, /主题：跟随系统（现为深色）/);
    assert.match(e.button.title, /点一下改为浅色/);
    assert.match(e.button.attrs['aria-label'], /跟随系统/);
    assert.match(e.button.innerHTML, /<svg/);
  });
});

describe('console-theme.js：点击循环、记住选择、发事件', () => {
  it('点一下：跟随系统 → 浅色 → 深色 → 跟随系统；每次写进 am.theme', () => {
    const e = env({ systemDark: true });
    const seen = [];
    for (let i = 0; i < 3; i++) { e.button.onclick(); seen.push([e.Console.theme.get(), e.theme.theme, e.store.get('am.theme')]); }
    assert.deepEqual(seen, [['light', 'light', 'light'], ['dark', 'dark', 'dark'], ['auto', 'dark', 'auto']]);
    e.button.onclick();
    assert.match(e.button.title, /主题：浅色/);
    assert.ok(!/现为/.test(e.button.title), '只有跟随系统时才写"现为"');
  });

  it('换主题时 window 发 am-theme，detail.theme 是实际生效的 light/dark', () => {
    const e = env({ systemDark: false });
    e.Console.theme.set('dark');
    e.Console.theme.set('light');
    assert.deepEqual(e.events.map((x) => [x.type, x.detail.theme, x.detail.choice]), [['am-theme', 'dark', 'dark'], ['am-theme', 'light', 'light']]);
    e.Console.theme.set('light');
    assert.equal(e.events.length, 2, '没变就不重复发');
  });

  it('手动选择优先于系统偏好（刷新后也一样：存储的值先于系统）', () => {
    assert.equal(env({ stored: 'dark', systemDark: false }).theme.theme, 'dark');
    assert.equal(env({ stored: 'light', systemDark: true }).theme.theme, 'light');
    assert.equal(env({ stored: 'auto', systemDark: true }).theme.theme, 'dark');
  });

  it('不合法的存储值按 auto 处理；set 传不认识的值被忽略', () => {
    const e = env({ stored: 'purple', systemDark: true });
    assert.equal(e.Console.theme.get(), 'auto');
    e.Console.theme.set('blue');
    assert.equal(e.Console.theme.get(), 'auto');
    assert.equal(e.events.length, 0);
    assert.equal(e.store.get('am.theme'), 'purple', '不认识的值不写入');
  });

  it('localStorage 不可用（隐私模式）也不报错，这次页面里仍然能切', () => {
    const e = env({ storageThrows: true, systemDark: false });
    assert.equal(e.theme.theme, 'light');
    e.Console.theme.set('dark');
    assert.equal(e.theme.theme, 'dark');
    assert.equal(e.Console.theme.get(), 'dark');
  });
});

describe('console-theme.js：系统偏好变化、别的标签页', () => {
  it('"跟随系统"时系统偏好一变就跟着变，并发事件', () => {
    const e = env({ systemDark: false });
    e.systemChange(true);
    assert.equal(e.theme.theme, 'dark');
    assert.deepEqual(e.events.map((x) => x.detail.theme), ['dark']);
    assert.match(e.button.title, /现为深色/);
    e.systemChange(false);
    assert.equal(e.theme.theme, 'light');
    assert.equal(e.events.length, 2);
  });

  it('手动选了浅色/深色，系统偏好变化不理会', () => {
    const e = env({ stored: 'light', systemDark: false });
    e.systemChange(true);
    assert.equal(e.theme.theme, 'light');
    assert.equal(e.events.length, 0);
  });

  it('别的标签页改了选择，这边同步并发事件', () => {
    const e = env({ systemDark: false });
    e.otherTab('dark');
    assert.equal(e.Console.theme.get(), 'dark');
    assert.equal(e.theme.theme, 'dark');
    assert.equal(e.events.length, 1);
    e.otherTab(null);
    assert.equal(e.Console.theme.get(), 'auto');
    assert.equal(e.theme.theme, 'light');
  });
});

describe('console-theme.js：嵌入模式（大屏里的拓扑）永远深色', () => {
  it('无视存储的选择和系统偏好，不显示切换按钮', () => {
    for (const stored of [undefined, 'light', 'auto']) {
      const e = env({ embed: true, stored, systemDark: false });
      assert.equal(e.theme.theme, 'dark', `stored=${stored}`);
      assert.equal(e.Console.theme.resolved(), 'dark');
      assert.equal(e.button, undefined, '嵌入模式不放按钮');
    }
  });

  it('嵌入时 set 不会变浅，系统偏好变化也不发事件', () => {
    const e = env({ embed: true, systemDark: false });
    e.Console.theme.set('light');
    assert.equal(e.theme.theme, 'dark');
    assert.equal(e.Console.theme.resolved(), 'dark');
    e.systemChange(true); e.systemChange(false);
    e.otherTab('light');
    assert.equal(e.theme.theme, 'dark');
  });
});
