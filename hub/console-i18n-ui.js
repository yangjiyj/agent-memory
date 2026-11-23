/*
 * 控制台界面文字的英文词典：页面静态文字、按钮、表头、空状态、提示、弹窗、设置项说明，以及各页面脚本里的类型/状态名。
 * 纯数据，只在英文下登记（引擎见 console-i18n.js，术语表也在那里）。服务端返回的句子在 console-i18n-srv.js。
 *   · add({中文: English})  精确匹配，键两端的空白忽略；片段（接在 <b>数字</b> 后面的单位等）也按这个登记，译文可以带首尾空格。
 *   · pat(句式, 模板)  带数字和名字的句式；{n} 数字、{w} 星期汉字、{*} 任意一段（用户数据留原样，$t1 表示再翻译一遍）、
 *     {t} 必须翻得动的一段（系统给的时间、日期、状态词；翻不动说明是用户写的，规则放弃——开头就是 {t}/{*} 的句式用它，免得吞用户数据）。
 *   · 宽规则（开头是 {*} 的）放在文件最后，前面的具体规则先试。
 *   · 带 " · "、"；" 的复合句不用整句登记：引擎会拆开逐段翻，翻不动的段当成用户数据保留。
 */
(function () {
  if (!window.AMI18n || window.AMI18n.lang !== 'en') return;
  const { add, pat, rule } = window.AMI18n;
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // ================= 外壳、导航、公共（console-core.js、console.html）=================
  AMI18n.addNav({ overview: 'Overview', lib: 'Library', triage: 'Triage', graph: 'Knowledge graph', digest: 'Digest', timeline: 'Timeline', projects: 'Projects', todos: 'Todos', convs: 'Conversations', topology: 'Topology', devices: 'Devices', agents: 'Agents', mcp: 'MCP', audit: 'Audit', jobs: 'Jobs', settings: 'Settings' });
  add({
    '菜单': 'Menu',
    '概览': 'Overview', '记忆库': 'Library', '待整理': 'Triage', '知识图谱': 'Knowledge graph', '摘要': 'Digest', '时间线': 'Timeline',
    '待办': 'Todos', '对话存档': 'Archive', '拓扑': 'Topology', '审计': 'Audit', '任务': 'Jobs', '设置': 'Settings',
    '记忆': 'Memory', '工作': 'Work', '接入': 'Connect', '系统': 'System',
    '年度报告 ✦': 'Wrapped ✦', '大屏': 'Wall',
    '读取中…': 'Loading…', '建设中': 'Under construction',
    'Claude 桌面版': 'Claude Desktop',
    // 记忆类型、来源方式、状态
    '偏好': 'Preference', '反馈': 'Feedback', '决定': 'Decision', '现状': 'Status', '坑': 'Pitfall', '事实': 'Fact', '参考': 'Reference',
    '工具自己记的': 'Tool\'s own notes', '从会话里抽的': 'Extracted from sessions', '旧卡片拆分': 'Split from old cards', '智能体主动写': 'Written by agent',
    '有效': 'Active', '待审候选': 'Proposed', '已被取代': 'Superseded', '已作废': 'Retired',
    '未写日志': 'Unlogged', '其他': 'Other', '（无）': '(none)', '（无标题）': '(untitled)',
    // 相对时间、连接错误
    '刚刚': 'just now', '从未': 'never', '今天': 'Today', '现在': 'Now',
    '连不上中心，请检查网络': 'Cannot reach the hub. Check your network.', '没有权限': 'Permission denied',
    // 星期、月份
    '日': 'Sun', '一': 'Mon', '二': 'Tue', '三': 'Wed', '四': 'Thu', '五': 'Fri', '六': 'Sat',
    '、': ', ', '；': '; ', '，': ', ',
  });
  pat('{n} 分钟前', '$1 min ago');
  pat('{n} 小时前', '$1 h ago');
  pat('{n} 天前', '$1 d ago');
  pat('请求失败（{n}）', 'Request failed ($1)');
  pat('页面出错：{*}', 'Page error: $t1');
  pat('读取数据失败：{*}', 'Failed to load data: $t1');
  pat('周{w}', '$w1');
  rule(/^(\d{1,2})月$/, (m) => MON[+m[1] - 1] || m[1]);
  rule(/^(\d{4}) 年 (\d{1,2}) 月$/, (m) => `${MON[+m[2] - 1] || m[2]} ${m[1]}`);

  // ================= 概览（console-overview.js）=================
  add({
    '工作星系': 'Work galaxy', '实时作战室': 'Live war room', '共享记忆全景': 'Shared memory at a glance', '需要处理': 'Needs attention',
    '没收尾的事': 'Unfinished items', '没同步的设备': 'Devices out of sync', '疑似重复': 'Possible duplicates', '过期现状': 'Stale status',
    '个会话': 'sessions', '条你和智能体说的话': 'messages you sent to agents', 'M 字': ' M chars', '对话原文（长期存档）': 'conversation text (archived)',
    '有工作日志的日子': 'days with a work journal', '条有效记忆': 'active memories', '机器 · 智能体': 'machines · agents', '点一下看这天': 'Click to see this day', '段会话（今天）': 'sessions (today)', '条消息': 'messages',
    '共享记忆': 'Memory', '在干活': 'working', '在线': 'online', '有效记忆': 'Active memories', '按类型': 'By type', '按项目': 'By project',
    '按来源（机器 · 智能体）': 'By source (machine · agent)', '最近更新的记忆': 'Recently updated memories',
    '天': ' days',
  });
  pat('{n} 种', '$1 {1|agent|agents}');
  pat('{n} 个会话', '$1 {1|session|sessions}');
  pat('/ {n} 台正在干活', '/ $1 working');

  // ================= 智能体、审计（console-access.js）=================
  add({
    '✓ 插件': '✓ Plugin', '⏸ 插件停用': '⏸ Plugin off', '✕ 没插件': '✕ No plugin',
    '✓ 用法说明': '✓ Usage notes', '✓ 摘要': '✓ Digest', '✕ 说明': '✕ Usage notes', '✓ 记忆同步': '✓ Memory sync',
    '机器': 'Machine', '命令行': 'CLI', '旧机器，只有历史对话': 'Legacy machine, history only',
    '● 没同步过': '● Never synced', '没同步过': 'Never synced',
    '对话': 'Conversations', '查询': 'Queries', '智能体状态': 'Agent status',
    '搜记忆': 'Search memory', '读记忆': 'Read memory', '写记忆': 'Write memory', '改记忆': 'Update memory', '作废': 'Retire', '最近记忆': 'Recent memories',
    '读摘要': 'Read digest', '搜原话': 'Search chats', '读原文': 'Read chat', '交接包': 'Handoff pack', '图谱': 'Graph',
    '打开浏览页': 'Open browse page', '打开大屏': 'Open wall', '打开控制台': 'Open console', '打开年报': 'Open Wrapped',
    '改设备策略': 'Change device policy', '生成加入码': 'Create join code', '作废加入码': 'Revoke join code', '开关工具': 'Toggle tool',
    '改设置': 'Change settings', '编辑记忆': 'Edit memory', '作废记忆': 'Retire memory', '合并重复': 'Merge duplicates', '保留候选': 'Keep candidate',
    '不要候选': 'Discard candidate', '恢复记忆': 'Restore memory', '生成分享链接': 'Create share link', '作废分享链接': 'Revoke share link',
    '浏览器': 'Browser', '机器 · 来源': 'Machine · source', '调用': 'Calls', '写入': 'Writes', '最近': 'Last',
    '只读': 'Read-only', '所有机器都能读写全部记忆': 'All machines can read and write all memories',
  });
  pat('● {t}同步', '● Synced $t1');
  pat('最近对话 {t}', 'Last chat $t1');
  pat('上次查 {t}', 'last query $t1');
  pat('写 {n}', 'Write $1');
  pat('拒收疑似密钥 {n} 次', 'rejected $1 suspected {1|secret|secrets}');
  pat('最近 7 天 {n} 次调用', 'Last 7 days: $1 {1|call|calls}');
  pat('权限：{*}', 'Access: $t1');
  pat('{*} 只读 看不到 {*}', '$1 read-only, cannot see $2');
  pat('{*} 只读', '$1 read-only');
  pat('{*} 看不到 {*}', '$1 cannot see $2');
  pat('看不到 {*}', 'cannot see $1');

  // ================= 知识图谱（console-graph.js）=================
  add({
    '项目': 'Project', '客户现场': 'Customer site', '版本': 'Version',
    '点图上的一个点，看它和谁有关、出现过哪些版本、最近的相关记录。': 'Click a node to see what it is linked to, which versions appeared, and the latest related records.',
  });
  pat('{n} 次', '$1 {1|time|times}');

  // ================= 分享（console-share.js）=================
  add({
    '分享 ·': 'Share ·', '分享': 'Share', '生成链接': 'Create link', '分享链接': 'Share link', '关闭后不再显示完整链接': 'The full link is not shown again after closing',
    '复制': 'Copy', '已复制': 'Copied', '关闭': 'Close', '没复制上，链接已选中，请手动复制': 'Copy failed — the link is selected, copy it manually',
    '有效的链接': 'Active links',
  });
  pat('{t} 到期', 'expires $1');
  pat('有效的链接 {n}', 'Active links $1');

  // ================= 摘要（console-digest.js）=================
  add({
    '偏好与反馈': 'Preferences and feedback', '项目现状': 'Project status', '决定与坑': 'Decisions and pitfalls', '参考与事实': 'References and facts',
    '已列出': 'Listed', '没列出': 'Not listed', '置顶': 'Pinned', '排除': 'Excluded', '没信息量': 'Vague', '重复': 'Duplicate',
    '通用词，说不清记了什么': 'Generic wording, unclear what it records', '过短': 'Too short', '只是个栏目名': 'Just a section label', '标题和正文对不上': 'Title does not match the body',
    '没信息量 · 改标题': 'Vague · edit title', '重复 · 合并': 'Duplicate · merge', '已排除': 'Excluded', '取消置顶': 'Unpin', '放回': 'Restore',
    '合并': 'Merge', '没有重复的': 'No duplicates', '没有符合的': 'No matches', '合并，保留选中的': 'Merge, keep the selected', '摘要原文': 'Digest text',
    '组': 'groups', '取消': 'Cancel',
  });
  pat('读取失败：{*}', 'Failed to load: $t1');
  pat('失败：{*}', 'Failed: $t1');
  pat('再显示 {n} 条（还有 {n}）', 'Show $1 more ($2 left)');
  pat('{n} 条近似', '$1 similar');
  pat('符合 {n}', '$1 match');
  pat('列出 {n} / {n}', 'Listed $1 / $2');
  pat('合并 {n} 条近似的记忆', 'Merge $1 similar memories');
  pat('已合并，{n} 条被取代', 'Merged, $1 superseded');

  // ================= 用量洞察（console-insight.js）=================
  add({
    '卡片': 'Cards', '忽略': 'Ignore', '恢复': 'Restore', '近 30 天没有搜不到的查询': 'No unanswered queries in the last 30 days', '还没有搜索记录': 'No search history yet',
    '读取记录从': 'Reads recorded since', '从': 'Reads recorded since', '起记录读取': '', '起': '', '还没有读取记录': 'No read records yet',
    '近这段时间每条有效记忆都被读到过': 'Every active memory has been read recently',
    '已忽略，在栏底可恢复': 'Ignored — restore it at the bottom', '已恢复': 'Restored', '记忆缺口': 'Memory gaps', '冷记忆': 'Cold memories', '未归项目': 'No project',
    '确定': 'OK',
  });
  pat('{n} 台', '$1 {1|device|devices}');
  pat('等 {n} 种', '$1 variants in total');
  pat('也有：{*}', 'Also: $1');
  pat('已忽略 {n} 条', '$1 ignored');
  pat('已忽略 {n} 条 {*}', '$1 ignored $2');
  pat('最后读到 {*}', 'Last read $1');
  pat('自 {*} 起没读到过', 'Not read since $1');
  pat('更新于 {t}', 'Updated $t1');
  pat('条（列出最早的 {n} 条）', 'items (showing the oldest $1)');
  pat('已攒 {n} 天', '$1 days collected');
  pat('攒满 {n} 天后这里才会列出', 'listed after $1 days');
  pat('{n} 天内没被读到的有效记忆', 'active memories not read in $1 days');

  // ================= 拓扑回放（console-replay.js）=================
  add({
    '5 分钟/秒': '5 min/s', '15 分钟/秒': '15 min/s', '30 分钟/秒': '30 min/s', '1 小时/秒': '1 h/s',
    '播放': 'Play', '暂停': 'Pause', '回到现在': 'Back to now', '时间轴': 'Timeline', '播放速度': 'Playback speed',
  });
  pat('设备 {*} 登记后一次都没同步过', 'Device $1 has never synced since it was registered');
  pat('设备 {*} 已经 {t}没同步', 'Device $1 has not synced for $t2');
  pat('{n} 小时', '$1 h');
  pat('回放数据读取失败：{*}', 'Failed to load replay data: $t1');

  // ================= 设备、MCP、任务、设置（console-admin.js）=================
  // 同一个汉字在不同位置译法不同：键写成 "标签|中文"（或 "标签.类名|中文"），按所在元素找
  add({
    'h2|设备': 'Devices', 'h2|令牌': 'Tokens', 'h4|令牌': 'Tokens', 'h4|设备': 'Devices', 'h4|项目': 'Projects', 'button|置顶': 'Pin', 'button|排除': 'Exclude',
  });
  add({
    '复制失败，请手动选中复制': 'Copy failed — select the text and copy it manually',
    '网关': 'Gateway', '加入码': 'Join code', '令牌': 'Token', '报表': 'Report', '抽取': 'Extractor', '管理': 'Admin',
    '设备': 'Device', '已暂停': 'Paused', '修改分组': 'Change group', '分组': 'Group', '全部': 'All', '未分组': 'Ungrouped', '读写': 'Read-write',
    '身份': 'Identity', '设备端': 'Device client', '最近同步': 'Last sync', '智能体': 'Agents', '可见项目': 'Visible projects', '还没有设备': 'No devices yet',
    '名称': 'Name', '角色': 'Role', '创建': 'Created', '最近使用': 'Last used', '主机': 'Host', '加入': 'Joined',
    '这台机器上的智能体不能再写入记忆，只能读取。': 'Agents on this machine can no longer write memories, only read them.',
    '不再告警没同步': 'Stop out-of-sync alerts', '隐藏项目': 'Hidden projects',
    '这台机器上的智能体看不到这些项目的记忆。': 'Agents on this machine cannot see memories from these projects.',
    '同步超时': 'Sync timeout', '留空 = 默认': 'empty = default', '保存': 'Save', '筛选项目': 'Filter projects', '全部可见': 'All visible',
    '没有匹配的项目': 'No matching projects', '只读：这台机器上的智能体不能再写入记忆。': 'Read-only: agents on this machine can no longer write memories.',
    '确认限制': 'Confirm restriction', '添加设备': 'Add device', '长期': 'No expiry', '加入码有效期': 'Join code validity',
    '设备加入后一直有效，期限只管这个码还能不能用来加新机器。': 'Joined devices stay valid; the validity only controls whether this code can still add new machines.',
    '还在生效的加入码': 'Active join codes', '加入码已作废': 'Join code revoked', '重新生成': 'Regenerate',
    '这个加入码长期有效，不用了可以在下面作废。': 'This join code never expires. Revoke it below when you no longer need it.',
    '已停用': 'Disabled', '写': 'Write', '读': 'Read', '工具': 'Tools', '用途': 'Purpose', '7 天调用': 'Calls (7d)', '耗时 中位 / 95 分位': 'Latency p50 / p95',
    '失败率': 'Failure rate', '最近一次': 'Last call', '启用': 'Enabled', '没有工具': 'No tools', '停用': 'Disable', '已启用': 'Enabled',
    '所有机器上的所有智能体都调不了这个工具，直到重新启用。': 'No agent on any machine can call this tool until you enable it again.',
    '设备同步': 'Device sync', '没有设备': 'No devices', '还没有接入设备': 'No devices connected yet', '要注意': 'Attention', '正常': 'OK', '没同步': 'Not synced',
    '最近一次同步': 'Last sync', '会话抽取': 'Session extraction', '没开': 'Off', '还没有会话进入抽取': 'No sessions have entered extraction yet',
    '待处理': 'Pending', '出错': 'Errors', '已处理': 'Processed', '最近上传': 'Last upload', '最近处理': 'Last processed', '最近自动通过': 'Last auto-approved',
    '工作日志': 'Work journal', '还没有生成过工作日志': 'No work journal generated yet', '已写天数': 'Days written', '今天 / 昨天': 'Today / yesterday', '最近生成': 'Last generated',
    '向量索引': 'Vector index', '已有条目': 'Items indexed', '没开，按意思搜暂不可用': 'Off — semantic search unavailable', '正在建': 'Building', '条目': 'Items', '模型': 'Model',
    '对话存档盘': 'Conversation archive disk', '没有存档盘信息': 'No archive disk information', '没挂载': 'Not mounted', '会话': 'Sessions', '总量': 'Total',
    '存档盘没挂载，新对话暂时存不进去': 'The archive disk is not mounted; new conversations cannot be stored for now',
    '记忆仓库': 'Repo', '作者': 'Author', '内容': 'Content', '最近提交': 'Last commit', '还没有提交记录': 'No commits yet',
    '巡检': 'Health check', '问题': 'Issues', '没有发现问题': 'No issues found', '没有巡检结果': 'No health check results',
    '设备名': 'Device name', '显示名': 'Display name', '删除': 'Delete', '撤销清除': 'Undo clear', '清除': 'Clear', '保存后清除': 'Cleared on save',
    '已设置，留空不改': 'Already set — leave empty to keep', '设备显示名里有重复的设备名': 'Duplicate device names in the display names', '已保存，已当场生效': 'Saved and applied immediately',
    '· 默认': '· default', '公开地址': 'Public URL', '会出现在安装命令和 MCP 接入地址里，设备按它连回中心': 'Shown in install commands and the MCP endpoint; devices use it to connect back to the hub',
    '向量服务': 'Vector service', '留空 = 不开按意思搜': 'Empty = semantic search off', '小时': 'hours', '候选自动通过': 'Auto-approve candidates', '摘要大小': 'Digest size', '字节': 'bytes',
    '不自动接入的设备名': 'Device names that are not auto-enrolled', '每行一个正则，不分大小写': 'One regex per line, case-insensitive', '正则写错整个保存会被拒': 'A malformed regex rejects the whole save',
    '模型接口地址': 'Model API URL', 'OpenAI 兼容的对话接口：写接口根（…/v1）或完整的 …/chat/completions 都行': 'OpenAI-compatible chat API: either the API root (…/v1) or the full …/chat/completions URL works',
    '模型名': 'Model name', '密钥': 'API key', '设备显示名': 'Device display names', '添加一项': 'Add entry', '图谱里要认的名字': 'Names recognized in the graph', '现场': 'Sites',
    '地址': 'Address', '时间与额度': 'Time and limits', '问答': 'Ask', '显示与图谱': 'Display and graph', '还原': 'Revert', '输入后回车': 'Type and press Enter',
    '有未保存的修改': 'Unsaved changes', '离开后这些修改会丢掉。': 'These changes will be lost if you leave.', '离开': 'Leave', '最新版本': 'Latest version',
  });
  pat('修改 {*} 的分组', 'Change group of $1');
  pat('{*} 已放进「{*}」', '$1 added to "$2"');
  pat('{*} 已移出分组', '$1 removed from group');
  pat('最新版本 {*}', 'Latest version $1');
  pat('隐藏 {n} 个', '$1 hidden');
  pat('已隐藏 {n} 个', '$1 hidden');
  pat('隐藏项目：这台机器上的智能体看不到「{*}」的记忆。', 'Hidden projects: agents on this machine cannot see memories from "$1".');
  pat('限制 {*}', 'Restrict $1');
  pat('{*} 已更新', '$1 updated');
  pat('{n} 条记忆', '$1 {1|memory|memories}');
  pat('{n} 天', '$1 {1|day|days}');
  pat('{t} 生成', 'Created $1');
  pat('加入了 {n} 台', '$1 {1|device|devices} joined');
  pat('这个加入码 {t} 到期。', 'This join code expires $1.');
  pat('近 7 天 {n} 次调用', '$1 {1|call|calls} in the last 7 days');
  pat('近 7 天 {n} / {n} 次失败', '$1 of $2 calls failed in the last 7 days');
  pat('启用 {*}', 'Enable $1');
  pat('停用 {*}', 'Disable $1');
  pat('{*} 已停用', '$1 disabled');
  pat('{*} 已启用', '$1 enabled');
  pat('{n} 段 / {n} 段', '$1 / $2 segments');
  pat('{n} 个问题', '$1 {1|issue|issues}');
  pat('删除 {*}', 'Delete $1');
  pat('{n} 项未保存', '$1 unsaved {1|change|changes}');
  pat('留空 = 默认 {n}', 'empty = default $1');
  pat('{n} 段', '$1 segments');
  pat('{n} 个', '$1');

  // ================= 记忆库、待整理、对话存档（console-memory.js）=================
  add({
    '全部类型': 'All types', '全部项目': 'All projects', '全部来源': 'All sources', '全部方式': 'All methods', '对话日志': 'Conversation journal',
    '搜索中…': 'Searching…', '输入一句话，按意思找相近的记忆': 'Type a sentence to find memories by meaning', '用一句话描述要找的内容': 'Describe what you are looking for in a sentence',
    '搜标题和正文，空格分隔多个词': 'Search titles and bodies, separate words with spaces', '选一条看全文': 'Select a memory to read it', '← 列表': '← List', '没有这条记忆': 'This memory does not exist',
    '…差异太长，后面省略': '… diff too long, rest omitted', '历史': 'History', '收起': 'Collapse', '当前 ·': 'Current ·', '已经是当前版本': 'Already the current version', '差异': 'Diff',
    '会新增一个版本，现在的内容仍留在历史里，可以再恢复回来。': 'This adds a new version. The current content stays in the history and can be restored again.',
    '已恢复，产生了一个新版本': 'Restored — a new version was created', '来源': 'Source', '方式': 'Method', '主题': 'Subject', '更新': 'Updated', '编号': 'ID',
    '保留': 'Keep', '不要': 'Discard', '编辑': 'Edit', '工具自己记的，只能作废；要改请改那台机器上的源文件': 'Written by the tool itself — it can only be retired; edit the source file on that machine to change it',
    '读不到全文，先别改': 'Cannot read the full text — do not edit yet', '标题': 'Title', '项目（英文短名）': 'Project (short name)', '正文': 'Body',
    '标题不能为空': 'Title cannot be empty', '已保存': 'Saved', '已保留': 'Kept', '已放弃这条候选': 'Candidate discarded', '原因': 'Reason', '过时/重复': 'Outdated/duplicate',
    '这是工具自己记的，源文件改了会重新出现。': 'This was written by the tool itself; it will reappear if the source file changes.',
    '不会真删：这些条目变为「已作废」，在状态筛选里选「已作废」可以找回。': 'Nothing is deleted: these entries become "Retired" and can be found again with the "Retired" status filter.',
    '搜索': 'Search', '关键词': 'Keyword', '按意思': 'Semantic', '有效的': 'Active', '全部状态': 'All statuses', '状态': 'Status', '全选': 'Select all',
    '向量服务没开（config 里没有 embed_url）': 'Vector service is off (no embed_url in config)', '向量服务没开': 'Vector service is off',
    '打开': 'Open', '没有待审候选': 'No pending candidates', '仍有效': 'Still valid', '没有过期的现状': 'No stale status entries',
    '没有疑似重复的': 'No possible duplicates', '已确认仍有效': 'Confirmed still valid', '过时': 'Outdated', '全部设备': 'All devices', '全部智能体': 'All agents',
    '输入关键词，搜所有设备上的对话原文': 'Enter keywords to search conversation text on all devices', '没搜到': 'No results', '用户': 'User', '助手': 'Assistant', '展开全文': 'Show full text',
    '选一个会话读原文': 'Select a session to read it', '从头读': 'Read from start', '这一天没有消息': 'No messages on this day', '加载更多': 'Load more', '没有这个会话': 'This session does not exist',
    '存成记忆': 'Save as memory', '已存成记忆': 'Saved as memory', '看这条': 'View', '类型': 'Type', '主题键': 'Subject key', '如 myapp/prod-version': 'e.g. myapp/prod-version',
    '搜对话原文，空格分隔多个词': 'Search conversation text, separate words with spaces', '搜索对话': 'Search conversations', '至': 'to', '开始日期': 'Start date', '结束日期': 'End date',
    '审批': 'Review',
  });
  pat('相似 {n}%', 'similarity $1%');
  pat('搜索失败：{*}', 'Search failed: $t1');
  pat('作废选中的（{n}）', 'Retire selected ($1)');
  pat('出处：对话 {*} · {*}', 'Source: conversation $1 · $2');
  pat('{*} · 控制台', '$1 · console');
  pat('审批 · {*}', 'Review · $1');
  pat('列出最近 {n} 版', 'showing the latest $1');
  pat('{n} 版', '$1 {1|version|versions}');
  pat('恢复到 {*} 的版本', 'Restore the version from $1');
  pat('恢复失败：{*}', 'Restore failed: $t1');
  pat('读不到全文，先别改：{*}', 'Cannot read the full text — do not edit yet: $t1');
  pat('作废「{*}」', 'Retire "$1"');
  add({
    '不会真删：条目变为「已作废」，在状态筛选里选「已作废」可以找回。': 'Nothing is deleted: the entry becomes "Retired" and can be found again with the "Retired" status filter.',
    '不会真删：条目变为「已作废」，在记忆库的状态筛选里选「已作废」可以找回。': 'Nothing is deleted: the entry becomes "Retired" and can be found again with the "Retired" status filter in the library.',
    '当前': 'Current',
  });
  pat('{n} 组', '$1 groups');
  pat('不会真删：条目变为「已作废」，在状态筛选里选「已作废」可以找回。{*}', 'Nothing is deleted: the entry becomes "Retired" and can be found again with the "Retired" status filter. $t1');
  pat('不会真删：条目变为「已作废」，在记忆库的状态筛选里选「已作废」可以找回。{*}', 'Nothing is deleted: the entry becomes "Retired" and can be found again with the "Retired" status filter in the library. $t1');
  pat('作废选中的 {n} 条', 'Retire $1 selected');
  pat('作废 {n} 条', 'Retire $1');
  pat('已作废 {n} 条', 'Retired $1');
  pat('更新 {t}', 'Updated $t1');
  pat('合并 {n} 条', 'Merge $1');
  pat('保留「{*}」，其余 {n} 条标为「已被取代」并指向它。不会真删，在记忆库的状态筛选里选「已被取代」可以找回。', 'Keep "$1"; the other $2 become "Superseded" and point to it. Nothing is deleted — find them again with the "Superseded" status filter in the library.');
  pat('列出最近 {n} 个', 'showing the latest $1');
  pat('{n} 个会话命中', '$1 {1|session matches|sessions match}');
  pat('{n} 条消息', '$1 {1|message|messages}');
  pat('{n} 条', '$1 {1|item|items}');

  // ================= 拓扑（console-topology.js）=================
  add({
    '控制台配置': 'Console config', '设备页': 'Devices page', 'MCP 页': 'MCP page', '任务页': 'Jobs page',
    '超时没同步': 'Out of sync', '正在干活': 'Working', '同步中': 'Syncing', '空闲': 'Idle', '还没加入': 'Not joined yet',
    '读取': 'Reads', '认证网关': 'Gateway', '台': 'devices', '经网关认出身份': 'authenticated', '未启用': 'Not enabled', '中心': 'Hub',
    '次调用': 'calls', '近 7 天': 'last 7 days', '还没有提交': 'No commits yet', '条': 'items', '个': '', '没挂上': 'Not mounted', '抽取机': 'Extractor',
    '还没有活动': 'No activity yet', '待写日志': 'Journals', '段': '', '正在建索引': 'Indexing', '已建向量': 'Vectors built',
    '按': 'Acting as', '的身份': '', '近 24 小时': 'Last 24 h', '最近对话': 'Last chat', '近 7 天调用': 'Calls (7d)', '已挂上': 'Mounted', '待抽取会话': 'Sessions to extract',
    '没有记录': 'No records', '没有对话': 'No chats', '接入方式': 'Connection', '（网关没启用）': '(gateway not enabled)', '设备端版本': 'Device client version', '暂停同步': 'Pause sync',
    '提交说明': 'Commit message', '抽取失败': 'Extraction failures', '已开': 'On', '已暂停同步': 'Sync paused', '已恢复同步': 'Sync resumed', '已设为只读': 'Set to read-only', '已恢复读写': 'Read-write restored',
    '退出全屏': 'Exit full screen', '全屏': 'Full screen', '近 24 小时没有新对话': 'No new chats in the last 24 hours', '刚刚发生': 'Just happened', '控制台': 'console',
    '待抽取': 'Pending extraction',
  });
  pat('{t}提交', 'committed $t1');
  pat('{t}活动', 'active $t1');
  pat('{n} 超时', '$1 timed out');
  pat('{n} 台设备超时没同步', '$1 {1|device is|devices are} out of sync');
  pat('{*} 近 7 天', '$1 last 7 days');
  pat('中心 v{*}', 'Hub v$1');
  pat('去{*}', 'Go to $t1');
  pat('拓扑刷新失败：{*}', 'Topology refresh failed: $t1');

  // ================= 时间线、项目、待办（console-work.js）=================
  add({
    '还没有数据': 'No data yet', '会话段': 'Session segments', '消息': 'Messages', '没有会话': 'No sessions', '少': 'Less', '多': 'More',
    '这天没有会话': 'No sessions on this day', '（日志还没写）': '(journal not written yet)', '时间不详（旧导出）': 'Time unknown (legacy export)',
    '你发的消息': 'Messages you sent', '占这个范围的': 'Share of this range', '没有': 'None', '▶ 时光回放': '▶ Time-lapse', '■ 停止': '■ Stop',
    '正在统计作息…': 'Analyzing routines…', '工作日历': 'Work calendar', '点亮': 'Find', '当天在做什么': 'What happened that day', '‹ 前一天': '‹ Prev', '后一天 ›': 'Next ›',
    '作息打卡': 'Activity by hour', '大事记': 'Milestones', '搜一个词，看哪些天做过：部署、登录页、2.9.20…': 'Search a word, e.g. deploy…',
    '（按关键词）': '(by keyword)', '生成中…': 'Generating…', '项目河流': 'Project river', '项目排行': 'Project ranking', '机器 → 智能体 → 项目': 'Machine → agent → project',
    '最近 7 天': 'Last 7 days', '最近 14 天': 'Last 14 days', '最近 30 天': 'Last 30 days', '最近 60 天': 'Last 60 days', '生成': 'Generate',
    '可选：再加个关键词': 'Optional: add a keyword', '生成后在这里，点「复制」贴给新会话或新智能体': 'The result appears here — click "Copy" and paste it into a new session or agent',
    '卡住': 'Blocked', '进行中': 'In progress', '✓ 已收尾': '✓ Done', '不用管': 'Dismiss', '看那天': 'View that day', '没有悬着的事': 'Nothing pending', '待办雷达': 'Todo radar',
    '个会话里': 'sessions',
  });
  pat('{t}（周{w}）', '$1 ($w2)');
  pat('{n} 个会话提到「{*}」', '$1 {1|session mentions|sessions mention} "$2"');
  pat('没提到「{*}」', 'No mention of "$1"');
  pat('{n}+ 个会话', '$1+ sessions');
  pat('正在找「{*}」…', 'Searching for "$1"…');
  pat('「{*}」出现在', '"$1" appears on');
  pat('最早 {*}', 'earliest $1');
  pat('没找到「{*}」', 'No match for "$1"');
  pat('{t} 周{w}', '$1 $w2');
  pat('（日志还没写）{*}', '(journal not written yet) $1');
  pat('周{w} {n}:00–{n}:00', '$w1 $2:00–$3:00');
  pat('最常在周{w} {n} 点干活', 'Busiest on $w1 at $2:00');
  pat('凌晨 0–5 点的消息占 {n}%（紫色底的格子）', '$1% of messages are between 0:00 and 5:00 (purple cells)');
  pat('周末占 {n}%', '$1% on weekends');
  pat('{n} 件', '$1 {1|item|items}');
  pat('累计 {n} 段会话', '$1 sessions in total');
  rule(/^(\d[\d,.]*) 万条消息$/, (m) => `${(parseFloat(m[1]) * 10).toFixed(1)}K messages`);
  pat('{t} 这周', '$1 week');
  pat('全部 {n}', 'All $1');
  pat('停了的项目：{*}', 'Stalled projects: $1');
  pat('{t}（{n} 天前）', '$1 ($2 {2|day|days} ago)');
  pat('最近 7 天新增 {n} 条', '$1 added in the last 7 days');
  pat('最近 7 天智能体查了 {n} 次', 'agents queried $1 {1|time|times} in the last 7 days');

  // ================= 全局搜索（console-search.js）=================
  add({
    '页面': 'Pages', '没搜完': 'search incomplete', '在对话存档里看全部命中': 'See all hits in the conversation archive', '问答还没配置': 'Ask is not configured yet',
    '去设置': 'Go to settings', '检索并回答中…': 'Searching and answering…', '出处': 'Sources', '问我的记忆，回车提交': 'Ask my memories, press Enter to submit', '未配置': 'Not configured',
    '搜记忆、对话、项目、设备、页面': 'Search memories, conversations, projects, devices, pages', '问': 'Ask', '全局搜索': 'Global search', '模式': 'Mode',
  });
  pat('出处 {n}', 'Source $1');
  pat('在记忆库里看全部 {n}+ 条', 'See all $1+ in the library');
  pat('在记忆库里看全部 {n} 条', 'See all $1 in the library');
  pat('没有找到「{*}」', 'No results for "$1"');
  pat('另有 {n} 条检索到、没被引用的资料', '$1 more retrieved but not cited');
  pat('搜索（{*}）', 'Search ($1)');

  // ================= 独立页面：大屏（wall.html）、年报（wrapped.html）=================
  add({
    '⛶ 全屏': '⛶ Full screen', '返回控制台': 'Back to console', '实时拓扑': 'Live topology', '⏸ 暂停巡航': '⏸ Pause tour', '▶ 开始巡航': '▶ Start tour',
    '所有机器': 'All machines', '所有智能体': 'All agents',
    '你的 AI 工作年报': 'Your AI Work Wrapped', '← 控制台': '← Console',
    '正在翻你这几个月的对话…（第一次要统计一下，几秒钟）': 'Going through your conversations of the past months… (the first run takes a few seconds to compute)',
    '点击 / → 下一页 · ← 上一页': 'Click or → next · ← previous',
    '这是你和 Claude Code、Codex、WorkBuddy、Hermes、OpenClaw……一起干活的几个月。往下翻。': 'These are the months you spent working with Claude Code, Codex, WorkBuddy, Hermes, OpenClaw… Scroll on.',
    '你们说了多少话': 'How much you talked', '字': ' chars', '是你发给智能体的（含粘贴进去的需求、日志和交接）': 'sent by you to agents (including pasted requirements, logs and handoffs)',
    '它们回了你': 'They replied with', '字。你一共发了': 'chars. You sent', '条消息。': 'messages in total.',
    '光是你写给它们的，就够': 'What you wrote to them alone fills', '套《三体》三部曲。': 'copies of the Three-Body trilogy.',
    '最忙的一天': 'Your busiest day', '段会话、': 'sessions, ', '那天在忙：': 'That day you were busy with: ',
    '连续作战': 'Longest streak', '周末也没闲着：': 'Weekends too: ', '的会话发生在周六日，差不多每三段工作就有一段在周末。': 'of sessions happened on a Saturday or Sunday — about one in every three pieces of work.',
    '夜猫子指数': 'Night owl index', '个凌晨': ' early mornings', '你在 0–5 点还在给智能体发消息，一共': 'You were still messaging agents between 0:00 and 5:00 — a total of',
    '（按"你这边发出的消息"算，含定时任务和别的会话转过来的）': '(counted by messages sent from your side, including scheduled tasks and ones forwarded from other sessions)',
    '最晚的一次是': 'The latest was', '你的高峰时刻': 'Your peak hour', '点': ' o\'clock', '一天里你最常在这个钟点找智能体干活': 'The hour of the day you most often put agents to work',
    '一周 168 个小时里最忙的一格是': 'The busiest of the 168 hours in a week is', '。': '.', '0 点': '0:00', '23 点': '23:00',
    '紫色是凌晨，橙色是全天最忙的那个小时。': 'Purple is the small hours, orange is the busiest hour of the day.',
    '你的 AI 搭档': 'Your AI partner', '是你用得最多的': 'is the one you used the most', '干活最多的机器：': 'Busiest machines: ', '你的项目': 'Your projects', '段会话': 'sessions',
    '你最常说的话': 'What you say most', '你一共说了': 'You said it', '次': 'times', '这几个月干成的事': 'What you got done these months', '件': ' milestones',
    '上线、发布、交付、升级现场、合并 main……最近这几件：': 'Launches, releases, deliveries, site upgrades, merges into main… the most recent ones:',
    '而且它还在长': 'And it keeps growing', '条记忆，所有机器、所有智能体共享': 'memories, shared by all machines and all agents',
    '每 10 分钟，新的对话汇进来；每天三次，写成日志。': 'Every 10 minutes new conversations flow in; three times a day they are written up as a journal.',
    '明天你在任何一台机器上问"那件事哪天做的"，它都记得。': 'Tomorrow, ask "when was that done?" on any machine — it will remember.',
    '去控制台看看 →': 'Go to the console →', '看时光回放 ▶': 'Watch the time-lapse ▶',
    '周一': 'Mon', '周二': 'Tue', '周三': 'Wed', '周四': 'Thu', '周五': 'Fri', '周六': 'Sat', '周日': 'Sun',
  });
  pat('第 {n} 屏', 'Screen $1');
  pat('{t} 起每一天做了什么', 'what happened every day since $1');
  pat('数据生成于 {*}', 'Data generated $1');
  pat('{n} 台机器', '$1 machines');
  pat('{n} 种智能体', '$1 agent types');
  pat('一天都没停过：{*} → {*}', 'Not a single day off: $t1 → $t2');
  pat('你对 {*} 说：', 'you told $1:');
  pat('占 {n}% 的会话', '$1% of sessions');
  pat('{*} 占了最多的心思：', '$1 took most of your attention:');
  pat('大事 {n} 件', '$1 milestones');
  pat('{n} 点：{n} 条', '$1:00 · $2 messages');
  pat('周{w} {n} 点', '$w1 $2:00');
  rule(/^(\d{1,2}) 月 (\d{1,2}) 日$/, (m) => `${MON[+m[1] - 1] || m[1]} ${m[2]}`);
  rule(/^(\d{1,2}) 月 (\d{1,2}) 日 → (\d{1,2}) 月 (\d{1,2}) 日$/, (m) => `${MON[+m[1] - 1] || m[1]} ${m[2]} → ${MON[+m[3] - 1] || m[3]} ${m[4]}`);
  rule(/^(\d{1,2}) 月 (\d{1,2}) 日 凌晨 (.+)$/, (m) => `${MON[+m[1] - 1] || m[1]} ${m[2]}, ${m[3]} AM`);

  rule(/^(\d{2}-\d{2} \d{2}:\d{2}) (用户|助手)$/, '$1 $t2');
  rule(/^(.+?) (已暂停同步|已恢复同步|已设为只读|已恢复读写)$/, '$1: $l2'); // 拓扑抽屉里开关后的提示：设备名 + 动作

  // 顶栏主题按钮的提示（console-theme.js）："主题：跟随系统（现为深色），点一下改为浅色"
  add({ '跟随系统': 'Follow system', '浅色': 'Light', '深色': 'Dark', '现为': 'now ', '点一下改为': 'click for ' });
  pat('主题：{*}（现为{*}）', 'Theme: $t1 (now $l2)');
  pat('主题：{*}', 'Theme: $t1');
  pat('点一下改为{*}', 'click for $l1');

  // ================= 宽规则放最后：前面的具体规则先试，轮不到它们 =================
  pat('{t} 至 {t}', '$1 to $2');
  pat('{*}（{n}）', '$t1 ($2)');
  rule(/^(.+?)（(刚刚|今天|\d+ (?:分钟|小时|天)前)）$/, '$1 ($l2)');
  pat('最近 {t}', 'latest $l1');
  pat('「{*}」', '"$1"');
  pat('{*}：{n}', '$t1: $2');
  // 通用的"标签 数字"（状态筛选、徽标、统计）：标签翻得动才翻，翻不动（用户数据）的原样
  rule(/^(.+?) (-?\d[\d,.]*)$/, (m, t) => { const a = t(m[1]); return a === m[1] ? null : `${a} ${m[2]}`; }, true);
})();
