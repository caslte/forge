/**
 * 极小 ZIP 打包器（SM-S08 会话导出）。
 *
 * 为什么不引第三方库：根 node_modules 里那份 `archiver` 是 electron-builder 带进来的
 * **间接依赖**，packages/forge-desktop/package.json 并未声明——打包成 app.asar 后
 * 可用性无保障，不能吃。ZIP 的 store/deflate 两种方式都不难，故自建：约百行纯逻辑，
 * 可完整单测，且不新增任何供应链。
 *
 * 实现要点：
 * - 只支持 ZIP 规范里最朴素的一种条目：本地文件头 + 数据 + 中央目录 + EOCD。
 *   不做数据描述符（streaming）、不做 ZIP64 —— 单文件超 4GB 由调用方先挡（见 buildSessionBundle）。
 * - 压缩用 node:zlib 的 deflateRaw（method=8）；空内容退回 store（method=0），
 *   因为 deflate 一个 0 长度输入会产出 2 字节空压缩块，比 store 的 0 字节还大。
 * - 时间戳**固定**为 1980-01-01（DOS 时间的下界）而不是取当前时间：同一会话重复导出
 *   应得到逐字节一致的包（PRD「幂等」，AC-SM-040），带时间戳会引入无意义的差异，
 *   也会让单测无法断言。
 */

import { deflateRawSync } from 'node:zlib';

/** ZIP 单条目 */
export interface ZipEntry {
  /** 包内路径，用 `/` 分隔（如 `meta.json`） */
  name: string;
  data: Buffer;
}

/** 打包结果 + 供断言用的清单 */
export interface ZipArchive {
  buffer: Buffer;
  entries: Array<{ name: string; method: number; compressedSize: number; size: number; crc32: number }>;
}

/** DOS 时间戳的 1980-01-01 00:00:00 —— ZIP 格式能表示的最早时刻 */
const DOS_DATE = 0x0021; // year 0 (=1980)<<9 | month 1<<5 | day 1
const DOS_TIME = 0x0000; // hour 0<<11 | minute 0<<5 | second/2 0

/** CRC-32 查表表（标准多项式 0xEDB88320 反射式） */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/** CRC-32（ZIP 用）。传入 Buffer/任意 view，返回无符号 32 位值。 */
export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    // 索引必然落在 0~255（& 0xff 保证），表长 256；下标非空断言 + 回落 0 仅为过 noUncheckedIndexedAccess
    const idx = (crc ^ data[i]!) & 0xff;
    crc = (CRC_TABLE[idx] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 由条目构建 ZIP 包。
 *
 * @throws 条目名含路径分隔符以外的非法字符、空名，或包体超过 4GB（ZIP64 未实现）
 */
export function buildZip(entries: ZipEntry[]): ZipArchive {
  if (entries.length === 0) throw new Error('zip: 至少需要一个条目');
  for (const e of entries) {
    if (e.name.length === 0) throw new Error('zip: 条目名不能为空');
    if (e.name.includes('\\')) throw new Error(`zip: 条目名不能含反斜杠（${e.name}）`);
    if (e.name.split('/').some((seg) => seg === '.' || seg === '..')) {
      throw new Error(`zip: 条目名不能含相对路径段（${e.name}）`);
    }
    if (e.data.length > 0xffffffff) throw new Error(`zip: 单条目超过 4GB，需 ZIP64（${e.name}）`);
  }

  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const manifest: ZipArchive['entries'] = [];

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const useDeflate = entry.data.length > 0;
    const payload = useDeflate ? deflateRawSync(entry.data, { level: 6 }) : entry.data;
    // deflate 反而变大（内容高度可压缩的极小文件）时退回 store，避免包体变大
    const method = useDeflate && payload.length < entry.data.length ? 8 : 0;
    const body = method === 8 ? payload : entry.data;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); // compressed size
    local.writeUInt32LE(entry.data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length

    locals.push(local, nameBuf, body);
    manifest.push({
      name: entry.name,
      method,
      compressedSize: body.length,
      size: entry.data.length,
      crc32: crc,
    });

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // 中央目录头签名
    central.writeUInt16LE(0x031e, 4); // version made by: 3.0 + Unix
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8); // flags: UTF-8 文件名
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attrs
    // 常规文件 + 0644 权限位。`<<` 是 32 位有符号运算，0o100644<<16 会溢出成负数，
    // writeUInt32LE 直接抛 ERR_OUT_OF_RANGE —— 必须 `>>> 0` 转回无符号。
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // 本地头起始偏移
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD 签名
  eocd.writeUInt16LE(0, 4); // 本磁盘号
  eocd.writeUInt16LE(0, 6); // 中央目录起始磁盘号
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  const buffer = Buffer.concat([...locals, centralBuf, eocd]);
  if (buffer.length > 0xffffffff) throw new Error('zip: 包体超过 4GB，需 ZIP64');
  return { buffer, entries: manifest };
}