import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PASTE_TEXT_TO_FILE_CHARS, shouldConvertPasteToFile } from '../src/utils/pasteText.ts';

test('超长粘贴判定：阈值为 2000 字', () => {
  assert.equal(PASTE_TEXT_TO_FILE_CHARS, 2000);
});

test('超长粘贴判定：超过 2000 字转文件，2000 字以内默认粘贴', () => {
  assert.equal(shouldConvertPasteToFile('x'.repeat(2000)), false, '恰 2000 字不转');
  assert.equal(shouldConvertPasteToFile('x'.repeat(2001)), true, '超 2000 字转文件');
  assert.equal(shouldConvertPasteToFile('短文本'), false);
  assert.equal(shouldConvertPasteToFile(''), false, '空串不转');
});
