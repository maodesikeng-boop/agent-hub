// agent 发给用户的文件：认链接、允许的文件夹、存副本（daemon/sent-files.ts）。
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_SENT_FILE_BYTES, MAX_SENT_FILES_PER_MESSAGE, MAX_SENT_FILES_TOTAL_BYTES, type SentFile } from "../shared/index.ts";
import { isShareable, prepareSentFilesDir, sentFileId, shareLinkedFiles, type ShareScope } from "./sent-files.ts";

let base: string;
/** 假的用户目录：.ssh/id_rsa、.agent-hub/（数据目录）。 */
let home: string;
let dataHome: string;
let sentDir: string;
let uploads: string;
let worktrees: string;
/** 项目主文件夹。 */
let proj: string;
let scope: ShareScope;

const KEY = "session:1:uuid-1";

function write(path: string, content: string | Buffer = "x"): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
}

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-hub-sent-")));
  home = join(base, "home");
  dataHome = join(home, ".agent-hub");
  sentDir = join(dataHome, "sent-files");
  uploads = join(dataHome, "uploads");
  worktrees = join(dataHome, "worktrees", "1");
  proj = join(base, "proj");
  write(join(home, ".ssh", "id_rsa"), "SECRET KEY");
  write(join(dataHome, "state", "ui-token"), "TOKEN");
  mkdirSync(uploads, { recursive: true });
  mkdirSync(worktrees, { recursive: true });
  mkdirSync(proj, { recursive: true });
  // 临时目录不在允许的列表里：测试的文件都在 os.tmpdir() 下，否则什么都能分享
  scope = { sentFilesDir: sentDir, cwd: proj, userHome: home, roots: [proj, worktrees, uploads], dataHome, dataExceptions: [uploads, worktrees] };
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const share = (text: string, key = KEY, s: ShareScope = scope) => shareLinkedFiles(text, key, s);
const copies = () => (existsSync(sentDir) ? readdirSync(sentDir) : []);
const copyOf = (file: SentFile) => readFileSync(join(sentDir, file.id!, file.name), "utf8");

describe("正常发文件", () => {
  it("png：存副本，meta 记原 href、原路径、编号、名字、大小、类型、状态、mtime", () => {
    const png = write(join(proj, "out", "图.png"), "PNG-DATA");
    utimesSync(png, 1_700_000_000, 1_700_000_000);
    const [file, ...rest] = share(`做好了：\n\n![截图](${png.replace("图", "%E5%9B%BE")})`);
    expect(rest).toEqual([]);
    expect(file).toEqual({
      href: png.replace("图", "%E5%9B%BE"),
      path: png,
      id: sentFileId(KEY, 0),
      name: "图.png",
      size: 8,
      mime: "image/png",
      status: "saved",
      mtime: 1_700_000_000_000,
    });
    expect(copyOf(file!)).toBe("PNG-DATA");
    expect(statSync(join(sentDir, file!.id!, "图.png")).mtimeMs).toBe(1_700_000_000_000);
  });

  it("pdf、md、csv：图片语法、链接语法都存，类型按扩展名", () => {
    const files = share(
      `[报告](${write(join(proj, "报告.pdf"))}) [说明](${write(join(proj, "说明.md"))}) ![表](${write(join(proj, "数据.csv"))})`,
    );
    expect(files.map((f) => [f.name, f.mime, f.status])).toEqual([
      ["报告.pdf", "application/pdf", "saved"],
      ["说明.md", "text/markdown", "saved"],
      ["数据.csv", "text/csv", "saved"],
    ]);
    expect(new Set(files.map((f) => f.id)).size).toBe(3);
  });

  it("file://、~/、相对路径（按会话的工作目录）、尖括号里带空格的路径都认", () => {
    write(join(proj, "a b.md"));
    write(join(proj, "docs", "rel.md"));
    write(join(uploads, "u1", "up.png"));
    const files = share(
      [
        `[1](file://${join(proj, "a%20b.md")})`,
        `[2](<${join(proj, "a b.md")}>)`,
        `[3](docs/rel.md)`,
        `[4](./docs/rel.md)`,
        `[5](~/.agent-hub/uploads/u1/up.png)`,
        `[6](file://localhost${join(proj, "docs", "rel.md")})`,
      ].join(" "),
    );
    expect(files.map((f) => [f.path, f.status])).toEqual([
      [join(proj, "a b.md"), "saved"],
      [join(proj, "a b.md"), "saved"],
      [join(proj, "docs", "rel.md"), "saved"],
      [join(proj, "docs", "rel.md"), "saved"],
      [join(uploads, "u1", "up.png"), "saved"],
      [join(proj, "docs", "rel.md"), "saved"],
    ]);
  });

  it("本项目的 worktree 里的文件（数据目录里的例外）能发", () => {
    const file = write(join(worktrees, "3", "shot.png"));
    expect(share(`![x](${file})`)[0]!.status).toBe("saved");
  });

  it("网址、锚点、mailto、//主机 不算本机文件；同一个地址写两次只存一份", () => {
    const md = write(join(proj, "a.md"));
    const files = share(`[网](https://example.com/a.png) ![远](http://x/y.png) [锚](#top) [信](mailto:a@b.c) [协](//host/x) [a](${md}) [again](${md})`);
    expect(files.map((f) => f.href)).toEqual([md]);
    expect(copies()).toHaveLength(1);
  });

  it("没有本机链接：返回空，不建任何目录", () => {
    expect(share("普通回复，**没有**链接 https://example.com")).toEqual([]);
    expect(existsSync(sentDir)).toBe(false);
  });
});

