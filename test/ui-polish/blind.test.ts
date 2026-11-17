import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaptureManifest, CapturedShot } from "./capture.ts";
import { BLIND_PLAN_FILE, type BlindPlan } from "./blind.ts";
import { main } from "./cli.ts";
import { CALIBRATION_BASELINE, MUTATIONS, SENTINEL_MUTATIONS } from "./mutations.ts";
import type { Finding } from "./rubric.ts";
import { SCREEN_INVENTORY } from "./screens.ts";

const JUDGES = ["agy/gemini-4-carbon", "claude/opus"] as const;
const COMMIT = "abcdef1234567890abcdef1234567890abcdef12";
const HINT_WORDS = ["哨兵", "弄坏", "校准", "基准图候选", "sentinel", "mutation"];

const tempDirs: string[] = [];
const makeTempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "ui-polish-blind-"));
  tempDirs.push(dir);
  return dir;
};
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** 截好的一轮：每张图写一个内容各不相同的假 PNG，清单里的 sha256 只要格式对。 */
function writeRound(dir: string, keys: readonly string[]): CaptureManifest {
  mkdirSync(dir, { recursive: true });
  const shots: CapturedShot[] = keys.map((key, i) => {
    writeFileSync(join(dir, `${key}.png`), `png ${key}`);
    return {
      key,
      screenId: key.split("@")[0]!,
      viewport: key.split("@")[1]!.split("!")[0] as CapturedShot["viewport"],
      file: `${key}.png`,
      sha256: i.toString(16).padStart(64, "0"),
      machineFindings: [],
    };
  });
  const manifest: CaptureManifest = { commit: COMMIT, browser: "chromium 159", shots };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  return manifest;
}

function captureOutput() {
  const io = { out: "", err: "" };
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    io.out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    io.err += String(chunk);
    return true;
  });
  return io;
}

const readPlan = (dir: string): BlindPlan => JSON.parse(readFileSync(join(dir, BLIND_PLAN_FILE), "utf8")) as BlindPlan;

