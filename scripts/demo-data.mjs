#!/usr/bin/env node
/* 演示数据生成器：一条命令造出一套完全虚构的数据，让任何人不接设备也能看到控制台的样子。
 *
 *   node scripts/demo-data.mjs /tmp/am-demo [--port 8790] [--seed 7]
 *   AGENT_MEMORY_CONFIG=/tmp/am-demo/config.json node hub/server.mjs
 *   浏览器打开 http://127.0.0.1:8790/
 *
 * 写入方式：先起一个临时中心进程，设备登记（令牌文件）、记忆（native/import/remember/会话抽取）、
 * 对话上传（/v1/conv/append）、工作日志（/v1/journal/result）、待办标记、设备策略都走中心自己的接口；
 * 接口补不了历史时间的部分，在停掉中心后直接写文件：心跳时间、调用记录（usage.jsonl）、
 * 拒收记录、自动保留记录，以及把非原生记忆条目的创建/更新时间改成合理的历史时间（再提交一次 git）。
 * 内容全是虚构的：项目、机器、对话、记忆都是模板加词表组合出来的，固定随机种子，每次结构一样，
 * 时间相对"现在"生成（最后一天是今天）。数据目录已存在且非空时拒绝执行。
 * 无第三方依赖，Node >= 18。
 */

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'hub', 'server.mjs');

// ------------------------------------------------------------------ 参数 ----

const argv = process.argv.slice(2);
let TARGET = '';
let PORT = 8790;
let SEED = 20261123;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--port') PORT = parseInt(argv[++i], 10);
  else if (argv[i] === '--seed') SEED = parseInt(argv[++i], 10);
  else if (!argv[i].startsWith('--') && !TARGET) TARGET = argv[i];
  else die(`不认识的参数 ${argv[i]}`);
}
function die(msg) { console.error(msg); process.exit(1); }
if (!TARGET) die('用法：node scripts/demo-data.mjs <数据目录> [--port 8790] [--seed N]\n数据目录必须不存在或是空的。');
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) die('--port 必须是 1–65535 的整数');
TARGET = path.resolve(TARGET);
if (fs.existsSync(TARGET) && fs.readdirSync(TARGET).length) die(`${TARGET} 已存在且不为空，拒绝覆盖（里面可能是真实数据）。换一个新目录，或先自己清掉。`);

// ----------------------------------------------------------- 随机和时间 ----

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const R = mulberry32(SEED);
const rnd = (n) => Math.floor(R() * n);
const range = (a, b) => a + rnd(b - a + 1);
const pick = (a) => a[rnd(a.length)];
const chance = (p) => R() < p;
const pickW = (obj) => {
  const es = Object.entries(obj);
  let r = R() * es.reduce((a, [, w]) => a + w, 0);
  for (const [k, w] of es) { r -= w; if (r < 0) return k; }
  return es[es.length - 1][0];
};
const shuffle = (a) => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = rnd(i + 1); [b[i], b[j]] = [b[j], b[i]]; } return b; };
const sample = (a, n) => shuffle(a).slice(0, n);

const NOW = Date.now();
const DAY = 86400e3;
const BJ = 8 * 3600e3;
const MIN = 60e3;
const DAYS = 140;
const todayStart = Math.floor((NOW + BJ) / DAY) * DAY - BJ; // 今天北京时间 0 点
const dayStart = (k) => todayStart - k * DAY;
const dayStr = (k) => new Date(dayStart(k) + BJ + 12 * 3600e3).toISOString().slice(0, 10);
const wdayOf = (k) => new Date(dayStart(k) + BJ + 12 * 3600e3).getUTCDay();
const iso = (ms) => new Date(ms).toISOString();
const localDay = (ms) => new Date(ms + BJ).toISOString().slice(0, 10);

// -------------------------------------------------------------- 设备定义 ----

const DEVICES = [
  { name: 'desktop', label: '台式机', os: 'linux', home: '/home/demo', via: 'gateway', created: 150, seen: 2, rate: 3.4, host: 'desk-01',
    tools: { 'claude-code': 6, codex: 3, opencode: 1 }, proj: { 'shop-api': 5, infra: 2, 'data-pipeline': 2, billing: 2, 'notify-bot': 1, 'docs-site': 1, '': 1 }, hours: 'day',
    native: ['claude-code'], wiring: { 'claude-code': ['on', 'digest', true], codex: ['on', 'digest', false], opencode: ['on', 'digest', false], cursor: ['on', 'none', false] } },
  { name: 'laptop', label: '笔记本', os: 'darwin', home: '/Users/demo', via: 'join', created: 148, seen: 6, rate: 2.0, host: 'demo-air',
    tools: { 'claude-code': 4, hermes: 2, workbuddy: 2 }, proj: { 'mobile-app': 5, 'shop-api': 2, 'docs-site': 2, 'notify-bot': 1, '': 2 }, hours: 'evening',
    native: ['claude-code', 'hermes', 'workbuddy'], wiring: { 'claude-code': ['on', 'digest', true], hermes: ['on', 'none', true], workbuddy: ['on', 'rules', true], 'claude-desktop': ['on', 'none', false] } },
  { name: 'work-mac', label: '公司 Mac', os: 'darwin', home: '/Users/demo', via: 'join', created: 90, seen: 4, rate: 2.2, host: 'office-mac',
    tools: { 'claude-code': 4, codex: 3, codebuddy: 1 }, proj: { 'mobile-app': 4, 'shop-api': 3, 'docs-site': 1, 'data-pipeline': 1, '': 1 }, hours: 'office',
    native: ['claude-code', 'codebuddy'], wiring: { 'claude-code': ['on', 'digest', true], codex: ['on', 'digest', false], codebuddy: ['on', 'missing', true] } },
  { name: 'build-server', label: '构建服务器', os: 'linux', home: '/home/ci', via: 'gateway', created: 120, seen: 8, rate: 1.2, host: 'ci-runner',
    tools: { codex: 4, openclaw: 3, hermes: 1 }, proj: { infra: 5, 'data-pipeline': 4, 'shop-api': 2, billing: 1 }, hours: 'night',
    native: ['hermes', 'openclaw'], wiring: { codex: ['on', 'digest', false], openclaw: ['on', 'rules', true], hermes: ['on', 'none', true] } },
  { name: 'home-nas', label: '家庭 NAS', os: 'linux', home: '/home/demo', via: 'gateway', created: 100, seen: 9 * 1440 + 130, rate: 0.5, host: 'nas-box', until: 9,
    tools: { openclaw: 3, hermes: 2 }, proj: { infra: 4, 'data-pipeline': 2, '': 1 }, hours: 'evening',
    native: ['hermes', 'openclaw'], wiring: { openclaw: ['on', 'rules', true], hermes: ['on', 'none', true] } },
  { name: 'lab-vm', label: '实验虚拟机', os: 'linux', home: '/home/demo', via: 'token', created: 58, seen: 11, rate: 0.5, host: 'lab-vm-01', from: 60,
    tools: { opencode: 3, gemini: 2, qwen: 1 }, proj: { '': 3, 'data-pipeline': 1, 'notify-bot': 2, 'mobile-app': 1 }, hours: 'day',
    native: [], wiring: { opencode: ['on', 'digest', false], gemini: ['off', 'digest', false], qwen: ['on', 'digest', false] } },
];
const DEV = Object.fromEntries(DEVICES.map((d) => [d.name, d]));
const HOURS = {
  day: [1, 0.5, 0.2, 0.1, 0.1, 0.1, 0.3, 1, 3, 7, 9, 8, 3, 5, 9, 10, 9, 7, 4, 5, 8, 9, 8, 5],
  evening: [2, 1, 0.5, 0.2, 0.1, 0.1, 0.2, 0.5, 1, 2, 3, 3, 2, 2, 3, 3, 3, 4, 6, 9, 11, 12, 10, 6],
  office: [0, 0, 0, 0, 0, 0, 0, 0.3, 3, 9, 11, 10, 3, 6, 11, 12, 10, 8, 3, 0.5, 0, 0, 0, 0],
  night: [6, 7, 7, 6, 4, 2, 1, 1, 2, 4, 5, 5, 3, 4, 5, 5, 4, 3, 3, 3, 4, 5, 6, 6],
};
const TOOL_LABEL = { 'claude-code': 'Claude Code', codex: 'Codex', workbuddy: 'WorkBuddy', codebuddy: 'CodeBuddy', hermes: 'Hermes', openclaw: 'OpenClaw', opencode: 'OpenCode', gemini: 'Gemini', qwen: 'Qwen' };

// ------------------------------------------------------------- 项目词表 ----
// bugs 写成 "现象|处理办法"；feats 是一句话的功能点

