# 嵌入式 Agent 讨论纪要

> 状态：讨论记录（v2+ 参考），不进 v1 范围
> 来源：forge v1 立项讨论中关于"业务系统用 pi 加 AI 性"的对话
> 关联：`forge-v1-plan.md`（主计划）、`think-1786004271124-plan.md`（think 流程）
> 日期：基于 2025 年对 pi(0.83.0) 的调研

---

## 1. 定位澄清：forge 与嵌入式是两件事

| | forge | 嵌入式 |
|---|---|---|
| 给谁用 | **人**（开发者） | **代码**（业务系统） |
| 形态 | 桌面项目工作台（Electron+Vue+pi），覆盖项目启动→对话编程 | 业务系统调用 agent 能力，增加 AI 性 |
| 谁负责 | forge | **pi 本身**（forge 不掺和） |

**结论**：嵌入式是 pi 的能力，不是 forge 的职责。forge 只做桌面工作台。

```
                    ┌─────────────────────────────────┐
                    │           pi（agent 平台）        │
                    │   npm 包 + 可编译独立二进制        │
                    │   SDK / CLI / RPC / Protocol      │
                    └──────────┬───────────┬───────────┘
                               │           │
              ┌────────────────┘           └─────────────────┐
              │                                              │
   【给人用】forge 桌面工作台                    【给代码用】业务系统嵌入
   Electron+Vue+pi                              直接用 pi，不经 forge
```

---

## 2. 核心结论

1. **嵌入式交给 pi**：业务系统要 agent 能力，直接用 pi 的 SDK/CLI/RPC，不经 forge。pi 本身已是可嵌入的 agent 平台。
2. **forge 不开放嵌入接口**：forge 是独立的桌面工作台，不对外提供"嵌入 API"。
3. **forge 的业务扩展天然可复用**：forge 业务能力以 pi 扩展承载，pi 扩展能被任何 pi 宿主加载。嵌入方想要 forge 某个能力，把那个扩展拿过去塞进自己的 pi 即可，**不需要 forge-core**。
4. **绝不拷源码**：用 npm 依赖（Node）或独立二进制（其他语言），不 fork、不 copy 源码。pi 开源，按其协议用。

---

## 3. 业务系统嵌入 pi 的 3 种方式

### 方式 ①：作依赖库（业务系统是 Node/TS 时）

```
┌──────────────────────────────────┐
│  你的 Node/TS 业务应用             │
│  ┌────────────────────────────┐  │
│  │ npm install                │  │
│  │   @earendil-works/pi-...   │  │
│  │ import { createAgentSession}│  │
│  │  -> agent 在你进程里跑       │  │
│  └────────────────────────────┘  │
└──────────────────────────────────┘
   ✅ 不需要 exe，最轻最快，事件/扩展全在手里
   ❌ 只限 Node/TS 应用
```

- pi 官方文档明确：Node/TS 应用优先用 SDK 进程内，别 spawn 子进程。
- SDK 含在主包 `@earendil-works/pi-coding-agent` 里，无需单独安装。

### 方式 ②：放 pi 可执行文件，RPC 子进程（业务系统是 Python/Go/Java/...）

```
┌───────────────────────┐      spawn       ┌──────────────────────┐
│ 你的业务应用           │ ────────────────►│ pi 可执行文件          │
│ (Python/Go/Java/...)  │                  │  pi --mode rpc        │
│                       │ ◄── JSON 协议 ──►│  (pi.exe / pi)        │
│                       │  stdin/stdout    │                       │
└───────────────────────┘   多轮·流式       └──────────────────────┘
        把 pi 二进制丢进部署包/容器/服务器
```

- pi 可用 `bun build --compile`（`build:binary` 脚本）编译成**独立二进制**（Windows=`pi.exe`，Linux/macOS=`pi`），**不依赖 Node**。
- 业务代码 spawn 它跑 `--mode rpc`，通过 stdin/stdout 谈 JSON 协议，支持多轮对话 + 流式事件。
- **跨语言通用**。这就是"放个 exe / linux 可执行"的方案。

### 方式 ③：常驻服务，网络调用（多消费者时）

```
┌────────────┐                        ┌──────────────────────┐
│ 业务应用 A  │ ──┐                ┌──►│ agent 服务常驻         │
├────────────┤   │  HTTP/网络协议  │   │ (跑在一台机器/容器)    │
│ 业务应用 B  │ ──┼────────────────┘   └──────────────────────┘
└────────────┘   │
           多个应用共用一个 agent 服务，最解耦
```

