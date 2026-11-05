// “@”文件搜索（方案第 5 节 14、15、16、27）。
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_FILE_RESULTS, MAX_WORKSPACE_FILES } from "../shared/index.ts";
import { createWorkspaceFiles, fileScore, listWorkspaceFiles } from "./workspace-files.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "hub-files-"));
  dirs.push(d);
  return d;
}

function write(root: string, files: string[]): void {
  for (const f of files) {
    mkdirSync(join(root, f, ".."), { recursive: true });
    writeFileSync(join(root, f), "x");
  }
}

function gitInit(root: string): void {
  execFileSync("git", ["init", "-q"], { cwd: root });
}

describe("列文件", () => {
  it("14：git 仓库：跳过 .gitignore 里的，没提交的也列；只列文件不列文件夹", async () => {
    const root = tempDir();
    gitInit(root);
    write(root, ["README.md", "src/a.ts", "dist/out.js", "secret.env", "node_modules/pkg/index.js", "docs/中文 文件.md"]);
    writeFileSync(join(root, ".gitignore"), "dist/\n*.env\nnode_modules/\n");
    execFileSync("git", ["add", "README.md"], { cwd: root });
    const { files, truncated } = await listWorkspaceFiles(root);
    expect(files.sort()).toEqual([".gitignore", "README.md", "docs/中文 文件.md", "src/a.ts"]);
    expect(truncated).toBe(false);
  });

  it("16：不是 git 仓库：自己遍历，跳过 node_modules 和 .git，不跟符号链接进目录", async () => {
    const root = tempDir();
    const outside = tempDir();
    write(outside, ["outside.txt"]);
    write(root, ["README.md", "src/deep/a.ts", "node_modules/pkg/index.js", ".git/config", ".hidden/ok.md"]);
    symlinkSync(outside, join(root, "link"));
    const { files } = await listWorkspaceFiles(root);
    expect(files.sort()).toEqual([".hidden/ok.md", "README.md", "src/deep/a.ts"]);
  });

  it("git 不执行仓库里配置的脚本：core.fsmonitor 指到脚本，列文件后脚本没跑", async () => {
    const root = tempDir();
    const outside = tempDir();
    gitInit(root);
    write(root, ["a.txt"]);
    execFileSync("git", ["add", "a.txt"], { cwd: root });
    const marker = join(outside, "ran");
    const hook = join(outside, "fsmonitor.sh");
    writeFileSync(hook, `#!/bin/sh\necho ran >> "${marker}"\nprintf '\\0'\n`);
    chmodSync(hook, 0o755);
    execFileSync("git", ["config", "core.fsmonitor", hook], { cwd: root });
    // 先确认这个脚本在普通的 git ls-files 下真的会跑，不然下面的断言什么也证明不了
    execFileSync("git", ["ls-files", "--cached", "--others"], { cwd: root });
    expect(existsSync(marker)).toBe(true);
    unlinkSync(marker);
    const { files } = await listWorkspaceFiles(root);
    expect(files).toEqual(["a.txt"]);
    expect(existsSync(marker)).toBe(false);
  });

  it("符号链接、已经不存在的文件、嵌套仓库（git 列成 dir/ 或不带斜杠的子模块）都不列", async () => {
    const root = tempDir();
    gitInit(root);
    write(root, ["a.txt", "gone.txt", "src/b.ts"]);
    symlinkSync("a.txt", join(root, "link.txt"));
    symlinkSync(root, join(root, "dirlink"));
    mkdirSync(join(root, "nested"));
    execFileSync("git", ["init", "-q"], { cwd: join(root, "nested") });
    write(join(root, "nested"), ["inner.txt"]);
    execFileSync("git", ["add", "a.txt", "gone.txt", "src/b.ts", "link.txt", "dirlink"], { cwd: root });
    execFileSync("git", ["update-index", "--add", "--cacheinfo", "160000,1111111111111111111111111111111111111111,sub"], { cwd: root });
    unlinkSync(join(root, "gone.txt"));
    const raw = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" }).split("\n");
    expect(raw).toEqual(expect.arrayContaining(["gone.txt", "link.txt", "nested/", "sub"]));
    const { files } = await listWorkspaceFiles(root);
    expect(files.sort()).toEqual(["a.txt", "src/b.ts"]);
  });

  it("文件夹不存在：空的", async () => {
    await expect(listWorkspaceFiles(join(tmpdir(), "hub-no-such-dir-xyz"))).resolves.toEqual({ files: [], truncated: false });
  });

  it("15：30000 个文件：最多列 MAX_WORKSPACE_FILES 个、truncated；缓存命中时一次少于 200ms，最多 MAX_FILE_RESULTS 条", { timeout: 60_000 }, async () => {
    const root = tempDir();
    gitInit(root);
    for (let d = 0; d < 30; d++) {
      mkdirSync(join(root, `d${d}`));
      for (let f = 0; f < 1000; f++) writeFileSync(join(root, `d${d}`, `file${f}.txt`), "");
    }
    const files = createWorkspaceFiles();
    const first = await files.search([root], "file1");
    expect(first.truncated).toBe(true);
    expect(first.matches).toHaveLength(MAX_FILE_RESULTS);
    const listed = await listWorkspaceFiles(root);
    expect(listed.files).toHaveLength(MAX_WORKSPACE_FILES);
    const started = performance.now();
    const again = await files.search([root], "fil");
    expect(performance.now() - started).toBeLessThan(200);
    expect(again.matches).toHaveLength(MAX_FILE_RESULTS);
  });
});

