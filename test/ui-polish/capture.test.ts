import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Page, Route } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openStore } from "../../src/daemon/store/index.ts";
import { API_PATHS, ENV_HOME } from "../../src/shared/index.ts";
import { resolveHubPaths } from "../../src/shared/paths.ts";
import { BLIND_PLAN_FILE, type BlindPlan } from "./blind.ts";
import { diffManifests, type CaptureManifest, type CapturedShot } from "./capture.ts";
import { MACHINE_CHECKS } from "./checks.ts";
import { main } from "./cli.ts";
import { MUTATIONS, applyMutation } from "./mutations.ts";
import { applyPatch, blockWrites } from "./patches.ts";
import { DIMENSIONS } from "./rubric.ts";
import { seedScenario } from "./seed.ts";

const shot = (key: string, sha256: string, focusSha256?: string): CapturedShot => ({
  key,
  screenId: key.split("@")[0]!,
  viewport: "desktop",
  file: `${key}.png`,
  sha256,
  ...(focusSha256 === undefined ? {} : { focusFile: `${key}.focus.png`, focusSha256 }),
  machineFindings: [],
});
const manifest = (...shots: CapturedShot[]): CaptureManifest => ({ commit: "abc", browser: "chromium 1", shots });

const tempDirs: string[] = [];
const makeTempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "ui-polish-test-"));
  tempDirs.push(dir);
  return dir;
};
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// captureAll 要起浏览器和守护进程，不在单元测试里跑，用 `pnpm ui:polish shots --verify` 验（方案第 8 节）。
describe("diffManifests", () => {
  it("两份清单每张图 sha256 都一样时返回空数组", () => {
    expect(diffManifests(manifest(shot("a@desktop", "1"), shot("b@desktop", "2")), manifest(shot("a@desktop", "1"), shot("b@desktop", "2")))).toEqual([]);
  });

  it("一张图 sha256 不同时返回它的 key", () => {
    expect(diffManifests(manifest(shot("a@desktop", "1"), shot("b@desktop", "2")), manifest(shot("a@desktop", "1"), shot("b@desktop", "3")))).toEqual(["b@desktop"]);
  });

  it("一边多出来的图也返回", () => {
    expect(diffManifests(manifest(shot("a@desktop", "1")), manifest(shot("a@desktop", "1"), shot("c@desktop", "9")))).toEqual(["c@desktop"]);
  });

  it("局部图的 sha256 不同也算", () => {
    expect(diffManifests(manifest(shot("a@desktop", "1", "f1")), manifest(shot("a@desktop", "1", "f2")))).toEqual(["a@desktop"]);
  });
});

