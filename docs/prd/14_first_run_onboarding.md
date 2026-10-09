# 14 · 首次使用指引蒙层

> 状态：已交付（2026-10-09 代码 + 单测 + e2e 全绿，真机视觉验收待用户跑 dev 应用）
> 来源：2026-10-09 用户要求「想给首次使用 app 的用户加一个蒙层的使用指引」，两轮 AskUserQuestion + 三形态 demo 后拍板。

## 1. 背景与问题

forge 的主界面把入口藏得很紧：目录视图是项目行尾一个 `<>` 图标、终端是工具条右端一个 26px 图标、设置是侧栏底部一行 50×19 的文字。新装用户第一次打开看到的是一个空状态 hero + 一棵只有「新会话」的树，没有任何东西告诉他这些入口在哪，而模块 13 的快捷键 Tab 只在「已经知道有设置页」之后才可能被发现。

现状（改动前）：

- 首启只有一层 `BootWelcome` 开屏动画（2026-09 交付），它讲品牌不讲功能，散场后什么都不留。
- 更新提示（模块 07）与「本版新增」（`WhatsNewDialog`）都只在**升级**路径出现，新装用户永远碰不到。
- 没有任何机制告诉用户「这个 app 首次进入会弹一个指引」，也没有重看入口。

## 2. 范围

**本期做**：

1. 六步**分步聚光灯**指引（形态 A），覆盖：会话树 → 目录视图 `<>` → 新建会话 → 终端 → 设置 → 侧栏更新入口。
2. **仅全新安装首启**自动出现一次；看过/跳过即落盘，之后不再自动弹。
3. 设置页「关于」Tab 放**重看使用指引**入口（用户拍板：只放关于页，不放通用/个性化）。
4. 蒙层期间**全部不可操作**（含洞内元素）：不做逐锚点放行，点空白/Esc = 跳过。
5. 锚点契约用真实元素上的 `data-onboarding` 标记，锚点缺失自动剔除该步（无更新入口是常态）；**「目录视图」一步例外**，零项目时退到备用锚点，见 §3.3。

**本期不做**（都是用户明确砍掉的）：

- 对话框/输入框的讲解：「对话框的步骤不用说，输入框也不用指引」。
- 洞内可点击（click-through / 逐锚点放行）。
- 分步截图、GIF、可拖拽卡片、进度条、多语言之外的文案变体。
- 升级路径的指引（升级首启已由 `WhatsNewDialog` 承接，两者互斥成立：新装 ⇒ `isUpgradeRun` 必为假）。
- 按角色/按功能的引导埋点。

## 3. 关键设计决策

### 3.1 形态：三方案 demo 对比后选 A（分步聚光灯）

`prototypes/onboarding-overlay-variants.html` 同屏摆三种形态（A 聚光灯分步 / B 一次性热区标注 / C 右下角气泡队列），用户选定 A。B 在实测中放不下六条文案，C 的注意力成本太低读不完。

### 3.2 「新装首启」必须由主进程同步判定

判定口径 = `updater-state.json` 里**没有** `lastRunForgeVersion`。这条必须在主进程启动早期一次性快照：

- `startupUpdate` 在启动流程后段就会把 `lastRunForgeVersion` 回写成当前版本，渲染层再读已经分不出「新装」和「平运行」。
- 所以新增 `IPC_STARTUP_FLAGS`（`forge:startup-flags`），值在 `readUpdaterState` 之后、任何回写之前算好，`registerShellIpc` 直接把这份常量镜像出去，渲染层任何时候问都是同一个答案。
- 纯函数 `resolveStartupFlags(lastRunForgeVersion, appVersion)` 单独成文件（`startupFlags.ts`），因为 forge-desktop 的单测只覆盖纯模块。

**已知降级（接受，不修）**：`updater-state.json` 缺失与损坏都归一为 `null` → 都判成新装首启。损坏文件本来就该重写，多弹一次指引比少弹一次更可接受。

