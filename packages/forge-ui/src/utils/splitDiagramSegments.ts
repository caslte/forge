/**
 * 正文分段：把 canvas / canvas-ir 占位从 HTML 流里切出来，换成组件槽位。
 *
 * 存在的理由（同 utils/ 下其他模块）：这是**正则与状态机**逻辑，
 * 出错形态是「卡片消失 / 正文丢段 / IR 被当成 canvas」，肉眼极难定位。
 * 抽成纯函数即可在 node:test 回归。
 *
 * 为什么 canvas 与 canvas-ir 必须**分别**写正则（不能合并成一个）：
 * 两个 class 名极相近（md-canvas / md-canvas-ir、data-md-canvas / data-md-canvas-ir），
 * 一旦用 `data-md-canvas="([^"]*)"` 这类前缀匹配，IR 的属性会被误吃进 canvas 的 encoded；
 * 反之贪婪匹配 `.*?` 收不住则会把两张卡片并成一张。
 * 首版就是靠测试把这个坑钉住的（见 test/splitDiagramSegments.test.ts）。
 */

/** 一段正文，或一个图示卡片的槽位。 */
export type DiagramSegment =
  | { kind: 'html'; html: string }
  /** 现状链路：模型写 HTML，宿主原样渲染。 */
  | { kind: 'canvas'; key: string; encoded: string; blocked: boolean }
  /** 新链路：模型写 IR，宿主编译。失败时只有回执没有 encoded。 */
  | {
      kind: 'ir';
      key: string;
      encoded?: string;
      receiptEncoded?: string;
      sourceEncoded?: string;
      blocked: boolean;
    };

export interface SplitOptions {
  /**
   * 流式期间：最后一张卡片挂骨架蒙版。
   * 只有最后一张需要——更早的围栏已闭合完整，骨架反而会让已出的图消失。
   */
  lastBlocked?: boolean;
}

/**
 * canvas 与 IR 的匹配器。
 *
 * 用带命名分组的单一正则，而不是「两个独立正则各跑一遍」：
 * 两次遍历需要维护两个游标，交错出现时顺序会乱。
 *
 * 关键是**用命名分组而非编号分组**——编号在两个分支各自有捕获组时会整体错位
 * （首版踩过：IR 的合规载荷落进了 receipt 组，表现为「合规卡片显示失败回执」）。
 * 命名分组不依赖顺序，改分支时不会静默串位。
 */
const RE_SEGMENT =
  /<pre class="(?<preClass>md-canvas-wrap|md-canvas-ir-wrap)(?: is-invalid)?">\s*<code class="(?<codeClass>[^"]*)"\s*(?<attrs>[^>]*)>[\s\S]*?<\/code><\/pre>/g;

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
    // 判定是 canvas 还是 IR：**以 code 类名为准，不靠 pre 类名**。
    // 两者的 pre 类名是前缀关系（md-canvas-wrap ⊂ md-canvas-ir-wrap 的字面量不是，
    // 但 startsWith 会误判），code 类名 md-canvas / md-canvas-ir 同样接近，
    // 所以用**精确等值**而不是前缀匹配。
    const isIr = g.codeClass === 'md-canvas-ir';
    // 双保险：pre 类名与code 类名不一致时视为不匹配（宁可漏切也不误切）
    const preOk = isIr
      ? g.preClass === 'md-canvas-ir-wrap'
      : g.preClass === 'md-canvas-wrap';
    if (!preOk) continue;

    if (m.index > cursor) {
      out.push({ kind: 'html', html: src.slice(cursor, m.index) });
    }

    const attrs = g.attrs ?? '';
    const key = 'd' + i;

    if (isIr) {
      const receiptEncoded = attr(attrs, 'data-md-canvas-ir-receipt');
      const seg: DiagramSegment = receiptEncoded !== undefined
        ? {
            kind: 'ir',
            key,
            receiptEncoded,
            sourceEncoded: attr(attrs, 'data-ir-source'),
            blocked: false,
          }
        : { kind: 'ir', key, encoded: attr(attrs, 'data-md-canvas-ir') ?? '', blocked: false };
      out.push(seg);
    } else {
      out.push({
        kind: 'canvas',
        key,
        encoded: attr(attrs, 'data-md-canvas') ?? '',
        blocked: false,
      });
    }

    cursor = m.index + m[0].length;
    i += 1;
  }

  if (cursor < src.length) {
    out.push({ kind: 'html', html: src.slice(cursor) });
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