describe("安全边界与种子数据", () => {
  it("seedScenario 在目标目录非空时抛错不覆盖", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "keep.txt"), "1");
    await expect(seedScenario({ home: dir, projectsDir: join(dir, "p"), scenario: "fresh" })).rejects.toThrow(/不是空的/);
  });

  it("同一个剧本灌两次时间戳相同，且不留待执行的动作", async () => {
    const root = makeTempDir();
    const a = await seedScenario({ home: join(root, "a"), projectsDir: join(root, "projects"), scenario: "fresh" });
    const b = await seedScenario({ home: join(root, "b"), projectsDir: join(root, "projects"), scenario: "fresh" });
    expect(a.lastAt).toBe(b.lastAt);
    const { db } = openStore(resolveHubPaths({ [ENV_HOME]: join(root, "a") }, homedir()));
    try {
      const pending = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM actions WHERE status IN ('pending', 'running')");
      expect(pending?.n).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("补丁与写请求拦截", () => {
  it("applyPatch 遇到未知补丁名抛 RangeError", async () => {
    await expect(applyPatch({} as Page, "no-such-patch")).rejects.toThrow(RangeError);
  });

  it("blockWrites 放行 GET 和 allow 里的路径，拦截其余写请求，只读型 POST 返回固定回包", async () => {
    let handler: ((route: Route) => unknown) | undefined;
    const fakePage = {
      route: async (_url: RegExp, fn: (route: Route) => unknown) => {
        handler = fn;
      },
    } as unknown as Page;
    await blockWrites(fakePage, ["/api/allowed"]);

    const dispatch = (method: string, path: string) => {
      const actions: string[] = [];
      handler!({
        request: () => ({ method: () => method, url: () => `http://127.0.0.1:9999${path}` }),
        fallback: () => actions.push("fallback"),
        abort: (code?: string) => actions.push(`abort:${code}`),
        fulfill: (res: { status?: number }) => actions.push(`fulfill:${res.status}`),
      } as unknown as Route);
      return actions;
    };

    expect(dispatch("GET", "/api/state")).toEqual(["fallback"]);
    expect(dispatch("POST", "/api/router/briefings/read")).toEqual(["abort:blockedbyclient"]);
    expect(dispatch("POST", "/api/allowed")).toEqual(["fallback"]);
    expect(dispatch("POST", API_PATHS.loginLinks)).toEqual(["fulfill:201"]);
  });
});

describe("校准用的弄坏与命令行入口", () => {
  it("10 个弄坏覆盖 P0、P1、P2，未知 id 抛 RangeError", async () => {
    expect(MUTATIONS).toHaveLength(10);
    expect(MUTATIONS.filter((m) => m.expectSeverity === "P0")).toHaveLength(3);
    expect(MUTATIONS.filter((m) => m.expectSeverity === "P1")).toHaveLength(4);
    expect(MUTATIONS.filter((m) => m.expectSeverity === "P2")).toHaveLength(3);
    for (const m of MUTATIONS) expect(DIMENSIONS).toContain(m.expectDimension);
    for (const m of MUTATIONS) expect(MACHINE_CHECKS.map((c) => c.id)).not.toContain(m.id);
    await expect(applyMutation({} as Page, "nope")).rejects.toThrow(RangeError);
  });

  it("cli inventory 返回 0，非法命令或轮次返回 2", async () => {
    let out = "";
    let err = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err += String(chunk);
      return true;
    });

    expect(await main(["inventory"])).toBe(0);
    expect(out).toContain("# 界面清单");
    expect(await main([])).toBe(2);
    expect(await main(["unknown"])).toBe(2);
    expect(await main(["shots", "--round", "bad"])).toBe(2);
    expect(err).toContain("用法：pnpm ui:polish");
  });

  it("cli brief、check-cards、score、report 全链路与无分数总览正常工作", async () => {
    const repoRoot = makeTempDir();
    const outRoot = makeTempDir();
    const r0Dir = join(outRoot, "R00");
    mkdirSync(r0Dir, { recursive: true });
    const sha1 = "1".repeat(64);
    const sha2 = "2".repeat(64);
    const sampleManifest: CaptureManifest = {
      commit: "abcdef1234567890abcdef1234567890abcdef12",
      browser: "chromium 159",
      shots: [shot("chat.normal@desktop", sha1), shot("quota.normal@desktop", sha2)],
    };
    writeFileSync(join(r0Dir, "manifest.json"), JSON.stringify(sampleManifest));
    for (const s of sampleManifest.shots) writeFileSync(join(r0Dir, s.file), s.key);

    let out = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(await main(["report", "--round", "R00", "--repo-root", repoRoot, "--out-root", outRoot])).toBe(0);
    expect(existsSync(join(r0Dir, "report.html"))).toBe(true);
    expect(readFileSync(join(r0Dir, "report.html"), "utf8")).toContain("chat.normal@desktop.png");

    out = "";
    expect(
      await main([
        "brief",
        "--round",
        "R00",
        "--judge",
        "agy/gemini-4-carbon",
        "--batch",
        "1",
        "--repo-root",
        repoRoot,
        "--out-root",
        outRoot,
      ]),
    ).toBe(0);
    const plan = JSON.parse(readFileSync(join(r0Dir, BLIND_PLAN_FILE), "utf8")) as BlindPlan;
    expect(plan.items.map((i) => i.key).sort()).toEqual(["chat.normal@desktop", "quota.normal@desktop"]);
    for (const item of plan.items) expect(out).toContain(item.id);
    expect(out).not.toContain("chat.normal@desktop");

    expect(
      await main([
        "check-cards",
        "--round",
        "R00",
        "--judge",
        "agy/gemini-4-carbon",
        "--batch",
        "1",
        "--repo-root",
        repoRoot,
        "--out-root",
        outRoot,
      ]),
    ).toBe(1);

    for (const judge of ["agy/gemini-4-carbon", "claude/opus"]) {
      const slug = judge.replaceAll("/", "__");
      const batchDir = join(r0Dir, "cards", slug, "batch-1");
      mkdirSync(batchDir, { recursive: true });
      for (const item of plan.items) {
        writeFileSync(
          join(batchDir, `${item.id}.json`),
          JSON.stringify({
            shot: item.id,
            judge,
            run: 1,
            imageSha256: item.sha256,
            findings: [],
            holistic: { style: 10, standard: 10, aesthetic: 10, ux: 10 },
            summary: "ok",
          }),
        );
      }
      expect(
        await main([
          "check-cards",
          "--round",
          "R00",
          "--judge",
          judge,
          "--batch",
          "1",
          "--repo-root",
          repoRoot,
          "--out-root",
          outRoot,
        ]),
      ).toBe(0);
    }

    expect(await main(["score", "--round", "R00", "--repo-root", repoRoot, "--out-root", outRoot])).toBe(0);
    expect(existsSync(join(repoRoot, "docs/ui-polish/rounds/R00.json"))).toBe(true);
    expect(existsSync(join(repoRoot, "docs/ui-polish/rounds.md"))).toBe(true);

    expect(await main(["report", "--round", "R00", "--repo-root", repoRoot, "--out-root", outRoot])).toBe(0);
    expect(readFileSync(join(r0Dir, "report.html"), "utf8")).toContain("agy/gemini-4-carbon");
  });

  it("cli calibration 生成校准报告和记录并按门槛返回退出码", async () => {
    const repoRoot = makeTempDir();
    const outRoot = makeTempDir();
    const c1Dir = join(outRoot, "C1");
    mkdirSync(c1Dir, { recursive: true });
    const sha = "a".repeat(64);
    const calManifest: CaptureManifest = {
      commit: "abcdef1234567890abcdef1234567890abcdef12",
      browser: "chromium 159",
      shots: [shot("chat.normal@desktop", sha)],
    };
    writeFileSync(join(c1Dir, "manifest.json"), JSON.stringify(calManifest));
    writeFileSync(join(c1Dir, "chat.normal@desktop.png"), "png");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await main(["brief", "--round", "C1", "--judge", "agy/gemini-4-carbon", "--batch", "1", "--batch-size", "28", "--repo-root", repoRoot, "--out-root", outRoot])).toBe(0);
    const [item] = (JSON.parse(readFileSync(join(c1Dir, BLIND_PLAN_FILE), "utf8")) as BlindPlan).items;
    const cardsDir = join(c1Dir, "cards", "batch-size-28", "agy__gemini-4-carbon", "run-1", "batch-1");
    mkdirSync(cardsDir, { recursive: true });
    writeFileSync(
      join(cardsDir, `${item!.id}.json`),
      JSON.stringify({
        shot: item!.id,
        judge: "agy/gemini-4-carbon",
        run: 1,
        imageSha256: sha,
        findings: [{ rule: "S1", severity: "P1", box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, what: "基准重伤", fix: "修" }],
        holistic: { style: 6, standard: 10, aesthetic: 10, ux: 10 },
        summary: "not ok",
      }),
    );

    expect(await main(["calibration", "--round", "C1", "--repo-root", repoRoot, "--out-root", outRoot])).toBe(1);
    expect(existsSync(join(repoRoot, "docs/ui-polish/calibration.md"))).toBe(true);
    expect(existsSync(join(repoRoot, "docs/ui-polish/rounds/C1.json"))).toBe(true);
  });
});
