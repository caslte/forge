# forge 自有存储设计（forge-store）

> 模块编号：forge-store
> 状态：已确认（PRD 01/02/05 已确认，本设计已确认）
> 存储介质：本地 JSON 文件（路径由 forge-desktop 传入，落在本机 userData 目录下；forge-core 纯 Node 不调 Electron API，单文件 `forge-store.json`）

---

## 0. 设计前提与边界

forge 是 Electron 桌面应用，**不引入传统关系数据库**。本 schema 只覆盖 forge 自有存储：

- **存（forge 自有）**：项目元数据、会话元数据缓存、全局默认模型、会话模型偏好。
- **不存（归 pi，只读/只写对接）**：
  - pi session JSONL（会话消息与原始数据）——见 `~/.pi/agent/sessions`，forge 不复制。
  - models.json（provider 配置）——forge 作为可视化编辑器读写该文件，密钥借 `!command`/`$ENV_VAR`，不明文。
  - OS keychain（API key 实际存放）——forge 经 `!forge-secret` 读写。
- **存储演进**：单 JSON 文件 `forge-store.json`，含 `schemaVersion` 字段支持后续迁移拆分（PRD 01 §3.5 兼容性要求）。

---

## 表：project（项目元数据）

forge 管理的项目注册信息。用户源码目录不在本项目内复制或修改。

| 字段名 | 类型 | 可空 | 默认值 | 用途 |
|--------|------|------|--------|------|
| path | string | 否 | - | 项目目录规范化绝对路径，主键 |
| alias | string | 否 | 目录名 | 项目别名（默认取目录名，可编辑） |
| createdAt | string(ISO8601) | 否 | - | 创建时间 |
| lastOpenedAt | string(ISO8601) | 是 | null | 最近打开时间（排序用） |
| trustState | enum | 否 | 'untrusted' | 信任状态缓存（untrusted/asking/trusted/rejected） |
| priority | number \| null | 是 | null | 手动排序优先级（拖拽钉扎）：数字越小越靠前；null=未钉扎 |

- 主键：`path`
- 索引：`priority`（项目列表排序主键：钉扎升序优先）；`lastOpenedAt`（未钉扎项目按最近打开倒序排其后）
- 关联：该项目的会话元数据在 `session` 表按 `projectPath` 关联
- seed 数据：无
- 状态：已确认

### 设计说明

- 同一路径不可重复注册；路径经 `fs.realpath` 规范化后作为唯一键（PRD01 §3.3 PM-S01）。
- `trustState` 仅为**展示缓存**，权威值在 pi（PRD01 §3.2）；项目移除时删除本记录，不影响 pi 会话与源文件。
- `priority` 为拖拽钉扎的手动排序优先级：列表排序 `priority` 升序优先，未钉扎（null）项目按 `lastOpenedAt` 倒序排其后；首次拖拽排序时为全量项目写 0..n-1（全部钉扎，此后打开项目不再重排），之后新增项目保持未钉扎。
- 刻意不存文件树、不存 pi 会话内容、不存密钥。

---

## 表：session（会话元数据）

forge 侧会话视图层元数据，**只存元信息，不存消息内容**（消息内容归 pi）。别名、归属、最近活动均由 forge 维护。

| 字段名 | 类型 | 可空 | 默认值 | 用途 |
|--------|------|------|--------|------|
| sessionId | string | 否 | - | pi session ID（对应 pi session 目录名，主键） |
| projectPath | string | 否 | - | 所属项目绝对路径 |
| alias | string | 是 | null | 会话别名（默认取首条用户消息摘要，可编辑） |
| lastActiveAt | string(ISO8601) | 否 | 创建时 | 最近活动时间（会话列表排序） |
| createdAt | string(ISO8601) | 否 | - | 创建时间 |
| modelOverride | string | 是 | null | 会话级模型覆盖（模块 05；空则用全局默认） |
| thinkingLevel | string | 是 | null | 会话级思考级别覆盖（模块 05 MP-S05；枚举同 pi：off/minimal/low/medium/high/xhigh/max；空则用全局默认） |

