import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_HOME } from "../../src/shared/index.ts";
import { captureAll } from "./capture.ts";
import { assertIsolated, realPathOf } from "./isolation.ts";
import { seedScenario, startIsolatedDaemon } from "./seed.ts";

const tempDirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

/** 假的用户主目录：里面有一个放了哨兵文件的 .agent-hub，再在别处放一个指向它的软链。 */
function fakeWorld() {
  const root = mkdtempSync(join(tmpdir(), "ui-polish-iso-"));
  tempDirs.push(root);
  const userHome = join(root, "home");
  const data = join(userHome, ".agent-hub");
  mkdirSync(join(data, "shots", "standard"), { recursive: true });
  writeFileSync(join(data, "shots", "keep.txt"), "keep");
  writeFileSync(join(data, "shots", "standard", "important.db"), "keep");
  const link = join(root, "link-to-data");
  symlinkSync(data, link);
  const custom = join(root, "custom-hub");
  mkdirSync(custom);
  writeFileSync(join(custom, "keep.txt"), "keep");
  const elsewhere = join(root, "elsewhere");
  mkdirSync(elsewhere);
  return { root, userHome, data, link, custom, elsewhere };
}

const intact = (w: ReturnType<typeof fakeWorld>) => {
  expect(readFileSync(join(w.data, "shots", "keep.txt"), "utf8")).toBe("keep");
  expect(readFileSync(join(w.data, "shots", "standard", "important.db"), "utf8")).toBe("keep");
  expect(readFileSync(join(w.custom, "keep.txt"), "utf8")).toBe("keep");
};

describe("realPathOf", () => {
  it("路径还不存在时，取最近一个存在的上级的真实路径再拼回去", () => {
    const w = fakeWorld();
    expect(realPathOf(join(w.link, "x", "y"))).toBe(join(realpathSync.native(w.data), "x", "y"));
  });

  it("指向还不存在的地方的软链也解开", () => {
    const w = fakeWorld();
    const dangling = join(w.root, "dangling");
    symlinkSync(join(w.data, "not-yet"), dangling);
    expect(realPathOf(join(dangling, "home"))).toBe(join(realpathSync.native(w.data), "not-yet", "home"));
  });
});

describe("assertIsolated", () => {
  it("直指真实数据目录、在它里面、把它包在里面都拒绝；无关的目录放行", () => {
    const w = fakeWorld();
    const env = {};
    expect(() => assertIsolated(w.data, env, w.userHome)).toThrow(/重叠/);
    expect(() => assertIsolated(join(w.data, "shots", "new"), env, w.userHome)).toThrow(/重叠/);
    expect(() => assertIsolated(w.userHome, env, w.userHome)).toThrow(/重叠/);
    expect(() => assertIsolated(join(w.elsewhere, "a"), env, w.userHome)).not.toThrow();
  });

  it("经软链指过去的、还不存在的子目录也拒绝", () => {
    const w = fakeWorld();
    expect(() => assertIsolated(join(w.link, "x", "home"), {}, w.userHome)).toThrow(/重叠/);
  });

  it("设了 AGENT_HUB_HOME 时，它指的目录同样受保护", () => {
    const w = fakeWorld();
    expect(() => assertIsolated(join(w.custom, "shots"), { [ENV_HOME]: w.custom }, w.userHome)).toThrow(/重叠/);
    expect(() => assertIsolated(join(w.custom, "shots"), {}, w.userHome)).not.toThrow();
  });
});

describe("动手之前先判隔离", () => {
  it("captureAll 的工作目录指进真实数据目录时，什么都不删就拒绝", async () => {
    const w = fakeWorld();
    vi.stubEnv("HOME", w.userHome);
    await expect(captureAll({ repoRoot: w.root, outDir: join(w.elsewhere, "R99"), workDir: join(w.data, "shots") })).rejects.toThrow(/重叠/);
    intact(w);
    expect(existsSync(join(w.elsewhere, "R99"))).toBe(false);
  });

  it("captureAll 的输出目录经软链指进真实数据目录时，什么都不删就拒绝", async () => {
    const w = fakeWorld();
    vi.stubEnv("HOME", w.userHome);
    writeFileSync(join(w.data, "shots", "old.png"), "keep");
    await expect(captureAll({ repoRoot: w.root, outDir: join(w.link, "shots"), workDir: join(w.elsewhere, "work") })).rejects.toThrow(/重叠/);
    intact(w);
    expect(readFileSync(join(w.data, "shots", "old.png"), "utf8")).toBe("keep");
    expect(existsSync(join(w.elsewhere, "work"))).toBe(false);
  });

  it("captureAll 的工作目录落在 AGENT_HUB_HOME 里时，什么都不删就拒绝", async () => {
    const w = fakeWorld();
    vi.stubEnv(ENV_HOME, w.custom);
    await expect(captureAll({ repoRoot: w.root, outDir: join(w.elsewhere, "R99"), workDir: w.custom })).rejects.toThrow(/重叠/);
    intact(w);
  });

  it("种子数据经软链指进真实数据目录时拒绝，一个文件都不写", async () => {
    const w = fakeWorld();
    vi.stubEnv("HOME", w.userHome);
    await expect(seedScenario({ home: join(w.link, "fresh", "home"), projectsDir: join(w.elsewhere, "projects"), scenario: "fresh" })).rejects.toThrow(/重叠/);
    expect(existsSync(join(w.data, "fresh"))).toBe(false);
    await expect(seedScenario({ home: join(w.elsewhere, "fresh", "home"), projectsDir: join(w.link, "projects"), scenario: "fresh" })).rejects.toThrow(/重叠/);
    expect(existsSync(join(w.data, "projects"))).toBe(false);
    expect(existsSync(join(w.elsewhere, "fresh"))).toBe(false);
  });

  it("隔离守护进程的数据目录经软链指进真实数据目录时拒绝，不建草稿目录", async () => {
    const w = fakeWorld();
    vi.stubEnv("HOME", w.userHome);
    await expect(startIsolatedDaemon({ home: join(w.link, "standard", "home"), repoRoot: w.root })).rejects.toThrow(/重叠/);
    expect(existsSync(join(w.data, "standard", "home-scratch"))).toBe(false);
  });
});