const I = (n, f, e, bugs, feats) => ({ n, f, e, bugs, feats });
const PROJECTS = {
  'shop-api': {
    w: 26, from: 140, to: 0, ver0: [2, 1, 0], rel: [6, 11], machines: ['build-server', 'build-server', 'desktop'], site: 'lakeside-mall',
    items: [
      I('购物车', 'internal/cart/service.go', 'cart', ['并发扣库存时偶发超卖|库存行加乐观锁，更新失败自动重试两次', '合并游客购物车后商品数量翻倍|合并时按 SKU 去重取较大数量', '叠加优惠券后金额多减了几分钱|金额统一用整数分计算，最后一步才格式化'], ['支持一次删除多个商品', '限购数量改成按活动配置', '增加凑单满减提示']),
      I('订单', 'internal/order/service.go', 'order', ['超时未支付的订单没有自动关闭|定时任务改成按下单时间分批扫描，并加分布式锁', '拆单后运费被重复收取|运费只挂在主订单上，子单不再计费', '订单列表翻页时同一时间戳的订单会漏掉|分页游标改成时间戳加订单号复合'], ['新增订单备注字段', '支持部分商品先发货', '订单状态变更推送给通知服务']),
      I('库存', 'internal/stock/ledger.go', 'stock', ['盘点后库存和仓库系统差几件|盘点结果以仓库系统为准，每晚对账补差', '预占库存到期后没有释放|预占加过期时间，到期由定时任务释放', '秒杀开始瞬间缓存被击穿|热点商品库存提前预热，并加互斥重建'], ['按仓库拆分库存', '低库存预警接入通知服务', '支持预售库存']),
      I('支付回调', 'internal/pay/callback.go', 'pay', ['第三方回调重复触发导致重复入账|用商户订单号做幂等键，重复回调直接返回成功', '回调验签在时间戳偏差大时误拒|验签允许五分钟时钟偏差', '退款回调丢失后订单状态卡住|增加退款状态补偿查询任务'], ['接入新的聚合支付渠道', '支付超时提示改成可配置', '回调日志脱敏后落库']),
      I('商品搜索', 'internal/search/query.go', 'search', ['下架商品还会出现在搜索结果里|下架事件同步删除索引文档', '拼音搜索对多音字命中不全|给多音字建立补充词典', '同义词配置更新后不生效|同义词热更新后触发一次索引重载'], ['搜索结果支持按销量排序', '增加搜索联想', '热搜词每天自动刷新']),
      I('优惠券', 'internal/coupon/issue.go', 'coupon', ['领券并发时超过发放总量|发放计数放到 Redis 做原子递减', '已过期的券还出现在可用列表|列表接口增加有效期过滤', '满减门槛按原价而不是折后价计算|门槛统一按折后应付金额判断'], ['支持新人专享券', '券包一键领取', '券使用记录支持导出']),
    ],
    ops: ['升级 Go 版本到 1.22 并清理废弃依赖', '给几条慢查询补索引并更新建表脚本', '整理各接口的超时和重试配置', '补一轮压测并记录性能基线', '把接口变更同步到文档站'],
    facts: ['灰度开关放在配置中心的 gray.* 键下，服务每 30 秒拉一次，改完不用重启', '订单号规则是日期加 6 位序列加校验位，不要在调用方自己拼'],
    refs: ['接口文档在文档站的「订单与支付」一节，改接口后要同步更新', '压测脚本在仓库 scripts/loadtest 下，基线数据记在 wiki 的 shop-api 性能页'],
  },
  'mobile-app': {
    w: 18, from: 140, to: 0, ver0: [3, 4, 0], rel: [8, 14], machines: ['lab-vm', 'build-server'], site: '',
    items: [
      I('首页', 'src/screens/Home.tsx', 'home', ['下拉刷新后列表闪回顶部|刷新时保留滚动位置，只替换变化的数据', '弱网下骨架屏一直不消失|给首屏请求加超时，超时后展示缓存', '轮播图在后台时还在自动播放|页面失焦时暂停定时器'], ['首页模块支持后台配置顺序', '增加个性化推荐位', '深色模式下调整卡片配色']),
      I('结算页', 'src/screens/Checkout.tsx', 'checkout', ['切换收货地址后运费没刷新|地址变化后重新请求运费', '选择优惠券后总价先闪一下旧值|总价在新数据返回前保持加载态', '支付中按返回键会重复创建订单|支付中禁用返回并按订单号做幂等'], ['结算页支持多种支付方式记忆', '增加地址智能补全', '运费说明改为弹层展示']),
      I('推送通知', 'src/services/push.ts', 'push', ['安卓 13 上通知权限没有弹窗|按系统版本分别申请通知权限', '点击通知冷启动后没跳到对应页面|冷启动时把跳转参数暂存到路由初始化之后', '通知角标和未读数不一致|角标改为以服务端未读数为准'], ['推送支持按分类开关', '增加静默时段设置', '通知点击埋点']),
      I('离线缓存', 'src/cache/store.ts', 'cache', ['离线时订单列表读不到缓存|订单列表请求失败时回退到本地缓存', '清缓存后图片仍占用空间|清缓存时同时清理图片磁盘缓存', '弱网重试策略导致请求堆积|重试加指数退避，并合并相同请求'], ['缓存过期时间改成按接口配置', '增加缓存占用展示', '启动时预热常用数据']),
      I('登录注册', 'src/screens/Login.tsx', 'login', ['验证码倒计时切到后台后不走了|倒计时改为按时间戳计算', '第三方登录回跳后白屏|回跳时先恢复路由栈再处理授权结果', '指纹登录在部分机型上没有反应|检测不到生物识别时回退到密码登录'], ['支持手机号一键登录', '登录失败次数过多时增加冷却', '游客浏览后登录自动合并购物车']),
      I('设置页', 'src/screens/Settings.tsx', 'settings', ['切换语言后部分文案没更新|语言切换后重建根组件', '清除缓存按钮点了没有反馈|清除完成后展示结果提示', '深色模式开关重启后丢失|开关状态持久化到本地存储'], ['增加字体大小设置', '设置项支持搜索', '关于页展示构建信息']),
    ],
    ops: ['升级 React Native 到 0.74 并修掉构建报错', '整理 CI 里的打包流程，缩短到 12 分钟', '接入崩溃上报并按版本拆看板', '更新应用商店的截图和版本说明'],
    facts: ['内测包通过内部分发页下载，每次合并 main 自动出包，版本号带构建序号', '应用内的接口地址按环境区分，测试包默认指向预发环境'],
    refs: ['设计稿和组件规范在设计工具的「mobile-app」空间，改交互前先看一眼', '崩溃看板按版本和机型拆分，值班时先看新版本的崩溃率'],
  },
  infra: {
    w: 12, from: 140, to: 0, ver0: [1, 8, 0], rel: [14, 24], machines: ['build-server', 'home-nas', 'lab-vm'], site: '',
    items: [
      I('监控告警', 'monitoring/alert-rules.yml', 'alert', ['磁盘告警阈值太敏感，夜里连续误报|阈值改为连续 15 分钟超过 85% 才告警', '告警恢复通知没有发出|补上恢复事件的通知路由', '监控数据保留期超出磁盘容量|缩短高频指标保留期并加降采样'], ['告警按服务分组静默', '加入每日巡检报告', '增加备份任务失败告警']),
      I('备份', 'scripts/backup/nightly.sh', 'backup', ['每晚备份在 home-nas 空间不足时静默失败|脚本失败时返回非零并触发告警', '备份校验脚本只检查了文件存在|校验改为抽样还原并比对行数', '恢复演练发现数据库备份缺少最新一天|备份窗口顺延到低峰之后再做'], ['备份保留策略改成日、周、月三档', '增加异地副本', '恢复演练脚本化']),
      I('证书与域名', 'ops/certs/renew.sh', 'certs', ['证书续期任务因 DNS 超时失败|续期前先检查解析，失败重试三次', '泛域名证书在边缘节点没有同步|续期后通过部署钩子同步到所有节点', '证书到期提醒邮件进了垃圾箱|提醒改发到团队群并保留邮件'], ['证书到期前 21 天开始提醒', '新增域名自动签发', '内部域名统一用泛域名证书']),
      I('CI 流水线', 'ci/pipeline.yml', 'ci', ['构建缓存失效导致流水线变慢|缓存键改成依赖锁文件的哈希', '并行任务争用同一端口|测试端口改成随机分配', '镜像推送偶发超时|推送加重试并换成就近的镜像仓库'], ['流水线支持按目录触发', '增加依赖漏洞扫描', '构建产物自动归档']),
      I('容器与部署', 'deploy/compose.prod.yml', 'deploy', ['容器内存限制过小被频繁重启|按实际峰值调整内存限制并加告警', '滚动更新时旧实例没有优雅退出|增加优雅退出等待并调整健康检查', '健康检查路径配置错误导致误判|健康检查改为专用的轻量接口'], ['部署脚本支持一键回滚', '增加灰度发布开关', '预发环境按需启停']),
      I('日志', 'logging/rotate.conf', 'logs', ['日志轮转配置漏了一个服务|轮转配置按目录统一管理', '日志收集进程占满磁盘 IO|收集进程限速并错峰压缩', '日志里出现未脱敏的手机号|写入前统一经过脱敏中间件'], ['日志按服务和级别建立索引', '增加慢请求专用日志', '日志保留期改成按类型配置']),
    ],
    ops: ['升级基础镜像并重新构建所有服务', '清理构建服务器上的旧镜像和缓存', '整理几台机器的定时任务，去掉重复项', '给内网服务统一加上健康检查', '盘点各机器磁盘使用并写进巡检报告'],
    facts: ['备份落在 home-nas 的 /backup 机械盘，固态盘只放热数据，不放快照', '所有定时任务统一登记在运维仓库的 cron 目录，机器上不要手改 crontab'],
    refs: ['巡检看板按机器分组，值班先看红色和黄色的', '证书续期流程的说明在运维 wiki 的「证书」页，里面有手动续期步骤'],
  },
  'data-pipeline': {
    w: 14, from: 140, to: 0, ver0: [1, 3, 0], rel: [9, 15], machines: ['build-server', 'lab-vm'], site: 'harbor-depot',
    items: [
      I('订单日报表', 'jobs/reports/daily_orders.py', 'report', ['日报在月初按时区算错了一天|统一按北京时间切分日期，并补月初用例', '汇总表重复写入同一分区|写入改为按分区覆盖而不是追加', '报表里退款金额口径和财务不一致|退款按实际到账时间计入，与财务口径对齐'], ['日报增加按渠道拆分', '报表生成后推送摘要', '增加同比和环比指标']),
      I('增量同步', 'jobs/sync/incremental.py', 'sync', ['源库主从切换后增量同步漏了数据|水位线回退到切换前的位点再补跑', '水位线更新早于写入完成|先写入、确认成功后再更新水位线', '大表同步占满带宽|大表同步限速并错开高峰'], ['同步任务支持断点续跑', '新增订单明细表的同步', '同步延迟指标接入监控']),
      I('数据质量', 'jobs/quality/checks.py', 'quality', ['空值率检查对新增字段误报|新增字段给出两周的观察期再启用阈值', '重复主键检查耗时过长|改为按分区抽样检查，周末全量', '报告里没有带上失败样例|报告附带最多十条失败样例'], ['质量规则支持按表配置', '失败时自动创建工单', '质量分数每天汇总']),
      I('调度任务', 'scheduler/dags/daily.py', 'dag', ['任务依赖成环导致调度器卡住|提交前增加环检测并报错', '重跑历史分区时覆盖了新数据|重跑前校验分区版本，不一致则拒绝', '失败重试没有退避|重试按指数退避，最多四次'], ['调度支持按依赖自动补跑', '增加任务耗时趋势图', '关键任务失败时电话告警']),
      I('用户画像', 'jobs/profile/tags.py', 'profile', ['标签计算在数据倾斜时超时|对倾斜键加盐后分两步聚合', '画像更新没有按天分区|画像表改成按天分区并保留 90 天', '新用户标签延迟一天|新用户走增量通道，当天就能出标签'], ['新增活跃度标签', '标签支持按人群包导出', '标签口径写进数据字典']),
      I('分区与存储', 'jobs/storage/compact.py', 'storage', ['小文件太多导致查询变慢|每晚合并小文件并设置目标大小', '冷数据归档后查询报错|归档表保留元数据并在查询层兜底', '分区裁剪没有生效|查询条件改成直接用分区字段'], ['冷热数据按天数自动分层', '增加存储成本报表', '分区命名统一规范']),
    ],
    ops: ['升级 Python 到 3.12 并更新依赖', '重新梳理调度任务的优先级和资源配额', '清理三个月前的临时表', '把常用脚本整理进公共工具库'],
    facts: ['所有任务统一按北京时间切分日期，落库时间字段保留 UTC 偏移', '历史分区回填必须先在 lab-vm 上演练，再在线上执行'],
    refs: ['数据字典在 wiki 的「数据管道」页，新增字段要同步更新', '调度器看板里红色任务就是需要人工处理的，绿色的不用管'],
  },
  billing: {
    w: 9, from: 135, to: 44, ver0: [1, 0, 0], rel: [12, 20], machines: ['build-server', 'desktop'], site: 'harbor-depot',
    items: [
      I('账单生成', 'src/invoice/generate.ts', 'invoice', ['月末账单把跨月的订阅算进了下月|账单周期按订阅开始日切分', '账单金额四舍五入后总额差一分|逐行取整后把尾差补到最后一行'], ['账单支持导出 PDF', '账单增加备注字段']),
      I('订阅续费', 'src/subscription/renew.ts', 'renew', ['续费扣款失败后没有重试|失败后按 1 天、3 天、7 天重试', '升级套餐时按天折算不准确|按剩余天数占比折算差价'], ['续费前三天发提醒', '支持暂停订阅']),
      I('对账', 'src/recon/daily.ts', 'recon', ['对账文件里同一笔交易出现两次|对账前按交易号去重', '时区不一致导致跨日交易对不上|对账文件统一转换为北京时间'], ['对账差异自动生成工单', '增加对账看板']),
      I('税率', 'src/tax/rates.ts', 'tax', ['新税率生效日当天仍按旧税率计算|税率表增加生效时间并按下单时间取值', '含税价和不含税价混用|接口统一返回不含税价和税额'], ['税率表支持后台维护', '增加分地区税率']),
    ],
    ops: ['整理账单数据库的索引并清理历史表', '补齐计费规则的单元测试', '升级依赖并跑一遍回归'],
    facts: ['金额一律用整数分存储，展示层才转成元', '计费规则变更必须带生效时间，不能直接改历史规则'],
    refs: ['计费规则说明在 wiki 的「计费」页，改规则前先更新那里', '对账差异的处理流程见财务协作文档'],
  },
  'docs-site': {
    w: 6, from: 125, to: 12, ver0: [0, 9, 0], rel: [10, 16], machines: ['home-nas', 'build-server'], site: '',
    items: [
      I('接口文档', 'docs/api/index.md', 'api', ['接口文档里的示例请求缺少必填参数|示例由接口定义自动生成，不再手写', '文档里的错误码表和实际返回不一致|错误码表改为从代码里导出'], ['接口文档增加在线试用', '错误码按模块分组']),
      I('快速开始', 'docs/start/quickstart.md', 'start', ['快速开始里的安装命令在新系统上失败|补充系统要求并给出备选命令', '文档截图已经过期|截图改为构建时自动生成'], ['快速开始增加五分钟上手视频', '增加常见问题页']),
      I('站内搜索', 'site/search/index.ts', 'search', ['搜索对中文分词不准|中文索引改用二字切分加词典', '搜索结果没有高亮关键词|结果页增加关键词高亮'], ['搜索支持按版本过滤', '增加最近搜索']),
      I('版本切换', 'site/versions/switcher.ts', 'versions', ['切换版本后跳到了首页而不是对应页面|版本切换时按路径映射到对应页', '旧版本页面没有过期提示|旧版本页顶部增加醒目提示'], ['保留最近三个大版本的文档', '版本说明自动汇总']),
    ],
    ops: ['升级站点生成工具并修复构建警告', '把图片统一压缩并改成延迟加载', '检查并修复文档里的死链'],
    facts: ['文档站每次合并 main 后自动构建并发布到预览地址，正式发布需要打标签', '接口文档的源头是接口定义文件，不要直接改生成出来的页面'],
    refs: ['写作规范在仓库的 CONTRIBUTING 里，术语表放在 docs/glossary.md', '站点访问数据按页面统计，每月看一次，找出没人看的页面'],
  },
  'notify-bot': {
    w: 3, from: 70, to: 0, ver0: [0, 3, 0], rel: [10, 16], machines: ['lab-vm', 'build-server'], site: '',
    items: [
      I('邮件模板', 'bot/templates/email.py', 'email', ['邮件模板里的变量缺失时直接显示占位符|缺失变量时回退到默认文案', '长标题在部分邮箱客户端被截断|标题限制在 40 个字以内'], ['模板支持多语言', '模板预览页']),
      I('频率限制', 'bot/limits.py', 'limit', ['同一用户一分钟内收到重复通知|增加按用户和类型的去重窗口', '限流计数在重启后清零|计数放到共享缓存里'], ['按渠道配置不同限流', '静默时段不发非紧急通知']),
      I('渠道适配', 'bot/channels/adapter.py', 'channel', ['短信渠道失败后没有切换到备用渠道|主渠道连续失败三次后自动切换', '站内信已读状态没有同步|已读事件回写到消息表'], ['新增企业群机器人渠道', '渠道健康状态展示']),
    ],
    ops: ['整理通知类型和优先级', '补一轮渠道故障演练'],
    facts: ['通知按优先级分三档，紧急通知不受静默时段和限流影响', '渠道密钥只放在部署环境里，仓库和日志里都不留'],
    refs: ['通知类型清单在 wiki 的「通知」页', '渠道故障演练的记录放在运维仓库的 drills 目录'],
  },
};
const PNAMES = Object.keys(PROJECTS);

