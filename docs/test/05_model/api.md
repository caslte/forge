# 模型与 Provider 配置 api 设计

> 模块：05 模型与 Provider 配置
> 来源：`coverage-matrix.md` + PRD 05
> 状态：已确认
> 触发：keychain mock、models.json `!command`/`$ENV_VAR` 断言、无 keychain 降级路径复杂，按 contract §D 客观触发展开。

---

## 通用断言（每条必含）

- 合法输入：响应结构对、错误码对、不返回 5xx、成功须有数据落地+副作用（禁"成功但什么都没做"）。
- 非法输入：返回约定错误码，不崩、不吞错。
- 无未捕获异常 / 无静默失败。

---

## A-MP-001 保存 provider 并加载

- **关联 AC**：AC-MP-001/008 | **优先级**：P0 | **自动化等级**：real-backend（写真实 models.json + pi 重载 mock）
- **前置**：无 provider；models.json 可写
- **请求**：`model/saveProvider`，合法配置（type=openai, baseUrl, apiKey, models≥1）
- **预期**：code 0；models.json 写入；pi 重载后新会话可用该 provider
- **断言点**：响应结构对；models.json 内容正确；`pi 重载`后 `getAvailable` 含新 provider
- **数据落地**：models.json 持久化
- **清理**：恢复 models.json 原状

## A-MP-002 密钥不明文（models.json 断言）

- **关联 AC**：AC-MP-002 | **优先级**：P0 | **自动化等级**：unit（keychainStore mock）+ real（models.json 文件断言）
- **前置**：OS keychain mock（`!forge-secret` 可读）
- **请求**：`model/saveProvider`，apiKey=明文输入
- **预期**：code 0；**models.json 中 apiKey 为 `!forge-secret get <provider>` 引用（或 `$ENV_VAR`），非明文**；真实值存 keychain mock
- **断言点**：
  - 写出的 models.json 全文**不含明文 key**（正则扫描）
  - apiKey 字段以 `!command` 或 `$ENV_VAR` 起始
  - keychainMock 存有真实值；`!forge-secret` 能读回
- **负向**：任何路径不得把明文 key 写入 models.json
- **审计/副作用**：无明文落盘

## A-MP-003 非法输入校验

- **关联 AC**：AC-MP-003 | **优先级**：P1 | **自动化等级**：unit + api
- **请求**：非法 baseUrl / 空 apiKey / 空 models
- **预期**：1001 校验错误；不写文件
- **断言点**：错误码对；models.json 无变更；字段标红提示

## A-MP-004 无 keychain 降级

- **关联 AC**：AC-MP-004 | **优先级**：P1 | **自动化等级**：mock（模拟无 keychain）
- **前置**：mock 无 keychain（`!forge-secret` 不可用）
- **请求**：`model/saveProvider`，apiKey=明文
- **预期**：降级提示用环境变量；仍可用 `$ENV_VAR` 引用保存（models.json 为 `$XXX_API_KEY`）
- **断言点**：降级提示正确；保存成功且 models.json 用 env 引用；真实值不落盘
- **负向**：无 keychain 不放明文、不静默失败

## A-MP-005/006 模型选择与覆盖隔离

- **关联 AC**：AC-MP-005/006 | **优先级**：P0 | **自动化等级**：real-backend
- **请求**：`model/setDefaultModel` → `model/setSessionModel`
- **预期**：全局默认新会话生效；会话 1 覆盖仅自身生效，会话 2/全局不变
- **断言点**：各会话 model 解析正确；forge-store 持久化；覆盖隔离无串扰

## A-MP-007 重启保留

- **关联 AC**：AC-MP-007 | **优先级**：P0 | **自动化等级**：real-backend
- **请求**：保存配置后重启 instance
- **预期**：provider 与全局默认仍在
- **断言点**：重启后 `queryConfig` 返回完整配置

---

## 覆盖汇总

| 用例 | AC | 优先级 | 自动化等级 | 触发展开项 |
|---|---|---|---|---|
| A-MP-001 | 001/008 | P0 | real-backend | models.json 内容断言 |
| A-MP-002 | 002 | P0 | unit+real | keychain mock + models.json !command 断言 |
| A-MP-003 | 003 | P1 | unit+api | 非法输入校验 |
| A-MP-004 | 004 | P1 | mock | 无 keychain 降级 |
| A-MP-005/006 | 005/006 | P0 | real-backend | 覆盖隔离 |
| A-MP-007 | 007 | P0 | real-backend | 重启保留 |