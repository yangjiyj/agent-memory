#!/usr/bin/env node
/* 容器入口：node docker/entrypoint.mjs [serve | demo | health | <server.mjs 的子命令…>]
 *
 *   serve（默认）  配置文件不存在就按环境变量生成一份（监听 0.0.0.0，数据都放 /data），然后启动中心
 *   demo           卷是空的就用 scripts/demo-data.mjs 在 /data 里生成虚构演示数据，然后启动中心
 *   health         探活（HEALTHCHECK 用）：读配置里的端口，请求 /health
 *   其他           原样交给 server.mjs，例如 add-device my-laptop、join-code 7
 *
 * 环境变量只在"首次生成配置"时读：AM_PUBLIC_URL（设备访问中心用的地址）、AM_GATE_SECRET（和认证网关一致）、
 * AM_CONSOLE_VIEWER（无网关时把浏览器按这台设备算，见 README，只在不对外的地址上用）。
 * 配置已经存在就一个字都不改，想调整直接改配置文件。AM_DATA 可以改数据目录（默认 /data）。
 * 无第三方依赖，Node >= 18。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'hub', 'server.mjs');
const DEMO = path.join(ROOT, 'scripts', 'demo-data.mjs');
const DATA = path.resolve(process.env.AM_DATA || '/data');
const CONFIG = process.env.AGENT_MEMORY_CONFIG || path.join(DATA, 'config.json');
const PORT = 8790;
process.env.AGENT_MEMORY_CONFIG = CONFIG;

const die = (msg) => { console.error(`agent-memory: ${msg}`); process.exit(1); };
const readConfig = () => JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const writeConfig = (cfg) => fs.writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
const publicUrl = () => (process.env.AM_PUBLIC_URL || '').trim().replace(/\/+$/, '');

function generateConfig() {
  const cfg = {
    listen: '0.0.0.0',
    port: PORT,
    public_url: publicUrl() || `http://127.0.0.1:${PORT}`,
    repo: path.join(DATA, 'repo'),
    state: path.join(DATA, 'state'),
    tokens: path.join(DATA, 'tokens.json'),
    cards_dir: path.join(DATA, 'cards'),
    archive_dir: path.join(DATA, 'archive'),
    dist_dir: path.join(DATA, 'dist'),
    gate_secret: process.env.AM_GATE_SECRET || '',
  };
  if (process.env.AM_CONSOLE_VIEWER) cfg.console_viewer = process.env.AM_CONSOLE_VIEWER;
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  writeConfig(cfg);
  console.log(`agent-memory: 已生成 ${CONFIG}`);
}

// 对话存档目录里要有标记文件，否则中心认为存档盘没挂上、拒收设备上传的对话；数据卷就是存档盘
function ensureArchiveMarker() {
  const dir = readConfig().archive_dir;
  if (typeof dir !== 'string' || !path.resolve(dir).startsWith(DATA + path.sep)) return;
  fs.mkdirSync(dir, { recursive: true });
  const mark = path.join(dir, '.am-archive');
  if (!fs.existsSync(mark)) fs.writeFileSync(mark, '');
}

function prepareServe() {
  if (!fs.existsSync(CONFIG)) generateConfig();
  ensureArchiveMarker();
}

function prepareDemo() {
  const ready = path.join(DATA, '.demo-ready');
  if (fs.existsSync(ready)) return;
  fs.mkdirSync(DATA, { recursive: true });
  if (fs.readdirSync(DATA).length) die(`${DATA} 不是空的，也不是演示数据，拒绝在里面生成演示数据。换一个新卷，或者 docker compose down -v 清掉演示卷。`);
  console.log('agent-memory: 首次启动，生成虚构演示数据（一两分钟）……');
  const r = spawnSync(process.execPath, [DEMO, DATA, '--port', String(PORT)], { stdio: 'inherit' });
  if (r.status !== 0) {
    for (const f of fs.readdirSync(DATA)) fs.rmSync(path.join(DATA, f), { recursive: true, force: true }); // 只清掉刚才生成到一半的东西，下次启动重来
    die('演示数据生成失败');
  }
  // 演示配置只监听 127.0.0.1，容器里要监听 0.0.0.0，端口映射才进得来；对外是否可达由 compose 的端口绑定把关
  const cfg = readConfig();
  cfg.listen = '0.0.0.0';
  if (publicUrl()) cfg.public_url = publicUrl();
  writeConfig(cfg);
  fs.writeFileSync(ready, '');
}

function start(args) {
  const child = spawn(process.execPath, [SERVER, ...args], { stdio: 'inherit', env: process.env });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => child.kill(sig));
  child.on('exit', (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
}

async function health() {
  let port = PORT;
  let host = '127.0.0.1';
  try {
    const cfg = readConfig();
    port = cfg.port || PORT;
    if (cfg.listen && !['0.0.0.0', '::'].includes(cfg.listen)) host = cfg.listen;
  } catch { /* 配置还没生成（比如演示数据还在生成），按默认端口探，失败就是还没好 */ }
  try {
    const res = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(4000) });
    process.exit(res.ok ? 0 : 1);
  } catch { process.exit(1); }
}

const [cmd = 'serve', ...rest] = process.argv.slice(2);
if (cmd === 'health') await health();
else if (cmd === 'demo') { prepareDemo(); start([]); }
else if (cmd === 'serve') { prepareServe(); start([]); }
else { prepareServe(); start([cmd, ...rest]); }