### 3.3 锚点契约 = `data-onboarding` 标记，不是 class

| 锚点 | 落点 | 实测矩形（1280×800 mock） |
|---|---|---|
| `treelist` | `App.vue` `.tree-view` | 292×541 |
| `codeentry` | `ProjectTree.vue` `.tree-icon-button.code-entry` | 18×18 |
| `codeentry-empty` | `ProjectTree.vue` `.tree-empty`（「暂无项目」空态行） | 292×65 |
| `newsession` | `App.vue` 工具条第一个 `.app-toolbar-btn` | 64×44 |
| `terminal` | `App.vue` `.app-toolbar-btn.term-toggle` | 26×26 |
| `settings` | `App.vue` `.sidebar-link`（设置） | 50×19 |
| `update` | `UpdateEntry.vue` 根 `.up-entry` | 22×20（仅 `entryVisible` 时存在） |

class 会随重构漂移，标记漂移了 e2e 与组件都会立刻咬住。**锚点缺失即剔除该步**：没有更新入口行时那一步不出现，所以实际步数不是写死的 6，计数与圆点都按剔除后的清单走（mock 实测 5 步）。

**「浏览目录」这一步不能靠剔除**（2026-10-09 补，用户拍板）：`<>` 挂在项目行上，而**全新装首启必然零项目**——实测清空项目后 `codeentry` MISSING、`update` 也 MISSING，蒙层只剩 **4 步**，用户点名要讲的功能在最该讲的人群里反而不讲。所以 `TourStep` 多一个可选 `alt`：**备用锚点和配套文案一起换**，零项目时圈住「暂无项目」空态行（实测洞 304×77、卡片高 184），标题走 `onboarding.step.code.empty.*`「浏览目录要先有项目」，正文改成「添加项目后它的行尾会出现 <> 图标」。对着还没有的图标讲「点这个 <> 图标」是假话，所以两套文案必须成对存在，不允许只换锚点不换字。备用文案刻意比主文案短（en 主 225px / 备 184px），别在扩写时反超。

### 3.4 蒙层期间被高亮控件必须强制显形（实测发现）

`<>` 图标在 `.tree-node-actions` 里，而这块基类是 `opacity: 0`、只有 `.tree-project:hover` 才显形。蒙层吃掉了全部指针事件 → 用户永远 hover 不到 → **第 2 步的高亮洞圈住的是一个透明图标**。

修法：`OnboardingTour` 在 `visible` 变化时给 `<html>` 挂/摘 `ob-tour-active` 类，`ProjectTree.vue` 加一档

```css
html.ob-tour-active .tree-project .tree-node-actions { opacity: 1; }
```

只提 `opacity`，**不给 `pointer-events`** —— 看得见但点不到，与「全部不可操作」的拍板一致。这条有红探针：删掉这档 CSS，`ONB-E2E-001` 在第 2 步必红（断言沿祖先链查 `opacity/display/visibility`）。

### 3.5 挖洞与落位：三条实测硬结论

1. **洞有最小尺寸 76×30**：设置入口实测 50×19、`<>` 18×18，原样挖洞是针眼；锚点外扩 6px 后再兜底，并把整洞夹回视口。
2. **卡片落位顺序右 → 左 → 下 → 上**，候选先水平夹取，再要求完整在窗内且不压避让清单（清单至少含自己的洞）。终端图标钉在工具条右端，右侧无余量，实测退到左侧。四个方向都不合身才走兜底（贴洞下方并逐步上移让开清单）。
3. **卡片高度按实测**：六步文案长短差一倍（zh 159~181px），所以写完文案先 `nextTick` 再量 `offsetHeight`，`CARD_H_FALLBACK` 只在量不到 DOM 时用。

z 档 6000/6001/6002，压在 `ConversationView` 的 5000 层之上。`Teleport to="body"`：祖先带 `transform` 会让 `position: fixed` 失效，这是仓内既有蒙层类组件的统一做法。

### 3.6 不留点不动的蒙层

