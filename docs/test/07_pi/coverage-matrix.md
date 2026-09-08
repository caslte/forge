# 版本更新与安装包（pi 运行时）覆盖矩阵

> 模块：07 版本更新与安装包（设置页 + 安装包/预装/自更新/联动更新）
> 来源：PRD 07（docs/prd/07_installer_update.md）
> 状态：已确认（PU-S01/S02 已实现并验证；IN-S01~04 为待开发部分的测试设计）
> 层级映射：unit=设置解析/版本回读/6002~6005 信封/updater-state 幂等标志/只增不删规则；API=IPC 方法信封与降级；E2E=设置页版本更新分区交互（含自更新提示/下载/安装 UI，mock-backend）；manual=真机安装/真 feed/断网/重启安装（发布前 checklist）

---

## 风险维度适用性

| 风险维度 | 是否适用 | 原因 | 覆盖要求 |
|---|---|---|---|
| 正常流程 | 适用 | 版本展示、更新成功刷新、发现新版→手动更新→确认弹窗→重启安装 | P0 |
| 字段边界 | 适用 | npm: 前缀剥离、实体缺失 version=null、components 快照差值、feed 无新版 | P0 |
| 权限角色 | 适用 | 单用户；per-user 安装免管理员；组件只写用户自身 agent 目录 | P2 |
| 状态流转 | 适用 | busy 态进出、按钮复位、自更新状态机 idle→checking→found→downloading→downloaded→installing | P0 |
| 异常失败 | 适用 | 更新 6002/6003/6004/6005、getInfo 失败降级、settings 损坏、断网、损坏包 | P0 |
| 数据一致性 | 适用 | updater-state 标志与真实状态一致；只增不删；覆盖安装不损坏 userData | P0 |
| 幂等重复 | 适用 | 重复预装/重复联动/重复检查/重复点击更新 | P0 |
| 前端反馈 | 适用 | 成功 toast、失败内联错误与输出尾部、发现新版 toast 一次+分区常驻、下载进度 | P0 |
| 页面健康（B3） | 适用 | 设置页加载冒烟：无 console error/pageerror | P0 |
| 契约完整性（B2） | 适用 | pi/getInfo、pi/updatePlugins、updater/* 响应结构与错误码；updater.stateChanged 白名单登记 | P0 |
| 安装完整性（真机） | 适用 | NSIS per-user 安装/覆盖安装/feed 产物可达——仅真机可验证 | manual |

---

## 覆盖基线

| AC ID | PRD 功能点 | 风险维度 | 场景 | 优先级 | 必测 | Unit ID | API ID | E2E ID | 核心断言 | 备注 |
|---|---|---|---|---|---|---|---|---|---|---|
| AC-PI-001 | PU-S01 | 正常流程 | 版本展示 | P0 | 是 | U-PI-001 | - | E-PI-001 | forgeVersion 渲染 | 已实现；e2e 断言随清单移除调整 |
| AC-PI-002 | PU-S01 | 边界 | 分区不渲染组件清单（负向） | P0 | 是 | - | - | E-PI-001 | 无组件列表/空态元素；明细仅日志与 updater-state | 清单 UI 移除随 dev 调整 |
| AC-PI-004 | PU-S01 | 异常 | getInfo 失败静默降级 | P1 | 否 | - | - | - | 版本「—」不报错 | 降级路径由 call 吞错实现 |
| AC-PI-005 | PU-S02 | 正常流程 | 更新成功 toast+刷新 | P0 | 是 | - | A-PI-002 | E-PI-001 | toast「更新完成」；变更明细入日志 + components 快照；按钮复位 | 已实现 |
| AC-PI-006 | PU-S02 | 异常 | 更新失败 6002 内联展示 | P0 | 是 | A-PI-002（单测） | A-PI-002 | E-PI-002 | 错误框 + 输出尾部；无成功 toast；按钮可点 | 已实现 |
| AC-PI-007 | PU-S02 | 契约 | 信封结构与错误码 | P0 | 是 | U-PI-002 | A-PI-002 | - | 6002+data.output / 成功透传 output | 已实现 |
| AC-PI-008 | PU-S02 | 异常 | settings 缺失/损坏静默降级 | P0 | 是 | U-PI-003 | - | - | plugins=[] 不抛错 | 已实现 |
| AC-IN-001 | IN-F01 | 安装完整性 | 全新机安装可启动、userData 归位 | P0 | 是 | - | - | - | 安装成功；%APPDATA%/forge 生成 | manual（发布前 checklist） |
| AC-IN-002 | IN-F01 | 数据一致性 | 覆盖安装不损坏 userData | P0 | 是 | - | - | - | 会话/模型/项目保留 | manual |
| AC-IN-003 | IN-F01 | 异常 | 无 feed 配置仍可安装运行 | P1 | 是 | - | - | - | 安装运行正常，无报错 | manual |
| AC-IN-004 | IN-F02 | 状态流转 | 首启静默预装、全程无 UI | P0 | 是 | U-IN-001 | - | E-IN-004 | 首启后清单出现推荐插件；无任何提示/toast | unit 真实临时目录 |
| AC-IN-005 | IN-F02 | 数据一致性 | 只增不删：已装不覆盖、缺项补上 | P0 | 是 | U-IN-001 | - | - | 用户自装版本保留；缺失项补齐 | |
| AC-IN-006 | IN-F02 | 幂等 | 预装标志幂等（不重复安装） | P0 | 是 | U-IN-002 | - | - | preinstallDone=true 后再启动不触发 | |
| AC-IN-007 | IN-F02 | 异常 | 预装失败不阻塞启动 | P0 | 是 | U-IN-002 | - | - | 失败静默；标志保持 false 下次重试 | 断网 manual 复核 |
| AC-IN-008 | IN-F03 | 正常流程 | 发现新版提示+分区常驻；无新版无提示 | P0 | 是 | - | A-IN-001 | E-IN-001 | toast 一次；分区常驻新版信息与「更新」按钮；无新版无提示 | mock feed |
| AC-IN-009 | IN-F03 | 状态流转 | 手动点击更新→下载→确认弹窗→重启安装 | P0 | 是 | - | A-IN-002/003 | E-IN-002 | 进度推送；downloaded 后点「重启安装」弹确认框，确认才执行；manual 真机复核 | 重启安装 manual |
| AC-IN-010 | IN-F03 | 异常 | 损坏包校验失败不安装、静默降级 | P0 | 是 | U-IN-003 | A-IN-002 | - | 6004；状态回 idle | |
| AC-IN-011 | IN-F03 | 异常 | 断网/下载失败不打断使用 | P0 | 是 | - | A-IN-001 | E-IN-003 | 6003/6004；无打断性弹窗；可重试 | 断网 manual 复核 |
| AC-IN-012 | IN-F04 | 状态流转 | forge 版本变化→后台静默联动更新组件 | P0 | 是 | U-IN-004 | - | E-IN-004 | 标志不等触发更新；无 UI 提示；成功回写版本 | |
| AC-IN-013 | IN-F04 | 异常 | 版本未变/离线/CLI 缺失跳过或静默 | P0 | 是 | U-IN-004 | - | - | 不触发/静默；不弹提示；不阻塞 | |
| AC-IN-014 | IN-F04 | 数据一致性 | 用户自装插件不删除/降级（只升不降） | P0 | 是 | U-IN-001 | - | - | 联动后用户自装项保留 | |

> 契约完整性（B2）：updater/* 信封与 6003/6004/6005 错误码断言归属 AC-IN-008/009/010/011 的 A-IN-001~003；`updater.stateChanged` 事件登记 FORGE_EVENTS 白名单由既有 `ipcEventContract.test.ts` 静态扫描回归，不单设 AC。
> AC-PI-003（空清单空态）与原 E-PI-003 随组件清单需求移除而作废（PRD 07 编号保留不复用）。

## 发布前 manual checklist（真机，AC-IN-001/002/003/007/009/011）

1. 全新机：双击安装 → 启动 → 项目/会话可用（AC-IN-001）
2. 旧版本有数据 → 覆盖安装新版本 → 数据完整（AC-IN-002）
3. 断网安装/启动/使用全流程无报错（AC-IN-003/007/011）
4. 真实 feed：发布新版 → 旧版收到提示 → 手动更新 → 重启后版本正确、数据完整（AC-IN-009）
5. 首启预装在真实网络下完成且 `~/.pi/agent` 出现推荐清单（AC-IN-004/007 真机复核）

## 用例索引

- Unit（forge-desktop/test/pi/piRuntime.test.ts）：U-PI-001 清单解析+版本回读；U-PI-002 6002/成功信封（注入 mock 更新器）；U-PI-003 settings 缺失/损坏降级（已实现）
- Unit（待开发，updaterState + 预装/联动流程）：U-IN-001 补缺合并只增不删；U-IN-002 preinstallDone 幂等；U-IN-003 自更新信封 6003/6004/6005（注入 mock electron-updater）；U-IN-004 版本标志判定触发/跳过
- E2E mock-backend（forge-ui/e2e/settings.spec.ts，已实现、断言随清单移除调整）：E-PI-001 版本展示+更新成功；E-PI-002 失败内联（E-PI-003 空态作废；调整时补「不渲染组件清单」负向断言）
- E2E mock-backend（forge-ui/e2e/updater.spec.ts，待开发）：E-IN-001 发现新版提示+常驻；E-IN-002 下载进度→确认弹窗→重启安装调用；E-IN-003 检查失败静默；E-IN-004 预装/联动无 UI（断言无提示出现）
- API/integration（待开发）：A-IN-001 checkForUpdates（found/idle/6003）；A-IN-002 downloadUpdate（进度事件/6004）；A-IN-003 quitAndInstall（6005）；事件白名单经 ipcEventContract.test 静态扫描覆盖
- manual：发布前 checklist（见上）
