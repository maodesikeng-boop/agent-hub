import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LedgerRequestError,
  MAX_PERSONA_BYTES,
  PM_ARCHIVE_RETENTION_MS,
  PM_MEMORY_INDEX_FILE,
  PM_MEMORY_MAX_BYTES,
  PM_MEMORY_MAX_DIR_SCAN,
  PM_MEMORY_MAX_LINES,
  PM_MEMORY_MAX_SUBFILES,
  PM_MEMORY_MAX_SUBFILE_BYTES,
  PM_MEMORY_MAX_TOTAL_BYTES,
  checkPmMemoryFileName,
  pmMemoryLineCount,
  utf8Bytes,
} from "../shared/index.ts";
import { pmMemoryDirPath, pmMemoryIndexPath, resolveHubPaths } from "../shared/paths.ts";
import { createPersonaNoter } from "./launch.ts";
import { createLedger, type SqliteLedger } from "./ledger/index.ts";
import {
  PM_MEMORY_TRUNCATION_HINT,
  deletePmMemoryFile,
  listPmMemoryFiles,
  readPmMemoryFile,
  truncatePmMemoryForPrompt,
  writePmMemoryFile,
} from "./pm-memory.ts";
import { openTestDb } from "./store/test-helpers.ts";
import type { Db } from "./store/index.ts";
import { createUiServer } from "./ui-server/server.ts";

describe("paths & limits：pm-memory 目录与文件名校验", () => {
  it("resolveHubPaths 包含 state/pm-memory，辅助路径拼出专属目录与 MEMORY.md", () => {
    const paths = resolveHubPaths({}, "/Users/u");
    expect(paths.pmMemoryDir).toBe("/Users/u/.agent-hub/state/pm-memory");
    expect(pmMemoryDirPath(paths.pmMemoryDir, 7)).toBe("/Users/u/.agent-hub/state/pm-memory/7");
    expect(pmMemoryIndexPath(paths.pmMemoryDir, 7)).toBe(`/Users/u/.agent-hub/state/pm-memory/7/${PM_MEMORY_INDEX_FILE}`);
  });

  it("checkPmMemoryFileName：只放行扁平 <topic>.md，严格拦截路径穿越、点文件、非 .md 与主索引同名文件", () => {
    expect(checkPmMemoryFileName("architecture.md")).toBeNull();
    expect(checkPmMemoryFileName("编码规范-v2.md")).toBeNull();
    for (const bad of [
      "",
      "   ",
      " notes.md",
      "notes.md ",
      ".md",
      ".hidden.md",
      "../secret.md",
      "foo/../bar.md",
      "a..b.md",
      "sub/topic.md",
      "sub\\topic.md",
      "bad:name.md",
      "bad\0.md",
      "bad\n.md",
      "notes.txt",
      "notes.MD",
      "MEMORY.md",
      "memory.md",
      "Memory.md",
      `${"a".repeat(80)}.md`,
    ]) {
      expect(checkPmMemoryFileName(bad), JSON.stringify(bad)).not.toBeNull();
    }
  });
});

