/**
 * 画布判决语料（2026-09-30 冻结）。
 *
 * 来源：tmp/canvas-judge-demo.html 语料矩阵经用户逐条拍板后冻结。语义基准：
 * - 有标签 = 想表达页面 → html，表现形式是模型的问题（G06 裁决）；
 * - prose 只认强证据：长句主导（N11/W01）或样式块 + 可见文本近零的空壳（G02）；
 * - <canvas> 是死元素不是死刑（G01），剥掉按其余内容判；
 * - 字符画薄壳降 code 保对齐（G03），短句也是内容（G04）。
 *
 * 本文件是 demo 矩阵（tmp/build-canvas-demo.mjs）的测试侧副本：demo 负责人眼复核
 * 「该渲染的渲染、不该渲染的没渲染」，本文件负责把这 25 例钉死成回归锁。两边语料
 * 若再演化，先改 demo 拍板、再同步到这里。
 */
import type { CanvasVerdict } from '../../src/markdown/canvasSandbox.ts';

export interface CanvasCorpusCase {
  id: string;
  name: string;
  expect: CanvasVerdict;
  src: string;
}

/* ---- 共享大字面量（canvasSandbox.test.ts 亦引用） ---- */

/** 真机注册流程卡（2026-09-30 误杀事故本体）：<style> 网格 + 94 短标签 + 2 长说明 */
export const REAL_STYLE_BLOCK_DIAGRAM = `<style>
.lane{border:1px solid var(--c-border);border-radius:10px;padding:9px 11px;margin:0 0 7px;background:var(--c-surface)}
.lane-hd{display:flex;align-items:center;gap:7px;margin-bottom:7px}
.flow{display:flex;flex-direction:column;gap:5px}
.step{border:1px solid var(--c-border);border-radius:7px;padding:5px 8px;background:var(--c-bg)}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:5px}
.arw{text-align:center;color:var(--c-muted-fg);font-size:12px;line-height:1;margin:-1px 0}
</style>
<div class="rg">
<div class="lane">
  <div class="lane-hd"><span class="lane-no">1</span><span class="lane-ttl">注册页初始化</span><span class="lane-api">匿名</span></div>
  <div class="flow">
    <div class="g2">
      <div class="step"><div class="t">单位下拉树</div><div class="s">GET /auth/register-depts</div></div>
      <div class="step"><div class="t">用户协议生效版本</div><div class="s">GET /agreements/user-agreement</div></div>
    </div>
    <div class="hint">下拉只暴露 id / parentId / deptName / children；提交时仍上送真实 deptId</div>
  </div>
</div>
<div class="lane">
  <div class="lane-hd"><span class="lane-no">2</span><span class="lane-ttl">发送邮箱验证码</span><span class="lane-api">POST /auth/registration-email-verifications</span></div>
  <div class="flow">
    <div class="step ac"><div class="t">① 邮箱格式 + 教育邮箱后缀策略 <span class="chip">eduOnly 默认 *.edu.cn</span></div></div>
    <div class="arw">↓ 不匹配 → <b>EDU_EMAIL_REQUIRED</b> 400（不可点遮罩关闭的弹窗）</div>
    <div class="step ac"><div class="t">② 查 sys_user 未软删除正式账号占用</div><div class="s">命中 → EMAIL_ALREADY_USED 409，不计限流、不建 challenge</div></div>
    <div class="g3">
      <div class="step warn"><div class="t">③ 邮件配置预检</div><div class="s">MAIL_CONFIG_REQUIRED / UNAVAILABLE</div></div>
      <div class="step warn"><div class="t">④ 可信代理解析 IP</div><div class="s">IPv4 单地址 / IPv6 按 /64</div></div>
      <div class="step warn"><div class="t">⑤ Redis 原子限流</div><div class="s">429 RATE_LIMIT_EXCEEDED</div></div>
    </div>
    <div class="step"><div class="t">⑥ 查 active challenge：有则复用同一 verificationId + 验证码（不延期），无则建 candidate</div></div>
    <div class="step ok"><div class="t">⑦ 写 sys_mail_log PENDING → SMTP 发送</div><div class="s">失败 MAIL_SEND_FAILED 502；仅 SMTP 接受后 candidate 才激活并淘汰旧码</div></div>
    <div class="step ok"><div class="t">⑧ 返回 verificationId / 600s 有效期 / 60s 重发冷却</div></div>
    <div class="step"><div class="t">⑦ 独立 MySQL 事务：协议行 SELECT FOR UPDATE 终复核 → 最终查重 → insert 申请 → 写 sys_user_agreement_acceptance → 可选自动审核</div></div>
  </div>
</div>
</div>`;

