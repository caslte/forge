import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { scanAttachments, savePasteImage, savePastedText, readImageDataUrl, listProjectFiles, SECRET_PATTERNS } from '../src/attachments.ts';

// ===== 附件安全扫描：文本文件命中密钥特征 → flagged=true（给路径机制下唯一的出域防线） =====

test('scanAttachments：文本文件命中密钥特征标记 flagged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-att-'));
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, JSON.stringify({ key: 'sk-abcdefghij1234567890' }));
  const [res] = scanAttachments([p]);
  assert.equal(res?.name, 'config.json');
  assert.equal(res?.flagged, true, '含 sk- 密钥的文本文件应被标记');
});

test('scanAttachments：普通文本与图片扩展名不误报', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-att-'));
  const txt = path.join(dir, 'readme.md');
  fs.writeFileSync(txt, '# 只是说明\n没有秘密');
  const png = path.join(dir, 'pic.png');
  fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const [a, b] = scanAttachments([txt, png]);
  assert.equal(a?.flagged, false, '普通文本不标记');
  assert.equal(b?.flagged, false, '图片扩展名不做文本嗅探');
});

test('scanAttachments：文件缺失不抛错，flagged=false', () => {
  const [res] = scanAttachments([path.join(os.tmpdir(), 'forge-not-exist-xyz.txt')]);
  assert.equal(res?.flagged, false);
});

test('SECRET_PATTERNS：覆盖私钥块 / AWS / GitHub / OpenAI / Slack 特征', () => {
  const samples = [
    '-----BEGIN RSA PRIVATE KEY-----',
    'AKIAIOSFODNN7EXAMPLE',
    'ghp_Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'sk-proj-abc123_DEF-4567890123',
    'xoxb-123456789-abcdef',
  ];
  for (const s of samples) {
    assert.ok(SECRET_PATTERNS.some((re) => re.test(s)), `应命中：${s}`);
  }
});

// ===== 粘贴截图落盘：base64 png → 系统临时目录真实文件（给路径机制的唯一落盘点） =====

test('savePasteImage：写入临时 png 并返回真实路径与文件名', () => {
  // 1x1 透明 png 的 base64
  const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const res = savePasteImage(PNG_1PX);
  try {
    assert.ok(res.path.endsWith('.png'));
    assert.ok(fs.existsSync(res.path), '落盘文件应存在');
    const head = fs.readFileSync(res.path).subarray(0, 4);
    assert.deepEqual([...head], [0x89, 0x50, 0x4e, 0x47], '内容应为 PNG');
    assert.equal(res.name, path.basename(res.path));
  } finally {
    fs.rmSync(res.path, { force: true });
  }
});

// ===== 超长粘贴文本落盘：长文本 → 系统临时目录 txt（输入框粘贴转附件用） =====

test('savePastedText：长文本落盘为临时 txt 并原样返回内容', () => {
  const text = `粘贴的长文本\n第二行 content 123\n${'x'.repeat(3000)}`;
  const res = savePastedText(text);
  try {
    assert.ok(res.path.endsWith('.txt'), '落盘文件应为 txt');
    assert.ok(fs.existsSync(res.path), '落盘文件应存在');
    assert.equal(fs.readFileSync(res.path, 'utf8'), text, '中文与换行应原样 round-trip');
    assert.equal(res.name, path.basename(res.path));
  } finally {
    fs.rmSync(res.path, { force: true });
  }
});

// ===== 缩略图读取：磁盘图片 → data URL（仅缩略图/预览用，非消息通道） =====

test('readImageDataUrl：磁盘图片读为 data URL；缺失/超大返回 null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-thumb-'));
  const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const p = path.join(dir, 't.png');
  fs.writeFileSync(p, Buffer.from(PNG_1PX, 'base64'));
  const ok = readImageDataUrl(p);
  assert.ok(ok?.startsWith('data:image/png;base64,'), 'png 应返回 image/png data URL');
  assert.equal(readImageDataUrl(path.join(dir, 'nope.png')), null, '缺失文件返回 null');
  const big = path.join(dir, 'big.png');
  fs.writeFileSync(big, Buffer.alloc(11 * 1024 * 1024));
  assert.equal(readImageDataUrl(big), null, '超过 10MB 上限返回 null');
});

// ===== @ 补全候选：项目内白名单文件遍历 =====

test('listProjectFiles：BFS 遍历白名单文件，忽略依赖目录与非白名单扩展', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-atwalk-'));
  try {
    fs.writeFileSync(path.join(root, 'README.md'), 'x');
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'x');
    fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'dep.js'), 'x');
    fs.writeFileSync(path.join(root, 'virus.exe'), 'x');
    const files = listProjectFiles(root);
    const norm = files.map((f) => f.replace(/\\/g, '/').slice(root.replace(/\\/g, '/').length + 1));
    assert.deepEqual(norm.sort(), ['README.md', 'src/index.ts'], 'node_modules 与 exe 应被排除');
    assert.equal(listProjectFiles(path.join(root, 'missing')).length, 0, '缺失目录返回空数组');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
