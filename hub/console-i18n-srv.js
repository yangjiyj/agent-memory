/*
 * 服务端返回的中文句子的英文词典：事件带文字、巡检问题、接口错误信息、历史动作名、状态词。
 * 服务端字符串本身不改（MCP 工具、/v1/*、设备端和现有测试都依赖原文），由前端在显示时翻译。纯数据，只在英文下登记。
 * 来源：hub/admin*.mjs 的 bad() / HttpError() 和事件文字表，hub/server.mjs 的 watch()，pipeline.mjs / convlog.mjs 的 watchProblems()，extras.mjs 的管理操作错误。
 * 变量（设备名、项目名、查询词）原样保留；写法见 console-i18n.js 开头。
 */
(function () {
  if (!window.AMI18n || window.AMI18n.lang !== 'en') return;
  const { add, pat, rule } = window.AMI18n;
  const CJK = new RegExp('[\\u3400-\\u9fff\\uff00-\\uffef\\u3000-\\u303f]');

  // ================= 事件带（admin.mjs）=================
  add({
    '查了记忆': 'Searched memories', '读了一条记忆': 'Read a memory', '看了时间线': 'Viewed the timeline', '看了待办': 'Viewed todos', '生成了交接包': 'Generated a handoff pack',
    '查了实体': 'Looked up an entity', '看了最近的记忆': 'Viewed recent memories', '取了记忆摘要': 'Fetched the memory digest', '搜了对话': 'Searched conversations', '读了一段对话': 'Read a conversation',
    '写了一条记忆': 'Wrote a memory', '更新了一条记忆': 'Updated a memory', '作废了一条记忆': 'Retired a memory',
    '改了设置': 'Changed settings', '改了设备策略': 'Changed a device policy', '生成了加入码': 'Created a join code', '开关了 MCP 工具': 'Toggled an MCP tool',
    '通过了候选记忆': 'Approved a candidate memory', '驳回了候选记忆': 'Rejected a candidate memory', '作废了记忆': 'Retired a memory', '合并了记忆': 'Merged memories',
    '拉了日报': 'Pulled the daily report', '拉了周报': 'Pulled the weekly report', '抽取了一个会话': 'Extracted a session', '写了一段工作日志': 'Wrote a journal entry',
    '有新对话': 'New chat', '查了知识卡片': 'Looked up a knowledge card', '读了记忆': 'Read memories', '拉了报表': 'Pulled a report', '处理了数据': 'Processed data',
    '在控制台做了管理操作': 'Performed an admin action in the console',
    '作废了分享链接': 'Revoked a share link', '生成了分享链接': 'Created a share link',
  });
  pat('在 {*} 有新对话', 'New chat in $1');
  // 「查询词」「标题」：动作词能翻才翻，查询词原样留着
  rule(/^(.+?)「(.+)」$/, (m, t) => { const a = t(m[1]); return CJK.test(a) ? null : `${a} "${m[2]}"`; });

  // ================= 巡检问题（server.mjs watch()、pipeline.mjs、convlog.mjs）=================
  pat('设备 {*} 已经 {t}没同步（阈值 {n} 小时）', 'Device $1 has not synced for $t2 (threshold: $3 {3|hour|hours})');
  pat('设备 {*} 已经 {t}没同步', 'Device $1 has not synced for $t2');
  pat('设备 {*} 登记后一次都没同步过', 'Device $1 has never synced since it was registered');
  pat('{n} 天', '$1 {1|day|days}');
  pat('{n} 小时', '$1 {1|hour|hours}');
  pat('{*} 的来源突然少了 {n} 条（原有 {n}），已拦下没作废；确认是真删了就在那台机器上 AM_FORCE_RETIRE=1 再同步一次', '$1: its sources suddenly dropped by $2 (it had $3). The retirement was blocked; if they were really deleted, sync again on that machine with AM_FORCE_RETIRE=1');
  pat('会话抽取失败 {n} 个（重试 3 次都没成功），最近一个：{*}', 'Extraction failed for $1 {1|session|sessions} (retried 3 times); latest: $t2');
  pat('{n} 个会话上传超过 36 小时还没抽取，夜间抽取任务可能没在跑', '$1 {1|session has|sessions have} been waiting more than 36 hours for extraction; the nightly extraction job may not be running');
  pat('对话存档盘 {*} 没挂上（看 .am-archive 标记文件），设备上传的对话会被拒收', 'The conversation archive disk $1 is not mounted (check the .am-archive marker file); conversations uploaded by devices will be rejected');
  pat('工作日志 36 小时没写了，积压 {n} 段两天前的会话（worker 上的 agent-memory-journal 任务可能没在跑）', 'No work journal written for 36 hours; $1 session {1|segment|segments} from two days ago {1|is|are} backlogged (the agent-memory-journal job on the worker may not be running)');
  add({ '未知原因': 'unknown reason' });

  // ================= 审计里的操作细节（admin*.mjs 的 audit()）=================
  rule(/^(.+?) (时间线|交接包) (\d+) 天 ([0-9a-f]{12})$/, '$1 $l2 $3 days $4');
  pat('{t} 停用', '$1 disabled');
  pat('{t} 启用', '$1 enabled');

  // ================= 历史动作（admin-tools.mjs）=================
  add({
    '初始化': 'Initialized', '对话存成记忆': 'Saved from conversation', '新建': 'Created', '被新条目取代': 'Superseded by a new entry', '恢复旧版本': 'Restored an old version',
    '原生同步（新建）': 'Native sync (created)', '原生同步': 'Native sync', '导入（新建）': 'Imported (created)', '导入': 'Imported',
    '审批：保留': 'Review: kept', '审批：不要': 'Review: discarded', '修正': 'Fixed',
    '这条记忆已被取代，不能再改': 'This memory has been superseded and can no longer be edited', '这条记忆已作废，不能再改': 'This memory has been retired and can no longer be edited',
    '这条记忆已不是有效状态，不能再改': 'This memory is no longer active and can no longer be edited',
    '这条来自工具自己的原生记忆文件，会被下次同步覆盖，不能恢复旧版本': 'This comes from the tool\'s own native memory file and would be overwritten by the next sync, so old versions cannot be restored',
    '这一版和当前内容一样，不用恢复。': 'This version is identical to the current content; nothing to restore.',
    '这一版读不出内容，不能恢复': 'This version cannot be read, so it cannot be restored',
    '这条记忆没有这个版本': 'This memory has no such version',
  });
  pat('这一版不能恢复：{*}', 'This version cannot be restored: $t1');
  pat('这个 sha 前缀不唯一，多写几位', 'This sha prefix is ambiguous — type a few more characters');

  // ================= 接口错误信息（hub/admin*.mjs、server.mjs、extras.mjs）=================
  add({
    '请求体必须是 JSON 对象': 'The request body must be a JSON object', '请求体太大': 'The request body is too large', '请求体不是合法 JSON': 'The request body is not valid JSON',
    'project 必须是 1–60 字的项目名': 'project must be a project name of 1–60 characters', 'kind 只能是 timeline（时间线）或 handoff（交接包）': 'kind must be timeline or handoff',
    '没有这个项目': 'No such project', '关键词太长了（最多 200 个字）': 'The keywords are too long (200 characters at most)',
    'sha 不对（7–40 位小写十六进制）': 'Invalid sha (7–40 lowercase hex digits)', 'ref 必须是 8 位小写十六进制的会话编号': 'ref must be an 8-digit lowercase hex session id',
    '还没有登记任何设备': 'No devices registered yet', '已不是有效状态': 'no longer active', 'id 不对': 'Invalid id', '这个分享链接已经失效或不存在': 'This share link has expired or does not exist',
    'key 必须是 1–200 个字的字符串': 'key must be a string of 1–200 characters', 'ignored 必须是 true 或 false': 'ignored must be true or false',
    '这一条没有被忽略过': 'This entry was never ignored', '没有这条缺口（可能已被忽略，或已经不在近 30 天里）': 'No such gap (it may have been ignored, or is no longer within the last 30 days)',
    '回看的小时数': 'Hours to look back', '每格的分钟数': 'Minutes per bucket',
    '这个接口只支持 GET': 'This endpoint only supports GET', '这台机器在共享记忆里设成了只读，不能写。': 'This machine is set to read-only in shared memory and cannot write.',
    '没有这个接口': 'No such endpoint', '对话存档盘没挂上，暂时查不了。': 'The conversation archive disk is not mounted, so nothing can be searched for now.',
    '对话存档盘没挂载，新对话暂时存不进去': 'The archive disk is not mounted; new conversations cannot be stored for now',
    '请给关键词（q，空格分隔，全部命中）': 'Provide keywords (q, space-separated, all must match)', 'from 必须是正整数': 'from must be a positive integer',
    'role 只能是 user 或 assistant': 'role must be user or assistant', '没有要改的字段': 'No fields to change', '没有要改的设置': 'No settings to change',
    '这台机器的可见范围受限，不能修改隐藏项目。': 'This machine has a restricted view and cannot change hidden projects.',
    '这个加入码已经失效或不存在': 'This join code has expired or does not exist', 'disabled 必须是 true 或 false': 'disabled must be true or false',
    '（没给 name）': '(no name given)', 'project 不是合法的项目名': 'project is not a valid project name',
    'since 不是合法的时间（用 ISO 格式，如 2026-11-23T08:00:00Z）': 'since is not a valid time (use ISO format, e.g. 2026-11-23T08:00:00Z)',
    '只有已经接入共享记忆的机器能用控制台（按 Tailscale 或虚拟机身份认，或者配置 console_viewer）。': 'Only machines already connected to shared memory can use the console (identified by Tailscale or VM identity, or configure console_viewer).',
    '配置文件不是合法的 JSON，为了不覆盖它，没有保存。先手工修好配置文件。': 'The config file is not valid JSON; nothing was saved so it is not overwritten. Fix the config file by hand first.',
    '配置文件的内容不是 JSON 对象，没有保存。': 'The config file content is not a JSON object; nothing was saved.',
    'embed_url 必须是字符串': 'embed_url must be a string', 'ask_url 必须是字符串': 'ask_url must be a string', 'ask_model 必须是字符串': 'ask_model must be a string',
    'ask_url 里不要带账号密码，密钥填在 ask_key': 'Do not put credentials in ask_url; enter the key in ask_key', 'ask_model 最长 80 个字': 'ask_model can be at most 80 characters',
    'ask_key 必须是非空字符串（要清除请传 null）': 'ask_key must be a non-empty string (pass null to clear it)', 'ask_key 最长 300 个字符': 'ask_key can be at most 300 characters',
    'device_labels 必须是 {设备名: 显示名} 对象': 'device_labels must be an object of {device name: display name}',
    'graph_entities 必须是 {machine: [...], site: [...]} 对象': 'graph_entities must be an object of {machine: [...], site: [...]}',
    'group 必须是字符串（最多 20 个字），传空串或 null 清掉分组': 'group must be a string (at most 20 characters); pass an empty string or null to clear the group',
    'group 里不能有换行等控制字符': 'group cannot contain control characters such as line breaks', 'group 最多 20 个字': 'group can be at most 20 characters',
    '正文太长': 'The body is too long', '设备名只能用字母数字 . _ -': 'Device names may only contain letters, digits, . _ -', '这台机器设成了只读': 'This machine is set to read-only',
    '没有要处理的条目': 'No entries to process', '不认识的操作': 'Unknown action', '条目不存在': 'The entry does not exist', '作废要写原因': 'A reason is required to retire',
    '在管理台手动作废': 'Retired manually in the admin console', '这条来自某个工具的原生记忆文件；删掉那个文件后会自动作废。': 'This comes from a tool\'s native memory file; it is retired automatically once that file is deleted.',
    '加入码无效或已过期': 'The join code is invalid or has expired', '这个加入码登记的机器太多了，换一个新的': 'Too many machines registered with this join code; use a new one',
    '请输入问题（q）': 'Enter a question (q)', '请给关键词（q）': 'Provide keywords (q)', '请求已取消': 'Request cancelled',
    '问题太长了，最多 500 个字': 'The question is too long (500 characters at most)',
    '还没配置问答：到「设置 → 问答」填上模型接口地址、模型名和密钥。': 'Ask is not configured yet: enter the model API URL, model name and key under "Settings → Ask".',
    '模型接口拒绝了访问，请检查设置里的密钥': 'The model API denied access; check the key in Settings', '模型接口地址或模型名不对': 'The model API URL or model name is wrong',
    '模型接口在限流，稍后再试': 'The model API is rate-limiting; try again later', '模型接口自己出错了': 'The model API returned an error', '模型接口不接受这个请求': 'The model API rejected this request',
    '连不上模型接口，请检查设置里的接口地址（地址不对、服务没开或被重定向都会这样）。': 'Cannot reach the model API; check the API URL in Settings (a wrong URL, a stopped service or a redirect all cause this).',
    '模型接口返回的格式不对：要的是 OpenAI 兼容的 /chat/completions。': 'The model API returned an unexpected format: an OpenAI-compatible /chat/completions is required.',
    '模型没有返回内容（思考型模型可能把额度全花在推理上了，换个模型试试）。': 'The model returned nothing (a reasoning model may have spent its whole budget on thinking; try another model).',
    '记忆和对话存档里没有找到相关内容。可以换个说法，或者换几个更具体的词再问。': 'Nothing relevant found in memories or the conversation archive. Try rephrasing, or ask again with more specific words.',
  });
  pat('{t} 必须是 {n}–{n} 之间的整数', '$1 must be an integer between $2 and $3');
  pat('{t}（{n}）：{*}', '$t1 ($2): $3'); // 模型接口的错误：提示（状态码）：对方的说明
  pat('{t}（{*}）必须是 {n}–{n} 之间的整数', '$1 ($t2) must be an integer between $3 and $4');
  pat('一共 {n} 格，超过 {n} 格上限：把 bucket 调大，或把 hours 调小', 'That makes $1 buckets, above the limit of $2: increase bucket or decrease hours');
  pat('{t} 必须是字符串数组（不能有空项）', '$1 must be an array of strings (no empty items)');
  pat('{t} 最多 {n} 项', '$1: at most $2 items');
  pat('{t} 里每项最多 {n} 个字', '$1: each item can be at most $2 characters');
  pat('{t} 不是合法的地址', '$1 is not a valid URL');
  pat('{t} 必须是 http:// 或 https:// 开头的地址', '$1 must be a URL starting with http:// or https://');
  pat('{t} 里的「{*}」不是合法的正则', '"$2" in $1 is not a valid regex');
  pat('device_labels 里的设备名「{*}」不合法（只能用字母数字 . _ -）', 'device name "$1" in device_labels is invalid (letters, digits, . _ - only)');
  pat('device_labels 里「{*}」的显示名必须是 1–40 字的字符串', 'the display name of "$1" in device_labels must be a string of 1–40 characters');
  pat('graph_entities 只能有 machine 和 site，不认识「{*}」', 'graph_entities may only contain machine and site; "$1" is not recognized');
  pat('读不了配置文件：{*}', 'Cannot read the config file: $1');
  pat('保存配置失败：{*}', 'Failed to save the config: $1');
  pat('没有设备 {*}', 'No such device: $1');
  pat('设备 {*} 上没有这个智能体：{*}', 'Device $1 has no such agent: $2');
  pat('{t} 必须是 true 或 false', '$1 must be true or false');
  pat('不认识的字段 {*}（可改：{*}）', 'Unknown field $1 (editable: $t2)');
  pat('未知的工具：{*}', 'Unknown tool: $1');
  pat('limit 必须是 {n}–{n} 之间的整数', 'limit must be an integer between $1 and $2');
  pat('不能通过这里修改：{*}（可改：{*}）', 'Cannot be changed here: $t1 (editable: $t2)');
  pat('{t} 不能清空', '$1 cannot be cleared');
  pat('{t} 的格式不对：用 2026-11-20、11-20、今天 或 昨天', '$1 has the wrong format: use 2026-11-20, 11-20, today or yesterday');
  pat('{t} 不是有效的日期', '$1 is not a valid date');
  pat('{t} 必须是 YYYY-MM-DD 的有效日期', '$1 must be a valid date in YYYY-MM-DD');
  pat('这个接口只支持 {*}', 'This endpoint only supports $1');
  pat('有效的分享链接已经有 {n} 个，先作废一些', 'There are already $1 active share links; revoke some first');
  pat('days（有效期）只能是 {*}，最长 30 天', 'days (validity) must be $1, 30 days at most');
  pat('这个会话在 {*} 没有消息', 'This session has no messages on $1');
  pat('正文太长（最多 {n} 字，出处行占 {n} 字）', 'The body is too long (at most $1 characters, the source line takes $2)');
  pat('保存失败：{*}', 'Save failed: $t1');
  pat('最多置顶 {n} 条，先取消几条再置顶', 'At most $1 can be pinned; unpin some first');
  pat('{t} 太长（最多 {n} 字）', '$1 is too long (at most $2 characters)');
  pat('模型接口 {n} 秒内没有响应（超时），稍后再试。', 'The model API did not respond within $1 s (timeout); try again later.');
  pat('提问太频繁了：每分钟最多 {n} 次，请 {n} 秒后再试。', 'Too many questions: at most $1 per minute. Try again in $2 s.');
  pat('这台机器（{*}）在不自动接入的名单里（客户现场等），没有登记。', 'This machine ($1) is on the do-not-auto-enroll list (customer sites etc.) and was not registered.');
  pat('合并到 {*}', 'Merged into $1');
  add({
    '只有有效的记忆能置顶或排除出摘要': 'Only active memories can be pinned or excluded from the digest', 'action 只能是 pin、unpin、exclude、include 之一': 'action must be one of pin, unpin, exclude, include',
    '认不出这台机器：要经过认证网关（Tailscale 网络或宿主机的虚拟机）访问。不在 Tailscale 里的机器请用加入码。': 'This machine is not recognized: access it through the auth gateway (Tailscale network or a VM on the host). Machines outside Tailscale should use a join code.',
  });
  // ================= MCP 工具说明（server.mjs 的 TOOLS、cards.mjs，显示在 MCP 页）=================
  add({
    'node kb-agent.mjs mcp --client <智能体名>': 'node kb-agent.mjs mcp --client <agent name>',
    '在跨机器、跨智能体的共享记忆里搜索：项目现状、以前的决定、踩过的坑、用户偏好和反馈。关键词用空格分隔（同时命中优先，子串匹配，中英文都行）。': 'Search shared memory across machines and agents: project status, past decisions, pitfalls, user preferences and feedback. Separate keywords with spaces (all-match first, substring match, Chinese and English both work).',
    '按 id 读一条共享记忆的全文。': 'Read the full text of a shared memory by id.',
    '写一条共享记忆，所有机器上的智能体随后都能查到。只写值得长期复用的：结论、决定、踩坑、用户偏好/反馈、项目现状。不写进度流水和临时状态；不写密钥、令牌、口令、客户现场账号密码（会被拒收）。项目现状用 type=status 并填 subject（如 myapp/prod-version），会自动替代同一 subject 的旧现状。': 'Write a shared memory that agents on all machines can find later. Only write what is worth keeping long-term: conclusions, decisions, pitfalls, user preferences/feedback, project status. No progress logs or temporary state; no keys, tokens, passwords or customer-site credentials (they are rejected). For project status use type=status with a subject (e.g. myapp/prod-version); a new status automatically replaces the old one with the same subject.',
    '修改一条用 memory_remember 写的条目（原生记忆同步来的条目不能改）。只传要改的字段。': 'Edit an entry written with memory_remember (entries synced from native memory cannot be edited). Pass only the fields to change.',
    '作废一条错误或不再成立的条目（保留历史，不再出现在搜索和摘要里）。': 'Retire an entry that is wrong or no longer true (history is kept; it no longer appears in search or the digest).',
    '看最近新增或更新的共享记忆。': 'See recently added or updated shared memories.',
    '读共享记忆摘要：偏好与反馈、各项目最新现状、最近的决定与坑。': 'Read the shared memory digest: preferences and feedback, the latest status of each project, recent decisions and pitfalls.',
    '生成交接包（接力提示词）：某个项目（或关键词）最近一段时间的现状、还没收尾的事、拍板的决定、踩过的坑、工作日志、相关会话 ref、用户偏好，拼成一份可以直接交给新会话/新智能体的说明。换会话接着干、交接给别的智能体时用。': 'Generate a handoff pack (a relay prompt): the recent status of a project (or keyword), unfinished items, decisions made, pitfalls hit, work journal, related session refs and user preferences, assembled into a briefing that can be handed straight to a new session or another agent. Use it when continuing in a new session or handing over to another agent.',
    '待办雷达：所有机器、所有智能体里还没收尾的事（工作日志最后状态是"进行中/卡住"的会话），以及停了的项目。问"还有什么没做完""哪些事悬着"时用。': 'Todo radar: unfinished items across all machines and agents (sessions whose last journal status is "in progress/blocked"), plus stalled projects. Use it for "what is still unfinished" or "what is left hanging".',
    '知识图谱：查一个项目、机器、客户现场或版本号和谁有关、出现过哪些版本、最近的相关记录。如"客户 A 现场现在什么版本""server-1 上跑了哪些项目"。': 'Knowledge graph: look up what a project, machine, customer site or version is related to, which versions appeared and the latest related records. For example "which version is customer A\'s site on now" or "which projects run on server-1".',
    '工作日志时间线：按天列出所有机器、所有智能体（Claude Code、Codex、WorkBuddy、Hermes、OpenClaw…）的会话，每段有一两句"做了什么"。用来回答"哪天干了什么""上周某项目做了哪些""某件事是哪天做的"。默认最近 7 天；ref 可交给 conversation_get 读原文。': 'Work journal timeline: sessions of all machines and agents (Claude Code, Codex, WorkBuddy, Hermes, OpenClaw…) listed by day, each with a sentence or two on "what was done". Use it to answer "what did we do on which day", "what did project X do last week" or "when was this done". Defaults to the last 7 days; pass a ref to conversation_get to read the original text.',
    '在所有机器、所有智能体的原始对话（只有用户和助手说的话）里搜关键词，找"我在哪说过/哪次提到过"。空格分隔全部命中，返回会话、日期和片段；读上下文用 conversation_get。': 'Search keywords in the raw conversations (only what the user and the assistant said) of all machines and agents, to find "where did I say it / when was it mentioned". Space-separated, all must match; returns sessions, dates and snippets; use conversation_get to read the context.',
    '读一个会话的原始对话（用户和助手说的话），ref 来自 memory_timeline 或 conversation_search。可按日期只看某一天，长会话分页。': 'Read the raw conversation of one session (what the user and the assistant said); the ref comes from memory_timeline or conversation_search. Can show a single day; long sessions are paginated.',
    '列出知识卡片（按主题整理的长文档：项目、SOP、设备、个人背景等），每张一行。不知道库里有什么时先看这个。': 'List the knowledge cards (long documents organized by topic: projects, SOPs, devices, personal background, etc.), one per line. Look here first when you do not know what the library holds.',
    '在知识卡片全文里搜关键词（空格分隔，全部命中，子串匹配，中英文都行），返回命中的卡片和行号样例。': 'Search keywords across the full text of the knowledge cards (space-separated, all must match, substring match, Chinese and English both work); returns the matching cards and sample line numbers.',
    '看一张卡片的目录（标题和行号）。卡片可能几十万字，读之前先看目录。': 'See the table of contents of a card (headings and line numbers). A card can be hundreds of thousands of characters, so check the contents before reading.',
    '读卡片的某一节（section 填标题片段）或某个行范围（from + lines）。输出带行号和续读提示。': 'Read one section of a card (pass a heading fragment as section) or a line range (from + lines). The output includes line numbers and continue-reading hints.',
  });
})();
