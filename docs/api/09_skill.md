# 09 Skill 管理接口

> 模块：设置页「Skills」分区后端（docs/prd/09_skill_management.md）。
> 实现位置：`packages/forge-desktop/src/pi/skillService.ts`（纯 TS，Electron 能力经 deps 端口注入），方法表在 `createForgeCore.ts` 合并进 RPC methodTable。
> 状态：已实现（单测 15 例覆盖 AC-09-01/02/05/06/07/08/09/11/12；回收站端口 = `shell.trashItem`）。

## 0. 业务对象与口径

- **skill**：pi 生态的 `SKILL.md` 目录（frontmatter `name`/`description` + 指令正文）。
- **枚举口径（TD-SK-01）**："UI 看到的" == "agent 实际加载的"。列表复用 pi `DefaultResourceLoader`
  （与斜杠命令 CV-S08 同款轻量化装配：`noExtensions/noThemes/noContextFiles`），
  loader 结果只含同名冲突**生效方**（loser 以 `collision` 诊断出现，first-wins，project-auto 先于 user-auto）。
- **四个发现根**（pi `package-manager.js` 自动发现口径）：
  | 根 | 作用域 |
  |---|---|
  | `<agentDir>/skills`（forge 解析：`USERPROFILE ?? HOME ?? cwd` 下 `.pi/agent`） | user |
  | `~/.agents/skills` | user |
  | `<project>/.pi/skills` | project |
  | `<project>/.agents/skills` | project |
- **写入目标固定（TD-SK-05）**：user → `<agentDir>/skills`；project → `<project>/.agents/skills`（不写 `.pi/`）。
- **安全边界（PRD §1.3 / AC-09-11）**：所有写/删路径 normalize 后必须是某根的**直接子目录**；
  realpath 复核父目录 == 根（防符号链接穿越）；符号链接条目本身必须指向 4 根之内。越界一律 1001。
  win32 路径比较大小写不敏感。
- **零重载（TD-SK-06）**：写操作不通知、不重载进行中的会话；下次 `listSkills`/斜杠命令查询/新会话自然生效。

## 1. skill/listSkills

枚举当前生效 skill + 诊断。**参数**：

