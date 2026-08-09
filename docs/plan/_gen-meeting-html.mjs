// 读取 meeting-room-demo-output.md，生成可视化的 meeting-room-demo.html
import { readFileSync, writeFileSync } from "node:fs";

const md = readFileSync("docs/plan/meeting-room-demo-output.md", "utf8");

// 拆分章节（只认 5 个顶层章节标记，避免被内部 ## 子标题切断）
const sectionRe = /^## (Round\d · [^\n]*|综合汇总)$/gm;
const marks = [];
let mm;
while ((mm = sectionRe.exec(md)) !== null) {
  marks.push({ title: mm[1].trim(), start: mm.index, bodyStart: sectionRe.lastIndex });
}
const header = md.slice(0, marks.length ? marks[0].start : md.length);
const sections = {};
for (let i = 0; i < marks.length; i++) {
  const bodyEnd = i + 1 < marks.length ? marks[i + 1].start : md.length;
  const body = md.slice(marks[i].bodyStart, bodyEnd).trim();
  const title = marks[i].title;
  if (/Round1.*minimax/i.test(title)) sections.r1min = { title, body };
  else if (/Round1.*huoshan/i.test(title)) sections.r1huo = { title, body };
  else if (/Round2.*minimax/i.test(title)) sections.r2min = { title, body };
  else if (/Round2.*huoshan/i.test(title)) sections.r2huo = { title, body };
  else if (/综合/.test(title)) sections.synth = { title, body };
}

