/**
 * skillService（模块 09）单元测试，对应 AC-09-01/02/05/06/07/09/11/12。
 *
 * - listSkills：fake loader 映射（scope/dirPath/diagnostics 透传）+ 影子扫描补报
 *   未加载子项（AC-09-02）+ loader 抛错 → 5000 降级
 * - importSkill：合法导入落目标根直接子目录；无 SKILL.md 拒绝（AC-09-05）；
 *   同名冲突 4090 → overwrite=true 旧目录进回收站再导新（AC-09-06）；
 *   项目作用域缺 projectPath 拒绝（AC-09-07）
 * - createSkill：name 安全校验（AC-09-09）+ 模板写入回读验证（AC-09-08）
 * - deleteSkill：根外/穿越路径服务端拒绝（AC-09-11）；回收站优先、失败回退
 *   永久删除；不存在 → 1002
 *
 * 文件系统操作用真实临时目录（agentDir/homeDir 全部注入 tmp，隔离真实用户目录）；
 * trashItem 用 fake 记录调用。node --experimental-strip-types --test。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createSkillMethods,
  type LoaderDiagnosticRecord,
  type SkillLoaderLike,
  type SkillMethodTable,
} from '../../src/pi/skillService.ts';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-skill-'));
}

function writeSkill(dir: string, name: string, description: string, body = 'content'): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`,
    'utf8',
  );
}

function harness(options: {
  loader?: SkillLoaderLike;
  trashFails?: boolean;
} = {}) {
  const root = makeTempDir();
  const agentDir = path.join(root, 'agent');
  const homeDir = path.join(root, 'home');
  const trashed: string[] = [];
  const methods: SkillMethodTable = createSkillMethods({
    agentDir,
    homeDir,
    loaderFactory: () =>
      options.loader ?? {
        async reload() {},
        getSkills: () => ({ skills: [], diagnostics: [] }),
      },
    trashItem: async (targetPath) => {
      if (options.trashFails) throw new Error('recycle bin unavailable');
      trashed.push(targetPath);
      // 模拟真实回收站语义：路径从原位置消失（shell.trashItem 会移走目录）
      fs.rmSync(targetPath, { recursive: true, force: true });
    },
  });
  return { root, agentDir, homeDir, methods, trashed };
}

/** fake loader：仅提供 name/filePath/baseDir（+可选 scope/description），其余字段补默认 */
function fakeLoader(
  skills: Array<{
    name: string;
    filePath: string;
    baseDir: string;
    scope?: string;
    description?: string;
  }>,
  diagnostics: LoaderDiagnosticRecord[] = [],
): SkillLoaderLike {
  return {
    async reload() {},
    getSkills: () => ({
      skills: skills.map((s) => ({
        description: s.description ?? 'd',
        disableModelInvocation: false,
        name: s.name,
        filePath: s.filePath,
        baseDir: s.baseDir,
        sourceInfo: { scope: s.scope ?? 'user' },
      })),
      diagnostics,
    }),
  };
}

// ---------------------------------------------------------------------------
// listSkills
// ---------------------------------------------------------------------------

