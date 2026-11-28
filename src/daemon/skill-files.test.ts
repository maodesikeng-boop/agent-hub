// 已知技能名单（skill-files.ts）：枚举技能目录建名单，只收真实路径恰好是 <可信根>/<合法技能名>/SKILL.md 的文件；工具参数里的路径按真实路径比；
// 换代读正文只读名单里的文件。PR #331 三份 FAIL 评论里的软链都在“软链边界”那张表里。技能文件放在临时目录里。
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
    expect(catalog.atPath(join(userHome, ".agents", "skills", "dup", "SKILL.md"))?.path).toBe(join(userHome, ".agents", "skills", "dup", "SKILL.md"));
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

  it("跨名软链（<cwd>/.agents/skills/alias → ~/.agents/skills/real-global）：别名不遮蔽原名，两个名字都找得到同一个文件", () => {
    const real = skill(join(userHome, ".agents", "skills"), "real-global");
    mkdirSync(project(), { recursive: true });
    symlinkSync(dirname(real), join(project(), "alias"));
    const catalog = files().catalog(session);
    expect(catalog.named("real-global")?.path).toBe(real);
    expect(catalog.named("alias")?.path).toBe(join(project(), "alias", "SKILL.md"));
    expect(catalog.named("alias")?.key).toBe(catalog.named("real-global")?.key);
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

describe("软链边界：软链位置 × 指向", () => {
  // 可信根 = 锚点（启动目录、用户主目录、项目目录）的真实路径 + 按字面拼的技能子路径。子路径的每一段、单个技能目录、SKILL.md 本身
  // 是软链时：指到技能目录以外、仓库里的非技能目录都不收；指到另一个可信根里面收。
  const MARK = "BOUNDARY_PROBE_CONTENT";
  type Target = "外面" | "仓库里的 docs" | "另一个可信根";
  interface Row {
    position: string;
    /** 放软链的位置。 */
    link: () => string;
    /** 从软链往下到 SKILL.md 还剩的路径；空串是软链本身就是 SKILL.md。 */
    rest: string;
    /** “另一个可信根”那一格软链指到哪里（那里按 rest 放好技能）。 */
    trusted: () => string;
    vendor?: SkillSession["vendor"];
  }
  const userSkills = () => join(userHome, ".agents", "skills");
  const rows: Row[] = [
    { position: ".claude", link: () => join(cwd, ".claude"), rest: "skills/probe/SKILL.md", trusted: () => join(userHome, ".agents") },
    { position: ".claude/skills", link: () => join(cwd, ".claude", "skills"), rest: "probe/SKILL.md", trusted: userSkills },
    { position: ".agents", link: () => join(cwd, ".agents"), rest: "skills/probe/SKILL.md", trusted: () => join(userHome, ".agents") },
    { position: ".agents/skills", link: () => join(cwd, ".agents", "skills"), rest: "probe/SKILL.md", trusted: userSkills },
    { position: "~/.agents", link: () => join(userHome, ".agents"), rest: "skills/probe/SKILL.md", trusted: () => join(cwd, ".agents") },
    { position: "~/.agents/skills", link: userSkills, rest: "probe/SKILL.md", trusted: () => join(cwd, ".agents", "skills") },
    { position: "~/.claude/skills", link: () => join(userHome, ".claude", "skills"), rest: "probe/SKILL.md", trusted: userSkills },
    { position: "~/.gemini/config/skills", link: () => join(userHome, ".gemini", "config", "skills"), rest: "probe/SKILL.md", trusted: userSkills, vendor: "agy" },
    { position: "启动目录的 skills", link: () => join(launchDir, "7", "skills"), rest: "probe/SKILL.md", trusted: userSkills },
    { position: "单个技能目录", link: () => join(project(), "probe"), rest: "SKILL.md", trusted: () => join(userSkills(), "probe") },
    { position: "SKILL.md 本身", link: () => join(project(), "probe", "SKILL.md"), rest: "", trusted: () => join(userSkills(), "probe", "SKILL.md") },
  ];

  /** 在 base 下按 rest 放一个带 MARK 的 SKILL.md（rest 是空串时 base 本身就是这个文件），返回 base。 */
  function plant(base: string, rest: string): string {
    const file = rest === "" ? base : join(base, rest);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text("probe", MARK));
    return base;
  }

  function linkTo(row: Row, target: Target): string {
    const id = row.position.replace(/[^a-z]/giu, "_");
    /** 软链本身是 SKILL.md 时，指到的文件也叫 SKILL.md。 */
    const named = (dir: string) => (row.rest === "" ? join(dir, "SKILL.md") : dir);
    const to =
      target === "外面" ? plant(named(join(root, "outside", id)), row.rest)
      : target === "仓库里的 docs" ? plant(named(join(cwd, "docs", id)), row.rest)
      : plant(row.trusted(), row.rest);
    const at = row.link();
    mkdirSync(dirname(at), { recursive: true });
    symlinkSync(to, at);
    return row.rest === "" ? at : join(at, row.rest);
  }

  const cells = rows.flatMap((row) => (["外面", "仓库里的 docs", "另一个可信根"] as const).map((target) => [row.position, target, row] as const));

  it.each(cells)("%s → %s", (_position, target, row) => {
    const through = linkTo(row, target);
    const s = { ...session, vendor: row.vendor ?? session.vendor };
    const skillFiles = files();
    const catalog = skillFiles.catalog(s);
    if (target === "另一个可信根") {
      expect(catalog.atPath(through)?.name).toBe("probe");
      expect(catalog.atPath(through)?.description).toBe("测试");
    } else {
      expect(catalog.skills.filter((k) => k.name === "probe")).toEqual([]);
      expect(catalog.atPath(through)).toBeNull();
    }
  });

  it("锚点本身是软链（像 macOS 的 /var → /private/var）：锚点先求真实路径，只收 <真实锚点>/<子路径>/<名字>/SKILL.md", () => {
    const real = join(root, "real-project");
    skill(join(real, ".agents", "skills"), "anchored");
    writeFileSync(join(real, "SKILL.md"), text("stray", MARK));
    skill(join(real, "docs"), "nested", MARK);
    const linked = join(root, "linked-project");
    symlinkSync(real, linked);
    const skillFiles = files();
    const catalog = skillFiles.catalog({ ...session, cwd: linked });
    expect(catalog.atPath(join(linked, ".agents", "skills", "anchored", "SKILL.md"))?.name).toBe("anchored");
    expect(catalog.skills.map((k) => k.name)).toEqual(["anchored"]);
    expect(catalog.atPath(join(linked, "SKILL.md"))).toBeNull();
    expect(catalog.atPath(join(linked, "docs", "nested", "SKILL.md"))).toBeNull();
  });

  it("环境变量把厂商配置目录指到主目录外面：那个目录自己是锚点，里面的技能照常收", () => {
    const piDir = join(root, "pi-agent");
    skill(join(piDir, "skills"), "pi-env");
    const catalog = createSkillFiles({ launchDir, userHome, env: { PI_CODING_AGENT_DIR: piDir } }).catalog({ ...session, vendor: "pi" });
    expect(catalog.named("pi-env")?.path).toBe(join(piDir, "skills", "pi-env", "SKILL.md"));
  });

  it("建完名单后整个技能目录掉包成指到外面的软链：换代现枚举不收", () => {
    skill(project(), "swapped");
    const skillFiles = files();
    expect(skillFiles.catalog(session).named("swapped")?.name).toBe("swapped");
    rmSync(project(), { recursive: true });
    symlinkSync(plant(join(root, "outside", "swapped-root"), "swapped/SKILL.md"), project());
    expect(skillFiles.catalog(session, { fresh: true }).named("swapped")).toBeNull();
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

describe("atPath：硬链也认（agy 的任务图手册硬链进 agy-rules/.agents/skills，agy 不跟软链）", () => {
  it("硬链到名单里的文件：认；名单里保留启动目录路径", () => {
    const product = skill(join(launchDir, "7", "skills"), "fusa-task-graph");
    const rules = join(launchDir, "7", "agy-rules", ".agents", "skills", "fusa-task-graph");
    mkdirSync(rules, { recursive: true });
    linkSync(product, join(rules, "SKILL.md"));
    const catalog = files().catalog({ ...session, vendor: "agy" });
    expect(catalog.atPath(join(rules, "SKILL.md"))?.path).toBe(product);
  });
});

describe("description：现枚举提取 frontmatter 单行简介", () => {
  it("改写磁盘上的 description 后 fresh 枚举立刻反映最新简介", () => {
    const path = skill(project(), "meta");
    const skillFiles = files();
    expect(skillFiles.catalog(session).named("meta")?.description).toBe("测试");
    writeFileSync(path, "---\nname: meta\ndescription: 更新后的简介\n---\n\n正文\n");
    expect(skillFiles.catalog(session, { fresh: true }).named("meta")?.description).toBe("更新后的简介");
  });
});