describe("truncatePmMemoryForPrompt：200 行与 25 KB 双上限安全截断", () => {
  it("未超限时无损原样返回（含恰好 200 行与恰好 25 KB）", () => {
    expect(truncatePmMemoryForPrompt("")).toEqual({ text: "", truncated: false });
    const exact200 = Array.from({ length: PM_MEMORY_MAX_LINES }, (_, i) => `line-${i + 1}`).join("\n");
    expect(truncatePmMemoryForPrompt(exact200)).toEqual({ text: exact200, truncated: false });

    const exact25k = "x".repeat(PM_MEMORY_MAX_BYTES);
    expect(truncatePmMemoryForPrompt(exact25k)).toEqual({ text: exact25k, truncated: false });
  });

  it("末尾单个换行不算多一行：恰好 200 行并以换行结尾不截断、不附提示，201 行才截断", () => {
    expect(pmMemoryLineCount("")).toBe(0);
    expect(pmMemoryLineCount("a")).toBe(1);
    expect(pmMemoryLineCount("a\n")).toBe(1);
    expect(pmMemoryLineCount("a\n\n")).toBe(2);
    const exact200Nl = Array.from({ length: PM_MEMORY_MAX_LINES }, (_, i) => `line-${i + 1}`).join("\n") + "\n";
    expect(truncatePmMemoryForPrompt(exact200Nl)).toEqual({ text: exact200Nl, truncated: false });
    const over201Nl = Array.from({ length: PM_MEMORY_MAX_LINES + 1 }, (_, i) => `line-${i + 1}`).join("\n") + "\n";
    const res = truncatePmMemoryForPrompt(over201Nl);
    expect(res.truncated).toBe(true);
    expect(res.text).not.toContain("line-201");
    expect(res.text.endsWith(`\n${PM_MEMORY_TRUNCATION_HINT}`)).toBe(true);
  });

  it("超过 200 行时截断到前 200 行，并在末尾附单行拆分提示", () => {
    const overLines = Array.from({ length: 205 }, (_, i) => `第 ${i + 1} 行`).join("\n");
    const res = truncatePmMemoryForPrompt(overLines);
    expect(res.truncated).toBe(true);
    expect(PM_MEMORY_TRUNCATION_HINT.includes("\n")).toBe(false);
    const lines = res.text.split("\n");
    expect(lines).toHaveLength(PM_MEMORY_MAX_LINES + 1);
    expect(lines[0]).toBe("第 1 行");
    expect(lines[PM_MEMORY_MAX_LINES - 1]).toBe("第 200 行");
    expect(lines[PM_MEMORY_MAX_LINES]).toBe(PM_MEMORY_TRUNCATION_HINT);
    expect(res.text).not.toContain("第 201 行");
  });

  it("超过 25 KB（含多字节中文与 Emoji 代理对）时按完整字符安全截断且总字节 <= 25 KB", () => {
    const cjk = "记".repeat(10_000); // 30_000 UTF-8 bytes
    const resCjk = truncatePmMemoryForPrompt(cjk);
    expect(resCjk.truncated).toBe(true);
    expect(utf8Bytes(resCjk.text)).toBeLessThanOrEqual(PM_MEMORY_MAX_BYTES);
    expect(resCjk.text.includes("\uFFFD")).toBe(false);
    expect(resCjk.text.endsWith(`\n${PM_MEMORY_TRUNCATION_HINT}`)).toBe(true);

    const emoji = "🍊".repeat(8_000); // 32_000 UTF-8 bytes, UTF-16 surrogate pairs
    const resEmoji = truncatePmMemoryForPrompt(emoji);
    expect(resEmoji.truncated).toBe(true);
    expect(utf8Bytes(resEmoji.text)).toBeLessThanOrEqual(PM_MEMORY_MAX_BYTES);
    expect(resEmoji.text.includes("\uFFFD")).toBe(false);
    expect(Buffer.from(resEmoji.text, "utf8").toString("utf8")).toBe(resEmoji.text);
    expect(resEmoji.text.endsWith(`\n${PM_MEMORY_TRUNCATION_HINT}`)).toBe(true);
  });
});