test('listSkills：loader 记录映射为 SkillEntry（scope/dirPath/filePath），诊断透传含 collision', async () => {
  const { methods, root } = harness({
    loader: fakeLoader(
      [
        { name: 'git-push', filePath: path.join('C:/x/skills/git-push', 'SKILL.md'), baseDir: 'C:/x/skills/git-push' },
        { name: 'pdf', filePath: 'P/SKILL.md', baseDir: 'P', scope: 'project' },
        { name: 'tmp-one', filePath: 'T/SKILL.md', baseDir: 'T', scope: 'temporary' },
      ],
      [
        {
          type: 'collision',
          message: 'name "pdf" collision',
          path: 'LOSER/SKILL.md',
          collision: { resourceType: 'skill', winnerPath: 'P/SKILL.md', loserPath: 'LOSER/SKILL.md' },
        },
      ],
    ),
  });
  try {
    const res = await methods['skill/listSkills']({});
    assert.equal(res.code, 0);
    const data = res.data as { skills: Array<Record<string, unknown>>; issues: Array<Record<string, unknown>> };
    assert.deepEqual(
      data.skills.map((s) => [s.name, s.scope, s.dirPath]),
      [
        ['git-push', 'user', 'C:/x/skills/git-push'],
        ['pdf', 'project', 'P'],
        ['tmp-one', 'other', 'T'],
      ],
    );
    assert.equal(data.issues.length, 1);
    assert.equal(data.issues[0]?.type, 'collision');
    assert.equal(data.issues[0]?.winnerPath, 'P/SKILL.md');
    assert.equal(data.issues[0]?.loserPath, 'LOSER/SKILL.md');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('listSkills：影子扫描把根内未加载子目录报为 warning 诊断（AC-09-02，不静默吞）', async () => {
  const runRoot = makeTempDir();
  const agentDir = path.join(runRoot, 'agent');
  const loaderSkillsRoot = path.join(agentDir, 'skills');
  writeSkill(path.join(loaderSkillsRoot, 'good-one'), 'good-one', 'ok');
  fs.mkdirSync(path.join(loaderSkillsRoot, 'broken-dir', 'nested'), { recursive: true }); // 无 SKILL.md
  const methods = createSkillMethods({
    agentDir,
    homeDir: path.join(runRoot, 'home'), // 不存在 → 影子扫描零贡献
    loaderFactory: () =>
      fakeLoader([
        {
          name: 'good-one',
          filePath: path.join(loaderSkillsRoot, 'good-one', 'SKILL.md'),
          baseDir: path.join(loaderSkillsRoot, 'good-one'),
        },
      ]),
  });
  try {
    const res = await methods['skill/listSkills']({});
    assert.equal(res.code, 0);
    const data = res.data as { skills: unknown[]; issues: Array<{ type: string; message: string; path: string | null }> };
    assert.equal(data.skills.length, 1);
    // 恰 1 条影子诊断且指向 broken-dir（good-one 已被 loader 覆盖）
    assert.equal(data.issues.length, 1);
    assert.equal(data.issues[0]?.type, 'warning');
    assert.ok(data.issues[0]?.path?.endsWith('broken-dir'), `诊断路径: ${data.issues[0]?.path}`);
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test('listSkills：loader 抛错 → 5000 信封不崩溃（F01 异常降级）', async () => {
  const { methods, root } = harness({
    loader: {
      reload: () => Promise.reject(new Error('boom')),
      getSkills: () => ({ skills: [], diagnostics: [] }),
    },
  });
  try {
    const res = await methods['skill/listSkills']({});
    assert.equal(res.code, 5000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// importSkill
// ---------------------------------------------------------------------------

test('importSkill：合法目录导入 user 作用域落到 <agentDir>/skills 直接子目录', async () => {
  const { methods, agentDir, root } = harness();
  try {
    const src = path.join(root, 'src', 'my-skill');
    writeSkill(src, 'my-skill', '导入测试');
    const res = await methods['skill/importSkill']({ scope: 'user', sourceDir: src });
    assert.equal(res.code, 0);
    const dest = path.join(agentDir, 'skills', 'my-skill');
    assert.equal((res.data as { path: string }).path, dest);
    assert.ok(fs.existsSync(path.join(dest, 'SKILL.md')));
    // 原子落位：临时目录已清理
    assert.deepEqual(
      fs.readdirSync(path.join(agentDir, 'skills')).filter((n) => n.startsWith('.forge-import')),
      [],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('importSkill：无 SKILL.md 源目录拒绝且给原因（AC-09-05）；frontmatter 坏同样拒', async () => {
  const { methods, root } = harness();
  try {
    const empty = path.join(root, 'src-empty');
    fs.mkdirSync(empty, { recursive: true });
    const res1 = await methods['skill/importSkill']({ scope: 'user', sourceDir: empty });
    assert.equal(res1.code, 1001);

    const bad = path.join(root, 'src-bad');
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, 'SKILL.md'), '---\nname: x\n---\n无描述\n', 'utf8');
    const res2 = await methods['skill/importSkill']({ scope: 'user', sourceDir: bad });
    assert.equal(res2.code, 1001);
    assert.ok(res2.message.includes('拒绝导入'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('importSkill：多 skill 父目录 → 拒并点名子目录引导单选（一次一个）', async () => {
  const { methods, root } = harness();
  try {
    const parent = path.join(root, 'src-parent');
    writeSkill(path.join(parent, 'alpha'), 'alpha', 'A');
    writeSkill(path.join(parent, 'beta'), 'beta', 'B');
    const res = await methods['skill/importSkill']({ scope: 'user', sourceDir: parent });
    assert.equal(res.code, 1001);
    assert.ok(res.message.includes('一次只能导入一个'), res.message);
    assert.ok(res.message.includes('alpha') && res.message.includes('beta'), res.message);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('importSkill：自身含 SKILL.md 但也有 skill 子目录 → 同样拒（一次一个，防整树带入）', async () => {
  const { methods, agentDir, root } = harness();
  try {
    const parent = path.join(root, 'src-pack');
    writeSkill(parent, 'pack-root', '父层也有 SKILL.md');
    writeSkill(path.join(parent, 'gamma'), 'gamma', 'G');
    const res = await methods['skill/importSkill']({ scope: 'user', sourceDir: parent });
    assert.equal(res.code, 1001);
    assert.ok(res.message.includes('一次只能导入一个'), res.message);
    assert.ok(res.message.includes('还包含'), res.message);
    assert.ok(res.message.includes('gamma'), res.message);
    assert.equal(fs.existsSync(path.join(agentDir, 'skills', 'src-pack')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('importSkill：同名冲突返回 4090+conflictPath；overwrite=true 旧目录进回收站再导新（AC-09-06）', async () => {
  const { methods, agentDir, root, trashed } = harness();
  try {
    const src = path.join(root, 'src', 'dup-skill');
    writeSkill(src, 'dup-skill', '新版本');
    const dest = path.join(agentDir, 'skills', 'dup-skill');
    writeSkill(dest, 'dup-skill', '旧版本');

    const conflict = await methods['skill/importSkill']({ scope: 'user', sourceDir: src });
    assert.equal(conflict.code, 4090);
    assert.equal((conflict.data as { conflictPath: string }).conflictPath, dest);
    // 未确认：一切不变（AC-09-12 语义）
    assert.ok(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8').includes('旧版本'));
    assert.deepEqual(trashed, []);

    const overwrite = await methods['skill/importSkill']({ scope: 'user', sourceDir: src, overwrite: true });
    assert.equal(overwrite.code, 0);
    assert.deepEqual(trashed, [dest]);
    assert.ok(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8').includes('新版本'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('importSkill：项目作用域落到 <project>/.agents/skills；缺 projectPath 拒绝（AC-09-07）', async () => {
  const { methods, root } = harness();
  try {
    const proj = path.join(root, 'proj');
    const src = path.join(root, 'src', 'proj-skill');
    writeSkill(src, 'proj-skill', '项目级');
    const res = await methods['skill/importSkill']({ scope: 'project', sourceDir: src, projectPath: proj });
    assert.equal(res.code, 0);
    assert.ok(fs.existsSync(path.join(proj, '.agents', 'skills', 'proj-skill', 'SKILL.md')));
    const missing = await methods['skill/importSkill']({ scope: 'project', sourceDir: src });
    assert.equal(missing.code, 1001);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('importSkill：源目录 == 目标根拒绝（自我复制守卫）', async () => {
  const { methods, agentDir, root } = harness();
  try {
    fs.mkdirSync(path.join(agentDir, 'skills'), { recursive: true });
    const res = await methods['skill/importSkill']({ scope: 'user', sourceDir: path.join(agentDir, 'skills') });
    assert.equal(res.code, 1001);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// createSkill
// ---------------------------------------------------------------------------

test('createSkill：生成标准 SKILL.md 且 pi 回读识别，中文正文保留（AC-09-08）', async () => {
  const { methods, agentDir, root } = harness();
  try {
    const res = await methods['skill/createSkill']({
      scope: 'user',
      name: 'my-new-skill',
      description: '这是一个: 含冒号"和引号"的描述',
      body: '第一步：做这件事\n第二步：做那件事',
    });
    assert.equal(res.code, 0);
    const file = path.join(agentDir, 'skills', 'my-new-skill', 'SKILL.md');
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(raw.startsWith('---\nname: "my-new-skill"'));
    assert.ok(raw.includes('第一步：做这件事'));
    assert.equal((res.data as { name: string }).name, 'my-new-skill');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('createSkill：非法 name（大写/空格/.. /-开头/中文）与空描述即时拒绝（AC-09-09）', async () => {
  const { methods, root } = harness();
  try {
    for (const name of ['My-Skill', 'my skill', '../evil', '-abc', '技能']) {
      const res = await methods['skill/createSkill']({ scope: 'user', name, description: 'd' });
      assert.equal(res.code, 1001, `name=${name} 应被拒绝`);
    }
    const noDesc = await methods['skill/createSkill']({ scope: 'user', name: 'ok-name', description: '  ' });
    assert.equal(noDesc.code, 1001);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('createSkill：同名目录存在 → 4090；未确认不产生任何文件系统变化', async () => {
  const { methods, agentDir, root } = harness();
  try {
    const dest = path.join(agentDir, 'skills', 'exist-skill');
    writeSkill(dest, 'exist-skill', '旧');
    const res = await methods['skill/createSkill']({ scope: 'user', name: 'exist-skill', description: '新' });
    assert.equal(res.code, 4090);
    assert.ok(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8').includes('旧'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// deleteSkill
// ---------------------------------------------------------------------------

test('deleteSkill：根内直接子目录 → 优先回收站（trashItem 收到精确路径）', async () => {
  const { methods, agentDir, root, trashed } = harness();
  try {
    const dest = path.join(agentDir, 'skills', 'gone-skill');
    writeSkill(dest, 'gone-skill', 'd');
    const res = await methods['skill/deleteSkill']({ path: dest });
    assert.equal(res.code, 0);
    assert.equal((res.data as { trashed: boolean }).trashed, true);
    assert.deepEqual(trashed, [dest]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('deleteSkill：trashItem 失败回退永久删除并如实标记 trashed=false（TD-SK-04）', async () => {
  const { methods, agentDir, root } = harness({ trashFails: true });
  try {
    const dest = path.join(agentDir, 'skills', 'hard-gone');
    writeSkill(dest, 'hard-gone', 'd');
    const res = await methods['skill/deleteSkill']({ path: dest });
    assert.equal(res.code, 0);
    assert.equal((res.data as { trashed: boolean }).trashed, false);
    assert.ok(!fs.existsSync(dest));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('deleteSkill：根外路径/穿越/嵌套子目录/缺失 path 全部服务端拒绝（AC-09-11）', async () => {
  const { methods, agentDir, homeDir, root } = harness();
  try {
    fs.mkdirSync(path.join(agentDir, 'skills'), { recursive: true });
    const cases: unknown[] = [
      { path: homeDir }, // 用户主目录（非任何根的直接子项）
      { path: path.join(agentDir, 'skills', 'skills', '..', '..', '..', '..') }, // .. 穿越（resolve 后仍在根内？agentDir/skills 上跳 4 级到 tmp）
      { path: root }, // 临时根本身
      { path: path.join(agentDir, 'settings.json') }, // agentDir 内非 skill 文件
    ];
    for (const params of cases) {
      const res = await methods['skill/deleteSkill'](params);
      assert.equal(res.code, 1001, `${JSON.stringify(params)} 应被拒绝`);
    }
    // 嵌套孙目录（非直接子项）拒绝
    const deep = path.join(agentDir, 'skills', 'outer', 'inner');
    fs.mkdirSync(deep, { recursive: true });
    const deepRes = await methods['skill/deleteSkill']({ path: deep });
    assert.equal(deepRes.code, 1001);
    // 缺 path 参数
    const noPath = await methods['skill/deleteSkill']({});
    assert.equal(noPath.code, 1001);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('deleteSkill：项目根直接子目录允许（含 .pi 与 .agents 两根）；不存在的目标 → 1002', async () => {
  const { methods, root } = harness();
  try {
    const proj = path.join(root, 'proj');
    const inPi = path.join(proj, '.pi', 'skills', 's1');
    const inAgents = path.join(proj, '.agents', 'skills', 's2');
    writeSkill(inPi, 's1', 'd');
    writeSkill(inAgents, 's2', 'd');
    const r1 = await methods['skill/deleteSkill']({ path: inPi, projectPath: proj });
    assert.equal(r1.code, 0);
    const r2 = await methods['skill/deleteSkill']({ path: inAgents, projectPath: proj });
    assert.equal(r2.code, 0);
    // 不带 projectPath：项目根条目不可删（containment 失败）
    const r3 = await methods['skill/deleteSkill']({ path: path.join(proj, '.pi', 'skills', 's3') });
    assert.ok(r3.code === 1001 || r3.code === 1002);
    // 不存在（重复删除第二次）→ 1002 不报成功
    const r4 = await methods['skill/deleteSkill']({ path: inPi, projectPath: proj });
    assert.equal(r4.code, 1002);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('deleteSkill：符号链接指向根外 → 拒绝（realpath 复核）', { skip: process.platform === 'win32' && !process.env.FORGE_TEST_SYMLINK }, async () => {
  const { methods, agentDir, root } = harness();
  try {
    const outside = path.join(root, 'outside-target');
    fs.mkdirSync(outside, { recursive: true });
    const link = path.join(agentDir, 'skills', 'evil-link');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(outside, link, 'dir');
    const res = await methods['skill/deleteSkill']({ path: link });
    assert.equal(res.code, 1001);
    assert.ok(fs.existsSync(outside), '外部目标目录不得被删除');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
