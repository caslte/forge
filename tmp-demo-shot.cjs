const { chromium } = require('playwright-core');
const path = require('path');

(async () => {
  const exe = 'C:/Users/chenmo/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
  const browser = await chromium.launch({ executablePath: exe });
  const page = await browser.newPage({ viewport: { width: 780, height: 960 }, deviceScaleFactor: 2 });
  const url = 'file:///' + path.resolve('prototypes/update-sidebar-entry-prototype.html').replace(/\\/g, '/');
  await page.goto(url);
  await page.waitForTimeout(300);
  const out = (n) => `C:/works/ai_work/forge/tmp-demo-${n}.png`;
  const footerClip = { x: 32, y: 500, width: 320, height: 130 };

  // found：静止纯图标 → hover 展开「新版本」
  await page.mouse.move(700, 300);
  await page.waitForTimeout(300);
  await page.screenshot({ path: out('v6-found-idle'), clip: footerClip });
  await page.hover('#upSlot [data-act="download"]');
  await page.waitForTimeout(450);
  await page.screenshot({ path: out('v6-found-hover'), clip: footerClip });

  // 下载中 → 就绪 hover「更新」（确认两态动画一致）
  await page.click('#upSlot [data-act="download"]');
  await page.waitForSelector('#upSlot [data-act="install"]', { timeout: 20000 });
  await page.mouse.move(700, 300);
  await page.waitForTimeout(300);
  await page.screenshot({ path: out('v6-update-idle'), clip: footerClip });
  await page.hover('#upSlot [data-act="install"]');
  await page.waitForTimeout(450);
  await page.screenshot({ path: out('v6-update-hover'), clip: footerClip });
  await page.click('.cbox .ghost').catch(() => {});

  // 浅色 found hover：重开页面回到初始 found 态
  await page.goto(url);
  await page.waitForTimeout(300);
  await page.click('#segTheme button[data-v="light"]');
  await page.hover('#upSlot [data-act="download"]');
  await page.waitForTimeout(450);
  await page.screenshot({ path: out('v6-light-found-hover'), clip: footerClip });

  await browser.close();
  console.log('done');
})().catch(e => { console.error(e); process.exit(1); });
