const { execFileSync } = require('node:child_process');
function t(label, args) {
  try {
    const out = execFileSync('reg.exe', args, { encoding: 'utf8', timeout: 5000, windowsHide: true });
    console.log(label, 'OK:', JSON.stringify(out.slice(0, 180)));
  } catch (e) {
    console.log(label, 'FAIL:', String(e.stderr || e.message).slice(0, 120));
  }
}
t('simple /ve', ['query', 'HKCU\\Environment', '/ve']);
t('list App Paths', ['query', 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths']);
t('code.exe /ve', ['query', 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\code.exe', '/ve']);
