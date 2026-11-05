// 命令列表的缓存（方案第 5 节 8、20、22；正在跑的会话、commands_changed）。
import { describe, expect, it, vi } from "vitest";
import { COMMANDS_FRESH_MS, COMMANDS_RETRY_MS, type ComposerCommand } from "../shared/index.ts";
import { createCommandCatalogs, type CommandsRequest } from "./commands-catalog.ts";
import { claudeComposerBase, type VendorComposer } from "./vendors/index.ts";

const LIST: ComposerCommand[] = [
  { name: "x", description: "probe command x (project)", argumentHint: "word" },
  { name: "compact", description: "Free up context" },
  { name: "clear", description: "Start a new session", argumentHint: "[name]" },
  { name: "model", description: "Set the AI model" },
  { name: "doctor", description: "Health-check" },
];
const VISIBLE = ["x", "compact"];
const REQ: CommandsRequest = { sessionId: 1, vendor: "claude", cwd: "/repo", addDirs: [] };

function setup(opts: { running?: () => Promise<ComposerCommand[] | null>; query?: () => Promise<ComposerCommand[]> } = {}) {
  let clock = 1_000_000;
  const query = vi.fn(opts.query ?? (async () => LIST));
  const vendor: VendorComposer = { ...claudeComposerBase, queryCommands: query };
  const queryRunning = vi.fn(opts.running ?? (async () => null));
  const logs: string[] = [];
  const catalogs = createCommandCatalogs({ vendors: { claude: vendor }, queryRunning, now: () => clock, log: (l) => logs.push(l) });
  return { catalogs, query, queryRunning, logs, advance: (ms: number) => (clock += ms) };
}

const names = (list: ComposerCommand[]) => list.map((c) => c.name);

describe("命令列表", () => {
  it("8：隐藏的命令（clear、model、doctor……）不在列表里", async () => {
    const t = setup();
    expect(names(await t.catalogs.list(REQ))).toEqual(VISIBLE);
  });

  it("会话正在跑：直接问它（不另起进程），问到的也写进缓存", async () => {
    const t = setup({ running: async () => [{ name: "fromSession", description: "" }, ...LIST] });
    expect(names(await t.catalogs.list(REQ))).toEqual(["fromSession", ...VISIBLE]);
    expect(t.queryRunning).toHaveBeenCalledWith(1);
    expect(t.query).not.toHaveBeenCalled();
  });

  it("会话没在跑：另起进程问（在会话的目录里，带附加文件夹）", async () => {
    const t = setup();
    await t.catalogs.list({ ...REQ, addDirs: ["/other"] });
    expect(t.query).toHaveBeenCalledWith({ cwd: "/repo", addDirs: ["/other"] }, expect.any(AbortSignal));
  });

  it("22：缓存：连续两次（含同时来的）只起一次进程；COMMANDS_FRESH_MS 后先给旧的，后台再问，问到就换新的", async () => {
    let version = 1;
    const t = setup({ query: async () => [{ name: `v${version}`, description: "" }] });
    const [a, b] = await Promise.all([t.catalogs.list(REQ), t.catalogs.list(REQ)]);
    expect(names(a)).toEqual(["v1"]);
    expect(names(b)).toEqual(["v1"]);
    expect(names(await t.catalogs.list(REQ))).toEqual(["v1"]);
    expect(t.query).toHaveBeenCalledTimes(1);

    version = 2;
    t.advance(COMMANDS_FRESH_MS);
    expect(names(await t.catalogs.list(REQ))).toEqual(["v1"]);
    expect(t.query).toHaveBeenCalledTimes(2);
    await vi.waitFor(async () => expect(names(await t.catalogs.list(REQ))).toEqual(["v2"]));
    expect(t.query).toHaveBeenCalledTimes(2);
  });

  it("缓存按（厂商、目录）分开：别的目录另问", async () => {
    const t = setup();
    await t.catalogs.list(REQ);
    await t.catalogs.list({ ...REQ, cwd: "/other" });
    await t.catalogs.list({ ...REQ, addDirs: ["/x"] });
    expect(t.query).toHaveBeenCalledTimes(3);
  });

  it("20：问不到：空列表、不报错、记日志；COMMANDS_RETRY_MS 之内不再问，之后再问", async () => {
    let fail = true;
    const t = setup({
      query: async () => {
        if (fail) throw new Error("claude 没装");
        return LIST;
      },
    });
    await expect(t.catalogs.list(REQ)).resolves.toEqual([]);
    expect(t.logs.some((l) => l.includes("claude 没装"))).toBe(true);
    await expect(t.catalogs.list(REQ)).resolves.toEqual([]);
    expect(t.query).toHaveBeenCalledTimes(1);
    fail = false;
    t.advance(COMMANDS_RETRY_MS);
    expect(names(await t.catalogs.list(REQ))).toEqual(VISIBLE);
    expect(t.query).toHaveBeenCalledTimes(2);
  });

  it("问正在跑的会话出错也当没在跑", async () => {
    const t = setup({ running: async () => Promise.reject(new Error("boom")) });
    expect(names(await t.catalogs.list(REQ))).toEqual(VISIBLE);
    expect(t.query).toHaveBeenCalledTimes(1);
  });

  it("正在跑的会话推来新名单（commands_changed）：缓存跟着换，会话停了也给新的", async () => {
    const t = setup();
    expect(names(await t.catalogs.list(REQ))).toEqual(VISIBLE);
    t.catalogs.update(REQ, [{ name: "newcmd", description: "new" }, ...LIST]);
    expect(names(await t.catalogs.list(REQ))).toEqual(["newcmd", ...VISIBLE]);
    expect(t.query).toHaveBeenCalledTimes(1);
  });

  it("不认识的厂商：空列表，不问", async () => {
    const t = setup();
    await expect(t.catalogs.list({ ...REQ, vendor: "codex" })).resolves.toEqual([]);
    expect(t.query).not.toHaveBeenCalled();
    expect(t.queryRunning).not.toHaveBeenCalled();
  });

  it("关机之后：不再问，给缓存里的", async () => {
    const t = setup();
    await t.catalogs.list(REQ);
    t.catalogs.close();
    t.advance(COMMANDS_FRESH_MS);
    expect(names(await t.catalogs.list(REQ))).toEqual(VISIBLE);
    expect(t.query).toHaveBeenCalledTimes(1);
  });
});
