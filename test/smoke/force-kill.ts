// 强制结束（m2-plan 第 6 节第 4 条）：agent 在 Bash 里跑着 `sleep 300`，结束它的 claude，sleep 子进程要跟着没了。
// 真 claude 的 Bash 工具可能把命令放进它自己的进程组，按 claude 的进程组杀就可能杀不到，所以先把进程表（谁是谁的子进程、进程组号）记下来。
// S10a 守护进程正常关机（SIGTERM）；S10b 守护进程被 SIGKILL 后重启，靠启动时清理残留进程（cleanupStale）；
// S10c 直接调驱动层强制结束用的 forceKillTree（SIGKILL claude 和它所有后代所在的进程组，真正的“强制结束”，不给 claude 自己清理的机会）。
// 结束后不管结果怎样，我们自己记下的 sleep 进程都会补一刀，免得测试留下 300 秒的睡眠进程。
import { forceKillTree } from "../../src/daemon/driver/process.ts";
import { isAlive } from "../e2e/harness.ts";
import { Smoke, expect, processTable, scenario, sleep, waitUntil, type Outcome } from "./kit.ts";

interface Tree {
  claudePid: number;
  claudePgid: number;
  sleepPid: number;
  sleepPgid: number;
  /** sleep 到 claude 之间的进程链（含两头），给报告看。 */
  chain: string;
}

/** 让 agent 在后台跑 sleep 300（claude 的 Bash 工具会拦前台的长 sleep），等 sleep 进程出现在 claude 名下，返回进程树。 */
async function startSleep(smoke: Smoke): Promise<Tree> {
  await smoke.client.post(smoke.privateId, "用 Bash 工具运行 `sleep 300`，必须把 run_in_background 设成 true（claude 不让前台跑这么久的 sleep）。启动后马上回复“已在后台跑”，不要等它。");
  return waitUntil(
    "claude 名下出现 sleep 300",
    () => {
      const claudePid = smoke.sessionRow().pid;
      if (claudePid === null) return undefined;
      const table = processTable();
      for (const [pid, p] of table) {
        // 命令行恰好是 sleep 300 的才是真的 sleep；外面那层 zsh -c "…sleep 300…" 的命令行里也带这几个字，不算
        if (p.command.trim() !== "sleep 300") continue;
        const chain: number[] = [pid];
        for (let cur = p.ppid; cur > 1 && !chain.includes(cur); cur = table.get(cur)?.ppid ?? 0) {
          chain.push(cur);
          if (cur === claudePid) {
            const claude = table.get(claudePid)!;
            const text = chain.map((c) => `${c}(pgid ${table.get(c)?.pgid}) ${table.get(c)?.command.slice(0, 40)}`).join(" ← ");
            return { claudePid, claudePgid: claude.pgid, sleepPid: pid, sleepPgid: p.pgid, chain: text };
          }
        }
      }
      return undefined;
    },
    90_000,
  );
}

const describe = (t: Tree) =>
  `claude ${t.claudePid}（进程组 ${t.claudePgid}），sleep ${t.sleepPid}（进程组 ${t.sleepPgid}${t.sleepPgid === t.claudePgid ? "，和 claude 同组" : "，不和 claude 同组"}）`;

/** 等 pid 退出，最多 ms 毫秒；返回它是不是已经没了。 */
async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (isAlive(pid) && Date.now() < deadline) await sleep(100);
  return !isAlive(pid);
}

/** 补一刀：还活着的就杀掉，返回补了哪些。 */
function sweep(pids: number[]): number[] {
  return pids.filter((pid) => {
    if (!isAlive(pid)) return false;
    process.kill(pid, "SIGKILL");
    return true;
  });
}

