// 已知技能名单（skill-files.ts）：枚举技能目录建名单，只收真实路径落在技能目录里的 SKILL.md；工具参数里的路径按真实路径比；
// 换代读正文只读名单里的文件。PR #331 第二份 FAIL 评论里的四种软链都在这里。技能文件放在临时目录里。
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { skillHeads } from "../shared/skill-loads.ts";
import { createSkillFiles, type SkillSession } from "./skill-files.ts";

let root: string;
let userHome: string;
let cwd: string;
let launchDir: string;
let session: SkillSession;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agent-hub-skill-files-"));
  userHome = join(root, "user");
  cwd = join(root, "project");
  launchDir = join(root, "launch");
  mkdirSync(userHome, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  session = { id: 7 as SkillSession["id"], vendor: "claude", cwd, addDirs: [] };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const text = (name: string, body = `${name} 的正文`) => `---\nname: ${name}\ndescription: 测试\n---\n\n${body}\n`;

/** 在 dir/<名字>/SKILL.md 写一个技能，返回路径。 */
function skill(dir: string, name: string, body?: string): string {
  mkdirSync(join(dir, name), { recursive: true });
  const path = join(dir, name, "SKILL.md");
  writeFileSync(path, text(name, body));
  return path;
}

const files = () => createSkillFiles({ launchDir, userHome, env: {} });
const project = () => join(cwd, ".agents", "skills");

describe("名单从哪些目录来", () => {
  it("启动目录的产品技能、项目、全局、别家的全局目录都收；按名字找时先到先得", () => {
    skill(join(launchDir, "7", "skills"), "fusa-task-graph");
    skill(project(), "dup", "项目的");
    skill(join(userHome, ".agents", "skills"), "dup", "全局的");
    skill(join(userHome, ".claude", "skills"), "claude-only");
    skill(join(userHome, ".pi", "agent", "skills"), "pi-only");
    const catalog = files().catalog(session);
    expect(catalog.named("fusa-task-graph")?.path).toBe(join(launchDir, "7", "skills", "fusa-task-graph", "SKILL.md"));
    expect(catalog.named("dup")?.path).toBe(join(project(), "dup", "SKILL.md"));
    expect(catalog.named("claude-only")).not.toBeNull();
    expect(catalog.named("pi-only")).not.toBeNull();
    expect(catalog.named("nope")).toBeNull();
    expect(catalog.named("dup")?.heads).toEqual(skillHeads(text("dup", "项目的")));
  });

  it("附加目录下的项目技能也收", () => {
    const extra = join(root, "extra");
    skill(join(extra, ".agents", "skills"), "extra-skill");
    expect(files().catalog({ ...session, addDirs: [extra] }).named("extra-skill")).not.toBeNull();
  });

  it(".claude/skills → ../.agents/skills 的整目录软链：同一个技能只收一个，真实路径一样", () => {
    skill(project(), "same");
    mkdirSync(join(cwd, ".claude"));
    symlinkSync("../.agents/skills", join(cwd, ".claude", "skills"));
    const catalog = files().catalog(session);
    expect(catalog.skills.filter((s) => s.name === "same")).toHaveLength(1);
    expect(catalog.atPath(join(cwd, ".claude", "skills", "same", "SKILL.md"))?.name).toBe("same");
    expect(catalog.atPath(join(project(), "same", "SKILL.md"))?.name).toBe("same");
  });

  it("vendor-sync 的逐项软链（~/.gemini/config/skills/<名字> → ~/.agents/skills/<名字>）照常能用", () => {
    skill(join(userHome, ".agents", "skills"), "linked");
    mkdirSync(join(userHome, ".gemini", "config", "skills"), { recursive: true });
    symlinkSync(join(userHome, ".agents", "skills", "linked"), join(userHome, ".gemini", "config", "skills", "linked"));
    const catalog = files().catalog({ ...session, vendor: "agy" });
    expect(catalog.atPath(join(userHome, ".gemini", "config", "skills", "linked", "SKILL.md"))?.name).toBe("linked");
  });

  it("技能目录没变时复用同一份名单；新加、删掉技能（目录变了）马上换新的", () => {
    skill(project(), "old");
    const skillFiles = files();
    const before = skillFiles.catalog(session);
    expect(skillFiles.catalog(session)).toBe(before);
    skill(project(), "added");
    expect(skillFiles.catalog(session).named("added")).not.toBeNull();
    rmSync(join(project(), "old"), { recursive: true });
    expect(skillFiles.catalog(session).named("old")).toBeNull();
  });

  it("fresh：不用缓存，现枚举（换代时用）", () => {
    const path = skill(project(), "edited");
    const skillFiles = files();
    skillFiles.catalog(session);
    writeFileSync(path, text("edited", "# 新标题\n新的第一句"));
    expect(skillFiles.catalog(session, { fresh: true }).named("edited")?.heads).toContain("# 新标题\n新的第一句");
  });
});

describe("指到技能目录外面的不收（FAIL 评论里的四种软链）", () => {
  let outside: string;
  beforeEach(() => {
    outside = join(root, "outside-not-skills");
    mkdirSync(outside);
    writeFileSync(join(outside, "SKILL.md"), text("outside", "OUTSIDE_SKILL_MD_CONTENT"));
    writeFileSync(join(outside, "secret.txt"), "RAW_SECRET_TXT_CONTENT");
    mkdirSync(project(), { recursive: true });
  });

  it("软链文件指到技能目录外的 SKILL.md", () => {
    mkdirSync(join(project(), "sym-file"));
    symlinkSync(join(outside, "SKILL.md"), join(project(), "sym-file", "SKILL.md"));
    const catalog = files().catalog(session);
    expect(catalog.named("sym-file")).toBeNull();
    expect(catalog.atPath(join(project(), "sym-file", "SKILL.md"))).toBeNull();
  });

  it("软链目录指到技能目录外的普通目录", () => {
    symlinkSync(outside, join(project(), "sym-dir"));
    expect(files().catalog(session).named("sym-dir")).toBeNull();
  });

  it("<cwd>/skills 指到普通目录：它不是配置的技能目录，路径参数认不出", () => {
    const plain = join(root, "plain-parent");
    skill(plain, "sub", "PLAIN_PARENT_SUB_CONTENT");
    symlinkSync(plain, join(cwd, "skills"));
    const catalog = files().catalog(session);
    expect(catalog.named("sub")).toBeNull();
    expect(catalog.atPath(join(cwd, "skills", "sub", "SKILL.md"))).toBeNull();
  });

  it("SKILL.md 软链到 secret.txt；技能目录里指到别的文件名的也不收", () => {
    mkdirSync(join(project(), "sym-secret"));
    symlinkSync(join(outside, "secret.txt"), join(project(), "sym-secret", "SKILL.md"));
    skill(project(), "real");
    writeFileSync(join(project(), "real", "README.md"), "readme");
    mkdirSync(join(project(), "alias"));
    symlinkSync(join(project(), "real", "README.md"), join(project(), "alias", "SKILL.md"));
    const catalog = files().catalog(session);
    expect(catalog.skills.map((s) => s.name)).toEqual(["real"]);
  });

  it("技能目录外面的 SKILL.md、用 .. 绕出去的路径：atPath 不认", () => {
    writeFileSync(join(cwd, "SKILL.md"), "不是技能");
    mkdirSync(join(cwd, "skills"));
    const catalog = files().catalog(session);
    expect(catalog.atPath("skills/../SKILL.md")).toBeNull();
    expect(catalog.atPath(join(outside, "SKILL.md"))).toBeNull();
    expect(catalog.atPath("")).toBeNull();
  });
});

describe("atPath：工具参数里的路径", () => {
  it("相对路径按会话工作目录解析，规整后和名单里的真实路径比", () => {
    skill(project(), "rel");
    const catalog = files().catalog(session);
    expect(catalog.atPath(".agents/skills/rel/SKILL.md")?.name).toBe("rel");
    expect(catalog.atPath(join(cwd, "x", "..", ".agents", "skills", "rel", "SKILL.md"))?.name).toBe("rel");
    expect(catalog.atPath(join(cwd, ".agents", "skills", "rel", "README.md"))).toBeNull();
  });
});

describe("read：换代时读正文", () => {
  it("读名单里的文件，读的是现在磁盘上的", () => {
    const path = skill(project(), "body");
    const skillFiles = files();
    const found = skillFiles.catalog(session).named("body")!;
    writeFileSync(path, text("body", "改过的"));
    expect(skillFiles.read(found)).toContain("改过的");
  });

  it("建完名单后被换成指到外面的软链、或删了：不读", () => {
    const path = skill(project(), "swap");
    const outside = join(root, "secret.txt");
    writeFileSync(outside, "RAW_SECRET");
    const skillFiles = files();
    const found = skillFiles.catalog(session).named("swap")!;
    rmSync(path);
    expect(skillFiles.read(found)).toBeNull();
    symlinkSync(outside, path);
    expect(skillFiles.read(found)).toBeNull();
  });
});
