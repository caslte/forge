/**
 * notifyToast 冒烟测试（维护者本地验证用，不进 CI）：
 * 真实 Electron 环境弹出 2 条通知（done + error），截图到 test-results/ 后退出。
 * 运行：node scripts/notify-toast-smoke.mjs（在 packages/forge-desktop 下）
 */
import { app, BrowserWindow, screen } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNotifyToastManager } from '../dist/notifyToast.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.whenReady().then(async () => {
  const manager = createNotifyToastManager({
    getMainWindow: () => null,
    getLocale: () => 'zh-CN',
    logoSrc: fs.existsSync('../forge-ui/dist/logo-main.png') ? 'data:image/png;base64,' + fs.readFileSync('../forge-ui/dist/logo-main.png').toString('base64') : null,
  });
  manager.notify({
    kind: 'done',
    sessionId: 's1',
    body: '任务：现在forge在对话框中已经有画布，可以渲染 html，那么是否可以渲染图片，然后模型输出的时候直接输出到对话框？就按这个方向改吧，注意兼容旧会话。',
  });
  // 同会话重复通知：应替换而不是叠加（窗口总数不应因此增加）
  manager.notify({
    kind: 'done',
    sessionId: 's1',
    body: '任务：帮我看看 Home 页 LCP 为什么这么高，先把图片都改成懒加载试试。',
  });
  manager.notify({
    kind: 'error',
    sessionId: 's2',
    body: '任务：帮我跑一下测试并修复失败的用例，先从 unit 开始。',
  });
  await new Promise((r) => setTimeout(r, 2500));
  const windows = BrowserWindow.getAllWindows();
  if (windows.length !== 2) {
    console.log(`[smoke] ✗ 预期 2 条通知（s1 替换后 1 条 + s2 1 条），实际 ${windows.length} 条`);
  } else {
    console.log('[smoke] ✓ 同会话替换生效：窗口总数 = 2');
  }
  await new Promise((r) => setTimeout(r, 2500));
  const outDir = path.join(__dirname, '../test-results');
  fs.mkdirSync(outDir, { recursive: true });
  let i = 0;
  for (const w of BrowserWindow.getAllWindows()) {
    const img = await w.webContents.capturePage();
    const bounds = w.getBounds();
    const wa = screen.getPrimaryDisplay().workArea;
    const fits = bounds.y + bounds.height <= wa.y + wa.height && bounds.x + bounds.width <= wa.x + wa.width;
    fs.writeFileSync(path.join(outDir, `notify-toast-smoke-${i}.png`), img.toPNG());
    console.log(
      `[smoke] toast ${i}: bounds=${JSON.stringify(bounds)} workArea=${JSON.stringify(wa)} ` +
        `withinWorkArea=${fits} shot=notify-toast-smoke-${i}.png`,
    );
    i += 1;
  }
  app.quit();
});
