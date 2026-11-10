import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROCESS_LEDGER_MAX_ENTRIES } from "../shared/limits.ts";
import { isAlive, waitForExit } from "./driver/process.ts";
import { createProcessLedger, installProcessLedger, readLedgerFile, trackChild } from "./process-ledger.ts";

/** 一个假的“刚 spawn 的子进程”：能手动让它退出。 */
function fakeChild(pid: number) {
  const emitter = new EventEmitter();
  const child = Object.assign(emitter, { pid, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null });
  return {
    child: child as unknown as Pick<ChildProcess, "pid" | "exitCode" | "signalCode" | "once">,
    exit() {
      child.exitCode = 0;
      emitter.emit("exit", 0, null);
    },
  };
}

const startTimes = new Map<number, string>();
const startTimeOf = async (pid: number) => startTimes.get(pid) ?? null;

const spawned: ChildProcess[] = [];
function spawnSleeper(options: { detached: boolean }): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", ...options });
  spawned.push(child);
  startTimes.set(child.pid!, `Tue Nov 10 16:00:00 2026#${child.pid}`);
  return child;
}

describe("子进程记账", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "process-ledger-"));
    file = join(dir, "child-processes.json");
    startTimes.clear();
  });
  afterEach(() => {
    for (const child of spawned.splice(0)) {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("track：记 pid + 启动时间 + 用途，退出时划掉；读不到启动时间、已退出的不记", async () => {
    const ledger = createProcessLedger({ file, startTimeOf });
    const a = fakeChild(4001);
    const b = fakeChild(4002);
    const gone = fakeChild(4003);
    startTimes.set(4001, "T1");
    startTimes.set(4002, "T2");
    startTimes.set(4003, "T3");
    ledger.track(a.child, "agent:claude", { detached: true });
    ledger.track(b.child, "probe:model-catalog");
    ledger.track(gone.child, "probe:x");
    gone.exit();
    ledger.track(fakeChild(4004).child, "no-start-time"); // startTimes 里没有 4004：ps 读不到
    await ledger.settled();
    expect(readLedgerFile(file)).toEqual([
      { pid: 4001, startTime: "T1", purpose: "agent:claude", ownsGroup: true },
      { pid: 4002, startTime: "T2", purpose: "probe:model-catalog", ownsGroup: false },
    ]);
    a.exit();
    expect(readLedgerFile(file).map((e) => e.pid)).toEqual([4002]);
    b.exit();
    expect(ledger.size).toBe(0);
    expect(readLedgerFile(file)).toEqual([]);
  });

  it("上限：超过 PROCESS_LEDGER_MAX_ENTRIES 丢最老的", async () => {
    const ledger = createProcessLedger({ file, startTimeOf });
    for (let i = 0; i < PROCESS_LEDGER_MAX_ENTRIES + 5; i++) {
      startTimes.set(5000 + i, `T${i}`);
      ledger.track(fakeChild(5000 + i).child, "p");
    }
    await ledger.settled();
    const pids = readLedgerFile(file).map((e) => e.pid);
    expect(pids).toHaveLength(PROCESS_LEDGER_MAX_ENTRIES);
    expect(pids[0]).toBe(5005);
    expect(pids.at(-1)).toBe(5000 + PROCESS_LEDGER_MAX_ENTRIES + 4);
  });

  it("坏文件、字段不对的记录当作没有", () => {
    writeFileSync(join(dir, "bad.json"), "{不是 json");
    expect(readLedgerFile(join(dir, "bad.json"))).toEqual([]);
    expect(readLedgerFile(join(dir, "missing.json"))).toEqual([]);
    writeFileSync(join(dir, "mixed.json"), JSON.stringify({ entries: [{ pid: 1, startTime: "x", purpose: "p", ownsGroup: false }, { pid: "7" }, null, { pid: 99, startTime: "x", purpose: "p", ownsGroup: true }] }));
    expect(readLedgerFile(join(dir, "mixed.json")).map((e) => e.pid)).toEqual([99]); // pid ≤ 1 也不要
  });

  it("启动回收：进程号还在、启动时间一致的杀掉（连组），记录清空", async () => {
    const child = spawnSleeper({ detached: true });
    const first = createProcessLedger({ file, startTimeOf });
    first.track(child, "agent:claude", { detached: true });
    await first.settled();
    expect(readLedgerFile(file)).toHaveLength(1);

    // 模拟守护进程崩溃后重启：新的账本读旧文件
    const logs: string[] = [];
    const second = createProcessLedger({ file, startTimeOf, log: (l) => logs.push(l) });
    const reaped = await second.reapStale();
    expect(reaped.map((r) => [r.pid, r.reason])).toEqual([[child.pid, "same_process"]]);
    expect(await waitForExit(child.pid!, 5_000)).toBe(true);
    expect(readLedgerFile(file)).toEqual([]);
    expect(logs.join("\n")).toContain(String(child.pid));
  });

  it("启动回收：进程号被别的进程复用了（启动时间对不上）不杀", async () => {
    const innocent = spawnSleeper({ detached: false });
    const ledger = createProcessLedger({ file, startTimeOf });
    ledger.track(innocent, "agent:claude");
    await ledger.settled();
    // 记录里是旧的启动时间，现在这个进程号上的是另一个进程
    startTimes.set(innocent.pid!, "Wed Nov 11 09:00:00 2026#reused");
    const restarted = createProcessLedger({ file, startTimeOf });
    expect(await restarted.reapStale()).toEqual([]);
    expect(isAlive(innocent.pid!)).toBe(true);
    expect(readLedgerFile(file)).toEqual([]); // 记录照样清掉
  });

  it("启动回收：读不到启动时间（ps 跑不了）宁可不杀", async () => {
    const child = spawnSleeper({ detached: false });
    const ledger = createProcessLedger({ file, startTimeOf });
    ledger.track(child, "agent:claude");
    await ledger.settled();
    startTimes.delete(child.pid!);
    expect(await createProcessLedger({ file, startTimeOf }).reapStale()).toEqual([]);
    expect(isAlive(child.pid!)).toBe(true);
  });

  it("启动回收：领头的进程没了、detached 组里的后代还在：按组杀；非 detached 的不按组杀", async () => {
    // sh 起一个后台的 node 就退出：组长（sh）没了，后代还在同一个组里
    const leader = spawn("/bin/sh", ["-c", `"${process.execPath}" -e "setInterval(() => {}, 1000)" >/dev/null 2>&1 & echo $!; exit 0`], { stdio: ["ignore", "pipe", "ignore"], detached: true });
    spawned.push(leader);
    let out = "";
    leader.stdout!.on("data", (d: Buffer) => (out += d));
    await new Promise((resolve) => leader.once("close", resolve));
    const grandchild = Number(out.trim());
    expect(isAlive(grandchild)).toBe(true);
    // 记账是在组长还活着时记的
    writeFileSync(file, JSON.stringify({ version: 1, entries: [{ pid: leader.pid, startTime: "gone", purpose: "agent:claude", ownsGroup: true }] }));
    const reaped = await createProcessLedger({ file, startTimeOf }).reapStale();
    expect(reaped.map((r) => r.reason)).toEqual(["group_survivors"]);
    expect(await waitForExit(grandchild, 5_000)).toBe(true);

    // ownsGroup 为 false 的记录，进程号没了就什么都不做
    writeFileSync(file, JSON.stringify({ version: 1, entries: [{ pid: leader.pid, startTime: "gone", purpose: "x", ownsGroup: false }] }));
    expect(await createProcessLedger({ file, startTimeOf }).reapStale()).toEqual([]);
  });

  it("启动回收：不杀自己、不杀这次已经记下的", async () => {
    writeFileSync(file, JSON.stringify({ version: 1, entries: [{ pid: process.pid, startTime: "x", purpose: "me", ownsGroup: false }] }));
    startTimes.set(process.pid, "x");
    expect(await createProcessLedger({ file, startTimeOf }).reapStale()).toEqual([]);
  });

  it("trackChild：没装记账什么都不做，装了就记；撤销只撤自己那份", async () => {
    const quiet = fakeChild(6001);
    startTimes.set(6001, "T");
    trackChild(quiet.child, "x"); // 没装：不报错
    const ledger = createProcessLedger({ file, startTimeOf });
    const uninstall = installProcessLedger(ledger);
    trackChild(fakeChild(6001).child, "agent:agy");
    await ledger.settled();
    expect(ledger.size).toBe(1);
    const other = createProcessLedger({ file: join(dir, "other.json"), startTimeOf });
    installProcessLedger(other);
    uninstall(); // 已经被换掉了：不能把别人的撤了
    trackChild(fakeChild(6001).child, "agent:agy");
    await other.settled();
    expect(other.size).toBe(1);
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).entries).toHaveLength(1);
  });
});
