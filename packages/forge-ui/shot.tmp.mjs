import { chromium } from 'playwright';
const url = 'file:///D:/work/aiwork/forge/prototypes/code-tree-git-demo.html';
const b = await chromium.launch();
const shots = [
  ['files-cover', async p => {}],
  ['changes-file', async p => { await p.click('#ctpViews .ctp-view[data-v="changes"]'); }],
  ['changes-diff', async p => { await p.click('#ctpViews .ctp-view[data-v="changes"]'); await p.click('#cpModes .cp-mode[data-m="diff"]'); }],
  ['split-diff-light', async p => { await p.click('#cpModes .cp-mode[data-m="diff"]'); await p.click('#h-layout .h-btn[data-l="split"]'); await p.click('#h-theme'); }],
  ['newfile-diff', async p => { await p.click('#ctpViews .ctp-view[data-v="changes"]'); await p.click('#cpModes .cp-mode[data-m="diff"]'); await p.click('.ctp-row.changed[data-path$="diffMarks.ts"]'); }],
  ['unchanged-file', async p => { await p.click('.ctp-row[data-path="packages/forge-ui/src/components/CodeViewer.vue"]'); await p.click('#h-legend'); }],
];
for (const [name, act] of shots) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  await p.goto(url);
  await act(p);
  await p.waitForTimeout(250);
  await p.screenshot({ path: `D:/work/aiwork/forge/prototypes/code-tree-git-${name}.png` });
  if (errs.length) console.log(name, errs);
  await ctx.close();
}
await b.close();
console.log('done');