- 主键：`sessionId`
- 索引：`projectPath`、`lastActiveAt`
- 关联：`projectPath` 指向 `project.path`；pi session 由其自身存储承载
- seed 数据：无
- 状态：已确认

### 设计说明

- 会话信任继承所属项目信任状态（模块 02），不加独立信任字段。
- 删除会话 = 删 pi session（不可逆）+ 删本元数据（PRD02 TD-SM-05）。
- 消息、工具事件全部由 pi 存储，本表不承载。
- 窗口为展示层（会话输出与窗口解耦），不按窗口持久化；窗口崩溃后从会话与 forge-core 输出流重建（PRD02 §3.5）。
- `thinkingLevel` 语义（PRD05 MP-S05）：会话有已存值则用已存值（运行时按模型能力 clamp），无已存值则继承 `settings.thinkingLevel` 全局默认；切换思考级别时**同时写本字段并同步全局默认**，已存在会话各自保持本字段，互不影响。

---

## 表：settings（全局偏好）

单例 key-value 集合，存全局默认与桌面级偏好。

| 字段名 | 类型 | 可空 | 默认值 | 用途 |
|--------|------|------|--------|------|
| key | string | 否 | - | 设置键（主键） |
| value | any | 是 | null | 设置值 |

- 主键：`key`
- seed 数据（首次创建时写入）：
  - `key='defaultModel'`，`value=null`（全局默认模型，未配置为 null）
  - `key='thinkingLevel'`，`value='off'`（全局默认思考级别，新会话继承；**默认关闭**——thinking 内容默认不产生/不展示，用户可显式调高）
  - `key='schemaVersion'`，`value=1`
- 状态：已确认

### 设计说明

- 当前键集合：`defaultModel`（全局默认模型）、`thinkingLevel`（全局默认思考级别，PRD05 MP-S05）；后续可扩展 `windowLayout`（多窗口布局持久化，如需重启恢复布局）、`theme` 等。
- 全局默认模型语义：会话无 `modelOverride` 时才用全局默认，不影响已配置覆盖的会话。
- 全局默认思考级别语义：会话无 `thinkingLevel` 覆盖时继承；输入框切换思考级别时同步更新本键，已存在会话各自保持 `session.thinkingLevel` 不受影响。**默认值为 `off`**（forge 启动即默认关闭思考内容产生/展示），旧数据缺失该键时按 `'off'` 兜底处理。

---

## 存储级约束（跨表）

- forge 不得将 pi 拥有的数据（session 消息、models.json、密钥明文）写入本文件。
- `session.projectPath` 指向的项目被移除时，会话元数据**保留**（用户重新添加同路径项目可恢复会话可见性，PRD01 §3.3 PM-S03）。
- 写入策略：单文件原子写（临时文件 + rename），避免崩溃损坏；`schemaVersion` 用于向后迁移。
- **并发选型**：forge-core 是唯一写入者（所有 IPC 经 forge-core 串行化写入，无并发写者），故单文件 JSON + 原子写足够安全；若将来引入多写者或高频写，再升级 SQLite（better-sqlite3）。会议室评审曾建议 SQLite 防多窗口并发腐烂，但决策 4（传输无关接口 + forge-core 单一写入中心）已从架构上消除并发写者。

---

## 与其他模块的边界

| 数据 | 归属 | 介质 | forge 行为 |
|---|---|---|---|
| 项目列表/元数据 | forge | forge-store.json | 读写 |
| 会话元数据（别名/项目归属） | forge | forge-store.json | 读写 |
| 全局默认模型 | forge | forge-store.json | 读写 |
| 会话模型覆盖 | forge | forge-store.json | 读写 |
| 全局默认思考级别 | forge | forge-store.json | 读写（PRD05 MP-S05） |
| 会话思考级别覆盖 | forge | forge-store.json | 读写（PRD05 MP-S05） |
| pi 会话消息 | pi | JSONL（`~/.pi/agent/sessions`） | 只读/委托创建 |
| provider 配置 | pi | models.json | 写入（可视化编辑器），含模型 contextWindow |
| API key | pi | OS keychain | 经 `!forge-secret` 读写，不明文入库 |
| 项目信任状态 | pi | pi 内部 | 只读缓存（trustState 仅展示） |