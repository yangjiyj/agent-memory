// C 组（用量洞察）测试的小工具：直接往 usage.jsonl 追加造好的行、写条目文件、写 usage-meta.json。
// 文件名不带 .test.，npm test 不会把它当测试跑。

import fs from 'node:fs';

export const DAY = 86400e3;
export const iso = (ms) => new Date(ms).toISOString();
export const ago = (days) => Date.now() - days * DAY;

export const readUsage = (hub) => fs.readFileSync(hub.path('state/usage.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
export const appendUsage = (hub, rows) => fs.appendFileSync(hub.path('state/usage.jsonl'), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
export const writeMeta = (hub, sinceMs) => fs.writeFileSync(hub.path('state/usage-meta.json'), JSON.stringify({ since: iso(sinceMs) }));

// 造一行带新字段的调用记录：row('tool:memory_search', 'my-laptop', 2, { d: '证书 续期', hits: 0 })
export const row = (op, device, days, extra = {}) => ({ t: iso(ago(days)), device, client: 'claude-code', op, dur: 12, ...extra });

// 往仓库里直接写一条条目文件（和 serializeEntry 同格式）；写完要 hub.restart() 才会被中心读到
export function writeEntryFile(hub, { id, type = 'fact', title, body = '内容', project = '', state = 'active', createdAgo = 60, updatedAgo = createdAgo }) {
  const meta = { id, type, title, project, state, origin: 'explicit', author: 'my-laptop', client: 'claude-code', created: iso(ago(createdAgo)), updated: iso(ago(updatedAgo)) };
  const lines = ['---'];
  for (const [k, v] of Object.entries(meta)) if (v !== '') lines.push(`${k}: ${JSON.stringify(v)}`);
  lines.push('---', '', body, '');
  fs.writeFileSync(hub.path(`repo/entries/${id}.md`), lines.join('\n'));
}
