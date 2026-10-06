# 会话管理 覆盖矩阵

> 模块：02 会话管理
> 来源：PRD 02（docs/prd/02_session_management.md）
> 状态：已确认
> 层级映射：unit=forge-core 纯逻辑；API=IPC 方法契约 + pi session 对接 + forge-core 输出流管理；E2E=Electron 桌面 UI（含多窗口画布）

---

## 风险维度适用性

| 风险维度 | 是否适用 | 原因 | 覆盖要求 |
|---|---|---|---|
| 正常流程 | 适用 | 创建/切换/删除/重命名/多窗口五场景主流程 | P0 |
| 字段边界 | 适用 | 别名非空、header 校验 | P1 |
| 权限角色 | 适用 | 单用户；会话信任继承项目 | P0 |
| 状态流转 | 适用 | stop/idle/running/done/error；删除运行中会话先停止 | P0 |
| 异常失败 | 适用 | session 创建失败、删除失败、窗口崩溃、会话被删时窗口关 | P1 |
| 数据一致性 | 适用 | 切换不影响其他会话；会话输出与窗口解耦；消息不丢不重 | P0 |
| 幂等重复 | 适用 | 重复删除无副作用；同一会话不重复开窗；重命名幂等 | P1 |
| 查询组合 | 适用 | 按项目过滤会话列表；跨项目全量列表 | P2 |
| 前端反馈 | 适用 | 删除二次确认、窗口吸附预览、z-index 置顶、4 窗格 | P1 |
| 跨模块影响 | 适用 | 输出流由 forge-core 统一管理（与模块 03 事件）、会话池跨项目 | P0 |

---

## 覆盖基线

