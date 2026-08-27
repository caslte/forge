# 模型与 Provider 配置 覆盖矩阵

> 模块：05 模型与 Provider 配置
> 来源：PRD 05（docs/prd/05_model_provider.md）
> 状态：已确认（含扩展 MP-S05 思考级别 / MP-S06 上下文大小 / MP-S07 思考等级配置）
> 层级映射：unit=配置校验/密钥存储逻辑/思考级别 clamp 与回显/上下文字段写移除/思考等级白名单；API=IPC 方法 + models.json 对接 + 会话思考级别持久化；E2E=设置页表单 + 输入框切换器

---

## 风险维度适用性

| 风险维度 | 是否适用 | 原因 | 覆盖要求 |
|---|---|---|---|
| 正常流程 | 适用 | provider 配置、模型选择、持久化、生效、思考级别选择、上下文 1M、思考等级配置七场景 | P0 |
| 字段边界 | 适用 | baseUrl 格式、apiKey 非空、models 至少一项、思考级别合法性、contextWindow 等值回显 | P0 |
| 权限角色 | 适用 | 单用户；密钥安全（不明文写入） | P0 |
| 状态流转 | 适用 | 无provider→已配置；会话覆盖不影响全局；思考级别下一轮生效；clamp 收敛 | P1 |
| 异常失败 | 适用 | models.json 写失败、无 keychain、pi 重载失败、思考级别查询失败降级 | P1 |
| 数据一致性 | 适用 | 配置持久化；重启保留；会话覆盖/思考级别只影响该会话；全局默认同步 | P0 |
| 幂等重复 | 适用 | 重复保存覆盖更新幂等；contextWindow 勾选/取消各幂等 | P1 |
| 查询组合 | 适用 | provider 列表/模型列表/思考级别列表查询（从 pi 读取） | P2 |
| 前端反馈 | 适用 | 保存成功/校验失败标红；思考级别切换器渲染与隐藏；max 金色流光动画 | P1 |
| 跨模块影响 | 适用 | 会话使用模型与思考级别（模块 02）；输入框切换器（模块 03）；pi 上下文窗口 | P0 |
| 状态渲染（B1，前端） | 适用 | 输入框切换器：推理模型渲染、非推理隐藏、加载/错误降级态 | P0 |
| 内容正确性（B1，前端） | 适用 | max 金色流光动画触发与时长；切换无多余 toast | P0 |
| 页面健康（B3） | 适用 | 输入框视图加载冒烟：无 console error/pageerror/requestfailed | P0 |
| 契约完整性（B2，后端） | 适用 | getModelThinkingLevels/setSessionThinkingLevel/saveProvider(contextWindow) 响应结构与错误码 | P0 |
| 集成完整性（B2，后端） | 适用 | pi `getSupportedThinkingLevels`/`clampThinkingLevel`/会话级 `setThinkingLevel` 真实应用（不得全 mock） | P0 |
| 并发隔离（B2，后端） | 适用 | 多会话并行思考级别互不串扰；全局默认同步无竞态 | P0 |
| 持久化完整性（B2，后端） | 适用 | 思考级别/contextWindow 重启保留；写 models.json 原子性 | P0 |

---

## 覆盖基线

