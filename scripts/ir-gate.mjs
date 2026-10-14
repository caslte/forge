#!/usr/bin/env node
/**
 * 阶段 1 真实对话门禁驱动：让**生产会话工厂**跑真实风格的对话，再机械统计首次通过率。
 *
 * ## 为什么不能只靠 `ir:probe`
 *
 * 探针（`scripts/ir-probe.mjs`）直接 import `IR_SPEC` 并裸调模型 API。它量的是
 * 「模型照着契约能不能产出合规 IR」——有价值，但它**绕过了整条注入链路**：
 * `applyIrHint` 的两段式（常驻 stanza + 命中才追加完整契约）、`canvasHint` 的让位、
 * 修复回路的回灌、以及真实的转录落盘格式。这些环节任何一个坏了，探针都看不出来。
 *
 * 本脚本补上这一段：走 `createPiAgentSessionFactory`（**生产代码，未改动**），
 * 于是量到的是「forge 里真实发生的那条链路」。
 *
 * ## 与「真实用户对话」的差别（必须如实说明）
 *
 * 剩下的唯一差别是**谁选 prompt**：这里仍是脚本选，不是人手打。所以它是
 * 「真实链路 + 仿真 prompt」，不是完全的真实对话。选 prompt 这件事只能靠人来消除。
 *
 * ## 隔离
 *
 * agentDir 指向 `tmp/ir-gate/agent`（**不碰**用户真实的 `~/.pi/agent` 与
 * `%APPDATA%/@forge/desktop/agent`），sessions 只落在隔离目录里，便于：
 *   1. 干净分母（不会被历史会话污染）
 *   2. 不污染用户的会话树
 * modelsPath 仍指向真实 `~/.pi/agent/models.json`——凭据要从那里取。
 *
 * ## 判据
 *
 * 通过率**不由本脚本计算**，而是复用生产模块 `extractIrSamples` + `reportSamples`
 * （与 `npm run ir:samples` 同一条判定路径）。否则采样口径与生产分叉，
 * 算出来的数字就不代表线上表现——这正是 `extractIrSamples.ts` 头注强调的事。
 *
 * 用法：
 *   node --experimental-strip-types scripts/ir-gate.mjs                    # 全部
 *   node --experimental-strip-types scripts/ir-gate.mjs --only flow-order  # 单条
 *   node --experimental-strip-types scripts/ir-gate.mjs --no-tools         # 对照：关工具
 *   node --experimental-strip-types scripts/ir-gate.mjs --keep-sessions    # 不清理旧转录
 */

// 开关必须在任何会话创建之前生效。写在这里而非命令行，是为了让「直接 node 跑」也不会
// 静默地量成「IR 关闭」的链路（那会得到 0 条 IR 围栏 + 一个看起来像「模型不听话」的假结论）。
process.env.FORGE_IR_CANVAS = process.env.FORGE_IR_CANVAS ?? '1';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPiAgentSessionFactory } from '../packages/forge-desktop/src/pi/createPiAgentSessionFactory.ts';
import {
  extractIrSamples,
} from '../packages/forge-desktop/src/canvasIrStats/extractIrSamples.ts';
import {
  formatPassRateReport,
  reportSamples,
} from '../packages/forge-desktop/src/canvasIrStats/irPassRate.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * prompt 集。
 *
 * `kind`：`diagram` = 应出图（进通过率分母）；`control` = 不该出图（验证不误报）。
 * `expect`：期望的 diagram_type。**不属于**生产判据（生产只判结构合法），
 *           单列出来是因为「结构合法但画错了图」是最隐蔽的失败模式——探针第一版
 *           的 flow→sequence 就是这样漏掉的。
 *
 * 措辞刻意贴近真实用户：有省略、有口语、有指代（「这个项目」「这套东西」）。
 * 刻意不写成「请输出 diagram_type=flow 的 IR」——那测的是提示词而不是对话。
 */
