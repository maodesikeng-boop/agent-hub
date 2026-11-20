// Absolute Node and hub paths are baked in so agents work without node on PATH.
import { chmodSync, copyFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HUB_COMMAND } from "../../shared/names.ts";
import {
  renameSyncWithWindowsRetry,
  requireWinHelperBinary,
  writeFileAtomicSyncWithRetry,
} from "../platform/index.ts";

const BIN_DIR_MODE = 0o700;
const SHIM_MODE = 0o700;

const DEFAULT_HUB_MAIN = fileURLToPath(new URL("../../hub/main.ts", import.meta.url));

export interface HubShimOptions {
  binDir: string;
  nodePath?: string;
  mainScript?: string;
  platform?: NodeJS.Platform;
  winHelperHubPath?: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function hubShimContent(nodePath: string, mainScript: string): string {
  return `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(mainScript)} "$@"\n`;
}

export function installHubShim(opts: HubShimOptions): string {
  const platform = opts.platform ?? process.platform;
  const nodePath = opts.nodePath ?? process.execPath;
  const mainScript = opts.mainScript ?? DEFAULT_HUB_MAIN;
  mkdirSync(opts.binDir, { recursive: true, mode: BIN_DIR_MODE });
  chmodSync(opts.binDir, BIN_DIR_MODE);

  if (platform === "win32") {
    const sourceExe = opts.winHelperHubPath ?? requireWinHelperBinary("hub.exe");
    const targetExe = join(opts.binDir, `${HUB_COMMAND}.exe`);
    const tmpExe = `${targetExe}.${process.pid}.tmp`;
    rmSync(join(opts.binDir, HUB_COMMAND), { force: true });
    copyFileSync(sourceExe, tmpExe);
    renameSyncWithWindowsRetry(tmpExe, targetExe, { platform: "win32" });
    const configPath = join(opts.binDir, `${HUB_COMMAND}.json`);
    const configJson = `${JSON.stringify(
      {
        node: nodePath,
        main: mainScript,
        direct_pipe: mainScript === DEFAULT_HUB_MAIN,
      },
      null,
      2,
    )}\n`;
    writeFileAtomicSyncWithRetry(configPath, configJson, { mode: 0o600, platform: "win32" });
    return targetExe;
  }

  const target = join(opts.binDir, HUB_COMMAND);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, hubShimContent(nodePath, mainScript), { mode: SHIM_MODE });
  chmodSync(tmp, SHIM_MODE);
  renameSync(tmp, target);
  return target;
}