| AC ID | PRD 功能点 | 风险维度 | 场景 | 优先级 | 必测 | Unit ID | API ID | E2E ID | 核心断言 | 备注 |
|---|---|---|---|---|---|---|---|---|---|---|
| AC-MP-001 | MP-S01 Provider 配置 | 跨模块协作 | 正常流程：配置写入并加载 | P0 | 是 | - | A-MP-001 | E-MP-001 | 写 models.json，pi 加载该 provider | 依赖 pi 重载 mock |
| AC-MP-002 | MP-S01 Provider 配置 | 安全 | 安全：apiKey 明文（v1 临时） | P0 | 是 | U-MP-002 | A-MP-002 | - | models.json 中 apiKey 与 pi 原生明文一致 | 与 PRD v1 明文决策一致 |
| AC-MP-003 | MP-S01 Provider 配置 | 边界 | 异常：无效输入 | P1 | 否 | U-MP-001 | A-MP-003 | E-MP-002 | baseUrl 无效/apiKey 为空|校验拒绝，不保存 | |
| AC-MP-004 | MP-S01 Provider 配置 | 可用性 | 异常：OS 无 keychain | P1 | 否 | - | A-MP-004 | - | 降级提示使用环境变量 | 平台差异 |
| AC-MP-005 | MP-S02 模型选择 | 状态 | 正常流程：全局默认生效 | P0 | 是 | - | A-MP-005 | E-MP-003 | 新会话使用全局默认模型 | |
| AC-MP-006 | MP-S02 模型选择 | 状态/一致性 | 正常流程：会话覆盖隔离 | P0 | 是 | - | A-MP-006 | E-MP-003 | 会话 1 切模型，会话 2/全局不变 | |
| AC-MP-007 | MP-S03 持久化 | 一致性 | 正常流程：重启保留 | P0 | 是 | - | A-MP-007 | E-MP-004 | 重启后 provider 与全局默认仍在 | 只需持久化断言 |
| AC-MP-008 | MP-S04 配置生效 | 状态 | 正常：新会话立即可用 | P0 | 是 | - | A-MP-001 | E-MP-001 | 保存后新会话直接用新配置 | 无需重启 |
| AC-MP-009 | MP-S04 配置生效 | 状态 | 正常：运行中切模型 | P1 | 是 | - | A-MP-008 | - | 运行中会话切模型下一轮生效 | |
| AC-MP-010 | MP-S05 思考级别 | 跨模块协作 | 正常：按模型能力渲染/隐藏切换器 | P0 | 是 | U-MP-006 | A-MP-012 | E-MP-006 | 选项与 getSupportedThinkingLevels 一致；非推理隐藏 | 集成见 PIC-005 |
| AC-MP-011 | MP-S05 思考级别 | 状态 | 正常：切换后下一轮生效、不中断 | P0 | 是 | - | A-MP-014 | E-MP-007 | 下一轮按新级别发送；进行中回复不被中断 | |
| AC-MP-012 | MP-S05 思考级别 | 状态/一致性 | 正常：新会话继承全局；已存在会话互不影响 | P0 | 是 | U-MP-007 | A-MP-013/014 | E-MP-007 | 快照继承；多会话各自保持 | |
| AC-MP-013 | MP-S05 思考级别 | 状态 | 边界：越界级别 clamp 收敛 | P1 | 是 | U-MP-003 | - | - | max 请求在仅至 high 模型上收敛 high | 集成见 PIC-005 |
| AC-MP-014 | MP-S05 思考级别 | 交互 | 正常：max 金色流光动画 | P0 | 是 | U-MP-008 | - | E-MP-008 | 切 max 触发约 2-3s 金色流光；其他级别无动画无 toast | visual |
| AC-MP-015 | MP-S06 上下文 1M | 持久化 | 正常：勾选写 contextWindow | P0 | 是 | - | A-MP-009 | E-MP-005 | models.json 出现 contextWindow=1000000 | 需本地 pi 配置 |
| AC-MP-016 | MP-S06 上下文 1M | 持久化 | 正常：取消移除字段 | P0 | 是 | - | A-MP-010 | E-MP-005 | models.json 移除 contextWindow | 需本地 pi 配置 |
| AC-MP-017 | MP-S06 上下文 1M | 一致性 | 边界：存量非 1M 覆盖语义 | P1 | 是 | U-MP-004 | A-MP-010 | - | 非 1M(200000) 未勾选保存 → 移除字段 | 一律按勾选覆盖 |
| AC-MP-018 | MP-S06 上下文 1M | 状态 | 正常：编辑回显 | P1 | 是 | U-MP-005 | A-MP-011 | - | contextWindow===1000000 勾选，其余未勾选 | 等值回显 |
| AC-MP-019 | MP-S06 上下文 1M | 跨模块协作 | 正常：新会话上下文按 1M | P0 | 是 | - | A-MP-015 | E-MP-005 | 上下文窗口上限/压缩阈值按 1000000 | 真实 pi 集成 |
| AC-MP-020 | 多模态勾选 | 持久化 | 正常：勾选写 input | P0 | 是 | U-MP-006 | A-MP-016 | E-MP-006 | models.json 首模型出现 input:["text","image"]；readProviders 回显 vision=true | 首模型作用域 |
| AC-MP-021 | 多模态勾选 | 持久化 | 正常：取消移除字段 | P0 | 是 | U-MP-007 | A-MP-017 | E-MP-006 | models.json 移除 input（回退纯文本）；回显 vision=false | 一律按勾选覆盖 |
| AC-MP-022 | 多模态勾选 | 一致性 | 边界：存量手工 input 保留 | P1 | 是 | U-MP-008 | - | - | 未传 vision 时手工 input（含 video 等）不被覆盖 | undefined 不触碰 |
| AC-MP-023 | MP-S07 思考等级配置 | 持久化 | 正常：勾选思考强度+部分等级写 reasoning/map | P0 | 是 | U-MP-009 | A-MP-018 | E-MP-009 | models.json 出现 reasoning:true 与 thinkingLevelMap（选中=级别名，未选=null） | 全量 7 项显式 |
| AC-MP-024 | MP-S07 思考等级配置 | 持久化 | 正常：取消思考强度移除 map | P0 | 是 | - | A-MP-019 | E-MP-009 | models.json 写 reasoning:false 且移除 thinkingLevelMap | 一律按勾选覆盖 |
| AC-MP-025 | MP-S07 思考等级配置 | 状态 | 正常：编辑回显 | P1 | 是 | U-MP-010 | - | E-MP-009 | 回显 reasoning 勾选态与白名单挡位（pi 语义推导） | pi 语义：null 隐藏/xhigh·max 缺省不可用 |
| AC-MP-026 | MP-S07 思考等级配置 | 边界 | 异常：非法输入拒绝 | P1 | 是 | U-MP-011 | A-MP-018 | - | reasoning 非布尔/白名单非法/重复 → 1001，不写文件 | 去重后写入 |
| AC-MP-027 | MP-S07 思考等级配置 | 跨模块协作 | 正常：对话框可选挡位与白名单一致 | P0 | 是 | - | - | E-MP-009 | 保存后切换器可选级与白名单一致，未选挡位不再出现 | 真实 pi 集成 |

