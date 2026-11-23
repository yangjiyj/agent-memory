# 只读分享链接 / Read-only share links

把某个项目的时间线或交接包做成一个 `/s/<令牌>` 链接，发给没有控制台权限的人看。控制台里在「项目」页的交接包旁点「分享」。

## 内容边界（分享版）

只有：项目名、日期、设备显示名（`device_labels`）、智能体、工作日志的 summary（一两句话）和"进行中 / 卡住"状态。

不给：对话原文、会话标题和 ref、工作日志里的 points、记忆条目的标题和正文（所以交接包里没有现状、决定、坑、参考、偏好）、记忆 id、会话所在目录。

- 时间线：最近 30 天（最多 200 段），按天倒序。
- 交接包：「还没收尾」（日志里最后状态还是进行中 / 卡住的）加最近 14 天（最多 80 段）。
- 页面在打开链接时按工作日志实时生成，不是创建时的快照。
- 同时按创建者现在看得到什么裁剪：创建者之后被设了 `hide_projects`，他看不到的会话不会出现，项目本身被隐藏则整条链接失效。

## 接口（控制台，需要网关身份）

| | |
|---|---|
| `POST /console/api/shares` | `{project, kind: "timeline" \| "handoff", days: 1 \| 7 \| 30}`；有效期只能这三个值；创建者必须看得到该项目；返回里有令牌和完整链接，仅此一次 |
| `GET /console/api/shares[?project=]` | id、项目、类型、创建时间、到期时间、创建者、状态（active / expired / revoked）；不含令牌 |
| `POST /console/api/shares/revoke` | `{id}` |

生成和作废记审计 `console:share-create`、`console:share-revoke`（不记令牌）。

## 安全约束

- 令牌 32 字节随机（base64url）；`state/shares.json`（权限 600）只存 sha256，丢了倒推不出链接。
- 无效、过期、作废、格式不对、创建者已看不到项目，一律返回完全相同的 404。
- 未认证访问限速：每个 IP 每分钟失败 30 次后 429（IP 取网关写的 `X-AM-Peer-IP`，没有网关暗号的请求按连接的真实地址算，伪造头没用）。
- 响应头 `Cache-Control: no-store`、`X-Robots-Tag: noindex, nofollow, noarchive`、`Referrer-Policy: no-referrer`，页面带 `<meta name="robots">`，自包含（无外部资源、无脚本、无指向控制台的链接）。
- 中心的访问日志里 `/s/` 后面的令牌已隐去（`/s/…`）。

## 网关（gateway/am-gate.py）：不用改

读代码并用真实的 `am-gate.py` 转发到中心验证过：没有身份的请求不会被网关挡掉——认不出来源的请求（不在 Tailscale、不在虚拟机网段）照样转发，只是不带 `X-AM-Peer`；外部传来的 `X-AM-*` 头一律剥掉，网关加 `X-AM-Gate`（暗号）和 `X-AM-Peer-IP`；响应头原样回传。所以 `/s/` 在中心的 `route()` 里排在身份校验之前就够了，网关不需要任何改动（`/join/`、`/install/` 也是同一个道理）。

不要给网关加"没身份只放行某几个路径"的白名单：不在 Tailscale 里的机器靠加入码接入，走的也是没身份的请求。

## 部署要点

- 升级中心时 `cp hub/* app/`：新增 `share.mjs`、`admin-access.mjs`、`console-share.css`，`console-share.js` 由占位变成实际界面；没有新的配置项。
- `public_url` 要配成对方打得开的地址（链接前缀用它）。
- `state/shares.json` 是一个 JSON 数组，随 state 目录备份；删掉它等于作废全部链接。

## 现实边界

现网入口在 Tailscale 内网，不在这个网络里的人打不开这些链接。这里的"分享"是给**同一张内网里、但没有控制台权限**的人看；不是能发到公网的链接。要真对外，需要另外放一个只转发 `/s/` 的反向代理，并把访客的真实 IP 通过 `X-AM-Peer-IP`（带网关暗号）传给中心，否则限速会把所有访客当成同一个 IP。本次没有做。

---

**English summary.** `POST /console/api/shares {project, kind: timeline|handoff, days: 1|7|30}` creates a read-only link `/s/<token>`. The shared page only contains the project name, dates, device display names, the agent, and work-log summaries (no conversation text, session titles, memory titles/bodies, ids or paths). Only the sha256 of the 32-byte token is stored (`state/shares.json`); invalid/expired/revoked tokens all return an identical 404; 30 failures per IP per minute return 429. The page is served before identity checks, so the gateway needs no change; note that the hub is still only reachable inside the Tailscale network, so this is not a public link.
