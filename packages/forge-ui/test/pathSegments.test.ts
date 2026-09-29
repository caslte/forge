/**
 * collapseDotSegments 单测（正斜杠路径的 . / .. 段词法折叠）。
 *
 * 覆盖：工具入参 ./ 前缀与项目根拼接产生的中间 . 段（Windows 弹「找不到文件」的
 * 实际场景）、普通 .. 回退、绝对路径在根/盘符处截停 ..、相对路径顶部 .. 保留、
 * 盘符 / POSIX 绝对 / UNC 前缀识别、空与重复斜杠。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { collapseDotSegments } from '../src/utils/pathSegments.ts';

test('collapseDotSegments: 折叠项目根拼接产生的中间 . 段（实际 bug 场景）', () => {
  assert.equal(
    collapseDotSegments('C:/root/deploy-v2/./yewu/swift/build_docker.sh'),
    'C:/root/deploy-v2/yewu/swift/build_docker.sh',
  );
});

test('collapseDotSegments: 开头 ./ 前缀与重复 . 段', () => {
  assert.equal(collapseDotSegments('./yewu/swift/a.ts'), 'yewu/swift/a.ts');
  assert.equal(collapseDotSegments('C:/a/./b/./c'), 'C:/a/b/c');
});

test('collapseDotSegments: .. 段回退上一段', () => {
  assert.equal(collapseDotSegments('C:/a/b/../c.ts'), 'C:/a/c.ts');
  assert.equal(collapseDotSegments('a/b/../../c'), 'c');
});

test('collapseDotSegments: 绝对路径 .. 在根/盘符处截停', () => {
  assert.equal(collapseDotSegments('C:/../outside'), 'C:/outside');
  assert.equal(collapseDotSegments('C:/a/../../outside'), 'C:/outside');
  assert.equal(collapseDotSegments('/../outside'), '/outside');
  assert.equal(collapseDotSegments('//server/share/../outside'), '//server/outside');
});

test('collapseDotSegments: 相对路径顶部 .. 保留原样', () => {
  assert.equal(collapseDotSegments('../foo/a.ts'), '../foo/a.ts');
  assert.equal(collapseDotSegments('../../foo/./a.ts'), '../../foo/a.ts');
});

test('collapseDotSegments: 前缀识别（盘符 / POSIX / UNC）与重复斜杠', () => {
  assert.equal(collapseDotSegments('D:/work/aiwork/forge/packages/x.ts'), 'D:/work/aiwork/forge/packages/x.ts');
  assert.equal(collapseDotSegments('/usr/local/./bin'), '/usr/local/bin');
  assert.equal(collapseDotSegments('//srv/share/./a'), '//srv/share/a');
  assert.equal(collapseDotSegments('C://a///b'), 'C:/a/b');
});

test('collapseDotSegments: 空串与无段路径原样', () => {
  assert.equal(collapseDotSegments(''), '');
  assert.equal(collapseDotSegments('a.ts'), 'a.ts');
});
