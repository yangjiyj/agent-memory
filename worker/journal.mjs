#!/usr/bin/env node
/* 工作日志任务（worker 机器上，每天 03:10、12:40、19:40 跑；也可手动跑）：
 * 从中心取"等着写日志的段"（某个会话在某一天的对话），几段拼一批交给 codex exec，
 * 每段写一句"做了什么" + 几条要点 + 项目名 + 状态，交回中心存进 journal/。
 *
 * 用 ~/.config/agent-memory/extractor.json（和会话抽取同一个令牌），可加：
 *   journal_batch_chars（每批正文上限，默认 45000）、journal_concurrency（默认 3）、journal_max_batches（每次最多几批，默认 60）、
 *   journal_reasoning_effort（默认 low）
 * 补历史：systemd-run --user --unit=agent-memory-journal-backfill --setenv=AM_JOURNAL_MAX_BATCHES=2000 /usr/bin/node ~/agent-memory/journal.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const expand = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const CFG = Object.assign(
  { codex: 'codex', credential_file: '~/.config/agent-memory/llm.env', timeout_sec: 900, journal_batch_chars: 45000, journal_concurrency: 3, journal_max_batches: 60, journal_reasoning_effort: 'low' },
  JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/agent-memory/extractor.json'), 'utf8')),
);
const SCHEMA = path.join(HERE, 'journal-schema.json');
const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
const TZ = 8 * 3600e3;
const hhmm = (iso) => new Date(Date.parse(iso) + TZ).toISOString().slice(11, 16);

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
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'am-journal-'));
  const out = path.join(work, 'out.json');
  const args = [
    'exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral',
    '--output-schema', SCHEMA, '--output-last-message', out, '-C', work,
    '-c', `model_reasoning_effort="${CFG.journal_reasoning_effort}"`,
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

// 一段对话压到 cap 字以内：用户的话尽量留，助手的话截短；还超就丢中间的助手消息，再不行只留头尾
function compact(msgs, cap) {
  let xs = msgs.map((m) => ({ ...m, text: m.text.length > (m.role === 'user' ? 1500 : 700) ? `${m.text.slice(0, m.role === 'user' ? 1500 : 700)}…` : m.text }));
  const size = () => xs.reduce((a, m) => a + m.text.length + 20, 0);
  if (size() > cap) {
    const lastA = xs.map((m, i) => (m.role === 'assistant' ? i : -1)).filter((i) => i >= 0).slice(-3);
    xs = xs.filter((m, i) => m.role === 'user' || lastA.includes(i) || i < 4);
  }
  if (size() > cap) xs = xs.map((m) => (m.text.length > 400 ? { ...m, text: `${m.text.slice(0, 400)}…` } : m));
  if (size() > cap) xs = [...xs.slice(0, 20), { role: 'user', ts: '', text: '…（中间省略）…' }, ...xs.slice(-60)];
  if (size() > cap) xs = xs.map((m) => ({ ...m, text: m.text.slice(0, 150) }));
  return xs;
}

function segmentText(s, n, cap) {
  const body = compact(s.messages, cap).map((m) => `[${m.role === 'user' ? '用户' : '助手'}${m.ts ? ` ${hhmm(m.ts)}` : ''}] ${m.text}`).join('\n');
  return [
    `=== 段 ${n} ===`,
    `id: ${n}`,
    `设备 ${s.device}，工具 ${s.tool}，日期 ${s.date}，会话标题「${s.title}」${s.cwd ? `，目录 ${s.cwd}` : ''}`,
    s.prev?.length ? `这个会话之前几天的日志：${s.prev.join('；')}` : '',
    '记录：',
    body,
  ].filter(Boolean).join('\n');
}

function buildPrompt(batch, projects) {
  return `你是用户的工作日志整理员。下面是用户和 AI 助手的 ${batch.length} 段会话记录：每段是某个会话在某一天里的对话，只保留了双方说的话（工具调用省略，"[来自另一个会话]"是别的会话转来的消息）。
请给每一段写一条工作日志，不要运行任何命令，不要读写文件，直接给出结果：
- id：照抄段落的 id。
- summary：一句话，不超过 60 字，说清这天在这段会话里做了什么、结果怎样，省略主语，例如"排查线上登录失败，定位到会话缓存过期，修复已合 main"。只是问答就写问了什么、得到什么结论。
- points：0–4 条要点，每条不超过 40 字：关键动作、结论、用户拍板的决定、遗留问题。没有就给空数组。
- project：英文短名，优先用已有项目名：${projects.join('、') || '（暂无）'}；新项目可以起简短的英文名；判断不了留空字符串。
- status：done（这段的事做完了）/ ongoing（还在进行）/ blocked（卡住、等人或等条件）/ chat（只是问答、闲聊）。
只写记录里真有的事，不要编造；不要写任何密码、口令、密钥、令牌。用中文。

${batch.map((s, i) => segmentText(s, i + 1, Math.floor(CFG.journal_batch_chars / batch.length) + 2000)).join('\n\n')}
`;
}

const LOCK = path.join(os.homedir(), '.cache', 'agent-memory-journal.lock');
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
  if (!acquireLock()) { log('已有日志任务在跑，这次跳过'); return; }
  const maxBatches = parseInt(process.env.AM_JOURNAL_MAX_BATCHES, 10) || CFG.journal_max_batches;
  const workers = Math.min(Math.max(parseInt(process.env.AM_JOURNAL_CONCURRENCY, 10) || CFG.journal_concurrency, 1), 8);
  const titles = await api('GET', '/v1/titles').catch(() => '');
  const projects = [...new Set([...titles.matchAll(/\] \[([a-z0-9][a-z0-9._-]{1,40})\]/g)].map((m) => m[1]))].slice(0, 40);
  let ok = 0;
  let failed = 0;
  let written = 0;
  let batches = 0;
  const cap = CFG.journal_batch_chars;
  // 一批：最多 8 段、正文合计不超过 cap；一段太长就自己一批（会被压缩）
  async function nextBatch(queue) {
    const batch = [];
    let size = 0;
    while (queue.length && batch.length < 8) {
      const p = queue[0];
      if (batch.length && size + Math.min(p.chars, cap) > cap) break;
      queue.shift();
      try {
        const it = JSON.parse(await api('GET', `/v1/journal/item?key=${encodeURIComponent(p.key)}&date=${p.date}`));
        if (!it.messages?.length) continue;
        batch.push(it);
        size += Math.min(p.chars, cap);
      } catch (e) { log(`取段失败 ${p.key} ${p.date}：${e.message}`); }
    }
    return batch;
  }
  while (batches < maxBatches) {
    const res = JSON.parse(await api('GET', `/v1/journal/pending?today=1&limit=${Math.min((maxBatches - batches) * 8, 400)}`));
    // journal_since（如 "2026-08-01"）：更早的老会话不写日志（中心按日期从新到旧给，碰到更早的就停）
    const since = process.env.AM_JOURNAL_SINCE || CFG.journal_since || '';
    const items = since ? res.items.filter((x) => x.date >= since) : res.items;
    const total = since ? `${items.length}+（${since} 以后）` : res.total;
    if (!items.length) break;
    log(`待写 ${total} 段，这一轮取 ${items.length} 段，并发 ${workers}`);
    const queue = [...items];
    let progressed = 0;
    await Promise.all(Array.from({ length: workers }, async () => {
      while (queue.length && batches < maxBatches) {
        const batch = await nextBatch(queue);
        if (!batch.length) continue;
        batches++;
        const started = Date.now();
        try {
          const raw = await runCodex(buildPrompt(batch, projects));
          const parsed = JSON.parse(raw);
          const out = [];
          for (const r of parsed.segments || []) {
            const s = batch[Number(r.id) - 1];
            if (!s || !r.summary) continue;
            out.push({ key: s.key, date: s.date, n: s.messages.length, summary: r.summary, points: r.points || [], project: r.project || '', status: r.status || '' });
          }
          const res = JSON.parse(await api('POST', '/v1/journal/result', { items: out }));
          written += res.written;
          progressed += res.written;
          ok++;
          log(`ok 一批 ${batch.length} 段（${Math.round((Date.now() - started) / 1000)}s），写入 ${res.written}：${batch.map((s) => `${s.date} ${s.title.slice(0, 16)}`).join(' | ')}`);
        } catch (e) {
          failed++;
          log(`失败 一批 ${batch.length} 段：${e.message}`);
        }
      }
    }));
    if (!progressed) break; // 这一轮一段都没写成：别空转
  }
  log(`完成：${ok} 批成功，${failed} 批失败，写入 ${written} 段`);
  if (failed && !ok) process.exitCode = 1;
}

main()
  .then(() => fs.rmSync(LOCK, { force: true }))
  .catch((e) => { log(`出错：${e.message}`); fs.rmSync(LOCK, { force: true }); process.exit(1); });
