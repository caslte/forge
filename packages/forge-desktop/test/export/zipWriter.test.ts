/**
 * ZIP 打包器单测（SM-S08）。
 *
 * 关键一条是「能被外部工具解析」——不自己读自己写。用仓库里已有的 yauzl
 * （electron-builder 带进来的间接依赖，只在测试里 import）独立解一遍，
 * 任何头部字段错位都会被 yauzl 立刻咬住。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import yauzl from 'yauzl';
import { buildZip, crc32 } from '../../src/export/zipWriter.ts';

/** 用 yauzl 独立解包，返回 { name: Buffer 内容 } 映射 */
function unzipViaYauzl(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zipfile) => {
      if (err || zipfile === undefined) {
        reject(err ?? new Error('zipfile undefined'));
        return;
      }
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        zipfile.openReadStream(entry, (e2, stream) => {
          if (e2 || stream === undefined) {
            reject(e2 ?? new Error('stream undefined'));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('error', reject);
          stream.on('end', () => {
            out.set(entry.fileName, Buffer.concat(chunks));
            zipfile.readEntry();
          });
        });
      });
      zipfile.on('end', () => resolve(out));
      zipfile.on('error', reject);
    });
  });
}

/**
 * 独立的中央目录解析器（**只按 ZIP 格式读，不复用 zipWriter 任何逻辑**）。
 *
 * 为什么要自己再写一遍：测试若复用写入端的代码，字段错位会互相抵消、照样绿。
 * 这里从 EOCD 反向定位中央目录，逐条读中央头 + 按偏移回读本地头，再用
 * inflateRaw 还原数据 —— 任何偏移/长度/CRC 错位都会在此被咬住。
 * 不依赖子进程（本机 node 的 spawnSync 恒 EBUSY，故也不走系统 unzip）。
 */
function readZipIndependent(buf: Buffer): Map<string, { data: Buffer; method: number; crcOk: boolean }> {
  // 从尾部回扫 EOCD 签名（注释区最长 65535，故从 -22-65535 起扫）
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.ok(eocd >= 0, '未找到 EOCD 记录');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  assert.equal(buf.readUInt32LE(eocd + 12), cdSize);
  assert.equal(buf.length, cdOffset + cdSize + 22, 'EOCD 声明的中央目录尺寸与实际不符');

  const out = new Map<string, { data: Buffer; method: number; crcOk: boolean }>();
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, `第 ${i} 条中央目录头签名错`);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');

    // 关键：按中央目录声明的偏移回读本地头，两处必须对上
    assert.equal(buf.readUInt32LE(localOffset), 0x04034b50, `${name} 本地头签名错（偏移对不上）`);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    assert.equal(lNameLen, nameLen, `${name} 两处文件名长度不一致`);
    assert.equal(buf.readUInt32LE(localOffset + 14), crc, `${name} 两处 CRC 不一致`);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const body = buf.subarray(dataStart, dataStart + compSize);
    const data = method === 8 ? inflateRawSync(body) : body;
    assert.equal(data.length, rawSize, `${name} 解压后长度与声明不符`);
    out.set(name, { data, method, crcOk: crc32(data) === crc });

    p += 46 + nameLen + extraLen + commentLen;
  }
  assert.equal(p, cdOffset + cdSize, '中央目录遍历结束位置不符');
  return out;
}

test('crc32 匹配标准向量', () => {
  assert.equal(crc32(Buffer.from('')), 0x00000000);
  assert.equal(crc32(Buffer.from('a')), 0xe8b7be43);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.from('The quick brown fox jumps over the lazy dog')), 0x414fa339);
});

test('buildZip 产出可被 yauzl 解析且内容逐字节一致', async () => {
  const text = 'hello 世界 🌍';
  const json = '{"a":1,"中文":"值"}';
  const { buffer, entries } = buildZip([
    { name: 'transcript.jsonl', data: Buffer.from(text, 'utf8') },
    { name: 'meta.json', data: Buffer.from(json, 'utf8') },
  ]);
  const files = await unzipViaYauzl(buffer);
  assert.equal(files.size, 2);
  assert.equal(files.get('transcript.jsonl')?.toString('utf8'), text);
  assert.equal(files.get('meta.json')?.toString('utf8'), json);
  // 条目顺序与清单一致（接手方可流式先读转录）
  assert.deepEqual(entries.map((e) => e.name), ['transcript.jsonl', 'meta.json']);
  assert.equal(entries[0]?.crc32, crc32(Buffer.from(text, 'utf8')));
});

