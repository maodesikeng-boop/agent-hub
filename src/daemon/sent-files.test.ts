// agent 发给用户的文件：认链接、允许的文件夹、存副本（daemon/sent-files.ts）。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
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
import {
  MAX_SENT_FILE_BYTES,
  MAX_SENT_FILES_PER_MESSAGE,
  MAX_SENT_FILES_TOTAL_BYTES,
  READONLY_SECRET_HOME_PATHS,
  type SentFile,
} from "../shared/index.ts";
import { SENSITIVE_HOME_PATHS, copyFromFd, isShareable, prepareSentFilesDir, sentFileId, sensitivePathsOf, shareLinkedFiles, type ShareScope } from "./sent-files.ts";

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

const share = (text: string, s: ShareScope = scope) => shareLinkedFiles(text, s);
const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");
const copies = () => (existsSync(sentDir) ? readdirSync(sentDir) : []);
const copyOf = (file: SentFile) => readFileSync(join(sentDir, file.id!, file.name), "utf8");

describe("正常发文件", () => {
  it("png：存副本，meta 记原 href、原路径、编号、名字、大小、类型、状态、mtime", () => {
    const png = write(join(proj, "out", "图.png"), "PNG-DATA");
    utimesSync(png, 1_700_000_000, 1_700_000_000);
    const [file, ...rest] = share(`做好了：\n\n![截图](${png.replace("图", "%E5%9B%BE")})`);
    expect(rest).toEqual([]);
    expect(file).toMatchObject({
      path: png,
      id: sentFileId("图.png", sha256("PNG-DATA")),
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

const SYSTEM_OUTSIDE_FILE =
  process.platform === "win32"
    ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "drivers", "etc", "hosts")
    : "/etc/hosts";

describe("安全：不在可分享的文件夹里的一律拒绝、不拷", () => {
  const rejected = (text: string, s: ShareScope = scope) => {
    const files = share(text, s);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ status: "not_allowed", id: null, size: null });
    expect(copies()).toEqual([]);
  };

  it("~/.ssh/id_rsa", () => rejected("[key](~/.ssh/id_rsa)"));
  it("系统目录外文件（/etc/hosts 或 drivers/etc/hosts）", () => rejected(`[hosts](${SYSTEM_OUTSIDE_FILE})`));

  it("项目里指向 ~/.ssh 的符号链接（文件、目录两种）", () => {
    symlinkSync(join(home, ".ssh", "id_rsa"), join(proj, "key.txt"));
    rejected(`[k](${join(proj, "key.txt")})`);
    symlinkSync(join(home, ".ssh"), join(proj, "ssh"));
    rejected(`[k](${join(proj, "ssh", "id_rsa")})`);
  });

  it("/项目/../../穿越到外部系统文件", () =>
    rejected(
      process.platform === "win32"
        ? `[p](${proj}${"\\..".repeat(20)}\\Windows\\System32\\drivers\\etc\\hosts)`
        : `[p](${proj}${"/..".repeat(20)}/etc/passwd)`,
    ));

  it("项目文件夹是 ~ 时，~/.agent-hub/state/ui-token（数据目录里除了 uploads、worktrees 都不行）", () => {
    const homeScope = { ...scope, cwd: home, roots: [home, worktrees, uploads] };
    rejected("[t](~/.agent-hub/state/ui-token)", homeScope);
    rejected(`[t](${join(dataHome, "state", "ui-token")})`, homeScope);
    // 同一个 scope 下普通文件照样能发
    write(join(home, "notes.md"));
    expect(share("[n](~/notes.md)", homeScope)[0]!.status).toBe("saved");
  });

  it("已经存的副本（sent-files/）也不能再当原文件发", () => {
    const homeScope = { ...scope, roots: [home] };
    write(join(sentDir, "0123456789abcdef", "a.png"));
    expect(share(`![x](${join(sentDir, "0123456789abcdef", "a.png")})`, homeScope)[0]!.status).toBe("not_allowed");
    expect(copies()).toEqual(["0123456789abcdef"]);
  });

  it("项目文件夹是 ~ 或 / 时，家目录里的凭据、钥匙串、claude 配置和 /etc 照样拒（敏感路径清单始终生效）", () => {
    const homeScope = { ...scope, cwd: home, roots: [home, "/"] };
    const secrets = [
      ".ssh/id_rsa",
      ".aws/credentials",
      ".gnupg/private-keys-v1.d/x.key",
      ".netrc",
      ".git-credentials",
      ".config/gh/hosts.yml",
      ".config/gcloud/credentials.db",
      ".kube/config",
      ".docker/config.json",
      ".npmrc",
      ".pypirc",
      ".password-store/a.gpg",
      ".claude/settings.json",
      ".claude.json",
      ".codex/auth.json",
      ".gemini/oauth_creds.json",
      ".gemini/antigravity-cli/state_5.sqlite",
      ".gemini/mcp-oauth-tokens.json",
      ".codex/.credentials.json",
      ".azure/accessTokens.json",
      ".config/hub",
      ".local/share/keyrings/login.keyring",
      ".config/google-chrome/Default/Cookies",
      ".config/chromium/Default/Cookies",
      ".mozilla/firefox/p/cookies.sqlite",
      "Library/Keychains/login.keychain-db",
      "Library/Cookies/Cookies.binarycookies",
      ".zsh_history",
      ".bash_history",
    ];
    for (const rel of secrets) {
      write(join(home, rel), "SECRET");
      expect(SENSITIVE_HOME_PATHS.some((p) => rel === p || rel.startsWith(`${p}/`)), rel).toBe(true);
      expect(share(`[s](~/${rel})`, homeScope)[0], rel).toMatchObject({ status: "not_allowed", id: null });
    }
    expect(share(`[h](${SYSTEM_OUTSIDE_FILE})`, homeScope)[0]!.status).toBe("not_allowed");
    // 经符号链接指过去的也拒
    symlinkSync(join(home, ".aws", "credentials"), join(home, "creds.txt"));
    expect(share("[c](~/creds.txt)", homeScope)[0]!.status).toBe("not_allowed");
    expect(copies()).toEqual([]);
    // 清单外的照常
    write(join(home, "notes.md"));
    expect(share("[n](~/notes.md)", homeScope)[0]!.status).toBe("saved");
  });

  it("防漂移：只读禁读的每一项（相对主目录）都被分享禁用名单覆盖", () => {
    const covered = (rel: string) => SENSITIVE_HOME_PATHS.some((p) => rel === p || rel.startsWith(`${p}/`));
    for (const rel of READONLY_SECRET_HOME_PATHS) expect(covered(rel), rel).toBe(true);
  });

  it("sensitivePathsOf：整份清单只在这里 realpath（主目录是符号链接时按它指向的地方），isShareable 可以直接吃算好的清单", () => {
    const linkedHome = join(base, "home-link");
    symlinkSync(home, linkedHome, process.platform === "win32" ? "junction" : "dir");
    const sensitive = sensitivePathsOf(linkedHome);
    expect(sensitive).toContain(join(realpathSync.native(home), ".ssh"));
    if (process.platform !== "win32") {
      expect(sensitive).toContain(realpathSync.native("/etc"));
    }
    const key = realpathSync.native(join(home, ".ssh", "id_rsa"));
    expect(isShareable(key, { ...scope, roots: [home], userHome: linkedHome }, sensitive)).toBe(false);
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

  it("站内链接、不存在的相对路径不当文件：不进 files，网页照原样显示", () => {
    write(join(proj, "src", "real.ts"));
    const files = share("[登录](/login) [首页](/) [api](/api/users?id=1) [x](src/foo.ts) [y](./nope/a.md) [z](~/nope.md) [r](src/real.ts)");
    expect(files.map((f) => [f.href, f.status])).toEqual([["src/real.ts", "saved"]]);
  });

  it("绝对路径写的、落在可分享的文件夹里但不存在：出“没找到”卡片（也认 file:// 和 /tmp 这类经符号链接的根）", () => {
    const sysTmp = process.platform === "win32" ? tmpdir() : "/tmp";
    const missingInTmp = join(sysTmp, "agent-hub-surely-missing", "a.png");
    const tmpScope = { ...scope, roots: [...scope.roots, sysTmp] };
    const files = share(`[a](${join(proj, "sub", "nope.pdf")}) [b](file://${join(proj, "x.md")}) [c](${missingInTmp})`, tmpScope);
    expect(files.map((f) => f.status)).toEqual(["missing", "missing", "missing"]);
  });

  it("可分享的文件夹外面的目录（/、/usr）不出卡片；里面的目录出“不是文件”", () => {
    mkdirSync(join(proj, "dir"));
    expect(share(`[根](/) [usr](/usr) [d](${join(proj, "dir")})`).map((f) => [f.href, f.status])).toEqual([[join(proj, "dir"), "not_file"]]);
  });

  it("不当文件的链接不占 10 个的名额", () => {
    const links = Array.from({ length: 10 }, (_, i) => `[${i}](${write(join(proj, `f${i}.md`))})`);
    const files = share(["[登录](/login)", "[x](src/foo.ts)", ...links].join("\n"));
    expect(files).toHaveLength(10);
    expect(files.at(-1)!.name).toBe("f9.md");
  });

  it("文件夹、命名管道：不是文件，不拷（管道不会卡住）", () => {
    mkdirSync(join(proj, "dir"));
    if (process.platform === "win32") {
      expect(share(`[d](${join(proj, "dir")}) [p](\\\\.\\pipe\\fusa-sent-test)`).map((f) => f.status)).toEqual([
        "not_file",
      ]);
    } else {
      execFileSync("mkfifo", [join(proj, "pipe")]);
      expect(share(`[d](${join(proj, "dir")}) [p](${join(proj, "pipe")})`).map((f) => f.status)).toEqual(["not_file", "not_file"]);
    }
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
    expect(share(`[e](${edge})`)[0]).toMatchObject({ status: "saved", size: MAX_SENT_FILE_BYTES });
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
    const names = ["中文 名字.md", "a(1).png", "第#1.md", "100%.txt", "😀.png", `${"长".repeat(80)}.md`];
    for (const n of names) write(join(proj, n));
    const hrefs = [
      `<${join(proj, "中文 名字.md")}>`,
      join(proj, "a(1).png"),
      join(proj, "第#1.md"),
      join(proj, "100%25.txt"),
      join(proj, "😀.png"),
      join(proj, `${"长".repeat(80)}.md`),
    ];
    const files = share(hrefs.map((h, i) => `[${i}](${h})`).join(" "));
    expect(files.map((f) => f.status)).toEqual(Array(6).fill("saved"));
    expect(files.slice(0, 5).map((f) => f.name)).toEqual(names.slice(0, 5));
    // 超长名截到 120 字节以内，扩展名留着（源文件名 243 字节：Linux 的文件名上限是 255 字节，100 个字就放不下了）
    expect(files[5]!.name.endsWith(".md")).toBe(true);
    expect(Buffer.byteLength(files[5]!.name)).toBeLessThanOrEqual(120);
    expect(copyOf(files[5]!)).toBe("x");
    // 原样的 % 解不开码就按原样当路径
    expect(share(`[p](${join(proj, "100%.txt")})`)[0]!.status).toBe("saved");
  });

  it("有空格但没尖括号：不是链接，当普通文字", () => {
    write(join(proj, "a b.md"));
    expect(share(`[x](${join(proj, "a b.md")})`)).toEqual([]);
  });

  it("代码块、行内代码里的链接不处理", () => {
    const md = write(join(proj, "a.md"));
    expect(share(`\`\`\`\n[x](${md})\n![y](${md})\n\`\`\`\n\n行内 \`[x](${md})\`\n\n    [缩进](${md})`)).toEqual([]);
  });

  it("同一条消息处理两次（入库前崩了、重启后重放）：内容没变就命中已有副本，编号不变、不重复拷", () => {
    const md = write(join(proj, "a.md"), "v1");
    const first = share(`[a](${md}) [b](${write(join(proj, "b.md"), "b")})`);
    const again = share(`[a](${md}) [b](${join(proj, "b.md")})`);
    expect(again.map((f) => f.id)).toEqual(first.map((f) => f.id));
    expect(copies().sort()).toEqual(first.map((f) => f.id).sort());
  });

  it("按内容去重：两个会话、两条消息发同一个文件只存一份，元数据各记各的；内容变了另存一份", () => {
    const md = write(join(proj, "a.md"), "v1");
    const [a] = share(`[a](${md})`);
    const [b] = share(`[另一种写法](file://${md})`);
    expect(a!.id).toBe(b!.id);
    expect([a!.path, b!.path]).toEqual([md, md]);
    expect(copies()).toHaveLength(1);
    writeFileSync(md, "v2");
    const [c] = share(`[a](${md})`);
    expect(c!.id).not.toBe(a!.id);
    expect(copies()).toHaveLength(2);
    expect(copyOf(a!)).toBe("v1");
    expect(copyOf(c!)).toBe("v2");
  });

  it("再发已有的副本：副本目录的修改时间刷新到现在，刚发过的不会被定期清理", () => {
    const md = write(join(proj, "a.md"), "v1");
    const [a] = share(`[a](${md})`);
    const dir = join(sentDir, a!.id!);
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    utimesSync(dir, old, old);
    share(`[a](${md})`);
    expect(Date.now() - statSync(dir).mtimeMs).toBeLessThan(60_000);
  });

  it("同样内容、不同文件名：各存一份（副本目录里放的是文件名）", () => {
    const [a, b] = share(`[a](${write(join(proj, "a.md"), "same")}) [b](${write(join(proj, "b.md"), "same")})`);
    expect(a!.id).not.toBe(b!.id);
    expect([copyOf(a!), copyOf(b!)]).toEqual(["same", "same"]);
  });

  it("拷的时候源文件被截断：元数据记实际拷到的字节数", () => {
    const src = write(join(proj, "t.bin"), "0123456789");
    const fd = openSync(src, "r");
    try {
      // 开文件时它还有 100 字节（fstat 看到的），拷的时候只剩 10 字节
      const stat = Object.assign(fstatSync(fd), { size: 100 });
      mkdirSync(sentDir, { recursive: true });
      const copied = copyFromFd(fd, stat, join(sentDir, "out"));
      expect(copied.bytes).toBe(10);
      expect(readFileSync(join(sentDir, "out"), "utf8")).toBe("0123456789");
    } finally {
      closeSync(fd);
    }
  });

  it("启动时清掉没拷完的残留目录，副本留着", () => {
    const [file] = share(`[a](${write(join(proj, "a.md"))})`);
    mkdirSync(join(sentDir, ".partial-0123456789abcdef-aa"));
    prepareSentFilesDir(sentDir);
    expect(copies()).toEqual([file!.id]);
  });

  it("没有本机文件链接的普通文字或纯外链：不跑敏感路径 realpathSync", () => {
    const getter = Object.getOwnPropertyDescriptor(scope, "userHome");
    let reads = 0;
    const lazyScope: ShareScope = {
      ...scope,
      get userHome() {
        reads++;
        return scope.userHome;
      },
    };
    expect(share("这是一段普通消息，没有任何链接。", lazyScope)).toEqual([]);
    expect(share("外链 [GitHub](https://github.com/example/repo) 也不需要查本机路径", lazyScope)).toEqual([]);
    expect(reads).toBe(0);
    void getter;
  });
});

describe("链接后面带行号", () => {
  const link = (href: string) => share(`[协议](${href})`);

  it.each(["#L10", "#L10-L20", "#L10-20", "#L10C5", "#L10C5-L12C3", ":10", ":10:5", ":10-20", ":10:5-12:3"])("%s：去掉后找到文件，标题照原样", (suffix) => {
    const file = write(join(proj, "src", "protocol.ts"), "CODE");
    const [saved, ...rest] = link(`${file}${suffix}`);
    expect(rest).toEqual([]);
    expect(saved).toMatchObject({ status: "saved", name: "protocol.ts", path: file, size: 4, href: `${file}${suffix}` });
    expect(copyOf(saved!)).toBe("CODE");
  });

  it("file:// 链接：# 片段不是路径，什么写法都去掉", () => {
    const file = write(join(proj, "a b.ts"), "CODE");
    expect(link(`file://${file.replace(" ", "%20")}#L502-L520`)[0]).toMatchObject({ status: "saved", name: "a b.ts" });
    expect(link(`file://${file.replace(" ", "%20")}#anchor`)[0]).toMatchObject({ status: "saved", name: "a b.ts" });
  });

  it("相对路径也认", () => {
    write(join(proj, "docs", "a.md"), "A");
    expect(link("docs/a.md:3")[0]).toMatchObject({ status: "saved", name: "a.md" });
    expect(link("docs/a.md#L2-L5")[0]).toMatchObject({ status: "saved", name: "a.md" });
  });

  it("文件名里真带 # 或 : 且原样存在：按原样找，不去掉", () => {
    const hashed = write(join(proj, "a#L10"), "H");
    write(join(proj, "a"), "plain");
    expect(link(hashed)[0]).toMatchObject({ status: "saved", name: "a#L10", size: 1 });
    if (process.platform !== "win32") {
      const colon = write(join(proj, "b:10"), "C");
      write(join(proj, "b"), "plain");
      expect(link(colon)[0]).toMatchObject({ status: "saved", name: "b:10", size: 1 });
    }
  });

  it("去掉行号后也不存在：照旧没找到", () => {
    expect(link(`${join(proj, "nope.ts")}#L1-L2`)[0]).toMatchObject({ status: "missing", name: "nope.ts#L1-L2", id: null });
    expect(link(`${join(proj, "nope.ts")}:7`)[0]).toMatchObject({ status: "missing", id: null });
  });
});
