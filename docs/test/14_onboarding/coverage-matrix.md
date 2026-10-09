# 首次使用指引蒙层覆盖矩阵

> 模块：14 首次使用指引蒙层（新装首启自动指引 + 关于页重看）
> 来源：PRD 14（docs/prd/14_first_run_onboarding.md）
> 状态：已确认（2026-10-09 随代码交付）
> 层级映射：unit=`resolveStartupFlags` 纯函数判定；E2E=真实 DOM 锚点上的洞/卡片几何与出口（mock-backend）；manual=真机 Electron 首启（安装包装完后第一次打开）与暗色档位目测

---

## 风险维度适用性

| 风险维度 | 是否适用 | 原因 | 覆盖要求 |
|---|---|---|---|
| 正常流程 | 适用 | 新装首启自动开蒙层 → 六步逐个走 → 「开始使用」收尾 | P0 |
| 字段边界 | 适用 | 锚点矩形小于最小洞（18×18 / 50×19）；锚点缺失（零项目、无更新入口）；窄窗无落位空间 | P0 |
| 权限角色 | 不适用 | 单用户本地应用，指引不涉及权限 | - |
| 状态流转 | 适用 | `visible` 开关 → seen 落盘 → reload 不再自动开 → 关于页重看再开 | P0 |
| 异常失败 | 适用 | `startup-flags` 桥不可用（浏览器 mock/旧 preload）时不弹也不留空蒙层；清单为空立即散场 | P0 |
| 数据一致性 | 适用 | 「新装」判定必须在 `lastRunForgeVersion` 被回写之前快照，否则与升级路径混淆 | P0 |
| 幂等重复 | 适用 | seen 落盘后任何入口不再自动弹；同一进程内重复 `autoStart` 不叠加 | P0 |
| 前端反馈 | 适用 | 洞跟随锚点移动、卡片随文案实测高度重定位、被高亮控件在蒙层下必须可见 | P0 |
| 页面健康（B3） | 适用 | 走完六步无 console error/pageerror | P0 |
| 契约完整性（B2） | 适用 | `forge:startup-flags` 返回 `{ isFreshInstall, isUpgradeRun }` 两字段 | P0 |
| 存量回归 | 适用 | 不能让全部既有 e2e 被自动弹出的蒙层挡住（mock 默认报非新装） | P0 |

---

## 覆盖基线