- pi 有 `pi-server`/`pi-protocol`/`pi-client` 包，但见 §4 真相。
- 最稳的做法：**用方式①的 SDK 自己包一层薄 HTTP 服务再容器化**（见 §5）。

### 选型表

| 业务系统语言 | 推荐方式 | 要不要 exe |
|---|---|---|
| Node / TypeScript | ① 作依赖库（SDK 进程内） | ❌ 不需要 |
| Python / Go / Java / Rust / ... | ② pi 二进制 + RPC 子进程 | ✅ 放个 `pi`/`pi.exe` |
| 多个服务都要用 / 分布式 | ③ 常驻服务 | 跑个服务进程 |

简单脚本甚至可 `pi -p "..."` 一行拿结果（one-shot）。

---

## 4. pi-server 的真相（纠正"开箱即用 HTTP 服务"误解）

`@earendil-works/pi-server` **不是**开箱即用的 HTTP 容器服务：

1. **实验性**：README 第一句"Experimental... may change or be removed without notice"。
2. **是库不是服务**：原话"This package does not provide a standalone CLI or coding-agent service. Applications supply the `PiServerService` implementation"。要自己写服务实现（接存储+agent）再起服务。
3. **内置传输 = Unix domain socket + CBOR 二进制**（`/tmp/pi/server.sock`），**不是 HTTP REST**。
4. **传输中立**：可自己加 WebSocket/HTTP 传输，但**只内置了 Unix**，HTTP/WS 要自己写。

→ **现阶段别依赖 pi-server 做"HTTP API 服务"**。

---

## 5. 容器 ≠ 服务化（重要区分）

pi 文档里的 **Docker 是"隔离沙箱"用途，不是"暴露成服务"**：

```
pi 文档的 Docker：
┌──── Docker 容器 ────┐
│   pi 进程            │  ← 限制 pi 能碰的文件/网络/权限（安全隔离）
│  (交互式 TTY/RPC)    │  ← 仍通过 TTY/RPC 交互，不是 HTTP 服务
└─────────────────────┘
   容器 = 隔离手段，不 = 服务化
```

- "Docker 容器服务"其实是两件事叠一起：①把 pi 做成服务 ②放进容器隔离。
- pi 官方只帮你做了②的隔离（Plain Docker / Gondolin micro-VM / OpenShell），①的服务化要自己做。
- 真要"HTTP API 容器服务"：**方式①SDK 包一层薄 HTTP（express/hono+SSE）再容器化**，接口形态自己定，最可控。

---

## 6. 一份核心两宿主（forge-core 传输无关接口，v2+ 可选）

> **v1.7 修正**：原方案"桌面端也走 HTTP/SSE"有本地攻击面（同机其他进程可打 HTTP 端口借 AgentSession 执行任意操作）。已改为：forge-core 暴露**传输无关接口**（方法+事件），桌面端走 **Electron IPC**（堵攻击面），headless 走 **HTTP/SSE**。接缝从"HTTP 服务"升级为"传输无关接口"，更干净也更安全。下方原 REST/SSE 表述保留为讨论脉络。

### 为什么能复用：一个"接缝"

forge-core 对外暴露**传输无关接口**（一组方法 + 事件流），不绑任何传输：
- 桌面壳（Electron）包一层 **IPC 适配**给 Vue 前端（不走 HTTP，堵本地攻击面）；前端 fetch/SSE 经适配层转 IPC。
- 无头壳（薄 Node 进程）包一层 **HTTP/SSE 适配**，给业务系统网络调用（v2+）。

**同一份 forge-core + 同一套传输无关接口，两个宿主各包自己的传输适配。**

### 架构图

```
┌──────────────────────────────────────────────────────────────┐
│                 forge-core（一份 Node 模块）                   │
│   pi SDK(AgentSession) · forge 扩展 · 事件->CanonicalEvent    │
│   项目/会话树 · 模型/provider 配置                            │
│   ┌────────────────────────────────────────────────────────┐ │
│   │  REST/SSE 服务层  ← 接缝：HTTP 接口，不绑 Electron       │ │
│   └──────────────────────────┬─────────────────────────────┘ │
└──────────────────────────────┼───────────────────────────────┘
                               │ 同一套接口
           ┌───────────────────┴───────────────────┐
           │                                       │
   ╔═══════▼══════════╗                  ╔════════▼═══════════╗
   ║ 宿主1：forge 桌面 ║                  ║ 宿主2：forge 无头   ║
   ║ (v1 就做)         ║                  ║ (v2+ 可选)          ║
   ║ Electron 壳       ║                  ║ 薄 Node 入口        ║
   ║ + Vue 渲染进程    ║                  ║ (只起 HTTP 服务)    ║
   ║ 给人用            ║                  ║ 给代码用            ║
   ╚════════╤═════════╝                  ╚════════╤═══════════╝
            │ localhost HTTP+SSE               │ 网络 HTTP+SSE
   ┌────────┴─────────┐                ┌────────┴───────────┐
   │  Vue 工作台界面    │                │ 业务系统 A / B / C   │
   │  (项目启动->编程)   │                │ (任何语言调 REST)    │
   └──────────────────┘                └────────────────────┘
```