/** 把这一批 brief 里列的评分卡路径和 sha256 读出来，照着交卡。 */
function cardTargets(brief: string): Array<{ path: string; sha256: string; id: string }> {
  const targets: Array<{ path: string; sha256: string; id: string }> = [];
  const pattern = /- `imageSha256`：`([0-9a-f]{64})`\n- 评分卡写入路径：`([^`]+)`/g;
  for (const m of brief.matchAll(pattern)) {
    const path = m[2]!;
    targets.push({ sha256: m[1]!, path, id: path.split("/").pop()!.replace(/\.json$/, "") });
  }
  return targets;
}

function writeCard(target: { path: string; sha256: string; id: string }, judge: string, run: number, findings: Finding[] = []) {
  mkdirSync(join(target.path, ".."), { recursive: true });
  writeFileSync(
    target.path,
    JSON.stringify({
      shot: target.id,
      judge,
      run,
      imageSha256: target.sha256,
      findings,
      holistic: { style: 10, standard: 10, aesthetic: 10, ux: 10 },
      summary: "ok",
    }),
  );
}

function expectBlind(text: string, realKeys: readonly string[]) {
  expect(text).not.toContain("!");
  for (const word of HINT_WORDS) expect(text).not.toContain(word);
  for (const m of MUTATIONS) expect(text).not.toContain(m.id);
  for (const key of realKeys) expect(text).not.toContain(key);
}

const SENTINEL_KEYS = [CALIBRATION_BASELINE, ...SENTINEL_MUTATIONS.map((id) => `${CALIBRATION_BASELINE}!${id}`)];
const CAL_KEYS = [CALIBRATION_BASELINE, ...MUTATIONS.map((m) => `${CALIBRATION_BASELINE}!${m.id}`), "router.model-picker@desktop"];
const REVIEW_KEYS = ["chat.normal@desktop", "chat.normal@mobile", "quota.normal@desktop", "router.model-picker@desktop", "settings.providers@desktop"];

/** 跑完一次校准：C1 截图、两家评委各评 CALIBRATION_RUNS 次（都没有发现），写出校准记录。 */
async function calibrated(repoRoot: string, outRoot: string) {
  writeRound(join(outRoot, "C1"), CAL_KEYS);
  const io = captureOutput();
  for (const judge of JUDGES) {
    for (const run of [1, 2, 3]) {
      io.out = "";
      expect(await main(["brief", "--round", "C1", "--judge", judge, "--batch", "1", "--batch-size", "28", "--run", String(run), "--repo-root", repoRoot, "--out-root", outRoot])).toBe(0);
      for (const t of cardTargets(io.out)) writeCard(t, judge, run);
    }
  }
  await main(["calibration", "--round", "C1", "--repo-root", repoRoot, "--out-root", outRoot]);
  vi.restoreAllMocks();
}

describe("评委看到的只有盲测编号", () => {
  it("校准轮的 brief 里没有 !、弄坏的名字、真实界面 key 和任何提示词", async () => {
    const repoRoot = makeTempDir();
    const outRoot = makeTempDir();
    writeRound(join(outRoot, "C1"), CAL_KEYS);
    const io = captureOutput();
    expect(await main(["brief", "--round", "C1", "--judge", JUDGES[0], "--batch", "1", "--batch-size", "28", "--repo-root", repoRoot, "--out-root", outRoot])).toBe(0);
    expectBlind(io.out, CAL_KEYS);
    expect(cardTargets(io.out)).toHaveLength(CAL_KEYS.length);
    const json = /```json\n([\s\S]*?)\n```/.exec(io.out)![1]!;
    expect((JSON.parse(json) as { shot: string }).shot).toMatch(/^item-\d+$/);
  });

  it("评委看的图是轮次目录 judge/ 下按编号复制的一份，内容和原图一样", async () => {
    const repoRoot = makeTempDir();
    const outRoot = makeTempDir();
    const dir = join(outRoot, "C1");
    writeRound(dir, CAL_KEYS);
    const io = captureOutput();
    expect(await main(["brief", "--round", "C1", "--judge", JUDGES[0], "--batch", "1", "--batch-size", "28", "--repo-root", repoRoot, "--out-root", outRoot])).toBe(0);
    const files = [...io.out.matchAll(/- 整屏图：`([^`]+)`/g)].map((m) => m[1]!);
    expect(files).toHaveLength(CAL_KEYS.length);
    const plan = readPlan(dir);
    for (const file of files) {
      expect(file.startsWith(join(dir, "judge"))).toBe(true);
      const item = plan.items.find((i) => file.endsWith(`/${i.id}.png`))!;
      expect(readFileSync(file, "utf8")).toBe(`png ${item.key}`);
    }
  });

  it("界面标题里不再写基准图候选", () => {
    for (const spec of SCREEN_INVENTORY) expect(spec.title).not.toContain("基准图候选");
  });

  it("评委按编号交的卡，check-cards 和 calibration 都认得出是哪张图", async () => {
    const repoRoot = makeTempDir();
    const outRoot = makeTempDir();
    await calibrated(repoRoot, outRoot);
    const record = JSON.parse(readFileSync(join(repoRoot, "docs/ui-polish/rounds/C1.json"), "utf8")) as { calibration: { mutations: Array<{ id: string; hits: number }> } };
    expect(record.calibration.mutations.map((m) => m.id)).toContain(MUTATIONS[0]!.id);
    captureOutput();
    for (const judge of JUDGES) {
      expect(await main(["check-cards", "--round", "C1", "--judge", judge, "--batch-size", "28", "--repo-root", repoRoot, "--out-root", outRoot])).toBe(0);
    }
  });
});