const auditItem = (tag: string, style: string, body: string) => `<div style="${style}"><b>${tag}</b> ${body}</div>`;

/** 存量 P0/P1/P2 文字堆：grid 壳 + 长句占满（长句判据的存量防线，不得放松） */
export const P0P1P2_AUDIT_CARD =
  '<div style="display:grid;gap:12px;line-height:1.8">' +
  auditItem('P0 · 必须处理（公开前）', 'padding:10px;border-radius:8px;background:var(--c-bad-bg)',
    'docs/plan/ 全 17 个文件 ·meeting-room-demo-output.md —— 内含 huoshan-ark 与 minimax-M3 两轮对抗式评审全文：这是内部会议记录，不是交付物，外发等于把自我批评和未决策争论公开。') +
  auditItem('P1 · 强烈建议移除', 'padding:10px;border-radius:8px;background:var(--c-warn-bg)',
    'AGENT.MD 你的个人开发规约：skill 调用策略、强制文档同步、什么时候该用 dev-tdd，不违规，但把私人工作流摊开给所有贡献者看通常不是你想要的。') +
  '</div>';

/* ---- 语料 ---- */

const swimLaneCard = `<style>
.lane{border:1px solid var(--c-border);border-radius:10px;padding:8px 10px;margin-bottom:8px;background:var(--c-surface)}
.lane-hd{display:flex;gap:6px;align-items:center;font-weight:600}
.g3{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
.node{border:1px solid var(--c-border);border-radius:6px;padding:4px 8px;background:var(--c-bg)}
.arw{color:var(--c-muted-fg);text-align:center}
</style>
<div>
<div class="lane"><div class="lane-hd">用户 / 前端</div>
<div class="g3"><div class="node">进个人中心</div><div class="node">点[实名认证]</div><div class="node">弹窗：姓名/身份证/图形码</div></div>
<div class="arw">↓ 提交</div></div>
<div class="lane"><div class="lane-hd">后端 RealnameVerifyService</div>
<div class="g3"><div class="node">开关关→400</div><div class="node">防越权</div><div class="node">图形码校验</div></div>
<div class="arw">↓</div>
<div class="g3"><div class="node">限流/IP/冷却</div><div class="node">Redis 计数</div><div class="node">密文查重</div></div></div>
<div class="lane"><div class="lane-hd">依赖</div>
<div class="g3"><div class="node">人口库 token 300s</div><div class="node">SM4 解密</div><div class="node">HCJG 四要素</div></div></div>
</div>`;

const svgDecisionTree = `<div style="padding:8px">
<svg viewBox="0 0 420 130" style="width:100%">
<rect x="10" y="46" width="96" height="38" rx="7" fill="var(--c-surface)" stroke="var(--c-border)"/><text x="58" y="70" text-anchor="middle" font-size="12" fill="var(--c-fg)">提交申请</text>
<rect x="162" y="46" width="96" height="38" rx="7" fill="var(--c-surface)" stroke="var(--c-border)"/><text x="210" y="70" text-anchor="middle" font-size="12" fill="var(--c-fg)">平台核验</text>
<rect x="314" y="10" width="96" height="34" rx="7" fill="var(--c-ok-bg)" stroke="var(--c-border)"/><text x="362" y="32" text-anchor="middle" font-size="12" fill="var(--c-ok)">PASS</text>
<rect x="314" y="86" width="96" height="34" rx="7" fill="var(--c-bad-bg)" stroke="var(--c-border)"/><text x="362" y="108" text-anchor="middle" font-size="12" fill="var(--c-bad)">MISMATCH</text>
<path d="M106 65 H162" stroke="var(--c-muted-fg)"/><path d="M258 55 L314 27" stroke="var(--c-muted-fg)"/><path d="M258 75 L314 103" stroke="var(--c-muted-fg)"/>
</svg></div>`;