describe("打分和搜索", () => {
  it("文件名命中排在路径命中前面：一样 > 开头 > 包含 > 按顺序含 > 路径包含 > 路径按顺序含", () => {
    expect(fileScore("src/app.ts", "app.ts")).toBe(0);
    expect(fileScore("src/app.ts", "app")).toBe(1);
    expect(fileScore("src/myapp.ts", "app")).toBe(2);
    expect(fileScore("src/a_p_p.ts", "app")).toBe(3);
    expect(fileScore("app/index.ts", "app")).toBe(4);
    expect(fileScore("a/p/p/index.ts", "app")).toBe(5);
    expect(fileScore("src/index.ts", "zzz")).toBeNull();
    expect(fileScore("Src/README.md", "readme")).toBe(1);
  });

  it("按分数排，同分短的在前；缓存期间新加的文件看不到，过期后看得到", async () => {
    const root = tempDir();
    write(root, ["composer/index.ts", "src/composer.ts", "src/web/components/Composer.tsx", "docs/composer-plan.md"]);
    let clock = 0;
    const files = createWorkspaceFiles({ now: () => clock, freshMs: 1000 });
    const { matches } = await files.search([root], "composer");
    expect(matches.map((m) => m.path)).toEqual(["src/composer.ts", "docs/composer-plan.md", "src/web/components/Composer.tsx", "composer/index.ts"]);
    write(root, ["fresh.md"]);
    expect((await files.search([root], "fresh")).matches).toEqual([]);
    clock = 1000;
    expect((await files.search([root], "fresh")).matches).toEqual([{ root, path: "fresh.md" }]);
  });

  it("清单缓存有上限：超过 maxCaches 个文件夹，最旧的被淘汰，下次搜它要重新列", async () => {
    const [a, b, c] = [tempDir(), tempDir(), tempDir()];
    for (const d of [a, b, c]) write(d, ["old.md"]);
    const files = createWorkspaceFiles({ now: () => 0, freshMs: 1_000_000, maxCaches: 2 });
    for (const d of [a, b, c]) await files.search([d], "");
    for (const d of [a, b, c]) write(d, ["fresh.md"]);
    // b、c 还在缓存里（看不到新文件），a 被淘汰了（重新列，看得到）
    expect((await files.search([b], "fresh")).matches).toEqual([]);
    expect((await files.search([c], "fresh")).matches).toEqual([]);
    expect((await files.search([a], "fresh")).matches).toEqual([{ root: a, path: "fresh.md" }]);
  });

  it("27：搜索词只拿来比，`../../etc` 这类搜不出文件夹外面的东西", async () => {
    const root = tempDir();
    write(root, ["a.txt"]);
    const files = createWorkspaceFiles();
    for (const q of ["../../etc", "/etc/passwd", "..", "../a.txt"]) {
      const { matches } = await files.search([root], q);
      for (const m of matches) expect(m.root).toBe(root);
      expect(matches.every((m) => !m.path.includes(".."))).toBe(true);
    }
    expect((await files.search([root], "../../etc/passwd")).matches).toEqual([]);
  });

  it("几个文件夹一起搜，结果带上是哪个文件夹的", async () => {
    const a = tempDir();
    const b = tempDir();
    write(a, ["notes.md"]);
    write(b, ["notes-b.md"]);
    const { matches } = await createWorkspaceFiles().search([a, b], "notes");
    expect(matches).toEqual([
      { root: a, path: "notes.md" },
      { root: b, path: "notes-b.md" },
    ]);
  });
});