describe("安全：不在可分享的文件夹里的一律拒绝、不拷", () => {
  const rejected = (text: string, s: ShareScope = scope) => {
    const files = share(text, KEY, s);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ status: "not_allowed", id: null, size: null });
    expect(copies()).toEqual([]);
  };

  it("~/.ssh/id_rsa", () => rejected("[key](~/.ssh/id_rsa)"));
  it("/etc/hosts", () => rejected("[hosts](/etc/hosts)"));

  it("项目里指向 ~/.ssh 的符号链接（文件、目录两种）", () => {
    symlinkSync(join(home, ".ssh", "id_rsa"), join(proj, "key.txt"));
    rejected(`[k](${join(proj, "key.txt")})`);
    symlinkSync(join(home, ".ssh"), join(proj, "ssh"));
    rejected(`[k](${join(proj, "ssh", "id_rsa")})`);
  });

  it("/项目/../../etc/passwd", () => rejected(`[p](${proj}${"/..".repeat(20)}/etc/passwd)`));

  it("项目文件夹是 ~ 时，~/.agent-hub/state/ui-token（数据目录里除了 uploads、worktrees 都不行）", () => {
    const homeScope = { ...scope, cwd: home, roots: [home, worktrees, uploads] };
    rejected("[t](~/.agent-hub/state/ui-token)", homeScope);
    rejected(`[t](${join(dataHome, "state", "ui-token")})`, homeScope);
    // 同一个 scope 下普通文件照样能发
    write(join(home, "notes.md"));
    expect(share("[n](~/notes.md)", KEY, homeScope)[0]!.status).toBe("saved");
  });

  it("已经存的副本（sent-files/）也不能再当原文件发", () => {
    const homeScope = { ...scope, roots: [home] };
    write(join(sentDir, "0123456789abcdef", "a.png"));
    expect(share(`![x](${join(sentDir, "0123456789abcdef", "a.png")})`, KEY, homeScope)[0]!.status).toBe("not_allowed");
    expect(copies()).toEqual(["0123456789abcdef"]);
  });

  it(".git/config，以及经符号链接进 .git 的", () => {
    write(join(proj, ".git", "config"), "[remote]");
    rejected(`[c](${join(proj, ".git", "config")})`);
    symlinkSync(join(proj, ".git"), join(proj, "g"));
    rejected(`[c](${join(proj, "g", "config")})`);
  });

  it("isShareable：按“前缀 + 路径分隔符”比，/a/proj-evil 不算在 /a/proj 里", () => {
    mkdirSync(`${proj}-evil`);
    write(join(`${proj}-evil`, "x.md"));
    expect(isShareable(realpathSync.native(join(`${proj}-evil`, "x.md")), scope)).toBe(false);
    expect(isShareable(proj, scope)).toBe(true);
  });
});