const PROMPTS = [
  // ---------- 流程图 ----------
  { id: 'flow-order', kind: 'diagram', expect: 'flow',
    text: '画个流程图：收到订单后先校验库存，库存不足就通知用户，库存够就扣减库存并生成发货单。' },
  { id: 'flow-ci', kind: 'diagram', expect: 'flow',
    text: '帮我画一下 CI 的流程：先跑 lint，lint 不过就停下来；过了跑测试，测试失败就回退。' },
  { id: 'flow-approval', kind: 'diagram', expect: 'flow',
    text: '画一张审批流程图。提交申请之后主管审批，主管通过就转财务，主管驳回就打回给申请人重填。' },
  { id: 'flow-cache', kind: 'diagram', expect: 'flow',
    text: '用流程图说明一下缓存的读取逻辑：先查缓存，命中直接返回；没命中就查数据库，查到之后写回缓存再返回。' },
  { id: 'flow-login', kind: 'diagram', expect: 'flow',
    text: '画个登录流程图，包含密码校验、失败次数过多锁定账号这两条分支。' },

  // ---------- 架构图 ----------
  { id: 'arch-modules', kind: 'diagram', expect: 'architecture',
    text: '帮我画一下这个项目的模块组成。' },
  { id: 'arch-layers', kind: 'diagram', expect: 'architecture',
    text: '画一张架构图：数据采集、清洗、特征、训练、服务，分成离线层和在线层两层。' },
  { id: 'arch-pkgs', kind: 'diagram', expect: 'architecture',
    text: '把 forge 的几个 package 的依赖关系画成一张架构图。' },
  { id: 'arch-web', kind: 'diagram', expect: 'architecture',
    text: '画个三层架构图：前端 Vue、主进程 Electron、核心引擎，说明它们的调用关系。' },
  { id: 'arch-storage', kind: 'diagram', expect: 'architecture',
    text: '画架构图：接入层、业务层、存储层，存储层下面挂 MySQL 和 Redis 两个组件。' },

  // ---------- 时序图 ----------
  { id: 'seq-http', kind: 'diagram', expect: 'sequence',
    text: '画个时序图：浏览器发起请求，网关转发到订单服务，订单服务查数据库后返回。' },
  { id: 'seq-pay', kind: 'diagram', expect: 'sequence',
    text: '时序图：用户下单，订单服务调支付服务，支付成功后支付服务回调订单服务，订单服务再通知物流。' },
  { id: 'seq-chain', kind: 'diagram', expect: 'sequence',
    text: '用图讲一下一次对话从用户输入到模型返回的完整链路。' },
  { id: 'seq-cache', kind: 'diagram', expect: 'sequence',
    text: '画时序图：客户端 → 网关 → 服务 A → 缓存，缓存未命中再走服务 A 到数据库这一路。' },
  { id: 'seq-deploy', kind: 'diagram', expect: 'sequence',
    text: '画个时序图说明发布流程：开发者提交代码，CI 构建镜像，推送到仓库，运维从仓库拉取并部署。' },

  // ---------- 树 / 思维导图 ----------
  { id: 'tree-repo', kind: 'diagram', expect: 'tree',
    text: '帮我梳理一下这个仓库的目录结构。' },
  { id: 'tree-taxonomy', kind: 'diagram', expect: 'tree',
    text: '把 IR 校验的错误码按类别整理成一张树。' },
  { id: 'tree-mindmap', kind: 'diagram', expect: 'tree',
    text: '画一张思维导图，主题是「如何提升模型出图的首次通过率」。' },
  { id: 'tree-plan', kind: 'diagram', expect: 'tree',
    text: '画个思维导图，梳理一下这个项目接下来的工作计划。' },
  { id: 'tree-skills', kind: 'diagram', expect: 'tree',
    text: '把「一个前端工程师需要掌握的知识」画成一张树形图。' },

  // ---------- 对照：不该出图 ----------
  { id: 'ctl-tests', kind: 'control',
    text: '这个项目的测试怎么跑？' },
  { id: 'ctl-repair', kind: 'control',
    text: '解释一下 canvasIrRepairExtension 是干什么的。' },
  { id: 'ctl-changelog', kind: 'control',
    text: '总结一下 docs/changelog.md 最近几条改了什么。' },
  { id: 'ctl-tsc', kind: 'control',
    text: '类型检查怎么跑？我想在提交前跑一遍。' },
  { id: 'ctl-vague', kind: 'control',
    text: '这个链路有点绕，能不能讲清楚一点。' },
  { id: 'ctl-code', kind: 'control',
    text: 'extractIrSamples 这个函数是怎么判断「首次产出」的？' },
];

