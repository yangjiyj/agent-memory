/* 访问控制相关的控制台接口：只读分享链接（公开页和令牌细节见 share.mjs）。
 *
 *   GET  shares[?project=名]   列出分享链接：id、项目、类型、创建时间、到期时间、创建者、状态（active / expired / revoked）；不含令牌
 *   POST shares                { project, kind: 'timeline' | 'handoff', days: 1 | 7 | 30 } → { id, project, kind, created, expires, creator, status, token, url }
 *                              令牌和完整链接只在这一次响应里出现
 *   POST shares/revoke         { id } 作废
 *
 * 创建者必须看得到这个项目（kit.visibleTo 口径）；看不到的项目和不存在的项目一样回 404。
 * 生成和作废都记审计（console:share-create、console:share-revoke，不记令牌）。
 */

import { SHARE_KINDS, SHARE_DAYS } from './share.mjs';

const MAX_ACTIVE = 200;

export function createAccess(ctx, kit) {
  const { CFG, readBody, send } = ctx;
  const { HttpError, bad, isObj, audit, scopeOf } = kit;

  async function create(req, viewer) {
    const b = await readBody(req);
    if (!isObj(b)) throw bad('请求体必须是 JSON 对象');
    const project = typeof b.project === 'string' ? b.project.trim() : '';
    if (!project || project.length > 60) throw bad('project 必须是 1–60 字的项目名');
    if (!Object.hasOwn(SHARE_KINDS, b.kind)) throw bad('kind 只能是 timeline（时间线）或 handoff（交接包）');
    if (!SHARE_DAYS.includes(b.days)) throw bad(`days（有效期）只能是 ${SHARE_DAYS.join('、')}，最长 30 天`);
    // 项目要真的存在，而且创建者看得到：看不到的和不存在的一样回 404，不泄露它存在
    const found = ctx.extras().projects(scopeOf(viewer)).find((x) => x.p.toLowerCase() === project.toLowerCase());
    if (!found) throw new HttpError(404, '没有这个项目');
    if (ctx.share.list().filter((r) => r.status === 'active').length >= MAX_ACTIVE) throw bad(`有效的分享链接已经有 ${MAX_ACTIVE} 个，先作废一些`);
    const { token, share } = ctx.share.create({ project: found.p, kind: b.kind, days: b.days, creator: viewer });
    audit(viewer, 'share-create', `${found.p} ${SHARE_KINDS[b.kind]} ${b.days} 天 ${share.id}`);
    return { ...share, token, url: `${String(CFG.public_url || '').replace(/\/+$/, '')}/s/${token}` };
  }

  function list(q, viewer) {
    const scope = scopeOf(viewer);
    const project = (q.get('project') || '').trim().toLowerCase();
    return { shares: ctx.share.list().filter((r) => scope.project(r.project) && (!project || r.project.toLowerCase() === project)) };
  }

  async function revoke(req, viewer) {
    const b = await readBody(req);
    const id = isObj(b) ? b.id : undefined;
    if (typeof id !== 'string' || !/^[0-9a-f]{12}$/.test(id)) throw bad('id 不对');
    const rec = ctx.share.get(id);
    if (!rec || rec.status !== 'active' || !scopeOf(viewer).project(rec.project) || !ctx.share.revoke(id)) throw new HttpError(404, '这个分享链接已经失效或不存在');
    audit(viewer, 'share-revoke', `${rec.project} ${id}`);
    return { ok: true };
  }

  return {
    async handle(req, res, url, sub, viewer) {
      const only = (m) => { if (req.method !== m) throw new HttpError(405, `这个接口只支持 ${m}`); };
      if (sub === 'shares') {
        if (req.method === 'GET') { send(res, 200, list(url.searchParams, viewer)); return true; }
        only('POST');
        send(res, 200, await create(req, viewer));
        return true;
      }
      if (sub === 'shares/revoke') { only('POST'); send(res, 200, await revoke(req, viewer)); return true; }
      return undefined;
    },
  };
}