| AC ID | PRD 功能点 | 风险维度 | 场景 | 优先级 | Unit ID | API ID | E2E ID | 核心断言 | 备注 |
|---|---|---|---|---|---|---|---|---|---|
| AC-SM-001 | SM-S01 创建会话 | 跨模块协作 | 正常流程：项目下新建 | P0 | - | A-SM-001 | E-SM-001 | 主视图显示新会话并聚焦输入框；cwd=项目目录 | |
| AC-SM-002 | SM-S01 创建会话 | 数据一致性 | 正常流程：cwd 正确 | P1 | - | A-SM-001 | - | session 创建后 cwd 等于项目路径 | 需 pi mock |
| AC-SM-003 | SM-S02 切换会话 | 状态/一致性 | 正常流程：切换不影响他 | P0 | - | A-SM-002 | E-SM-002 | 切换选中 B，A 仍运行中不暂停 | 多会话并行核心 |
| AC-SM-004 | SM-S02 切换会话 | 状态 | 正常流程：看运行中会话实时输出 | P1 | - | - | E-SM-002 | 切换到 running 会话显示实时流式内容 | |
| AC-SM-005 | SM-S03 删除 | 安全/一致性 | 不可逆操作：删除确认 | P0 | U-SM-003（v3.74：转录 JSONL+子 agent 目录真删、不误伤 CLI 会话、失败上抛） | A-SM-003 | E-SM-003 | 二次确认；确认后 pi session 被永久删除（v3.74 落地磁盘真删） | 无需 cancel 按钮 |
| AC-SM-006 | SM-S03 删除 | 状态/一致性 | 异常：删除运行中会话 | P0 | U-SM-001 | A-SM-003 | E-SM-003 | 先停止 AgentSession 再删除 | 状态校验 |
| AC-SM-007 | SM-S03 重命名 | 一致性 | 正常流程：改别名 | P1 | U-SM-002 | A-SM-004 | - | 别名变更，pi session 消息不变 | |
| AC-SM-008 | SM-S04 多会话并行 | 并发/一致性 | 正常流程：≤10 会话并行 | P0 | U-SM-002 | A-SM-005 | E-SM-002 | 各会话独立流式输出，互不阻塞 | 典型 ≤10 |
| AC-SM-009 | SM-S04 多会话并行 | 状态 | 正常流程：切换不影响其他 | P0 | - | A-SM-005 | E-SM-002 | 有会话运行时切换，其他会话继续 | |
| AC-SM-010 | SM-S04 多会话并行 | 可观测性 | 正常流程：状态列表+运行数 | P1 | - | - | E-SM-002 | 列表显示各会话实时状态与运行中会话数 | |
| AC-SM-011 | SM-S05 多窗口观察 | 状态 | 正常流程：拖会话开窗 | P0 | - | A-SM-006 | E-SM-004 | 拖到画布开窗，显示会话实时内容 | |
| AC-SM-012 | SM-S05 多窗口观察 | 一致性 | 正常流程：关窗不删会话 | P0 | - | A-SM-006 | E-SM-004 | 关闭窗口仅摘除展示，会话回会话池；删除 session 保留 | |
| AC-SM-013 | SM-S05 多窗口观察 | 交互 | 正常流程：窗口吸附 | P1 | - | - | E-SM-004 | 拖到左边缘松手铺满左半区 | Window Snap |
| AC-SM-014 | SM-S05 多窗口观察 | 交互 | 正常流程：z-index 置顶 | P1 | - | - | E-SM-004 | 点/拖/resize 窗口置顶 | |
| AC-SM-015 | SM-S05 多窗口观察 | 跨模块 | 正常流程：跨项目开窗 | P1 | - | A-SM-007 | E-SM-004 | 两个项目会话可同时开窗并排 | |
| AC-SM-016 | SM-S05 多窗口观察 | 幂等 | 异常：会话已开窗 | P1 | - | A-SM-006 | E-SM-004 | 同一会话重复开窗被拒绝/聚焦已有窗口 | 幂等断言 |
| AC-SM-017 | SM-S05 多窗口观察 | 交互 | 正常流程：各吸附区 | P1 | - | - | E-SM-005 | 拖到右/上/下/四角吸附对应区域并预览 | 8 区覆盖 |
| AC-SM-018 | SM-S05 多窗口观察 | 交互 | 正常流程：4 窗格 | P1 | - | - | E-SM-005 | 点"4 窗格"排列 2×2 严丝合缝 | |
| AC-SM-019 | SM-S05 多窗口观察 | 交互 | 正常流程：resize | P1 | - | - | E-SM-005 | 拖右下角缩放，受最小尺寸限制 | |
| AC-SM-020 | SM-S05 多窗口观察 | 可用性/一致性 | 异常：窗口崩溃 | P1 | - | A-SM-008 | E-SM-005 | 崩溃后从其会话重开，恢复已展示内容 | 窗口状态在 forge-core |
| AC-SM-021 | SM-S04 状态显示（绿点） | 状态/一致性 | 正常流程：完成结果已读落盘 | P1 | U-SM-004 | A-SM-009 | - | 查看后绿点消失且跨窗口/重启一致；新一轮完成重新提示 | 替代 UI 内存态已读集合 |
| AC-SM-022 | SM-S06 双视角 | 状态/一致性 | 正常流程：视角切换+项目 tag+记忆 | P0 | - | - | E-SM-006 | 任务视角平摊全部会话、行尾项目 tag；视角选择重启保持 | tag 别名优先 |
| AC-SM-023 | SM-S06 双视角 | 状态 | 正常流程：任务视角排序同规则 | P0 | U-SM-005 | - | E-SM-006 | 运行中置顶且保留；从未激活保持后端原序（稳定） | 混合状态会话集 |
| AC-SM-024 | SM-S06 收起/展开全部 | 交互/状态 | 正常流程：全收起⇄全展开 | P1 | U-SM-005 | - | E-SM-006 | 任一展开→点=全收起；全收起→点=全展开；图标随态切换 | 混合折叠态 |
| AC-SM-025 | SM-S06 双视角 | 一致性 | 正常流程：行操作两视角一致 | P1 | - | - | E-SM-006 | 删除/重命名/拖拽开窗/已开窗灰态与项目视角一致 | 含已开窗会话 |
| AC-SM-026 | SM-S06 多窗口配套 | 可观测性 | 正常流程：聚焦行项目 pill | P2 | - | - | E-SM-006 | 「返回多窗口」聚焦行显示归属项目 | 跨项目窗口聚焦 |
| AC-SM-027 | SM-S07 LOGO 缩放按钮 | 交互 | 正常流程：LOGO 瓷片与缩放合一 | P1 | - | - | E-SM-006 | 默认显瓷片、hover 缩放图标、点击折叠/展开行为不变；FORGE 文字隐藏 | 折叠/展开两态 |
| AC-SM-028 | SM-S01 输入框项目选择器 | 跨模块协作 | 正常流程:草稿态选归属 | P0 | - | - | E-SM-007 | 草稿下拉可选归属项目（选中=切当前项目，草稿保留）；条目按最近使用置顶排序（MRU：新建项目/创建会话成功触发置顶，纯选中不改序，持久）；条目悬停可移除（两阶段确认，仅删 forge 元数据）；条目不显运行中点/✓；含“打开项目…”直接弹系统目录选择器，注册后自动选中为草稿归属（草稿保留，v3.48） | 双视角下均可见；移除当前归属后回落首个剩余项目 |
| AC-SM-029 | SM-S01 会话中信息态 | 状态 | 正常流程：归属可见 | P1 | - | - | E-SM-007 | 会话中 pill 只读显示归属，不弹浮窗 | 归属不可更换 |
| AC-SM-030 | SM-S01 新建默认落点 | 状态 | 正常流程：默认选列表第一项 | P0 | U-SM-006 | - | E-SM-007 | 默认=项目选择器列表第一项（列表序不变）；项目树行内新建固定归属所在项目；无项目才禁用新建 | 多窗口画布下新建先退回单会话视图 |

