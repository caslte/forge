/**
 * 版本更新说明（updater/getReleaseNotes | updater/markNotesShown）。
 *
 * 数据源：release.mjs 发布时生成的 release-notes.md——打包产物经 electron-builder
 * extraResources 落在 resources/（asar 外），dev 回退仓库内包目录同名文件。
 * 消费场景：
 * - 升级后首次启动自动弹「已更新到 x.y.z」（shouldShow 门控，UI useWhatsNew 消费）
 * - 设置「关于」页「查看本次更新说明」随时回看（只依赖 markdown，不看 shouldShow）
 *
 * 只弹一次口径（三层门控，全部满足才弹）：
 * 1. markdown 存在（安装包未携带说明 = 无法展示）
 * 2. isUpgradeRun —— 本次启动是「升级启动」。该快照由 main.ts 在启动链早期同步采集
 *    （lastRunForgeVersion 非 null 且 ≠ 当前版本）：startupUpdate 联动阶段会异步把
 *    lastRunForgeVersion 改写为当前版本，RPC 时刻再读就分不出「升级」与「平运行」；
 *    全新安装（lastRunForgeVersion=null）不算升级，不弹
 * 3. lastShownNotesVersion ≠ 当前版本（updater-state.json；弹窗打开即回写，
 *    关掉/崩溃/联动更新失败都不重弹）
 *
 * 全部容错：文件缺失/状态文件损坏按 markdown=null / shouldShow=false 降级，绝不抛出
 * （与 updaterState.ts 的降级口径一致）。
 */
import fs from 'node:fs';
import type { RpcResult } from '@forge/core';
import { readUpdaterState, writeUpdaterState } from './updaterState.ts';

/** updater/getReleaseNotes 响应 data（渲染层 bridge.ReleaseNotesPayload 同构） */
export interface ReleaseNotesPayload {
  /** 说明对应的 forge 版本（=当前版本） */
  version: string;
  /** Markdown 原文；null = 安装包未携带说明（异常/极老安装包） */
  markdown: string | null;
  /** 是否应自动弹出（升级首启且本版本未展示过）；关于页回看只看 markdown */
  shouldShow: boolean;
}

/** 可注入依赖（测试传 fake readTextFile / 临时 statePath） */
export interface ReleaseNotesDeps {
  currentVersion: string;
  /** 本次启动是否「升级启动」（main.ts whenReady 同步采集的快照） */
  isUpgradeRun: boolean;
  /** 说明文件绝对路径；null = 无法定位（markdown=null） */
  notesFilePath: string | null;
  /** updater-state.json 路径；null = 跳过持久化（视为未展示过） */
  statePath: string | null;
  /** 读文件端口（测试注入）；缺省同步 fs + 全容错 */
  readTextFile?: (filePath: string) => string | null;
}

/** 缺省读文件：同步 fs，任何异常返回 null（启动路径小文件，与 updaterState.ts 同口径） */
function defaultReadTextFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/** 读包内更新说明 Markdown；文件缺失/读取失败/纯空白返回 null */
export function readReleaseNotesMarkdown(deps: ReleaseNotesDeps): string | null {
  if (deps.notesFilePath === null) return null;
  const markdown = (deps.readTextFile ?? defaultReadTextFile)(deps.notesFilePath)?.trim() ?? '';
  return markdown === '' ? null : markdown;
}

/**
 * 组装 getReleaseNotes 响应（纯函数，便于单测）。
 * lastShownNotesVersion 由调用方从 updater-state.json 读出传入。
 */
export function resolveReleaseNotes(
  deps: ReleaseNotesDeps,
  lastShownNotesVersion: string | null,
): ReleaseNotesPayload {
  const markdown = readReleaseNotesMarkdown(deps);
  const shown = lastShownNotesVersion === deps.currentVersion;
  return {
    version: deps.currentVersion,
    markdown,
    shouldShow: markdown !== null && deps.isUpgradeRun && !shown,
  };
}

/** 弹窗展示后回写「本版本已展示」；statePath 未注入（缺省）则跳过持久化 */
export function markNotesShown(statePath: string | null, version: string): void {
  if (statePath === null) return;
  const state = readUpdaterState(statePath);
  if (state.lastShownNotesVersion === version) return;
  state.lastShownNotesVersion = version;
  writeUpdaterState(statePath, state);
}

/** updater/* 说明两方法映射（createForgeCore 合并进 methodTable；无参数方法） */
export function createReleaseNotesMethods(
  deps: ReleaseNotesDeps,
): Record<string, (params: unknown) => Promise<RpcResult>> {
  return {
    'updater/getReleaseNotes': async () => {
      const state = deps.statePath === null ? null : readUpdaterState(deps.statePath);
      return {
        code: 0,
        message: 'success',
        data: resolveReleaseNotes(deps, state?.lastShownNotesVersion ?? null),
      };
    },
    'updater/markNotesShown': async () => {
      markNotesShown(deps.statePath, deps.currentVersion);
      return { code: 0, message: 'success', data: null };
    },
  };
}