---

## 用例设计说明

### unit

| 用例 ID | 关联 AC | 测试对象 | 风险维度 | 前置条件 | 输入 | 操作 | 预期结果 | 负向断言 |
|---|---|---|---|---|---|---|---|---|
| U-MP-001 | AC-MP-003 | provider 校验 | 字段边界 | - | 非法 baseUrl、空 apiKey、空 models | 保存 | 字段校验失败，不写文件 | 无 models.json 变更 |
| U-MP-002 | AC-MP-002/003 | modelService.saveProvider 密钥处理 | 安全 | - | apiKey 明文 | 保存 | apiKey 明文写入 models.json（与 pi 原生一致，v1 临时）；其他字段保留 | 不丢 reasoning/compat 等附加字段 |
| U-MP-003 | AC-MP-013 | 思考级别 clamp 收敛 | 状态 | 模型 reasoning=true 但 thinkingLevelMap 仅至 high | 请求 max | resolvePiModel → clampThinkingLevel | 就近收敛为 high 并生效 | 不向上游发送不支持级别的请求字段 |
| U-MP-004 | AC-MP-017 | contextWindow 覆盖语义 | 一致性 | models.json 已有 contextWindow=200000 | saveProvider contextWindow=null | 保存 | 该模型 contextWindow 字段被移除 | 其余模型字段/其他模型不受影响 |
| U-MP-005 | AC-MP-018 | contextWindow 等值回显 | 状态 | 模型 contextWindow 分别为 1000000/200000/缺失 | queryProviderList | 读取 | 仅 1000000 呈现勾选态；其他为未勾选 | 非等值不误判为勾选 |
| U-MP-006 | AC-MP-010 | 非推理模型判定 | 字段边界 | getSupportedThinkingLevels 返回仅 ["off"] | 查询级别 | 判定 | 判定为非推理 → 切换器隐藏 | reasoning=false 时不返回非 off 级别 |
| U-MP-007 | AC-MP-012 | setSessionThinkingLevel 校验与一致性 | 数据一致性 | 会话 1/2 已存在 | 非法/合法 level | 写入 | 非法级别 1001；合法写会话 1 + 同步全局默认；会话 2 不变 | 其他会话与全局无串扰 |
| U-MP-008 | AC-MP-014 | max 动画触发判定 | 交互 | 切换器选中 max | 选中 | 状态切换 | 触发 max 金色流光动画状态（约 2-3s） | 非 max 级别不触发、不发 toast |
| U-MP-006v | AC-MP-020 | saveProvider vision 透传与校验 | 字段边界 | - | vision=true/false/非法值/缺省 | 保存 | true/false 透传记录；非法值 1001 不写；缺省不携带字段 | 非法值不写文件；缺省不覆盖原值 |
| U-MP-007v | AC-MP-021 | input 字段落盘与回显 | 持久化 | models.json 已有/无 input | writeProviders vision=true/false | 读写 | true 写 input:["text","image"] 且保留其他字段；false 移除 input；回显 vision 与 input 含 image 一致 | 仅含 video 不判为支持图片 |
| U-MP-009 | AC-MP-023/026 | saveProvider reasoning/thinkingLevels 透传与校验 | 字段边界 | - | reasoning=true/false/非法、thinkingLevels=合法/非法/重复/null/缺省 | 保存 | 合法透传记录；非法 1001 不写；null 透传移除；缺省不携带字段 | 非法值不写文件；缺省不覆盖原值 |
| U-MP-010 | AC-MP-025 | 白名单推导（pi 语义回显） | 状态 | 存量 thinkingLevelMap 全量/缺省/部分 null | readProviders | 读取 | reasoning=true 时按 pi 语义推导白名单（null 隐藏、xhigh/max 缺省不可用）；reasoning=false 不返回 | 顺序固定 |
| U-MP-011 | AC-MP-026 | buildThinkingLevelMap 纯函数 | 字段边界 | - | 全选/部分选/空选 | 构建 | 全量 7 项：选中=级别名，未选=null | 确定性一致 |

