// 命令列表的缓存（方案第 5 节 8、20、22；正在跑的会话、commands_changed）。
import { describe, expect, it, vi } from "vitest";
import { COMMANDS_FRESH_MS, COMMANDS_RETRY_MS, type ComposerCommand } from "../shared/index.ts";
import { createCommandCatalogs, type CommandsRequest } from "./commands-catalog.ts";
import { claudeComposerBase } from "../vendors/claude/composer.ts";
import type { VendorComposer } from "./vendors/index.ts";

const LIST: ComposerCommand[] = [
  { name: "x", description: "probe command x (project)", argumentHint: "word" },
  { name: "compact", description: "Free up context" },
  { name: "clear", description: "Start a new session", argumentHint: "[name]", builtin: true },
  { name: "model", description: "Set the AI model", builtin: true },
  { name: "doctor", description: "Health-check", builtin: true },
  // 用户自己的 skill 刚好叫 debug、new：不是 builtin，不藏
  { name: "debug", description: "my own debug skill" },
  { name: "new", description: "my own new command" },
];
const VISIBLE = ["x", "compact", "debug", "new"];
const REQ: CommandsRequest = { sessionId: 1, vendor: "claude", cwd: "/repo", addDirs: [] };

function setup(
  opts: { running?: () => Promise<ComposerCommand[] | null>; query?: () => Promise<ComposerCommand[]>; maxConcurrent?: number; maxEntries?: number } = {},
) {
  let clock = 1_000_000;
  const query = vi.fn(opts.query ?? (async () => LIST));
  const vendor: VendorComposer = { ...claudeComposerBase, queryCommands: query };
  const queryRunning = vi.fn(opts.running ?? (async () => null));
  const logs: string[] = [];
  const catalogs = createCommandCatalogs({
    vendors: { claude: vendor },
    queryRunning,
    now: () => clock,
    log: (l) => logs.push(l),
    ...(opts.maxConcurrent !== undefined ? { maxConcurrent: opts.maxConcurrent } : {}),
    ...(opts.maxEntries !== undefined ? { maxEntries: opts.maxEntries } : {}),
  });
  return { catalogs, query, queryRunning, logs, advance: (ms: number) => (clock += ms) };
}

const names = (list: ComposerCommand[]) => list.map((c) => c.name);

describe("命令列表", () => {
  it("8：隐藏的命令（clear、model、doctor……）不在列表里；用户自己叫 debug、new 的留着", async () => {
    const t = setup();
    expect(names(await t.catalogs.list(REQ))).toEqual(VISIBLE);
  });

  it("内部按需技能 fusa-task-graph（裸名、fusa: 前缀、skill: 前缀）不在网页 / 列表里出现，普通技能照常保留", async () => {
    const internalAndUser: ComposerCommand[] = [
      { name: "fusa-task-graph", description: "Fusa 任务图手册" },
      { name: "fusa:fusa-task-graph", description: "(fusa) Fusa 任务图手册" },
      { name: "skill:fusa-task-graph", description: "Fusa 任务图手册" },
      { name: "skill:my-skill", description: "用户自己的 Pi 技能" },
      { name: "my-plugin:helper", description: "用户自己的插件技能" },
    ];
    const idle = setup({ query: async () => [...internalAndUser, ...LIST] });
    expect(names(await idle.catalogs.list(REQ))).toEqual(["skill:my-skill", "my-plugin:helper", ...VISIBLE]);

    const live = setup({ running: async () => [...internalAndUser, ...LIST] });
    expect(names(await live.catalogs.list(REQ))).toEqual(["skill:my-skill", "my-plugin:helper", ...VISIBLE]);
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

  it("cached：缓存着的完整名单（含隐藏的），没问过是 null，不起进程", async () => {
    const t = setup();
    const { sessionId: _ignored, ...target } = REQ;
    expect(t.catalogs.cached(target)).toBeNull();
    await t.catalogs.list(REQ);
    expect(t.catalogs.cached(target)).toEqual(LIST);
    expect(t.catalogs.cached({ ...target, cwd: "/other" })).toBeNull();
    expect(t.query).toHaveBeenCalledTimes(1);
  });

  it("另起的进程同一时间最多 maxConcurrent 个，多的排队，都能问到", async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    const t = setup({
      maxConcurrent: 2,
      query: () =>
        new Promise((resolve) => {
          active++;
          peak = Math.max(peak, active);
          releases.push(() => {
            active--;
            resolve(LIST);
          });
        }),
    });
    const lists = [1, 2, 3, 4].map((n) => t.catalogs.list({ ...REQ, cwd: `/repo${n}` }));
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(t.query).toHaveBeenCalledTimes(2);
    releases[0]!();
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    releases[1]!();
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    releases[2]!();
    releases[3]!();
    for (const list of await Promise.all(lists)) expect(names(list)).toEqual(VISIBLE);
    expect(peak).toBe(2);
    expect(t.query).toHaveBeenCalledTimes(4);
  });

  it("排队的在关机时取消，不再起进程", async () => {
    let started = 0;
    const t = setup({
      maxConcurrent: 1,
      query: () => {
        started++;
        return new Promise(() => {});
      },
    });
    const first = t.catalogs.list({ ...REQ, cwd: "/a" });
    const second = t.catalogs.list({ ...REQ, cwd: "/b" });
    await vi.waitFor(() => expect(started).toBe(1));
    t.catalogs.close();
    await expect(second).resolves.toEqual([]);
    expect(started).toBe(1);
    void first;
  });

  it("缓存有上限：超过 maxEntries 份，最旧的被淘汰，再要时重新问", async () => {
    const t = setup({ maxEntries: 2 });
    for (const cwd of ["/a", "/b", "/c"]) await t.catalogs.list({ ...REQ, cwd });
    expect(t.query).toHaveBeenCalledTimes(3);
    const target = (cwd: string) => ({ vendor: "claude", cwd, addDirs: [] });
    expect(t.catalogs.cached(target("/a"))).toBeNull();
    expect(t.catalogs.cached(target("/b"))).not.toBeNull();
    expect(t.catalogs.cached(target("/c"))).not.toBeNull();
    await t.catalogs.list({ ...REQ, cwd: "/a" });
    expect(t.query).toHaveBeenCalledTimes(4);
  });
});
