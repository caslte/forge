# 项目管理 覆盖矩阵

> 模块：01 项目管理
> 来源：PRD 01（docs/prd/01_project_management.md）
> 状态：已确认
> 层级映射：unit=forge-core 纯逻辑；API=IPC 方法契约 + forge-store 持久化；E2E=Electron 桌面 UI

---

## 风险维度适用性

| 风险维度 | 是否适用 | 原因 | 覆盖要求 |
|---|---|---|---|
| 正常流程 | 适用 | 添加/打开/移除/信任四场景主流程 | P0 |
| 字段边界 | 适用 | 路径规范化唯一键、别名非空校验 | P1 |
| 权限角色 | 适用 | 单用户；项目信任（安全硬约束） | P0 |
| 状态流转 | 适用 | 信任状态：未信任→询问中→已信任/已拒绝 | P0 |
| 异常失败 | 适用 | 目录失效/无权限、注册失败、信任事件拦截不可用降级 | P1 |
| 数据一致性 | 适用 | 源文件不被删除；pi 会话不被删除；元数据只归 forge | P0 |
| 幂等重复 | 适用 | 重复注册拒绝、重复打开无副作用、重复移除无副作用、信任决策幂等 | P1 |
| 查询组合 | 不适用 | 项目列表无分页/多条件查询，仅按最近打开排序 | - |
| 前端反馈 | 适用 | 移除确认弹窗文案、信任弹窗、列表高亮、失效提示 | P1 |
| 跨模块影响 | 适用 | 打开→加载会话列表（模块 02）；信任→扩展加载 | P0 |

---

## 覆盖基线

| AC ID | PRD 功能点 | 风险维度 | 场景 | 优先级 | Unit ID | API ID | E2E ID | 核心断言 | 备注 |
|---|---|---|---|---|---|---|---|---|---|
| AC-PM-001 | PM-S01 添加项目 | 数据一致性 | 正常流程：有效目录注册 | P0 | - | U-PM-001 | E-PM-001 | 注册后列表新增；源目录文件哈希不变；forge-store 出现 project 记录 | E2E 用真实临时目录 |
| AC-PM-002 | PM-S01 添加项目 | 幂等 | 异常：重复注册 | P1 | U-PM-001 | A-PM-001 | - | addProject 返回 1001；store 仅一条记录 | 路径含符号链接时先规范化再比较 |
| AC-PM-003 | PM-S01 添加项目 | 字段边界 | 异常：失效/无权限路径 | P1 | U-PM-002 | A-PM-002 | E-PM-002 | 不注册；返回"路径无效或不可访问"；store 无新增 | 目录选择器本身选不到无权限目录，需 API 级测 |
| AC-PM-004 | PM-S02 打开项目 | 跨模块协作 | 正常流程：打开含会话项目 | P0 | - | A-PM-003 | E-PM-001 | openProject 返回成功；会话列表加载（模块 02 联动） | 需与模块 02 联测 |
| AC-PM-005 | PM-S02 打开项目 | 可用性 | 异常：目录被删除 | P1 | - | A-PM-004 | E-PM-002 | 打开不崩溃；提示路径失效；提供"重新定位/移除"出口 | |
| AC-PM-006 | PM-S03 移除项目 | 数据一致性/不可逆 | 正常流程：移除含会话项目 | P0 | - | A-PM-005 | E-PM-003 | 列表移除；源文件存在；pi 会话 JSONL 删除；store 中 project 与该项目 session 记录删除 | 不可逆操作核心断言（v3.32 改级联删） |
| AC-PM-007 | PM-S03 移除项目 | 前端反馈 | 正常流程：确认弹窗文案 | P2 | - | - | E-PM-003 | 弹窗文本含"仅移除注册，不删除源文件与会话"；确认后移除、取消不操作 | 原 PRD 标 manual，本设计提升为 E2E 文案断言；环境受限可降级 manual |
| AC-PM-008 | PM-S04 项目信任 | 安全/权限 | 正常流程：含 .pi 资源首次打开 | P0 | - | A-PM-006 | E-PM-004 | 触发 trustRequested 事件；UI 出现信任弹窗 | |
| AC-PM-009 | PM-S04 项目信任 | 安全 | 正常流程：选择信任 | P0 | U-PM-003 | A-PM-006 | E-PM-004 | setTrust(trust) 回传 pi；项目级资源加载 | 依赖 pi 信任机制 mock |
| AC-PM-010 | PM-S04 项目信任 | 安全/可用性 | 异常：拒绝信任 | P0 | U-PM-003 | A-PM-007 | E-PM-004 | 资源不加载；基础会话仍可用；trustState=rejected | |
| AC-PM-011 | PM-S04 项目信任 | 幂等 | 正常流程：已信任再次打开 | P1 | U-PM-003 | - | E-PM-004 | 不重复弹窗；trustState 已确定 | 幂等断言 |
| AC-PM-012 | PM-S01 项目拖拽排序 | 数据一致性 | 正常流程：拖拽排优先级 | P0 | U-PM-004/005 | A-PM-008 | - | 新顺序写 priority=0..n-1 持久化；未钉扎按最近打开倒序 | 全量重排一次落盘 |

