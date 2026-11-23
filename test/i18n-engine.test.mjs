// 界面语言引擎（hub/console-i18n.js）：不依赖浏览器，用 node:vm 加载。
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadI18n, fakeDom, ENGINE } from './i18n-util.mjs';

const en = (extra) => { const sb = loadI18n({ lang: 'en', files: [ENGINE] }); if (extra) extra(sb.AMI18n); return sb.AMI18n; };

test('语言：localStorage 优先，没有就看浏览器语言（zh 开头用中文，否则英文）', () => {
  assert.equal(loadI18n({ store: { 'am.lang': 'en' }, navigator: 'zh-CN', files: [ENGINE] }).AMI18n.lang, 'en');
  assert.equal(loadI18n({ store: { 'am.lang': 'zh' }, navigator: 'en-US', files: [ENGINE] }).AMI18n.lang, 'zh');
  assert.equal(loadI18n({ store: {}, navigator: 'zh-CN', files: [ENGINE] }).AMI18n.lang, 'zh');
  assert.equal(loadI18n({ store: {}, navigator: 'zh-TW', files: [ENGINE] }).AMI18n.lang, 'zh');
  assert.equal(loadI18n({ store: {}, navigator: 'en-US', files: [ENGINE] }).AMI18n.lang, 'en');
  assert.equal(loadI18n({ store: {}, navigator: 'ja-JP', files: [ENGINE] }).AMI18n.lang, 'en');
  assert.equal(loadI18n({ store: {}, navigator: '', files: [ENGINE] }).AMI18n.lang, 'en');
  assert.equal(loadI18n({ store: { 'am.lang': 'fr' }, navigator: 'zh-CN', files: [ENGINE] }).AMI18n.lang, 'zh', '存了不认识的值就当没存');
});

test('zh：什么都不做——t 原样返回，add/rule/pat 不登记，apply 不动 DOM', () => {
  const sb = loadI18n({ lang: 'zh' });
  const I = sb.AMI18n;
  assert.equal(I.lang, 'zh');
  I.add({ 概览: 'Overview' });
  I.pat('{n} 条', '$1 items');
  assert.equal(I.t('概览'), '概览');
  assert.equal(I.t('3 条'), '3 条');
  assert.equal(I.nav('lib', '记忆库'), '记忆库');
  const { el, text, dump } = fakeDom();
  const root = el('div', { title: '提示' }, text('概览'), el('b', {}, text('3 条')));
  const before = dump(root);
  I.apply(root);
  assert.equal(dump(root), before);
  assert.deepEqual(Array.from(I.missed()), []);
  assert.equal(I._size, undefined, 'zh 下不建词典');
});

test('en：精确词典、两端空白保留、译文自带的空格保留、未命中原样返回', () => {
  const I = en((i) => i.add({ 概览: 'Overview', 条: ' items', '  保存 ': 'Save' }));
  assert.equal(I.t('概览'), 'Overview');
  assert.equal(I.t('  概览\n'), '  Overview\n');
  assert.equal(I.t(' 保存'), ' Save', '键里的空白被忽略');
  assert.equal(I.t(' 条'), '  items');
  assert.equal(I.t('没登记过的句子'), '没登记过的句子');
  assert.equal(I.t('English only'), 'English only');
  assert.equal(I.t(''), '');
  assert.equal(I.t(42), 42, '非字符串原样');
});

test('en：规则——数字捕获、单复数、星期、再翻译、函数规则、拒绝', () => {
  const I = en((i) => {
    i.add({ 刚刚: 'just now', 作废: 'Retire' });
    i.pat('近 {n} 天', 'last $1 {1|day|days}');
    i.pat('{n} 分钟前', '$1 min ago');
    i.pat('{*} 已更新', '$1 updated');
    i.pat('● {*}同步', '● synced $t1');
    i.pat('周{w}', '$w1');
    i.rule(/^累计 (\d+) 万$/, (m) => `${m[1] * 10}K`);
    i.rule(/^(.+?)「(.+)」$/, (m, t) => { const a = t(m[1]); return /[㐀-鿿]/.test(a) ? null : `${a} "${m[2]}"`; });
  });
  assert.equal(I.t('近 7 天'), 'last 7 days');
  assert.equal(I.t('近 1 天'), 'last 1 day');
  assert.equal(I.t('近 1,234 天'), 'last 1,234 days');
  assert.equal(I.t('3 分钟前'), '3 min ago');
  assert.equal(I.t('desk-01 已更新'), 'desk-01 updated');
  assert.equal(I.t('● 3 分钟前同步'), '● synced 3 min ago');
  assert.equal(I.t('● 刚刚同步'), '● synced just now');
  assert.equal(I.t('周一'), 'Mon');
  assert.equal(I.t('周日'), 'Sun');
  assert.equal(I.t('周八'), '周八', '不是星期汉字不翻');
  assert.equal(I.t('累计 3 万'), '30K');
  assert.equal(I.t('作废「旧部署」'), 'Retire "旧部署"', '动作词翻、引号里的原样');
  assert.equal(I.t('随便「写点」什么'), '随便「写点」什么', '函数规则返回 null = 不归它，原样');
  assert.equal(I.t('近 abc 天'), '近 abc 天', '{n} 只认数字');
});

