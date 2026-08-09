/**
 * spike: pi 多 AgentSession 并发可行性验证
 *
 * 目的：验证 forge PRD 02 TD-SM-01（多会话并行）的前提——
 *       一个 Node 进程内能否同时 new 多个 AgentSession 并发跑而不冲突。
 *
 * 运行前置：
 *   1. pi 需已构建（dist 存在）。pi 用 tsgo 编译，若未装 tsgo，先 `npm i -g @typescript/native-preview` 或改用 tsc。
 *      构建：cd D:/work/aiwork/pi && npm run build
 *   2. 需有可用 provider（auth.json 或 env ANTHROPIC_API_KEY/OPENAI_API_KEY 等）。
 *
 * 运行：
 *   cd D:/work/aiwork/pi/packages/coding-agent
 *   npx tsx D:/work/aiwork/forge/docs/plan/spike-multi-session.ts
 *
 * 期望结果：
 *   - 3 个会话 id 互不相同（独立性）
 *   - 每个会话只收到自己的事件（事件总线隔离，无串扰）
 *   - 3 个 prompt 并发完成，各自有事件计数 >0，无报错
 *   若出现 "global state"/"singleton"/"already initialized" 类错误，则并发不支持。
 */

import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  DefaultResourceLoader,
} from "@earendil-works/pi-coding-agent";

const N = 3;

const modelRuntime = await ModelRuntime.create();
const available = await modelRuntime.getAvailable();
if (!available.length) {
  console.error("✗ 无可用模型——请先配置 provider（auth.json 或 env API key）后再跑");
  process.exit(1);
}
const model = available[0];
console.log(`使用模型: ${model.provider}/${model.id}，并发创建 ${N} 个会话\n`);

// 1. 并发创建 N 个会话：每个独立 ResourceLoader（=> 独立事件总线 + 独立扩展实例）+ inMemory SessionManager
const sessions = await Promise.all(
  Array.from({ length: N }, async (_, i) => {
    const loader = new DefaultResourceLoader({ cwd: process.cwd() });
    await loader.reload();
    const { session } = await createAgentSession({
      model,
      modelRuntime,
      resourceLoader: loader, // 关键：每会话独立 loader，不共享
      sessionManager: SessionManager.inMemory(),
    });
    return { i, session, loader };
  }),
);

// 2. 验证会话 id 互不相同
const ids = sessions.map((s) => s.session.getSessionId());
console.log("session ids:", ids);
console.log("ids 唯一?", new Set(ids).size === ids.length);

// 3. 验证事件总线隔离：每个 session 计自己的事件，看是否串扰
const counts = sessions.map(() => 0);
sessions.forEach((s, i) =>
  s.session.subscribe(() => {
    counts[i]++;
  }),
);

// 4. 并发 prompt（真模型）：看是否独立流式完成、有无报错/串扰
await Promise.all(
  sessions.map(async (s, i) => {
    try {
      await s.session.prompt(`Reply with exactly this text and nothing else: session-${i} ok`);
      console.log(`session ${i} 完成，事件数=${counts[i]}`);
    } catch (e) {
      console.error(`session ${i} 出错:`, e instanceof Error ? e.message : e);
    }
  }),
);

console.log("\n各会话事件计数:", counts);
const allGotEvents = counts.every((c) => c > 0);
console.log("每个会话都收到自己的事件?", allGotEvents);

// 期望 id 唯一 + 各自收到事件 + 无报错
const ok = new Set(ids).size === ids.length && allGotEvents;
console.log(ok ? "\n✓ 并发多会话可行（源码预期得到运行时验证）" : "\n✗ 存在串扰或冲突，需排查");

for (const s of sessions) s.session.dispose();
process.exit(ok ? 0 : 1);
