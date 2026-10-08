# 13 快捷键（Keyboard Shortcuts）

> 状态：`实现中`（键位与清单内容 2026-10-08 逐条拍板；§7 两项已确认）
> 原型：`prototypes/settings-shortcuts-demo.html`（布局 A/B × 中英 × Win/mac 记法 × Tab 位置 × 明暗，可交互切换）
> 定位：把散落在各组件里的按键行为**收拢成一份对用户可见的清单**，并补齐 3 个高频动作的键位。**本期不做改键。**

---

## 1. 背景与问题

forge 目前几乎没有"快捷键"这个概念：

- 全应用只有 **1 个组合键** `Ctrl+\``（开合终端，`App.vue:437`）。其余全是组件内的上下文单键（`Enter`/`Esc`/`↑↓`），散在 11 个文件里。
- 没有任何地方告诉用户「连按两次 `Esc` 能打断流式」「`Esc` 是逐级退出」。这些能力存在，但只有读过代码或碰巧试到才知道。
- 高频动作只有鼠标入口：新建会话（顶栏 `+`、树行 `+`）、打开设置（侧栏 footer）、折叠侧栏（标题栏按钮）。
- **一处既有不一致**（改动前口径）：终端复制键判了 `ctrlKey || metaKey`（`TerminalPanel.vue:216`），终端开合键只判 `ctrlKey`——Mac 上 ``⌘+` `` 按了没反应。改动前渲染层没有任何平台判定代码，本期由 `utils/platformKey.ts` 补上并修好这一条（清单第 1 行的键位本来就有，本期新增的是 Mac 通道）。
- 主进程**未注册** Electron `Menu` / `globalShortcut`（`forge-desktop/src/main.ts` 无相关引用），DevTools 键走 `before-input-event`（`main.ts:419-431`，仅 dev 模式）。所以没有 accelerator 层，全部键位在渲染层实现。
- 文案里还硬编码了一处键位：`terminal.toggle` = 「终端 (Ctrl+\`)」（`i18n/domains/terminal.ts`），Mac 上显示的就是错的。

## 2. 范围

**做**：设置页第 5 个 Tab（只读清单，3 组 12 行）+ 主修饰键抽象 + 3 个新键位 + 1 处 Mac 回归修复。

**不做（本期明确排除）**：

| 排除项 | 理由 |
|---|---|
| 改键 / 录制框 / 冲突检测 | 需把 `App.vue`、`ConversationView.vue`、`InstructionInput.vue` 的硬编码判断改成读集中注册表，会动到已验收的「`Esc` 逐级退出」与「连按两次打断流式」。留待下一档。 |
| 新建会话的「有草稿不生效」保护 | 草稿按会话 key 实时落仓（`utils/composerDrafts.ts`，`InstructionInput.vue:1418` 每次编辑即存），切走不丢、切回自动回填；且既有三个新建入口（顶栏 `App.vue:1287`、树行 `App.vue:1227`、hero）都不判草稿。加了保护反而让快捷键成为全应用唯一一个会拦的入口，且行为"时灵时不灵"。**用户 2026-10-08 确认砍掉。** |
| 终端粘贴 `Ctrl+Shift+V` | 未拍板，维持右键现状。首版清单里曾标注「尚无快捷键」，用户 2026-10-08 要求「终端的去掉」→ 整组（复制选区 + 粘贴）移出清单。 |
| 全局搜索 / 主题切换 / 上下一会话 的快捷键 | 前者功能尚不存在；后两者非高频，加了是键位噪音。 |
| Electron `Menu` / `accelerator` 层 | 引入原生菜单会改变无边框窗口与默认菜单行为，超出本期。 |
| 把上下文单键做成可配置项 | `↑↓`/`Enter`/`Esc` 是组件内编辑语义，抽出来配置没有意义，只进清单展示。 |

## 3. 关键设计决策

### 3.1 主修饰键：一个判定 + 一个展示标签，不做 keymap 注册表

新增 `packages/forge-ui/src/utils/platformKey.ts`，导出判定与展示两组小函数（无默认对象、无状态泄漏）：

```ts
export function isMacPlatform(): boolean;                      // 取缓存的平台判定
export function hitsPrimary(ev: KeySignal, want: KeyWant, mac?): boolean;
export function capLabels(caps: readonly string[], mac?): string[];      // 'P'→'Ctrl'|'⌘'
export function capsSeparator(labels: readonly string[], mac?): string;  // Mac 主键组合连写 → ''
export function formatCaps(caps: readonly string[], mac?): string;       // 'Ctrl+`' / '⌘`'
```

- **平台来源以 `window.forge.platform` 为准**（preload 注入的 `process.platform`）——这是项目既有的权威口径，`App.vue:164`、`TitleBar.vue:19` 已在用；`preload.ts:232-233` 明确说明 contextIsolation 下 `navigator.platform` 不可靠。仅当桥不存在或值为 `'browser'`（纯浏览器 / e2e mock 场景）时才回落 `navigator.platform` + `userAgent` 猜测。结果首次调用后缓存。
- `hitsPrimary` 要求修饰键**精确匹配**：主修饰键（Mac→`metaKey`、其他→`ctrlKey`）必须命中且另一个不能按下；`shift`/`alt` 按 `want` 里声明的期望值逐项比对（未声明即期望 false，所以 `Ctrl+Shift+N` 不会被 `Ctrl+N` 命中，反之亦然）。再判 `key`（大小写不敏感）与 `code` 双通道，覆盖键盘布局差异。
- 展示层键帽文本由 `capLabels` + `capsSeparator` + `formatCaps` 拼，**i18n 文案里不再写死键位**——`terminal.toggle` 改为「终端 ({hotkey})」，键位由 UI 层传入。

> 为什么本期不建 keymap 注册表：注册表是为改键准备的基础设施。本期只有 4 个全局键，先统一"怎么判"和"怎么显示"这两件事；下一档开放改键时，把这 4 个键搬进注册表即可，不返工判定逻辑。

### 3.2 四个全局键位

| 动作 | Windows / Linux | macOS | 接的现有入口 |
|---|---|---|---|
| 开合终端面板 | ``Ctrl+` `` | ``⌘` `` | `setTerminalOpen()`（现状，补 Mac 分支） |
| 打开 / 关闭设置 | `Ctrl+,` | `⌘,` | `openSettings()` `App.vue:908` / `closeSettings()` `App.vue:914` |
| 显示 / 隐藏侧栏 | `Ctrl+B` | `⌘B` | `sidebarCollapsed` 取反（`App.vue:110`，与标题栏按钮 `App.vue:1127` 同一状态） |
| 新建会话 | `Ctrl+Shift+N` | `⌘⇧N` | `onCreateSession()` `App.vue:734`，与顶栏 `+` 完全同参 |
| 打开开发者工具 | `F12` / `Ctrl+Shift+I` | 同左（主进程只判 `input.control`，未做平台分支；仅 dev 模式生效） | 主进程 `before-input-event`，本期不改，仅入清单 |

- macOS 记法按平台惯例连写不带 `+`（`capsSeparator` 对 `⌘` 开头返回空串），Win/Linux 用 `+`。
- **表内后两行不进设置页清单**（用户 2026-10-08 拍板，见 §3.3）：「打开 / 关闭设置」仍按上表接线可用，只是不列进快捷键 Tab；「打开开发者工具」属主进程既有行为，本期未改也不罗列。

- **`Ctrl+N` 特意避开**：单窗口应用将来若加多窗口，`Ctrl+N` 是既定语义，先不占用。
- **设置做成 toggle**：在会话视图按 → 进设置；已在设置页再按 → `closeSettings()` 回会话视图。与侧栏、终端的 toggle 语义一致。
- **无需聚焦豁免**：`Ctrl+B` / `Ctrl+,` / `Ctrl+Shift+N` 在 textarea 里都不产出字符（与 `App.vue:434-436` 对 `Ctrl+\`` 的既有论证同理），所以不必为输入框特判。
- **实现形态**：4 个动作合并为**一个** `onGlobalHotkey` 监听（内部按修饰键+key 分派），替换现有 `onTerminalHotkey`；`onCodeEscape` 保持独立不动（它管的是逐级退出语义，不是全局动作）。注册/注销位置沿用 `App.vue:1085-1086` / `1098-1099`。

