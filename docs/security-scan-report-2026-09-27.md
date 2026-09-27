# forge 项目安全扫描报告

- 扫描日期：2026-09-27
- 扫描范围：`packages/*`（forge-core / forge-desktop / forge-ui / forge-extensions）、`scripts/`、依赖树（npm workspaces 全量）
- 扫描项：依赖漏洞、敏感信息泄露、Electron 安全配置、危险代码模式、XSS 防线

---

## 总体结论

| 维度 | 结论 | 评级 |
| --- | --- | --- |
| 依赖漏洞 | 16 个（1 critical / 14 high / 1 moderate），集中在构建链 | ⚠️ 需处理 |
| 敏感信息泄露 | 未发现真实凭据泄露 | ✅ 通过 |
| Electron 安全配置 | 安全清单关键项全部落实 | ✅ 优秀 |
| 危险代码模式 | 无 eval / 无 shell 拼接，IPC 校验完善 | ✅ 优秀 |
| XSS 防线 | 白名单 sanitize + 多层沙箱，体系完整 | ✅ 优秀 |

---

## 一、依赖漏洞（npm audit）：16 个

### 1.1 按影响面排序（需关注程度从高到低）

**① electron 本体（high，影响运行时）**
- GHSA-r4w5-6pfg-jxp5：`ProtocolResponse.url` 复用默认 session 缓存而非注册 session
- GHSA-9f4c-93c8-jc8g：沙箱 iframe 可经 OpenURL 导航路径绕过 `allow-popups` 限制
- 修复：`npm audit fix` 即可（非 breaking），建议尽快执行

**② electron-builder 依赖链（critical + high，仅影响构建期）**
- `tar <=7.5.20`（**critical**）：11 个公告，含硬链接/符号链接路径穿越导致任意文件创建/覆盖、PAX 解析 DoS 等
- `app-builder-lib <=26.14.0`（high）：electron-updater 构建的 AppImage 存在不可控搜索路径（GHSA-7g7r-gx96-252g）
- `builder-util-runtime <9.7.0`（high）：electron-updater 跨域重定向泄露 `PRIVATE-TOKEN` 与混合大小写 `Authorization` 凭据（GHSA-p2f4-r6v6-j797）
- `extract-zip`（high）：symlink 归档条目任意文件写（两条 GHSA）
- 修复：需 `electron-builder@26.15.3`（**breaking**），建议单独开分支升级验证

**③ esbuild / vite（moderate，仅影响开发模式）**
- GHSA-67mh-4wv8-2f99：任意网站可向 dev server 发请求并读取响应
- 仅 `npm run dev` 时暴露本机端口；生产构建不受影响
- 修复：需 `vite@8.3.1`（**breaking**），可与 vite 升级路线合并处理

### 1.2 修复建议

```bash
# 第一步（立即可做，非 breaking）：修复 electron 本体 + extract-zip
npm audit fix

# 第二步（breaking，单独分支验证）：修复 tar / app-builder-lib / builder-util-runtime
npm audit fix --force   # 将 electron-builder 升至 26.15.3

# 第三步（breaking，规划处理）：vite 6 → 8，消除 esbuild dev server 风险
```

> 缓解说明：tar / app-builder-lib 属构建工具链，需攻击者投毒构建输入才可利用，运行时面不暴露；electron 本体两条 high 建议优先修复。

### 1.3 对终端用户的影响评估

**结论：均不影响用户日常使用——以上是潜在攻击面，不是功能缺陷。**

- electron 本体两条 high 在 forge 架构下利用路径均不成立：
  - GHSA-r4w5-6pfg-jxp5 需应用注册自定义协议（`protocol.handle` / `ProtocolResponse`）才触发，forge-desktop 源码零命中；
  - GHSA-9f4c-93c8-jc8g 需沙箱 iframe 带 allow-popups，forge 的 canvas iframe 为 `sandbox=""` 全关，且主进程 `setWindowOpenHandler` 全 deny 双兜底。
