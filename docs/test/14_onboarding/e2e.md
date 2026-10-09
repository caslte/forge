# 首次使用指引蒙层 E2E 设计

> 模块：14 · 用例文件：`packages/forge-ui/e2e/onboarding.spec.ts`
> 自动化等级：mock-backend（`window.__forgeMock` + `localStorage['forge-mock-fresh-install']=1` 让 `startupFlags` 报新装）
> 视口：`test.use({ viewport: { width: 1280, height: 800 } })` —— 与真机窗口同量级。窄窗（如 531×620）会触发兜底落位、卡片压在洞上，量不到正常路径，所以钉死。

## 为什么这个模块必须靠 e2e

指引的全部风险都在**几何**与**真实 DOM 锚点**上：typecheck 与单测只能证明它能编译，证明不了「洞圈住了东西」「卡片没盖住讲解对象」「被高亮的控件其实看不见」。所以逐步骤量 rect，一条都不抽样。

## 公共夹具

| 助手 | 作用 |
|---|---|
| `bootFresh(page)` | `addInitScript` 里：置 `forge-mock-fresh-install=1`、**只在本次 context 的第一次导航**清 `forge:onboarding:seen:v1`、把侧栏钉在「项目」视角（任务视角是平摊会话，没有 `<>` 锚点）。不清 seen 的话 reload 一次就测不出「看过之后不再自动开」 |
| `measure(page)` | 洞读 `.ob-spot` 的**内联 style**（落位目标值），卡片读 `getBoundingClientRect()`（真几何）；锚点靠「中心落在洞里」反查；`anchorVisible` 沿祖先链查 `opacity/display/visibility` |
| `attachHealthGuards` | 收尾断言零 console error / pageerror（AC-OB-017） |

时序：洞的跟随过渡是 420ms `--transition-decelerate`，每步之间等 560~600ms 再量。**不断言动画中间态**（无头/隐藏页 rAF 会停，动画时序不可复现）。

## 用例

### ONB-E2E-001/002 · 新装首启自动开蒙层，逐步量洞与卡片的真实几何

覆盖 AC-OB-006~010、014、017。

1. `.ob-root` 在 5s 内出现（证明 `App.vue` 蒙层散场后的 `autoStart` 接线成立）。
2. 圆点数 = **5**：六步清单在 mock 场景自动剔除「更新入口」那步（`UpdateEntry` 的 `v-if` 不成立）。写死 6 的用例会在任何一次「锚点暂时不可见」时假红。
3. 逐步（`Enter` 推进）断言：
   - 洞必须反查到某个 `data-onboarding` 锚点（否则等于圈了片空白）；
   - 锚点沿祖先链可见（`opacity ≥ 0.9`）——**这条就是 §3.4 那个坑的探针**；
   - 洞完整在窗内、且把锚点四边包住（锚点是外扩 6px 再兜最小尺寸挖进去的）；
   - 洞 ≥ 76×30（最小尺寸兜底成立）；
   - 卡片完整在窗内、且**不与自己的洞相交**（压住洞 = 把讲解对象盖掉）。
4. 五步锚点序列必须等于 `treelist → codeentry → newsession → terminal → settings`（教学顺序即产品口径，顺序变了要有意识地改这条）。
5. 末步主按钮文案「开始使用」，点击后 `.ob-root` 计数归 0 且 `seen=1`。

### ONB-E2E-003 · Esc 跳过即落盘，reload 不再自动开；关于页按钮能重看

覆盖 AC-OB-011~013。

1. `Esc` → `.ob-root` 消失、`seen=1`、`<html>` 上的 `ob-tour-active` 摘掉（强制显形不能留在页面上）。
2. `reload` → 1.2s 内 `.ob-root` 计数仍为 0（幂等）。
3. 侧栏「设置」→「关于」Tab → 点「开始指引」→ 蒙层重新出现，圆点仍是 5、计数 `1/5`。这条专门钉住那个坑：工具条是 `v-if="activeView !== 'settings'"`，重看入口若不同时关掉设置视图，「新建会话」「终端」两步会被静默剔除，用户看到的就是「重看少两步」。

### ONB-E2E-004 · 零项目新装：第 2 步退到「暂无项目」空态并换配套文案

覆盖 AC-OB-019~021。夹具与 001 同源，额外在 `addInitScript` 里把 `forge-mock-projects` / `forge-mock-sessions` 写成 `[]`，复刻真实全新装（新装首启必然还没有项目）。

1. `[data-onboarding="codeentry"]` 计数为 0，`.tree-empty` 文案是「暂无项目」——先证明主锚点真的不在位，退路才有意义。
2. 圆点仍是 **5** 个（这一步没被剪掉）。早期版本这里是 4 个，用户点名要讲的功能在最该讲的人群里反而不讲。
3. 逐步骤几何断言同 001（洞在窗内、卡片在窗内、卡片不压自己的洞、被高亮内容可见）。
4. 锚点清单等于 `['treelist','codeentry-empty','newsession','terminal','settings']`，且第 2 步标题是「浏览目录要先有项目」——钉住「备用锚点和配套文案必须成对换」，只换锚点会对着还没有的图标讲「点这个 <> 图标」。

## 红探针记录（改动前必红）

| 探针 | 做法 | 结果 |
|---|---|---|
| 强制显形 | 把 `html.ob-tour-active .tree-project .tree-node-actions { opacity: 1 }` 那一档的 selector 改废 | ONB-E2E-001 在第 2 步失败：`第 2 步（codeentry）被高亮控件在蒙层下不可见` |
| 零项目退路 | 把步骤表里的 `alt` 删掉 | ONB-E2E-004 圆点数 4 ≠ 5，且第 2 步报 `洞没圈住任何锚点` |
| 逐步骤几何 | 视口收窄到 531×620（浏览器 mock 手工跑） | 第 1 步卡片落到洞上（兜底路径），证明窄窗必须靠真机目测而不是靠用例断言 |

## 跑法

```bash
cd packages/forge-ui
FORGE_DEV_SERVER_ORIGIN=http://localhost:51731 npx playwright test e2e/onboarding.spec.ts --reporter=list
```

（`FORGE_DEV_SERVER_ORIGIN` 必须给，否则 `main.ts` 不注入 mock-bridge，`startupFlags` 走真桥。）

## 实拍（视觉档位，非断言）

`node prototypes/_shot-onboarding.mjs` → `prototypes/onboarding-shots/`：1280×800 下 `{light,dark}-step-{1..5}.png`（zh 有项目）、`dark-en-step-*`（en 有项目）、`{light-empty,dark-en-empty}-step-*`（零项目退路），各配一张 `-about.png`。脚本同时打印每步「洞尺寸 / 卡片高 / 卡片底边」——改一句文案就要回来看这张表，en 第 2 步主文案 225px 是六步里的最长项。用于人工比对压暗档位与长文案下的卡片高度。
