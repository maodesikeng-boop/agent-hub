// 不是 macOS 的服务端（Linux 服务器）：/api/state 的 server 说明没有“选择文件夹”和“在 Finder 中显示 / 默认程序打开”，
// 这两类接口回 501，不会真的去起不存在的 osascript / open。不传 runOpen、folderPicker，走的是默认实现；都不会真的起进程。
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_PATHS, isLoopbackAddress, serverInfoFor, serverInfoForClient } from "../../shared/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { FakeLedger } from "./fake-ledger.ts";
import { createUiServer } from "./server.ts";
import { testLogin } from "./test-login.ts";

const TOKEN = "test-token-0123456789abcdef";
const PORT = 4000;
const db = openTestDb();
const HEADERS = { host: `127.0.0.1:${PORT}`, cookie: testLogin(db, PORT).cookie(), origin: `http://127.0.0.1:${PORT}` };
const ID = "0123456789abcdef";

let root: string;
let app: FastifyInstance;

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "hub-linux-")));
  const uploadsDir = join(root, "uploads");
  mkdirSync(join(uploadsDir, ID), { recursive: true });
  writeFileSync(join(uploadsDir, ID, "a.pdf"), "x");
  app = createUiServer({
    ledger: new FakeLedger().asLedger(),
    token: TOKEN,
    staticDir: join(root, "no-static"),
    uploadsDir,
    sentFilesDir: join(root, "sent-files"),
    port: PORT,
    db,
    serverInfo: serverInfoFor("linux"),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("服务端不是 macOS", () => {
  it("serverInfoFor：darwin 两项都有；linux 两项都关；win32 支持文件定位且仅经壳监管时开选文件夹", () => {
    expect(serverInfoFor("darwin")).toEqual({ platform: "darwin", folderPicker: true, fileActions: true });
    expect(serverInfoFor("linux")).toEqual({ platform: "linux", folderPicker: false, fileActions: false });
    expect(serverInfoFor("win32")).toEqual({ platform: "win32", folderPicker: false, fileActions: true });
    expect(serverInfoFor("win32", { supervised: true })).toEqual({ platform: "win32", folderPicker: true, fileActions: true });
  });

  it("/api/state 带着 server，网页按它显示控件", async () => {
    const res = await app.inject({ method: "GET", url: API_PATHS.state, headers: HEADERS });
    expect(res.statusCode).toBe(200);
    expect(res.json().server).toEqual({ platform: "linux", folderPicker: false, fileActions: false });
  });

  it("选择文件夹：501 加中文原因", async () => {
    const res = await app.inject({ method: "POST", url: API_PATHS.pickFolder, headers: { ...HEADERS, "content-type": "application/json" }, payload: "{}" });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toContain("直接输入路径");
  });

  it("在 Finder 中显示 / 用默认程序打开：501，不去起 open", async () => {
    for (const action of ["reveal", "open"] as const) {
      const res = await app.inject({ method: "POST", url: API_PATHS.attachmentAction(ID, action), headers: HEADERS });
      expect(res.statusCode, action).toBe(501);
      expect(res.json().error).toContain("下载");
    }
  });
});

describe("浏览器和守护进程不在同一台机器（macOS 服务端，请求不是来自回环地址）", () => {
  const mac = serverInfoFor("darwin");

  it("isLoopbackAddress：127.x、::1、::ffff:127.x 是，别的不是", () => {
    for (const a of ["127.0.0.1", "127.8.8.8", "::1", "::ffff:127.0.0.1"]) expect(isLoopbackAddress(a), a).toBe(true);
    for (const a of ["192.168.1.5", "10.0.0.2", "::ffff:10.0.0.2", "fe80::1", "", undefined]) expect(isLoopbackAddress(a), String(a)).toBe(false);
  });

  it("serverInfoForClient：回环才保留 fileActions 和 repoDir", () => {
    const macWithRepo = { ...mac, repoDir: "/Users/me/agent-hub" };
    expect(serverInfoForClient(macWithRepo, "127.0.0.1")).toEqual({ ...mac, fileActions: true, repoDir: "/Users/me/agent-hub" });
    expect(serverInfoForClient(macWithRepo, "192.168.1.5")).toEqual({ ...mac, fileActions: false });
  });

  it("/api/state 按请求来源：本机 true，别的机器 false", async () => {
    const macApp = createUiServer({
      ledger: new FakeLedger().asLedger(),
      token: TOKEN,
      staticDir: join(root, "no-static"),
      uploadsDir: join(root, "uploads"),
      sentFilesDir: join(root, "sent-files"),
      port: PORT,
      db,
      serverInfo: mac,
      runOpen: async () => {
        throw new Error("不该被调用");
      },
    });
    await macApp.ready();
    const local = await macApp.inject({ method: "GET", url: API_PATHS.state, headers: HEADERS, remoteAddress: "127.0.0.1" });
    expect(local.json().server.fileActions).toBe(true);
    const remote = await macApp.inject({ method: "GET", url: API_PATHS.state, headers: HEADERS, remoteAddress: "192.168.1.5" });
    expect(remote.json().server.fileActions).toBe(false);
    const post = await macApp.inject({ method: "POST", url: API_PATHS.attachmentAction(ID, "reveal"), headers: HEADERS, remoteAddress: "192.168.1.5" });
    expect(post.statusCode).toBe(501);
    await macApp.close();
  });
});