- tar / app-builder-lib / extract-zip 只存在于开发/打包机，用户安装的成品不携带这些代码。
- builder-util-runtime 凭据泄露（GHSA-p2f4-r6v6-j797）虽因私有 GitHub feed（`private: true`）有实际载体，但带 token 的请求只发生在发版机/CI；普通用户机器无 `GH_TOKEN` 环境变量，electron-updater 无凭据可带。
- esbuild/vite 仅影响 `npm run dev` 的开发环境。

修复的价值在于纵深防御（未来新增自定义协议等功能时不踩坑）与保护维护者构建环境，非紧急救火。

---

## 二、敏感信息泄露：未发现

- 全源码扫描 `apiKey / secret / token / password / Authorization Bearer` 硬编码模式：**全部命中为测试 mock**（`sk-secret-123`、`AKIAIOSFODNN7EXAMPLE`（AWS 文档示例值）、`ghp_Aaaa…` 等），分布在 5 个测试文件中，属正常测试夹具
- 无 `BEGIN PRIVATE KEY` 真实私钥（`attachments.test.ts` 中的私钥串是 SECRET_PATTERNS 检测功能的测试样例）
- git 跟踪文件中无 `.env` / `.pem` / `.key` / `.p12` / `*secret*`
- `.gitignore` 覆盖了日志、临时目录、打包产物

---

## 三、Electron 安全配置：优秀（`packages/forge-desktop/src/main.ts`）

| 检查项 | 状态 | 位置 |
| --- | --- | --- |
| `contextIsolation: true` | ✅ | main.ts:354 |
| `nodeIntegration: false` | ✅ | main.ts:355 |
| `sandbox: false` | ⚠️ 见下注 | main.ts:356 |
| `setWindowOpenHandler` → 全部 deny | ✅ | main.ts:410 |
| `will-navigate` 导航白名单（dev 限 dev server 同源；prod 限 index.html 本体） | ✅ | main.ts:411-421 |
| `openExternal` 仅放行 http/https/mailto | ✅ | main.ts:502-512 |
| 保存对话框 defaultPath 取 basename 防路径穿越 | ✅ | main.ts:516-517 |
| dev 模式 `FORGE_DEV_SERVER_ORIGIN` origin 强校验 | ✅ | main.ts:422-427 |

> ⚠️ `sandbox: false`：渲染进程关闭沙箱后 preload 可用完整 Node 能力。由于 contextIsolation 已开 + 导航守卫已封死外部页面加载路径，实际风险可控；如未来 preload 依赖可缩减，建议评估开启 sandbox。

---

## 四、危险代码模式：良好

- **无** `eval( / new Function( / dangerouslySetInnerHTML`（src 全量扫描零命中）
- **child_process**：全部使用 `execFile`（数组传参，不经 shell 拼接）——`gitService.ts` 注释明确「数组传入 execFile（绝不拼接 shell）」；`spawnSync` 均带 `timeout` 且 Windows 下 `windowsHide: true`
- **IPC handler 输入校验**：抽查的 `shell:openExternal`（协议白名单）、`dialog:saveFile`（basename 清洗）均做了类型与内容双重校验

---

## 五、XSS 防线（v-html 出口审计）

forge-ui 共 9 处 `v-html`，逐出口确认防护到位：

| 出口 | 数据源 | 防护 |
| --- | --- | --- |
| MessageCard / SubagentResultView / AskUserQuestionPanel | `renderMarkdown()` | marked + **sanitize-html 白名单**（forge-core/src/markdown/renderMarkdown.ts）：禁 script/style/iframe/on* 事件属性；`allowedSchemes` 仅 http/https/mailto；非白名单链接整体降级为 `<span>`；class 仅放行 `hljs-*`/`md-*` 前缀（防属性投毒） |
| DiffView | highlight.js 高亮输出 | hljs 输出转义安全，且经上述白名单二次过滤 |
| MermaidBlock | mermaid 图表 | `securityLevel: 'strict'`（MermaidBlock.vue:49） |
| HtmlCanvasBlock | 模型生成的完整 HTML | `iframe sandbox=""` 全关：不给 allow-scripts、不给 allow-same-origin（HtmlCanvasBlock.vue:227/240） |
| TodoPanel | pi 工具结果 | `escapeHtml` 显式转义 subject / activeForm |
| ConversationHistoryPopover | — | 明确注释「绝不 v-html」，用纯文本插值 |

