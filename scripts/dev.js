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
 *
 * ## 端口纪律（2026-10-13 踩坑，两个坑叠在一起）
 *
 * vite 是 strictPort，端口被占时**它自己会报错退出**；而本脚本原先的
 * `waitForDevServer` 只轮询「51731 有没有在服务」，于是：
 *
 * 1. 上一次 dev 的 vite 残留（终端被直接关掉就会留下）还在服务 ⇒ 新 vite 绑定失败退出，
 *    而轮询**照旧通过** ⇒ 脚本一路走到第 5 步，把 electron 连到那个旧服务上。
 *    表面上「启动成功」，实际跑的是旧服务——比启动失败更难发现。
 * 2. 即便没有残留，vite 绑定失败后脚本还要傻等 15 秒才报「未就绪」，
 *    真正的原因（Port already in use）被埋在 vite 自己的输出里。
 *
 * 故启动 vite **之前**先探测端口：占用了就带 PID 与处理命令快速失败，
 * 并给 `--free-port` 一键清掉残留（头号占用原因就是上次 dev 的 vite）。
 */
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
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

/**
 * dev 需要预构建的工作区。
 *
 * `@forge/extensions` 必须在列：forge-desktop 运行时 import 的是它的
 * `dist/index.js`（package.json exports 指向 dist，不是 src）。早先这里只构建
 * core + desktop，于是**改了 extensions 的 src 却不生效**——dev 一直跑在旧产物上，
 * 且完全静默。实测踩到过：`canvasIrHint/promptIr.ts` 已从「手抄契约」改成
 * 「由 schema 派生」，但 dist 仍是旧的，模型拿到的 schema_version 还是 v1，
 * 而校验器要 v2 ⇒ 开关一开就 100% 失败。
 */
const DEV_BUILD_WORKSPACES = ['@forge/core', '@forge/extensions', '@forge/desktop'];
/** --free-port：端口被占用时直接清掉占用方再继续（残留 vite 的头号解法）。 */
const FREE_PORT = process.argv.includes('--free-port');

/**
 * 端口探测：**IPv4 与 IPv6 都要试**。
 *
 * 2026-10-13 实测：残留的 vite 只 LISTEN 在 [::1]:51731（netstat 显示
 * `TCP [::1]:51731 [::]:0 LISTENING`）。只探 127.0.0.1 会 ECONNREFUSED 而
 * 误判「端口空闲」——而 vite 自己的绑定冲突是照样的。双栈都探才不漏。
 */
export async function probePortOnce(port, host) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (occupied) => {
      socket.destroy();
      resolve(occupied);
    };
    socket.setTimeout(800);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

export async function probePort(port) {
  if (await probePortOnce(port, '127.0.0.1')) return true;
  return probePortOnce(port, '::1');
}

/**
 * 从 netstat -ano 输出里解析某端口的 LISTENING PID（纯函数，便于测试）。
 *
 * 格式锚点（Windows 实测行，列间是多个空格）：
 *   `  TCP    [::1]:51731            [::]:0                 LISTENING       8908`
 */
