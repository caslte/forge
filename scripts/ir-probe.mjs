#!/usr/bin/env node
/**
 * IR 契约探针：真实模型 + 生产契约 → 首次通过率 + 可视化。
 *
 * 为什么需要它：阶段 1 的门禁是「真实对话首次通过率 ≥80%」，但改一版契约就要等
 * 真实用户跑 20 轮，反馈周期太长，无法支撑「调优提示词」这种需要快速迭代的工作。
 * 探针把这一步变成秒级：**契约直接从 promptIr.ts import**，所以它测的永远是当前
 * 生产契约，不会出现「探针测的是另一份提示词」这种漂移。
 *
 * 与真实用户对话的区别（必须清楚，别混为一谈）：
 * - 探针 = **契约一致性测试**：真实模型 + 真实契约 + 我选的 prompt。
 *   它能回答「模型能不能照着契约产出合规 IR」，不能替代 P0 的真实使用门禁。
 * - 样本来自真实模型（MiniMax），不是本项目手写 IR —— 这一点没有违反
 *   「禁止自造样本」的纪律（那条禁的是「自己扮演模型」）。
 *
 * 工具保真：契约里最脆弱的一条是「不要把图写到文件/用工具出图」。真实 forge 里模型
 * 是有工具的，光给提示词不给工具会高估通过率。故默认**声明真实工具**：模型若调工具
 * 而不是在回复里写围栏，记为失败（理由 `used-tool`），这正是线上会发生的失败。
 *
 * 用法：
 *   npm run ir:probe                      # 全量 prompt，每类各跑一遍
 *   npm run ir:probe -- --n 2             # 每个 prompt 跑 2 次
 *   npm run ir:probe -- --only 架构        # 只跑名字含「架构」的 prompt
 *   npm run ir:probe -- --render          # 额外生成可视化画廊 tmp/ir-probe/gallery.html
 *   npm run ir:probe -- --no-tools        # 不声明工具（对照用）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { judgeIr, parseIr, compileIrToSvg, IR_HOST_CSS_VARS } from '@forge/core/markdown';
import { IR_STANZA, IR_SPEC } from '../packages/forge-extensions/src/canvasIrHint/promptIr.ts';

/* ============================ 参数 ============================ */

function parseArgs(argv) {
  const o = { n: 1, only: undefined, render: false, tools: true, provider: 'mx', model: undefined, out: 'tmp/ir-probe', maxTokens: 16384, replay: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--n') o.n = Math.max(1, Number(argv[++i]) || 1);
    else if (a === '--only') o.only = argv[++i];
    else if (a === '--render') o.render = true;
    else if (a === '--replay') { o.replay = argv[++i]; o.render = true; }
    else if (a === '--no-tools') o.tools = false;
    else if (a === '--provider') o.provider = argv[++i];
    else if (a === '--model') o.model = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--max-tokens') o.maxTokens = Math.max(256, Number(argv[++i]) || 16384);
    else if (a === '-h' || a === '--help') o.help = true;
    else { console.error('未知参数：' + a); o.help = true; }
  }
  return o;
}

const HELP = `IR 契约探针 —— 真实模型 + 生产契约，出首次通过率与可视化

  --n <k>            每个 prompt 重复 k 次（默认 1）
  --only <substr>    只跑名字含该子串的 prompt
  --render           生成可视化画廊 <out>/gallery.html
  --replay <file>    不回模型，直接拿已有的 results.json 重出画廊（隐含 --render）
  --no-tools         不声明工具（对照：看「用工具出图」这类失败有多少）
  --provider <id>    模型 provider（默认 mx）
  --model <id>       覆盖模型 id
  --out <dir>        产物目录（默认 tmp/ir-probe）
  --max-tokens <n>   单次回复上限（默认 16384）

关于 --max-tokens：MiniMax 的思维链算进 completion_tokens。首版探针用 4096，
结果 4/17 个样本把整个额度烧在思考上、正文为空——那不是契约失败，是**量具坏了**。
这类样本现在单独记为 truncated，并在算通过率时剔除。

关于 --replay：产物 SVG 是纯函数（IR → SVG），改渲染器后想再看一眼观感，
不该再烧一遍模型额度。--replay 就是为这个场景准备的：从 results.json 重放，
只跑「解析 → 编译 → 拼画廊」。
`;

