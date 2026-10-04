import { test } from '@playwright/test';
test('rail px', async ({ page }) => {
  await page.goto('/e2e-report/__tmp-rail.png');
  const info = await page.evaluate(async () => {
    const img = document.querySelector('img') as HTMLImageElement;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d')!; g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const RGB = (x: number, y: number) => { const i = (y * c.width + x) * 4; return [d[i], d[i+1], d[i+2]]; };
    const L = (x: number, y: number) => { const p = RGB(x, y); return 0.299*p[0]+0.587*p[1]+0.114*p[2]; };
    // 红框区域大约 x 0..70, y 250..390
    const segs: string[] = [];
    let cur: number[] = [];
    for (let y = 240; y < 400; y++) {
      let mn = 9999, mx = -1, m = 0;
      for (let x = 0; x < 70; x++) { const l = L(x, y); if (l < mn) mn = l; if (l > mx) mx = x; if (l > m) m = l; }
      if (mn < 100) cur.push(y);
      if (mn >= 100 && cur.length) {
        const y0 = cur[0], y1 = cur[cur.length-1];
        let a = 9999, b = -1;
        for (let yy = y0; yy <= y1; yy++) for (let x = 0; x < 70; x++) { const l = L(x, yy); if (l < 100) { a = Math.min(a,x); b = Math.max(b,x); } }
        segs.push(`y${y0}-${y1} (h=${y1-y0+1})  x=${a}..${b}  宽=${b-a+1}px  最亮=${m.toFixed(0)}`);
        cur = [];
      }
    }
    return { size: [c.width, c.height], segs };
  });
  console.log('截图尺寸', info.size.join('x'));
  console.log(info.segs.join('\n'));
});