// 通用词表
const BLOCKERS = ['等第三方沙箱放开接口权限', '预发库的迁移卡在锁表上', '上游返回字段和文档对不上，等对方确认', '等设计稿确认交互', '测试环境数据被别人清掉了，要重新准备', '依赖的内部服务还没发布新版本'];
const RESULTS = {
  bugfix: ['已合并 main', '补了回归测试', '已上线灰度', '在预发环境验证通过', '测试全部通过，待发布', '线上观察一天没有再出现'],
  feature: ['已合并 main', '本地跑通，等 review', '已上线灰度', '已部署到预发环境', '功能开关默认关闭，待放量'],
  other: ['已合并 main', '改动不大，已提交', '测试全部通过', '已整理完并提交'],
};
const REMAIN = ['还差联调', '等 review 反馈', '还没补测试', '需要再确认边界情况', '准备明天接着做'];
const REFACTORS = ['拆分过长的函数并补注释', '把重复的校验逻辑抽成公共方法', '统一错误处理和日志格式', '去掉已经废弃的分支'];
const PERFS = ['p95 延迟下降约一半', '慢查询消失', '内存占用下降两成', '压测吞吐提升三成'];
const TOPICS = ['分布式锁的几种实现方式', '日志采样方案', '缓存预热的做法', '灰度发布策略', '接口限流算法', '数据库读写分离的取舍', '定时任务的幂等方案', '消息重试和死信的处理'];
const CHOICES = ['先灰度 10% 再全量', '走配置开关，默认关闭', '保持接口向后兼容，只新增字段', '先在预发验证一周再上', '复用现有中间件，不新增依赖', '改动放在独立模块，方便回滚'];
const ALTS = ['直接改表结构并停机迁移', '引入新的第三方库', '在客户端硬编码规则', '一次性全量上线', '手工脚本定期修正'];
const NOTES = ['这是上次复盘时确认的，后来没有变化', '来自一次现场排查，相关记录在对话存档里可以搜到', '交接文档里也写了这一条，以这里为准', '有例外情况时先在群里确认再改', '之前有人踩过，所以单独记一条'];
const BACKGROUNDS = ['上个版本里反复出现同类问题', '现场反馈比较集中', '之前的做法维护成本越来越高', '上线节奏需要更可控', '多个模块各写了一份相同逻辑'];

const MISC = [
  ['帮我写个 shell 脚本批量重命名截图文件', '写了个批量重命名截图的 shell 脚本，按日期和序号命名', ['脚本放在 ~/bin 下', '支持先预览再执行']],
  ['解释一下 git rebase 和 merge 的区别，团队该用哪个', '梳理了 rebase 和 merge 的取舍，倾向功能分支用 rebase 整理、合并用 merge', ['整理成三条团队约定', '补了冲突处理的步骤']],
  ['这条 SQL 为什么走不了索引，帮我看下执行计划', '分析了一条慢 SQL 的执行计划，原因是隐式类型转换导致索引失效', ['改写后走到了联合索引', '总结了三种常见的失效写法']],
  ['帮我整理这周的周报草稿', '整理了本周周报草稿，按项目归并成要点', ['每项不超过两行', '标出了下周要跟进的事']],
  ['tmux 里怎么让鼠标滚动生效，顺便给个常用配置', '调整了 tmux 配置：开启鼠标、改了前缀键和状态栏', ['配置放进了点文件仓库']],
  ['crontab 里“每个工作日早上 9 点”怎么写', '确认了 crontab 的写法，并给备份脚本加了每日定时', ['顺带检查了时区设置']],
  ['把这份 JSON 转成表格，按字段排序', '写了个小脚本把 JSON 转成 CSV，并按字段排序', ['处理了嵌套字段的展开']],
  ['正则怎么匹配形如 2026-11-03 的日期，还要排除非法月份', '写好了日期匹配的正则并补了用例，覆盖了闰年和非法月份', ['用例放进了工具库']],
  ['帮我看看这个 Dockerfile 为什么镜像这么大', '精简了一个 Dockerfile，镜像体积从 1.2GB 降到 380MB', ['改成多阶段构建', '清理了包管理缓存']],
  ['整理一下常用的 vim 快捷键，做成一页速查', '整理了一页 vim 速查表，按移动、编辑、查找分组', ['放进了笔记仓库']],
  ['对比一下两个开源日志库的性能和 API 风格', '对比了两个日志库，结论是按场景选：服务端用结构化的那个', ['记录了基准测试的结果']],
  ['写个脚本检查本机各项目有没有没推送的提交', '写了个脚本扫描各项目是否有未推送的提交，输出成表格', ['加进了每天早上的提醒']],
];

// ------------------------------------------------------- 偏好与反馈（通用）----

const PREFS = [
  ['提交信息用英文，一行不超过 72 个字符，说明做了什么而不是怎么做的', '遇到过两次提交信息太长被工具截断，之后统一按这个格式写。'],
  ['回复尽量简短，先给结论，再说依据；末尾不要重复总结', '阅读成本高，结论放最前面能省很多时间。'],
  ['代码改动先说方案，等确认后再动手，明显的小修复除外', '大改动返工代价高，先对齐思路更省事。'],
  ['说“完成”之前先跑测试；跑不了要说明原因', '有过没跑测试就报完成、结果线上出问题的情况。'],
  ['中文文档里的英文术语保留原文，比如 rebase、feature flag，不要硬翻译', '硬翻译之后团队里没人看得懂。'],
  ['不要在仓库里新建说明文档，除非明确要求', '仓库里的零散文档没人维护，很快就过期。'],
  ['shell 脚本默认写成幂等的，重复执行不应该出错', '运维脚本经常会被重复执行，幂等能避免半途失败后的清理工作。'],
  ['改配置前先备份原文件，放在同目录并加 .bak 后缀', '回滚时最快的办法就是直接换回备份。'],
  ['时间一律按北京时间显示，日志里保留 UTC 偏移', '跨机器排查问题时，时间对不上最浪费精力。'],
  ['能用标准库就不引入新依赖，新增依赖要先问一声', '依赖多了升级和审计都是负担。'],
  ['数据库迁移必须能回滚：写 down 脚本，并在预发演练一遍', '上线前演练过回滚，真出问题时才有底气。'],
  ['危险命令（删除、强推、清库）执行前必须让我确认', '这类操作不可逆，宁可多问一句。'],
  ['图表默认用浅色背景、字号不小于 12，颜色不超过五种', '投到会议室屏幕上才看得清。'],
  ['周报用要点列表，每项不超过两行，先写做成了什么', '领导只扫一眼，重点要放在前面。'],
  ['code review 的意见要具体到行并说明原因，不要只写“建议优化”', '笼统的意见没法执行，来回沟通成本高。'],
  ['需要联网查资料时先说明要查什么，再动手', '有些环境不允许随意外联，先说清楚更稳妥。'],
  ['脚本和配置里的路径不要写死个人目录，用环境变量或相对路径', '同一份脚本要在好几台机器上跑。'],
  ['数据库字段变更要同步更新数据字典', '数据字典过期之后，报表口径就会跑偏。'],
];
const FEEDBACKS = [
  ['上次为了让用例通过放宽了断言，这样不对：要改实现，不要改断言', '测试是保护网，放宽断言等于把洞补成了假象。'],
  ['不要一次改太多文件，一个提交只做一件事，方便回滚', '大提交出问题时没法只回滚其中一部分。'],
  ['排查问题时别猜，先看日志和实际数据，再下结论', '凭印象判断导致绕了两个小时弯路。'],
  ['回复里不要用“显然”“很简单”这类词', '看起来像是在暗示对方没看懂。'],
  ['别把中间过程全贴出来，只要关键输出和结论', '长输出淹没了真正有用的信息。'],
  ['遇到不确定的接口行为，先写个最小脚本验证，再改代码', '文档和实际行为不一致已经出现过好几次。'],
  ['文案里别加感叹号，也别用夸张的形容词', '产品文案要克制，过度渲染反而显得不可信。'],
  ['发布前把变更清单再对一遍，别只看最后一个提交', '上次漏发了一个迁移脚本。'],
  ['汇报进度时区分“已经做完”和“已经改好但没验证”', '两者混在一起会让人误判风险。'],
  ['改动涉及多个项目时，先列出影响面再开始', '漏掉下游调用方是最常见的回归来源。'],
];

// ----------------------------------------------------------- 版本发布表 ----

const releases = {}; // 项目 -> [{k, ver}]，k 为距今天数（大的更早）
for (const [p, P] of Object.entries(PROJECTS)) {
  const list = [];
  let [a, b, c] = P.ver0;
  let k = P.from - range(4, 9);
  let n = 0;
  while (k > P.to + 1) {
    n++;
    if (n % 4 === 0) { b++; c = 0; } else c++;
    list.push({ k, ver: `${a}.${b}.${c}` });
    k -= range(P.rel[0], P.rel[1]);
  }
  releases[p] = list;
}
const verAt = (p, k) => { const xs = releases[p].filter((r) => r.k >= k); return (xs[xs.length - 1] || releases[p][0]).ver; };
const nextVer = (p) => { const v = verAt(p, 0).split('.').map(Number); return `${v[0]}.${v[1]}.${v[2] + 1}`; };