const tableCard = `<table style="width:100%;border-collapse:collapse;font-size:12px">
<tr><th style="border:1px solid var(--c-border);padding:4px 8px;text-align:left">接口</th><th style="border:1px solid var(--c-border);padding:4px 8px">限流</th><th style="border:1px solid var(--c-border);padding:4px 8px">冷却</th></tr>
<tr><td style="border:1px solid var(--c-border);padding:4px 8px">POST /auth/realname/verify</td><td style="border:1px solid var(--c-border);padding:4px 8px;text-align:center">IP 5/min</td><td style="border:1px solid var(--c-border);padding:4px 8px;text-align:center">60s</td></tr>
<tr><td style="border:1px solid var(--c-border);padding:4px 8px">GET /auth/realname/status</td><td style="border:1px solid var(--c-border);padding:4px 8px;text-align:center">—</td><td style="border:1px solid var(--c-border);padding:4px 8px;text-align:center">—</td></tr>
</table>`;

const flexBoxCard = `<div style="font-size:12px">
<div style="font-weight:700;margin-bottom:6px">发帖门禁挂载点</div>
<div style="display:flex;gap:6px;flex-wrap:wrap">
<span style="border:1px solid var(--c-border);border-radius:6px;padding:3px 8px">建帖/改帖</span>
<span style="border:1px solid var(--c-border);border-radius:6px;padding:3px 8px">求助回复</span>
<span style="border:1px solid var(--c-border);border-radius:6px;padding:3px 8px">知识库发布</span>
<span style="border:1px solid var(--c-border);border-radius:6px;padding:3px 8px">评论</span>
<span style="border:1px solid var(--c-border);border-radius:6px;padding:3px 8px">意见反馈</span>
</div></div>`;

const timelineCard = `<div style="font-size:12px">
<div style="font-weight:700;margin-bottom:6px">核验耗时分布</div>
${['09-30 13:20|提交申请', '09-30 13:20|取人口库 token', '09-30 13:21|HCJG 判定', '09-30 13:21|留痕返回', '09-30 13:21|弹窗关闭'].map((r) => { const [d, e] = r.split('|'); return `<div style="display:flex;gap:10px;padding:3px 0;border-bottom:1px dashed var(--c-border)"><span style="color:var(--c-muted-fg)">${d}</span><span>${e}</span></div>`; }).join('')}
</div>`;

const codeShowcaseCard = `<div style="border:1px solid var(--c-border);border-radius:8px;overflow:hidden">
<div style="background:var(--c-surface);padding:4px 10px;font-weight:600;font-size:12px">重试示例</div>
<pre style="margin:0;padding:10px;font-size:12px;overflow:auto"><code>await retry(() =&gt; verify(id), { times: 3, backoff: 'exp' });</code></pre>
</div>`;

const smallCard = `<div style="text-align:center;padding:18px">
<div style="font-size:15px;font-weight:700">部署完成</div>
<div style="display:flex;gap:8px;justify-content:center;margin-top:8px;font-size:12px"><span>API</span><span>Web</span><span>Worker</span></div>
</div>`;

const scriptCard = `<script>${'var x = 1;'.repeat(40)}</script><div style="font-size:13px">甲</div><div style="font-size:13px">乙</div>`;

const preambleWithBoxes = (boxes: number, label: string) => {
  const pre = '实名认证共两条链路：个人中心的二要素核查认证，以及发帖前的实名门禁；链路与 PRD 的 89_realname_verification.md 一致，注册侧实名已停用。';
  const items = Array.from({ length: boxes }, (_, i) => `<div class="n">${label}${i}</div>`).join('');
  return `<style>.wrap{font-size:12px}.n{border:1px solid var(--c-border);border-radius:6px;padding:3px 8px;margin:3px 0}</style><div class="wrap"><p>${pre}</p>${items}</div>`;
};

