# forge 改动项清单

> 跟踪所有已确认/待办的修改，防止遗漏。来源：forge 立项 + 文档审核 + skill 评审讨论。
> 状态：待办 / 进行中 / 已完成。更新规则：改动落地后更新状态与日期。

---

## 一、gen-doc-test-cases skill 加强（全局，跨项目）

> 落点：`C:\Users\Admin\.pi\agent\skills\gen-doc-test-cases\SKILL.md` + `references\test-design-contract.md`
> 状态：**已完成**（2026-08-08 已落进两份文件，校验通过）

| # | 改动点 | 落点 |
|---|---|---|
| C1 | 扩张触发客观化（命中即展开，替代"按需"主观判断） | contract §D |
| C2 | 深度门禁（前置数据/操作步骤/断言三要素，复杂用例禁一行空壳） | contract §C |
| C3 | 必测场景定义 + 矩阵"必测"标记列 + index 可审计覆盖率 | contract §E |
| C4 | P0+manual 澄清（P0 断言 100% 自动覆盖，manual 仅补充） | contract §F |
| C5 | 前端一眼可见维度（页面健康/视觉布局完整性/状态渲染/明显内容 + 加载冒烟基线） | contract §A/B1 + §G 断言 + §H |
| C6 | 后端一眼可见维度（后端健康/集成完整性/契约完整性/并发隔离/资源生命周期/持久化完整性） | contract §A/B2 |
| C7 | SKILL.md 对应改动（执行步加一眼可见评估；第4步改客观触发；门禁加深度/必测/P0-manual；边界不整体标不适用） | SKILL.md |

**目标**：AI 按矩阵生成并跑完测试后，打开页面/调用接口不再有一眼可见的低级问题；深层复杂问题仍归人。

---

## 二、CI 自动跑（skill 生态缺口，**待决策**）

> 状态：**待确认**（未建改动项，待用户拍板）。

- 目标：测试"每次提交自动跑"，而非"想起来才跑"。
- 方案：GitHub Actions / git hook——每次提交跑 unit+smoke；release 跑 full e2e + visual + release gate；门禁不过不让合。
- 引擎：调用 test-e2e / test-unit / test-ui 相关流程。
- 若确认，登记为独立改动项并细化。

---

## 三、forge 测试矩阵改进（当前 forge 文档，**待办**）

| # | 改动点 | 状态 |
|---|---|---|
| F1 | `test/index.md` 修两个自洽缺口：必测场景口径 + “P0 断言 100% 自动覆盖，manual 仅补充” | 已完成 |
| F2 | PRD 02 补多窗口 AC（AC-SM-017~020：8 区吸附/4 窗格/resize/崩溃恢复），矩阵跟进 | 已完成 |
| F3 | 展开 `test/02_session/e2e.md`（多窗口交互细化，按新 skill 三要素） | 已完成 |
| F4 | 展开 03/04/05：`03 e2e.md`（流式 mock 时序/XSS）、`04 e2e.md`（Diff fixtures/大文件）、`05 api.md`（keychain mock/models.json 断言） | 已完成 |
| F5 | 补 pi 事件→CanonicalEvent 映射集成测试设计（`test/integration/pi-core.md` PIC-001，真实集成非全 mock） | 已完成 |
| F6 | 多 AgentSession 真实并发集成用例（`pi-core.md` PIC-003，非 mock，呼应 demo 已验证 2 并发） | 已完成 |

---

## 四、forge 文档已完成修正（参照，防止遗漏=已完成不再遗漏）

| # | 改动点 | 状态 |
|---|---|---|
| D1 | artifacts.json 补 db/api 声明 + per-artifact 状态（prd=approved/其余=draft） | 已完成 |
| D2 | DB schema/README：路径表述改"forge-desktop 传入" + 补并发选型理由（单写者→JSON 安全） | 已完成 |
| D3 | API 01：openProject 同步返回 1005 为主路径，trustRequested 事件预留 | 已完成 |
| D4 | PRD 01/05/02 次要修正（信任拦截 user/global 扩展、keychain 命令、跨项目枚举） | 已完成 |
| D5 | 传输架构决策4：forge-core 传输无关接口 + 桌面 IPC / headless HTTP（堵本地攻击面） | 已完成 |
| D6 | 会议室概念存档（`plan/meeting-room-concept.md`）+ demo 验证 | 已完成 |
| D7 | docs 初始化 + PRD 01-05 + DB/API/测试设计生成 + 审核 | 已完成 |

---

## 优先级建议

1. **skill 加强（一）**：影响所有项目质量，且是本轮讨论核心 —— 建议优先落地 C1-C7。
2. **forge 测试矩阵（三）**：F1（自洽缺口）简单先做；F2/F3（02 多窗口）补覆盖；F5（pi 映射）是后端最大盲区，建议做。
3. **CI（二）**：待你拍板是否建独立改动项。