/* ============================ 被测 prompt ============================ */

/**
 * 覆盖四类图，每类 3~5 个 prompt。
 *
 * ## 每个 prompt 必须**自包含**（2026-10-12 修正）
 *
 * 首版有几条写成「这个项目的模块组成」「这个仓库的目录结构」「这个功能的设计要点」——
 * 而探针没有仓库上下文，于是模型合理地先去 run_command 看一眼，或者反问「哪个功能？」。
 * 那测的是**提示词的歧义**，不是 IR 契约。实测代价：v2 首轮 17 条里 3 条栽在这上面，
 * 把通过率从 82% 压到 76%。
 *
 * 规则：主语必须写死在 prompt 里，让模型没有任何理由去调工具或反问。
 *
 * ## flow 那一组是刻意保留的对照组
 *
 * v1 契约的规则 3 把「流程」硬塞进 sequence（原文 `流程/时序/先后/调用链 → sequence`）。
 * 首轮实测：4 条 flow prompt 里 3 条产出了**时序图**——合规、但不是用户要的图。
 * 这组 prompt 就是用来量那个硬套的代价的，改契约时不要动它们。
 */
const PROMPTS = [
  { id: 'arch-forge', want: 'architecture', text: '画一下 forge 的分层架构' },
  { id: 'arch-modules', want: 'architecture', text: '梳理一下一个 Electron 桌面应用的模块组成，用图表示' },
  { id: 'arch-processes', want: 'architecture', text: '展示一下浏览器进程、渲染进程、主进程之间的组成关系' },
  { id: 'arch-deploy', want: 'architecture', text: '画一张部署架构图，说明网关、服务、数据库的位置' },
  { id: 'arch-frontend', want: 'architecture', text: '用图说明一下前端项目的目录分层' },

  { id: 'seq-login', want: 'sequence', text: '画一下登录的时序图' },
  { id: 'seq-http', want: 'sequence', text: '说明一下一次 HTTP 请求从发出到响应的完整过程' },
  { id: 'seq-toolcall', want: 'sequence', text: '展示一下工具调用的调用链' },
  { id: 'seq-payment', want: 'sequence', text: '画一下支付回调的时序' },
  { id: 'seq-handshake', want: 'sequence', text: '说明 TCP 三次握手的过程' },

  { id: 'flow-order', want: 'flow', text: '画一下用户下单的流程' },
  { id: 'flow-ci', want: 'flow', text: '展示一下 CI 的构建步骤流程' },
  { id: 'flow-branch', want: 'flow', text: '画一个数据处理流程图，包含判断分支和失败重试' },
  { id: 'flow-approval', want: 'flow', text: '画一下报销审批的流程，有通过和不通过两条路' },

  { id: 'tree-repo', want: 'tree', text: '用树状图展示一个 npm monorepo 的典型目录结构' },
  { id: 'tree-mindmap', want: 'tree', text: '画一个思维导图梳理「离线优先同步」这个功能的设计要点' },
  { id: 'tree-taxonomy', want: 'tree', text: '用层级图展示一下错误码的分类' },
];

/* ============================ 环境 ============================ */

function loadProvider(id) {
  const cfgPath = path.join(os.homedir(), '.pi', 'agent', 'models.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const p = cfg.providers?.[id];
  if (!p) throw new Error(`models.json 里没有 provider "${id}"（可选：${Object.keys(cfg.providers ?? {}).join(', ')}）`);
  if (!p.apiKey) throw new Error(`provider "${id}" 缺 apiKey`);
  return p;
}

/** 基座系统提示：forge 是「带工具的桌面编码助手」，这里保持最小但角色正确。 */
const BASE_SYSTEM = [
  'You are forge, a desktop AI assistant for software engineering tasks.',
  'You have tools available and may call them when they are the right way to do the job.',
  'Answer in the same language the user wrote in.',
].join('\n');

/** 工具声明：契约明确禁止「用工具出图」，所以必须让工具真实可用，否则测不出这条。 */
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file on disk.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a shell command and return its output.',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    },
  },
];