function parseArgs(argv) {
  const o = {
    out: 'tmp/ir-gate',
    only: undefined,
    model: 'MiniMax-M3',
    perPromptTimeoutMs: 240_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.out = argv[++i];
    else if (a === '--only') o.only = argv[++i];
    else if (a === '--model') o.model = argv[++i];
    else if (a === '--timeout') o.perPromptTimeoutMs = Number(argv[++i]) * 1000;
    else if (a === '-h' || a === '--help') o.help = true;
    else { console.error('未知参数：' + a); o.help = true; }
  }
  return o;
}

const HELP = `阶段 1 真实对话门禁 —— 走生产会话工厂跑对话，再机械统计首次通过率

  --only <substr>     只跑 id 含该子串的 prompt
  --model <id>        模型 id（默认 MiniMax-M3，取自 models.json 的 mx provider）
  --out <dir>         产物根目录（默认 tmp/ir-gate），本轮落在 <out>/run-<时间戳>
  --timeout <sec>     单条 prompt 上限（默认 240）

每次运行写进独立的 run-<时间戳> 目录，故没有「清空旧会话」的开关——
干净分母由目录唯一性保证，不靠删除。

注：**没有** --no-tools。生产工厂（createPiAgentSessionFactory）只把
cwd/model/thinkingLevel 转发给 createAgentSession，不转发 noTools ⇒
加一个关不掉工具的旗子只会让人误以为做了对照。
`;

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log(HELP);
  process.exit(0);
}

const picked = PROMPTS.filter((p) => !opts.only || p.id.includes(opts.only));
if (picked.length === 0) {
  console.error(`没有匹配 "${opts.only}" 的 prompt`);
  process.exit(2);
}

const outDir = path.resolve(opts.out);
// 每次运行一个独立目录（带时间戳），而不是「清空旧目录再跑」。
// 两个理由：
//   1. 干净分母——上一轮的转录绝不会混进这一轮。
//   2. 本机沙箱把 fs.rmSync 拦成「移到回收站」并会超时（safe-delete shim），
//      与其依赖删除，不如让目录天然唯一。
// 代价是 tmp 下会攒目录，但它们本来就在 tmp 里，且可回溯对账。
const runId = process.env.FORGE_GATE_RUN ?? new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const runDir = path.join(outDir, 'run-' + runId);
const agentDir = path.join(runDir, 'agent');
const cwd = REPO_ROOT;
const sessionDir = path.join(agentDir, 'sessions', encodeURIComponent(cwd));
const modelsPath = path.join(os.homedir(), '.pi', 'agent', 'models.json');

fs.mkdirSync(sessionDir, { recursive: true });

if (!fs.existsSync(modelsPath)) {
  console.error(`找不到 models.json：${modelsPath}`);
  process.exit(2);
}

// 把凭据**复制**（不是链接）进隔离 agentDir。
//
// 为什么必须做：`createAgentSession` 自己按 `agentDir` 组一个 ModelRuntime
// （见 sdk.d.ts：`Defaults to a runtime using agentDir/auth.json and models.json`），
// **不看**工厂那个 `modelsPath`——后者只用于把模型字符串解析成 Model 对象。
// 隔离目录里没有这两份文件时，模型能解析成功、发请求却报
// 「No API key found for mx」：解析与鉴权走的是两条不同的配置来源。
const piAgentDir = path.join(os.homedir(), '.pi', 'agent');
for (const f of ['models.json', 'auth.json']) {
  const src = path.join(piAgentDir, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(agentDir, f));
}

const factory = createPiAgentSessionFactory({
  agentDir,
  modelsPath,
  // 隔离目录里没有 trust.json，缺省判定为「未信任」⇒ 不加载项目资源。
  // 本脚本要的正是这个：只留内置扩展，把用户自装的扩展从变量里剔掉。
  // 显式传 true 反而会去 jiti 编译仓库里的 .pi 扩展，引入无关变量。
  projectTrustedFor: () => false,
});

const toolNote = 'on（read/bash/edit/write，pi 默认）';
console.log(`门禁驱动：model=${opts.model}  tools=on（read/bash/edit/write，pi 默认）  prompts=${picked.length}`);
console.log(`本轮目录=${runDir}`);
console.log(`agentDir（隔离）=${agentDir}`);
console.log(`cwd=${cwd}`);
console.log(`契约来源=生产扩展 canvasIrHintExtension（FORGE_IR_CANVAS=${process.env.FORGE_IR_CANVAS}）`);
console.log('');

