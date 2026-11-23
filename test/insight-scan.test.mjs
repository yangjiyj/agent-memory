// usage.jsonl 的增量扫描（缺口和冷记忆自己的那一份，窗口比 usageTail 的 8 天长）：大文件跨块边界、追加后继续、半行不算。运行：node --test test/
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startHub, TOKENS } from './helpers.mjs';
import { appendUsage, writeMeta, row, iso, ago } from './insight-util.mjs';

describe('用量扫描：大文件和增量', () => {
  let hub; let zero = 0;
  before(async () => {
    hub = await startHub({ tokens: TOKENS, peers: ['my-laptop'] });
    writeMeta(hub, ago(40));
    const lines = [];
    for (let i = 0; i < 42000; i++) {
      if (i % 700 === 0) { lines.push(JSON.stringify(row('tool:memory_search', 'my-laptop', 1, { d: '边界 查询', hits: 0 }))); zero++; } else {
        lines.push(JSON.stringify({ t: iso(ago(1)), device: 'my-laptop', client: 'claude-code', op: 'tool:memory_get', d: 'm-filler-0001', dur: 3, pad: 'x'.repeat(170) }));
      }
    }
    fs.appendFileSync(hub.path('state/usage.jsonl'), `${lines.join('\n')}\n`);
  });
  after(() => hub.stop());
  const count = async () => (await hub.get('insight/gaps')).json.groups.find((g) => g.text === '边界 查询')?.count || 0;

  it('文件超过一个读取块（8MB）：每一行都算到，一条不多一条不少', async () => {
    assert.ok(fs.statSync(hub.path('state/usage.jsonl')).size > 8 << 20, '测试文件要比一个读取块大');
    assert.equal(await count(), zero);
  });

  it('追加之后只读新增的部分，计数继续对', async () => {
    appendUsage(hub, [row('tool:memory_search', 'my-laptop', 0, { d: '边界 查询', hits: 0 }), row('tool:memory_search', 'my-laptop', 0, { d: '边界 查询', hits: 0 })]);
    assert.equal(await count(), zero + 2);
  });

  it('最后一行还没写完（没有换行）时不计数也不报错，写完整了才算', async () => {
    const full = JSON.stringify(row('tool:memory_search', 'my-laptop', 0, { d: '边界 查询', hits: 0 }));
    fs.appendFileSync(hub.path('state/usage.jsonl'), full.slice(0, 50));
    assert.equal(await count(), zero + 2);
    fs.appendFileSync(hub.path('state/usage.jsonl'), `${full.slice(50)}\n`);
    assert.equal(await count(), zero + 3);
  });

  it('坏行被跳过，不影响前后的行', async () => {
    fs.appendFileSync(hub.path('state/usage.jsonl'), '{这不是 JSON, "dur": 1}\n');
    appendUsage(hub, [row('tool:memory_search', 'my-laptop', 0, { d: '边界 查询', hits: 0 })]);
    assert.equal(await count(), zero + 4);
  });

  it('文件被截断（换了新文件）时重新扫', async () => {
    fs.writeFileSync(hub.path('state/usage.jsonl'), `${JSON.stringify(row('tool:memory_search', 'my-laptop', 0, { d: '边界 查询', hits: 0 }))}\n`);
    assert.equal(await count(), 1);
  });
});