### api（IPC+models.json 对接）

| 用例 | 关联 AC | 接口 | 前置 | 断言 |
|---|---|---|---|---|
| A-MP-001 | AC-MP-001/008 | model/saveProvider | 无 provider | 返回 200；models.json 写库；pi 加载 |
| A-MP-002 | AC-MP-002 | model/saveProvider（含 key） | - | models.json 中 apiKey 为明文且与填值一致（v1 决策） |
| A-MP-003 | AC-MP-003 | model/saveProvider（非法） | - | 1001 校验错误，无写库 |
| A-MP-004 | AC-MP-004 | model/saveProvider（无 keychain） | 模拟无 keychain | 降级提示环境变量，仍可保存（v1 明文直写不依赖 keychain） |
| A-MP-005 | AC-MP-005 | model/setDefault | 已配 provider | 200；新会话默认用该模型；持久化 |
| A-MP-006 | AC-MP-006 | model/setSessionModel | 会话已存在 | 仅该会话覆盖；全局与其他会话不受影响 |
| A-MP-007 | AC-MP-007 | model/queryModels | 已保存配置 | 重启后 provider 与全局默认仍在 |
| A-MP-008 | AC-MP-009 | model/setSessionModel + conversation | 配置后新会话 | 运行中会话切模型下一轮生效 |
| A-MP-009 | AC-MP-015 | model/saveProvider | 已配单模型 | contextWindow=1000000 → models.json 首模型出现该字段 |
| A-MP-010 | AC-MP-016/017 | model/saveProvider | 存量 contextWindow=200000 | contextWindow=null → 字段移除，其余字段保留 |
| A-MP-011 | AC-MP-018 | model/queryProviderList | 已配 1000000/缺失各一 | providers[].contextWindow 回显 1000000，缺失为 null |
| A-MP-012 | AC-MP-010 | model/getModelThinkingLevels | 推理/非推理模型各一 | 推理返回可用级别列表且不含 off（MP-S07 过滤，含存量缺省 off 配置）、顺序固定；非推理仅 ["off"]；未知模型 1004 |
| A-MP-013 | AC-MP-012 | model/getSessionThinkingLevel | 会话已设/未设 | 已设 effective=session；未设继承全局快照 effective=global |
| A-MP-014 | AC-MP-011/012 | model/setSessionThinkingLevel | 多会话 | 写当前会话+同步全局默认；其他会话不变；下一轮生效 |
| A-MP-015 | AC-MP-019 | model/saveProvider + 会话创建 | 已配 1M 模型 | 新会话上下文窗口/压缩阈值按 1000000（真实 pi 集成见 PIC-005） |
| A-MP-016 | AC-MP-020 | model/saveProvider（vision=true） | 单模型 | models.json 首模型出现 input:["text","image"]；queryProviderList 回显 vision=true |
| A-MP-017 | AC-MP-021 | model/saveProvider（vision=false） | 存量含 input | input 字段被移除；回显 vision=false |
| A-MP-018 | AC-MP-023/026 | model/saveProvider（reasoning/thinkingLevels） | 单模型 | reasoning=true + thinkingLevels=[off,high,max] → 写库记录含 reasoning=true 与 thinkingLevels；解析层去重；非法值 1001 无写库 |
| A-MP-019 | AC-MP-024 | model/saveProvider（reasoning=false + thinkingLevels=null） | 存量含 reasoning/map | 写 reasoning:false 并移除 thinkingLevelMap；queryProviderList 回显 reasoning=false、无 thinkingLevels |

