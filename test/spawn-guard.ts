// 子进程残留守卫（vitest 的 setupFiles，node 项目每个 worker 启动时跑）：
// 记下本测试文件通过 child_process.spawn / fork / execFile 起的每个子进程，文件的 afterAll 里检查它们是不是都退出了，
// 没退出（或者 detached 起的进程组里还有后代）就 SIGKILL 清掉并让这个文件失败，带上进程号和命令。
// 只看自己记下的进程：用 process.kill(pid, 0) 检查，不跑 ps（Worker 沙箱里 ps 被禁）、不按名字找别人的进程。
import { execFileSync, type ChildProcess } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { afterAll, expect } from "vitest";
import { TEST_CHILD_EXIT_WAIT_MS } from "../src/shared/limits.ts";

interface Tracked {
  child: ChildProcess;
  command: string;
  /** detached 起的进程是自己进程组的组长，组里的后代也算它的。 */
  detached: boolean;
  /** 进程已退出且当时它的进程组已清空（锁住，免得后面进程号被并行 worker 复用后误判或误杀）。 */
  groupCleared: boolean;
  /** 起它的时候正在跑的用例（模块顶层、beforeAll 里起的是 undefined），报残留时用来找出处。 */
  test: string | undefined;
}

const STORE = Symbol.for("agent-hub.spawn-guard");
const POLL_MS = 25;
const nodeRequire = createRequire(import.meta.url);

function store(): Tracked[] {
  const g = globalThis as { [STORE]?: Tracked[] };
  return (g[STORE] ??= []);
}

function remember(child: ChildProcess, args: unknown[]): void {
  const options = args.find((a) => typeof a === "object" && a !== null && !Array.isArray(a) && !(a instanceof Function)) as { detached?: unknown } | undefined;
  const command = [args[0], ...(Array.isArray(args[1]) ? args[1] : [])].map(String).join(" ").slice(0, 200);
  const detached = options?.detached === true;
  const tracked: Tracked = { child, command, detached, groupCleared: !detached, test: expect.getState().currentTestName };
  if (detached) {
    child.once("exit", () => {
      if (child.pid === undefined || !groupAlive(child.pid)) tracked.groupCleared = true;
    });
  }
  store().push(tracked);
}

/** 把 child_process 的 spawn / fork / execFile 换成会记账的版本（只换一次）。 */
function install(): void {
  const cp = nodeRequire("node:child_process") as Record<string | symbol, unknown>;
  if (cp[STORE]) return;
  cp[STORE] = true;
  for (const name of ["spawn", "fork", "execFile"] as const) {
    const original = cp[name] as (...args: unknown[]) => ChildProcess;
    const wrapped = function (this: unknown, ...args: unknown[]): ChildProcess {
      const child = original.apply(this, args);
      remember(child, args);
      return child;
    };
    // 连 util.promisify.custom 这类符号属性一起带上
    Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(original));
    cp[name] = wrapped;
  }
  syncBuiltinESMExports(); // 让 `import { spawn } from "node:child_process"` 的静态导入也拿到新的
}

function groupAlive(pid: number): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    // 测试自己起的子进程都是同一个用户的，不会 EPERM；EPERM 说明这个进程组号已经被别的用户的进程复用了
    return false;
  }
}

function isLeaked(tracked: Tracked): boolean {
  const { child } = tracked;
  if (child.pid === undefined) return false; // 没起来（ENOENT 之类）
  if (child.exitCode === null && child.signalCode === null) return true;
  if (tracked.groupCleared) return false;
  if (!groupAlive(child.pid)) {
    tracked.groupCleared = true;
    return false;
  }
  return true;
}

/** 本 worker 里记下的、现在还没退干净的子进程。 */
export function leakedChildren(): Tracked[] {
  return store().filter(isLeaked);
}

/** 记下过的子进程总数（给守卫自己的测试看）。 */
export function trackedChildren(): readonly Tracked[] {
  return store();
}

/** 清掉残留：detached 的杀整个进程组，其他的只杀它本身。 */
export function killLeaked(leaked: readonly Tracked[]): void {
  for (const { child, detached } of leaked) {
    if (child.pid === undefined || child.pid <= 1) continue;
    try {
      if (process.platform === "win32") {
        try {
          execFileSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
        } catch {
          process.kill(child.pid);
        }
      } else {
        process.kill(detached ? -child.pid : child.pid, "SIGKILL");
      }
    } catch {
      // 已经没了
    }
  }
}

/** 等残留退干净，最多 ms；返回超时后还在的。 */
export async function waitForNoLeaks(ms: number): Promise<Tracked[]> {
  const deadline = Date.now() + ms;
  let leaked = leakedChildren();
  while (leaked.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    leaked = leakedChildren();
  }
  return leaked;
}

install();

afterAll(async () => {
  try {
    const leaked = await waitForNoLeaks(TEST_CHILD_EXIT_WAIT_MS);
    if (leaked.length === 0) return;
    killLeaked(leaked);
    throw new Error(`测试结束时还有 ${leaked.length} 个子进程没退出（已强制结束）：${leaked.map((t) => `${t.child.pid} ${t.command}（起于：${t.test ?? "用例之外"}）`).join("；")}`);
  } finally {
    store().length = 0;
  }
});
