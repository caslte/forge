/**
 * 模块 12 · FileService 单元测试。
 *
 * 重点不是「能不能列目录」（那是 fs 的工作），而是三道安全/降级边界：
 * 1. 越界：../ 穿越、绝对路径、盘符、符号链接逃逸——四种逃逸方式都必须被 6103 拦下
 * 2. 降级：二进制 / 超大文件 / 路径失效
 * 3. 忽略：内置表 + .gitignore 语义（含 ! 取反、目录剪枝）
 *
 * 用真实临时目录而非 mock fs：要测的正是真实路径语义（realpath / 符号链接），
 * mock 掉 fs 等于把被测对象换掉了。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FileService,
  FILE_ERROR,
  MAX_READ_LINES,
  DEFAULT_IGNORES,
  compileIgnoreMatcher,
  resolveInside,
  normalizeRelPath,
  looksBinary,
  type FileResult,
} from '../../src/file/fileService.ts';

/** 建一个受控的临时项目根，返回 { root, cleanup } */
function makeProject(): { root: string; cleanup: () => void } {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-file-')));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** 接受一切路径的服务（越界测试要的就是「除了越界以外别拦」） */
function svc(registered: (p: string) => boolean = () => true): FileService {
  return new FileService({ isProjectRegistered: registered });
}

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

// ── listDir ─────────────────────────────────────────────────────────────────

test('listDir：目录优先 + 组内字典序，文件带 size/mtime', () => {
  const { root, cleanup } = makeProject();
  try {
    write(root, 'b.ts', 'bb');
    write(root, 'a.ts', 'a');
    write(root, 'zeta/z.ts', 'z');
    write(root, 'alpha/a.ts', 'a');

    const r = svc().listDir(root, '');
    assert.ok(r.ok);
    assert.deepEqual(
      r.data.nodes.map((n) => `${n.kind}:${n.name}`),
      ['dir:alpha', 'dir:zeta', 'file:a.ts', 'file:b.ts'],
    );
    const a = r.data.nodes.find((n) => n.name === 'a.ts');
    assert.equal(a?.size, 1);
    assert.ok((a?.mtimeMs ?? 0) > 0);
  } finally {
    cleanup();
  }
});

test('listDir：子目录用 POSIX 相对路径拼接，不泄漏绝对路径', () => {
  const { root, cleanup } = makeProject();
  try {
    write(root, 'packages/forge-ui/src/App.vue', '<template></template>');
    const r = svc().listDir(root, 'packages/forge-ui/src');
    assert.ok(r.ok);
    assert.equal(r.data.relPath, 'packages/forge-ui/src');
    assert.equal(r.data.nodes[0]?.relPath, 'packages/forge-ui/src/App.vue');
    assert.ok(!(r.data.nodes[0]?.relPath ?? '').includes(root));
  } finally {
    cleanup();
  }
});

test('listDir：内置忽略项不出现在结果里，计入 hidden', () => {
  const { root, cleanup } = makeProject();
  try {
    write(root, 'src/a.ts', 'a');
    for (const ignored of DEFAULT_IGNORES) {
      write(root, `${ignored}/x.txt`, 'x');
    }
    const r = svc().listDir(root, '');
    assert.ok(r.ok);
    const names = r.data.nodes.map((n) => n.name);
    for (const ignored of DEFAULT_IGNORES) {
      assert.ok(!names.includes(ignored), `忽略项 ${ignored} 不应出现`);
    }
    assert.equal(names.includes('src'), true);
    assert.equal(r.data.hidden, DEFAULT_IGNORES.length);
  } finally {
    cleanup();
  }
});

test('listDir：对文件调用返回 6105，对不存在路径返回 6104', () => {
  const { root, cleanup } = makeProject();
  try {
    write(root, 'a.ts', 'a');
    const s = svc();
    const onFile = s.listDir(root, 'a.ts');
    assert.ok(!onFile.ok && onFile.code === FILE_ERROR.NOT_A_DIRECTORY);
    const missing = s.listDir(root, 'nope');
    assert.ok(!missing.ok && missing.code === FILE_ERROR.NOT_FOUND);
  } finally {
    cleanup();
  }
});

test('listDir：项目未注册返回 6102', () => {
  const { root, cleanup } = makeProject();
  try {
    const r = svc(() => false).listDir(root, '');
    assert.ok(!r.ok && r.code === FILE_ERROR.PROJECT_NOT_FOUND);
  } finally {
    cleanup();
  }
});

// ── 路径越界（安全核心）──────────────────────────────────────────────────────

test('resolveInside：../ 穿越被 6103 拒绝', () => {
  const { root, cleanup } = makeProject();
  try {
    fs.writeFileSync(path.join(path.dirname(root), 'secret.txt'), 'TOP SECRET');
    const r = resolveInside(root, '../secret.txt');
    assert.ok(!r.ok && r.code === FILE_ERROR.PATH_ESCAPE);
  } finally {
    cleanup();
  }
});

test('resolveInside：绝对路径 / 盘符 / UNC 前缀均被 6103 拒绝', () => {
  const { root, cleanup } = makeProject();
  try {
    for (const evil of ['/etc/passwd', 'C:/Windows/win.ini', 'D:\\secrets', '\\\\server\\share\\x']) {
      const r = resolveInside(root, evil);
      assert.ok(!r.ok && r.code === FILE_ERROR.PATH_ESCAPE, `应拒绝: ${evil}（实得 ${JSON.stringify(r)}）`);
    }
  } finally {
    cleanup();
  }
});

test('resolveInside：符号链接指向项目外被 6103 拒绝（词法挡不住这一种）', () => {
  const { root, cleanup } = makeProject();
  const outside = makeProject();
  try {
    const secret = path.join(outside.root, 'secret.txt');
    fs.writeFileSync(secret, 'TOP SECRET');
    // Windows 创建文件符号链接需开发者模式/管理员，普通 CI 会 EPERM；故在 win32
    // 改用「目录 junction + 往里穿一层」，同样能证明 realpath 那一道闸门必需。
    if (process.platform === 'win32') {
      fs.symlinkSync(outside.root, path.join(root, 'link'), 'junction');
      const r = resolveInside(root, 'link/secret.txt');
      assert.ok(!r.ok && r.code === FILE_ERROR.PATH_ESCAPE);
      const read = svc().readFile(root, 'link/secret.txt');
      assert.ok(!read.ok && read.code === FILE_ERROR.PATH_ESCAPE);
    } else {
      fs.symlinkSync(secret, path.join(root, 'sneaky.txt'));
      // 词法判定会认为 sneaky.txt 在项目内 —— 这一层证明 realpath 那一道是必需的
      const r = resolveInside(root, 'sneaky.txt');
      assert.ok(!r.ok && r.code === FILE_ERROR.PATH_ESCAPE);
      // 端到端：经 readFile 也拿不到内容
      const read = svc().readFile(root, 'sneaky.txt');
      assert.ok(!read.ok && read.code === FILE_ERROR.PATH_ESCAPE);
    }
  } finally {
    cleanup();
    outside.cleanup();
  }
});

test('resolveInside：junction 指向项目外时，其下的文件同样被拒', () => {
  const { root, cleanup } = makeProject();
  const outside = makeProject();
  try {
    fs.writeFileSync(path.join(outside.root, 'passwd'), 'x');
    fs.symlinkSync(outside.root, path.join(root, 'link-dir'), 'junction');
    const r = resolveInside(root, 'link-dir/passwd');
    assert.ok(!r.ok && r.code === FILE_ERROR.PATH_ESCAPE);
  } finally {
    cleanup();
    outside.cleanup();
  }
});

test('readFile：越界时不返回任何内容（data 为 null）', () => {
  const { root, cleanup } = makeProject();
  try {
    const r: FileResult<unknown> = svc().readFile(root, '../../../../../../etc/passwd');
    assert.ok(!r.ok);
    assert.equal(r.code, FILE_ERROR.PATH_ESCAPE);
  } finally {
    cleanup();
  }
});

// ── readFile ────────────────────────────────────────────────────────────────

test('readFile：正常 UTF-8 返回内容 + 行数 + LF 判定', () => {
  const { root, cleanup } = makeProject();
  try {
    write(root, 'a.ts', 'line1\nline2\nline3\n');
    const r = svc().readFile(root, 'a.ts');
    assert.ok(r.ok);
    assert.equal(r.data.content, 'line1\nline2\nline3\n');
    assert.equal(r.data.lineCount, 3);
    assert.equal(r.data.totalLines, 3);
    assert.equal(r.data.eol, 'lf');
    assert.equal(r.data.binary, false);
    assert.equal(r.data.truncated, false);
    assert.equal(r.data.truncatedBy, null);
    assert.equal(r.data.name, 'a.ts');
  } finally {
    cleanup();
  }
});

test('readFile：CRLF 正确识别，末行无换行时行数不虚增', () => {
  const { root, cleanup } = makeProject();
  try {
    write(root, 'crlf.txt', 'a\r\nb\r\nc');
    const r = svc().readFile(root, 'crlf.txt');
    assert.ok(r.ok);
    assert.equal(r.data.eol, 'crlf');
    assert.equal(r.data.lineCount, 3);
  } finally {
    cleanup();
  }
});

test('readFile：二进制文件返回 binary=true 且 content 为空串', () => {
  const { root, cleanup } = makeProject();
  try {
    const abs = path.join(root, 'logo.png');
    fs.writeFileSync(abs, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]));
    const r = svc().readFile(root, 'logo.png');
    assert.ok(r.ok);
    assert.equal(r.data.binary, true);
    assert.equal(r.data.content, '');
    assert.equal(r.data.truncated, false);
  } finally {
    cleanup();
  }
});