// ---------------------------------------------------------- 会话和对话 ----

const KINDS_BASE = { bugfix: 22, feature: 22, refactor: 6, test: 7, perf: 6, review: 6, docs: 5, ops: 9, research: 5, debug: 7 };
const KIND_ADJ = { infra: { ops: 3, debug: 2, feature: 0.5 }, 'docs-site': { docs: 4, feature: 1.2, bugfix: 0.8 }, 'data-pipeline': { debug: 1.8, perf: 1.6 }, 'notify-bot': { ops: 0.5 } };
const kindWeights = (p) => Object.fromEntries(Object.entries(KINDS_BASE).map(([k, w]) => [k, w * (KIND_ADJ[p]?.[k] ?? 1)]));

function projectActive(p, k) { const P = PROJECTS[p]; return k <= P.from && k >= P.to; }

// 一天的活跃系数：工作日 1、周末低、几个特别忙的段、一周假期
function dayFactor(k) {
  const wd = wdayOf(k);
  let f = wd === 0 ? 0.3 : wd === 6 ? 0.4 : 1;
  if ((k >= 94 && k <= 101) || (k >= 52 && k <= 58) || (k >= 17 && k <= 22)) f *= 1.7;
  if (k >= 69 && k <= 75) f *= 0.15;
  if (k === 118 || k === 117) f *= 0.3;
  return f;
}

function makePlan(spec) {
  const p = spec.proj;
  const plan = { proj: p, k: spec.k, kind: spec.kind || 'misc', status: 'done' };
  if (!p) {
    const m = pick(MISC);
    Object.assign(plan, { kind: 'misc', miscQ: m[0], miscS: m[1], miscPts: m[2], status: 'done', n: '', file: '', e: 'misc' });
    return plan;
  }
  const P = PROJECTS[p];
  const it = pick(P.items);
  const [sym, fix] = pick(it.bugs).split('|');
  Object.assign(plan, { item: it, n: it.n, file: it.f, e: it.e, sym, fix, feat: pick(it.feats), ops: pick(P.ops), topic: pick(TOPICS), perf: pick(PERFS), refactor: pick(REFACTORS), ver: verAt(p, spec.k), machine: pick(P.machines) });
  if (spec.kind === 'deploy') { plan.ver = spec.ver; plan.status = 'done'; }
  else if (['feature', 'refactor', 'ops', 'bugfix'].includes(plan.kind)) {
    const recent = spec.k <= 20;
    const roll = R();
    if (roll < (recent ? 0.085 : 0.015)) plan.status = 'ongoing';
    else if (roll < (recent ? 0.11 : 0.03)) { plan.status = 'blocked'; plan.blocker = pick(BLOCKERS); }
  }
  return plan;
}

const lastSeg = (s) => s.slice(s.lastIndexOf('/') + 1);

const U_FIRST = {
  bugfix: [(s) => `${s.n}这块有个问题：${s.sym}，帮我定位一下原因。`, (s) => `线上反馈${s.n}有问题：${s.sym}，先看看 ${s.file} 里是不是哪里没处理好。`, (s) => `帮我修一下${s.n}的问题：${s.sym}。`, (s) => `复现了：${s.sym}（${s.n}）。先分析原因，别急着改。`],
  feature: [(s) => `我们要给${s.n}加个功能：${s.feat}。先看看现有代码，说说怎么改最小。`, (s) => `需求：${s.feat}（${s.n}）。先出方案，我确认后你再动手。`, (s) => `在 ${s.file} 里实现“${s.feat}”，写好单元测试。`],
  refactor: [(s) => `${s.file} 已经快 800 行了，帮我拆一下，行为不要变。`, (s) => `${s.n}里的重复逻辑想整理一下：${s.refactor}。先列出会动到哪些文件。`],
  test: [(s) => `给${s.n}补一组集成测试，重点覆盖“${s.sym}”这种情况。`, (s) => `${s.n}相关的测试偶发失败，帮我找出不稳定的用例。`],
  perf: [(s) => `${s.n}接口最近变慢了，帮我看看 profile，找出瓶颈。`, (s) => `${s.n}相关的查询在数据量大时很慢，给个优化方案。`],
  review: [(s) => `帮我 review 一下这次${s.n}的改动，重点看并发和边界。`, (s) => `这是${s.n}的合并请求，先过一遍有没有明显的风险点。`],
  docs: [(s) => `把${s.n}的说明补到文档里，带上请求和响应示例。`, (s) => `${s.n}的文档有些过期了，对照代码更新一下。`],
  deploy: [(s) => `把 ${s.proj} ${s.ver} 发布到 ${s.machine}，先对一下发布清单有没有漏项。`, (s) => `准备发 ${s.ver}：先看变更列表，再决定要不要先灰度。`],
  ops: [(s) => `${s.ops}。`],
  research: [(s) => `调研一下${s.topic}，给我一个对比和建议。`],
  debug: [(s) => `排查一下${s.n}的线上告警：${s.sym}。`, (s) => `${s.n}这边告警了：${s.sym}，帮我看日志缩小范围。`],
  wip: [(s) => `继续做${s.n}：${s.feat}。`],
};
U_FIRST.misc = [(s) => s.miscQ];
const A_READ = [(s) => `我先看了 ${s.file} 和相关测试。目前${s.n}的处理流程是：先读取当前状态，再按规则计算，最后一次性写回，中间没有加保护。`, (s) => `先把 ${s.file} 以及调用它的几处代码过了一遍，入口和数据流都清楚了，下面是我的理解，你看有没有出入。`, (s) => `读完了。这部分逻辑集中在 ${lastSeg(s.file)} 里，对外只有两个入口，改动面不大。`];
const A_CAUSE = [(s) => `问题出在${s.n}的更新逻辑上：${s.sym}。我的处理思路是：${s.fix}。`, (s) => `定位到了：${s.sym}，根源是边界条件没处理。准备这样改：${s.fix}。`];
const A_PLAN = [(s) => `方案如下：1）在 ${s.file} 里新增处理分支，实现“${s.feat}”；2）配置项放进现有配置，默认保持旧行为；3）补单测，再走一遍灰度开关。预计改动 3 个文件。`, (s) => `我建议分两步：先把“${s.feat}”所需的数据结构补齐，再接入调用方，每一步都能单独合并和回滚。`];
const A_IMPL = [(s) => `已经改好了，改动集中在 ${s.file}，另外补了 ${range(2, 6)} 个测试用例，包含刚才说的边界情况。`, (s) => `改完了，涉及 ${range(2, 5)} 个文件（+${range(30, 160)}/-${range(5, 60)} 行），原有行为保持不变。`];
const A_TEST = [() => `跑了相关测试，${range(12, 48)} 个用例全部通过，没有新增告警。`, () => '本地和 CI 都过了，覆盖率没有下降。', () => `全量测试跑完了，${range(120, 360)} 个用例通过，耗时 ${range(1, 4)} 分 ${range(5, 55)} 秒。`];
const A_ASK = [(s) => `顺带提一句：${s.n}附近还有一处类似的写法，要不要一起处理？`, (s) => `提交信息我先按“fix(${s.e}): handle edge case in ${lastSeg(s.file)}”写好了，你确认后我再提交。`, () => '这个改动会影响一个调用方，我已经确认过它不依赖旧行为。'];
const A_DEPLOY1 = [(s) => `发布清单核对完毕：数据库迁移 ${range(0, 3)} 个，配置项 ${range(0, 4)} 个，均已就绪。建议先灰度 10%，观察 30 分钟再放量。`];
const A_DEPLOY2 = [(s) => `已经发布 ${s.ver}，健康检查通过，错误率和延迟与上个版本持平。回滚命令我记在发布说明里了。`, (s) => `${s.machine} 上的 ${s.proj} 已更新到 ${s.ver}，冒烟用例全部通过。`];
const A_RES = [(s) => `我对比了三种做法：1）直接复用现有组件；2）加一层薄封装；3）引入新的库。倾向第二种：改动小、可以回滚，也不增加依赖。关于${s.topic}，要点我整理成了一页。`];
const A_OPS = [(s) => `已完成：${s.ops}。改动了 ${range(2, 6)} 个配置文件，原文件都留了备份，回滚时直接换回即可。`];
const A_REVIEW = [(s) => `过了一遍，主要有 ${range(2, 5)} 处建议：并发场景下的状态更新需要加保护；错误分支缺少日志；${s.n}的边界值没有覆盖测试。其余没有发现问题。`];
const A_PERF = [(s) => `profile 显示耗时主要在重复查询上。调整后${s.perf}，已经在本地压测里验证过。`];
const A_MISC = [(s) => `${s.miscS}。你看看是否符合预期，需要的话我再调整。`, () => '已经按你说的改好了，也加了简单的注释，方便以后自己看。'];
const FOLLOW = ['好的，继续', '先别动别的，只改这一处', '跑一下相关测试', '把日志也贴出来看看', '再检查一下边界情况，比如空值和并发', '提交吧，信息写英文', '这个方案可以，按它来', '为什么这里要加锁？', '有没有更小的改法', 'ok，发预发看看', '合并吧', '先不合，我再看看', '继续', '好', '看下日志', '可以了', '再跑一遍', '不对，再看看', '行，就这样'];

const F_AFTER_READ = ['先出方案', '好的，继续', '按你的理解来，先别动代码', '先把现状讲清楚'];
const F_AFTER_PLAN = ['这个方案可以，按它来', '有没有更小的改法', '为什么这里要加锁？', '先只改这一处', '行，开始吧'];
const F_AFTER_IMPL = ['跑一下相关测试', '再检查一下边界情况，比如空值和并发', '给我看看改动的 diff', '把日志也贴出来看看'];
const F_AFTER_TEST = ['提交吧，信息写英文', '合并吧', 'ok，发预发看看', '先不合，我再看看', '再跑一遍'];
const F_AFTER_ASK = ['好，一起处理', '不用，下次再说', '可以了', '继续', '行，就这样'];
const FOLLOW_OF = new Map([[A_READ, F_AFTER_READ], [A_CAUSE, F_AFTER_PLAN], [A_PLAN, F_AFTER_PLAN], [A_PERF, F_AFTER_PLAN], [A_REVIEW, F_AFTER_ASK], [A_IMPL, F_AFTER_IMPL], [A_TEST, F_AFTER_TEST], [A_ASK, F_AFTER_ASK], [A_DEPLOY1, ['先灰度', '按清单来，开始发布']], [A_DEPLOY2, F_AFTER_TEST], [A_OPS, F_AFTER_ASK], [A_RES, F_AFTER_PLAN]]);
const CONTEXT = ['背景：这是最近一次迭代里排的需求。', '相关日志已经放在项目目录的 logs 下了。', '注意不要改对外的接口签名。', '时间比较紧，今天想先发到预发环境。', '之前同事处理过类似的，可以参考提交历史。'];
const detailOf = (s) => `\n\n${sample([`- 入口：${s.file || '相关模块'}`, `- 影响范围：${s.n || '相关'}涉及的 ${range(1, 4)} 个调用方`, `- 风险：${pick(['并发写入', '旧数据兼容', '灰度期间两套逻辑并存', '时区和边界值'])}`, `- 验证方式：${pick(['本地单测', '预发环境回放线上流量', '压测对比', '人工走查关键路径'])}`], range(2, 3)).join('\n')}`;