test('en：按 " · "、"；" 拆开逐段翻，翻不动的段当用户数据留着；"，"、"、" 必须每段都翻得动', () => {
  const I = en((i) => {
    i.add({ 刚刚: 'just now', 已暂停: 'Paused', 次: 'times' });
    i.pat('{n} 分钟前', '$1 min ago');
    i.pat('近 {n} 天', 'last $1 days');
  });
  assert.equal(I.t('已暂停 · 3 分钟前'), 'Paused · 3 min ago');
  assert.equal(I.t('我的项目 · 刚刚'), '我的项目 · just now', '用户数据的段原样');
  assert.equal(I.t('部署流程 · 备份'), '部署流程 · 备份', '一段也翻不动就不改');
  assert.equal(I.t('· 刚刚'), '· just now', '开头的 "· "');
  assert.equal(I.t('已暂停；刚刚'), 'Paused; just now');
  assert.equal(I.t('已暂停，刚刚'), 'Paused, just now');
  assert.equal(I.t('已暂停，用户写的话'), '已暂停，用户写的话', '句内的逗号：有一段翻不动就整句不动');
  assert.equal(I.t('已暂停、刚刚'), 'Paused, just now');
});

test('en：规则不会吞用户数据（几条典型用户标题原样不变）', () => {
  const sb = loadI18n({ lang: 'en' });
  const I = sb.AMI18n;
  const user = [
    '部署流程', '修复登录页的 bug', '2.9.20 发布记录', '星河项目 · 备份', 'myapp 11-22 两现场只读排查结论',
    '关于「部署」的决定', '用户偏好：回复用中文', '项目现状（11-22）', '近期决定与坑', '周报：本周做了什么', '备份脚本在 /srv/backup',
    '最近一次发布后回滚了', '没有人关心的事', '设备台账', '待办：整理笔记', '记忆库迁移到新机器',
  ];
  for (const s of user) assert.equal(I.t(s), s, `用户标题被改了：${s}`);
});

test('en：翻译结果是幂等的（再翻一次不变），而且词典输出里没有汉字', () => {
  const sb = loadI18n({ lang: 'en' });
  const I = sb.AMI18n;
  const samples = ['概览', '近 7 天', '3 分钟前', '刚刚', '已暂停 · 3 分钟前', '周一', '作废「x」', '设备 x 已经 3 小时没同步', '页面出错：没有权限', '失败：请求体必须是 JSON 对象', '12 条记忆'];
  for (const s of samples) {
    const a = I.t(s);
    assert.equal(I.t(a), a, `不幂等：${s} → ${a}`);
    assert.doesNotMatch(a, /[㐀-鿿]/, `还有汉字：${s} → ${a}`);
  }
});

test('en：apply 翻译文本节点和 title/placeholder/aria-label/alt，按钮的 value 翻、输入框的 value 不翻', () => {
  const I = en((i) => i.add({ 概览: 'Overview', 保存: 'Save', 提示: 'Hint', 搜索: 'Search' }));
  const { el, text, dump } = fakeDom();
  const root = el('div', {}, el('h1', {}, text('概览')), el('button', { 'aria-label': '搜索', title: '提示' }, text('保存')), el('input', { type: 'button', value: '保存' }), el('input', { type: 'text', value: '概览', placeholder: '搜索' }), el('img', { alt: '概览' }));
  I.apply(root);
  assert.equal(dump(root), '<div><h1>Overview</h1><button aria-label="Search" title="Hint">Save</button><input type="button" value="Save"></input><input type="text" value="概览" placeholder="Search"></input><img alt="Overview"></img></div>');
});

test('en：apply 不翻 script/style/textarea 和 data-i18n-skip 里的东西；已翻的再 apply 不变', () => {
  const I = en((i) => i.add({ 概览: 'Overview' }));
  const { el, text, dump } = fakeDom();
  const root = el('div', {}, el('script', {}, text('概览')), el('style', {}, text('概览')), el('textarea', {}, text('概览')), el('div', { 'data-i18n-skip': '' }, el('b', {}, text('概览'))), el('p', {}, text('概览')));
  I.apply(root);
  assert.equal(dump(root), '<div><script>概览</script><style>概览</style><textarea>概览</textarea><div data-i18n-skip=""><b>概览</b></div><p>Overview</p></div>');
  const once = dump(root);
  I.apply(root); I.apply(root);
  assert.equal(dump(root), once);
  const t = text('概览'); const p = el('p', {}, t);
  I.apply(p); assert.equal(t.nodeValue, 'Overview');
  t.nodeValue = '概览'; I.apply(p); assert.equal(t.nodeValue, 'Overview', '页面重新写入中文后能再翻');
});

