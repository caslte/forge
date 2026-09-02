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
| AC-SM-005 | SM-S03 删除 | 安全/一致性 | 不可逆操作：删除确认 | P0 | - | A-SM-003 | E-SM-003 | 二次确认；确认后 pi session 被永久删除 | 无需 cancel 按钮 |
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

---

## 用例设计说明

### unit

| 用例 ID | 关联 AC | 测试对象 | 风险维度 | 前置条件 | 输入 | 操作 | 预期结果 | 负向断言 |
|---|---|---|---|---|---|---|---|---|
| U-SM-001 | AC-SM-006 | sessionService 删除运行中会话 | 状态流转 | 会话 running | sessionId | deleteSession | 先 stop AgentSession 再删除 pi session；状态机合法 | 不经停止直接删除被拦截 |
| U-SM-002 | AC-SM-008 | sessionManager 并发实例 | 并发 | 10 个会话 | 10 会话并行发消息 | 同时发起 | 各输出流独立；无共享状态串扰 | 资源不足时提示但不强制停止 |
| U-SM-003 | AC-SM-007 | sessionService 重命名 | 状态 | 会话存在 | alias | updateSessionAlias | forge 侧 alias 更新；pi 消息文件不变 | alias 为空的拒绝 |
| U-SM-004 | AC-SM-021 | sessionService 已读落盘 | 状态流转 | 会话 done | sessionId | markSessionRead + setSessionStatus(done) | doneReadAt 落库；新一轮 done 转入清已读；done→done 重复写不清 | 空 ID 1001 / 会话不存在 1002 |

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

### e2e

| 用例 ID | 关联 AC | 页面 | 前置条件 | 测试数据 | 自动化等级 | 操作 | 断言 |
|---|---|---|---|---|---|---|---|
| E-SM-001 | AC-SM-001 | 项目工作区 | 项目已打开 | 临时项目 | real-backend | 点新建会话→输入框聚焦 | 会话出现在主视图，聚焦输入框 |
| E-SM-002 | AC-SM-003/008/009/010 | 会话列表+主视图 | ≥2 会话 | 2 个并行会话（mock backend 流式） | mock-backend | 并行发消息→切换→观察 | A 继续 running；切换后 B 有流式输出；列表显示运行数 |
| E-SM-002b | AC-SM-010 | 会话列表 | ≥2 会话，含 streaming | 1 running + 1 idle（mock backend） | mock-backend | 选中 running→切走→回切 | running 会话选中/未选中状态点都可见（与列表高亮正交） | bugfix 回归：修复前选中态隐藏运行状态点 |
| E-SM-003 | AC-SM-005/006 | 会话列表 | 含 idle + running 会话 | 2 会话 | mock-backend | 右键删除 idle→取消→确认；右键删除 running→确认 | 确认弹窗出现；删除后不存在；running 先停止 |
| E-SM-004 | AC-SM-011/012/013/014/015/016 | 画布多窗口 | 跨项目会话存在 | 2 项目各会话 | mock-backend | 拖 A 会话开窗→拖到边缘→再拖 A→关闭 | 开窗+吸附+置顶；重复开窗拒绝；关闭后会话仍在池 |
| E-SM-005 | AC-SM-017/018/019/020 | 画布多窗口 | 多会话在画布 | 4 会话 | mock-backend | 依次拖到右/上/下/四角→点 4 窗格→拖右下角 resize→模拟窗口崩溃后重开 | 各吸附区预览+吸附；4 窗格 2×2；resize 最小尺寸限制；崩溃后重开恢复内容（无健康断言：无 console error） |