---

## 用例设计说明

### unit

| 用例 ID | 关联 AC | 测试对象 | 风险维度 | 前置条件 | 输入 | 操作 | 预期结果 | 负向断言 |
|---|---|---|---|---|---|---|---|---|
| U-SM-001 | AC-SM-006 | sessionService 删除运行中会话 | 状态流转 | 会话 running | sessionId | deleteSession | 先 stop AgentSession 再删除 pi session；状态机合法 | 不经停止直接删除被拦截 |
| U-SM-002 | AC-SM-008 | sessionManager 并发实例 | 并发 | 10 个会话 | 10 会话并行发消息 | 同时发起 | 各输出流独立；无共享状态串扰 | 资源不足时提示但不强制停止 |
| U-SM-003 | AC-SM-007 | sessionService 重命名 | 状态 | 会话存在 | alias | updateSessionAlias | forge 侧 alias 更新；pi 消息文件不变 | alias 为空的拒绝 |
| U-SM-004 | AC-SM-021 | sessionService 已读落盘 | 状态流转 | 会话 done | sessionId | markSessionRead + setSessionStatus(done) | doneReadAt 落库；新一轮 done 转入清已读；done→done 重复写不清 | 空 ID 1001 / 会话不存在 1002 |
| U-SM-005 | AC-SM-023/024 | sessionView 纯函数（排序/全收起判定） | 状态/交互 | 混合状态会话集 + 激活序 | sessions + activatedOrder / paths + collapsed 集 | sortSessionsByActivation / nextFoldAllAction | 运行中置顶且保留；未激活稳定后置；任一展开→collapse、全收起→expand | 空列表/空折叠集不抛错，返回稳定结果 |
| U-SM-006 | AC-SM-030 | App 新建默认落点（onCreateSession） | 状态 | ≥2 项目 + 已选中的旧项目 | 载荷路径 / 无载荷 | onCreateSession(sessionProjectPath?) | 无载荷→归属=选择器列表第一项；行内新建带路径→归属=该项目；均进入草稿态且不创建 pi session | 无项目时不进草稿；旧选中项目不被沿用 |
| U-SM-007 | AC-SM-023（+ PRD 默认项「会话列表按最近活动时间排序」） | sessionService 排序持久化（setSessionStatus → store） | 状态 | 3 会话、活动时间固定为互异旧值 | sessionId 逐个 setSessionStatus(running/done) | 转 running 时 touch lastActiveAt 落盘 | listSessions 按活动降序：该会话置顶、done 后不回落；**重开 store（重启/新窗口读盘）后顺序保持** | 会话不存在不写盘；同轮重复 running 不重复写 |

### api（IPC 契约 + pi 对接 + 输出流管理）

