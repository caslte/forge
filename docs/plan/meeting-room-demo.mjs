/**
 * 会议室 demo（架构 A：编排器 + 对等 AgentSession，非子 agent）
 *
 * 两个模型各自作为独立 AgentSession，对一个文档进行：
 *   Round 1 并行评审 -> Round 2 交叉质询（看对方评审并回应）-> 综合汇总
 *
 * 用法：
 *   cd D:/work/aiwork/forge
 *   node docs/plan/meeting-room-demo.mjs [文档路径]   # 默认 docs/overview.md
 *
 * 模型：minimax-cn/MiniMax-M3（架构师视角）、huoshan/ark-code-latest（产品/工程视角）
 */
import { createAgentSession, ModelRuntime, SessionManager, DefaultResourceLoader } from "file:///C:/Users/Admin/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const PI = "file:///C:/Users/Admin/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
// re-import 已在上面；此处 PI 仅注释用

const docPath = process.argv[2] || "docs/overview.md";
const doc = readFileSync(docPath, "utf8");
const OUT = "docs/plan/meeting-room-demo-output.md";

const log = (...a) => console.log(...a);
const hr = (t) => log("\n" + "═".repeat(70) + `\n${t}\n` + "═".repeat(70));

log(`📄 评审文档: ${docPath} (${doc.length} 字符)`);
const rt = await ModelRuntime.create();

// 两个参与者：不同模型 + 不同视角角色
const participants = [
  { name: "minimax-M3",  model: rt.getModel("minimax-cn", "MiniMax-M3"), role: "资深架构师，关注架构合理性、技术风险、可行性与一致性" },
  { name: "huoshan-ark", model: rt.getModel("huoshan", "ark-code-latest"), role: "资深产品/工程负责人，关注需求完整性、用户体验、落地优先级与边界遗漏" },
];

// 创建独立 AgentSession（每个独立 ResourceLoader + inMemory + 无工具=纯推理评审）
log("🔧 创建 2 个对等 AgentSession…");
const sessions = [];
for (const p of participants) {
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: homedir() + "/.pi/agent",
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPromptOverride: () =>
      `你是${p.role}。你在参加一个多模型评审会议，评审一份项目文档。用中文，直接给结论与具体问题，不要客套、不要复述文档。每个问题给出：问题、为什么是问题、建议。`,
  });
  await loader.reload();
  const { session } = await createAgentSession({
    model: p.model,
    modelRuntime: rt,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    tools: [],
  });
  sessions.push({ ...p, session });
}
log("✅ 2 个会话就绪（独立 ResourceLoader / 事件总线 / inMemory）\n");

// 工具：跑一轮 prompt，流式输出 + 收集全文
async function turn(s, prompt) {
  let text = "";
  s.session.subscribe((e) => {
    if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
      text += e.assistantMessageEvent.delta;
    }
  });
  await s.session.prompt(prompt);
  return text.trim();
}

const transcript = [];
const push = (h, body) => { transcript.push(`## ${h}\n\n${body}\n`); };

// ───────── Round 1：并行评审 ─────────
hr("Round 1 · 并行评审（两个模型各自独立评审文档）");
const r1Prompt = `以下是项目文档：\n\n\`\`\`\n${doc}\n\`\`\`\n\n请从你的专业角度评审，列出关键问题、风险、缺失和改进建议。`;
const r1 = await Promise.all(sessions.map((s) => {
  hr(`【${s.name}】评审中…`);
  return turn(s, r1Prompt).then((t) => { log("\n"); push(`Round1 · ${s.name} 评审`, t); return t; });
}));

// ───────── Round 2：交叉质询（每个看对方的 Round1 评审） ─────────
hr("Round 2 · 交叉质询（每个模型看到对方的评审并回应）");
const r2 = await Promise.all(sessions.map((s, i) => {
  const other = sessions[1 - i];
  const prompt = `另一位评审专家【${other.name}】给出了以下评审意见：\n\n${r1[1 - i]}\n\n请回应：你同意哪些、反对哪些、补充什么？最后给出你的综合判断（这份文档是否可行、最大隐患是什么）。`;
  hr(`【${s.name}】回应对方…`);
  return turn(s, prompt).then((t) => { log("\n"); push(`Round2 · ${s.name} 回应`, t); return t; });
}));

// ───────── 综合（用 minimax 作综合者） ─────────
hr("综合汇总（由 minimax-M3 综合）");
const synthPrompt = `以下是两位专家对同一份项目文档的评审与交叉回应。\n\n### 专家A(minimax-M3) Round1 评审\n${r1[0]}\n\n### 专家A 回应专家B\n${r2[0]}\n\n### 专家B(huoshan-ark) Round1 评审\n${r1[1]}\n\n### 专家B 回应专家A\n${r2[1]}\n\n请综合产出：\n1. 双方共识（都认同的问题/建议）\n2. 双方分歧（各自立场，简述）\n3. 最终建议（优先要改的 Top 3）\n4. 一句话结论：这份文档当前可否推进。`;
const synth = await turn(sessions[0], synthPrompt);
log("\n");
push("综合汇总", synth);

// 收尾
for (const s of sessions) s.session.dispose();

// 写出完整纪要
const header = `# 会议室 demo 纪要\n\n- 评审文档：\`${docPath}\`\n- 参与者：${participants.map(p => `${p.name}（${p.role}）`).join(" / ")}\n- 协议：Round1 并行评审 → Round2 交叉质询 → 综合\n- 时间：${new Date().toISOString()}\n`;
writeFileSync(OUT, header + "\n" + transcript.join("\n"));
hr("完成");
log(`✅ 完整纪要已写入：${OUT}`);
