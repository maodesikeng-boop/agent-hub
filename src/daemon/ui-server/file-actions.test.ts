// 预览窗背后的接口：?inline=1 取 pdf、html 的响应头；POST 在 Finder 中显示 / 用默认程序打开（open 命令换成记录调用的假函数，不真的打开）。
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { API_PATHS, UI_COOKIE_NAME, sentFileMime, type Attachment, type SentFile } from "../../shared/index.ts";
import { FakeLedger, makeMessage } from "./fake-ledger.ts";
import { createUiServer } from "./server.ts";

const TOKEN = "test-token-0123456789abcdef";
const PORT = 4000;
const HOST = `127.0.0.1:${PORT}`;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const COOKIE = `${UI_COOKIE_NAME}=${TOKEN}`;
const ID = "0123456789abcdef";

let root: string;
let projectDir: string;
let uploadsDir: string;
let sentFilesDir: string;
let ledger: FakeLedger;
let app: FastifyInstance;
let opened: string[][];
let openError: Error | null;

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "hub-actions-")));
  projectDir = join(root, "project");
  uploadsDir = join(root, "data", "uploads");
  sentFilesDir = join(root, "data", "sent-files");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(uploadsDir, { recursive: true });
  mkdirSync(sentFilesDir, { recursive: true });
  ledger = new FakeLedger();
  ledger.sentFileAllows = (_sessionId, real) => real.startsWith(projectDir);
  opened = [];
  openError = null;
  app = createUiServer({
    ledger: ledger.asLedger(),
    token: TOKEN,
    staticDir: join(root, "no-static"),
    uploadsDir,
    sentFilesDir,
    port: PORT,
    runOpen: async (args) => {
      if (openError !== null) throw openError;
      opened.push(args);
    },
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

interface Opts {
  cookie?: string | null;
  origin?: string | null;
}

function post(url: string, opts: Opts = {}) {
  const headers: Record<string, string> = { host: HOST };
  const cookie = opts.cookie === undefined ? COOKIE : opts.cookie;
  if (cookie !== null) headers.cookie = cookie;
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  if (origin !== null) headers.origin = origin;
  return app.inject({ method: "POST", url, headers });
}

function get(url: string) {
  return app.inject({ method: "GET", url, headers: { host: HOST, cookie: COOKIE } });
}

function sentCopy(id: string, name: string, content: string): string {
  mkdirSync(join(sentFilesDir, id), { recursive: true });
  const path = join(sentFilesDir, id, name);
  writeFileSync(path, content);
  return path;
}

/** 消息 5 里发了一个文件：原文件在项目里（写好了），副本在 sent-files/。 */
function sendFile(name: string, over: Partial<SentFile> = {}, content = "x"): { original: string; copy: string } {
  const original = join(projectDir, name);
  writeFileSync(original, content);
  const copy = sentCopy(ID, name, content);
  const file: SentFile = { href: original, path: original, id: ID, name, size: 1, mime: sentFileMime(name), status: "saved", mtime: 1, ...over };
  ledger.storedMessages.set(5, { ...makeMessage(5, 1), sender: "agent", sessionId: 3, meta: { files: [file] } });
  return { original, copy };
}

describe("GET ?inline=1（预览窗取 pdf、html）", () => {
  it("pdf：内联，保持 nosniff 和 CSP 沙箱（浏览器自带查看器在 iframe 里能渲染，只是 iframe 本身不能加 sandbox 属性）", async () => {
    sentCopy(ID, "报告.pdf", "%PDF-1.4");
    const res = await get(`/api/sent-files/${ID}/x.pdf?inline=1`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toBe("inline; filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBe("sandbox; default-src 'none'");
  });

  it("html：内联，CSP 是 sandbox allow-scripts（脚本能跑，但没有同源身份），nosniff", async () => {
    sentCopy(ID, "页面.html", "<script>1</script>");
    const res = await get(`/api/sent-files/${ID}/x.html?inline=1`);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.headers["content-disposition"]).toContain("inline");
    expect(res.headers["content-security-policy"]).toBe("sandbox allow-scripts");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("不带 inline：pdf、html 照旧当下载，CSP 照旧", async () => {
    sentCopy(ID, "页面.html", "x");
    const res = await get(`/api/sent-files/${ID}/x.html`);
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-security-policy"]).toBe("sandbox; default-src 'none'");
  });

  it("别的类型带 inline 也不内联（文本、压缩包、未知）", async () => {
    for (const name of ["a.txt", "a.zip", "a.md", "a.csv"]) {
      rmSync(sentFilesDir, { recursive: true, force: true });
      sentCopy(ID, name, "x");
      const res = await get(`/api/sent-files/${ID}/${name}?inline=1`);
      expect(res.headers["content-disposition"], name).toContain("attachment");
      expect(res.headers["content-security-policy"], name).toBe("sandbox; default-src 'none'");
    }
  });

  it("视频：带 Range 取得到（原生播放器拖动用）", async () => {
    sentCopy(ID, "a.mp4", "0123456789");
    const res = await app.inject({ method: "GET", url: `/api/sent-files/${ID}/a.mp4?inline=1`, headers: { host: HOST, cookie: COOKIE, range: "bytes=2-5" } });
    expect(res.statusCode).toBe(206);
    expect(res.headers["content-type"]).toBe("video/mp4");
    expect(res.body).toBe("2345");
  });

  it("上传的附件带 inline=1：按扩展名认类型（pdf 能内联），不带的还是 octet-stream 下载", async () => {
    const dir = join(uploadsDir, ID);
    mkdirSync(dir);
    writeFileSync(join(dir, "报告.pdf"), "%PDF");
    const inline = await get(`/api/uploads/${ID}/x?inline=1`);
    expect(inline.headers["content-type"]).toBe("application/pdf");
    expect(inline.headers["content-disposition"]).toContain("inline");
    const plain = await get(`/api/uploads/${ID}/x`);
    expect(plain.headers["content-type"]).toBe("application/octet-stream");
    expect(plain.headers["content-disposition"]).toContain("attachment");
  });
});

describe("POST 在 Finder 中显示 / 用默认程序打开（agent 发来的文件）", () => {
  const url = (action: string, index = 0) => `/api/messages/5/files/${index}/${action}`;

  it("在 Finder 中显示：open -R -- 原文件，返回 target original", async () => {
    const { original } = sendFile("报告.pdf");
    const res = await post(url("reveal"));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ target: "original" });
    expect(opened).toEqual([["-R", "--", original]]);
  });

  it("用默认程序打开：open -- 原文件", async () => {
    const { original } = sendFile("报告.pdf");
    expect((await post(url("open"))).statusCode).toBe(200);
    expect(opened).toEqual([["--", original]]);
  });

  it("接口地址和 API_PATHS 一致", () => {
    expect(API_PATHS.sentFileAction(5, 0, "open")).toBe(url("open"));
  });

  it("原文件已经删了：用副本", async () => {
    const { original, copy } = sendFile("报告.pdf");
    rmSync(original);
    const res = await post(url("open"));
    expect(res.json()).toEqual({ target: "copy" });
    expect(opened).toEqual([["--", copy]]);
  });

  it("原文件还在但已经不在允许的文件夹里：用副本，不碰原文件", async () => {
    const outside = join(root, "elsewhere");
    mkdirSync(outside);
    const { copy } = sendFile("报告.pdf", { path: join(outside, "报告.pdf") });
    writeFileSync(join(outside, "报告.pdf"), "secret");
    const res = await post(url("reveal"));
    expect(res.json()).toEqual({ target: "copy" });
    expect(opened).toEqual([["-R", "--", copy]]);
  });

  it("原文件是符号链接指到允许的文件夹外：按真实路径判断，用副本", async () => {
    const outside = join(root, "elsewhere.txt");
    writeFileSync(outside, "secret");
    const { original, copy } = sendFile("a.txt");
    rmSync(original);
    symlinkSync(outside, original);
    await post(url("open"));
    expect(opened).toEqual([["--", copy]]);
  });

  it("可执行类型（.sh、.app、.command、.pkg、.scpt、.jar）：只能显示，打开 403 且不执行", async () => {
    for (const name of ["run.sh", "a.command", "b.pkg", "c.scpt", "d.jar", "E.APP"]) {
      opened = [];
      const { original } = sendFile(name);
      const refused = await post(url("open"));
      expect(refused.statusCode, name).toBe(403);
      expect(refused.json().error, name).toContain("Finder");
      expect(opened, name).toEqual([]);
      expect((await post(url("reveal"))).statusCode, name).toBe(200);
      expect(opened, name).toEqual([["-R", "--", original]]);
    }
  });

  it("带可执行权限的文件（没有扩展名也一样）：打开 403，显示可以", async () => {
    const { original } = sendFile("tool");
    chmodSync(original, 0o755);
    expect((await post(url("open"))).statusCode).toBe(403);
    expect(opened).toEqual([]);
    expect((await post(url("reveal"))).statusCode).toBe(200);
  });

  it("不带 Origin 403、Origin 不对 403、没登录 401；都不执行", async () => {
    sendFile("a.pdf");
    expect((await post(url("open"), { origin: null })).statusCode).toBe(403);
    expect((await post(url("open"), { origin: "http://evil.example" })).statusCode).toBe(403);
    expect((await post(url("open"), { origin: "http://127.0.0.1:9999" })).statusCode).toBe(403);
    expect((await post(url("open"), { cookie: null })).statusCode).toBe(401);
    expect(opened).toEqual([]);
  });

  it("没有这条消息、没有这个下标、没存副本的、动作不认识：404", async () => {
    sendFile("a.pdf");
    expect((await post("/api/messages/6/files/0/open")).statusCode).toBe(404);
    expect((await post(url("open", 1))).statusCode).toBe(404);
    expect((await post(url("delete"))).statusCode).toBe(404);
    expect((await post("/api/messages/5/files/x/open")).statusCode).toBe(404);
    sendFile("b.pdf", { id: null, size: null, status: "missing" });
    expect((await post(url("open"))).statusCode).toBe(404);
    expect(opened).toEqual([]);
  });

  it("原文件和副本都没了：404，不执行", async () => {
    const { original, copy } = sendFile("a.pdf");
    rmSync(original);
    rmSync(copy);
    expect((await post(url("open"))).statusCode).toBe(404);
    expect(opened).toEqual([]);
  });

  it("消息里的路径写成 -rf 开头、带空格、中文：照样当一个参数（-- 之后）", async () => {
    const { original } = sendFile("-r f 报告.pdf");
    await post(url("open"));
    expect(opened).toEqual([["--", original]]);
  });

  it("open 命令失败：500，原因是中文", async () => {
    sendFile("a.pdf");
    openError = new Error("boom");
    const res = await post(url("open"));
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("没能打开这个文件");
  });
});

describe("POST 在 Finder 中显示 / 用默认程序打开（聊天框上传的附件）", () => {
  function uploadedFile(name: string): Attachment {
    mkdirSync(join(uploadsDir, ID), { recursive: true });
    const path = join(uploadsDir, ID, name);
    writeFileSync(path, "x");
    return { id: ID, name, path, size: 1, mime: "application/octet-stream" };
  }

  it("显示、打开：用上传目录里的那一份", async () => {
    const a = uploadedFile("a.pdf");
    expect((await post(API_PATHS.attachmentAction(ID, "reveal"))).statusCode).toBe(200);
    expect((await post(API_PATHS.attachmentAction(ID, "open"))).statusCode).toBe(200);
    expect(opened).toEqual([["-R", "--", a.path], ["--", a.path]]);
  });

  it("可执行类型打开 403；没有这个编号 404；不带 Origin 403", async () => {
    uploadedFile("run.sh");
    expect((await post(API_PATHS.attachmentAction(ID, "open"))).statusCode).toBe(403);
    expect((await post(API_PATHS.attachmentAction("fedcba9876543210", "open"))).statusCode).toBe(404);
    expect((await post(API_PATHS.attachmentAction(ID, "reveal"), { origin: null })).statusCode).toBe(403);
    expect(opened).toEqual([]);
  });
});