### e2e

| 用例 | 关联 AC | 页面 | 前置 | 测试数据 | 自动化等级 | 操作 | 断言 |
|---|---|---|---|---|---|---|---|
| E-MP-001 | AC-MP-001/008 | 设置页 | 无 provider | 合法配置 | mock（写 models.json） | 填表→保存→新会话 | 保存成功提示；写了 models.json；新会话可用 |
| E-MP-002 | AC-MP-003 | 设置页 | - | 非法 baseUrl、空 key | mock | 填非法→保存 | 字段标红提示，不保存 |
| E-MP-003 | AC-MP-005/006 | 会话+设置页 | 多会话+全局默认 | 2 会话 | mock | 设全局默认；会话1切模型 | 全局默认生效；会话1覆盖仅自身生效 |
| E-MP-004 | AC-MP-007 | 设置页 | 已保存配置 | - | real | 重启应用 | 配置与全局默认仍显示 |
| E-MP-005 | AC-MP-015/016/019 | 设置页 | 已配模型 | 勾选/取消 1M | mock（写真实 models.json 文件） | 勾选→保存；取消→保存；新建会话 | contextWindow=1000000 写入；取消后字段移除；编辑回显一致；新会话上下文按 1M 显示 |
| E-MP-006 | AC-MP-010 | 对话输入框 | 推理/非推理模型各一 | - | mock | 打开会话查看切换器 | 推理模型显示切换器且选项与接口返回一致；非推理不显示；页面无 console error/pageerror/requestfailed（B3 冒烟） |
| E-MP-007 | AC-MP-011/012 | 对话输入框 | 多会话 | 会话1切 high + 新建会话 | mock | 会话1切级别→下一轮对话；新建会话 | 会话1下一轮按 high 发送且进行中回复不被中断；新会话继承全局默认；会话2 不受影响；无多余 toast |
| E-MP-008 | AC-MP-014 | 对话输入框 | 模型支持 max | 切 max / 切 high | visual | 切 max → 观察输入框；切回 high | 金色流光动画约 2-3s 出现并消失；其他级别无动画、无 toast；关键元素可见（B1 内容正确性） |
| E-MP-006v | AC-MP-020/021/022 | 设置页 | 已配模型 | 勾选/取消「支持图片输入」 | mock（写真实 models.json 文件） | 勾选→保存；取消→保存；编辑回显；列表标签 | 保存后 models.json 首模型 input:["text","image"]；取消后字段移除；回显勾选一致；列表显示「多模态」；页面无 console error（B3 冒烟） |
| E-MP-009 | AC-MP-023/024/025/027 | 设置页+对话输入框 | 已配推理模型 | 勾选/取消思考强度；勾选 off/high/max | mock（写真实 models.json 文件） | 勾选→保存；取消→保存；编辑回显；打开对话框切换器 | 保存后 models.json 首模型 reasoning:true + thinkingLevelMap（选中=级别名，未选=null）；取消后 reasoning:false 且 map 移除；回显一致；对话框切换器可选挡位与白名单一致（未选挡位不出现）；页面无 console error（B3 冒烟） |