// --plugin-dir loads a plugin for this session only; its skills show as <plugin>:<skill>.
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  normalizePathForComparison,
  unlinkDirectoryLinkSync,
  writeFileAtomicSyncWithRetry,
} from "../../daemon/platform/index.ts";
import { PRODUCT_PLUGIN_NAME } from "../../shared/names.ts";

const CLAUDE_PLUGIN_DIR = "claude-plugin";

export function claudePluginDirOf(skillsDir: string): string {
  return join(dirname(skillsDir), CLAUDE_PLUGIN_DIR);
}

const PLUGIN_MANIFEST = `${JSON.stringify({ name: PRODUCT_PLUGIN_NAME, description: "Bellwood 给项目经理会话挂的产品技能（任务图手册）" }, null, 2)}\n`;

export function ensureClaudeSkillPlugin(skillsDir: string, platform: NodeJS.Platform = process.platform): string {
  const pluginDir = claudePluginDirOf(skillsDir);
  const manifestDir = join(pluginDir, ".claude-plugin");
  const manifest = join(manifestDir, "plugin.json");
  mkdirSync(manifestDir, { recursive: true, mode: 0o700 });
  if (!existsSync(manifest) || readFileSync(manifest, "utf8") !== PLUGIN_MANIFEST) {
    writeFileAtomicSyncWithRetry(manifest, PLUGIN_MANIFEST, { mode: 0o600, platform });
  }
  const link = join(pluginDir, "skills");
  if (platform === "win32") {
    const absSkillsDir = resolve(skillsDir);
    let ok = false;
    try {
      if (lstatSync(link).isSymbolicLink()) {
        const actual = existsSync(link) ? realpathSync.native(link) : resolve(dirname(link), readlinkSync(link));
        const expected = existsSync(absSkillsDir) ? realpathSync.native(absSkillsDir) : absSkillsDir;
        ok = normalizePathForComparison(actual) === normalizePathForComparison(expected);
      }
    } catch {
      ok = false;
    }
    if (!ok) {
      try {
        if (lstatSync(link).isSymbolicLink()) unlinkDirectoryLinkSync(link);
        else rmSync(link, { recursive: true, force: true });
      } catch {
      }
      symlinkSync(absSkillsDir, link, "junction");
    }
    return pluginDir;
  }
  const target = join("..", basename(skillsDir));
  let ok = false;
  try {
    ok = lstatSync(link).isSymbolicLink() && readlinkSync(link) === target;
  } catch {
    ok = false;
  }
  if (!ok) {
    rmSync(link, { recursive: true, force: true });
    symlinkSync(target, link);
  }
  return pluginDir;
}