export function parseListenPid(netstatText, port) {
  const re = new RegExp(`TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'm');
  const m = re.exec(netstatText);
  return m ? Number(m[1]) : undefined;
}

/** 占用端口的 PID。best-effort：查不到不阻塞诊断（netstat / lsof 都可能不在）。 */
function findPortHolderPid(port) {
  try {
    if (isWindows) {
      // 不套 shell：netstat.exe 是真实可执行文件，直接 spawn 避免 cmd 参数 quoting 问题
      const res = spawnSync('netstat', ['-ano'], { encoding: 'utf8' });
      if (res.error) return undefined;
      return parseListenPid(res.stdout ?? '', port);
    }
    const res = spawnSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8' });
    if (res.error) return undefined;
    const pid = Number((res.stdout ?? '').trim().split('\n')[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function killPid(pid) {
  const res = isWindows
    ? spawnSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'inherit', shell: true })
    : spawnSync('kill', [String(pid)], { stdio: 'inherit' });
  return res.status === 0;
}

/** 等端口释放（kill 之后 LISTEN 不一定立刻消失）。 */
async function waitPortFree(port, maxAttempts = 20) {
  for (let i = 0; i < maxAttempts; i += 1) {
    if (!(await probePort(port))) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/**
 * 启动 vite 前的端口预检。
 *
 * 为什么要单独一道：vite strictPort 下被占用的表现是「它自己退出」，而下游的
 * 就绪轮询分不清「新服务起来了」和「旧服务还在」——残留 vite 会让后者看起来
 * 一切正常（见文件头「端口纪律」）。预检把这两个失败模式都堵在起点。
 */
async function ensureDevPortFree() {
  if (!(await probePort(DEV_PORT))) return;
  const pid = findPortHolderPid(DEV_PORT);
  const where = pid ? `（PID ${pid}）` : '';
  console.error(`[dev] 端口 ${DEV_PORT} 已被占用${where}，vite(strictPort) 无法绑定。`);
  console.error('[dev] 最常见原因：上一次 npm run dev 的 vite 残留（终端被直接关掉就会留下），');
  console.error('[dev] 它在旧代码上服务——不处理的话 electron 会连到那个旧服务，且看起来一切正常。');
  if (FREE_PORT && pid) {
    console.error(`[dev] --free-port：清掉占用方 PID ${pid}`);
    if (killPid(pid) && (await waitPortFree(DEV_PORT))) {
      console.error('[dev] 端口已释放，继续启动。');
      return;
    }
    console.error('[dev] 清理失败，请手动处理后重试。');
    process.exit(1);
  }
  if (pid) {
    console.error(`[dev] 处理：${isWindows ? `taskkill /PID ${pid} /F` : `kill ${pid}`}，或改用 npm run dev -- --free-port`);
  } else {
    console.error(`[dev] 处理：找到并结束占用 ${DEV_PORT} 的进程，或改用 npm run dev -- --free-port`);
  }
  process.exit(1);
}

async function main() {
  // 端口预检放在构建之前：占用了就没必要让用户等 90 秒构建再失败
  await ensureDevPortFree();
  if (isWindows) {
    // 中文 Windows 默认代码页 936(GBK)，与子进程 UTF-8 输出不符会显示乱码
    spawnSync('cmd', ['/c', 'chcp', '65001'], { stdio: 'ignore' });
  }
  DEV_BUILD_WORKSPACES.forEach((ws, i) => {
    console.log(`[dev] ${i + 1}/${DEV_BUILD_WORKSPACES.length + 2} build ${ws}`);
    runBuild(ws);
  });

  console.log(`[dev] ${DEV_BUILD_WORKSPACES.length + 1}/${DEV_BUILD_WORKSPACES.length + 2} 启动 vite dev server`);
  const vite = spawn(npmCmd, ['run', 'dev', '-w', '@forge/ui'], {
    stdio: 'inherit',
    shell: isWindows,
    env: { ...process.env, FORGE_VITE_PORT: String(DEV_PORT), FORGE_DEV_SERVER_ORIGIN: DEV_URL },
  });
  vite.on('error', (err) => {
    console.error('[dev] vite 启动失败', err);
    process.exit(1);
  });
  // vite 自己退出（strictPort 撞端口最常见）要立刻失败，而不是让就绪轮询
  // 傻等 15 秒后报一句与真实原因无关的「未就绪」。
  let viteExitCode = null;
  vite.on('exit', (code) => {
    viteExitCode = code ?? 0;
  });

  try {
    await Promise.race([
      waitForDevServer(),
      new Promise((resolve, reject) => {
        const t = setInterval(() => {
          if (viteExitCode === null) return;
          clearInterval(t);
          reject(new Error(`vite 进程已退出（exit ${viteExitCode}）——真实原因见上面 vite 自己的输出`));
        }, 100);
        t.unref();
      }),
    ]);
  } catch (err) {
    console.error('[dev]', err instanceof Error ? err.message : err);
    vite.kill();
    process.exit(1);
  }

  console.log(`[dev] ${DEV_BUILD_WORKSPACES.length + 2}/${DEV_BUILD_WORKSPACES.length + 2} 启动 electron（加载`, DEV_URL, '）');
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

// 直接执行本文件时才启动 dev；被 import（测试）时不产生任何副作用。
// 判据用真实路径比对而非 import.meta.main（Node 22.22 尚无该字段）。
const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err) => {
    console.error('[dev] 异常', err);
    process.exit(1);
  });
}
