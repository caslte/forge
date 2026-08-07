# forge v1 项目计划

> 状态：**确认点 1 待确认**（用户要继续讨论其他事项，暂不进入 gen-doc-init / gen-doc-prd）
> 来源：think 流程 run_id `1786004271124`（见 `think-1786004271124-plan.md`）
> 日期：基于 2025 年对 pi(0.83.0) 与 ai-coding 的调研

---

## 1. 背景与动机

- **pi**（`D:\work\aiwork\pi`）：开源 TypeScript/Node coding agent harness。有成熟的扩展系统（TS 扩展 + `ExtensionAPI`）、skills、多嵌入方式（进程内 SDK `AgentSession` / RPC / JSON / print / protocol）、自研 TUI（`pi-tui`）。作为 npm 包可作依赖。**无内置权限系统、无沙箱**（设计如此）。
- **ai-coding**（`D:\work\aiwork\ai-coding`，品牌 FORGE）：Wails(Go) + Vue3 桌面应用，原思路是 spawn claude/codex/opencode 三种子进程可切换。**Vue 前端在 API 边界后端无关**（依赖一组 REST 端点 + SSE `canonicalEvent` 流）。
- **forge**（本仓库）：全新项目。**抛弃** ai-coding 的"多引擎子进程可切换"思路，改为**以 pi 为固定基座**，深度扩展；pi 可独立升级，业务能力以 pi 扩展承载，不 fork pi 核心。

## 2. 目标

做一个以 pi 为固定引擎的桌面 coding agent 应用（forge）：
- pi 作 npm 依赖，可独立升级；
- 业务能力以 **pi 扩展**承载，不 fork pi 核心；
- 桌面 UI 复用 ai-coding 的 Vue 前端；
- 架构为将来"嵌入式 agent"（代码调用 agent 能力）留好出口。

## 3. 关键决策（已锁定）

| # | 决策 | 理由 |
|---|---|---|
| 1 | **pi 集成 = 进程内 SDK**（Node 内嵌 `AgentSession`，非子进程 RPC） | 扩展 in-process 拿完整 `ExtensionAPI`；抛弃 ai-coding 子进程思路；pi 作 npm 库升级最简 |
| 2 | **UI 形态 = web GUI**（复用 ai-coding Vue；TUI 留作以后可选） | 好看/富交互；ai-coding 前端现成可复用 |
| 3 | **桌面壳 = Electron**（壳+大脑同进程） | 一体性优先于体积；自动更新生态成熟（electron-updater） |
| 4 | **forge-core 为纯 Node 模块**（v1 架构纪律） | Electron 专有逻辑（托盘/原生对话框/自动更新/安装器）放 `forge-desktop`，绝不进 `forge-core`。REST/SSE 服务层是干净接缝，为 v2+ 可选复用为无头"forge 即服务"铺路。业务系统 raw 嵌入用 pi 直接，不经 forge（详见 `embedded-agent-discussion.md`） |
| 5 | **业务能力 = pi 扩展**（非 fork） | pi 可独立 `npm update`；不侵入 pi 源码 |
| 6 | **权限跟 pi 一致** | 继承 pi 项目信任（白捡）；不做自定义 per-tool 审批层；需要时用 opt-in pi 扩展（`permission-gate` 模式） |
| 7 | **存储复用 pi** | session 用 pi JSONL（`~/.pi/agent/sessions`）；forge 只加项目/会话树组织层；不重造消息存储 |
| 8 | **v1 聚焦 MVP** | 核心先行，复杂功能后续迭代 |

## 4. 架构

```
┌──────────────────────────────────────────────────┐
│  Electron App（一个 Node 进程）                    │
│                                                  │
│  ┌────────────┐    ┌──────────────────────────┐  │
│  │ Electron 壳 │    │  forge-core（Node 模块）  │  │
│  │ 窗口/托盘/  │    │ ┌──────────────────────┐ │  │
│  │ 单例/对话框/│    │ │ pi SDK (AgentSession)│ │  │
│  │ 通知/自动更新│   │ │ + forge 扩展(业务)   │ │  │
│  │ /安装器     │    │ │ + REST/SSE 服务      │ │  │
│  └─────┬──────┘    │ └──────────────────────┘ │  │
│        │           └────────────┬─────────────┘  │
│   ┌────┴─────┐         HTTP+SSE │                │
│   │ Vue 前端  │◄────────────────┘                │
│   │(ai-coding)│                                  │
│   └──────────┘                                   │
└──────────────────────────────────────────────────┘
   （v2+）同一 forge-core -> 无头二进制（SDK/服务/CLI）= 嵌入式 agent
```

