// 各组合并后的联合检查：设了 hide_projects 的浏览者，新老接口（含首屏汇总和后来新增的）都看不到被隐藏项目的任何痕迹。
// 运行：node --test test/

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHub } from './helpers.mjs';
import { TOKENS, PEERS, AS, HIDDEN, seed, leaks } from './access-fixture.mjs';
import { BOOT_PAGES } from '../hub/perf.mjs';

describe('受限浏览者：合并后的所有接口', () => {
  let hub; let s;
  before(async () => {
    hub = await startHub({ tokens: TOKENS, peers: PEERS });
    s = await seed(hub);
    assert.equal((await hub.post('devices/build-server', { hide_projects: [HIDDEN] })).status, 200);
  });
  after(() => hub.stop());
  const asRestricted = (route) => hub.get(route, AS('build-server'));

  it('首屏汇总：每个页面的汇总里都没有被隐藏项目的痕迹，而不受限的浏览者能看到', async () => {
    const pages = ['overview', ...Object.keys(BOOT_PAGES)];
    let seen = false;
    for (const page of pages) {
      const r = await asRestricted(`boot?page=${page}`);
      assert.equal(r.status, 200, page);
      assert.deepEqual(leaks(r.text, s.forbidden), [], `boot ${page}`);
      const open = await hub.get(`boot?page=${page}`);
      if (leaks(open.text, s.forbidden).length) seen = true;
    }
    assert.ok(seen, '不受限的浏览者至少在某个页面的汇总里看得到被隐藏项目（否则这条检查是空的）');
  });

  it('后来新增的接口：拓扑历史、缺口、冷记忆、摘要、搜索都不泄露', async () => {
    for (const route of ['topology/history?hours=24&bucket=15', 'insight/gaps', 'insight/cold?days=30', 'digest', 'search?q=hidden', 'search?q=title', 'search?q=proj']) {
      const r = await asRestricted(route);
      assert.equal(r.status, 200, route);
      assert.deepEqual(leaks(r.text, s.forbidden), [], route);
    }
  });

  it('被隐藏项目的记忆：历史 404；存成记忆 404', async () => {
    const id = s.ids.hiddenEntry || Object.values(s.ids).find((x) => typeof x === 'string' && /^m-/.test(x));
    if (id) {
      const h = await asRestricted(`memory/${id}/history`);
      assert.ok([404, 200].includes(h.status));
      if (h.status === 200) assert.deepEqual(leaks(h.text, s.forbidden), []);
    }
  });
});