**设置页作用域**（本期唯一的例外，见 §7）：`activeView === 'settings'` 时只响应「终端」和「设置(toggle 回)」两键。理由：设置页没有可见侧栏，`Ctrl+B` 会去折叠一个看不见的东西；`Ctrl+Shift+N` 会在后台把当前会话切走、而用户屏幕上仍停在设置页——两者都是"按了没反应"或"按了更乱"。

### 3.3 清单内容口径（2026-10-08 逐条拍板）

- **布局 B**：分组收进单卡、行间 1px 分割线（区别于「个性化」Tab 的一卡一行）。
- **Tab 位置**：排在 **Skills 之后、关于之前** → 通用 / 个性化 / Skills / 快捷键 / 关于。
- **保留「本版新增」徽标 → 已摘除**（用户 2026-10-08 见到首版后拍板）：徽标原是标在设置/侧栏/新建会话三行上的青绿胶囊（`--brand-accent` 14% 底），既然清单要压到最小，整类去掉；`ScRow.badge` 字段、`.sc-badge` 样式与 `shortcuts.badge.new` 文案一并删除，开放改键时如需再引入当作新需求重议。
- **「打开 / 关闭设置」「打开开发者工具」两行不进清单**（用户 2026-10-08 拍板）：`Ctrl+,` 的接线行为不变（§3.2），只是不再罗列；DevTools 键本就不是本期新增能力，属主进程既有行为，清单不收录。故全局组只剩终端、侧栏、新建会话三行。
- **卡片边框去重**：基类 `.pref-row` 自带 `border + radius + background`（那是「个性化」Tab 一卡一行的形态），进了 `.sc-card` 必须显式脱框（`border:none; border-radius:0; background:transparent`），否则卡片外框与行框各画一条线（左右沿看着 2px），行间分割线还会与行自身的 `border-top` 再叠一层。demo 里按布局作用域写样式所以没这问题，落到 `SettingsPanel.vue` 的全局 `.pref-row` 才暴露；已由 e2e 逐行数 `computed border-*` 钉住（SC-E2E-007）。
- **删三行**：「翻阅历史输入」「建议导航方向键（`↑↓` → `Enter`）」「滚出消息流」。理由：它们是输入框/滚动区里的普通按键，占快捷键条目反而稀释真正的全局键。
- **`@` 与 `/` 以触发符呈现**：无边框等宽字符 chip（`.sc-sym`），与带边框键帽（`.sc-kbd`）视觉区分；说明文字承担语义（"在输入框键入此符号唤起文件选择/命令列表"）。
- **「终端内」整组不进清单**（用户 2026-10-08 见到首版后拍板删掉）：复制终端选区 / 粘贴到终端两行连同分组移除。附带原因：`capLabels` 的令牌里 `'C'` 就是 Control，字母 C 无法用令牌表达，首版把「复制终端选区」渲染成了 `Ctrl + Ctrl`；该组本也只是终端内部行为，不是应用级快捷键。

