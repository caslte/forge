# forge 项目目录梳理

> 基于仓库实际文件结构整理，用于快速定位代码与文档归属。
> forge = 基于 `pi` 编码代理引擎的桌面工作台（Electron + Vue 3），npm workspaces 单体仓库。

---

## 一、顶层结构

| 目录/文件 | 作用 | 备注 |
|---|---|---|
| `package.json` | npm workspaces 根（name: forge v0.1.0, `type: module`, node >= 22） | 聚合 4 个 workspace |
| `packages/` | 全部业务代码 | 见下文分层说明 |
| `docs/` | 全部文档（83 个 .md） | 需求/API/DB/测试/计划/规范，事实来源 |
| `prototypes/` | HTML 视觉原型 + 截图 | 代码改样式需同步此处（AGENT.MD 约定） |
| `electron/electron/` | **空目录** | 无内容，可清理 |
| `scripts/` | 工程脚本：`dev.js`、`package.mjs`、`release.mjs`、`bump-pi.mjs`、`collect-prod-deps.mjs`、`release.ps1`、`tmp-session-audit.mjs` | |
| `release/` | electron-builder 打包产物（win-unpacked，含 forge.exe / locales / *.pak） | 构建输出，不入版本控制 |
| `.github/workflows/release.yml` | 发布流水线 | |
| `.sisyphus/run-continuation/` | 4 个会话续跑状态 JSON | 工具运行残留 |
| `AGENT.MD` | 项目规范（代码改样式同步原型、改码必须更新文档、开发用 dev-tdd 等） | 强制约束 |
| `tsconfig.base.json` / `start.bat` | 共享 TS 配置 / 本地启动入口 | |

## 二、代码分层（packages，按调用顺序自上而下）

| 包 | 职责 | 规模 | 关键路径 |
|---|---|---|---|
| **forge-ui** `@forge/ui` | Vue 3 + Vite 前端，Electron 渲染层 | 82 文件 / 约 2.5 万行 src；53 个 e2e | `src/App.vue`、`src/bridge.ts`（IPC 桥）、`src/components/*`（约 35 个 .vue）、`src/i18n/`（11 个 domain + en/zh-CN）、`src/utils/`、`src/mock-bridge.ts`、`e2e/`、`playwright.config.ts` |
| **forge-desktop** `@forge/desktop` | Electron 主进程：窗口/托盘/单例/IPC/自动更新/pi 运行时装配 | 31 文件 / 约 7900 行；28 个测试 | `src/main.ts`、`preload.ts`、`ipc-contract.ts`、`createForgeCore.ts`、`pi/*`（piModelResolver、piSessionAdapter、skillService、appUpdater、gitBashResolver、keychainAdapter 等 20 个）、`mock/*`、`electron-builder.yml`、`build/installer.nsh` |
| **forge-core** `@forge/core` | 纯 Node 引擎层，传输无关（方法 + 事件），禁止 Electron API | 23 文件 / 约 6700 行；24 个测试 | `src/rpc/*`（project/session/conversation/tool/git/model Methods）、`src/project`、`src/session`、`src/conversation`、`src/store/forgeStore.ts`、`src/subagent/`、`src/tool/`、`src/markdown/`、`src/multiwin/`、`src/types/forge-store.ts` |
| **forge-extensions** `@forge/extensions` | pi 扩展承载业务能力（不 fork pi 源码） | 17 文件 / 约 1100 行；6 个测试 | `src/askUserQuestion/*`（8 文件）、`src/canvasHint/*`、`src/suggestNextSteps/*`、`slashCommandReporter.ts` |

依赖方向：`forge-ui` ↔(IPC/preload)↔ `forge-desktop` → `forge-core` + `forge-extensions` → pi SDK（`@earendil-works/pi-coding-agent` 0.84.3）。

## 三、docs/ 文档体系（事实来源）

| 目录 | 内容 |
|---|---|
| `overview.md` | **项目唯一入口文档**：背景、技术栈、分层、11 个一级模块与 PRD 导航、MVP 范围、当前状态 |
| `prd/` | 11 个 PRD（`01_project_management.md` … `11_git_commit_push.md`）+ `index.md` |
| `api/` | API 契约（`index.md` + `01~07`、`09_skill`、`11_git_commit_push`） |
| `db/` | `forge-store/schema.md`（自有存储）、`07_installer/` |
| `specs/` | 技术规范：`vue.md`、`go.md`、`java.md`、`python.md`、`common/coding-style.md`、`api-design.md`、`database.md` |
| `test/` | 测试用例：`coverage-matrix.md`（按 01~07 模块）、`e2e.md`、`unit.md`、`api.md`、集成 `integration/pi-core.md`、`index.md` |
| `plan/` | 计划与流水线产物：`forge-v1-plan.md`、`forge-v1.1-plan.md`、`pi-integration-*.md`、`embedded-agent-discussion.md`、`dev-*.json`（dev-flow 运行记录）、`results/`、QA 报告 |
| `templates/` | 文档模板（prd / api / plan / changelog / e2e / unit test 等 16 个） |
| `knowledge/` | 排障知识：flex-scroll-shrink、git-bash-autofix、ipc-events-whitelist、pi-extension-cold-load、pi-preflight-isstreaming-race 等 |
| `assets/` | `hero.png`、`multi-window.png`（README 使用） |
| `ui/` | **空目录** |
| `changelog.md` / `release.md` / `packaging.md` / `artifacts.json` | 变更记录与发布说明 |
| `docs/plan/results/` | 大量 JSON 产物（plan/qa/fanin/verify/normalize/env-* 等约 70 个），为流水线痕迹 |

## 四、常用命令

```bash
npm run dev          # scripts/dev.js，启动开发
npm run build        # 各 workspace 依次构建
npm run typecheck    # 各 workspace 类型检查
npm test             # 各 workspace 单测（node --experimental-strip-types --test）
npm run release      # scripts/release.mjs 发布；--dry-run 预演
npm run bump:pi      # 升级 pi 依赖版本
```

打包入口在 `packages/forge-desktop`：`dist` / `dist:dir` / `dist:ci`（先构建 core、extensions、ui，再 electron-builder）。

## 五、需要留意的问题

1. `electron/electron/` 与 `docs/ui/` 均为空目录，`docs/ui` 与 PRD 08（UI 国际化）相关但无内容。
2. `release/`（根）与 `packages/forge-desktop/release/` 是两处打包产物，后者含 `forge-0.1.9` 安装包与 `win-unpacked`，体积大。
3. `docs/plan/results/` 积累约 70 个流水线 JSON，无索引，检索成本高。
4. `prototypes/` 与代码样式高度耦合，按 AGENT.MD 每次改样式都需同步。