| AC ID | PRD 功能点 | 风险维度 | 场景 | 优先级 | 必测 | Unit ID | API ID | E2E ID | 核心断言 | 备注 |
|---|---|---|---|---|---|---|---|---|---|---|
| AC-OB-001 | §3.2 | 数据一致性 | `lastRunForgeVersion=null` → 新装首启 | P0 | 是 | U-SF-001 | - | - | `isFreshInstall=true`、`isUpgradeRun=false` | `test/startupFlags.test.ts` |
| AC-OB-002 | §3.2 | 数据一致性 | 旧版本 → 升级首启 | P0 | 是 | U-SF-002 | - | - | 两个标志都按口径 | 同上 |
| AC-OB-003 | §3.2 | 幂等 | 版本相等 → 平运行 | P0 | 是 | U-SF-003 | - | - | 两个标志皆 false | 同上 |
| AC-OB-004 | §3.2 | 边界 | 回滚装（stored 比当前新） | P1 | 是 | U-SF-004 | - | - | 判为升级首启 | 同上 |
| AC-OB-005 | §3.2 | 边界 | stored 为空串 | P1 | 是 | U-SF-005 | - | - | 判为升级首启（不当新装） | 同上 |
| AC-OB-006 | §2 | 正常流程 | 新装首启自动开蒙层 | P0 | 是 | - | - | ONB-E2E-001 | `.ob-root` 在蒙层散场前常驻；首步即 `treelist` | 1280×800 |
| AC-OB-007 | §3.3 | 边界 | 锚点缺失自动剔步 | P0 | 是 | - | - | ONB-E2E-001 | mock 无更新入口 → 圆点与实际步数都是 5，不是写死的 6 | 顺序断言 `treelist→codeentry→newsession→terminal→settings` |
| AC-OB-008 | §3.5 | 前端反馈 | 洞包住锚点且不越窗 | P0 | 是 | - | - | ONB-E2E-001 | 逐步比 rect：锚点四边在洞内；洞 ≥ 76×30；洞完整在视口内 | 逐步骤量，不是抽样 |
| AC-OB-009 | §3.5 | 前端反馈 | 卡片不压自己的洞、完整在窗内 | P0 | 是 | - | - | ONB-E2E-001 | 卡片 rect 与洞 rect 不相交；卡片四边在窗内 | 终端那步实测落左侧，走的是候选 2 |
| AC-OB-010 | §3.4 | 前端反馈 | 被高亮控件在蒙层下可见 | P0 | 是 | - | - | ONB-E2E-001 | 锚点沿祖先链 `opacity≥0.9` 且非 `display:none/visibility:hidden` | **红探针已做**：摘掉 `html.ob-tour-active` 那一档 CSS，第 2 步必红 |
| AC-OB-011 | §3.6 | 状态流转 | Esc 跳过即落盘 | P0 | 是 | - | - | ONB-E2E-003 | `.ob-root` 消失、`forge:onboarding:seen:v1=1`、`<html>` 上的 `ob-tour-active` 摘掉 | Esc 在捕获阶段被吞，不外溢 |
| AC-OB-012 | §2 | 幂等 | seen 之后不再自动开 | P0 | 是 | - | - | ONB-E2E-003 | reload 后 1.2s 内 `.ob-root` 计数为 0 | init script 只在首次导航清 seen |
| AC-OB-013 | §2 | 状态流转 | 关于页「重看使用指引」 | P0 | 是 | - | - | ONB-E2E-003 | 点击后设置页关闭、蒙层开、圆点仍是 5、计数 `1/5` | 不先关设置会因工具条 `v-if` 少两步 |
| AC-OB-014 | §2 | 正常流程 | 「开始使用」收尾 | P0 | 是 | - | - | ONB-E2E-001 | 末步主按钮文案为「开始使用」，点击后蒙层散且 seen 落盘 | 与 Esc/点遮罩同出口 |
| AC-OB-015 | §3.2 | 异常失败 | 桥不可用 | P1 | 是 | - | - | manual | 纯浏览器无 `window.forge.startupFlags` 时不弹也不留空蒙层 | `autoStart` 内 try-catch 直接 return |
| AC-OB-016 | §5 | 存量回归 | 既有 e2e 不被蒙层挡 | P0 | 是 | - | - | 全量 e2e | `mock-bridge` 默认 `isFreshInstall:false` | 已由 settings/updater/shortcuts 等邻域用例共跑证明 |
| AC-OB-017 | §6 | 页面健康 | 全程无 console error/pageerror | P0 | 是 | - | - | ONB-E2E-001/003 | `attachHealthGuards` 收尾断言 | 实拍脚本双主题亦零报错 |
| AC-OB-018 | §6 | 前端反馈 | 暗/亮 × 中/英 视觉档位 | P1 | 是 | - | - | manual | 真机 Electron 窗口目测压暗档位、洞边框粗细、英文长文案下卡片不溢出 | 实拍见 `prototypes/onboarding-shots/`；真机待用户跑 |
| AC-OB-019 | §3.3 | 边界 | 零项目新装：主锚点不在位 | P0 | 是 | - | - | ONB-E2E-004 | `[data-onboarding="codeentry"]` 计数 0，`.tree-empty` 是「暂无项目」 | 真实新装首启必然零项目 |
| AC-OB-020 | §3.3 | 正常流程 | 第 2 步退到备用锚点、不剪步 | P0 | 是 | - | - | ONB-E2E-004 | 圆点仍 5 个，锚点清单含 `codeentry-empty`（早期版本这里掉成 4 步） | **红探针已做**：删掉步骤表的 `alt` 即红 |
| AC-OB-021 | §3.3 | 前端反馈 | 备用锚点与配套文案成对换 | P0 | 是 | - | - | ONB-E2E-004 | 第 2 步标题「浏览目录要先有项目」，且与第 1 步标题不同 | 只换锚点不换字 = 对着没有的图标讲「点这个图标」 |

---

## 缺口与备注

- AC-OB-015/018 只能真机或人工观测：前者要构造无桥环境，后者是视觉档位判断，不写成断言避免自证。
- 本模块**没有 API 层用例**：`forge:startup-flags` 是 shell 级通道（与 `forge:boot-state` 同族），不进 forge-core RPC 目录，其契约由 `ipc-contract.ts` 的 `StartupFlags` 类型 + typecheck 保证，行为由 U-SF-001~005 覆盖。
- 洞的跟随动画时序（420ms `--transition-decelerate`）不做断言：无头/隐藏页里 rAF 会停，动画态不可复现；用例统一读内联 `style` 的落位目标值，卡片读 `getBoundingClientRect()`。