```json
{ "projectPath": "D:/work/xxx" }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| projectPath | string | 否 | 当前项目；缺省 = 未打开项目（仅用户两根） |

成功响应 `data`：

```json
{
  "cwd": "D:/work/xxx",
  "skills": [
    {
      "name": "pdf-report",
      "description": "生成 PDF 周报",
      "scope": "user",
      "dirPath": "C:/Users/x/.pi/agent/skills/pdf-report",
      "filePath": "C:/Users/x/.pi/agent/skills/pdf-report/SKILL.md",
      "disableModelInvocation": false
    }
  ],
  "issues": [
    { "type": "collision", "message": "…", "path": "…", "winnerPath": "…", "loserPath": "…" }
  ]
}
```

| 字段 | 说明 |
|---|---|
| skills[].scope | pi `sourceInfo.scope` 原样映射；非 user/project（temporary/package 等）归 `'other'` 兜底展示 |
| skills[].dirPath | SKILL.md 所在目录绝对路径（真实根路径徽标数据源） |
| issues[].type | `warning`=非法或未加载，`collision`=同名被覆盖未生效，`error` 预留 |
| issues[].winnerPath/loserPath | 仅 collision 有值（其余为 null） |

诊断来源两路（AC-09-02 不静默吞）：
1. loader `getSkills().diagnostics` 原样映射；
2. **影子扫描**：pi 对缺 SKILL.md / frontmatter 非法的目录**静默跳过**，本模块对 4 根直接子项补扫，
   凡未被任一已加载 skill 覆盖的目录/根级 `.md` 以 warning 上报（`.` 前缀与 `node_modules` 豁免；同路径去重）。

loader 装配失败 → `5000`（`枚举 skill 失败: …`）。

## 2. skill/importSkill

导入本地 skill 文件夹（整目录复制）。**参数**：

```json
{ "scope": "user", "sourceDir": "D:/dl/my-skill", "projectPath": "…", "overwrite": false }
```

流程与校验（顺序即短路顺序）：

| 步骤 | 失败响应 |
|---|---|
| scope/sourceDir 非空字符串 | 1001 `参数错误：scope/sourceDir 必须为非空字符串` |
| project 作用域需 projectPath | 1001 `参数错误：项目作用域需要已打开项目（projectPath）` |
| sourceDir 存在 | 1002 `源目录不存在: …` |
| sourceDir 是目录 | 1001 `参数错误：sourceDir 必须是目录` |
| 自我复制守卫：源不在目标根内 | 1001 `拒绝导入：源目录与目标 skills 根相同或位于其内` |
| SKILL.md 有效性（复用 pi `loadSkillsFromDir`，AC-09-05） | 1001 `拒绝导入：<pi 诊断或"目录中未找到有效 SKILL.md（需含非空 description）">` |
| 目标名安全（basename 落在根直接子级） | 1001 `拒绝导入：目标目录名不安全` |
| **同名冲突且未确认** | **4090**，`data: { conflictPath, sourceDir }`（UI 弹确认后带 `overwrite:true` 重调，TD-SK-03） |

落位原子性：`cpSync` 到根内临时目录 `.forge-import-<base36>-<rand>` → `renameSync` 到目标；
overwrite 时旧目录**先移入回收站**（见 §4 trashed 语义）再导新。任何一步失败清理临时目录并 5000，不留半个 skill。

成功响应 `data`：`{ "path": "<dest>", "overwritten": true|false }`。

## 3. skill/createSkill

按标准模板新建（AC-09-08/09）。**参数**：

```json
{ "scope": "project", "name": "my-skill", "description": "…", "body": "…", "projectPath": "…", "overwrite": false }
```

| 校验 | 失败响应 |
|---|---|
| scope/name 非空 | 1001 `参数错误：scope/name 必须为非空字符串` |
| 名称 `^[a-z0-9][a-z0-9-]*$` 且 ≤64 | 1001 `名称不合法：仅小写字母/数字/连字符，以字母或数字开头，不超过 64 字符` |
| description 非空 | 1001 `描述不能为空` |
| project 作用域需 projectPath | 1001（同 §2） |
| 同名冲突未确认 | **4090**，`data: { conflictPath }` |

生成文件 `<targetRoot>/<name>/SKILL.md`，frontmatter 值用 JSON 双引号标量（YAML 兼容，description 含冒号/引号安全）；
`body` 缺省为 `TODO: 编写 <name> 的操作指引`。创建后 `loadSkillsFromDir` **回读验证**，
pi 不识别 → 5000 `已创建但 pi 未识别该 skill：<原因>（目录保留：<dest>）`。

成功响应 `data`：`{ "path": "<dest>", "name": "<pi 回读名>" }`。

## 4. skill/deleteSkill

删除（移入回收站优先，TD-SK-04）。**参数**：

```json
{ "path": "C:/Users/x/.pi/agent/skills/old-skill", "projectPath": "…" }
```

| 步骤 | 失败响应 |
|---|---|
| path 非空字符串 | 1001 |
| containment 复验（§0 安全边界） | 1001 `安全拒绝：目标不是 skills 根目录的直接子目录` / `路径校验失败：父目录经符号链接重定向，拒绝删除` / `路径校验失败：目标为指向根外的符号链接，拒绝删除` |
| 必须是目录 | 1001 `参数错误：只能删除 skill 目录` |
| 必须存在 | 1002 `skill 目录不存在（可能已被外部删除），请刷新列表` |

删除动作：`shell.trashItem`（main.ts 注入）→ 成功 `trashed:true`；端口缺失或抛错 → console.warn 后
`fs.rmSync(recursive)` 永久删除并如实回报 `trashed:false`（UI 用 info 级 toast 区分）。
**只删 skill 目录整体，不接受根路径本身**（containment 的直接子目录约束兜底）。

成功响应 `data`：`{ "path": "<resolved>", "trashed": true|false }`。

## 5. 错误码汇总（本模块）

| code | 语义 |
|---|---|
| 0 | 成功 |
| 1001 | 参数错误 / 安全拒绝（containment、自我复制、非法名） |
| 1002 | 资源不存在（源目录、待删目录） |
| 4090 | 同名冲突**待用户确认**（正常分支，非异常）；`data.conflictPath` 供 UI 展示，确认后带 `overwrite:true` 重调 |
| 5000 | 内部/IO 失败（loader 装配、复制、磁盘写入、回读验证） |

## 6. UI 侧约定（forge-ui）

- 组件：`packages/forge-ui/src/components/SkillsSection.vue`，挂在设置页「关于」Tab 版本更新分区下方（PRD §3.4）。
- 4090 是需弹确认的正常分支，`call()` 的抛错语义不适用 → `bridge.ts` 提供 `invokeRaw<T>()` 原样返回信封。
- 目录选择复用既有 `window.forge.dialog.selectDirectory()`（desktop 零新增 dialog 端口）；
  路径徽标点击跳转复用 `window.forge.shell.openPath()`。
- 浏览器 dev 预览：`mock-bridge.ts` 内存实现四方法（含 4090/overwrite 与 trashed 协议）。