- 清单为空（一个锚点都没找到）→ 立刻 `closeTour()`。
- 首帧就位后才加 `is-open`：否则洞会从窗口左上角飞进来（`position` 过渡是常驻的）。
- 点遮罩、Esc、最后一步「开始使用」三条出口都落盘 `forge:onboarding:seen:v1`。
- Esc 在捕获阶段 `stopPropagation`，指引期间的 Esc 不许再冒给 App 的分层退出逻辑。

### 3.7 关于页新按钮的类名单独走 `.tour-btn`

「重看使用指引」那一行的按钮与「检查更新」完全同款，样式直接并入基类选择器（`.up-btn, .tour-btn { … }`），但**类名必须分开**：`e2e/updater.spec.ts` 有 14 处用裸 `.up-btn` 选更新按钮，关于页再多一个同类会让它一次选中两个元素、Playwright 直接 strict mode violation（实测红 5 例，改回独立类名后 onboarding + updater 8/8 绿）。

## 4. 需要新增的接口

只有一个 shell 级 IPC 通道，与 `forge:boot-state` 同族（不进 `docs/api` 的 forge-core RPC 目录，那里只记业务模块方法）：

| 通道 | 方向 | 载荷 | 语义 |
|---|---|---|---|
| `forge:startup-flags` | renderer → main（invoke） | 无 → `{ isFreshInstall, isUpgradeRun }` | 启动早期一次性快照，进程生命周期内恒定 |

## 5. 改动清单

| 文件 | 改动 |
|---|---|
| `packages/forge-desktop/src/ipc-contract.ts` | `IPC_STARTUP_FLAGS` + `StartupFlags` |
| `packages/forge-desktop/src/startupFlags.ts` | 新增，纯函数 `resolveStartupFlags` |
| `packages/forge-desktop/src/main.ts` | 启动早期快照 flags；`registerShellIpc` 多收一个参数并注册 handler |
| `packages/forge-desktop/src/preload.ts` | `startupFlags()` 桥方法 |
| `packages/forge-ui/src/bridge.ts` | `StartupFlags` 镜像 + `getStartupFlags()` |
| `packages/forge-ui/src/mock-bridge.ts` | 默认报 `isFreshInstall: false`，仅 `localStorage['forge-mock-fresh-install']='1'` 才为真 —— 否则全部存量 e2e 会被蒙层挡住 |
| `packages/forge-ui/src/composables/useOnboarding.ts` | 新增：`visible` / `autoStart` / `openTour` / `closeTour`，seen 落盘与 try-catch 口径抄 `usePreferences` |
| `packages/forge-ui/src/components/OnboardingTour.vue` | 新增：步骤表、挖洞、落位、键盘、样式 |
| `packages/forge-ui/src/i18n/domains/onboarding.ts` | 新增第 15 个域文件（`onboarding.*`，zh/en 全量），`zh-CN.ts`/`en.ts` 合并 |
| `packages/forge-ui/src/App.vue` | 六个锚点里的四个（`treelist`/`settings`/`newsession`/`terminal`）+ 蒙层散场后 `autoStart` + 挂 `<OnboardingTour />` |
| `packages/forge-ui/src/components/ProjectTree.vue` | `codeentry` 锚点 + 零项目空态行的备用锚点 `codeentry-empty` + §3.4 的强制显形那一档 |
| `packages/forge-ui/src/components/UpdateEntry.vue` | `update` 锚点 |
| `packages/forge-ui/src/components/SettingsPanel.vue` | 关于页「重看使用指引」行（按钮类名 `.tour-btn`，见 §3.7）；点击先 `emit('close')` 再 `nextTick` 开蒙层（工具条是 `v-if="activeView !== 'settings'"`，不先关就少两步） |
| `packages/forge-desktop/test/startupFlags.test.ts` | 新增 5 例 |
| `packages/forge-ui/e2e/onboarding.spec.ts` | 新增 3 例（几何逐步骤实测 + 退出/重看 + 零项目退路） |
| `prototypes/onboarding-overlay-variants.html` | 三形态 demo（定稿依据，gitignore 目录）；「模拟零项目新装」勾选框同步了退路行为 |
| `prototypes/_shot-onboarding.mjs` | 逐步 × 双主题 × 双场景实拍脚本，顺带打印每步卡片高度（gitignore 目录） |

