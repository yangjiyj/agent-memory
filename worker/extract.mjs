#!/usr/bin/env node
/* 会话抽取任务（worker 机器上每晚一次，也可手动跑）：
 * 从中心取待处理会话 → 用 codex exec 抽候选记忆 → 交回中心（进审批页）。
 *
 * 配置 ~/.config/agent-memory/extractor.json：
 *   { "hub": "http://192.168.122.50:8790", "token": "…(extractor 角色)", "codex": "codex",
 *     "credential_file": "~/.config/agent-memory/llm.env", "max_sessions": 40, "timeout_sec": 900,
 *     "reasoning_effort": "medium" }
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const expand = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const CFG = Object.assign(
  { codex: 'codex', credential_file: '~/.config/agent-memory/llm.env', max_sessions: 40, timeout_sec: 900, reasoning_effort: 'medium' },
  JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/agent-memory/extractor.json'), 'utf8')),
);
const SCHEMA = path.join(HERE, 'extract-schema.json');
const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

async function api(method, p, body) {
  const res = await fetch(`${CFG.hub}${p}`, {
    method,
    headers: { authorization: `Bearer ${CFG.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${txt.slice(0, 200)}`);
  return txt;
}

function credentialEnv() {
  const env = {};
  try {
    for (const line of fs.readFileSync(expand(CFG.credential_file), 'utf8').split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      if (m) env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch { /* 没有凭据文件就用 codex 自己的配置 */ }
  return env;
}

function runCodex(prompt) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'am-extract-'));
  const out = path.join(work, 'out.json');
  const args = [
    'exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral',
    '--output-schema', SCHEMA, '--output-last-message', out, '-C', work,
    '-c', `model_reasoning_effort="${CFG.reasoning_effort}"`,
  ];
  if (CFG.model) args.push('-m', CFG.model);
  args.push('-');
  return new Promise((resolve, reject) => {
    const child = spawn(CFG.codex, args, { env: { ...process.env, ...credentialEnv() }, stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), CFG.timeout_sec * 1000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        if (code === 0 && fs.existsSync(out)) resolve(fs.readFileSync(out, 'utf8'));
        else reject(new Error(`codex 退出码 ${code}：${err.trim().split('\n').slice(-3).join(' | ')}`));
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }
    });
    child.stdin.end(prompt);
  });
}

function buildPrompt(s, titles) {
  const transcript = s.messages
    .map((m) => `[${m.role === 'user' ? '用户' : '助手'}${m.ts ? ' ' + String(m.ts).slice(0, 16).replace('T', ' ') : ''}]\n${m.text}`)
    .join('\n\n');
  return `你是"共享记忆"的整理员。下面是用户和一个 AI 编程助手（${s.tool}，设备 ${s.device}）的一次会话记录，只保留了双方说的话，工具调用都省略了。
请挑出值得长期记住、以后别的智能体也用得上的内容，整理成候选记忆条目。不要运行任何命令，不要读写文件，直接给出结果。

只挑这几类（type）：
- status：某个项目或系统某方面的当前状态（版本、部署在哪、做到哪一步、还差什么）。必须填 subject，格式"<项目>/<方面>"，例如"myapp/客户A现场版本"。
- decision：用户拍板的决定、约定、对外口径。
- pitfall：踩过的坑和教训（现象→原因→以后怎么避免）。
- preference / feedback：用户对工作方式、交付物、沟通方式的偏好或纠正，要能跨项目复用。
- fact：稳定事实（架构、组件关系、机器用途）。
- reference：位置、路径、入口、常用命令。

不要挑：过程流水、一次性的临时状态、闲聊、只在这次会话里有意义的东西、助手没验证过的猜测；
也不要重复"现有记忆"里已经有的内容——除非这次有更新的信息，那就写一条新的 status，并且**沿用现有记忆里同一方面的 subject 原文**（列表里现状条目后面括号里就是 subject 和日期；同 subject 的新现状会自动替代旧的），或在 body 里说清楚更新了什么。
同一个方面在这次会话里前后有变化的，只写会话结束时的最终状态。现有记忆比这次会话日期更新的，不要用这次会话的旧信息去覆盖。
绝对不要写任何密码、口令、API Key、令牌、私钥、认证头。

要求：最多 8 条，宁缺毋滥；没有值得记的就返回空数组。用中文。title 一行说清（不超过 80 字）；body 先写事实本身，再写"为什么/怎么用"，不超过 600 字。
project 用英文短名（如 webapp、api、infra、agent-memory），沿用"现有记忆"里已有的项目名，不确定就留空字符串；tags 2–5 个；不是 status 的 subject 留空字符串。

## 现有记忆（标题，用于去重）
${titles}

## 会话信息
设备 ${s.device}，工具 ${s.tool}，开始于 ${s.started || '未知'}，工作目录 ${s.cwd || '未知'}，标题「${s.title || ''}」

## 会话记录
${transcript}
`;
}