最终清单：全局快捷键 3 行 / 输入与发送 5 行 / 打断与关闭 4 行 = **12 行 3 组**。

### 3.4 承载：SettingsPanel 第 5 个 Tab

- `activeTab` 联合类型 +`'shortcuts'`；`tabBtns` 对象 +1 键；`setTabRef` 签名 +1（`SettingsPanel.vue:387/390/392`）；nav 按钮插在 Skills 与 关于 之间（`SettingsPanel.vue:622-648`）；body 沿用 `v-if` 条件渲染（与现有 4 个 Tab 同构，不引入 `component :is`）。
- 滑动选中块（`moveThumb` + `ResizeObserver`）依赖 `tabBtns` 的键集，新增 Tab 必须同步注册 ref，否则 thumb 定位不到——这是现有实现里最容易漏的一处。
- 内容**全静态**：无 IPC、无 RPC、无 localStorage。数据以组件内常量数组声明，按 §3.3 的三组渲染。
- i18n：新增 `i18n/domains/shortcuts.ts`，导出 `zhShortcuts` / `enShortcuts`，键前缀 `shortcuts.`（`shortcuts.tab` / `shortcuts.group.*` / `shortcuts.item.*` / `shortcuts.hint`），并入 `i18n/zh-CN.ts` 与 `i18n/en.ts` 的 spread。**zh 键集是 `MessageKey` 类型基准，en 缺键会回落中文**，两个对象必须同时补齐。
- 文案「返回工作区」「设置」等复用既有键，不重复定义。

## 4. 需要新增的接口

**无。** 零 RPC、零 IPC 通道、零主进程改动、零持久化、零 schemaVersion 变更。本期是纯渲染层改动。

## 5. 改动清单

