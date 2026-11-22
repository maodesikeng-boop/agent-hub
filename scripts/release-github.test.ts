import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishRelease, readReleaseFacts, yankRelease, type ReleaseContext } from "./release-github.ts";
import { REQUIRED_RELEASE_ASSETS, type ReleasePlan } from "./release-plan.ts";
import { sha256FileHex } from "./stage-runtime-common.ts";

const REPO = "owner/agent-hub";
const RC_SHA = "a".repeat(40);
const HEAD_SHA = "c".repeat(40);
const INSTALLERS = REQUIRED_RELEASE_ASSETS.filter((name) => !name.endsWith(".sha256"));

interface Call {
  file: string;
  args: readonly string[];
}

type Handler = (args: readonly string[]) => string | undefined;

function fakeContext(opts: { dryRun?: boolean; handlers?: Partial<Record<string, Handler>> } = {}) {
  const calls: Call[] = [];
  const logs: string[] = [];
  const ctx: ReleaseContext = {
    repo: REPO,
    dryRun: opts.dryRun ?? false,
    log: (line) => logs.push(line),
    run: (file, args) => {
      calls.push({ file, args });
      const key = `${file} ${args.slice(0, 2).join(" ")}`;
      const out = opts.handlers?.[key]?.(args);
      if (out === undefined) throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
      return out;
    },
  };
  return { ctx, calls, logs };
}

const RELEASE_LINES = [
  { tag: "v0.4.0-rc.1", draft: false, prerelease: true, assets: [...REQUIRED_RELEASE_ASSETS] },
  { tag: "v0.4.0-rc.2", draft: true, prerelease: true, assets: [] },
  { tag: "v0.3.0", draft: false, prerelease: false, assets: [...REQUIRED_RELEASE_ASSETS] },
  { tag: "v0.2.0", draft: false, prerelease: false, assets: [...REQUIRED_RELEASE_ASSETS] },
]
  .map((release) => JSON.stringify(release))
  .join("\n");

const LS_REMOTE = [
  `${"1".repeat(40)}\trefs/tags/v0.3.0`,
  `${"3".repeat(40)}\trefs/tags/v0.3.0^{}`,
  `${RC_SHA}\trefs/tags/v0.4.0-rc.1`,
  `${"2".repeat(40)}\trefs/tags/v0.2.0`,
].join("\n");

