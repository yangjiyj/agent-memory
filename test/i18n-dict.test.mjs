// 两个词典文件（console-i18n-ui.js、console-i18n-srv.js）的完整性：没有重复键、写法合规、译文里没有汉字、规则可达。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadI18n, HUB, DICTS } from './i18n-util.mjs';

const CJK = /[㐀-鿿＀-￯　-〿]/;

test('词典文件存在，英文下登记的条数不为零，zh 下不登记', () => {
  for (const f of DICTS) assert.ok(fs.existsSync(path.join(HUB, f)), `缺 ${f}`);
  const en = loadI18n({ lang: 'en' }).AMI18n;
  const n = en._size();
  assert.ok(n.dict > 500, `词典条数太少：${n.dict}`);
  assert.ok(n.rules > 150, `规则条数太少：${n.rules}`);
  const zh = loadI18n({ lang: 'zh' }).AMI18n;
  assert.equal(zh._size, undefined);
  assert.deepEqual(Array.from(zh.missed()), []);
});

test('词典里没有重复键，规则写法合规（整句锚定、含汉字）', () => {
  const I = loadI18n({ lang: 'en' }).AMI18n;
  assert.deepEqual(Array.from(I._dupes), [], '同一个键登记了两次');
  assert.deepEqual(Array.from(I._bad), []);
});

test('英文词典输出里不带汉字（用户数据占位符除外），也不带全角标点', () => {
  const src = DICTS.map((f) => fs.readFileSync(path.join(HUB, f), 'utf8')).join('\n');
  // 取出每个 add({…}) 里的值和每个 pat/rule 的第二个参数文本：键在冒号前、值在冒号后
  const bad = [];
  for (const m of src.matchAll(/'((?:[^'\\]|\\.)*)':\s*'((?:[^'\\]|\\.)*)'/g)) if (CJK.test(m[2])) bad.push(`${m[1]} → ${m[2]}`);
  for (const m of src.matchAll(/\bpat\('((?:[^'\\]|\\.)*)',\s*'((?:[^'\\]|\\.)*)'\)/g)) if (CJK.test(m[2])) bad.push(`${m[1]} → ${m[2]}`);
  assert.deepEqual(bad, []);
});

test('每条词典键的译文都和键不同，并且再翻一次不变', () => {
  const I = loadI18n({ lang: 'en' }).AMI18n;
  const src = DICTS.map((f) => fs.readFileSync(path.join(HUB, f), 'utf8')).join('\n');
  let n = 0;
  for (const m of src.matchAll(/'((?:[^'\\]|\\.)*)':\s*'((?:[^'\\]|\\.)*)'/g)) {
    const key = m[1].replace(/\\'/g, "'");
    if (!CJK.test(key)) continue;
    const out = I.t(key);
    n++;
    assert.notEqual(out, key, `没翻：${key}`);
    assert.equal(I.t(out), out, `不幂等：${key} → ${out}`);
  }
  assert.ok(n > 500);
});

test('规则互相不遮挡：每条整句规则的样例句子都由它自己（或拆分后的各段）翻出来，不被前面的规则抢走', () => {
  const I = loadI18n({ lang: 'en' }).AMI18n;
  const src = DICTS.map((f) => fs.readFileSync(path.join(HUB, f), 'utf8')).join('\n');
  const bad = [];
  for (const m of src.matchAll(/\bpat\('((?:[^'\\]|\\.)*)',\s*'((?:[^'\\]|\\.)*)'\)/g)) {
    const zh = m[1].replace(/\\'/g, "'");
    if (/\{\*\}\s*$/.test(zh) && !/[㐀-鿿]/.test(zh.replace(/\{\*\}/g, ''))) continue;
    const sample = zh.replace(/\{n\}/g, '12').replace(/\{w\}/g, '一').replace(/\{t\}/g, '12').replace(/\{\*\}/g, 'Abc');
    const out = I.t(sample);
    if (CJK.test(out)) bad.push(`${zh} → ${sample} → ${out}`);
  }
  assert.deepEqual(bad, []);
});