test('en：词典晚到时，之前翻不动的节点再 apply 会重新翻', () => {
  const sb = loadI18n({ lang: 'en', files: [ENGINE] });
  const I = sb.AMI18n;
  const { el, text } = fakeDom();
  const t = text('保存'); const p = el('p', {}, t);
  I.apply(p); assert.equal(t.nodeValue, '保存');
  I.add({ 保存: 'Save' });
  I.apply(p); assert.equal(t.nodeValue, 'Save');
});

test('en：登记时的写法检查——词典键要有汉字，规则要整句锚定、要有汉字；重复键会被记下', () => {
  const I = en((i) => {
    i.add({ abc: 'x', 概览: 'Overview' });
    i.add({ 概览: 'Overview' });
    i.rule(/(\d+) 条/, '$1');
    i.rule(/^(.+)$/, '$1');
  });
  assert.equal(I._bad.length, 3);
  assert.deepEqual(Array.from(I._dupes), ['概览']);
});

test('en：页面名表 nav() 优先，没有就按词典翻', () => {
  const I = en((i) => { i.add({ 项目: 'Project' }); i.addNav({ projects: 'Projects' }); });
  assert.equal(I.nav('projects', '项目'), 'Projects');
  assert.equal(I.nav('other', '项目'), 'Project');
});

test('zh/en 都有的小工具：pl 单复数、wd 星期', () => {
  for (const lang of ['zh', 'en']) {
    const I = loadI18n({ lang, files: [ENGINE] }).AMI18n;
    assert.equal(I.pl(1, 'a', 'b'), 'a');
    assert.equal(I.pl(2, 'a', 'b'), 'b');
  }
  assert.equal(en().wd('一'), 'Mon');
  assert.equal(en().wd('日'), 'Sun');
});

test('en：{t} 捕获必须能翻成不带汉字的，翻不动就是用户数据，规则放弃；$l 把首字母变小写', () => {
  const I = en((i) => {
    i.add({ 刚刚: 'just now', 今天: 'Today' });
    i.pat('{t}提交', 'committed $t1');
    i.pat('更新于 {t}', 'updated $l1');
  });
  assert.equal(I.t('刚刚提交'), 'committed just now');
  assert.equal(I.t('2026-11-01提交'), 'committed 2026-11-01', '日期没有汉字，直接过');
  assert.equal(I.t('改动不大，已提交'), '改动不大，已提交', '用户写的"…已提交"不会被规则吃掉');
  assert.equal(I.t('更新于 今天'), 'updated today');
  assert.equal(I.t('更新于 刚刚'), 'updated just now');
});

test('en：同一个汉字在不同元素里译法不同（"标签|中文"、"标签.类名|中文"），apply 按文本节点的父元素找', () => {
  const I = en((i) => i.add({ 设备: 'Device', 'h2|设备': 'Devices', 'button.warn|设备': 'Drop device' }));
  const { el, text, dump } = fakeDom();
  const root = el('div', {}, el('h2', {}, text('设备')), el('th', {}, text('设备')), el('button', { class: 'warn x' }, text('设备')), el('button', {}, text('设备')));
  I.apply(root);
  assert.equal(dump(root), '<div><h2>Devices</h2><th>Device</th><button class="warn x">Drop device</button><button>Device</button></div>');
  assert.equal(I.t('设备'), 'Device', '不带上下文时用普通词条');
});

test('en：textarea 里的文字不翻，但它的 placeholder 翻；data-i18n-skip 里的属性也不翻', () => {
  const I = en((i) => i.add({ 提示: 'Hint', 概览: 'Overview' }));
  const { el, text, dump } = fakeDom();
  const root = el('div', {}, el('textarea', { placeholder: '提示' }, text('概览')), el('div', { 'data-i18n-skip': '' }, el('input', { placeholder: '提示' })));
  I.apply(root);
  assert.equal(dump(root), '<div><textarea placeholder="Hint">概览</textarea><div data-i18n-skip=""><input placeholder="提示"></input></div></div>');
});

test('en：长列表（"、"拼的十几项）也能逐项翻；带汉字的段太多的长文原样（用户数据）', () => {
  const I = en((i) => i.add({ 设备: 'Device' }));
  const list = Array.from({ length: 15 }, (_, k) => `key_${k}`).join('、');
  assert.equal(I.t(list), list.replaceAll('、', ', '));
  const long = Array.from({ length: 20 }, () => '一段用户写的话').join('，');
  assert.equal(I.t(long), long);
  const huge = `设备${'用户数据'.repeat(300)}`;
  assert.equal(I.t(huge), huge, '600 字以上的长文直接放过');
});

test('en：句首句尾挂着的 "·" 也能拆（它前面或后面是别的元素）', () => {
  const I = en((i) => { i.add({ 刚刚: 'just now' }); i.pat('{n} 次', '$1 times'); });
  assert.equal(I.t('73 次 ·'), '73 times ·');
  assert.equal(I.t('· 刚刚'), '· just now');
  assert.equal(I.t('2026-11-02（20 天前）· 台式机'), '2026-11-02（20 天前）· 台式机', '一段翻不动、另一段没有对应规则：不动');
});