/**
 * 给单条 prompt 建一个**全新会话**——保证每个样本都是真正的「首次产出」，无上下文串味。
 *
 * 返回值里的 `assistantMsgs` 是关键：转录里**一条助手消息都没有**意味着这次模型调用
 * 根本没产出内容（网络/额度/服务端空回复），那是**量具故障**，不是「模型选择不画图」。
 * 不区分这两者会让分母被静默缩小，算出来的通过率偏乐观——与探针第一版
 * `max_tokens` 烧光额度却被计成契约失败，是同一类错误的反面。
 */
async function runOne(p) {
  const sessionId = p.id.replace(/[^A-Za-z0-9_-]/g, '-');
  const lease = await factory({ cwd, model: opts.model, sessionId });
  const sessionFile = lease.handle.sessionFile;
  const t0 = Date.now();
  let timedOut = false;
  let error;
  try {
    await Promise.race([
      lease.session.prompt(p.text),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error('TIMEOUT')), opts.perPromptTimeoutMs).unref?.(),
      ),
    ]);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    timedOut = error === 'TIMEOUT';
    if (timedOut) {
      try { await lease.session.abort(); } catch { /* 已结束 */ }
    }
  } finally {
    try { lease.dispose(); } catch { /* 忽略 */ }
  }

  // 落盘统计（dispose 之后文件已定型）
  let assistantMsgs = 0;
  let chars = 0;
  try {
    const raw = fs.readFileSync(sessionFile, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim() === '') continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.type !== 'message' || e.message?.role !== 'assistant') continue;
      assistantMsgs++;
      const c = e.message.content;
      chars += typeof c === 'string' ? c.length
        : Array.isArray(c) ? c.reduce((n, x) => n + (typeof x?.text === 'string' ? x.text.length : 0), 0)
        : 0;
    }
  } catch { /* 文件没写出来也按 0 处理 */ }

  return { id: p.id, ms: Date.now() - t0, timedOut, error, assistantMsgs, chars };
}

const results = [];
for (const [i, p] of picked.entries()) {
  const tag = `[${String(i + 1).padStart(2, '0')}/${picked.length}] ${p.id}`;
  process.stdout.write(`${tag} … `);
  const r = await runOne(p);
  results.push(r);
  const flag = r.error
    ? (r.timedOut ? '超时' : '错误: ' + r.error)
    : r.assistantMsgs === 0
      ? '⚠ 空回复（量具故障，非契约结论）'
      : 'ok';
  console.log(`${flag}  ${(r.ms / 1000).toFixed(0)}s`);
}

fs.writeFileSync(
  path.join(runDir, 'run.json'),
  JSON.stringify({ model: opts.model, cwd, results }, null, 2),
  'utf8',
);

// ---------------------------------------------------------------------------
// 判定：完全复用生产链路，不在这里另写一套
// ---------------------------------------------------------------------------
const report = extractIrSamples([agentDir], { idPrefix: 'gate' });
console.log('');
console.log('='.repeat(72));
console.log('采样通道（生产模块 extractIrSamples）');
console.log('='.repeat(72));
console.log(`转录文件：${report.files.length} 个`);
console.log(`含 canvas-ir 围栏的文件：${report.files.length - report.filesWithoutIr.length} 个`);
console.log(`无 IR 围栏的文件：${report.filesWithoutIr.length} 个`);
if (report.skippedRepairs > 0) console.log(`跳过的修复轮：${report.skippedRepairs} 条（首轮口径）`);
console.log('');

if (report.samples.length === 0) {
  console.error('一条 IR 样本都没有 —— 链路根本没产出 IR。先查注入是否生效，而不是判契约。');
  process.exit(3);
}

console.log(formatPassRateReport(reportSamples(report.samples)));

// 量具故障单列。空回复（模型一条助手消息都没产出）**不能**算作契约结论——
// 它既不是「产出合规 IR」也不是「产出违规 IR」，把它混进「无 IR 围栏」那一栏
// 会让分母静默缩小、通过率偏乐观。单列出来才能对账。
const instrumentFailures = results.filter((r) => !r.error && r.assistantMsgs === 0);
const errored = results.filter((r) => r.error);
console.log('');
console.log('量具状态（不参与契约判定，但必须可见）');
if (instrumentFailures.length === 0 && errored.length === 0) {
  console.log(`  全部 ${results.length} 条都拿到了模型回复 ✓`);
} else {
  for (const r of errored) console.log(`  ✗ ${r.id}：${r.timedOut ? '超时' : r.error}`);
  for (const r of instrumentFailures) console.log(`  ✗ ${r.id}：空回复（0 条助手消息）——量具故障，非契约结论`);
  console.log(
    `  合计 ${errored.length + instrumentFailures.length} 条无效；有效样本 = 分母里的 ${report.samples.length} 条`,
  );
}