// 同一时间只跑一个抽取（夜间定时和手动补抽不要撞车）
const LOCK = path.join(os.homedir(), '.cache', 'agent-memory-extract.lock');
function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  try {
    const pid = parseInt(fs.readFileSync(LOCK, 'utf8'), 10);
    if (pid && pid !== process.pid) { try { process.kill(pid, 0); return false; } catch { /* 进程已不在 */ } }
  } catch { /* 没有锁 */ }
  fs.writeFileSync(LOCK, String(process.pid));
  return true;
}

async function main() {
  if (!acquireLock()) { log('已有抽取任务在跑，这次跳过'); return; }
  const max = parseInt(process.env.AM_MAX_SESSIONS, 10) || CFG.max_sessions;
  const workers = Math.min(Math.max(parseInt(process.env.AM_CONCURRENCY, 10) || CFG.concurrency || 1, 1), 6);
  const pending = JSON.parse(await api('GET', `/v1/sessions/pending?limit=${max}`));
  if (!pending.length) { log('没有待处理的会话'); return; }
  log(`待处理 ${pending.length} 个会话，并发 ${workers}`);
  let ok = 0;
  let failed = 0;
  const queue = [...pending];
  await Promise.all(Array.from({ length: workers }, () => (async () => {
    for (let p = queue.shift(); p; p = queue.shift()) await processOne(p);
  })()));
  log(`完成：成功 ${ok}，失败 ${failed}`);
  // 一个都没成功说明环境坏了（缺文件、凭据失效、模型不通），让定时任务显示失败，巡检能报出来
  if (failed && !ok) process.exitCode = 1;

  async function processOne(p) {
    const started = Date.now();
    try {
      // 每个会话前重新取一次：前面会话刚抽出的候选也要参与去重
      const titles = await api('GET', '/v1/titles');
      const s = JSON.parse(await api('GET', `/v1/sessions/item?key=${encodeURIComponent(p.key)}`));
      const raw = await runCodex(buildPrompt(s, titles));
      const parsed = JSON.parse(raw);
      const candidates = (Array.isArray(parsed.candidates) ? parsed.candidates : []).slice(0, 8);
      const res = JSON.parse(await api('POST', '/v1/sessions/result', { key: p.key, candidates }));
      ok++;
      log(`ok ${p.key}（${Math.round((Date.now() - started) / 1000)}s）候选 ${res.added}${res.rejected.length ? `，拒收 ${res.rejected.length}` : ''}`);
    } catch (e) {
      failed++;
      log(`失败 ${p.key}：${e.message}`);
      await api('POST', '/v1/sessions/result', { key: p.key, error: e.message }).catch(() => {});
    }
  }
}

main()
  .then(() => fs.rmSync(LOCK, { force: true }))
  .catch((e) => { log(`出错：${e.message}`); fs.rmSync(LOCK, { force: true }); process.exit(1); });
