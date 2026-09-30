/**
 * forge 一键 dev 启动脚本。
 *
 * 流程：
 * 1. build @forge/core（forge-desktop 运行时依赖其 dist）
 * 2. build @forge/desktop（产出 dist/main.js + dist/preload.js）
 * 3. 启动 @forge/ui vite dev server
 * 4. 等待 dev server 就绪
 * 5. 启动 electron，设 FORGE_DEV_SERVER_URL 让主进程 loadURL
 * 6. electron 退出时一并关闭 vite
 */
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEV_PORT = 51731;
const DEV_URL = `http://localhost:${DEV_PORT}`;
const isWindows = process.platform === 'win32';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const electronCli = path.join(projectRoot, 'packages/forge-desktop/node_modules/electron/cli.js');
const mainPath = path.join(projectRoot, 'packages/forge-desktop/dist/main.js');

/** 轮询 dev server 直到就绪或超时 */
function waitForDevServer(maxAttempts = 30) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const probe = () => {
  const req = http.get(DEV_URL, (res) => {
        if (res.statusCode !== undefined && res.statusCode < 500) {
          resolve();
        } else {
          retry();
        }
        res.resume();
      });
      req.on('error', () => retry());
    };
    const retry = () => {
      attempts += 1;
      if (attempts >= maxAttempts) {
        reject(new Error(`dev server ${DEV_URL} 未在 ${maxAttempts} 次内就绪`));
        return;
      }
      setTimeout(probe, 500);
    };
    probe();
  });
}

function runBuild(workspace) {
  // Windows 下 spawn .cmd 必须 shell:true（Node CVE-2024-27980 后强制 EINVAL）
  const res = spawnSync(npmCmd, ['run', 'build', '-w', workspace], {
    stdio: 'inherit',
    shell: isWindows,
  });
  if (res.error) {
    console.error(`[dev] ${workspace} 构建进程异常:`, res.error.message);
    process.exit(1);
  }
  if (res.status !== 0) {
    console.error(`[dev] ${workspace} 构建失败（exit ${res.status}），中止启动`);
    process.exit(res.status ?? 1);
  }
}

async function main() {
  if (isWindows) {
    // 中文 Windows 默认代码页 936(GBK)，与子进程 UTF-8 输出不符会显示乱码
    spawnSync('cmd', ['/c', 'chcp', '65001'], { stdio: 'ignore' });
  }
  console.log('[dev] 1/4 build @forge/core');
  runBuild('@forge/core');
  console.log('[dev] 2/4 build @forge/desktop');
  runBuild('@forge/desktop');

  console.log('[dev] 3/4 启动 vite dev server');
  const vite = spawn(npmCmd, ['run', 'dev', '-w', '@forge/ui'], {
    stdio: 'inherit',
    shell: isWindows,
    env: { ...process.env, FORGE_VITE_PORT: String(DEV_PORT), FORGE_DEV_SERVER_ORIGIN: DEV_URL },
  });
  vite.on('error', (err) => {
    console.error('[dev] vite 启动失败', err);
    process.exit(1);
  });

  try {
    await waitForDevServer();
  } catch (err) {
    console.error('[dev]', err instanceof Error ? err.message : err);
    vite.kill();
    process.exit(1);
  }

  console.log('[dev] 4/4 启动 electron（加载', DEV_URL, '）');
  const electron = spawn('node', [electronCli, mainPath], {
    stdio: 'inherit',
    env: {
      ...process.env,
      FORGE_DEV_SERVER_URL: DEV_URL,
      FORGE_DEV_SERVER_ORIGIN: DEV_URL,
    },
  });
  electron.on('close', (code) => {
    vite.kill();
    process.exit(code ?? 0);
  });
  electron.on('error', (err) => {
    console.error('[dev] electron 启动失败', err);
    vite.kill();
    process.exit(1);
  });
}

main().catch((err) => {
  console.error('[dev] 异常', err);
  process.exit(1);
});