test('looksBinary：NUL 字节与非法 UTF-8 占比都判二进制', () => {
  assert.equal(looksBinary(Buffer.from('plain text'), '.txt'), false);
  assert.equal(looksBinary(Buffer.from([0x61, 0x00, 0x62]), '.txt'), true);
  // 扩展名白名单：不看内容也判二进制
  assert.equal(looksBinary(Buffer.from('actually text'), '.png'), true);
  // 无 NUL 但非法 UTF-8 占比高
  assert.equal(looksBinary(Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa]), '.dat'), true);
});

test('readFile：超行数上限时按行边界截断，totalLines 保留真实值', () => {
  const { root, cleanup } = makeProject();
  try {
    const body = Array.from({ length: MAX_READ_LINES + 200 }, (_, i) => `line ${i}`).join('\n');
    write(root, 'big.ts', body);
    const r = svc().readFile(root, 'big.ts');
    assert.ok(r.ok);
    assert.equal(r.data.truncated, true);
    assert.equal(r.data.truncatedBy, 'lines');
    assert.equal(r.data.lineCount, MAX_READ_LINES);
    assert.equal(r.data.totalLines, MAX_READ_LINES + 200);
    // 截断不得腰斩成半个 token：末行必须是完整的一行
    const last = r.data.content.split('\n').at(-1);
    assert.equal(last, `line ${MAX_READ_LINES - 1}`);
  } finally {
    cleanup();
  }
});

