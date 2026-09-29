import fs from 'node:fs';
import path from 'node:path';

const storePath = path.join(process.env.APPDATA, 'Electron', 'forge-store.json');
const j = JSON.parse(fs.readFileSync(storePath, 'utf8'));
const sessions = j.sessions || [];

const newRoot = path.join(process.env.APPDATA, 'Electron', 'agent', 'sessions');
const oldRoot = path.join(process.env.USERPROFILE, '.pi', 'agent', 'sessions');

let okNew = 0;
const missing = [];
for (const s of sessions) {
  const fname = `forge-${s.sessionId}.jsonl`;
  const inNew = fs.existsSync(path.join(newRoot, encodeURIComponent(s.projectPath), fname));
  if (inNew) {
    okNew++;
    continue;
  }
  // 旧根两种历史编码样式都探一遍：%2F 斜杠形 + 现格式
  const slashForm = encodeURIComponent(s.projectPath.split('\\').join('/'));
  const candidates = [
    path.join(oldRoot, slashForm, fname),
    path.join(oldRoot, encodeURIComponent(s.projectPath), fname),
  ];
  const foundOld = candidates.find((p) => fs.existsSync(p));
  missing.push({
    id: s.sessionId.slice(0, 8),
    alias: (s.alias || '').slice(0, 12),
    proj: s.projectPath,
    oldFile: foundOld ?? null,
  });
}

console.log(`新根可直接打开: ${okNew} / ${sessions.length}`);
console.log(`旧根能找到转录: ${missing.filter((m) => m.oldFile).length}`);
console.log(`两边都没有(真丢了): ${missing.filter((m) => !m.oldFile).length}`);
for (const m of missing) console.log(JSON.stringify(m));