export async function runForceKill(outcomes: Outcome[], only: (name: string) => boolean): Promise<void> {
  if (only("S10a")) {
    const smoke = await Smoke.boot();
    let tree: Tree | undefined;
    const ok = await scenario(outcomes, "S10a 关机时 agent 正在跑 sleep：sleep 跟着没了", async () => {
      tree = await startSleep(smoke);
      const t0 = Date.now();
      const exit = await smoke.terminate();
      const took = ((Date.now() - t0) / 1000).toFixed(1);
      expect(exit.code === 0, `关机退出码 ${exit.code}`);
      const claudeGone = await goneWithin(tree.claudePid, 3_000);
      const sleepGone = await goneWithin(tree.sleepPid, 3_000);
      expect(claudeGone, `关机后 claude ${tree.claudePid} 还在`);
      expect(sleepGone, `关机（${took} 秒）后 claude 没了，但 sleep ${tree.sleepPid} 还在：${describe(tree)}；进程链 ${tree.chain}`);
      return `关机 ${took} 秒，${describe(tree)}，都没了；进程链 ${tree.chain}`;
    });
    const swept = tree ? sweep([tree.sleepPid, tree.claudePid]) : [];
    if (swept.length > 0) console.log(`  补刀结束了残留进程 ${swept.join("、")}`);
    const problems = await smoke.finish(!ok);
    if (problems.length > 0) outcomes.push({ name: "S10a（收尾）", ok: false, detail: problems.join("；") });
  }

  if (only("S10b")) {
    const smoke = await Smoke.boot();
    let tree: Tree | undefined;
    const ok = await scenario(outcomes, "S10b 守护进程被 SIGKILL 后重启：清理残留，sleep 跟着没了", async () => {
      tree = await startSleep(smoke);
      smoke.daemon.child.kill("SIGKILL");
      await smoke.daemon.exited;
      expect(isAlive(tree.claudePid) && isAlive(tree.sleepPid), `守护进程被杀后 claude 或 sleep 就没了，场景没造成：${describe(tree)}`);
      const t0 = Date.now();
      await smoke.start();
      const claudeGone = await goneWithin(tree.claudePid, 15_000);
      const sleepGone = await goneWithin(tree.sleepPid, 5_000);
      const took = ((Date.now() - t0) / 1000).toFixed(1);
      expect(claudeGone, `重启（${took} 秒）后残留的 claude ${tree.claudePid} 还在`);
      expect(sleepGone, `重启（${took} 秒）后残留的 claude 没了，但 sleep ${tree.sleepPid} 还在：${describe(tree)}；进程链 ${tree.chain}`);
      return `重启 ${took} 秒内清掉了残留，${describe(tree)}，都没了；进程链 ${tree.chain}`;
    });
    const swept = tree ? sweep([tree.sleepPid, tree.claudePid]) : [];
    if (swept.length > 0) console.log(`  补刀结束了残留进程 ${swept.join("、")}`);
    const problems = await smoke.finish(!ok);
    if (problems.length > 0) outcomes.push({ name: "S10b（收尾）", ok: false, detail: problems.join("；") });
  }
  if (only("S10c")) {
    const smoke = await Smoke.boot();
    let tree: Tree | undefined;
    const ok = await scenario(outcomes, "S10c 驱动层的强制结束（forceKillTree）：sleep 跟着没了", async () => {
      tree = await startSleep(smoke);
      await forceKillTree(tree.claudePid, true);
      const claudeGone = await goneWithin(tree.claudePid, 3_000);
      const sleepGone = await goneWithin(tree.sleepPid, 3_000);
      expect(claudeGone, `claude ${tree.claudePid} 没被杀掉`);
      expect(sleepGone, `强制结束之后 claude 没了，但 sleep ${tree.sleepPid} 还在：${describe(tree)}；进程链 ${tree.chain}`);
      return `${describe(tree)}，都没了；进程链 ${tree.chain}`;
    });
    const swept = tree ? sweep([tree.sleepPid, tree.claudePid]) : [];
    if (swept.length > 0) console.log(`  补刀结束了残留进程 ${swept.join("、")}`);
    const problems = await smoke.finish(!ok);
    if (problems.length > 0) outcomes.push({ name: "S10c（收尾）", ok: false, detail: problems.join("；") });
  }
}