## 5. 一级模块

| 模块 | 技术 | 职责 |
|---|---|---|
| **forge-core** | Node/TS | 引擎层：pi SDK 集成、扩展加载、pi 事件->`CanonicalEvent` 映射、REST/SSE 服务（实现 ai-coding 前端契约）、项目/会话树组织、模型/provider 对接。**可独立无头运行** |
| **forge-desktop** | Electron | 桌面壳：窗口/托盘/单例/原生对话框/通知/自动更新(electron-updater)/安装器(electron-builder)。嵌入 forge-core |
| **forge-ui** | Vue3+Vite | 前端：复用 ai-coding Vue，改造（去多CLI切换、`window.go.*` Wails 绑定改 Electron API、模型配置对接 pi），取 v1 MVP 子集 |
| **forge-extensions** | TS（pi 扩展） | 业务能力：以 pi 扩展承载（jiti 加载）。v1 具体扩展待 PRD 细化 |

## 6. v1 MVP 范围

**做：**
- 项目管理（添加/选择目录）
- 多会话（新建/切换/删除，复用 pi session）
- 对话（发消息、流式响应、Markdown + 代码高亮 + Mermaid）
- 工具执行展示（tool call/result 卡片、Diff）
- 模型/Provider 配置（对接 pi，基础选择）
- 项目信任（pi 自带，白捡）

**暂不做（后续迭代）：** 嵌入式终端（node-pty+xterm）、发送队列、子代理面板、复杂 ToolProfile CRUD、图片附件、per-tool 审批扩展、嵌入式 agent 形态（v2+）、TUI 形态。

## 7. 非目标（v1）

- 不做多引擎可切换（claude/codex/opencode 子进程）
- 不 fork pi 核心源码
- 不做 TUI 形态
- 不做嵌入式 agent（v2+）
- 不做自定义 per-tool 审批层（跟 pi 一致）
- 不做沙箱（跟 pi 一致，隔离由 OS/容器负责）

## 8. 技术栈

- **引擎**：Node.js ≥22 + TypeScript；pi（`@earendil-works/pi-coding-agent` 等）作 npm 依赖
- **桌面壳**：Electron + electron-builder + electron-updater
- **前端**：Vue 3 + Vite + TS（复用 ai-coding），marked / prismjs / mermaid
- **通信**：HTTP REST + SSE（ai-coding 前端契约）
- **扩展**：pi 扩展（TS，jiti 加载）
- **存储**：pi session JSONL + forge 项目组织层
- **构建**：npm workspaces，tsc/tsgo

## 9. 隐含假设（待 PRD/开发压力验证）

- pi 扩展 API + SDK 足以覆盖 forge 业务能力。
- ai-coding 前端 REST+SSE 契约可由 forge-core 实现，pi 事件能映射到 `CanonicalEvent`。
- ai-coding 前端可改造适配 Electron + pi（去 Wails 绑定、去多 CLI、模型配置对接）。

## 10. 待继续讨论

> 用户表示还有其他事项要讨论，确认点 1 暂不推进。讨论完成后再次确认，再进入：
> **gen-doc-init -> gen-doc-prd（逐模块两轮确认）-> 确认点 2 -> DB/API/测试设计 -> artifacts.json**

### 已知待定项（v1 不必全定，但讨论中可能涉及）
- 嵌入式 agent 形态（v2+）：SDK 库 / 无头服务 / CLI（架构已不堵死）。**已整理到 `embedded-agent-discussion.md`**（含 3 种嵌入方式、pi-server 真相、一份核心两宿主、性能分析）
- forge-extensions v1 具体有哪些业务扩展（待 PRD）
- ai-coding 前端改造的工作量与边界
- forge-core 的 REST/SSE 契约与 ai-coding 原契约的差异点
