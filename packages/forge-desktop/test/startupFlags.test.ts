/**
 * 启动特征判定（startupFlags.ts）单测。
 *
 * 锁的是「三态互斥」这一条产品口径：首次使用指引只在全新安装首启自动出现，版本更新说明
 * 只在升级后首启自动弹出，两者都不能在平运行时冒出来。判定的输入只有
 * `lastRunForgeVersion`（null / 旧版本 / 当前版本）三种取值，所以按三态逐一断言即可。
 *
 * 为什么判定必须在主进程同步段做：startupUpdate 联动会异步把 lastRunForgeVersion 改写为
 * 当前版本，本函数对此无感知——它只负责把快照翻译成人话，因此测试也只覆盖翻译本身。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveStartupFlags } from '../src/startupFlags.ts';

const CURRENT = '0.2.3';

test('lastRunForgeVersion=null → 全新安装首启，不算升级', () => {
  assert.deepStrictEqual(resolveStartupFlags(null, CURRENT), {
    isFreshInstall: true,
    isUpgradeRun: false,
  });
});

test('上次版本落后于当前版本 → 升级后首启，不算新装', () => {
  assert.deepStrictEqual(resolveStartupFlags('0.2.2', CURRENT), {
    isFreshInstall: false,
    isUpgradeRun: true,
  });
});

test('上次版本等于当前版本 → 平运行，两者都不触发', () => {
  assert.deepStrictEqual(resolveStartupFlags(CURRENT, CURRENT), {
    isFreshInstall: false,
    isUpgradeRun: false,
  });
});

test('上次版本比当前版本更新（回滚安装包）→ 仍按升级处理，指引不重弹', () => {
  assert.deepStrictEqual(resolveStartupFlags('0.3.0', CURRENT), {
    isFreshInstall: false,
    isUpgradeRun: true,
  });
});

test('空字符串版本不算新装（只有 null 才是首次运行）', () => {
  assert.deepStrictEqual(resolveStartupFlags('', CURRENT), {
    isFreshInstall: false,
    isUpgradeRun: true,
  });
});