// 逐样本明细：把「哪条挂了、为什么」摊开
console.log('');
console.log('='.repeat(72));
console.log('逐样本明细');
console.log('='.repeat(72));
const judged = reportSamples(report.samples);

// 样本 id 的形态：`<idPrefix>-<转录文件名主体>:<消息 id>[#n]`。
// 转录文件名主体 = `forge-<我们的 sessionId>`（piSessionPaths 加的 forge- 前缀），
// 而我们的 sessionId 就是 prompt id。所以要同时剥掉 `gate-` 与 `forge-` 两层，
// 否则 byId 查不到 → expect 显示成 `?`、类型符合性检查空转成「全部一致」。
function sampleToPromptId(sampleId) {
  return sampleId.replace(/^gate-/, '').replace(/^forge-/, '').replace(/:.*$/, '');
}

const byId = new Map(picked.map((p) => [p.id, p]));
for (const s of judged.perSample) {
  const id = sampleToPromptId(s.sample.id);
  const p = byId.get(id);
  const expect = p?.expect ?? (p?.kind === 'control' ? '(对照)' : '?');
  const verdict = s.judgement.verdict === 'ok' ? 'ok  ' : 'FAIL';
  const codes = s.judgement.diagnostics.map((d) => d.code).join(',') || '-';
  console.log(`  ${verdict} ${String(id).padEnd(16)} expect=${String(expect).padEnd(13)} ${s.judgement.verdict === 'ok' ? '' : codes}`);
}

// 下面两项检查**只统计本轮真正跑过的 prompt**。
// 早先的写法拿 PROMPTS 全量当分母，于是只跑 1 条时也会打印
// 「对照 6 条全部未产出 IR ✓」——空转的检查比没有检查更坏，它给出虚假的安心。
const pickedIds = new Set(picked.map((p) => p.id));
const ranControlIds = PROMPTS
  .filter((p) => p.kind === 'control' && pickedIds.has(p.id))
  .map((p) => p.id);
const producedIds = new Set(report.samples.map((s) => sampleToPromptId(s.id)));
const falsePositives = ranControlIds.filter((id) => producedIds.has(id));
console.log('');
if (ranControlIds.length === 0) {
  console.log('误报检查：本轮没跑对照 prompt，**未检查**（不计入通过）。');
} else {
  console.log(
    falsePositives.length === 0
      ? `误报检查：对照 prompt ${ranControlIds.length} 条，全部未产出 IR ✓`
      : `误报检查：以下对照 prompt 竟然产出了 IR ✗ → ${falsePositives.join(', ')}`,
  );
}

// 类型符合性（生产判据之外的单列项）
const ranDiagram = PROMPTS.filter(
  (p) => p.kind === 'diagram' && p.expect && pickedIds.has(p.id),
);
const mismatch = [];
for (const p of ranDiagram) {
  const s = report.samples.find((x) => sampleToPromptId(x.id) === p.id);
  if (!s) continue; // 没产出 IR 的样本，通过率那一栏已经报过，这里不重复
  const m = /"diagram_type"\s*:\s*"([a-z]+)"/.exec(s.source);
  const got = m ? m[1] : '(无)';
  if (got !== p.expect) mismatch.push(`${p.id}: 期望 ${p.expect}，实际 ${got}`);
}
if (ranDiagram.length === 0) {
  console.log('类型符合性：本轮没跑出图 prompt，**未检查**。');
} else {
  console.log(
    mismatch.length === 0
      ? `类型符合性：${ranDiagram.length} 条出图 prompt 全部与预期一致 ✓`
      : `类型符合性（结构合法但语义可能不对）：\n  - ${mismatch.join('\n  - ')}`,
  );
}
console.log('');
console.log('产物：' + path.join(runDir, 'run.json'));
console.log('复核命令：npm run ir:samples -- --sessions "' + agentDir + '"');
