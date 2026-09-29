import { judgeCanvasSource } from '../../src/markdown/canvasSandbox.ts';

// E-CA-003 流式中途的半截卡片源码
const HALF = '<div class="k">登录接口防爆破机制';
console.log('源码            :', JSON.stringify(HALF));
console.log('trim().length   :', HALF.trim().length);
console.log('judgeCanvasSource:', judgeCanvasSource(HALF));