const fourStepWithDesc = (() => {
  const desc = [
    '提交后校验图形码与限流：验证码错误即焚并计数，连续五次锁定十分钟；IP 维度每分钟五次、每天二十次，超限返回 429 并提示稍后再试，单用户另有六十秒冷却，全流程与 PRD 口径一致。',
    '四要素送人口库核验：先取三百秒有效 token，SM4-CBC 解密证件号，HCJG 返回判定码；命中结果缓存则直接留痕返回，PASS 结果缓存二十四小时内复用，不重复出网。',
    '核查记录落 sys_realname_verify_record：判定码、是否缓存命中、来源 IP 都要留痕；PASS 才 upsert 身份行，密文唯一索引保证一号一户终审，冲突返回 409。',
    '弹窗关闭回个人中心：身份行未实名才显示入口，状态接口幂等可轮询；MISMATCH 计数加一，ERROR 返回 503 且不计数，防刷口径与主链路完全一致。',
  ];
  const step = (t: string, d: string) => `<div class="step"><b>${t}</b><div>${d}</div></div>`;
  return `<style>.flow{display:flex;flex-direction:column;gap:6px;font-size:12px}.step{border:1px solid var(--c-border);border-radius:6px;padding:6px}.arw{text-align:center;color:var(--c-muted-fg)}</style><div class="flow">${desc.map((d, i) => step('步骤' + '一二三四'[i], d)).join('<div class="arw">↓</div>')}</div>`;
})();

