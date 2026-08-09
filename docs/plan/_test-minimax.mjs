// 决定性测试：拦截 fetch，看 minimax 调用到底打到哪个 URL、返回什么状态、有没有 token usage
import { createAgentSession, ModelRuntime, SessionManager, DefaultResourceLoader } from "file:///C:/Users/Admin/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import { homedir } from "node:os";

// 拦截 globalThis.fetch，记录 URL + 状态（不记录 body/key）
const origFetch = globalThis.fetch;
const fetchLog = [];
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : (input?.url || String(input));
  const method = init?.method || "GET";
  const host = (() => { try { return new URL(url).host; } catch { return url; } })();
  fetchLog.push({ method, host, url });
  console.log(`[FETCH] ${method} ${host}`);
  let res;
  try { res = await origFetch(input, init); }
  catch (e) { console.log(`[FETCH] 抛错: ${e.message}`); throw e; }
  console.log(`[FETCH] -> ${res.status} ${res.statusText}`);
  fetchLog[fetchLog.length - 1].status = res.status;
  return res;
};

const rt = await ModelRuntime.create();
const m = rt.getModel("minimax-cn", "MiniMax-M3");
console.log(`\n模型: ${m.provider}/${m.id}  baseUrl=${m.baseUrl}\n`);

const loader = new DefaultResourceLoader({
  cwd: process.cwd(), agentDir: homedir() + "/.pi/agent",
  noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
});
await loader.reload();
const { session } = await createAgentSession({ model: m, modelRuntime: rt, resourceLoader: loader, sessionManager: SessionManager.inMemory(), tools: [] });

let text = "";
const interesting = [];
session.subscribe((e) => {
  if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") text += e.assistantMessageEvent.delta;
  // 找 usage/tokens/cost/error/fallback
  const s = JSON.stringify(e);
  if (/usage|token|cost|error|fallback|model/i.test(s) && e.type !== "message_update") {
    interesting.push(e.type + ": " + s.slice(0, 300));
  }
});

console.log("=== 发送 prompt ===");
try {
  await session.prompt("用中文说一句你好，并告诉我你是什么模型");
  console.log("✅ prompt 完成");
} catch (e) {
  console.log("❌ prompt 抛错:", e.message);
}

console.log("\n=== 产出文本 ===");
console.log(JSON.stringify(text));

console.log("\n=== fetch 调用记录 ===");
for (const f of fetchLog) console.log(`  ${f.method} ${f.host} -> ${f.status ?? "(无响应)"}`);

console.log("\n=== 关键事件(usage/error/fallback/model) ===");
if (interesting.length) interesting.forEach((x) => console.log("  " + x));
else console.log("  (无 usage/token/error/fallback 事件)");

session.dispose();