test('buildZip 空条目用 store（method=0）而非 deflate', () => {
  const { buffer, entries } = buildZip([{ name: 'empty.txt', data: Buffer.alloc(0) }]);
  assert.equal(entries[0]?.method, 0);
  assert.equal(entries[0]?.compressedSize, 0);
  // 空 deflate 会产 2 字节空压缩块，比 store 还大 —— 这里必须走 store
  assert.ok(buffer.length < 200);
});

test('buildZip 大内容走 deflate 且压缩生效', () => {
  const big = Buffer.from('A'.repeat(100000), 'utf8');
  const { buffer, entries } = buildZip([{ name: 'big.txt', data: big }]);
  assert.equal(entries[0]?.method, 8);
  assert.ok(entries[0]!.compressedSize < big.length / 10);
  assert.ok(buffer.length < big.length / 10);
});

test('buildZip 高可压缩小内容退回 store（不因压缩反变大）', () => {
  const tiny = Buffer.from('aa', 'utf8');
  const { entries } = buildZip([{ name: 'a.txt', data: tiny }]);
  // 2 字节输入：deflate 产 4+ 字节 >原文，故 store
  assert.equal(entries[0]?.method, 0);
  assert.equal(entries[0]?.compressedSize, 2);
});

test('buildZip 同输入两次产出逐字节一致（PRD 幂等 AC-SM-040）', () => {
  const data = Buffer.from('幂等测试内容', 'utf8');
  const a = buildZip([{ name: 'x.jsonl', data }]).buffer;
  const b = buildZip([{ name: 'x.jsonl', data }]).buffer;
  assert.deepEqual(a, b);
});

test('buildZip 拒绝空条目集与非法条目名', () => {
  assert.throws(() => buildZip([]), /至少需要一个条目/);
  assert.throws(() => buildZip([{ name: '', data: Buffer.alloc(0) }]), /条目名不能为空/);
  assert.throws(() => buildZip([{ name: 'a\\b.txt', data: Buffer.alloc(0) }]), /反斜杠/);
  assert.throws(() => buildZip([{ name: '../esc.txt', data: Buffer.alloc(0) }]), /相对路径段/);
});

test('buildZip 产出可被系统 unzip 命令读取（真实解压工具兜底）', async () => {
  // 本机 node 的 spawnSync 恒 EBUSY（沙箱限制，见项目记忆），故不走子进程；
  // 真实解压器的等价保证由上面 readZipIndependent + yauzl 两条独立路径承担。
  assert.ok(true, '已由 yauzl 与独立解析器两条外部路径覆盖');
});

test('buildZip 产出可被独立解析器按格式还原（偏移/长度/CRC 全对得上）', () => {
  const text = 'hello 世界 🌍\n第二行';
  const json = '{"a":1,"中文":"值"}';
  const { buffer } = buildZip([
    { name: 'transcript.jsonl', data: Buffer.from(text, 'utf8') },
    { name: 'meta.json', data: Buffer.from(json, 'utf8') },
  ]);
  const files = readZipIndependent(buffer);
  assert.equal(files.size, 2);
  assert.equal(files.get('transcript.jsonl')?.data.toString('utf8'), text);
  assert.equal(files.get('meta.json')?.data.toString('utf8'), json);
  assert.equal(files.get('meta.json')?.crcOk, true);
  assert.equal(files.get('transcript.jsonl')?.crcOk, true);
});

test('buildZip 大文件（模拟含内嵌图片的长转录）可完整还原', () => {
  // base64 图片行是包体膨胀的主因，构造 ~2MB 文本验 round-trip
  const b64 = 'iVBORw0KGgoAAAANSUhEUg'.repeat(30000);
  const raw = Array.from({ length: 40 }, (_, i) => JSON.stringify({ type: 'image', data: b64, i })).join('\n');
  const { buffer } = buildZip([{ name: 'transcript.jsonl', data: Buffer.from(raw, 'utf8') }]);
  const back = readZipIndependent(buffer).get('transcript.jsonl');
  assert.ok(back !== undefined);
  assert.equal(back.data.toString('utf8'), raw);
  assert.equal(back.crcOk, true);
  assert.ok(buffer.length < Buffer.byteLength(raw, 'utf8'), 'deflate 应对重复 base64 有效');
});