此外 `markdownLinks.ts` 对所有 v-html 出口统一拦截链接点击，非 http/https/mailto 链接在渲染层已「死链不成形」。

---

## 六、行动清单（按优先级）

1. **P1**：执行 `npm audit fix` 修复 electron 本体两条 high（GHSA-r4w5-6pfg-jxp5、GHSA-9f4c-93c8-jc8g）
2. **P2**：升级 electron-builder@26.15.3（修 critical 的 tar 链），breaking，需回归打包发布流程
3. **P2**：评估升级 vite@8（修 esbuild dev server 风险），breaking，仅影响开发环境
4. **P3**：条件允许时评估开启渲染进程 `sandbox`（当前有 contextIsolation + 导航守卫兜底，非紧迫）
5. **持续**：关注 electron 官方安全公告，及时跟进后续版本

---

*扫描方法：npm audit（依赖树全量）+ Grep 模式扫描（凭据/私钥/危险 API/v-html）+ 人工复核关键文件（main.ts / preload.ts / renderMarkdown.ts / HtmlCanvasBlock.vue 等）。*

---

# 附录：外部 AI 审计报告核实（2026-09-27 第二轮）

对另一份 AI 审计报告逐项源码核实。**总评：质量很高，绝大多数属实**，此前首轮扫描未覆盖信任链路与密钥链路，两份互补。

## 核实结果

### 高危

| # | 声明 | 结论 | 关键证据 |
| --- | --- | --- | --- |
| 1 | 信任门禁未接入 pi，恶意项目可主进程 RCE | ✅ **完全属实（最严重）** | `SettingsManager.create` 两参调用共 4 处（createPiAgentSessionFactory.ts:198/:304、shellProbe.ts:40/:65）；pi settings-manager.js:169 缺省 `projectTrusted ?? true`，resource-loader / package-manager 的信任门全依赖它 → 恒开；main.ts:789 启动无条件取最近项目预热，且预热在 boot 门闩前（早于任何信任询问）；预热经 jiti 编译执行项目扩展（注释自述）；pi 无自定义协议/iframe popups 面已堵，此条是当前唯一真实 RCE 链入口 |
| 2 | apiKey 明文存储 + 明文回传渲染层 | ✅ **属实** | modelService.ts:385-431 明文直写 models.json，:393-403 把 keychain 存量 `$ENV`/`!cmd` 引用**主动迁移为明文**（瓦解 SafeStorage/DPAPI）；keychainAdapter.ts:108/:121 解密明文常驻 process.env（全部子进程继承，piRuntime execFile 无 env 白名单）；rpc/modelMethods.ts:89 toSafeProvider 原样透传 apiKey 进渲染层，**与文件头 TD-MP-01「绝不明文/引用泄漏」硬约束直接矛盾** |
| 3 | shell.openPath 无校验 | ✅ 属实 | main.ts:496-499 仅查非空字符串；注释 (:500) 自己承认「这条通道绝不能转交 openPath」但 IPC_SHELL_OPEN_PATH 本身就是无校验 openPath |
| 4 | 发布链无签名 | ✅ 属实（已知 v1 决策） | electron-builder.yml:29「v1 不做代码签名」、:65 `identity: null`（注释记录了 mac 自动更新不可用等后果）；FORGE_GH_OWNER/REPO env 可覆盖 feed 属实（main.ts:691-704），但 env 只有本机控制权可设，渲染层不可达 |
| 5 | 首启静默 npm 预装 --no-approve | ✅ 属实 | startupUpdate.ts:128；缓解：清单为代码内置推荐列表（非用户/项目可控），攻击面是 registry 投毒；版本未固定（装 latest）属实 |