function arcFor(kind) {
  switch (kind) {
    case 'bugfix': case 'debug': return [A_READ, A_CAUSE, A_IMPL, A_TEST, A_ASK];
    case 'feature': case 'wip': case 'refactor': return [A_READ, A_PLAN, A_IMPL, A_TEST, A_ASK];
    case 'test': return [A_READ, A_IMPL, A_TEST, A_ASK];
    case 'perf': return [A_READ, A_PERF, A_IMPL, A_TEST];
    case 'review': return [A_READ, A_REVIEW, A_ASK];
    case 'docs': return [A_READ, A_IMPL, A_ASK];
    case 'deploy': return [A_DEPLOY1, A_DEPLOY2, A_TEST];
    case 'ops': return [A_READ, A_OPS, A_ASK];
    case 'research': return [A_RES, A_ASK];
    default: return [A_MISC, A_MISC];
  }
}

function dialog(plan, pairs) {
  const kind = plan.status === 'ongoing' || plan.status === 'blocked' ? 'wip' : plan.kind;
  const first = pick(U_FIRST[kind] || U_FIRST.bugfix)(plan);
  const msgs = [{ r: 'user', x: plan.kind !== 'misc' && chance(0.5) ? `${first}\n\n${pick(CONTEXT)}` : first }];
  const arc = arcFor(kind === 'wip' ? 'feature' : plan.kind);
  for (let i = 0; i < pairs; i++) {
    const bank = arc[i] || pick([A_IMPL, A_TEST, A_ASK]);
    let x = pick(bank)(plan);
    if (plan.kind !== 'misc' && bank !== A_TEST && chance(0.85)) x += detailOf(plan);
    msgs.push({ r: 'assistant', x });
    if (i < pairs - 1) msgs.push({ r: 'user', x: pick(FOLLOW_OF.get(bank) || FOLLOW) });
  }
  if (plan.status === 'blocked') msgs.push({ r: 'user', x: `先放一放，${plan.blocker}。` }, { r: 'assistant', x: '好的，我把当前进度和待确认的问题记在了笔记里，等那边有结果再接着做。' });
  return msgs;
}

function titleOf(plan) {
  const n = plan.n;
  switch (plan.kind) {
    case 'bugfix': return `修复${n}：${plan.sym}`;
    case 'feature': return `实现${plan.feat}`;
    case 'refactor': return `重构${n}：${plan.refactor}`;
    case 'test': return `补${n}的集成测试`;
    case 'perf': return `优化${n}性能`;
    case 'review': return `review ${n}的改动`;
    case 'docs': return `补${n}的文档`;
    case 'deploy': return `发布 ${plan.proj} ${plan.ver}`;
    case 'ops': return plan.ops;
    case 'research': return `调研${plan.topic}`;
    case 'debug': return `排查${n}告警`;
    default: return plan.miscQ.slice(0, 28);
  }
}

// 工作日志：同一个计划在会话的每一天各出一段
function journalFor(plan, partIdx, parts) {
  const P = PROJECTS[plan.proj];
  const r = pick(RESULTS[plan.kind === 'bugfix' ? 'bugfix' : plan.kind === 'feature' ? 'feature' : 'other']);
  const site = P?.site && chance(0.2) ? `（${P.site} 现场反馈）` : '';
  const mach = plan.machine && chance(0.5) ? `，在 ${plan.machine} 上验证通过` : '';
  let summary; let points = [];
  const n = plan.n;
  if (plan.status === 'ongoing') summary = `${n}：${plan.feat}，完成了约 ${range(3, 8) * 10}%，${pick(REMAIN)}`;
  else if (plan.status === 'blocked') summary = `${n}：${plan.feat}，卡住了：${plan.blocker}`;
  else switch (plan.kind) {
    case 'bugfix': summary = pick([`修复${n}：${plan.sym}${site}，${r}${mach}`, `定位并修复${n}：${plan.sym}（${plan.fix}），${r}`]); points = [`处理办法：${plan.fix}`, `改动集中在 ${plan.file}`, `补了 ${range(1, 4)} 个回归用例`]; break;
    case 'feature': summary = pick([`${n}新增功能：${plan.feat}，${r}${mach}`, `实现${plan.feat}（${n}），${r}`]); points = [`改动集中在 ${plan.file}`, `新增 ${range(2, 8)} 个测试用例`, '默认保持旧行为，靠开关放量']; break;
    case 'refactor': summary = `重构${n}模块：${plan.refactor}，行为不变，${r}`; points = [`涉及 ${range(2, 6)} 个文件`, '原有测试全部通过']; break;
    case 'test': summary = `补${n}的集成测试，覆盖“${plan.sym}”等场景，${r}`; points = [`新增 ${range(3, 10)} 个用例`, '顺带修了一个不稳定的用例']; break;
    case 'perf': summary = `优化${n}相关查询，${plan.perf}，${r}`; points = ['先 profile 再改，只动了热点路径', '压测对比已记入 wiki']; break;
    case 'review': summary = `review ${n}相关改动，提出 ${range(2, 6)} 处修改意见`; points = ['并发和边界是主要关注点']; break;
    case 'docs': summary = `补写${n}的说明和示例，${r}`; points = ['示例请求和响应都实际跑过']; break;
    case 'deploy': summary = pick([`发布 ${plan.proj} ${plan.ver}，已部署到 ${plan.machine}，冒烟通过`, `${plan.proj} ${plan.ver} 已部署到 ${plan.machine}，灰度观察后放量`]); points = [`发布清单逐项核对`, `回滚方案已备好`]; break;
    case 'ops': summary = `${plan.ops}，${r}${mach}`; points = ['改动前已备份原配置']; break;
    case 'research': summary = `调研${plan.topic}，对比后倾向“加一层薄封装”的做法`; points = ['整理了一页对比', '结论待团队讨论']; break;
    case 'debug': summary = `排查${n}线上告警：${plan.sym}，${r}`; points = [`处理办法：${plan.fix}`, '补了对应的监控项']; break;
    default: summary = plan.miscS; points = plan.miscPts;
  }
  if (parts > 1 && partIdx > 0) summary = `接着上一天：${summary}`;
  return { summary: summary.slice(0, 280), points: points.slice(0, 4).map((x) => x.slice(0, 150)), status: partIdx === parts - 1 ? plan.status : 'done' };
}

// ------------------------------------------------------------ 会话生成 ----

const sessions = [];
let sidSeq = 0;
function buildSession(spec) {
  const d = DEV[spec.dev];
  const plan = spec.plan || makePlan({ proj: spec.proj, k: spec.k, kind: spec.kind, ver: spec.ver });
  const pairs = spec.pairs || (plan.kind === 'deploy' ? range(3, 6) : plan.kind === 'misc' ? range(1, 3) : plan.status !== 'done' ? range(3, 8) : pickW({ 2: 2, 3: 4, 4: 6, 5: 6, 7: 5, 10: 3, 16: 2 }));
  const dlg = dialog(plan, Number(pairs));
  let t = spec.start;
  const msgs = [];
  for (const m of dlg) {
    msgs.push({ role: m.r, text: m.x, ts: iso(t) });
    t += m.r === 'user' ? range(8, 60) * 1000 : (chance(0.12) ? range(8, 40) * MIN : range(20, 360) * 1000);
  }
  // 跨天续做：隔一两天回来接着聊几句
  if (spec.resume) {
    let rt = spec.start + spec.resume * DAY + range(-2, 3) * 3600e3;
    for (let i = 0; i < range(2, 4); i++) {
      msgs.push({ role: 'user', text: pick(FOLLOW), ts: iso(rt) }, { role: 'assistant', text: pick([A_TEST, A_ASK, A_IMPL])[0](plan) || '好的。', ts: iso(rt + range(10, 90) * 1000) });
      rt += range(2, 12) * MIN;
    }
  }
  const limit = spec.live ? NOW : NOW - 25 * MIN;
  const kept = msgs.filter((m) => Date.parse(m.ts) <= limit);
  if (!kept.length || kept[0].role !== 'user') return null;
  const tool = spec.tool;
  const proj = plan.proj;
  const cwd = `${d.home}/code/${proj || 'scratch'}`;
  const s = { dev: spec.dev, tool, sid: `${tool.slice(0, 2)}-${(++sidSeq).toString(36).padStart(4, '0')}-${crypto.createHash('sha1').update(`${SEED}:${sidSeq}`).digest('hex').slice(0, 8)}`, title: titleOf(plan).slice(0, 80), cwd, started: kept[0].ts, messages: kept, plan, live: Boolean(spec.live) };
  s.key = `${s.dev}__${s.tool}__${s.sid}`.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200);
  sessions.push(s);
  return s;
}

function genSessions() {
  // 版本发布：每个发布日一个发布会话
  const relSpecs = [];
  for (const [p, list] of Object.entries(releases)) {
    for (const r of list) {
      if (r.k < 1) continue;
      const wd = wdayOf(r.k);
      const k = wd === 6 ? r.k + 2 : wd === 0 ? r.k + 1 : r.k;
      if (k > DAYS - 1) continue;
      const devs = DEVICES.filter((d) => d.proj[p] && (!d.until || k > d.until) && (!d.from || k < d.from));
      relSpecs.push({ k, p, ver: r.ver, dev: pick(devs).name });
    }
  }
  for (let k = DAYS - 1; k >= 0; k--) {
    const f = dayFactor(k);
    for (const d of DEVICES) {
      if ((d.until && k <= d.until) || (d.from && k > d.from)) continue;
      const lam = d.rate * f * (d.hours === 'office' && [0, 6].includes(wdayOf(k)) ? 0.1 : 1);
      let n = Math.floor(lam) + (R() < lam - Math.floor(lam) ? 1 : 0);
      if (chance(0.12)) n += 1; // 偶尔多聊几个
      for (let i = 0; i < n; i++) {
        const hour = Number(pickW(Object.fromEntries(HOURS[d.hours].map((w, h) => [h, w]))));
        const start = dayStart(k) + hour * 3600e3 + rnd(60) * MIN + rnd(60) * 1000;
        if (start > NOW - 30 * MIN) continue;
        const projW = Object.fromEntries(Object.entries(d.proj).filter(([p]) => !p || projectActive(p, k)));
        const proj = pickW(projW);
        const tool = pickW(d.tools);
        const kind = proj ? pickW(kindWeights(proj)) : 'misc';
        buildSession({ k, dev: d.name, tool, proj, kind, start, resume: chance(0.07) ? range(1, 3) : 0 });
      }
    }
    for (const r of relSpecs.filter((x) => x.k === k)) {
      const d = DEV[r.dev];
      const tool = pickW(d.tools);
      buildSession({ k, dev: r.dev, tool, proj: r.p, kind: 'deploy', ver: r.ver, start: dayStart(k) + range(14, 18) * 3600e3 + rnd(50) * MIN, pairs: range(3, 5) });
    }
  }
  // 最近 20 分钟内"正在干活"的两个会话
  const live1 = makePlan({ proj: 'shop-api', k: 0, kind: 'feature' });
  live1.status = 'ongoing';
  buildSession({ k: 0, dev: 'desktop', tool: 'claude-code', plan: live1, start: NOW - 52 * MIN, pairs: 12, live: true });
  const live2 = makePlan({ proj: 'infra', k: 0, kind: 'ops' });
  live2.status = 'ongoing';
  buildSession({ k: 0, dev: 'build-server', tool: 'codex', plan: live2, start: NOW - 31 * MIN, pairs: 8, live: true });
  // 实时会话的最后一条消息要落在最近 20 分钟里
  for (const [s, ago] of [[sessions[sessions.length - 2], 3], [sessions[sessions.length - 1], 9]]) {
    const last = Date.parse(s.messages[s.messages.length - 1].ts);
    const shift = NOW - ago * MIN - last;
    for (const m of s.messages) m.ts = iso(Date.parse(m.ts) + shift);
    s.started = s.messages[0].ts;
  }
}

// --------------------------------------------------------------- 记忆 ----

const grams = (s) => { const t = String(s || '').toLowerCase().replace(/[\s\p{P}]+/gu, ''); const o = new Set(); for (let i = 0; i < t.length - 1; i++) o.add(t.slice(i, i + 2)); return o; };
const jaccard = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n); };

