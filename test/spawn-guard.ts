// 子进程残留守卫（vitest 的 setupFiles，node 项目每个 worker 启动时跑）：
// 记下本测试文件通过 child_process.spawn / fork / execFile 起的每个子进程，文件的 afterAll 里检查它们是不是都退出了，
// 没退出（或者 detached 起的进程组里还有后代）就 SIGKILL 清掉并让这个文件失败，带上进程号和命令。
// 只看自己记下的进程：用 process.kill(pid, 0) 检查，不跑 ps（Worker 沙箱里 ps 被禁）、不按名字找别人的进程。
import { type ChildProcess } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { afterAll, expect } from "vitest";
import { TEST_CHILD_EXIT_WAIT_MS } from "../src/shared/limits.ts";

interface Tracked {
  child: ChildProcess;
  command: string;
  /** detached 起的进程是自己进程组的组长，组里的后代也算它的。 */
  detached: boolean;
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
  store().push({ child, command, detached: options?.detached === true, test: expect.getState().currentTestName });
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
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isLeaked({ child, detached }: Tracked): boolean {
  if (child.pid === undefined) return false; // 没起来（ENOENT 之类）
  if (child.exitCode === null && child.signalCode === null) return true;
  return detached && groupAlive(child.pid);
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
      process.kill(detached ? -child.pid : child.pid, "SIGKILL");
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
  const leaked = await waitForNoLeaks(TEST_CHILD_EXIT_WAIT_MS);
  if (leaked.length === 0) return;
  killLeaked(leaked);
  throw new Error(`测试结束时还有 ${leaked.length} 个子进程没退出（已强制结束）：${leaked.map((t) => `${t.child.pid} ${t.command}（起于：${t.test ?? "用例之外"}）`).join("；")}`);
});
