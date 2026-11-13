// claude 的产品技能入口（spec 的 capabilities.skills 是 "native"，docs/orchestration-skill-design.md 第 6.2 节）：
// `--plugin-dir <目录>` 只对这一次会话加载一个插件（claude --help 原话 "for this session only"），插件里的技能显示成 `<插件名>:<技能名>`，
// 和用户自己的同名技能互不覆盖。插件放在启动目录的 claude-plugin/ 下：.claude-plugin/plugin.json 加一个指向 ../skills 的软链，
// 技能文件只有守护进程写的那一份（launch/<会话>/skills/，LaunchFiles.skillsDir）。claude 跟软链（2026-11-12 claude 2.1.322 实测：
// initialize 回的命令里多出 fusa:fusa-task-graph）。不写 ~/.claude 和仓库。
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  normalizePathForComparison,
  unlinkDirectoryLinkSync,
  writeFileAtomicSyncWithRetry,
} from "../../daemon/platform/index.ts";
import { PRODUCT_PLUGIN_NAME } from "../../shared/names.ts";

/** 启动目录里 claude 插件的目录名。 */
const CLAUDE_PLUGIN_DIR = "claude-plugin";

/** skillsDir（launch/<会话>/skills）对应的插件目录：同一个启动目录下的 claude-plugin/。 */
export function claudePluginDirOf(skillsDir: string): string {
  return join(dirname(skillsDir), CLAUDE_PLUGIN_DIR);
}

/** 插件清单：只要名字（技能前缀）。 */
const PLUGIN_MANIFEST = `${JSON.stringify({ name: PRODUCT_PLUGIN_NAME, description: "Fusa 给项目经理会话挂的产品技能（任务图手册）" }, null, 2)}\n`;

/**
 * 起进程前调：写好插件清单和指向技能目录的软链（都没变就不动），返回 --plugin-dir 的目录。
 * 软链用相对路径（../skills），启动目录整个挪走也不断。
 */
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
        // link does not exist yet
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