function genAtoms() {
  const atoms = []; // {type,title,body,project,subject,tags,k,tag}
  const lastK = (p) => PROJECTS[p].to;
  const add = (a) => { atoms.push(a); return a; };
  // 项目现状（每个项目 3–4 条，subject 不同）
  for (const p of PNAMES) {
    const P = PROJECTS[p];
    const its = shuffle(P.items);
    const kBase = P.to; // 停了的项目，现状也停在停止前后
    const subjects = [
      ['prod-version', (k) => ({ title: `${p} 线上版本 ${verAt(p, k)}`, body: `当前线上版本 ${verAt(p, k)}，上次发布在 ${dayStr(Math.max(k, releases[p].filter((r) => r.k >= k).slice(-1)[0]?.k ?? k))}。下一个计划版本 ${nextVer(p)}，预计包含：${its[0].feats[0]}；${its[1].feats[0]}。` })],
      ['current-focus', () => ({ title: `${p} 近期重点：${its[0].n}、${its[1].n}`, body: `正在做：${its[0].feats[1] || its[0].feats[0]}（${its[0].n}）；${its[1].feats[0]}（${its[1].n}）。已知卡点：${pick(BLOCKERS)}。` })],
      ['open-risks', () => ({ title: `${p} 已知风险：${its[2 % its.length].bugs[0].split('|')[0]}`, body: `${its[2 % its.length].n}：${its[2 % its.length].bugs[0].split('|')[0]}，目前的临时处理是${its[2 % its.length].bugs[0].split('|')[1]}。还没有完整方案，遇到相关告警先看这条。` })],
      ['next-milestone', () => ({ title: `${p} 下个里程碑：${its[3 % its.length].feats[0]}`, body: `目标版本 ${nextVer(p)}，范围：${its[3 % its.length].feats[0]}（${its[3 % its.length].n}）；${its[4 % its.length].feats[1] || its[4 % its.length].feats[0]}（${its[4 % its.length].n}）。依赖：${pick(BLOCKERS)}。` })],
      ['oncall', () => ({ title: `${p} 值班注意事项`, body: `告警先看${its[1].n}和${its[5 % its.length].n}两块；${pick(['夜间告警先按值班手册排查，不要直接重启', '发版期间暂停非紧急变更', '重启前先确认没有进行中的批处理'])}。` })],
      ['test-env', () => ({ title: `${p} 预发环境状态`, body: `预发环境部署的是 ${verAt(p, 3)}，数据每周一重置；${pick(['缓存和数据库都是独立实例', '第三方接口走沙箱', '定时任务默认关闭'])}。` })],
    ];
    const count = p === 'notify-bot' ? 3 : 6;
    subjects.slice(0, count).forEach(([sub, mk], i) => {
      const stale = (['test-env', 'oncall', 'next-milestone'].includes(sub) && chance(0.55)) || (p === 'mobile-app' && sub === 'open-risks') || (p === 'shop-api' && sub === 'open-risks');
      const k = stale ? range(36, 75) : kBase > 0 ? kBase + range(0, 6) : sub === 'prod-version' ? range(0, 4) : range(0, 16);
      const x = mk(k);
      add({ type: 'status', ...x, project: p, subject: `${p}/${sub}`, tags: [p], k: Math.min(k, DAYS - 2), tag: sub });
    });
  }
  // 决定：来自功能点
  const decisions = [];
  for (const p of PNAMES) for (const it of PROJECTS[p].items) for (const f of it.feats) decisions.push({ p, it, f });
  for (const { p, it, f } of sample(decisions, 80)) {
    const P = PROJECTS[p];
    const k = Math.max(P.to, Math.min(DAYS - 3, Math.floor(-Math.log(1 - R()) * 40)));
    const c = pick(CHOICES);
    add({ type: 'decision', title: `${p}：${f}，${c}`, body: `背景：${pick(BACKGROUNDS)}。\n决定：${f}，${c}。\n放弃的做法：${pick(ALTS)}。\n影响范围：${it.n}相关模块，改动入口在 ${it.f}。`, project: p, subject: '', tags: [p, it.n], k });
  }
  // 坑：来自 bug
  const pits = [];
  for (const p of PNAMES) for (const it of PROJECTS[p].items) for (const b of it.bugs) pits.push({ p, it, b });
  for (const { p, it, b } of sample(pits, 84)) {
    const [sym, fix] = b.split('|');
    const P = PROJECTS[p];
    const k = Math.max(P.to, Math.min(DAYS - 3, Math.floor(-Math.log(1 - R()) * 42)));
    add({ type: 'pitfall', title: `${it.n}：${sym}（${p}）`, body: `现象：${it.n}，${sym}。\n原因与处理：${fix}。\n提醒：改动 ${it.f} 相关逻辑时，先跑一遍对应的回归用例。`, project: p, subject: '', tags: [p, it.n], k });
  }
  // 事实与参考
  for (const p of PNAMES) {
    const P = PROJECTS[p];
    P.facts.forEach((f) => add({ type: 'fact', title: `${p}：${f}`, body: `${f}。\n补充：${pick(NOTES)}`, project: p, subject: '', tags: [p], k: Math.max(P.to, range(3, 70)) }));
    P.refs.forEach((f) => add({ type: 'reference', title: `${p}：${f}`, body: `${f}。\n补充：${pick(NOTES)}`, project: p, subject: '', tags: [p], k: Math.max(P.to, range(3, 90)) }));
  }
  [['所有项目的日志、报表和对账一律按北京时间切分日期，时区转换只在展示层做', 'fact'], ['内部 wiki 的搜索只覆盖标题和前两百字，找不到时直接翻对应项目的目录页', 'reference'], ['值班手册在运维 wiki 的「值班」页，夜间告警先按手册里的顺序排查', 'reference'], ['构建服务器上同时只允许跑两条流水线，再多会拖慢所有构建', 'fact'], ['家庭 NAS 的机械盘是 /backup，固态盘只放热数据；备份和快照不要放固态盘', 'fact'], ['公司网络访问外部仓库需要走代理，脚本里读环境变量里的代理设置', 'fact']]
    .forEach(([t, ty]) => add({ type: ty, title: t, body: `${t}。\n补充：${pick(NOTES)}`, project: '', subject: '', tags: [], k: range(5, 100) }));
  // 偏好与反馈
  PREFS.forEach(([t, b]) => add({ type: 'preference', title: t, body: `${t}\n\n背景：${b}`, project: '', subject: '', tags: [], k: range(8, 125) }));
  FEEDBACKS.forEach(([t, b]) => add({ type: 'feedback', title: t, body: `${t}\n\n背景：${b}`, project: '', subject: '', tags: [], k: range(3, 110) }));
  return atoms;
}

// ------------------------------------------------------------ HTTP 工具 ----

let BASE = '';
async function call(method, route, { token, body, client, raw } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (client) headers['x-agent-client'] = client;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${route}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (raw) return { status: res.status, text };
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status} ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
}
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const it = items[i++]; await fn(it); } }));
}
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); s.on('error', reject); });
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v, mode) => fs.writeFileSync(f, JSON.stringify(v, null, 1), mode ? { mode } : undefined);

// ------------------------------------------------------------------ 主流程 ----