### 两个宿主差异（只差一层壳）

| | 宿主1：forge 桌面 | 宿主2：forge 无头 |
|---|---|---|
| 进程 | Electron（主进程内嵌 forge-core） | 薄 Node 进程（只 import forge-core） |
| UI | 有（Vue 渲染进程） | 无 |
| HTTP 监听 | localhost（本机内部） | 端口（网络可访问） |
| Electron 专有（托盘/对话框/更新/安装器） | ✅ 有 | ❌ 没有 |
| **forge-core 本身** | **完全一样** | **完全一样** |

### 成本：几乎为零

- 唯一纪律：**Electron 专有东西（托盘/原生对话框/自动更新/安装器）写进 `forge-desktop`，绝不写进 `forge-core`。** forge-core 保持纯 Node。这本就是好的模块划分。
- 宿主2入口文件约 20 行（起服务、监听端口、可选鉴权）。
- v1 只做宿主1。宿主2是 v2+ 想要时，"换个入口 + 丢进 Docker"就上线。

### 与"业务直接用 pi"的关系（两层都成立）

| 业务系统想要 | 用什么 |
|---|---|
| **raw agent 能力**（最简） | 直接用 pi（SDK/CLI/RPC） |
| **forge 体验/能力作为服务**（同 REST/SSE 契约 + forge 扩展） | forge-core 无头（这份复用） |

forge-core 无头 = "**forge 即服务**"的免费选项，不是硬造的嵌入产品。

---

## 7. 性能：HTTP+SSE 不会慢

### 延迟构成（一次 agent 对话回合）

| 环节 | 耗时量级 | 占比 |
|---|---|---|
| **LLM 推理**（想+生成+多轮工具调用） | **数秒~数分钟** | **≈99.9%** |
| localhost HTTP 来回（Vue↔forge-core） | ~0.1–1ms | <0.1% |
| SSE 流式推送 + JSON 序列化 | 亚毫秒 | 可忽略 |
| pi SDK 内部处理 | 亚毫秒 | 可忽略 |

**HTTP+SSE 层加的延迟约 1ms，LLM 要几秒到几分钟。** 对 LLM agent 应用，传输层永远不是瓶颈。

### 类比

```
   厨师做菜(LLM)        传菜(HTTP接缝)        你吃
  ████████████████████   █   ▏              ▏
  数秒~数分钟             ~1ms              即时
  ← 99.9% 的时间在这 ->   ← 几乎不存在 ->
```

### 比 ai-coding 还快

ai-coding 当年 spawn 子进程(claude/codex) -> 解析 stdout -> 转事件，有进程启动+输出缓冲延迟。
forge-core 用**进程内 SDK**，直接从 AgentSession 拿事件，省掉子进程层，反而更快。

### 两个留意点（都可管理）

1. **超大 payload**（如读 50MB 文件）：序列化有成本，但跟用不用 HTTP 无关，靠截断/分页/流式处理。
2. **无头服务放远了**（跨机房）：网络 RTT 才明显，部署时同机房即可。

### 为何不用"直接函数调用"省掉 HTTP

ai-coding 前端本就是 fetch+SSE 写的，去掉 HTTP = 重写整个前端数据层，为省 ~1ms 不值得。留着 HTTP 接缝，前端几乎不改，还白捡"一份核心两宿主"复用。

---

## 8. 待定 / 决策

- **v1 不做嵌入式**（桌面工作台先行）。
- 嵌入式形态（SDK/无头服务/CLI）= v2+，**架构已不堵死**：
  - raw 嵌入 -> 用 pi 直接。
  - forge 即服务 -> forge-core 无头（传输无关接口复用）。
- **架构纪律**（v1 就要遵守，为 v2 铺路）：forge-core 保持纯 Node，Electron 专有逻辑放 forge-desktop。
- 待 v2 立项时再定：是否做 forge-core 无头服务、是否容器化、鉴权方案。