/** 与 forge 一致：`<think>…</think>` 包裹的思维链不算正文。 */
function stripThinking(s) {
  return String(s ?? '').replace(/<think[\s\S]*?<\/think>/gi, '').trim();
}

/* ============================ 单次调用 ============================ */

async function askOnce({ provider, model, prompt, useTools, maxTokens }) {
  const body = {
    model,
    messages: [
      { role: 'system', content: `${BASE_SYSTEM}\n\n${IR_STANZA}\n\n${IR_SPEC.join('\n')}` },
      { role: 'user', content: prompt },
    ],
    max_tokens: maxTokens,
  };
  if (useTools) body.tools = TOOLS;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 120000);
  try {
    const res = await fetch(provider.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await res.text();
    if (!res.ok) return { error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    const json = JSON.parse(text);
    const choice = json.choices?.[0] ?? {};
    const msg = choice.message ?? {};
    return {
      content: stripThinking(msg.content),
      // 思维链可能落在 content 的 <think> 里（M3.1），也可能落在 reasoning_content（M3）。
      // 两者都留着，便于区分「模型没写」与「模型全用在思考上」。
      reasoning: String(msg.reasoning_content ?? '').length,
      finishReason: choice.finish_reason,
      toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls.map((t) => t.function?.name) : [],
      usage: json.usage,
    };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timeout(120s)' : String(e.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

/** 从回复正文里取第一个 canvas-ir 围栏。 */
function firstFence(content) {
  const m = /```canvas-ir[ \t]*\r?\n([\s\S]*?)```/.exec(String(content ?? ''));
  return m ? m[1].trim() : null;
}

/* ============================ 主流程 ============================ */

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log(HELP);
  process.exit(0);
}

/** 重放模式：不回模型，直接拿历史 results.json 重出画廊。 */
function loadReplay(file) {
  const raw = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  // 兼容两种形状：旧的裸数组，和新的自描述信封。
  const env = Array.isArray(raw) ? { results: raw } : raw;
  if (!Array.isArray(env.results)) throw new Error(file + ' 里没有 results 数组');
  return env;
}

let provider = null;
let model = 'replay';
let picked = [];
let results = [];
let total = 0;

if (opts.replay) {
  const env = loadReplay(opts.replay);
  results = env.results;
  opts.provider = env.provider ?? opts.provider;
  model = env.model ?? 'replay';
  opts.tools = env.tools ?? opts.tools;
  console.log(`重放 ${opts.replay}：${results.length} 条（不回模型）`);
  console.log(`原次运行：provider=${opts.provider} model=${model} tools=${opts.tools ? 'on' : 'off'}`);
  console.log('');
} else {
  provider = loadProvider(opts.provider);
  model = opts.model ?? provider.models?.[0]?.id;
  if (!model) throw new Error(`provider "${opts.provider}" 没有可用模型，请用 --model 指定`);

  picked = PROMPTS.filter((p) => !opts.only || p.id.includes(opts.only) || p.text.includes(opts.only));
  if (picked.length === 0) {
    console.error(`没有匹配 "${opts.only}" 的 prompt`);
    process.exit(2);
  }

  console.log(`provider=${opts.provider} model=${model} tools=${opts.tools ? 'on' : 'off'} prompts=${picked.length} × ${opts.n}`);
  console.log('契约来源：packages/forge-extensions/src/canvasIrHint/promptIr.ts（生产契约，直接 import）');
  console.log('');
  total = picked.length * opts.n;
}

let done = 0;

for (const p of opts.replay ? [] : picked) {
  for (let k = 0; k < opts.n; k++) {
    const r = await askOnce({ provider, model, prompt: p.text, useTools: opts.tools, maxTokens: opts.maxTokens });
    done++;

    const rec = { promptId: p.id, want: p.want, prompt: p.text, run: k + 1, ...r };
    const fence = r.error ? null : firstFence(r.content);
    if (r.error) {
      rec.outcome = 'error';
      rec.reason = r.error;
    } else if (!fence && r.finishReason === 'length') {
      // 输出被预算截断：这是**量具问题**不是契约问题，必须单列，
      // 否则会把「思维链烧光额度」误算成「模型不听话」，从而误判契约质量。
      rec.outcome = 'truncated';
      rec.reason = `输出预算 ${opts.maxTokens} 耗尽（finish_reason=length，思维链 ${r.reasoning} 字），正文为空`
        + '；调大 --max-tokens 或换不烧思维链的模型';
    } else if (r.toolCalls.length > 0 && !fence) {
      // 契约最脆弱的一条：模型绕过回复、改用工具出图 —— 用户什么也看不到
      rec.outcome = 'used-tool';
      rec.reason = '调用了工具 ' + r.toolCalls.join(',') + ' 而不是在回复里写围栏';
    } else {
      if (!fence) {
        rec.outcome = 'no-fence';
        rec.reason = '回复里没有 canvas-ir 围栏';
      } else {
        rec.source = fence;
        const j = judgeIr(fence);
        rec.verdict = j.verdict;
        rec.codes = j.diagnostics.map((d) => d.code);
        rec.diag = j.diagnostics.map((d) => `${d.code} ${d.subject} — ${d.evidence}`);
        rec.outcome = j.verdict === 'ok' ? 'pass' : 'invalid-ir';
        if (j.verdict === 'ok') {
          const ir = parseIr(fence);
          if (ir) rec.diagramType = ir.diagram_type;
        }
      }
    }

    results.push(rec);
    const mark = rec.outcome === 'pass' ? 'PASS' : 'FAIL';
    console.log(`[${done}/${total}] ${mark} ${p.id}${opts.n > 1 ? ' #' + (k + 1) : ''}` +
      (rec.outcome === 'pass' ? `  type=${rec.diagramType}` : `  ${rec.outcome}: ${(rec.reason ?? rec.codes?.join(',') ?? '').slice(0, 90)}`));
  }
}

/* ============================ 汇总 ============================ */

const passed = results.filter((r) => r.outcome === 'pass').length;
const byOutcome = {};
for (const r of results) byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
const codeHist = {};
for (const r of results) for (const c of r.codes ?? []) codeHist[c] = (codeHist[c] ?? 0) + 1;

/**
 * truncated 是量具故障，不是契约失败：把它剔除后再算通过率，
 * 否则调大 --max-tokens 会让「通过率」凭空虚高，掩盖真实的契约缺陷。
 */
const valid = results.filter((r) => r.outcome !== 'truncated');
const rate = valid.length ? passed / valid.length : 0;

const typeMismatch = results.filter(
  (r) => r.outcome === 'pass' && r.want !== r.diagramType,
);

console.log('');
console.log('='.repeat(60));
console.log(`首次通过率：${passed}/${valid.length} = ${(rate * 100).toFixed(0)}%   （门槛 80%）`);
if (valid.length !== results.length) {
  console.log(`（另有 ${results.length - valid.length} 个样本因输出截断被剔除，不计入分母）`);
}
console.log('结果分布：' + Object.entries(byOutcome).map(([k, v]) => `${k}=${v}`).join('  '));
if (Object.keys(codeHist).length) {
  console.log('缺陷分布：' + Object.entries(codeHist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join('  '));
}
if (typeMismatch.length) {
  console.log('');
  console.log('⚠️ 图类型与预期不符（合规但语义错）：');
  for (const r of typeMismatch) console.log(`   ${r.promptId}：期望 ${r.want}，实际 ${r.diagramType}`);
}

const outDir = path.resolve(
  // 重放时默认写回「被重放文件所在的目录」，否则会把画廊丢到一个凭空新建的 tmp/ir-probe 里，
  // 和刚看过的那份分家。
  opts.out !== 'tmp/ir-probe' || !opts.replay ? opts.out : path.dirname(path.resolve(opts.replay)),
);
fs.mkdirSync(outDir, { recursive: true });
if (!opts.replay) {
  // 重放模式下 results.json 是**输入**，回写等于把输入覆盖成自己（且丢失原始 provider 信息）。
  const envelope = { provider: opts.provider, model, tools: opts.tools, maxTokens: opts.maxTokens, results };
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(envelope, null, 2), 'utf8');
  console.log('');
  console.log('明细：' + path.join(outDir, 'results.json'));
}

/* ============================ 可视化画廊 ============================ */

if (opts.render) {
  const cards = results
    .map((r) => {
      if (r.outcome !== 'pass') {
        return `<section class="fail"><h3>${r.promptId} <span>${r.outcome}</span></h3>
          <p class="p">${escapeHtml(r.prompt)}</p>
          <pre class="why">${escapeHtml(r.reason ?? (r.codes ?? []).join(', '))}</pre>
          ${r.source ? `<pre class="src">${escapeHtml(r.source)}</pre>` : ''}</section>`;
      }
      let svg = '';
      try {
        const ir = parseIr(r.source);
        svg = ir ? compileIrToSvg(ir) : '';
      } catch (e) {
        svg = `<pre class="why">编译异常：${escapeHtml(String(e.message ?? e))}</pre>`;
      }
      const mismatch = r.want !== r.diagramType;
      return `<section class="ok${mismatch ? ' mismatch' : ''}"><h3>${r.promptId} <span>${r.diagramType}</span>${mismatch ? `<b>期望 ${r.want}</b>` : ''}</h3>
        <p class="p">${escapeHtml(r.prompt)}</p>
        <div class="card">${svg}</div>
        <details><summary>IR</summary><pre class="src">${escapeHtml(r.source)}</pre></details></section>`;
    })
    .join('\n');

  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>IR 探针画廊</title><style>
${IR_HOST_CSS_VARS}
/* 画廊自己的排版变量。注意 --c-* 那套（图表色）必须来自 IR_HOST_CSS_VARS：
   少了它们，SVG 里 var(--c-*) 求值失败 ⇒ fill 回落成黑块、stroke 回落成 none（线消失）。 */
:root{--bg:#fff;--fg:#1c1d20;--muted:#6b7280;--line:#e5e7eb;--ok:#0f6e56;--bad:#b91c1c}
@media(prefers-color-scheme:dark){:root{--bg:#1c1d20;--fg:#e8e9ec;--muted:#9aa0aa;--line:#3a3d44;--ok:#6fce9d;--bad:#e88b85}}
body{margin:0;padding:28px 22px 80px;background:var(--bg);color:var(--fg);
font:14px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
h1{font-size:18px;font-weight:500;margin:0 0 6px}
.sum{color:var(--muted);font-size:13px;margin:0 0 24px}
section{border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:18px}
section.fail{border-color:var(--bad)}
section.mismatch{border-color:#b45309}
h3{font-size:13px;font-weight:500;margin:0 0 4px}
h3 span{color:var(--muted);font-weight:400;font-family:ui-monospace,monospace;font-size:12px}
h3 b{color:#b45309;font-weight:400;font-size:12px;margin-left:8px}
.p{color:var(--muted);font-size:12.5px;margin:0 0 10px}
.card{display:flex;justify-content:center;overflow:auto;padding:8px}
.card svg{max-width:100%;height:auto}
pre{background:rgba(127,127,127,.08);border-radius:8px;padding:10px;font-size:11.5px;
font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow:auto;max-height:300px;color:var(--muted)}
.why{color:var(--bad)}
details{margin-top:8px}summary{font-size:12px;color:var(--muted);cursor:pointer}
</style></head><body>
<h1>IR 契约探针画廊</h1>
<p class="sum">provider=${escapeHtml(opts.provider)} · model=${escapeHtml(model)} · tools=${opts.tools ? 'on' : 'off'} ·
通过率 ${passed}/${results.length} = ${(rate * 100).toFixed(0)}% · ${escapeHtml(new Date().toLocaleString('zh-CN'))}</p>
${cards}
</body></html>`;

  const gallery = path.join(outDir, 'gallery.html');
  fs.writeFileSync(gallery, html, 'utf8');
  console.log('画廊：' + gallery);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