describe("pm-memory 子文件管理：配额、路径穿越与符号链接逃逸拦截", () => {
  let root: string;
  let pmMemoryDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ah-pm-memory-"));
    pmMemoryDir = join(root, "state", "pm-memory");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("增删改查扁平 <topic>.md 子文件，且列表自动跳过 MEMORY.md 与隐藏临时文件", () => {
    expect(listPmMemoryFiles(pmMemoryDir, 1)).toEqual({ files: [], totalBytes: 0 });
    const dir = pmMemoryDirPath(pmMemoryDir, 1);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "MEMORY.md"), "# 主索引");
    writeFileSync(join(dir, ".tmp-ignore.md"), "temp");

    const written = writePmMemoryFile(pmMemoryDir, 1, "api.md", "# API 约定\n");
    expect(written.file.name).toBe("api.md");
    expect(written.file.bytes).toBe(utf8Bytes("# API 约定\n"));
    expect(written.totalBytes).toBe(written.file.bytes);

    expect(readPmMemoryFile(pmMemoryDir, 1, "api.md").content).toBe("# API 约定\n");
    expect(listPmMemoryFiles(pmMemoryDir, 1).files.map((f) => f.name)).toEqual(["api.md"]);

    deletePmMemoryFile(pmMemoryDir, 1, "api.md");
    expect(listPmMemoryFiles(pmMemoryDir, 1)).toEqual({ files: [], totalBytes: 0 });
    expect(() => readPmMemoryFile(pmMemoryDir, 1, "api.md")).toThrow(LedgerRequestError);
  });

  it("严格拦截路径穿越与符号链接逃逸（含软链文件与软链目录）", () => {
    const outside = join(root, "outside-secret.md");
    writeFileSync(outside, "TOP_SECRET");

    for (const attack of ["../outside-secret.md", "sub/a.md", "MEMORY.md", "memory.md"]) {
      expect(() => writePmMemoryFile(pmMemoryDir, 1, attack, "x")).toThrow(LedgerRequestError);
      expect(() => readPmMemoryFile(pmMemoryDir, 1, attack)).toThrow(LedgerRequestError);
      expect(() => deletePmMemoryFile(pmMemoryDir, 1, attack)).toThrow(LedgerRequestError);
    }

    // 目录内植入指向外部文件的符号链接：list 跳过，read/write/delete 全部拒绝且绝不覆盖或删除外部原文件
    const pmDir = pmMemoryDirPath(pmMemoryDir, 1);
    mkdirSync(pmDir, { recursive: true });
    symlinkSync(outside, join(pmDir, "escape.md"));

    expect(listPmMemoryFiles(pmMemoryDir, 1).files).toEqual([]);
    expect(() => readPmMemoryFile(pmMemoryDir, 1, "escape.md")).toThrow(LedgerRequestError);
    expect(() => writePmMemoryFile(pmMemoryDir, 1, "escape.md", "OVERWRITTEN")).toThrow(LedgerRequestError);
    expect(() => deletePmMemoryFile(pmMemoryDir, 1, "escape.md")).toThrow(LedgerRequestError);
    expect(readFileSync(outside, "utf8")).toBe("TOP_SECRET");

    // 整个 <pmId> 目录被替换成指向外部目录的符号链接：全部拒绝
    const outsideDir = join(root, "outside-dir");
    mkdirSync(outsideDir, { recursive: true });
    symlinkSync(outsideDir, pmMemoryDirPath(pmMemoryDir, 2));
    expect(() => listPmMemoryFiles(pmMemoryDir, 2)).toThrow(LedgerRequestError);
    expect(() => writePmMemoryFile(pmMemoryDir, 2, "note.md", "x")).toThrow(LedgerRequestError);
  });

  it("目录里被塞进超过扫描上限的杂项时，列表最多看 PM_MEMORY_MAX_DIR_SCAN 项、不报错", () => {
    const pmDir = pmMemoryDirPath(pmMemoryDir, 3);
    mkdirSync(pmDir, { recursive: true });
    for (let i = 0; i < PM_MEMORY_MAX_DIR_SCAN + 20; i++) writeFileSync(join(pmDir, `n-${i}.md`), "x");
    const listed = listPmMemoryFiles(pmMemoryDir, 3);
    expect(listed.files.length).toBe(PM_MEMORY_MAX_DIR_SCAN);
    expect(listed.totalBytes).toBe(PM_MEMORY_MAX_DIR_SCAN);
  });

  it("配额上限：单文件 <= 64 KB、最多 50 个子文件、总计 <= 1 MB", () => {
    // 1. 单文件 64 KB 放行，64 KB + 1 拒绝
    const maxSingle = "a".repeat(PM_MEMORY_MAX_SUBFILE_BYTES);
    expect(() => writePmMemoryFile(pmMemoryDir, 1, "exact.md", maxSingle)).not.toThrow();
    expect(() => writePmMemoryFile(pmMemoryDir, 1, "over.md", `${maxSingle}x`)).toThrow(LedgerRequestError);

    // 2. 总计 1 MB（16 * 64 KB = 1 MB）放行，再多 1 字节拒绝；缩小已有文件放行
    for (let i = 1; i < 16; i++) {
      writePmMemoryFile(pmMemoryDir, 1, `chunk-${i}.md`, maxSingle);
    }
    expect(listPmMemoryFiles(pmMemoryDir, 1).totalBytes).toBe(PM_MEMORY_MAX_TOTAL_BYTES);
    expect(() => writePmMemoryFile(pmMemoryDir, 1, "extra.md", "x")).toThrow(LedgerRequestError);
    expect(() => writePmMemoryFile(pmMemoryDir, 1, "chunk-15.md", "small")).not.toThrow();

    // 3. 最多 50 个子文件：第 50 个成功，第 51 个拒绝，更新已有的成功
    for (let i = 1; i <= PM_MEMORY_MAX_SUBFILES; i++) {
      writePmMemoryFile(pmMemoryDir, 3, `t-${i}.md`, `v${i}`);
    }
    expect(() => writePmMemoryFile(pmMemoryDir, 3, "t-51.md", "overflow")).toThrow(LedgerRequestError);
    expect(writePmMemoryFile(pmMemoryDir, 3, "t-50.md", "updated").file.content).toBe("updated");
  });
});