test('readFile：文件已删除返回 6104（UI 据此把标签页标记失效）', () => {
  const { root, cleanup } = makeProject();
  try {
    const r = svc().readFile(root, 'ghost.ts');
    assert.ok(!r.ok && r.code === FILE_ERROR.NOT_FOUND);
  } finally {
    cleanup();
  }
});

test('readFile：对目录调用返回 6106', () => {
  const { root, cleanup } = makeProject();
  try {
    fs.mkdirSync(path.join(root, 'dir'));
    const r = svc().readFile(root, 'dir');
    assert.ok(!r.ok && r.code === FILE_ERROR.NOT_A_FILE);
  } finally {
    cleanup();
  }
});

// ── searchFiles ─────────────────────────────────────────────────────────────

test('searchFiles：按文件名子串匹配，大小写不敏感；目录名不参与匹配', () => {
  const { root, cleanup } = makeProject();
  try {
    write(root, 'src/App.vue', '');
    write(root, 'src/components/app/Child.vue', '');
    write(root, 'src/main.ts', '');
    const r = svc().searchFiles(root, 'app');
    assert.ok(r.ok);
    // 只匹配文件名：Child.vue 的文件名不含 app（app 是它的父目录名）→ 不命中。
    // 这条断言锁的是「本期不做路径/内容搜索」的范围边界，不是 bug。
    assert.deepEqual(r.data.files, ['src/App.vue']);
  } finally {
    cleanup();
  }
});

test('searchFiles：空 query 不扫盘直接返回空', () => {
  const { root, cleanup } = makeProject();
  try {
    write(root, 'a.ts', 'a');
    const r = svc().searchFiles(root, '   ');
    assert.ok(r.ok);
    assert.deepEqual(r.data.files, []);
  } finally {
    cleanup();
  }
});

test('searchFiles：命中被忽略目录内的文件不返回', () => {
  const { root, cleanup } = makeProject();
  try {
    write(root, 'src/a.ts', 'a');
    write(root, 'node_modules/pkg/a.ts', 'a');
    const r = svc().searchFiles(root, 'a.ts');
    assert.ok(r.ok);
    assert.deepEqual(r.data.files, ['src/a.ts']);
  } finally {
    cleanup();
  }
});