---

## 用例设计说明

### unit

| 用例 ID | 关联 AC | 测试对象 | 风险维度 | 前置条件 | 输入 | 操作 | 预期结果 | 负向断言 |
|---|---|---|---|---|---|---|---|---|
| U-PM-001 | AC-PM-002 | projectService 路径规范化/唯一键 | 幂等 | forge-store 无该项目 | 同路径两次 addProject（第 2 次含符号链接变体） | 规范化后比较 | 第 2 次返回 1001；store 仅 1 条 | store 不出现重复 path |
| U-PM-002 | AC-PM-003 | projectService 路径校验 | 字段边界 | - | 不存在路径 / 无权限路径 | addProject | 返回校验错误，不写 store | store 无新增 |
| U-PM-003 | AC-PM-009/010/011 | trustService 状态机 | 权限/状态流转/幂等 | 项目含 .pi 资源 | decision=trust/reject/trustOnce；重复 openProject | setTrust 后校验状态 | trust→trusted 资源加载；reject→rejected 不加载；已确定状态不再询问 | 状态不跳转（untrusted 不可直接 trusted） |
| U-PM-004 | AC-PM-012 | store.reorderProjects 排序/持久化 | 数据一致性 | 3 个项目 | 全量重排 paths | 重排 + 重载 | 新顺序写 priority=0..n-1，listProjects 按钉扎升序，重载保持 | 含未注册路径 → 1003 不写盘 |
| U-PM-005 | AC-PM-012 | projectService.reorderProjects 校验/透传 | 字段边界 | - | 非数组/空/含非字符串；含未注册路径 | 重排 | 非法 1001；未注册 1002；合法 0 且持久化 | 不写盘 |

### api（IPC 契约 + 持久化）

| 用例 ID | 关联 AC | 接口 | 前置条件 | 请求数据 | 预期响应/错误码 | 数据落地 | 断言点 |
|---|---|---|---|---|---|---|---|
| A-PM-001 | AC-PM-002 | project/addProject | store 无项目 | { path: 同路径 } | 1001 | 无写入 | 响应码 + store 记录数不变 |
| A-PM-002 | AC-PM-003 | project/addProject | - | { path: 无效路径 } | 1001 + 提示 | 无写入 | 错误提示文案 |
| A-PM-003 | AC-PM-004 | project/openProject | 项目已注册含会话 | { path } | 0 + project | lastOpenedAt 更新 | 响应 + 时间戳更新 + 会话列表联动 |
| A-PM-004 | AC-PM-005 | project/openProject | 项目已注册，目录被删 | { path } | 0（或特定码）+ 失效提示 | 无破坏性写入 | 不崩溃、提示失效 |
| A-PM-005 | AC-PM-006 | project/removeProject | 项目含会话 | { path } | 0 | store project 删除；名下会话级联删除（session.removed 逐个发射） | 源文件存在 + pi JSONL 删除 + store project/session 记录删除 + data.removedSessions 计数正确 |
| A-PM-006 | AC-PM-008/009 | project/openProject + setTrust | 项目含 .pi 资源 | { path } → { decision: trust } | 0；1005 先触发询问 | trustState 更新 | trustRequested 事件 → setTrust 回传 |
| A-PM-007 | AC-PM-010 | project/setTrust | 询问中 | { decision: reject } | 0 | trustState=rejected | 资源不加载；会话基础能力可用 |
| A-PM-008 | AC-PM-012 | project/reorderProjects | 3 个项目已注册 | { paths: 重排后的全量顺序 } | 0 | 列表顺序变更且持久化 | paths 非法（非数组/空/含非字符串）→ 1001；含未注册路径 → 1002 不写盘 |

### e2e

| 用例 ID | 关联 AC | 页面 | 前置条件 | 测试数据 | 自动化等级 | 操作 | 断言 |
|---|---|---|---|---|---|---|---|
| E-PM-001 | AC-PM-001/004 | 项目列表页→工作区 | 应用启动 | 临时目录 + 预建会话 | real-backend | 添加→列表新增→打开→进入工作区 | 列表出现；源文件哈希不变；会话列表出现 |
| E-PM-002 | AC-PM-003/005 | 项目列表页 | 应用启动 | 失效目录 | real-backend | 添加失效路径→打开失效项目 | 添加失败提示；打开不崩溃并提示修复出口 |
| E-PM-003 | AC-PM-006/007 | 项目列表页 | 项目含会话 | 临时目录 + 会话 | real-backend | 右键移除→确认弹窗→确认 | 弹窗文案；列表移除；源文件与 pi 会话仍存在 |
| E-PM-004 | AC-PM-008/009/010/011 | 项目工作区 | 项目含 .pi 资源 | 临时目录 + .pi 扩展 | mock-backend（pi 信任 mock） | 首次打开→弹窗→信任/拒绝→再次打开 | 弹窗出现；信任后资源加载；拒绝后不加载；再次打开不弹 |