| 用例 ID | 关联 AC | 接口 | 前置条件 | 请求数据 | 预期响应/错误码 | 数据落地 | 断言点 |
|---|---|---|---|---|---|---|---|
| A-SM-001 | AC-SM-002 | session/createSession | 项目已注册 | { projectPath } | 0 + session | forge-store 写入 session 记录 | sessionId/cwd 正确；store 落库 |
| A-SM-002 | AC-SM-003 | session/switch-a | 多会话 | { sessionId: "b" } | 200 | 无 | a 仍 running；b 显示 |
| A-SM-003 | AC-SM-006 | session/deleteSession | 会话运行中 | { sessionId } | 0 | pi session 文件删除 + forge-store 删除 | 存储删除 + 先停止执行校验（mock stopAgent） |
| A-SM-004 | AC-SM-007 | session/updateSessionAlias | 会话存在 | { sessionId, alias } | 200 alias 更新 | 仅 forge-store alias | pi session 文件未变 |
| A-SM-005 | AC-SM-008 | session/queryActiveSessions | 多会话并行 | - | 200 列表 | - | 各会话 status 独立 |
| A-SM-006 | AC-SM-011/012/016 | session/attachWindow / releaseWindow | 会话存在 | { sessionId } | 0，同 id 重复拦截 | 窗口绑定表唯一约束 | 重复开窗拒绝/聚焦 |
| A-SM-007 | AC-SM-015 | session/queryAll | 多项目 | 无 | 返回跨项目全部会话 | 无写入 | 跨项目会话可见 |
| A-SM-009 | AC-SM-021 | session/markSessionRead | 会话存在 | { sessionId } | 0 + session（含 doneReadAt） | forge-store 写 doneReadAt | session.updated 发射；1001/1002 校验 |
| A-SM-010 | v0.3 自由对话 | session/createSession | projectPath 缺省/null/空白 | {} / null / { projectPath: null } / { projectPath: "  " } | 0 + session(projectPath=null) | forge-store 写入 projectPath=null | 数字类型 1001；adapter 收 null；服务层与 RPC 层空白语义一致 |
| A-SM-011 | v0.3 自由对话 | session/updateSessionProject | 会话存在 + 目标合法 | { sessionId, projectPath: key \| null } | 0 + session（归属已变） | forge-store 改 projectPath，转录文件不动 | session.updated 发射；目标未注册 1002；会话不存在 1002；归属未变幂等；desktop 侧 resolveSessionFile 多候选（当前归属→自由目录回落）保证移入项目后历史续接 |

### e2e