describe("正式评审混进哨兵图", () => {
  it("校准过后，评审轮的批次里混进基准图和两张弄坏的图，评委看不出来", async () => {
    const repoRoot = makeTempDir();
    const outRoot = makeTempDir();
    await calibrated(repoRoot, outRoot);
    const dir = join(outRoot, "R01");
    writeRound(dir, REVIEW_KEYS);
    const io = captureOutput();
    const seen: string[] = [];
    for (let batch = 1; batch <= 4; batch++) {
      io.out = "";
      expect(await main(["brief", "--round", "R01", "--judge", JUDGES[0], "--batch", String(batch), "--batch-size", "2", "--repo-root", repoRoot, "--out-root", outRoot])).toBe(0);
      expectBlind(io.out, [...REVIEW_KEYS, ...SENTINEL_KEYS]);
      seen.push(...cardTargets(io.out).map((t) => t.id));
    }
    const plan = readPlan(dir);
    const sentinels = plan.items.filter((i) => i.sentinel);
    expect(sentinels.map((i) => i.key).sort()).toEqual([...SENTINEL_KEYS].sort());
    expect(seen.sort()).toEqual(plan.items.map((i) => i.id).sort());
  });

  it("哨兵的分和校准时差得超过 1 分，score 判这次评审作废；不超过就照常合分", async () => {
    const repoRoot = makeTempDir();
    const outRoot = makeTempDir();
    await calibrated(repoRoot, outRoot);
    writeRound(join(outRoot, "R01"), REVIEW_KEYS);
    const io = captureOutput();
    const all: Array<{ path: string; sha256: string; id: string }> = [];
    for (const judge of JUDGES) {
      for (let batch = 1; batch <= 4; batch++) {
        io.out = "";
        expect(await main(["brief", "--round", "R01", "--judge", judge, "--batch", String(batch), "--batch-size", "2", "--repo-root", repoRoot, "--out-root", outRoot])).toBe(0);
        for (const t of cardTargets(io.out)) {
          writeCard(t, judge, 1);
          all.push(t);
        }
      }
    }
    const plan = readPlan(join(outRoot, "R01"));
    const drifting = plan.items.find((i) => i.sentinel)!;
    const p0 = (x: number): Finding => ({ rule: "machine:clipped", severity: "P0", box: { x, y: 0.1, w: 0.05, h: 0.05 }, what: "裁掉", fix: "放开" });
    writeCard(all.find((t) => t.id === drifting.id)!, JUDGES[0], 1, [p0(0.1), p0(0.5)]);
    io.err = "";
    expect(await main(["score", "--round", "R01", "--repo-root", repoRoot, "--out-root", outRoot])).toBe(1);
    expect(io.err).toContain("作废");
    expect(existsSync(join(repoRoot, "docs/ui-polish/rounds/R01.json"))).toBe(false);

    writeCard(all.find((t) => t.id === drifting.id)!, JUDGES[0], 1);
    expect(await main(["score", "--round", "R01", "--repo-root", repoRoot, "--out-root", outRoot])).toBe(0);
    const record = JSON.parse(readFileSync(join(repoRoot, "docs/ui-polish/rounds/R01.json"), "utf8")) as { shots: Array<{ shotKey: string }> };
    expect(record.shots.map((s) => s.shotKey).sort()).toEqual([...REVIEW_KEYS].sort());
  });

  it("有校准记录但校准轮的图不在了，评审轮拒绝出 brief，不悄悄跳过哨兵", async () => {
    const repoRoot = makeTempDir();
    const outRoot = makeTempDir();
    await calibrated(repoRoot, outRoot);
    rmSync(join(outRoot, "C1"), { recursive: true, force: true });
    writeRound(join(outRoot, "R01"), REVIEW_KEYS);
    const io = captureOutput();
    expect(await main(["brief", "--round", "R01", "--judge", JUDGES[0], "--batch", "1", "--repo-root", repoRoot, "--out-root", outRoot])).toBe(1);
    expect(io.err).toContain("C1");
  });
});