// 提取元信息
const docMatch = header.match(/评审文档：`([^`]+)`/);
const docName = docMatch ? docMatch[1] : "docs/overview.md";

const MJ = JSON.stringify;

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>forge · 会议室 demo</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<style>
  :root{
    --bg:#0a0b0e; --bg2:#101216; --card:#15171c; --surf:#1c1f26; --line:#272b33;
    --fg:#e8e9ed; --mute:#8b909a; --dim:#525761;
    --teal:#2dd4bf; --orange:#fb923c; --amber:#fbbf24; --green:#34d399; --rose:#fb7185;
    --mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
    --sans:'Inter',system-ui,sans-serif;
  }
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;background:var(--bg);color:var(--fg);font-family:var(--sans);font-size:14px;line-height:1.6;-webkit-font-smoothing:antialiased}
  body{background:
      radial-gradient(1200px 600px at 85% -10%, rgba(45,212,191,.05), transparent 60%),
      radial-gradient(900px 500px at 0% 110%, rgba(251,146,60,.04), transparent 60%),
      var(--bg); min-height:100vh}
  /* top bar */
  .bar{position:sticky;top:0;z-index:50;backdrop-filter:blur(10px);background:linear-gradient(180deg,rgba(16,18,22,.92),rgba(10,11,14,.88));border-bottom:1px solid var(--line);padding:14px 22px}
  .bar .logo{font-family:var(--mono);font-weight:800;font-size:16px;letter-spacing:-.01em}
  .bar .logo b{color:var(--teal)}
  .bar .logo .v{color:var(--mute);font-weight:500;margin-left:8px;font-size:11px}
  .meta{display:flex;flex-wrap:wrap;gap:18px;margin-top:8px;font-size:12px;color:var(--mute);font-family:var(--mono)}
  .meta b{color:var(--fg);font-weight:600}
  .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px;vertical-align:middle}
  .dot.teal{background:var(--teal);box-shadow:0 0 8px var(--teal)}
  .dot.orange{background:var(--orange);box-shadow:0 0 8px var(--orange)}
  .flow{display:flex;align-items:center;gap:8px;margin-top:10px;font-family:var(--mono);font-size:11px;flex-wrap:wrap}
  .flow .step{padding:4px 10px;border:1px solid var(--line);border-radius:6px;background:#0c0e12;color:var(--mute)}
  .flow .step.on{color:var(--teal);border-color:rgba(45,212,191,.3)}
  .flow .arr{color:var(--dim)}
  /* layout */
  .wrap{max-width:1500px;margin:0 auto;padding:24px 22px 80px}
  .stage{margin-top:28px}
  .stage-h{display:flex;align-items:center;gap:10px;margin-bottom:6px}
  .stage-h .badge{font-family:var(--mono);font-size:11px;font-weight:700;padding:4px 10px;border-radius:6px;letter-spacing:.03em}
  .stage-h .badge.r1{color:var(--teal);background:rgba(45,212,191,.1);border:1px solid rgba(45,212,191,.25)}
  .stage-h .badge.r2{color:var(--amber);background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.25)}
  .stage-h .badge.sy{color:var(--green);background:rgba(52,211,153,.1);border:1px solid rgba(52,211,153,.25)}
  .stage-h h2{margin:0;font-size:18px;font-weight:700}
  .hint{color:var(--mute);font-size:12.5px;margin:0 0 14px;font-family:var(--mono)}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  .row.full{grid-template-columns:1fr}
  @media(max-width:980px){.row{grid-template-columns:1fr}}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden;display:flex;flex-direction:column}
  .card.teal{border-top:3px solid var(--teal)}
  .card.orange{border-top:3px solid var(--orange)}
  .card.green{border-top:3px solid var(--green)}
  .card-h{display:flex;align-items:center;gap:10px;padding:11px 14px;border-bottom:1px solid var(--line);background:#0d0f13}
  .card-h .nm{font-family:var(--mono);font-weight:700;font-size:13px}
  .card-h .nm.teal{color:var(--teal)} .card-h .nm.orange{color:var(--orange)} .card-h .nm.green{color:var(--green)}
  .card-h .role{color:var(--mute);font-size:11px;font-family:var(--mono)}
  .card-h .tag{margin-left:auto;font-size:10px;font-family:var(--mono);padding:2px 7px;border-radius:4px;background:#0c0e12;border:1px solid var(--line);color:var(--dim)}
  .card-body{padding:14px 16px;overflow:auto;max-height:none}
  /* markdown rendered content */
  .md h1{font-size:18px;margin:18px 0 10px;color:var(--fg);border-bottom:1px solid var(--line);padding-bottom:6px}
  .md h1:first-child{margin-top:0}
  .md h2{font-size:15px;margin:16px 0 8px;color:var(--teal)}
  .card.orange .md h2{color:var(--orange)}
  .md h3{font-size:14px;margin:14px 0 6px;color:var(--fg)}
  .md h4{font-size:13px;margin:12px 0 5px;color:var(--amber)}
  .md p{margin:8px 0;color:#cdd2da}
  .md ul,.md ol{margin:8px 0;padding-left:22px;color:#cdd2da}
  .md li{margin:4px 0}
  .md strong{color:var(--fg);font-weight:700}
  .md code{font-family:var(--mono);font-size:12px;background:#0c0e12;padding:1px 5px;border-radius:3px;color:#a8b0bd;border:1px solid var(--line)}
  .md pre{background:#0a0c10;border:1px solid var(--line);border-radius:8px;padding:12px;overflow:auto;margin:10px 0}
  .md pre code{background:none;border:none;padding:0;color:#cdd2da;font-size:12px}
  .md table{border-collapse:collapse;width:100%;margin:10px 0;font-size:12px;font-family:var(--mono)}
  .md th,.md td{border:1px solid var(--line);padding:6px 9px;text-align:left;vertical-align:top}
  .md th{background:#0d0f13;color:var(--teal);font-weight:700}
  .card.orange .md th{color:var(--orange)}
  .md hr{border:none;border-top:1px solid var(--line);margin:14px 0}
  .md blockquote{border-left:3px solid var(--teal);margin:10px 0;padding:4px 12px;color:var(--mute);background:rgba(45,212,191,.04);border-radius:0 6px 6px 0}
  .foot{margin-top:40px;text-align:center;color:var(--dim);font-size:11px;font-family:var(--mono);padding:16px;border-top:1px solid var(--line)}
  .foot a{color:var(--mute)}
</style>
</head>
<body>
<div class="bar">
  <div class="logo">⬢ <b>forge</b><span class="v">会议室 demo · 多模型评审可视化</span></div>
  <div class="meta">
    <span><span class="dot teal"></span><b>minimax-M3</b> 资深架构师</span>
    <span><span class="dot orange"></span><b>huoshan-ark</b> 产品/工程负责人</span>
    <span>📄 评审文档：<b>${docName}</b></span>
  </div>
  <div class="flow">
    <span class="step on">Round 1 · 并行评审</span><span class="arr">→</span>
    <span class="step on">Round 2 · 交叉质询</span><span class="arr">→</span>
    <span class="step on">综合汇总</span>
    <span class="arr" style="margin-left:14px">协议：编排器 + 对等 AgentSession（非子 agent）· 2 并发已运行时验证</span>
  </div>
</div>

<div class="wrap">

  <div class="stage">
    <div class="stage-h"><span class="badge r1">Round 1</span><h2>并行评审</h2></div>
    <p class="hint">两个模型各自独立评审同一份文档，互不知对方观点</p>
    <div class="row">
      <div class="card teal"><div class="card-h"><span class="nm teal">minimax-M3</span><span class="role">架构师视角</span><span class="tag">独立评审</span></div><div class="card-body md" id="r1min"></div></div>
      <div class="card orange"><div class="card-h"><span class="nm orange">huoshan-ark</span><span class="role">产品/工程视角</span><span class="tag">独立评审</span></div><div class="card-body md" id="r1huo"></div></div>
    </div>
  </div>

  <div class="stage">
    <div class="stage-h"><span class="badge r2">Round 2</span><h2>交叉质询</h2></div>
    <p class="hint">每个模型看到对方的 Round 1 评审后回应：同意 / 反对 / 补充</p>
    <div class="row">
      <div class="card teal"><div class="card-h"><span class="nm teal">minimax-M3</span><span class="role">回应 huoshan-ark</span><span class="tag">← 看到对方评审</span></div><div class="card-body md" id="r2min"></div></div>
      <div class="card orange"><div class="card-h"><span class="nm orange">huoshan-ark</span><span class="role">回应 minimax-M3</span><span class="tag">← 看到对方评审</span></div><div class="card-body md" id="r2huo"></div></div>
    </div>
  </div>

  <div class="stage">
    <div class="stage-h"><span class="badge sy">综合</span><h2>综合汇总</h2></div>
    <p class="hint">由 minimax-M3 综合：双方共识 / 分歧（含判断）/ 最终建议 / 一句话结论</p>
    <div class="row full">
      <div class="card green"><div class="card-h"><span class="nm green">综合结论</span><span class="role">共识 + 分歧 + Top3 建议</span></div><div class="card-body md" id="synth"></div></div>
    </div>
  </div>

  <div class="foot">forge 会议室 demo · 数据来自 <code>docs/plan/meeting-room-demo-output.md</code> · 重新生成：<code>node docs/plan/_gen-meeting-html.mjs</code></div>
</div>

<script>
  const SECTIONS = ${MJ(sections)};
  function render(){
    const map = {r1min:'r1min',r1huo:'r1huo',r2min:'r2min',r2huo:'r2huo',synth:'synth'};
    for(const k of Object.keys(map)){
      const el = document.getElementById(k);
      const s = SECTIONS[k];
      if(el && s){ el.innerHTML = marked.parse(s.body); }
    }
  }
  if(window.marked){ marked.setOptions({breaks:true,gfm:true}); render(); }
  else { window.addEventListener('load',()=>{ marked.setOptions({breaks:true,gfm:true}); render(); }); }
</script>
</body>
</html>`;

writeFileSync("docs/plan/meeting-room-demo.html", html, "utf8");
console.log("✅ 生成 docs/plan/meeting-room-demo.html");