describe("边界", () => {
  it("文件不存在：没找到，不拷", () => {
    expect(share(`[x](${join(proj, "nope.pdf")})`)[0]).toMatchObject({ status: "missing", name: "nope.pdf", id: null });
    expect(copies()).toEqual([]);
  });

  it("文件夹、命名管道：不是文件，不拷（管道不会卡住）", () => {
    mkdirSync(join(proj, "dir"));
    execFileSync("mkfifo", [join(proj, "pipe")]);
    expect(share(`[d](${join(proj, "dir")}) [p](${join(proj, "pipe")})`).map((f) => f.status)).toEqual(["not_file", "not_file"]);
    expect(copies()).toEqual([]);
  });

  it("发出后原文件被删、被改：副本还是发出时的内容", () => {
    const md = write(join(proj, "a.md"), "第一版");
    const [file] = share(`[a](${md})`);
    writeFileSync(md, "第二版");
    expect(copyOf(file!)).toBe("第一版");
    rmSync(md);
    expect(copyOf(file!)).toBe("第一版");
  });

  it("60 MB：太大，不拷；正好 50 MB 的照存", () => {
    const big = write(join(proj, "big.bin"));
    truncateSync(big, 60 * 1024 * 1024);
    expect(share(`[b](${big})`)[0]).toMatchObject({ status: "too_large", size: 60 * 1024 * 1024, id: null });
    expect(copies()).toEqual([]);
    const edge = write(join(proj, "edge.bin"));
    truncateSync(edge, MAX_SENT_FILE_BYTES);
    expect(share(`[e](${edge})`, "k2")[0]).toMatchObject({ status: "saved", size: MAX_SENT_FILE_BYTES });
  });

  it("一条消息合计超过 200 MB：超出的那个不拷，后面小的照拷", () => {
    const each = 45 * 1024 * 1024; // 4 个 180 MB，第 5 个超
    const names = [1, 2, 3, 4, 5].map((i) => {
      const f = write(join(proj, `f${i}.bin`));
      truncateSync(f, each);
      return f;
    });
    const small = write(join(proj, "small.md"));
    const files = share([...names, small].map((f, i) => `[${i}](${f})`).join(" "));
    expect(MAX_SENT_FILES_TOTAL_BYTES).toBeLessThan(5 * each);
    expect(files.map((f) => f.status)).toEqual(["saved", "saved", "saved", "saved", "too_large", "saved"]);
  });

  it("11 个文件只处理前 10 个", () => {
    const links = Array.from({ length: 11 }, (_, i) => `[${i}](${write(join(proj, `f${i}.md`))})`);
    const files = share(links.join("\n"));
    expect(files).toHaveLength(MAX_SENT_FILES_PER_MESSAGE);
    expect(files.at(-1)!.name).toBe("f9.md");
    expect(copies()).toHaveLength(10);
  });

  it("中文名、括号、#、%、emoji、超长名都能发", () => {
    const names = ["中文 名字.md", "a(1).png", "第#1.md", "100%.txt", "😀.png", `${"长".repeat(100)}.md`];
    for (const n of names) write(join(proj, n));
    const hrefs = [
      `<${join(proj, "中文 名字.md")}>`,
      join(proj, "a(1).png"),
      join(proj, "第#1.md"),
      join(proj, "100%25.txt"),
      join(proj, "😀.png"),
      join(proj, `${"长".repeat(100)}.md`),
    ];
    const files = share(hrefs.map((h, i) => `[${i}](${h})`).join(" "));
    expect(files.map((f) => f.status)).toEqual(Array(6).fill("saved"));
    expect(files.slice(0, 5).map((f) => f.name)).toEqual(names.slice(0, 5));
    // 超长名截到 120 字节以内，扩展名留着
    expect(files[5]!.name.endsWith(".md")).toBe(true);
    expect(Buffer.byteLength(files[5]!.name)).toBeLessThanOrEqual(120);
    expect(copyOf(files[5]!)).toBe("x");
    // 原样的 % 解不开码就按原样当路径
    expect(share(`[p](${join(proj, "100%.txt")})`, "k3")[0]!.status).toBe("saved");
  });

  it("有空格但没尖括号：不是链接，当普通文字", () => {
    write(join(proj, "a b.md"));
    expect(share(`[x](${join(proj, "a b.md")})`)).toEqual([]);
  });

  it("代码块、行内代码里的链接不处理", () => {
    const md = write(join(proj, "a.md"));
    expect(share(`\`\`\`\n[x](${md})\n![y](${md})\n\`\`\`\n\n行内 \`[x](${md})\`\n\n    [缩进](${md})`)).toEqual([]);
  });

  it("重启后重放同一条消息：编号不变、不重复拷（原文件改了也还是第一次的副本）", () => {
    const md = write(join(proj, "a.md"), "v1");
    const first = share(`[a](${md}) [b](${write(join(proj, "b.md"))})`);
    writeFileSync(md, "v2");
    const again = share(`[a](${md}) [b](${join(proj, "b.md")})`);
    expect(again.map((f) => f.id)).toEqual(first.map((f) => f.id));
    expect(copies().sort()).toEqual(first.map((f) => f.id).sort());
    expect(copyOf(again[0]!)).toBe("v1");
  });

  it("两个会话同时发同一个文件：各自一份", () => {
    const md = write(join(proj, "a.md"));
    const [a] = share(`[a](${md})`, "session:1:u");
    const [b] = share(`[a](${md})`, "session:2:u");
    expect(a!.id).not.toBe(b!.id);
    expect(copies()).toHaveLength(2);
  });

  it("启动时清掉没拷完的残留目录，副本留着", () => {
    const [file] = share(`[a](${write(join(proj, "a.md"))})`);
    mkdirSync(join(sentDir, ".partial-0123456789abcdef-aa"));
    prepareSentFilesDir(sentDir);
    expect(copies()).toEqual([file!.id]);
  });
});