## 6. 验收

- `npm run typecheck`：0 错（全仓）。
- `npm run test -w @forge/desktop`：`startupFlags` 5/5；仓内存量 7 红为本机基线（`PiConversationAdapter` ×2、`ensurePiShellPath` ×4、`建窗底色` ×1），与本模块无关。
- `npx playwright test e2e/onboarding.spec.ts`：3/3 绿（1280×800，逐步骤断言洞包住锚点、卡片完整在窗内、卡片不压自己的洞、锚点在蒙层下可见、清单自动缩成 5 步、Esc/落盘/reload 不再自动开、关于页重看入口、零项目时第 2 步退到空态且标题为「浏览目录要先有项目」）。
- 邻域回归：`e2e/updater.spec.ts` 6 例与 onboarding 共跑 8/8 绿。**中途红过一次**——关于页新按钮最初复用 `.up-btn`，把 updater 的裸 `.up-btn` 选择器撑成两个元素、5 例 strict mode violation，按 §3.7 拆类名后恢复。
- 全量 e2e（257 例，1 worker，16.4 min）：**227 passed / 21 failed / 2 skipped**，本模块与 `updater`/`settings`/`shortcuts`/`smoke`/`tooltip`/`terminalTopEdge` 全绿。21 例红**全部不在本模块**（`branchBadge` ×3、`gitHistory` ×3、`thinkingLevel` ×5、`subagent` ×4、`mw-restore` ×2、`contentWidth` ×1、`todoPanel` ×1、`session` ×1、`__repro-*`/`tmp-filmstrip` 探针 ×2），单独重跑 6 个 spec 仍是同样 15 红 —— 稳定红不是抖动。其中 `subagent` 4 例与 `session` 1 例是仓内已登记的基线红（见 changelog v6.16/v6.17），其余落在最近两个提交（d8773ac 模型别名重构、70956d7 提交历史视图）改动过的邻域，本模块没碰。
- 红探针：摘掉 §3.4 的 CSS 一档 → `ONB-E2E-001` 第 2 步必红；把 `alt` 从步骤表里删掉 → `ONB-E2E-004` 红在第 2 步「洞没圈住任何锚点」（零项目只剩 4 步）。
- 视觉实拍：`node prototypes/_shot-onboarding.mjs` → `prototypes/onboarding-shots/`，`{light,dark}-step-{1..5}.png`、`dark-en-step-{1..5}.png`、零项目两套 `{light-empty,dark-en-empty}-step-{1..5}.png`，各自配一张 `-about.png`，控制台零报错。脚本同时打印每步「洞尺寸 / 卡片高 / 卡片底边」，改一句文案就要回来看这张表（zh 第 2 步 184、en 主文案 225、en 零项目 184，窗口高 800）。
- **待真机验收**：dev 应用（主进程改动不热更，需重启 `npm run dev`）在真实 Electron 窗口里走一遍，重点是暗色主题的压暗档位与洞边框粗细。

## 7. 已确认口径（2026-10-09）

- 形态 A 分步聚光灯；**仅全新安装首启**自动弹；重看入口只放设置「关于」Tab；蒙层期间全部不可操作。
- 步骤清单按用户改后的口径：不讲对话框与输入框，必须讲终端入口与目录视图入口。
- 锚点必须对齐真实代码（用户原话「你的锚点要对齐我们的真实代码就行了」），因此有 §3.3 的标记契约与 §6 的逐步骤 rect 实测。
- 零项目新装的「浏览目录」一步：**退到「暂无项目」空态并换配套文案**（2026-10-09 用户在三个选项里拍的板，另两个是「保持剔除」和「无锚点纯文字卡」）。