async function main() {
  const t0 = Date.now();
  const log = (...a) => console.log(...a);
  genSessions();
  const atoms = genAtoms();
  log(`生成 ${sessions.length} 个会话、${atoms.length} 条记忆素材 ...`);

  // 目录、配置
  const p = (...x) => path.join(TARGET, ...x);
  for (const d of ['repo', 'state', 'cards', 'archive']) fs.mkdirSync(p(d), { recursive: true });
  fs.writeFileSync(p('archive', '.am-archive'), '');
  const config = {
    listen: '127.0.0.1', port: PORT, public_url: `http://127.0.0.1:${PORT}`,
    repo: p('repo'), state: p('state'), tokens: p('tokens.json'), cards_dir: p('cards'), archive_dir: p('archive'),
    auto_register_deny: [], disabled_tools: ['kb_map'], auto_approve_days: 365, stale_hours: 3, digest_budget: 13800,
    console_viewer: 'desktop',
    device_labels: Object.fromEntries(DEVICES.map((d) => [d.name, d.label])),
    graph_entities: { machine: DEVICES.map((d) => d.name), site: ['lakeside-mall', 'harbor-depot'] },
  };
  fs.writeFileSync(p('config.json'), `${JSON.stringify(config, null, 2)}\n`);
  const genPort = await freePort();
  fs.writeFileSync(p('config.gen.json'), JSON.stringify({ ...config, port: genPort, public_url: `http://127.0.0.1:${genPort}` }));
  const env = { ...process.env, AGENT_MEMORY_CONFIG: p('config.gen.json') };

  // 设备令牌：用中心自己的命令行生成，再把创建时间和接入方式改成"用了几个月"的样子
  const tok = {};
  for (const d of DEVICES) tok[d.name] = execFileSync(process.execPath, [SERVER, 'add-device', d.name], { env, encoding: 'utf8' }).trim();
  tok['journal-bot'] = execFileSync(process.execPath, [SERVER, 'add-device', 'journal-bot', 'extractor'], { env, encoding: 'utf8' }).trim();
  tok['daily-report'] = execFileSync(process.execPath, [SERVER, 'add-device', 'daily-report', 'reporter'], { env, encoding: 'utf8' }).trim();
  const tokens = readJson(p('tokens.json'), { devices: {} });
  for (const d of DEVICES) { tokens.devices[d.name].created = iso(NOW - d.created * DAY + rnd(10) * 3600e3); if (d.via !== 'token') tokens.devices[d.name].via = d.via === 'gateway' ? 'gateway' : 'join'; }
  tokens.devices['journal-bot'].created = iso(NOW - 140 * DAY);
  tokens.devices['daily-report'].created = iso(NOW - 120 * DAY);
  writeJson(p('tokens.json'), tokens, 0o600);
  // 网关认出的机器：记在 peers.json 里（设备页的"身份"一列）
  const peers = {};
  for (const d of DEVICES.filter((x) => x.via === 'gateway')) peers[d.name] = { peer: `tailnet:${d.name}`, aliases: [`tailnet:${d.name}`], os: d.os, seen: iso(NOW - d.seen * MIN), first: iso(NOW - d.created * DAY) };
  writeJson(p('state', 'peers.json'), peers);

  // 起临时中心
  const child = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let hubLog = '';
  child.stdout.on('data', (b) => { hubLog += b; });
  child.stderr.on('data', (b) => { hubLog += b; });
  BASE = `http://127.0.0.1:${genPort}`;
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* 还没起来 */ }
    if (i > 150 || child.exitCode !== null) die(`临时中心没起来：\n${hubLog}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const stopHub = async () => { child.kill('SIGTERM'); await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r))); };

  let entryIds = [];
  try {
    // ---- 记忆 ----
    const agentVer = /const VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'agent', 'kb-agent.mjs'), 'utf8'))?.[1] || '0.9.0';
    const devOfProject = (proj, tools) => {
      const cands = DEVICES.filter((d) => (!proj || d.proj[proj]) && (!tools || d.native.some((t) => tools.includes(t))));
      return pick(cands.length ? cands : DEVICES.slice(0, 3));
    };
    const NATIVE_CLAUDE = { preference: 'user', feedback: 'feedback', status: 'project', reference: 'reference' };
    const channelOf = (a) => {
      if (a.type === 'status') return chance(0.5) ? 'native' : 'import';
      if (a.type === 'preference' || a.type === 'feedback') return chance(0.7) ? 'native' : 'import';
      if (a.type === 'reference') return chance(0.4) ? 'native' : 'import';
      return pickW({ import: 6, explicit: 1, native: 1.6 });
    };
    // 要做重复的坑：复制几条标题略有出入的条目（同类型，二元组相似度够高）
    const dupSrc = sample(atoms.filter((a) => a.type === 'pitfall'), 6);
    const dups = [];
    for (const a of dupSrc) {
      const core = a.title.replace(/（.*?）$/, '');
      const b = { ...a, title: `${a.project}：${core}`, k: Math.max(0, a.k - range(2, 9)), dupOf: a };
      if (jaccard(grams(a.title), grams(b.title)) >= 0.6 && grams(b.title).size) dups.push(b);
    }
    atoms.push(...dups.slice(0, 5));
    // 候选（会话抽取）：从素材里拿一批最近的决定/坑/现状
    const candPool = shuffle(atoms.filter((a) => ['decision', 'pitfall', 'status', 'fact'].includes(a.type) && a.k <= 40 && !a.dupOf && a.type !== 'status'));
    const candAtoms = candPool.slice(0, 20);
    candAtoms.forEach((a, i) => { a.channel = 'extract'; a.pending = i < 9; a.k = a.pending ? range(0, 6) : range(7, 38); });
    // 额外两条候选是"过期现状"之外的新现状
    for (const a of atoms) if (!a.channel) a.channel = a.dupOf ? 'import' : channelOf(a);
    for (const a of atoms) {
      a.dev = a.dupOf ? pick(DEVICES.filter((d) => d.name !== a.dupOf.dev)).name : devOfProject(a.project, a.channel === 'native' ? ['claude-code', 'hermes', 'workbuddy', 'codebuddy', 'openclaw'] : null).name;
    }
    // 原生记忆：按 设备/工具 分组同步
    const nativeBy = new Map();
    for (const a of atoms.filter((x) => x.channel === 'native')) {
      const d = DEV[a.dev];
      const opts = d.native.filter((t) => t !== 'claude-code' || NATIVE_CLAUDE[a.type]);
      if (!opts.length) { a.channel = 'import'; continue; }
      a.tool = opts.includes('claude-code') && chance(0.7) ? 'claude-code' : pick(opts);
      const k = `${a.dev}|${a.tool}`;
      (nativeBy.get(k) || nativeBy.set(k, []).get(k)).push(a);
    }
    let nCount = 0;
    for (const [key, list] of nativeBy) {
      const [dev, tool] = key.split('|');
      const files = list.map((a, i) => {
        const mtime = iso(dayStart(a.k) + range(9, 21) * 3600e3 + rnd(3600) * 1000);
        const slug = `${(a.project || 'general').replace(/[^a-z0-9-]/g, '')}-${a.type}-${i + 1}`;
        if (tool === 'claude-code' || tool === 'codebuddy') {
          const nt = NATIVE_CLAUDE[a.type];
          const head = nt ? `metadata:\n  type: ${nt}` : `type: ${a.type}`;
          return { key: tool === 'claude-code' ? `-${DEV[dev].home.replace(/\//g, '-')}-code-${a.project || 'scratch'}/memory/${slug}.md` : `memery/${slug}_memery.md`, mtime, content: `---\nname: ${a.subject || slug}\ndescription: ${a.title}\n${head}\n---\n\n${a.body}\n` };
        }
        const rest = a.body.startsWith(a.title) ? a.body.slice(a.title.length).trim() : a.body;
        const dev1 = tool === 'hermes' ? `${a.title}\n${rest}` : `# ${a.title}\n\n${rest}`;
        return { key: `${tool === 'hermes' ? (a.type === 'preference' || a.type === 'feedback' ? 'USER.md' : 'MEMORY.md') : tool === 'workbuddy' ? `memory/${slug}.md` : `workspace/${slug}.md`}${tool === 'hermes' ? `§${i + 1}` : ''}`, mtime, content: dev1.trim(), type_hint: a.type, subject_hint: slug };
      });
      await call('POST', '/v1/native/sync', { token: tok[dev], client: tool, body: { tool, files, present: files.map((f) => f.key) } });
      nCount += files.length;
    }
    log(`原生记忆同步 ${nCount} 条`);

    // 导入（旧卡片拆分）：按 来源 分组，保留信息本身的日期
    const impBy = new Map();
    for (const a of atoms.filter((x) => x.channel === 'import')) {
      const src = `笔记整理:${a.project || '通用'}`;
      (impBy.get(`${src}|${a.dev}`) || impBy.set(`${src}|${a.dev}`, []).get(`${src}|${a.dev}`)).push(a);
    }
    let iCount = 0;
    for (const [key, list] of impBy) {
      const [source, dev] = key.split('|');
      const entries = list.map((a, i) => ({ key: `${a.type}-${i + 1}-${crypto.createHash('sha1').update(a.title).digest('hex').slice(0, 6)}`, type: a.type, title: a.title, body: a.body, subject: a.subject, project: a.project, tags: a.tags, as_of: iso(dayStart(a.k) + range(9, 20) * 3600e3), sources: [] }));
      await call('POST', '/v1/import', { token: tok[dev], client: pick(Object.keys(DEV[dev].tools)), body: { source, entries } });
      iCount += entries.length;
    }
    log(`导入 ${iCount} 条`);

    // 智能体主动写的（remember）：含三组"新现状取代旧现状"
    const explicit = atoms.filter((x) => x.channel === 'explicit');
    const superPairs = [];
    for (const proj of ['shop-api', 'mobile-app', 'data-pipeline']) {
      const sub = `${proj}/rollout`;
      superPairs.push({ proj, sub, old: { type: 'status', title: `${proj} 灰度放量进度：10%`, body: `${verAt(proj, 6)} 已灰度 10%，观察指标正常，等明天决定是否放到 30%。`, project: proj, subject: sub, tags: [proj] }, neu: { type: 'status', title: `${proj} 灰度放量进度：已全量`, body: `${verAt(proj, 2)} 已全量，灰度开关已删除，旧版本保留一周以便回滚。`, project: proj, subject: sub, tags: [proj] } });
    }
    const explicitIds = []; // {id, kind}
    for (const a of explicit) {
      const dev = DEV[a.dev];
      const r = await call('POST', '/v1/remember', { token: tok[a.dev], client: pickW(dev.tools), body: { type: a.type, title: a.title, body: a.body, subject: a.subject, project: a.project, tags: a.tags } });
      explicitIds.push({ id: r.id, k: a.k });
    }
    const supers = [];
    for (const sp of superPairs) {
      const dev = pick(DEVICES.filter((d) => d.proj[sp.proj]));
      const c = pickW(dev.tools);
      const o = await call('POST', '/v1/remember', { token: tok[dev.name], client: c, body: sp.old });
      const n = await call('POST', '/v1/remember', { token: tok[dev.name], client: c, body: sp.neu });
      supers.push({ old: o.id, neu: n.id });
    }
    log(`主动写入 ${explicitIds.length + supers.length * 2} 条`);

    // 会话抽取出来的候选：上传若干 Codex 会话，再由"抽取机"回写候选
    const exDevs = DEVICES.filter((d) => d.tools.codex);
    const exSessions = [];
    const extractorDone = [];
    for (let i = 0; i < 44; i++) {
      const d = pick(exDevs);
      const k = i < 9 ? range(0, 6) : range(7, 40);
      const started = iso(Math.min(dayStart(k) + range(9, 21) * 3600e3, NOW - 40 * MIN));
      const sid = `ex-${i}-${crypto.createHash('sha1').update(`${SEED}:ex:${i}`).digest('hex').slice(0, 6)}`;
      const plan = makePlan({ proj: pick(PNAMES.filter((x) => projectActive(x, k))), k, kind: pick(['bugfix', 'feature', 'debug']) });
      const msgs = dialog(plan, 2).map((m, j) => ({ role: m.r, text: m.x, ts: iso(Date.parse(started) + j * 70e3) }));
      const up = await call('POST', '/v1/sessions', { token: tok[d.name], client: 'codex', body: { tool: 'codex', session_id: sid, title: titleOf(plan), cwd: `${d.home}/code/${plan.proj}`, started, messages: msgs } });
      exSessions.push({ key: up.key, k, plan, dev: d.name });
    }
    // 候选分配给最近的会话：9 条待审，其余 11 条里 8 条保留、3 条不要
    const cands = atoms.filter((a) => a.channel === 'extract');
    const pendingSess = exSessions.filter((s) => s.k <= 6);
    const doneSess = exSessions.filter((s) => s.k > 6);
    const ids = { approve: [], reject: [] };
    for (const [i, a] of cands.entries()) {
      const sess = a.pending ? pendingSess[i % pendingSess.length] : doneSess[i % doneSess.length];
      a.sess = sess;
    }
    const bySess = new Map();
    for (const a of cands) (bySess.get(a.sess.key) || bySess.set(a.sess.key, []).get(a.sess.key)).push(a);
    for (const s of exSessions) {
      const list = bySess.get(s.key) || [];
      await call('POST', '/v1/sessions/result', { token: tok['journal-bot'], body: { key: s.key, candidates: list.map((a) => ({ type: a.type, title: a.title, body: a.body, subject: a.subject, project: a.project, tags: a.tags })) } });
    }
    // 两个刚上传、还在排队的会话，和一个抽取失败的
    for (const [i, k] of [[1, 0], [2, 0], [3, 3]]) {
      const d = pick(exDevs);
      const plan = makePlan({ proj: pick(PNAMES.filter((x) => projectActive(x, k))), k, kind: 'bugfix' });
      const msgs = dialog(plan, 2).map((m, j) => ({ role: m.r, text: m.x, ts: iso(NOW - 3 * 3600e3 - j * 70e3 - k * DAY) }));
      const up = await call('POST', '/v1/sessions', { token: tok[d.name], client: 'codex', body: { tool: 'codex', session_id: `q-${i}`, title: titleOf(plan), cwd: `${d.home}/code/${plan.proj}`, started: msgs[0].ts, messages: msgs } });
      if (i === 3) for (let r = 0; r < 3; r++) await call('POST', '/v1/sessions/result', { token: tok['journal-bot'], body: { key: up.key, error: '模型接口超时' } });
    }
    log(`会话抽取：上传 ${exSessions.length} 个，候选 ${cands.length} 条`);

    // ---- 对话存档 ----
    let sent = 0;
    await pool(sessions, 6, async (s) => {
      const r = await call('POST', '/v1/conv/append', { token: tok[s.dev], client: s.tool, body: { tool: s.tool, session_id: s.sid, title: s.title, cwd: s.cwd, started: s.started, base: 0, messages: s.messages } });
      if (!r.ok) throw new Error(`上传 ${s.key} 失败`);
      if (++sent % 200 === 0) log(`  对话 ${sent}/${sessions.length}`);
    });
    log(`对话存档 ${sessions.length} 个会话、${sessions.reduce((a, s) => a + s.messages.length, 0)} 条消息`);

    // ---- 工作日志（每个会话每天一段；正在进行的实时会话不写）----
    const items = [];
    for (const s of sessions) {
      if (s.live) continue;
      const days = [...new Set(s.messages.map((m) => localDay(Date.parse(m.ts))))].sort();
      const users = (d) => s.messages.filter((m) => m.role === 'user' && localDay(Date.parse(m.ts)) === d).length;
      days.forEach((d, i) => {
        if (!users(d)) return;
        const j = journalFor(s.plan, i, days.length);
        items.push({ key: s.key, date: d, project: s.plan.proj, n: s.messages.filter((m) => localDay(Date.parse(m.ts)) === d).length, ...j });
      });
    }
    for (let i = 0; i < items.length; i += 150) await call('POST', '/v1/journal/result', { token: tok['journal-bot'], body: { items: items.slice(i, i + 150) } });
    log(`工作日志 ${items.length} 段`);

    // ---- 心跳（各设备的接入状态）----
    for (const d of DEVICES) {
      const wiring = {};
      for (const [t, [mcp, notes, memory]] of Object.entries(d.wiring)) wiring[t] = { mcp, ...(notes !== 'none' ? { notes } : {}), memory };
      const sources = {};
      for (const t of d.native) sources[t] = nativeBy.get(`${d.name}|${t}`)?.length || 0;
      await call('POST', '/v1/heartbeat', { token: tok[d.name], client: Object.keys(d.tools)[0], body: { agent_version: agentVer, hostname: d.host, sources, wiring } });
    }

    // ---- 待办标记、候选审批、作废、设备策略（走控制台接口，身份是配置里的 console_viewer）----
    const todos = await call('GET', '/browse/todos');
    for (const t of todos.items.filter((x) => x.age >= 12 && x.status === 'ongoing').slice(0, 2)) await call('POST', '/browse/todo', { body: { ref: t.ref, action: 'done' } });
    const manage = await call('GET', '/browse/manage-data');
    const proposed = manage.entries.filter((e) => e.state === 'proposed' && e.origin === 'extract');
    const pendingTitles = new Set(cands.filter((a) => a.pending).map((a) => a.title));
    const settled = proposed.filter((e) => !pendingTitles.has(e.title));
    // 有的候选所在会话还在排队，它们本来就没有候选；这里只处理已出结果的
    if (settled.length) {
      await call('POST', '/browse/manage-action', { body: { action: 'approve', ids: settled.slice(0, settled.length - 3).map((e) => e.id) } });
      await call('POST', '/browse/manage-action', { body: { action: 'reject', ids: settled.slice(-3).map((e) => e.id) } });
    }
    const dupTitles = new Set(atoms.filter((a) => a.dupOf || dups.some((d) => d.dupOf === a)).map((a) => a.title));
    const retirable = manage.entries.filter((e) => e.state === 'active' && e.origin === 'import' && e.type !== 'preference' && !dupTitles.has(e.title)).slice(0, 40);
    const retireIds = sample(retirable, 6);
    const reasons = ['项目已下线，不再适用', '被新的方案取代', '信息已过时，实际配置已经改了', '重复记录，保留另一条', '临时结论，已验证不成立', '涉及的模块已重构'];
    for (const [i, e] of retireIds.entries()) await call('POST', '/browse/manage-action', { body: { action: 'retire', ids: [e.id], reason: reasons[i % reasons.length] } });
    await call('POST', '/console/api/devices/work-mac', { body: { readonly: true, hide_projects: ['billing'] } });

    // 取回条目清单，给调用记录和改日期用
    const all = await call('GET', '/browse/data');
    entryIds = all.entries.map((e) => ({ id: e.id, type: e.type, client: e.client, author: e.author }));
    log(`记忆库共 ${all.entries.length} 条（含作废和候选）`);
  } finally {
    await stopHub();
  }

  // ---- 停掉中心之后直接写文件的部分 ----
  // 1) 心跳时间：大多数刚同步过，一台很久没同步；抽取机和日报令牌也有最近使用时间
  const hb = readJson(p('state', 'heartbeats.json'), {});
  for (const d of DEVICES) if (hb[d.name]) hb[d.name].last_seen = iso(NOW - d.seen * MIN);
  hb['journal-bot'] = { last_seen: iso(NOW - 38 * MIN), agent_version: '', hostname: '', sources: {}, wiring: {} };
  hb['daily-report'] = { last_seen: iso(NOW - 7 * 3600e3), agent_version: '', hostname: '', sources: {}, wiring: {} };
  writeJson(p('state', 'heartbeats.json'), hb);

  // 2) 调用记录：最近 14 天，工作日多、晚上有峰值；home-nas 在停止同步之后就没有了
  const usagePath = p('state', 'usage.jsonl');
  const existing = fs.existsSync(usagePath) ? fs.readFileSync(usagePath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const OPS = { memory_search: 38, memory_get: 18, memory_timeline: 7, conversation_search: 6, conversation_get: 4, memory_recent: 6, memory_digest: 5, memory_remember: 4, memory_update: 1, memory_handoff: 3, memory_todos: 2.4, memory_entities: 2.2, kb_search: 1.4, kb_read: 0.9, memory_retire: 0.3 };
  const QUERIES = ['购物车 库存', '部署 检查清单', '证书 续期', '灰度 开关', '备份 恢复', '日报 口径', '推送 权限', '订单 超时', '限流', '迁移 回滚', '版本号', '优惠券 并发', '健康检查', '时区', '索引 慢查询', '支付 回调 幂等', '启动 白屏', '缓存 预热'];
  const usage = [];
  const detail = (op, c) => {
    if (op === 'memory_search') return pick(QUERIES);
    if (op === 'memory_get') return pick(entryIds).id;
    if (op === 'conversation_search') return pick(['超卖', '续期失败', '回滚', '灰度', '分区', '白屏']);
    if (op === 'memory_timeline') return pick(['days=7', 'days=3', `project=${pick(PNAMES)}`, `date=${dayStr(range(1, 10)).slice(5)}`]);
    if (op === 'memory_handoff') return pick(PNAMES);
    if (op === 'memory_entities') return pick([...PNAMES, 'build-server', 'home-nas']);
    if (op === 'memory_todos') return pick(['', pick(PNAMES)]);
    if (op === 'memory_remember') return pick(['decision', 'pitfall', 'status']);
    return '';
  };
  for (let k = 13; k >= 0; k--) {
    const f = dayFactor(k) * (k === 0 ? 0.6 : 1);
    for (const d of DEVICES) {
      if (d.until && k <= d.until) continue;
      if (d.from && k > d.from) continue;
      const calls = Math.round(d.rate * 12 * f * (0.7 + R() * 0.6));
      for (let i = 0; i < calls; i++) {
        const hour = Number(pickW(Object.fromEntries(HOURS[d.hours].map((w, h) => [h, w]))));
        const t = dayStart(k) + hour * 3600e3 + rnd(3600) * 1000;
        if (t > NOW - MIN) continue;
        const client = pickW(d.tools);
        let op = pickW(OPS);
        if (d.name === 'work-mac' && /remember|update|retire/.test(op)) op = 'memory_search'; // 只读设备不写
        const cli = chance(0.07);
        usage.push({ t: iso(t), device: d.name, client: cli ? 'cli' : client, op: cli ? `cli:${op.replace(/^memory_/, '')}` : `tool:${op}`, ...(detail(op) ? { d: String(detail(op)) } : {}) });
      }
    }
    // 浏览器里打开控制台、大屏
    if (k <= 10 && wdayOf(k) !== 0 && chance(0.8)) for (let i = 0; i < range(1, 3); i++) usage.push({ t: iso(dayStart(k) + range(9, 22) * 3600e3 + rnd(3600) * 1000), device: 'desktop', client: 'browser', op: pick(['console', 'console', 'wall']) });
  }
  // 几次整理操作（审计页里的"写入"）
  for (const [k, op, dd] of [[5, 'manage:retire', 'm-demo'], [3, 'manage:approve', 'c-demo'], [2, 'console:settings', 'device_labels'], [1, 'manage:merge', 'm-demo2']]) usage.push({ t: iso(dayStart(k) + range(10, 20) * 3600e3), device: 'desktop', client: 'console', op, d: dd });
  const merged = [...usage, ...existing].sort((a, b) => a.t.localeCompare(b.t));
  fs.writeFileSync(usagePath, `${merged.map((u) => JSON.stringify(u)).join('\n')}\n`);

  // 3) 拒收记录（写入前拦截了疑似密钥）和自动保留记录
  const rej = [
    { t: iso(dayStart(4) + 15 * 3600e3), device: 'laptop', client: 'claude-code', where: 'remember:临时调试配置', reason: '口令或密钥赋值' },
    { t: iso(dayStart(2) + 11 * 3600e3), device: 'build-server', client: 'codex', where: 'remember:部署脚本备忘', reason: 'API Key（sk-…）' },
    { t: iso(dayStart(1) + 22 * 3600e3), device: 'desktop', client: 'claude-code', where: 'native:claude-code:deploy-notes.md', reason: '疑似高熵密钥串' },
  ];
  fs.writeFileSync(p('state', 'rejections.jsonl'), `${rej.map((x) => JSON.stringify(x)).join('\n')}\n`);
  fs.writeFileSync(p('state', 'auto-approve.jsonl'), `${[{ t: iso(dayStart(9) + 3 * 3600e3), n: 4 }, { t: iso(dayStart(16) + 3 * 3600e3), n: 6 }].map((x) => JSON.stringify(x)).join('\n')}\n`);

  // 4) 条目的创建/更新时间：非原生的条目是用接口写的，创建时间是"现在"，改成合理的历史时间
  const entDir = p('repo', 'entries');
  const setField = (txt, k, v) => txt.replace(new RegExp(`^${k}: ".*"$`, 'm'), `${k}: ${JSON.stringify(v)}`);
  const getField = (txt, k) => new RegExp(`^${k}: "(.*)"$`, 'm').exec(txt)?.[1];
  let redated = 0;
  for (const f of fs.readdirSync(entDir)) {
    if (!f.endsWith('.md')) continue;
    const fp = path.join(entDir, f);
    let txt = fs.readFileSync(fp, 'utf8');
    const origin = getField(txt, 'origin');
    if (!['import', 'explicit', 'extract'].includes(origin)) continue;
    const updated = Date.parse(getField(txt, 'updated'));
    const created0 = Date.parse(getField(txt, 'created'));
    if (origin === 'import') txt = setField(txt, 'created', iso(Math.max(updated - rnd(25) * DAY - rnd(20) * 3600e3, NOW - 150 * DAY)));
    else if (origin === 'extract') txt = setField(txt, 'created', iso(Math.min(updated + range(2, 20) * 3600e3, created0)));
    else {
      // 智能体主动写的：散落在最近三周
      const at = NOW - range(1, 21) * DAY - rnd(20) * 3600e3;
      txt = setField(setField(txt, 'created', iso(at)), 'updated', iso(at));
    }
    fs.writeFileSync(fp, txt);
    redated++;
  }
  // 被取代的老现状：更新时间改成取代它的那条的创建时间
  const byId = new Map(fs.readdirSync(entDir).filter((f) => f.endsWith('.md')).map((f) => [f.slice(0, -3), path.join(entDir, f)]));
  for (const [id, fp] of byId) {
    let txt = fs.readFileSync(fp, 'utf8');
    const by = getField(txt, 'superseded_by');
    if (!by || !byId.has(by) || getField(txt, 'origin') !== 'explicit') continue;
    const newer = fs.readFileSync(byId.get(by), 'utf8');
    const at = Date.parse(getField(newer, 'created'));
    txt = setField(setField(txt, 'created', iso(at - range(5, 12) * DAY)), 'updated', iso(at));
    fs.writeFileSync(fp, txt);
  }
  execFileSync('git', ['-C', p('repo'), '-c', 'user.name=agent-memory', '-c', 'user.email=hub@agent-memory', 'add', '-A']);
  try { execFileSync('git', ['-C', p('repo'), '-c', 'user.name=agent-memory', '-c', 'user.email=hub@agent-memory', 'commit', '-q', '-m', 'demo data: backdate entries']); } catch { /* 没有变化 */ }
  for (const f of ['config.gen.json', 'config.gen.json.bak']) fs.rmSync(p(f), { force: true });

  const nEnt = fs.readdirSync(entDir).filter((f) => f.endsWith('.md')).length;
  log(`\n演示数据已生成到 ${TARGET}（${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
  log(`  设备 ${DEVICES.length} 台、项目 ${PNAMES.length} 个、会话 ${sessions.length} 个、记忆条目 ${nEnt} 条（改了 ${redated} 条的时间）`);
  log('\n启动：');
  log(`  AGENT_MEMORY_CONFIG=${p('config.json')} node ${path.relative(process.cwd(), SERVER) || SERVER}`);
  log(`  浏览器打开 http://127.0.0.1:${PORT}/   （实时作战室只在生成后 20 分钟内是亮的）`);
}

main().catch((e) => { console.error(e); process.exit(1); });