function factHandlers(onMain: boolean): Partial<Record<string, Handler>> {
  return {
    "gh api --paginate": () => RELEASE_LINES,
    "git ls-remote --tags": () => LS_REMOTE,
    "git rev-parse HEAD": () => `${HEAD_SHA}\n`,
    "git rev-parse --verify": () => "",
    "git merge-base --is-ancestor": () => {
      if (!onMain) throw new Error("exit 1");
      return "";
    },
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeAssets(dir: string, corrupt?: string): void {
  mkdirSync(dir, { recursive: true });
  for (const name of INSTALLERS) {
    writeFileSync(join(dir, name), `bytes of ${name}`);
    const hash = name === corrupt ? "0".repeat(64) : sha256FileHex(join(dir, name));
    writeFileSync(join(dir, `${name}.sha256`), `${hash}  ${name}\n`);
  }
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fusa-release-gh-"));
  dirs.push(dir);
  return dir;
}

function writes(calls: readonly Call[]): string[] {
  return calls.filter((c) => c.args[0] === "release" && (c.args[1] === "create" || c.args[1] === "edit")).map((c) => c.args.join(" "));
}

describe("readReleaseFacts", () => {
  it("reads every release with its tag commit, draft and prerelease flags, and asset names", () => {
    const { ctx } = fakeContext({ handlers: factHandlers(true) });
    const facts = readReleaseFacts("v0.4.0-rc.1", "0.4.0", ctx);
    expect(facts.tag).toBe("v0.4.0-rc.1");
    expect(facts.commit).toBe(RC_SHA);
    expect(facts.releases).toEqual([
      { tag: "v0.4.0-rc.1", commit: RC_SHA, draft: false, prerelease: true, assets: [...REQUIRED_RELEASE_ASSETS] },
      { tag: "v0.4.0-rc.2", commit: "", draft: true, prerelease: true, assets: [] },
      { tag: "v0.3.0", commit: "3".repeat(40), draft: false, prerelease: false, assets: [...REQUIRED_RELEASE_ASSETS] },
      { tag: "v0.2.0", commit: "2".repeat(40), draft: false, prerelease: false, assets: [...REQUIRED_RELEASE_ASSETS] },
    ]);
  });

  it("reports onMain from git merge-base --is-ancestor against origin/main", () => {
    const onMain = fakeContext({ handlers: factHandlers(true) });
    expect(readReleaseFacts("v0.4.0-rc.1", "0.4.0", onMain.ctx).onMain).toBe(true);
    expect(onMain.calls.find((c) => c.args[0] === "merge-base")?.args).toEqual(["merge-base", "--is-ancestor", RC_SHA, "origin/main"]);
    const offMain = fakeContext({ handlers: factHandlers(false) });
    expect(readReleaseFacts("v0.4.0-rc.1", "0.4.0", offMain.ctx).onMain).toBe(false);
  });

  it("uses HEAD as the commit when a dry run rehearses a tag that does not exist yet", () => {
    const { ctx } = fakeContext({ dryRun: true, handlers: factHandlers(true) });
    expect(readReleaseFacts("v0.3.0-rc.99", "0.3.0", ctx).commit).toBe(HEAD_SHA);
  });

  it("refuses to read facts for a real publish when the remote no longer has the tag", () => {
    const { ctx } = fakeContext({ handlers: factHandlers(true) });
    expect(() => readReleaseFacts("v0.4.0-rc.2", "0.4.0", ctx)).toThrow("Tag v0.4.0-rc.2 does not exist on origin");
  });
});

const BUILD: ReleasePlan = { mode: "build", tag: "v0.4.0-rc.2", version: "0.4.0", rc: 2 };
const PROMOTE: ReleasePlan = { mode: "promote", tag: "v0.4.0", version: "0.4.0", fromTag: "v0.4.0-rc.1", commit: RC_SHA };

function flagValue(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx < 0 ? undefined : args[idx + 1];
}

/** Mirrors gh attestation verify: each optional --source-* flag must match the attested certificate, and an absent flag checks nothing. */
function promoteHandlers(opts: { corrupt?: string; unattested?: string; attestedCommit?: string } = {}): Partial<Record<string, Handler>> {
  const attested = { ref: "refs/tags/v0.4.0-rc.1", digest: opts.attestedCommit ?? RC_SHA };
  return {
    "gh release download": (args) => {
      writeAssets(args[args.indexOf("--dir") + 1]!, opts.corrupt);
      return "";
    },
    "gh attestation verify": (args) => {
      if (opts.unattested && args[2]!.endsWith(opts.unattested)) throw new Error("no attestations found");
      const ref = flagValue(args, "--source-ref");
      const digest = flagValue(args, "--source-digest");
      if (ref !== undefined && ref !== attested.ref) throw new Error(`source ref ${attested.ref} does not match ${ref}`);
      if (digest !== undefined && digest !== attested.digest) throw new Error(`source digest ${attested.digest} does not match ${digest}`);
      return "";
    },
    "gh release create": () => "",
    "gh release edit": () => "",
  };
}

describe("publishRelease", () => {
  it("creates a build plan's release as a draft, uploads every asset, then publishes it as a prerelease", () => {
    const assetsDir = tempDir();
    writeAssets(assetsDir);
    const { ctx, calls } = fakeContext({ handlers: promoteHandlers() });
    publishRelease(BUILD, { assetsDir, notesFile: "notes.md" }, ctx);
    const [create, publish] = calls;
    expect(create!.args.slice(0, 11)).toEqual([
      "release", "create", "v0.4.0-rc.2", "--repo", REPO, "--draft", "--verify-tag", "--title", "Bellwood v0.4.0-rc.2 (unsigned preview)", "--notes-file", "notes.md",
    ]);
    expect(create!.args).toContain("--prerelease");
    expect(create!.args.slice(-REQUIRED_RELEASE_ASSETS.length)).toEqual(REQUIRED_RELEASE_ASSETS.map((name) => join(assetsDir, name)));
    expect(publish!.args).toEqual(["release", "edit", "v0.4.0-rc.2", "--repo", REPO, "--draft=false"]);
    expect(calls).toHaveLength(2);
  });

  it("downloads the rc assets for a promote plan and publishes them as latest under the formal tag", () => {
    const assetsDir = join(tempDir(), "assets");
    const { ctx, calls } = fakeContext({ handlers: promoteHandlers() });
    publishRelease(PROMOTE, { assetsDir, notesFile: "notes.md" }, ctx);
    expect(calls[0]!.args.slice(0, 7)).toEqual(["release", "download", "v0.4.0-rc.1", "--repo", REPO, "--dir", assetsDir]);
    const attested = calls.filter((c) => c.args[0] === "attestation");
    expect(attested.map((c) => c.args[2])).toEqual(INSTALLERS.map((name) => join(assetsDir, name)));
    expect(attested[0]!.args).toContain(`${REPO}/.github/workflows/release.yml`);
    expect(flagValue(attested[0]!.args, "--source-ref")).toBe("refs/tags/v0.4.0-rc.1");
    expect(flagValue(attested[0]!.args, "--source-digest")).toBe(RC_SHA);
    const [create, publish] = writes(calls);
    expect(create).toContain("release create v0.4.0 ");
    expect(create).not.toContain("--prerelease");
    expect(publish).toBe(`release edit v0.4.0 --repo ${REPO} --draft=false --latest`);
  });

  it("refuses to publish a promoted asset whose .sha256 does not match", () => {
    const { ctx, calls } = fakeContext({ handlers: promoteHandlers({ corrupt: INSTALLERS[0] }) });
    expect(() => publishRelease(PROMOTE, { assetsDir: tempDir(), notesFile: "notes.md" }, ctx)).toThrow(`SHA-256 of ${INSTALLERS[0]} is `);
    expect(writes(calls)).toEqual([]);
  });

  it("refuses to publish a promoted asset without a release.yml build provenance attestation", () => {
    const { ctx, calls } = fakeContext({ handlers: promoteHandlers({ unattested: INSTALLERS[1] }) });
    expect(() => publishRelease(PROMOTE, { assetsDir: tempDir(), notesFile: "notes.md" }, ctx)).toThrow("no attestations found");
    expect(writes(calls)).toEqual([]);
  });

  it("refuses to promote rc installers attested on a different commit than the formal tag", () => {
    const { ctx, calls } = fakeContext({ handlers: promoteHandlers({ attestedCommit: "b".repeat(40) }) });
    expect(() => publishRelease(PROMOTE, { assetsDir: tempDir(), notesFile: "notes.md" }, ctx)).toThrow(`does not match ${RC_SHA}`);
    expect(writes(calls)).toEqual([]);
  });

  it("never passes --clobber and never uploads to or edits an existing release", () => {
    for (const plan of [BUILD, PROMOTE]) {
      const assetsDir = tempDir();
      writeAssets(assetsDir);
      const { ctx, calls } = fakeContext({ handlers: promoteHandlers() });
      publishRelease(plan, { assetsDir, notesFile: "notes.md" }, ctx);
      expect(calls.flatMap((c) => c.args)).not.toContain("--clobber");
      expect(calls.some((c) => c.args[1] === "upload" || c.args[1] === "delete")).toBe(false);
      // The only edit publishes the draft this call just created.
      const [create, edit] = writes(calls);
      expect(create).toContain("--draft");
      expect(edit).toContain(`release edit ${plan.tag} `);
    }
  });

  it("logs every write command and runs only read commands in dry-run mode", () => {
    const buildDir = tempDir();
    writeAssets(buildDir);
    const build = fakeContext({ dryRun: true, handlers: promoteHandlers() });
    publishRelease(BUILD, { assetsDir: buildDir, notesFile: "notes.md" }, build.ctx);
    expect(build.calls).toEqual([]);
    expect(build.logs).toEqual([
      expect.stringMatching(/^\[dry-run\] gh release create v0\.4\.0-rc\.2 .*--draft --verify-tag .*--prerelease/),
      `[dry-run] gh release edit v0.4.0-rc.2 --repo ${REPO} --draft=false`,
    ]);

    const promote = fakeContext({ dryRun: true, handlers: promoteHandlers() });
    publishRelease(PROMOTE, { assetsDir: tempDir(), notesFile: "notes.md" }, promote.ctx);
    expect(promote.calls.map((c) => c.args[0])).toEqual(["release", "attestation", "attestation"]);
    expect(writes(promote.calls)).toEqual([]);
    expect(promote.logs.filter((line) => line.startsWith("[dry-run]"))).toHaveLength(2);
  });
});

function yankHandlers(latestAfter: string): Partial<Record<string, Handler>> {
  return {
    "gh api --paginate": () => RELEASE_LINES,
    "gh release edit": () => "",
    [`gh api repos/${REPO}/releases/latest`]: () => `${latestAfter}\n`,
  };
}

describe("yankRelease", () => {
  it("marks the release as a prerelease that is not latest and marks the previous formal release as latest", () => {
    const { ctx, calls } = fakeContext({ handlers: yankHandlers("v0.2.0") });
    expect(yankRelease("v0.3.0", ctx)).toBe("v0.2.0");
    expect(writes(calls)).toEqual([
      `release edit v0.3.0 --repo ${REPO} --prerelease --latest=false`,
      `release edit v0.2.0 --repo ${REPO} --latest`,
    ]);
  });

  it("confirms that releases/latest returns the previous formal release", () => {
    const { ctx, calls } = fakeContext({ handlers: yankHandlers("v0.2.0") });
    yankRelease("v0.3.0", ctx);
    expect(calls.at(-1)!.args).toEqual(["api", `repos/${REPO}/releases/latest`, "--jq", ".tag_name"]);
    const stale = fakeContext({ handlers: yankHandlers("v0.3.0") });
    expect(() => yankRelease("v0.3.0", stale.ctx)).toThrow("releases/latest returns v0.3.0, expected v0.2.0");
  });

  it("throws when no other formal release exists", () => {
    const only = JSON.stringify({ tag: "v0.3.0", draft: false, prerelease: false, assets: [] });
    const { ctx, calls } = fakeContext({ handlers: { "gh api --paginate": () => only } });
    expect(() => yankRelease("v0.3.0", ctx)).toThrow("No other published formal release exists");
    expect(() => yankRelease("v0.4.0-rc.1", fakeContext({ handlers: yankHandlers("v0.3.0") }).ctx)).toThrow("is not a published formal release");
    expect(writes(calls)).toEqual([]);
  });

  it("logs the edits without running them in dry-run mode", () => {
    const { ctx, calls, logs } = fakeContext({ dryRun: true, handlers: yankHandlers("v0.3.0") });
    expect(yankRelease("v0.3.0", ctx)).toBe("v0.2.0");
    expect(writes(calls)).toEqual([]);
    expect(calls.map((c) => c.args[0])).toEqual(["api"]);
    expect(logs).toEqual([
      `[dry-run] gh release edit v0.3.0 --repo ${REPO} --prerelease --latest=false`,
      `[dry-run] gh release edit v0.2.0 --repo ${REPO} --latest`,
      `[dry-run] would confirm that repos/${REPO}/releases/latest returns v0.2.0`,
    ]);
  });
});