### 中危

| 声明 | 结论 | 备注 |
| --- | --- | --- |
| 全程无 CSP | ✅ 属实 | index.html 无 meta CSP，主进程无 onHeadersReceived；配合 sandbox:false，XSS 绕过 sanitize 即得完整 IPC 桥，确无第二道防线 |
| IPC_FILE_WRITE_TEXT 任意路径写 .html | ✅ 属实 | main.ts:533-544；注释「路径由用户在对话框里挑」的威胁模型不成立——IPC 可直传任意路径 |
| readImage 全盘读 / listProjectFiles 枚举任意目录 | ✅ 属实 | main.ts:585-594 |
| subagent/queryOutput agentId 路径遍历 | ✅ 属实 | createForgeCore.ts:607 + subagentOutput.ts:43，agentId 来自渲染层 RPC 未校验直拼 `${agentId}.output`；缓解：后缀固定 .output 且需 sessionId 在 store 内，威胁有限 |
| skillService 写路径不受信 | ⚠️ 部分属实 | mkdir+write 限定 `<projectPath>/.agents/skills/SKILL.md` 固定子路径，非任意写；但 projectPath 确实未校验注册/信任（删除操作反而有 containment + realpath 复验，写入没有） |
| http 端点携带 Bearer key | ⚠️ 半属实 | baseUrl 允许 http:// 属实（modelService.ts:244）；**commitMessageService.ts:129 引用不存在**（该文件无 HTTP header 代码，疑幻觉） |

### 低危

- InstructionInput.vue localStorage 持久输入历史 ✅ 属实
- gitService.ts:387 日志回显提交信息前 60 字符 ✅ 属实（无害级）
- FORGE_BOOT_FRAME_DUMP 截图落盘 ✅ 存在，但为 opt-in 主进程 env（渲染层不可控），实际几乎无风险
- models.json 无文件权限设置：合理推断（未逐行验证；Windows 下 chmod 意义有限）

## 修复方案（按优先级）

**P0-A 信任门禁接入执行链**（改动小、收益最大）：
1. `createPiAgentSessionFactory.ts` 工厂 (:198) 与预热 (:304)：经 `ProjectTrustStore.getDecision(cwd)` 取决策，`SettingsManager.create(cwd, dir, { projectTrusted: decision === true })`（pi 第三参已确认支持）；决策 null（未决）按 false 保守处理
2. main.ts 预热：未信任（decision !== true）的 warmCwd 跳过预热
3. shellProbe.ts 两处同步修改
4. 单测：未信任 cwd 断言 `settingsManager.isProjectTrusted() === false`；信任后资源加载恢复

**P0-B openPath 收紧**：`fs.statSync(p).isDirectory()` 校验后才放行（该 IPC 语义就是"打开项目所在目录"，目录限定即可挡掉 .exe/.bat/.lnk）

**P1-C apiKey 链路整改**（涉及 UI 回显行为变化，需产品确认）：
1. 删除 modelService.ts:393-403「引用迁移为明文」逻辑
2. saveProvider 有 keychain 能力时走 storeKey 落 `$VAR` 引用
3. toSafeProvider 改掩码回显（`sk-***abcd`）；明文回显走独立 RPC 且仅用户明确操作时解密
4. （后续）pi 子进程 env 注入按引用收窄，替代全量 process.env

**P1-D 纵深补防线**：
1. meta CSP（保守起步）：`default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'`，img/style 按现有需求放行（data: blob: / 'unsafe-inline'）；dev 模式需补 vite HMR ws:
2. queryOutput agentId 加 `/^[A-Za-z0-9_-]+$/` 白名单
3. IPC_FILE_WRITE_TEXT 主进程记住最近一次 save dialog 结果，写入路径必须与之相等

**P2**：skillService 写前校验 projectPath 已注册且已信任；预装清单固定版本号；http baseUrl 配置时 UI 明文告警；models.json 权限（Windows 收益有限）。