const twoColumnCompare = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:12px">
<div style="border:1px solid var(--c-border);border-radius:8px;padding:10px"><b>方案 A：同步核验</b><div>提交时实时调用人口库，用户在弹窗内等待结果，优点是状态即时生效、无需轮询，缺点是依赖平台稳定性，熔断时发帖主链路会被一起拖住，需要额外的降级开关兜底。</div></div>
<div style="border:1px solid var(--c-border);border-radius:8px;padding:10px"><b>方案 B：异步核验</b><div>提交后先返回受理中，后台队列完成核验后写身份行，前端轮询状态接口，优点是主链路不被平台抖动影响，缺点是用户要等推送、存在受理中中间态，超时还需要补偿任务。</div></div>
</div>`;

const plainTextWall = (() => {
  const sent = '这一段是五十五个字左右的完整句子，模拟模型把要点写成整句放进卡片里，包含主语谓语和标点，不是图示的短标签。';
  return '<div style="display:flex;flex-direction:column;gap:8px">' + Array(8).fill(`<div>${sent}</div>`).join('') + '</div>';
})();

const styledTextWall = (() => {
  const sent = '这一段是五十五个字左右的完整句子，模拟模型把要点写成整句放进卡片里，包含主语谓语和标点，不是图示的短标签。';
  const css = '.card{border:1px solid var(--c-border);border-radius:8px;padding:10px;margin:6px 0;font-size:13px}'.repeat(8);
  return `<style>${css}</style>` + Array(6).fill(`<div class="card">${sent}</div>`).join('');
})();

const asciiArtLines = ['┌────────┬────────┐', '│ 提交    │ 校验    │', '├────────┼────────┤', '│ 留痕    │ 返回    │', '└────────┴────────┘'];

export const CANVAS_CORPUS: CanvasCorpusCase[] = [
  // —— 正常·应渲染成卡片（html） ——
  { id: 'N01', name: '真机注册流程卡（回归锚点）', expect: 'html', src: REAL_STYLE_BLOCK_DIAGRAM },
  { id: 'N02', name: '泳道流程卡（实名认证形态）', expect: 'html', src: swimLaneCard },
  { id: 'N03', name: 'SVG 决策树', expect: 'html', src: svgDecisionTree },
  { id: 'N04', name: '数据表格卡', expect: 'html', src: tableCard },
  { id: 'N05', name: 'flex 盒子图（纯短标签）', expect: 'html', src: flexBoxCard },
  { id: 'N06', name: '时间线卡', expect: 'html', src: timelineCard },
  { id: 'N07', name: '代码展示卡（pre/code）', expect: 'html', src: codeShowcaseCard },
  { id: 'N08', name: '小卡（可见文本 16 字）', expect: 'html', src: smallCard },
  { id: 'N09', name: 'script 逻辑卡(剥脚本后空壳 → prose)', expect: 'prose', src: scriptCard },
  { id: 'N10', name: '一段前言 + 20 个盒子', expect: 'html', src: preambleWithBoxes(20, '盒子：发送邮箱验证码') },
  { id: 'G05', name: '一段前言 + 12 个盒子（流式翻面样本，方案 A 接受）', expect: 'html', src: preambleWithBoxes(12, '个人中心二要素核查') },
  { id: 'G06', name: '<style> + 无属性 div 文字墙（用户裁决：页面）', expect: 'html', src: styledTextWall },
  // —— 滥用·应降级（prose/code） ——
  { id: 'W01', name: 'P0/P1/P2 文字堆（长句占满）', expect: 'prose', src: P0P1P2_AUDIT_CARD },
  { id: 'W02', name: '纯文字说明（无标签）', expect: 'prose',
    src: '梳理结果：这套实名认证实际是两个流程：个人中心的二要素核查认证，以及发帖前的实名门禁。链路与 PRD 一致，注册侧实名已停用，保留方法但直接抛 REALNAME_VERIFICATION_DISABLED。' },
  { id: 'W03', name: 'flex 壳文字墙（无样式薄壳，用户裁决：正文）', expect: 'prose', src: plainTextWall },
  { id: 'N11', name: '四步流程每步带 97 字说明（用户裁决：文本）', expect: 'prose', src: fourStepWithDesc },
  { id: 'N12', name: '双栏对比卡（两段 ~75 字说明，未过 80 长句线 → html）', expect: 'html', src: twoColumnCompare },
  { id: 'W05', name: '无标签源码', expect: 'code',
    src: "const gate = useRealnameGate();\nif (!gate.ok) {\n  return redirect('/realname?from=post');\n}" },
  { id: 'W06', name: '无标签 ASCII 字符画', expect: 'code', src: asciiArtLines.join('\n') },
  { id: 'G03', name: '薄壳 div 包字符画（降 code 保对齐）', expect: 'code',
    src: `<div style="font-family:monospace">${asciiArtLines.join('\n')}</div>` },
  // —— 裁决修复样本 ——
  { id: 'G01', name: '好卡混 <canvas> 装饰（剥元素保其余）', expect: 'html',
    src: '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px">' +
      '<div style="border:1px solid var(--c-border);border-radius:6px;padding:6px">步骤一</div>' +
      '<div style="border:1px solid var(--c-border);border-radius:6px;padding:6px">步骤二</div>' +
      '<div style="border:1px solid var(--c-border);border-radius:6px;padding:6px">步骤三</div>' +
      '<div style="border:1px solid var(--c-border);border-radius:6px;padding:6px">步骤四</div>' +
      '<canvas width="80" height="40"></canvas></div>' },
  { id: 'G02', name: '大 <style> + 一个字（空壳判文本）', expect: 'prose',
    src: '<style>' + '.a{color:var(--c-fg);border:1px solid var(--c-border);padding:10px;margin:4px;border-radius:6px}'.repeat(40) + '</style><div class="a">甲</div>' },
  { id: 'G04', name: '一句话短文本（终态无 undecided）', expect: 'prose', src: '画好了' },
  { id: 'W07', name: '<canvas> 直译画布（剥标签后按回退文本判）', expect: 'prose',
    src: '<canvas style="background:#fff">流程图回退文本</canvas>' },
  { id: 'W08', name: '死画布包 ASCII 表格（剥标签后走字符画 → code）', expect: 'code',
    src: '<canvas width="640" height="150" style="background:#fff;font:13px/1.5 system-ui">\n' +
      "localStorage 'forge:content-width'   生效值\n" +
      '─────────────────────────────────────────────\n' +
      '(缺失 / 非法)  ────────► standard 920px 居中   ← 改后默认\n' +
      "'standard'    ────────► standard 920px 居中\n" +
      '</canvas>' },
];
