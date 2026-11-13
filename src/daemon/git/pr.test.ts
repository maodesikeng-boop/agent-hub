// hub worker show 查 PR：gh pr list 的输出只取编号、状态、网址；空数组返回 null，gh 报错/超时返回不可用原因（pr.ts）。
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeExecutableNodeScript } from "../../../test/fake-cli-shim.ts";
import { createResolveFolder } from "../ledger/files.ts";
import { createLedger } from "../ledger/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { describeGhError, parsePrList, parsePrView, probePr, probePrByUrl } from "./pr.ts";

let root: string;
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-hub-pr-test-")));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function fakeGh(script: string): void {
  const bin = join(root, "fake-bin");
  mkdirSync(bin, { recursive: true });
  if (process.platform === "win32") {
    const gitBash = [
      join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
      join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "usr", "bin", "bash.exe"),
    ].find((p) => existsSync(p)) ?? "bash.exe";
    writeExecutableNodeScript(
      join(bin, "gh"),
      `
import { spawnSync } from "node:child_process";
const res = spawnSync(${JSON.stringify(gitBash)}, ["-c", ${JSON.stringify(script)}, "gh", ...process.argv.slice(2)], { stdio: "inherit", windowsHide: true });
process.exit(res.status ?? 1);
`,
    );
    vi.stubEnv("PATH", `${bin}${delimiter}${dirname(process.execPath)}`);
    return;
  }
  writeFileSync(join(bin, "gh"), `#!/bin/sh\n${script}\n`);
  chmodSync(join(bin, "gh"), 0o755);
  vi.stubEnv("PATH", `${bin}:/bin:/usr/bin`);
}

describe("parsePrList", () => {
  it("取第一个 PR 的编号、状态、网址，别的字段不带", () => {
    expect(parsePrList('[{"number":97,"state":"OPEN","url":"https://github.com/o/r/pull/97","title":"x","body":"secret"}]')).toEqual({
      number: 97,
      state: "OPEN",
      url: "https://github.com/o/r/pull/97",
    });
  });

  it.each(["", "not json", "{}", "[]", '[{"number":"97","state":"OPEN","url":"u"}]', '[{"number":97}]', "null"])("认不出的当没有：%j", (input) => {
    expect(parsePrList(input)).toBeNull();
  });
});

describe("probePr", () => {
  it("gh 退出码 0 且输出空数组 []：真的没有 PR，返回 null", async () => {
    fakeGh("printf '[]\\n'");
    await expect(probePr(root, "hub/1-x")).resolves.toBeNull();
  });

  it("gh 退出码 0 且有 PR：返回 PR 信息", async () => {
    fakeGh('printf \'[{"number":42,"state":"OPEN","url":"https://github.com/o/r/pull/42"}]\\n\'');
    await expect(probePr(root, "hub/1-x")).resolves.toEqual({
      number: 42,
      state: "OPEN",
      url: "https://github.com/o/r/pull/42",
    });
  });

  it("gh 没装（ENOENT）：不抛错，返回 gh 没装", async () => {
    vi.stubEnv("PATH", join(root, "empty-bin"));
    await expect(probePr(root, "hub/1-x")).resolves.toEqual({ unavailable: "gh 没装" });
  });

  it("gh 超时：不抛错，返回 gh 超时", async () => {
    fakeGh("exec sleep 30");
    await expect(probePr(root, "hub/1-x", 100)).resolves.toEqual({ unavailable: "gh 超时" });
  });

  it("gh 未登录或报错：不抛错，返回不可用原因，并在 hub worker show 中显示 PR 查不了（<原因>）", async () => {
    fakeGh("echo 'To get started with GitHub CLI, please run: gh auth login' >&2; exit 4");
    const pr = await probePr(root, "hub/1-x");
    expect(pr).toEqual({ unavailable: "gh 未登录或无权限" });
    expect(describeGhError(Object.assign(new Error("net"), { code: "1" }), "dial tcp: lookup api.github.com: no such host (network)")).toBe(
      "gh 网络错误",
    );

    const db = openTestDb();
    try {
      const dataHome = join(root, ".agent-hub");
      const ledger = createLedger(db, {
        now: () => 1_700_000_000_000,
        pmHomeRoot: join(dataHome, "pm-home"),
        dataHome,
        worktreesDir: join(dataHome, "worktrees"),
        resolveFolder: createResolveFolder({ dataHome, userHome: root }),
      });
      const pm = ledger.createPm({ name: "小林", mode: "manage_only", persona: "" });
      const repo = join(root, "repo");
      mkdirSync(repo, { recursive: true });
      ledger.hubCall(pm.sessionId, "project.create", { folder: repo });
      const w = ledger.hubCall(
        pm.sessionId,
        "worker.start",
        { title: "修 PR", task: "x" },
        { workspace: { kind: "ok", isRepoWithCommit: true, hasUncommittedChanges: false } },
      ).data.worker.id;

      // 空数组（probePr 返回 null）时不显示 PR 行
      const noPrText = ledger.hubCall(pm.sessionId, "worker.show", { workerId: w }, {}).text;
      expect(noPrText).not.toContain("PR ");

      // gh 报错/超时返回 { unavailable } 时显示 PR 查不了（<原因>）
      const errText = ledger.hubCall(pm.sessionId, "worker.show", { workerId: w }, { pr }).text;
      expect(errText).toContain("PR 查不了（gh 未登录或无权限）");
    } finally {
      db.close();
    }
  });
});

describe("probePrByUrl（hub graph finish 查 hub graph done --pr 手工补记的 PR）", () => {
  it("gh pr view 输出单个对象：取编号、状态、网址", async () => {
    fakeGh(`[ "$1 $2" = "pr view" ] || exit 9; echo '{"number":301,"state":"OPEN","url":"'"$3"'","title":"x"}'`);
    const url = "https://github.com/o/r/pull/301";
    expect(await probePrByUrl(root, url)).toEqual({ number: 301, state: "OPEN", url });
  });

  it("不是 http(s) 网址（含以 - 开头会被当成参数的）不调 gh，返回 null", async () => {
    fakeGh("echo called >&2; exit 1");
    expect(await probePrByUrl(root, "--repo=evil/x")).toBeNull();
    expect(await probePrByUrl(root, "#301")).toBeNull();
  });

  it("gh 报错（比如不是 GitHub 的网址）：返回不可用原因，不抛错", async () => {
    fakeGh("echo 'none of the git remotes configured for this repository point to a known GitHub host' >&2; exit 1");
    expect(await probePrByUrl(root, "https://example.test/pr/1")).toMatchObject({ unavailable: expect.any(String) });
  });

  it("parsePrView：不是对象或缺字段返回 null", () => {
    expect(parsePrView("not json")).toBeNull();
    expect(parsePrView("[]")).toBeNull();
    expect(parsePrView('{"number":"1","state":"OPEN","url":"u"}')).toBeNull();
  });
});
