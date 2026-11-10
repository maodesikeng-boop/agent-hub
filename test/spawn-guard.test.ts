// 守卫自己的测试：起的子进程会被记下；没退出的、detached 组里还有后代的会被认出来，清掉之后就干净了。
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { killLeaked, leakedChildren, trackedChildren, waitForNoLeaks } from "./spawn-guard.ts";

const SLEEP = ["-e", "setInterval(() => {}, 1000)"];

describe("spawn-guard", () => {
  it("没退出的子进程算残留；清掉后没有残留", async () => {
    const child = spawn(process.execPath, SLEEP, { stdio: "ignore" });
    expect(trackedChildren().some((t) => t.child === child)).toBe(true);
    const leaked = leakedChildren().filter((t) => t.child === child);
    expect(leaked).toHaveLength(1);
    killLeaked(leaked);
    expect(await waitForNoLeaks(5_000)).toEqual([]);
  });

  it("detached 的进程自己退了、组里的后代还在：算残留", async () => {
    const child = spawn("/bin/sh", ["-c", `"${process.execPath}" -e "setInterval(() => {}, 1000)" & exit 0`], { stdio: "ignore", detached: true });
    await new Promise((resolve) => child.once("exit", resolve));
    const leaked = leakedChildren().filter((t) => t.child === child);
    expect(leaked).toHaveLength(1);
    killLeaked(leaked);
    expect(await waitForNoLeaks(5_000)).toEqual([]);
  });

  it("正常退出的子进程不算残留", async () => {
    const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
    await new Promise((resolve) => child.once("exit", resolve));
    expect(leakedChildren().filter((t) => t.child === child)).toEqual([]);
  });

  it("起不来的子进程（ENOENT）不算残留", async () => {
    const child = spawn("/nonexistent/agent-hub-nope", [], { stdio: "ignore" });
    await new Promise((resolve) => child.once("error", resolve));
    expect(leakedChildren().filter((t) => t.child === child)).toEqual([]);
  });
});
