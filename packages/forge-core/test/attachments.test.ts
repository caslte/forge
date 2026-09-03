import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ATTACHMENT_EXTENSIONS, ATTACHMENT_DIALOG_FILTER, isAllowedAttachmentPath } from '../src/attachments.ts';

test('附件格式白名单：图片/文本/Office 放行，大小写不敏感', () => {
  assert.equal(isAllowedAttachmentPath('C:\\a\\b.PNG'), true);
  assert.equal(isAllowedAttachmentPath('/home/x/report.xlsx'), true);
  assert.equal(isAllowedAttachmentPath('/home/x/old.xls'), true);
  assert.equal(isAllowedAttachmentPath('方案.Docx'), true);
  assert.equal(isAllowedAttachmentPath('notes.md'), true);
});

test('附件格式白名单：未列入的扩展名与无扩展名拒绝', () => {
  assert.equal(isAllowedAttachmentPath('virus.exe'), false);
  assert.equal(isAllowedAttachmentPath('C:\\a\\b.docm'), false);
  assert.equal(isAllowedAttachmentPath('Dockerfile'), false);
  assert.equal(isAllowedAttachmentPath(''), false);
});

test('附件格式白名单：对话框过滤项由白名单派生且同长度', () => {
  assert.equal(ATTACHMENT_DIALOG_FILTER.extensions.length, ATTACHMENT_EXTENSIONS.length);
  assert.ok(ATTACHMENT_EXTENSIONS.includes('xlsx'));
  assert.ok(ATTACHMENT_EXTENSIONS.includes('docx'));
});
