/**
 * 正文分段：把 canvas 占位从 HTML 流里切出来，换成组件槽位。
 *
 * 存在的理由（同 utils/ 下其他模块）：这是**正则与状态机**逻辑，
 * 出错形态是「卡片消失 / 正文丢段」，肉眼极难定位。
 * 抽成纯函数即可在 node:test 回归。
 */

/** 一段正文，或一个图示卡片的槽位。 */
export type DiagramSegment =
  | { kind: 'html'; html: string }
  /** 现状链路：模型写 HTML，宿主原样渲染。 */
  | { kind: 'canvas'; key: string; encoded: string; blocked: boolean };

export interface SplitOptions {
  /**
   * 流式期间：最后一张卡片挂骨架蒙版。
   * 只有最后一张需要——更早的围栏已闭合完整，骨架反而会让已出的图消失。
   */
  lastBlocked?: boolean;
}

/**
 * canvas 的匹配器（命名分组）。
 *
 * 曾与 IR 链路（canvas-ir）共用一张正则、靠 codeClass 精确等值区分两者——当时
 * 两个 class 名极相近，用 `data-md-canvas="([^"]*)"` 这类前缀匹配会把 IR 的属性
 * 误吃进 canvas 的 encoded，贪婪匹配又会把两张卡并成一张。
 * IR 已于 v6.33 整体移除，这里回归单一链路，正则随之收窄。
 */
const RE_SEGMENT =
  /<pre class="(?<preClass>md-canvas-wrap)">\s*<code class="(?<codeClass>[^"]*)"\s*(?<attrs>[^>]*)>[\s\S]*?<\/code><\/pre>/g;

/** 从 attrs 串里取某个属性值。 */
function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(name + '="([^"]*)"').exec(attrs);
  return m ? m[1] : undefined;
}

export function splitDiagramSegments(
  html: string,
  options?: SplitOptions,
): DiagramSegment[] {
  const src = html ?? '';
  if (!src) return [];

  const out: DiagramSegment[] = [];
  // 命名分组 + lastIndex 由正则自己维护，循环内不重置
  RE_SEGMENT.lastIndex = 0;

  let cursor = 0;
  let i = 0;
  let m: RegExpExecArray | null;

  while ((m = RE_SEGMENT.exec(src)) !== null) {
    const g = m.groups ?? {};
    // 只认 canvas（精确等值，双保险：pre 类名也必须一致）
    if (g.codeClass !== 'md-canvas' || g.preClass !== 'md-canvas-wrap') continue;

    if (m.index > cursor) {
      out.push({ kind: 'html', html: src.slice(cursor, m.index) });
    }

    out.push({
      kind: 'canvas',
      key: 'd' + i,
      encoded: attr(g.attrs ?? '', 'data-md-canvas') ?? '',
      blocked: false,
    });

    cursor = m.index + m[0].length;
    i += 1;
  }

  if (cursor < src.length) {
    out.push({ kind: 'html', html: src.slice(cursor, src.length) });
  }

  // 骨架只挂最后一张卡
  if (options?.lastBlocked === true) {
    for (let j = out.length - 1; j >= 0; j -= 1) {
      const seg = out[j]!;
      if (seg.kind !== 'html') {
        seg.blocked = true;
        break;
      }
    }
  }

  return out;
}
