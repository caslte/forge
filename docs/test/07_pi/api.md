# 版本更新（pi 运行时）api 设计

> 模块：07 版本更新（设置页）
> 来源：`coverage-matrix.md` + PRD 07
> 状态：已确认
> 触发：更新器子进程（ELECTRON_RUN_AS_NODE）在 unit 层不可真跑（会真实更新共享扩展），
> 失败/成功信封经依赖注入验证（TD-PI-05）；真实更新链路属手工验收（执行一次 `pi update --extensions` 等价行为）。

---

## 通用断言（每条必含）

- 合法输入：响应结构对、错误码对、成功须有数据落地（清单/输出）。
- 非法/异常输入：返回约定错误码，不崩、不吞错。
- 无未捕获异常 / 无静默失败（降级路径除外，降级需有据）。

---

## A-PI-002 更新组件信封（成功/失败）

- **关联 AC**：AC-PI-006/007 | **优先级**：P0 | **自动化等级**：unit（注入 mock 更新器）
- **前置**：createForgeCore + deps.piUpdateExtensions / deps.piAgentDir 指向临时目录
- **请求**：`pi/updatePlugins`（无参）
- **预期**：
  - 更新器 ok=true → code 0，data.output 透传
  - 更新器 ok=false → code 6002，message「组件更新失败」，data.output 附输出尾部
- **断言点**：信封结构、6002 不被吞、不触发真实子进程
- **落地**：见 forge-desktop/test/pi/piRuntime.test.ts

## E-PI-001~003 设置页交互（mock-backend）

- **关联 AC**：AC-PI-001/002/003/005/006 | **优先级**：P0 | **自动化等级**：mock-backend
- **位置**：forge-ui/e2e/settings.spec.ts「版本更新」3 用例
- **断言点**：版本与清单渲染、未安装态、更新成功 toast+刷新、失败内联错误与输出尾部、空态
