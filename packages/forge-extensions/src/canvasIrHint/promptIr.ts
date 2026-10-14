/**
 * 图示 IR 的提示词契约。
 *
 * 与 canvasHint/prompt.ts 的关系（勿混淆）：
 * - prompt.ts 是**现状链路**的契约：教模型怎么写 HTML+CSS
 * - 本文件是**新链路**的契约：让模型改产出 JSON IR，样式与排版全部不管
 *
 * 两段式沿用 prompt.ts 的既有设计（常驻段极短 + 命中出图意图才追加完整契约），
 * 理由与代价见 prompt.ts 文件头，本文件不重复论证。
 *
 * ## v1 → v2：从「手写」改为「派生」（2026-10-12）
 *
 * 改造前本文件手写了 `MAX_NODES = 12`、`KINDS = [...]`、`IR_VERSION = 'forge-ir/1'`
 * ——同一批事实在 `@forge/core` 的校验器里还有一份。两处维护的后果不是「多打几个字」，
 * 而是**加一类图时漏改一处且没有测试报错**：提示词让模型产 `flow`，校验器只认
 * `architecture|sequence`，模型照做即被判错。
 *
 * 更严重的是语义错配：改造前规则 3 写的是 `流程/时序/先后/调用链 → sequence`，
 * 把「流程图」和「时序图」并成一类。用户要流程图，拿到的是时序图——**合规但不符合图的逻辑**，
 * 而校验器永远发现不了（它只看结构）。
 *
 * 现在本文件不再存任何事实，只把 `@forge/core/markdown` 导出的 schema 渲染结果
 * 原样转发。加一类图 = 改 `schemaSpec.ts` 一处，提示词与校验器同时跟上。
 */

/**
 * 围栏语言标记名。与 canvas 的 HTML 围栏区分开，避免模型混淆两种载荷。
 *
 * 从 `@forge/core/markdown` 取，不在此另写一份字面量——否则围栏名对不上时
 * 表现为「卡片静默不出现」，没有报错。
 */
export { IR_FENCE_LANGUAGE } from '@forge/core/markdown';

/** 第一段：常驻偏好。每轮注入，控制在几十 token。派生自 schema。 */
export { IR_STANZA } from '@forge/core/markdown';

/** 第二段：命中出图请求后追加的完整契约。仅本轮生效。派生自 schema。 */
export { IR_SPEC } from '@forge/core/markdown';