// ── ignore 匹配器 ───────────────────────────────────────────────────────────

test('ignore：.gitignore 生效，含锚定与 ! 取反', () => {
  const { root, cleanup } = makeProject();
  try {
    write(root, '.gitignore', ['# comment', 'secret.txt', '/root-only.txt', 'build/', '*.log', '!keep.log', ''].join('\n'));
    write(root, 'visible.ts', '');
    write(root, 'secret.txt', '');
    write(root, 'root-only.txt', '');
    write(root, 'nested/root-only.txt', '');
    write(root, 'build/out.js', '');
    write(root, 'debug.log', '');
    write(root, 'keep.log', '');

    const r = svc().listDir(root, '');
    assert.ok(r.ok);
    const names = r.data.nodes.map((n) => n.name);
    assert.ok(names.includes('visible.ts'));
    assert.ok(!names.includes('secret.txt'), 'basename 模式应命中任意层级');
    assert.ok(!names.includes('root-only.txt'), '/ 前缀=锚定根');
    assert.ok(!names.includes('build'), '目录剪枝');
    assert.ok(!names.includes('debug.log'));
    assert.ok(names.includes('keep.log'), '! 取反应恢复');

    // 锚定语义：nested/root-only.txt 不该被 '/root-only.txt' 命中
    const nested = svc().listDir(root, 'nested');
    assert.ok(nested.ok);
    assert.ok(nested.data.nodes.some((n) => n.name === 'root-only.txt'));
  } finally {
    cleanup();
  }
});

test('ignore：compileIgnoreMatcher 通配与 ** 语义', () => {
  const m = compileIgnoreMatcher(['*.min.js', 'docs/**', 'temp?/*.txt', 'a/b/c.log']);
  assert.equal(m.ignores('lib/x.min.js', false), true);
  assert.equal(m.ignores('lib/x.js', false), false);
  assert.equal(m.ignores('docs/a/b/c.md', false), true);
  assert.equal(m.ignores('docsx/a.md', false), false);
  assert.equal(m.ignores('temp1/x.txt', false), true);
  assert.equal(m.ignores('temp12/x.txt', false), false);
  // 中部含 / → 锚定
  assert.equal(m.ignores('z/a/b/c.log', false), false);
  assert.equal(m.ignores('a/b/c.log', false), true);
  // `docs/**` 连目录本身一起剪掉（git 原义只匹配目录「内部」，但在文件树里保留一个
  // 永远为空的 docs 节点没有意义，故整棵剪）——这与 VSCode 资源管理器一致
  assert.equal(m.prunesDir('docs'), true);
  assert.equal(m.ignores('docs', false), true);
});

test('ignore：目录专属规则（尾随 /）不误伤同名文件', () => {
  const m = compileIgnoreMatcher(['build/']);
  assert.equal(m.prunesDir('build'), true);
  // 名为 build 的「文件」不是目录，dirOnly 规则应跳过
  assert.equal(m.ignores('build', false), false);
  assert.equal(m.ignores('build/out.js', false), false, '子项靠 prunesDir 剪枝，无需逐项规则');
});

test('ignore：项目根 .gitignore 变更后 invalidate 可刷新', () => {
  const { root, cleanup } = makeProject();
  try {
    write(root, '.gitignore', 'hidden.txt\n');
    write(root, 'hidden.txt', '');
    const s = svc();
    const before = s.listDir(root, '');
    assert.ok(before.ok);
    assert.equal(before.data.nodes.some((n) => n.name === 'hidden.txt'), false);

    fs.writeFileSync(path.join(root, '.gitignore'), '');
    s.invalidate(root);
    const after = s.listDir(root, '');
    assert.ok(after.ok);
    assert.equal(after.data.nodes.some((n) => n.name === 'hidden.txt'), true);
  } finally {
    cleanup();
  }
});

// ── 工具函数 ────────────────────────────────────────────────────────────────

test('normalizeRelPath：Windows 与 POSIX 分隔符统一，. 与空段丢弃', () => {
  assert.equal(normalizeRelPath('packages\\forge-ui\\src'), 'packages/forge-ui/src');
  assert.equal(normalizeRelPath('./a//b/./c'), 'a/b/c');
  assert.equal(normalizeRelPath(''), '');
  assert.equal(normalizeRelPath('/'), '');
});