| 文件 | 改动 | 说明 |
|---|---|---|
| `packages/forge-ui/src/utils/platformKey.ts` | 新增 | `isMacPlatform` / `hitsPrimary` / `capLabels` / `capsSeparator` / `formatCaps`；平台来源 `window.forge.platform`，浏览器场景回落 navigator |
| `packages/forge-ui/src/App.vue` | 修改 | `onTerminalHotkey` → `onGlobalHotkey`（4 动作分派 + 设置页作用域例外）；注册/注销沿用现有位置 |
| `packages/forge-ui/src/components/SettingsPanel.vue` | 修改 | 第 5 个 Tab：`activeTab`/`tabBtns`/`setTabRef`/nav/body + `SC_GROUPS` 静态数据 + `.shortcuts-body`/`.sc-card`/`.sc-kbd`/`.sc-sym` 样式（`.sc-card .pref-row` 显式脱掉基类边框，见 §3.3） |
| `packages/forge-ui/src/components/CodeViewer.vue` | 修改 | 终端按钮 tooltip/aria-label 的键位改由 `formatCaps` 注入 |
| `packages/forge-ui/src/i18n/domains/shortcuts.ts` | 新增 | 第 14 个域文件，中英双导出 |
| `packages/forge-ui/src/i18n/domains/settings.ts` | 修改 | `settings.tab.shortcuts`（zh + en 两处） |
| `packages/forge-ui/src/i18n/domains/terminal.ts` | 修改 | `terminal.toggle` 硬编码的「(Ctrl+\`)」改为 `{hotkey}` 插值 |
| `packages/forge-ui/src/i18n/zh-CN.ts` / `en.ts` | 修改 | 合并新域 |
| `packages/forge-ui/test/platformKey.test.ts` | 新增 | 11 例判定/展示矩阵，见 §6 |
| `packages/forge-ui/e2e/shortcuts.spec.ts` | 新增 | 键位生效 + 作用域 + Tab 渲染，见 §6 |
| `prototypes/settings-shortcuts-demo.html` | 新增 | 布局/记法/Tab 位置/中英/明暗可切换原型 |
| `docs/prd/index.md` / `docs/overview.md` / `docs/changelog.md` | 修改 | 模块登记 |

## 6. 验收

- `npm run typecheck` 0 错；`npm run test` 全绿。
- **单测**（`test/platformKey.test.ts`，11 例）：Mac/非 Mac 下 `⌘`/`Ctrl` 交叉不命中（含本期修复的 ``⌘+` ``）；主修饰键混按（⌘+Ctrl）排除；`Alt` 一律排除；纯键无修饰不命中（保证输入框打字不受影响）；`Shift` 作为要求项（`Ctrl+Shift+N` 命中、`Ctrl+N` 不命中）；`key` 大小写不敏感；`key` 与 `code` 或关系兜底；展示记法（`⌘` 组合连写、`P`→⌘ 与 `C`→⌃ 区分、`capsSeparator`）。
- **e2e**（`e2e/shortcuts.spec.ts` 7 例，已全绿）：① 四个键各按一次，断言终端面板开合 / `activeView` 进设置 / 侧栏折叠 class / 新建会话退出当前会话；② 设置页作用域内 `Ctrl+B`、`Ctrl+Shift+N` 不响应；③ 快捷键 Tab 渲染 3 组 **12 行**、无徽标无占位行，中英各一遍量 rect（标题右沿 ≤ 键帽左沿 − 12px，键帽不溢出卡片）；④ 逐行数 `computed border-top/right/bottom/left`：各组首行四边皆 0，其余行只有 `1px/0px/0px/0px`（钉住 §3.3 的卡片去框口径）；⑤ thumb 落位后与 `.settings-tab.active` 的 left/width 差 ≤1px（**不能点完立刻量**：水滴时序途中宽度会过 0）。
- **真机回归项**：Mac 上 ``⌘` `` 开合终端（本期修复的既有缺陷）。

## 7. 已确认口径（2026-10-08）

1. **设置页作用域例外**（§3.2 末）：按「设置页里侧栏键与新建会话键不响应」实现。
2. **终端粘贴 `Ctrl+Shift+V`**：本期不做，维持鼠标右键现状；「终端内」那组连复制选区一起不进清单（§3.3 末条）。若下一档做粘贴键，与 §3.1 的 `hitsPrimary` 无冲突（终端内该组合未被占用），需要在 `TerminalPanel.vue` 的 `attachCustomKeyEventHandler` 里加一条放行分支。
3. **清单再收 2 行 + 摘除徽标**（用户 2026-10-08 第二轮反馈）：「打开 / 关闭设置」「打开开发者工具」两行删除、「本版新增」徽标整类删除；`Ctrl+,` 的接线与设置页作用域例外均不变（SC-E2E-002 / SC-E2E-006 仍覆盖），只是清单不再罗列。
