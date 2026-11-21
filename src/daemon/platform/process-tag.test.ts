import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_SESSION_OWNER_TAG, SESSION_TAG_MAX_DEPTH } from "../../shared/limits.ts";
import { isAlive, waitForExit } from "../driver/process.ts";
import {
  envContainsSessionTag,
  listTaggedProcesses,
  makeSessionOwnerTag,
  reapTaggedProcesses,
  type ListTaggedProcessesOptions,
} from "./process-tag.ts";

const spawnedPids: number[] = [];
const tempDirs: string[] = [];

const canRunPs =
  process.platform !== "win32" &&
  (() => {
    try {
      execFileSync("ps", ["-o", "pid=", "-p", String(process.pid)], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

/** Inside macOS sandbox-exec, setuid /bin/ps returns EPERM; feed real spawned PIDs to the darwin parser so real SIGSTOP/SIGKILL reaping is still verified. */
function psOptionsForLivePid(pid: number, envTagValue: string): ListTaggedProcessesOptions {
  if (canRunPs) return {};
  const uid = process.getuid?.() ?? 501;
  return {
    platform: "darwin",
    ownUid: uid,
    runPs: async (args) => {
      if (args[0] === "-p") return `${process.pid}\n`;
      if (!isAlive(pid)) return "";
      return `  ${pid}     1  ${pid}   ${uid} node -e sleeper ${ENV_SESSION_OWNER_TAG}=${envTagValue} PATH=/usr/bin\n`;
    },
  };
}

afterEach(() => {
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
      }
    }
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("session owner process tagging and reaping", () => {
  it("builds a single-session tag and appends to parent tags up to SESSION_TAG_MAX_DEPTH", () => {
    const t1 = makeSessionOwnerTag(10, "aaa111");
    expect(t1).toBe("s10:aaa111");
    const t2 = makeSessionOwnerTag(20, "bbb222", t1);
    expect(t2).toBe("s10:aaa111,s20:bbb222");
    const deep = makeSessionOwnerTag(99, "zzz999", "s1:a,s2:b,s3:c,s4:d,s5:e");
    const tokens = deep.split(",");
    expect(tokens).toHaveLength(SESSION_TAG_MAX_DEPTH);
    expect(tokens[0]).toBe("s1:a");
    expect(tokens.at(-1)).toBe("s99:zzz999");
  });

  it("matches only exact comma-delimited tokens in envContainsSessionTag", () => {
    const envVal = "s1:abc,s12:def,s123:ghi";
    expect(envContainsSessionTag(envVal, "s1:abc")).toBe(true);
    expect(envContainsSessionTag(envVal, "s12:def")).toBe(true);
    expect(envContainsSessionTag(envVal, "s123:ghi")).toBe(true);
    expect(envContainsSessionTag(envVal, "s1:a")).toBe(false);
    expect(envContainsSessionTag(envVal, "s12")).toBe(false);
    expect(envContainsSessionTag(envVal, "s1:abc,s12:def")).toBe(false);
    expect(envContainsSessionTag("", "s1:abc")).toBe(false);
  });

  it("lists detached grandchildren carrying the session tag on macOS (ps eww) and Linux (/proc/<pid>/environ)", async () => {
    // Linux /proc/<pid>/environ parser.
    const fakeProc = mkdtempSync(join(tmpdir(), "fake-proc-"));
    tempDirs.push(fakeProc);
    const makeProc = (pid: number, ppid: number, pgid: number, environ: string, cmdline: string) => {
      const dir = join(fakeProc, String(pid));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "environ"), environ);
      writeFileSync(join(dir, "stat"), `${pid} (node (test)) S ${ppid} ${pgid} ${pgid} 0 -1 0\n`);
      writeFileSync(join(dir, "cmdline"), cmdline);
    };
    makeProc(1, 0, 1, `${ENV_SESSION_OWNER_TAG}=s42:tok1\0`, "init\0");
    makeProc(500, 1, 500, `PATH=/usr/bin\0${ENV_SESSION_OWNER_TAG}=s42:tok1,s99:tok2\0`, "node\0server.js\0");
    makeProc(501, 1, 501, `PATH=/usr/bin\0${ENV_SESSION_OWNER_TAG}=s42:tok10\0`, "node\0other.js\0");
    makeProc(process.pid, 1, process.pid, `${ENV_SESSION_OWNER_TAG}=s42:tok1\0`, "vitest\0");

    const linuxFound = await listTaggedProcesses("s42:tok1", {
      platform: "linux",
      procRoot: fakeProc,
      ownPid: process.pid,
    });
    expect(linuxFound).toEqual([
      { pid: 500, ppid: 1, pgid: 500, tag: "s42:tok1", command: "node server.js" },
    ]);

    // macOS ps eww parser (including uid isolation and exact token matching).
    const darwinFound = await listTaggedProcesses("s42:tok1", {
      platform: "darwin",
      ownPid: 100,
      ownUid: 501,
      runPs: async () =>
        [
          `    1     0     1   501 /sbin/launchd ${ENV_SESSION_OWNER_TAG}=s42:tok1`,
          `  100     1   100   501 node daemon.ts ${ENV_SESSION_OWNER_TAG}=s42:tok1`,
          `  600     1   600   502 node other-user.js ${ENV_SESSION_OWNER_TAG}=s42:tok1`,
          `  601     1   601   501 node wrong-tag.js ${ENV_SESSION_OWNER_TAG}=s42:tok10`,
          `  602     1   602   501 node detached.js HOME=/Users/u ${ENV_SESSION_OWNER_TAG}=s42:tok1,s99:tok2 TERM=xterm`,
        ].join("\n"),
    });
    expect(darwinFound).toEqual([
      { pid: 602, ppid: 1, pgid: 602, tag: "s42:tok1", command: "node detached.js HOME=/Users/u" },
    ]);

    if (canRunPs && (process.platform === "darwin" || process.platform === "linux")) {
      const tag = makeSessionOwnerTag(777, `list${Date.now()}`);
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, [ENV_SESSION_OWNER_TAG]: tag },
      });
      spawnedPids.push(child.pid!);
      const listed = await listTaggedProcesses(tag);
      expect(listed.map((p) => p.pid)).toContain(child.pid!);
      await reapTaggedProcesses(tag);
    }
  });

  it("excludes PID <= 1 and ownPid from listed and reaped targets", async () => {
    const fakeProc = mkdtempSync(join(tmpdir(), "fake-proc-own-"));
    tempDirs.push(fakeProc);
    for (const pid of [1, process.pid]) {
      const dir = join(fakeProc, String(pid));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "environ"), `${ENV_SESSION_OWNER_TAG}=s5:same\0`);
      writeFileSync(join(dir, "stat"), `${pid} (self) S 0 ${pid} ${pid} 0 -1 0\n`);
      writeFileSync(join(dir, "cmdline"), "self\0");
    }
    const found = await listTaggedProcesses("s5:same", {
      platform: "linux",
      procRoot: fakeProc,
      ownPid: process.pid,
    });
    expect(found).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("reaps a detached grandchild process whose intermediate parent already exited", async () => {
    const dir = mkdtempSync(join(tmpdir(), "detached-gc-"));
    tempDirs.push(dir);
    const pidFile = join(dir, "gc.pid");
    const tag = makeSessionOwnerTag(801, `gc${Date.now()}`);

    const parent = spawn(
      process.execPath,
      [
        "-e",
        `
        const { spawn } = require("node:child_process");
        const { writeFileSync } = require("node:fs");
        const gc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
        gc.unref();
        writeFileSync(${JSON.stringify(pidFile)}, String(gc.pid));
        process.exit(0);
        `,
      ],
      {
        stdio: "ignore",
        env: { ...process.env, [ENV_SESSION_OWNER_TAG]: tag },
      },
    );
    await new Promise((resolve) => parent.once("exit", resolve));
    const gcPid = Number(readFileSync(pidFile, "utf8").trim());
    spawnedPids.push(gcPid);
    expect(isAlive(gcPid)).toBe(true);

    const result = await reapTaggedProcesses(tag, psOptionsForLivePid(gcPid, tag));
    expect(result.reapedPids).toContain(gcPid);
    expect(result.survivingPids).toEqual([]);
    expect(await waitForExit(gcPid, 2_000)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("reaps a nested test daemon process that inherited the parent Worker tag", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nested-daemon-"));
    tempDirs.push(dir);
    const pidFile = join(dir, "nested.pid");
    const parentTag = makeSessionOwnerTag(802, `worker${Date.now()}`);
    const nestedEnvTag = makeSessionOwnerTag(1, `smoke${Date.now()}`, parentTag);

    const nestedDaemon = spawn(
      process.execPath,
      [
        "-e",
        `
        const { writeFileSync } = require("node:fs");
        writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
        setInterval(() => {}, 1000);
        `,
      ],
      {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, [ENV_SESSION_OWNER_TAG]: nestedEnvTag },
      },
    );
    nestedDaemon.unref();
    spawnedPids.push(nestedDaemon.pid!);
    for (let i = 0; i < 40; i++) {
      try {
        if (Number(readFileSync(pidFile, "utf8").trim()) === nestedDaemon.pid) break;
      } catch {
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(isAlive(nestedDaemon.pid!)).toBe(true);

    const result = await reapTaggedProcesses(parentTag, psOptionsForLivePid(nestedDaemon.pid!, nestedEnvTag));
    expect(result.reapedPids).toContain(nestedDaemon.pid!);
    expect(await waitForExit(nestedDaemon.pid!, 2_000)).toBe(true);
  });

  it("returns empty list on win32 where fusa-run Job Objects own the process tree", async () => {
    expect(await listTaggedProcesses("s1:abc", { platform: "win32" })).toEqual([]);
    expect(await reapTaggedProcesses("s1:abc", { platform: "win32" })).toEqual({ reapedPids: [], survivingPids: [] });
  });
});