describe("平滑兼容迁移、双向同步、撤销与 HTTP 接口", () => {
  let db: Db;
  let root: string;
  let dataHome: string;
  let pmMemoryDir: string;
  let personasDir: string;
  let now: number;
  let ledger: SqliteLedger;

  beforeEach(() => {
    db = openTestDb();
    root = mkdtempSync(join(tmpdir(), "ah-pm-mem-ledger-"));
    dataHome = realpathSync.native((mkdirSync(join(root, ".agent-hub"), { recursive: true }), join(root, ".agent-hub")));
    pmMemoryDir = join(dataHome, "state", "pm-memory");
    personasDir = join(dataHome, "state", "personas");
    now = 10_000;
    ledger = createLedger(db, {
      now: () => now,
      pmHomeRoot: join(dataHome, "pm-home"),
      personasDir,
      pmMemoryDir,
      dataHome,
    });
  });

  afterEach(() => {
    ledger.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("老库首次读取：MEMORY.md 不存在且数据库现有性格设定非空时，自动无损写入 MEMORY.md", () => {
    const created = ledger.createPm({ name: "老林", mode: "manage_only", persona: "老库里的性格设定\n第二行" });
    const indexFile = pmMemoryIndexPath(pmMemoryDir, created.pm.id);
    // 模拟升级前状态：删掉 pm-memory 目录，只留数据库里的 pms.persona
    rmSync(pmMemoryDir, { recursive: true, force: true });
    expect(existsSync(indexFile)).toBe(false);

    const reopened = createLedger(db, {
      now: () => now,
      pmHomeRoot: join(dataHome, "pm-home"),
      personasDir,
      pmMemoryDir,
      dataHome,
    });
    try {
      const view = reopened.getPersona(created.pm.id);
      expect(view.text).toBe("老库里的性格设定\n第二行");
      expect(readFileSync(indexFile, "utf8")).toBe("老库里的性格设定\n第二行");
    } finally {
      reopened.close();
    }
  });

  it("双向同步与撤销：资料页编辑、hub persona show/edit、PM 直接改磁盘 MEMORY.md、Undo 全部一致", () => {
    const { pm, sessionId } = ledger.createPm({ name: "阿青", mode: "manage_only", persona: "初始设定" });
    const indexFile = pmMemoryIndexPath(pmMemoryDir, pm.id);
    expect(readFileSync(indexFile, "utf8")).toBe("初始设定");

    // 1. hub persona.edit 同步写 MEMORY.md
    ledger.hubCall(sessionId, "persona.edit", { text: "PM 通过 hub 改的索引", reason: "整理索引" });
    expect(readFileSync(indexFile, "utf8")).toBe("PM 通过 hub 改的索引");
    expect(ledger.getPersona(pm.id).text).toBe("PM 通过 hub 改的索引");

    // 2. PM 通过 addDirs 文件工具直接改磁盘 MEMORY.md -> hub persona.show 与 getPersona 感知并记入历史，支持 Undo！
    writeFileSync(indexFile, "PM 直接用 Edit 工具改的 MEMORY.md");
    const shown = ledger.hubCall(sessionId, "persona.show", {});
    expect(shown.data).toEqual({ text: "PM 直接用 Edit 工具改的 MEMORY.md", mode: "manage_only" });
    const afterDiskEdit = ledger.getPersona(pm.id);
    expect(afterDiskEdit.text).toBe("PM 直接用 Edit 工具改的 MEMORY.md");
    expect(afterDiskEdit.changes[0]).toMatchObject({
      actor: "file",
      textBefore: "PM 通过 hub 改的索引",
      textAfter: "PM 直接用 Edit 工具改的 MEMORY.md",
    });

    // 3. 资料页撤销（Undo）同时回退数据库和 MEMORY.md
    const reverted = ledger.revertPersonaChange(afterDiskEdit.revertableChangeId!);
    expect(reverted.persona.text).toBe("PM 通过 hub 改的索引");
    expect(readFileSync(indexFile, "utf8")).toBe("PM 通过 hub 改的索引");
  });

  it("PM 手写的 MEMORY.md 超过 MAX_PERSONA_BYTES：原文挪成 MEMORY-overflow-<时间>.md 子文件保全，再按数据库重写，不丢内容", () => {
    const { pm, sessionId } = ledger.createPm({ name: "超大索引", mode: "manage_only", persona: "数据库里的索引" });
    const indexFile = pmMemoryIndexPath(pmMemoryDir, pm.id);
    const big = "规则\n".repeat(Math.ceil((MAX_PERSONA_BYTES + 1) / utf8Bytes("规则\n")));
    expect(utf8Bytes(big)).toBeGreaterThan(MAX_PERSONA_BYTES);
    writeFileSync(indexFile, big);

    const ctx = ledger.getLaunchContext(sessionId);
    expect(ctx.pm.persona).toBe("数据库里的索引");
    expect(readFileSync(indexFile, "utf8")).toBe("数据库里的索引");
    const kept = `MEMORY-overflow-${now}.md`;
    expect(readFileSync(join(pmMemoryDirPath(pmMemoryDir, pm.id), kept), "utf8")).toBe(big);
    expect(ledger.listPmMemoryFiles(pm.id).files.map((f) => f.name)).toEqual([kept]);
    // 再来一次（同一时刻又被写超）：换名保全，绝不覆盖上一份
    writeFileSync(indexFile, `${big}第二份`);
    ledger.getPersona(pm.id);
    const names = ledger.listPmMemoryFiles(pm.id).files.map((f) => f.name);
    expect(names).toHaveLength(2);
    expect(readFileSync(join(pmMemoryDirPath(pmMemoryDir, pm.id), kept), "utf8")).toBe(big);
    expect(readFileSync(indexFile, "utf8")).toBe("数据库里的索引");
  });

  it("getLaunchContext 与 createPersonaNoter 对超 200 行 / 25 KB 的 MEMORY.md 自动截断并附拆分提示，完整原文仍无损保留", () => {
    const longPersona = Array.from({ length: 220 }, (_, i) => `规则 ${i + 1}: 保持清晰`).join("\n");
    expect(utf8Bytes(longPersona)).toBeLessThanOrEqual(MAX_PERSONA_BYTES);
    const { pm, sessionId } = ledger.createPm({ name: "超长测试", mode: "manage_only", persona: "短" });
    ledger.editPersona(pm.id, { text: longPersona }, { kind: "user" });

    // 资料页与磁盘保留完整 220 行
    expect(ledger.getPersona(pm.id).text).toBe(longPersona);
    expect(readFileSync(pmMemoryIndexPath(pmMemoryDir, pm.id), "utf8")).toBe(longPersona);

    // 系统提示词上下文与中途更新说明均截断到 200 行并附单行提示
    const ctx = ledger.getLaunchContext(sessionId);
    expect(ctx.pm.persona).toContain("规则 200: 保持清晰");
    expect(ctx.pm.persona).not.toContain("规则 201: 保持清晰");
    expect(ctx.pm.persona.endsWith(`\n${PM_MEMORY_TRUNCATION_HINT}`)).toBe(true);

    const noter = createPersonaNoter((sid, since) => ledger.personaUpdate(sid, since));
    const note = noter(sessionId, 0);
    expect(note?.note).toContain("规则 200: 保持清晰");
    expect(note?.note).not.toContain("规则 201: 保持清晰");
    expect(note?.note).toContain(PM_MEMORY_TRUNCATION_HINT);
  });

  it("归档保护与到期清理：归档后禁止改删子文件，到期清理一并删掉 state/pm-memory/<pmId>", () => {
    const { pm } = ledger.createPm({ name: "将归档", mode: "manage_only", persona: "设定" });
    ledger.putPmMemoryFile(pm.id, "roadmap.md", "# 路线图");
    expect(existsSync(join(pmMemoryDirPath(pmMemoryDir, pm.id), "roadmap.md"))).toBe(true);

    ledger.archivePm(pm.id);
    // 已归档仍可读，但禁止写和删
    expect(ledger.listPmMemoryFiles(pm.id).files).toHaveLength(1);
    expect(() => ledger.putPmMemoryFile(pm.id, "roadmap.md", "改")).toThrow(LedgerRequestError);
    expect(() => ledger.deletePmMemoryFile(pm.id, "roadmap.md")).toThrow(LedgerRequestError);

    now += PM_ARCHIVE_RETENTION_MS + 1;
    expect(ledger.purgeExpiredArchivedPms(now)).toEqual([pm.id]);
    expect(existsSync(pmMemoryDirPath(pmMemoryDir, pm.id))).toBe(false);
  });

  it("HTTP /api/pms/:id/memory-files 接口：鉴权、列表、读取、新建/编辑、删除与非法文件名 400 拦截", async () => {
    const { pm } = ledger.createPm({ name: "接口测试", mode: "manage_only", persona: "" });
    const token = "test-ui-token-123456";
    const app = createUiServer({
      ledger,
      staticDir: root,
      uploadsDir: join(dataHome, "uploads"),
      sentFilesDir: join(dataHome, "sent-files"),
      token,
      port: 4317,
    });
    await app.ready();
    try {
      const host = "127.0.0.1:4317";
      const origin = `http://${host}`;
      const login = await app.inject({
        method: "GET",
        url: `/auth?token=${token}`,
        headers: { host },
      });
      expect(login.statusCode).toBe(302);
      const cookie = String(login.headers["set-cookie"]).split(";")[0]!;

      // 未登录 401
      const unauth = await app.inject({ method: "GET", url: `/api/pms/${pm.id}/memory-files`, headers: { host } });
      expect(unauth.statusCode).toBe(401);

      // 初始为空
      const list0 = await app.inject({ method: "GET", url: `/api/pms/${pm.id}/memory-files`, headers: { host, cookie } });
      expect(list0.statusCode).toBe(200);
      expect(list0.json()).toEqual({ files: [], totalBytes: 0 });

      // PUT 新建
      const putRes = await app.inject({
        method: "PUT",
        url: `/api/pms/${pm.id}/memory-files/design.md`,
        headers: { host, origin, cookie },
        payload: { content: "# 设计笔记\n细节" },
      });
      expect(putRes.statusCode).toBe(200);
      expect(putRes.json().file).toMatchObject({ name: "design.md", content: "# 设计笔记\n细节" });

      // GET 单文件
      const getRes = await app.inject({
        method: "GET",
        url: `/api/pms/${pm.id}/memory-files/design.md`,
        headers: { host, cookie },
      });
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json()).toMatchObject({ name: "design.md", content: "# 设计笔记\n细节" });

      // 非法文件名（MEMORY.md、编码斜杠穿越）回 400
      for (const bad of ["MEMORY.md", "..%2Fsecret.md", "notes.txt"]) {
        const badRes = await app.inject({
          method: "PUT",
          url: `/api/pms/${pm.id}/memory-files/${bad}`,
          headers: { host, origin, cookie },
          payload: { content: "x" },
        });
        expect(badRes.statusCode, bad).toBe(400);
      }

      // DELETE 删除
      const delRes = await app.inject({
        method: "DELETE",
        url: `/api/pms/${pm.id}/memory-files/design.md`,
        headers: { host, origin, cookie },
      });
      expect(delRes.statusCode).toBe(204);

      const afterDel = await app.inject({ method: "GET", url: `/api/pms/${pm.id}/memory-files`, headers: { host, cookie } });
      expect(afterDel.json()).toEqual({ files: [], totalBytes: 0 });
    } finally {
      await app.close();
    }
  });
});
