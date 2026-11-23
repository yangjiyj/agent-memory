// 访问控制测试的共用数据：两个设备（一个会被设 hide_projects）、含被隐藏项目和普通项目的记忆、对话、工作日志、待办。
// 不是测试文件（不以 .test.mjs 结尾），access-*.test.mjs 都 import 它。

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { GATE } from './helpers.mjs';

export const HIDDEN = 'qx-hidden-91'; // 被隐藏的项目（数据里故意用不同大小写写）
export const VISIBLE = 'vis-proj';
export const TOKENS = {
  'my-laptop': { token: 'tok-laptop-secret-value' },
  'build-server': { token: 'tok-build-secret-value' },
  nightly: { token: 'tok-nightly-secret-value', role: 'extractor' },
  'ci-box': { token: 'tok-cibox-secret-value' },
};
export const PEERS = ['my-laptop', 'build-server'];
export const AS = (name) => ({ 'x-am-gate': GATE, 'x-am-peer': name });

export const keyOf = (device, tool, sid) => `${device}__${tool}__${sid}`.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200);
export const refOf = (key) => crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
export const localDay = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);

const idOf = (r) => /m-\d{8}-[0-9a-f]{6}/.exec(r.content[0].text)?.[0];

// 造数据，返回 { ids, refs, days, forbidden, visible }：forbidden 是被隐藏项目的全部痕迹（项目名、标题、id、ref、正文片段），visible 是普通内容里一定还在的标记
export async function seed(hub) {
  const remember = async (type, title, body, project, subject) => {
    const r = await hub.rpc('my-laptop', 'tools/call', { name: 'memory_remember', arguments: { type, title, body, ...(project ? { project } : {}), ...(subject ? { subject } : {}) } });
    assert.ok(!r.isError, r.content[0].text);
    return idOf(r);
  };
  const ids = {};
  ids.H1 = await remember('decision', 'hidden-title-H1', 'hidden-body-H1 secret reasoning', 'Qx-Hidden-91');
  ids.H2 = await remember('status', 'hidden-status-H2', 'hidden-body-H2 current state', 'qx-hidden-91', 'hidden/state');
  ids.H3 = await remember('pitfall', 'hidden-pitfall-H3', 'hidden-body-H3 do not repeat', 'QX-HIDDEN-91');
  ids.P1 = await remember('preference', 'hidden-pref-P1', 'hidden-body-P1 prefers tabs', 'qx-hidden-91');
  ids.V1 = await remember('decision', 'visible-title-V1', 'visible-body-V1', VISIBLE);
  ids.V2 = await remember('status', 'visible-status-V2', 'visible-body-V2', VISIBLE, 'vis/state');
  ids.V3 = await remember('pitfall', 'visible-pitfall-V3', 'visible-body-V3', VISIBLE);
  ids.N1 = await remember('preference', 'noproj-pref-N1', 'noproj-body-N1');

  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const sessions = {
    SH: { sid: 'sess-h', title: 'title-hidden-S1', cwd: '/home/dev/code/app', msgs: [[now - 3600e3, 'user', 'MSG-HIDDEN-ONE please fix it'], [now - 3599e3, 'assistant', 'ok']] },
    SV: { sid: 'sess-v', title: 'title-visible-S2', cwd: '/home/dev/code/web', msgs: [[now - 1800e3, 'user', 'MSG-VISIBLE-TWO please check'], [now - 1799e3, 'assistant', 'fine']] },
    SN: { sid: 'sess-n', title: 'title-noproj-S3', cwd: '/home/dev/notes', msgs: [[now - 900e3, 'user', 'MSG-NOPROJ-THREE hello'], [now - 899e3, 'assistant', 'hi']] },
    SC: { sid: 'sess-c', title: 'title-cwd-S4', cwd: '/work/QX-Hidden-91/app', msgs: [[now - 600e3, 'user', 'MSG-CWD-FOUR no journal yet'], [now - 599e3, 'assistant', 'ok']] },
    SM: { sid: 'sess-m', title: 'title-multi-S5', cwd: '/home/dev/code/mix', msgs: [[now - 26 * 3600e3, 'user', 'MSG-MULTI-OLD first day'], [now - 26 * 3600e3 + 1000, 'assistant', 'ok'], [now - 1200e3, 'user', 'MSG-MULTI-NEW second day'], [now - 1199e3, 'assistant', 'ok']] },
  };
  const keys = {};
  const refs = {};
  for (const [name, s] of Object.entries(sessions)) {
    const r = await hub.device('my-laptop', '/v1/conv/append', {
      tool: 'claude-code', session_id: s.sid, base: 0, title: s.title, cwd: s.cwd,
      messages: s.msgs.map(([ms, role, text]) => ({ role, text, ts: iso(ms) })),
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    keys[name] = keyOf('my-laptop', 'claude-code', s.sid);
    refs[name] = refOf(keys[name]);
  }
  const day = (name, i = -1) => localDay(sessions[name].msgs.at(i)[0]);
  const days = { SH: day('SH'), SV: day('SV'), SN: day('SN'), SM_old: day('SM', 0), SM_new: day('SM') };
  const item = (name, date, project, summary, status, points) => ({ key: keys[name], date, project, summary, status, points });
  const j = await hub.device('nightly', '/v1/journal/result', {
    items: [
      item('SH', days.SH, HIDDEN, 'journal-hidden-J1 已上线', 'ongoing', ['point-hidden-J1']),
      item('SV', days.SV, VISIBLE, 'journal-visible-J2 已上线', 'ongoing', ['point-visible-J2']),
      item('SN', days.SN, '', 'journal-noproj-J3', 'ongoing', []),
      item('SM', days.SM_old, VISIBLE, 'journal-multi-old-J4', '', []),
      item('SM', days.SM_new, HIDDEN, 'journal-multi-new-J5', 'blocked', []),
    ],
  });
  assert.equal(j.status, 200, JSON.stringify(j.json));
  assert.equal(j.json.written, 5);
  // 最后一次提交是被隐藏项目的记忆（看 jobs 里的最近提交说明有没有带标题）
  ids.L1 = await remember('fact', 'hidden-last-commit-L1', 'hidden-body-L1', 'qx-hidden-91');

  return {
    ids, refs, keys, days,
    forbidden: [
      HIDDEN, 'hidden-title-H1', 'hidden-status-H2', 'hidden-pitfall-H3', 'hidden-pref-P1', 'hidden-last-commit-L1', 'hidden-body-',
      'journal-hidden-J1', 'point-hidden-J1', 'title-hidden-S1', 'MSG-HIDDEN-ONE', 'title-cwd-S4', 'MSG-CWD-FOUR', 'title-multi-S5',
      'MSG-MULTI-OLD', 'MSG-MULTI-NEW', 'journal-multi-old-J4', 'journal-multi-new-J5', '/work/QX-Hidden-91',
      ids.H1, ids.H2, ids.H3, ids.P1, ids.L1, refs.SH, refs.SC, refs.SM,
    ],
    visible: ['visible-title-V1', 'visible-status-V2', 'noproj-pref-N1', 'journal-visible-J2', 'title-visible-S2', 'title-noproj-S3', 'MSG-VISIBLE-TWO', 'MSG-NOPROJ-THREE'],
  };
}

// 响应文本里出现了哪些被隐藏的痕迹（不分大小写）
export const leaks = (text, forbidden) => forbidden.filter((x) => text.toLowerCase().includes(String(x).toLowerCase()));