| 用例 ID | 关联 AC | 页面 | 前置条件 | 测试数据 | 自动化等级 | 操作 | 断言 |
|---|---|---|---|---|---|---|---|
| E-SM-001 | AC-SM-001 | 项目工作区 | 项目已打开 | 临时项目 | real-backend | 点新建会话→输入框聚焦 | 会话出现在主视图，聚焦输入框 |
| E-SM-002 | AC-SM-003/008/009/010 | 会话列表+主视图 | ≥2 会话 | 2 个并行会话（mock backend 流式） | mock-backend | 并行发消息→切换→观察 | A 继续 running；切换后 B 有流式输出；列表显示运行数 |
| E-SM-002b | AC-SM-010 | 会话列表 | ≥2 会话，含 streaming | 1 running + 1 idle（mock backend） | mock-backend | 选中 running→切走→回切 | running 会话选中/未选中状态点都可见（与列表高亮正交） | bugfix 回归：修复前选中态隐藏运行状态点 |
| E-SM-003 | AC-SM-005/006 | 会话列表 | 含 idle + running 会话 | 2 会话 | mock-backend | 右键删除 idle→取消→确认；右键删除 running→确认 | 确认弹窗出现；删除后不存在；running 先停止 |
| E-SM-004 | AC-SM-011/012/013/014/015/016 | 画布多窗口 | 跨项目会话存在 | 2 项目各会话 | mock-backend | 拖 A 会话开窗→拖到边缘→再拖 A→关闭 | 开窗+吸附+置顶；重复开窗拒绝；关闭后会话仍在池 |
| E-SM-005 | AC-SM-017/018/019/020 | 画布多窗口 | 多会话在画布 | 4 会话 | mock-backend | 依次拖到右/上/下/四角→点 4 窗格→拖右下角 resize→模拟窗口崩溃后重开 | 各吸附区预览+吸附；4 窗格 2×2；resize 最小尺寸限制；崩溃后重开恢复内容（无健康断言：无 console error） |
| E-SM-006 | AC-SM-022/023/024/025/026/027 | 侧栏会话列表 + 多窗口聚焦行 | 跨项目 ≥2 项目、含运行中/完成/出错/已开窗会话 | 2 项目各 2-3 会话（mock backend 置状态） | mock-backend | 切任务视角→断言平摊+tag→建运行会话断言置顶→点收起全部/展开全部→切回项目视角验证单项目折叠保留→任务视角行删除/拖拽开窗→窗口标题进聚焦层→刷新重进断言视角保持→hover 左上角按钮→点击折叠/展开 | 任务视角平摊+项目 tag；运行中置顶保留；收起全部/展开全部两态切换且单项目折叠不被覆盖；聚焦行显示项目 pill；视角记忆；LOGO 瓷片 hover 换图标、点击折叠行为不变（无健康断言：无 console error） |
| E-SM-007 | AC-SM-028/029/030 | 输入框项目选择器 | ≥2 项目;草稿态与会话中两场景 | 2-3 项目(别名混合) | mock-backend | 新建会话→点底行项目 pill→切归属→发送首条消息→断言 cwd/树归属;会话中点 pill→信息态断言归属+路径;任务视角直接新建(不先选项目,断言默认选中列表第一项);草稿下拉选 B→发送首条消息→断言 B 置顶且重启保持;新建项目→断言新项目置顶且自动选中为草稿归属（草稿文本保留，v3.48 回归）；悬停条目→移除×→首点变"确认"→再点→项目与名下会话从下拉与侧栏消失且源目录仍在;点"打开项目..."→mock 目录选择器返回路径→项目注册 | 草稿可选归属且发送后归属正确;会话中信息态显归属;新建默认选中列表第一项;创建会话后归属项目置顶且持久(纯选中不改序);移除级联删名下会话且当前项目移除后自动回落;下拉无运行中点/✓;打开项目直达系统选择器(无健康断言:无 console error) |
| E-SM-008 | —（性能回归锁，保障 SM-S05 会话列表可用） | 侧栏会话树（冷启动首屏） | ≥1 项目 + ≥1 会话；openProject 被人为拖慢 | mock 默认项目 D:/work/aiwork/forge + 会话种子 sess-startup | mock-backend | init script 抢在 mock 句柄赋值时注入 seed('project/openProject') 延迟 6s + setSessions → goto('/') → 等 .tree-panel | .tree-project 数 = 1（项目行先到）；.tree-session 数 = 1 且须在 2000ms 内命中 —— 修复前 loadSessions 串在 openProject 之后需等满 6s，本断言必失败（无健康断言：无 console error / pageerror） |
| E-SM-009 | AC-SM-022（胶囊几何是分段开关可用性的可观测面） | 侧栏顶部「项目/任务」分段开关 | 项目已打开（开关随 formalUiReady 挂载） | 默认 mock 项目 + 1 会话 | mock-backend | goto('/') 断言首贴贴合 → 切任务/切回项目各断言贴合 → 点 .shell-toggle 折叠（等侧栏宽度到 0）再展开（等开关回到原宽）→ 断言贴合 | 胶囊 ::before 的 left/width 与 active 按钮 offsetLeft/offsetWidth 误差 ≤1px —— 修复前展开瞬间开关被压到 min-content（94→70px、按钮 44→32px），测出的 --pill-r 永久偏小，过渡结束后胶囊被拉长成 56px（实测 Received: 12），必失败（无健康断言：无 console error） |
| E-SM-010 | AC-SM-022 | 侧栏顶部「Projects/Tasks」分段开关（英文界面） | 界面语言英文（navigator.language = en-US） | 默认 mock 项目 + 1 会话；两键不等宽（62/47px） | mock-backend | 英文冷启动 → 断言 Projects active 且胶囊贴合 → 切 Tasks → 断言贴合 | 首帧（未切过视角）胶囊即与 active 按钮贴合（≤1px）—— 修复前首贴静默落空，停在 CSS 50% 兜底几何上，胶囊比按钮窄 7.5px（实测 Received: 7.4844），必失败（无健康断言：无 console error） |
| E-SM-011 | v0.3 自由对话（无 PRD AC，需求来源：prototypes/no-project-session-demo.html 定稿 + 用户裁定） | 侧栏「自由对话」虚拟分组 + 落地 hero | 零项目（或含项目 + 自由会话） | projectPath=null 的会话种子 / 零项目种子 | mock-backend | FREE-01：零项目 hero 输入→Enter→断言自由会话落「自由对话」分组且 mock 侧 projectPath=null、无绑定入口；FREE-02：右键自由会话→移入项目→分组迁移+toast+mock 归属变更；FREE-03：任务视角自由会话带「自由」徽章、项目会话无；FREE-04：拖自由会话进多窗口画布→窗口标题「自由对话」tag、无分支徽标 | 发送即创建（不再弹目录选择器）；归属变更只走侧栏（无会话内绑定按钮）；自由会话 cwd 由 desktop 映射 free-workspace（unit 层 sessionService null 语义矩阵 + updateSessionProject 双向/幂等/1002 已覆盖，见 A-SM-010/011）（无健康断言：无 console error） |
