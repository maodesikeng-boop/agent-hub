import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { REPO_ROOT } from "./stage-runtime-common.ts";

interface ActionStep {
  id?: string;
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}

interface CompositeAction {
  runs: {
    using: string;
    steps: ActionStep[];
  };
}

const APT_ACTION_PATH = join(REPO_ROOT, ".github", "actions", "apt-install", "action.yml");

function loadAptAction(): CompositeAction {
  return parse(readFileSync(APT_ACTION_PATH, "utf8")) as CompositeAction;
}

function writeStubScript(dir: string, name: string, body: string): void {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function parseGithubOutputs(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/u)) {
    const idx = line.indexOf("=");
    if (idx > 0) out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}

function renderCacheKey(template: string, vars: Record<string, string>): string {
  return template.replace(/\$\{\{\s*([^}]+?)\s*\}\}/gu, (raw, expr: string) => vars[expr] ?? raw);
}

describe(".github/actions/apt-install/action.yml", () => {
  it("preserves composite structure, actions/cache, archive.ubuntu.com fallback, and timed $INSTALL execution (unchanged rule)", () => {
    const action = loadAptAction();
    expect(action.runs.using).toBe("composite");
    expect(action.runs.steps.some((s) => s.uses?.startsWith("actions/cache@"))).toBe(true);
    const allRun = action.runs.steps.map((s) => s.run ?? "").join("\n");
    expect(allRun).toContain("archive.ubuntu.com");
    const installLines = allRun
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => !l.startsWith("#") && /\$(?:INSTALL\b|\{INSTALL\})/u.test(l));
    expect(installLines.length).toBeGreaterThan(0);
    for (const line of installLines) {
      expect(line).toMatch(/^sudo timeout(?: --kill-after=\d+s)? \d+ (?:env [^;&|]+ )?bash (?:-e )?-c "\$INSTALL"$/u);
    }
  });

  describe.skipIf(process.platform === "win32")("cache key fingerprinting and broken-dpkg recovery", () => {
    function buildStubHarness(opts: {
      dpkgQueryOut?: string;
      cacheUnmet?: boolean;
      cacheMidUnpackFail?: boolean;
      mirrorFailsUntilArchive?: boolean;
      initialSources?: string;
      newArchiveDebs?: string[];
    }) {
      const root = makeTempDir("apt-action-test-");
      const bin = join(root, "bin");
      const debsDir = join(root, "debs");
      const archivesDir = join(root, "archives");
      const etcApt = join(root, "etc-apt");
      const sourcesD = join(etcApt, "sources.list.d");
      const stateDir = join(root, "state");
      mkdirSync(bin, { recursive: true });
      mkdirSync(debsDir, { recursive: true });
      mkdirSync(archivesDir, { recursive: true });
      mkdirSync(sourcesD, { recursive: true });
      mkdirSync(stateDir, { recursive: true });

      const sourcesFile = join(sourcesD, "ubuntu.sources");
      writeFileSync(
        sourcesFile,
        opts.initialSources ?? "Types: deb\nURIs: http://us-west-2.ec2.archive.ubuntu.com/ubuntu/\nSuites: resolute\n",
      );
      const logFile = join(stateDir, "calls.log");
      writeFileSync(logFile, "");

      for (const name of opts.newArchiveDebs ?? []) {
        writeFileSync(join(archivesDir, name), "fake-deb");
      }

      if (process.platform === "darwin") {
        writeStubScript(
          bin,
          "sed",
          `args=()
for arg in "$@"; do
  if [[ "$arg" == "-i" ]]; then
    args+=("-i" "")
  else
    args+=("$arg")
  fi
done
exec /usr/bin/sed "\${args[@]}"`,
        );
      }

      writeStubScript(
        bin,
        "sudo",
        `args=()
for arg in "$@"; do
  if [[ "$arg" == /etc/apt/* ]]; then
    args+=("${etcApt}/\${arg#/etc/apt/}")
  else
    args+=("$arg")
  fi
done
exec "\${args[@]}"`,
      );

      writeStubScript(
        bin,
        "timeout",
        `while [[ $# -gt 0 ]]; do
  case "$1" in
    --kill-after=*) shift ;;
    --kill-after|-k|-s|--signal) shift 2 ;;
    -*) shift ;;
    *) shift; break ;;
  esac
done
exec "$@"`,
      );

      writeStubScript(
        bin,
        "dpkg-query",
        `printf '%s\\n' ${JSON.stringify(opts.dpkgQueryOut ?? "libasound2-data=1.2.15.3-1ubuntu1.1")}`,
      );

      writeStubScript(
        bin,
        "dpkg",
        `echo "dpkg $*" >> ${JSON.stringify(logFile)}
case "$*" in
  *--audit*)
    if [[ -f ${JSON.stringify(join(stateDir, "broken"))} ]]; then
      echo "The following packages have been unpacked but not yet configured:"
      echo " gstreamer1.0-plugins-bad"
    fi
    exit 0
    ;;
  *--configure*)
    if [[ -f ${JSON.stringify(join(stateDir, "unmet"))} ]]; then
      echo "dpkg: dependency problems prevent configuration of gstreamer1.0-plugins-bad" >&2
      exit 1
    fi
    rm -f ${JSON.stringify(join(stateDir, "broken"))}
    exit 0
    ;;
  *-i*)
    if [[ ${JSON.stringify(opts.cacheUnmet ? "1" : "0")} == "1" || ${JSON.stringify(opts.cacheMidUnpackFail ? "1" : "0")} == "1" ]]; then
      touch ${JSON.stringify(join(stateDir, "broken"))}
      touch ${JSON.stringify(join(stateDir, "unmet"))}
      echo "dpkg: dependency problems prevent configuration of gstreamer1.0-plugins-bad" >&2
      exit 1
    fi
    touch ${JSON.stringify(join(stateDir, "installed"))}
    exit 0
    ;;
esac
exit 0`,
      );

      writeStubScript(
        bin,
        "apt-get",
        `echo "apt-get $*" >> ${JSON.stringify(logFile)}
if [[ "$*" == *"--no-download"* ]]; then
  if [[ ${JSON.stringify(opts.cacheMidUnpackFail ? "1" : "0")} == "1" ]]; then
    touch ${JSON.stringify(join(stateDir, "broken"))}
    touch ${JSON.stringify(join(stateDir, "unmet"))}
    exit 124
  fi
  if [[ ${JSON.stringify(opts.cacheUnmet ? "1" : "0")} == "1" ]]; then
    echo "E: Unmet dependencies." >&2
    exit 100
  fi
  touch ${JSON.stringify(join(stateDir, "installed"))}
  exit 0
fi
if [[ ${JSON.stringify(opts.mirrorFailsUntilArchive ? "1" : "0")} == "1" ]] && grep -Eq "ec2\\.archive\\.ubuntu\\.com|azure\\.archive\\.ubuntu\\.com|mirror\\+file:" ${JSON.stringify(sourcesFile)}; then
  echo "Err:1 mirror unreachable" >&2
  exit 100
fi
if [[ "$*" == *"update"* ]]; then
  exit 0
fi
if [[ "$*" == *" -f "* || "$*" == *" -f" || "$*" == *"--fix-broken"* ]]; then
  rm -f ${JSON.stringify(join(stateDir, "broken"))} ${JSON.stringify(join(stateDir, "unmet"))}
  exit 0
fi
if [[ -f ${JSON.stringify(join(stateDir, "broken"))} ]]; then
  echo "E: Unmet dependencies. Try 'apt --fix-broken install' with no packages." >&2
  exit 100
fi
touch ${JSON.stringify(join(stateDir, "installed"))}
exit 0`,
      );

      return { root, bin, debsDir, archivesDir, etcApt, sourcesFile, stateDir, logFile };
    }

    it("bumps the cache key past v2 and separates runners with identical ImageVersion but different base dpkg packages", () => {
      const action = loadAptAction();
      const cacheStep = action.runs.steps.find((s) => s.uses?.startsWith("actions/cache@"));
      expect(cacheStep?.with?.key).toBeDefined();
      expect(cacheStep!.with!.key).toMatch(/^apt-debs-v(?:[3-9]|[1-9]\d+)-/u);

      const metaStep = action.runs.steps[0];
      expect(metaStep?.run).toBeDefined();
      const metaId = metaStep!.id!;

      const runMeta = (dpkgQueryOut: string) => {
        const harness = buildStubHarness({ dpkgQueryOut });
        const outputFile = join(harness.root, "github-output.txt");
        writeFileSync(outputFile, "");
        const res = spawnSync("bash", ["-euo", "pipefail", "-c", metaStep!.run!], {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${harness.bin}:${process.env.PATH ?? ""}`,
            ImageOS: "ubuntu26",
            ImageVersion: "20261122.9.1",
            GITHUB_OUTPUT: outputFile,
          },
        });
        expect(res.status, res.stderr).toBe(0);
        const outputs = parseGithubOutputs(outputFile);
        const vars: Record<string, string> = {
          "runner.os": "Linux",
          "runner.arch": "X64",
          "inputs.cache-id": "playwright-chromium-webkit-abc",
        };
        for (const [k, v] of Object.entries(outputs)) {
          vars[`steps.${metaId}.outputs.${k}`] = v;
        }
        return renderCacheKey(cacheStep!.with!.key!, vars);
      };

      const azureKey1 = runMeta("libasound2-data=1.2.15.3-1ubuntu1.2\nlibjson-glib-1.0-0=1.10.6-1");
      const azureKey2 = runMeta("libasound2-data=1.2.15.3-1ubuntu1.2\nlibjson-glib-1.0-0=1.10.6-1");
      const awsKey = runMeta("libasound2-data=1.2.15.3-1ubuntu1.1");

      expect(azureKey1).toBe(azureKey2);
      expect(azureKey1).not.toBe(awsKey);
      expect(azureKey1).not.toContain("${{");
      expect(awsKey).not.toContain("${{");
    });

    it("recovers cleanly when cached debs have unmet dependencies instead of failing $INSTALL with exit code 100", () => {
      const action = loadAptAction();
      const installStep = action.runs.steps.find((s) => s.run?.includes("$INSTALL"));
      expect(installStep?.run).toBeDefined();

      const harness = buildStubHarness({ cacheUnmet: true });
      writeFileSync(join(harness.debsDir, "gstreamer1.0-plugins-bad.deb"), "cached-deb");

      const installedMarker = join(harness.stateDir, "installed");
      const res = spawnSync("bash", ["-euo", "pipefail", "-c", installStep!.run!], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${harness.bin}:${process.env.PATH ?? ""}`,
          DEBS: harness.debsDir,
          CACHE_HIT: "true",
          PROBE: `test -f ${JSON.stringify(installedMarker)}`,
          INSTALL: "apt-get update && apt-get install -y --no-install-recommends gstreamer1.0-plugins-bad",
          APT_ARCHIVES_DIR: harness.archivesDir,
          APT_SOURCES_ROOT: harness.etcApt,
        },
      });

      expect(res.status, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBe(0);
      expect(res.stderr).not.toContain("unbound variable");
      expect(existsSync(installedMarker)).toBe(true);
    });

    it("repairs dirty dpkg state left by a mid-unpack failure before running $INSTALL", () => {
      const action = loadAptAction();
      const installStep = action.runs.steps.find((s) => s.run?.includes("$INSTALL"));
      expect(installStep?.run).toBeDefined();

      const harness = buildStubHarness({ cacheMidUnpackFail: true });
      writeFileSync(join(harness.debsDir, "gstreamer1.0-plugins-bad.deb"), "cached-deb");

      const installedMarker = join(harness.stateDir, "installed");
      const res = spawnSync("bash", ["-euo", "pipefail", "-c", installStep!.run!], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${harness.bin}:${process.env.PATH ?? ""}`,
          DEBS: harness.debsDir,
          CACHE_HIT: "true",
          PROBE: `test -f ${JSON.stringify(installedMarker)}`,
          INSTALL: "apt-get update && apt-get install -y --no-install-recommends gstreamer1.0-plugins-bad",
          APT_ARCHIVES_DIR: harness.archivesDir,
          APT_SOURCES_ROOT: harness.etcApt,
        },
      });

      expect(res.status, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBe(0);
      expect(res.stderr).not.toContain("unbound variable");
      expect(existsSync(join(harness.stateDir, "broken"))).toBe(false);
      expect(existsSync(installedMarker)).toBe(true);
    });

    it("rewrites direct EC2 mirror URLs to archive.ubuntu.com and clears stale debs before saving fresh archives", () => {
      const action = loadAptAction();
      const installStep = action.runs.steps.find((s) => s.run?.includes("$INSTALL"));
      expect(installStep?.run).toBeDefined();

      const harness = buildStubHarness({
        mirrorFailsUntilArchive: true,
        initialSources: "Types: deb\nURIs: http://us-west-2.ec2.archive.ubuntu.com/ubuntu/\nSuites: resolute\n",
        newArchiveDebs: ["fresh-pkg.deb"],
      });
      writeFileSync(join(harness.debsDir, "stale-pkg.deb"), "old-deb");

      const installedMarker = join(harness.stateDir, "installed");
      const res = spawnSync("bash", ["-euo", "pipefail", "-c", installStep!.run!], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${harness.bin}:${process.env.PATH ?? ""}`,
          DEBS: harness.debsDir,
          CACHE_HIT: "false",
          PROBE: `test -f ${JSON.stringify(installedMarker)}`,
          INSTALL: "apt-get update && apt-get install -y --no-install-recommends fresh-pkg",
          APT_ARCHIVES_DIR: harness.archivesDir,
          APT_SOURCES_ROOT: harness.etcApt,
        },
      });

      expect(res.status, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBe(0);
      expect(res.stderr).not.toContain("unbound variable");
      expect(readFileSync(harness.sourcesFile, "utf8")).toContain("http://archive.ubuntu.com/ubuntu/");
      expect(readFileSync(harness.sourcesFile, "utf8")).not.toContain("ec2.archive.ubuntu.com");
      expect(readdirSync(harness.debsDir).sort()).toEqual(["fresh-pkg.deb"]);
    });
  });
});
