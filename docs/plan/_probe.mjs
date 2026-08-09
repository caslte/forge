// 探针：验证全局 pi 包能 import，并列出可用 provider/模型
import { ModelRuntime } from "file:///C:/Users/Admin/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/index.js";

try {
  const rt = await ModelRuntime.create();
  const providers = rt.getProviders();
  console.log("=== 所有 provider ===");
  for (const p of providers) {
    let authStatus = "?";
    try { authStatus = (await rt.checkAuth(p.id)) ? "OK" : "no-key"; } catch (e) { authStatus = "err"; }
    const models = (rt.getModels?.(p.id) || []).map(m => `${m.provider}/${m.id}`);
    console.log(`- ${p.id}  auth=${authStatus}  models=${models.length ? models.join(", ") : "(none/builtin)"}`);
  }
  const available = await rt.getAvailable();
  console.log("\n=== 可用模型(有 key 的) ===");
  for (const m of available) console.log(`- ${m.provider}/${m.id}`);
} catch (e) {
  console.error("probe error:", e?.stack || e);
}
