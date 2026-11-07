// 测试用：照真浏览器那样登录（GET /auth?token=主钥匙），拿回要放进 cookie 头的 `名字=值`。
import type { FastifyInstance } from "fastify";
import { uiCookieName } from "../../shared/index.ts";
import type { Db } from "../store/index.ts";
import { createBrowserSessions } from "./sessions.ts";

export async function loginCookie(app: FastifyInstance, opts: { token: string; port: number; userAgent?: string }): Promise<string> {
  const res = await app.inject({
    method: "GET",
    url: `/auth?token=${opts.token}`,
    headers: { host: `127.0.0.1:${opts.port}`, ...(opts.userAgent === undefined ? {} : { "user-agent": opts.userAgent }) },
  });
  const setCookie = res.headers["set-cookie"];
  if (res.statusCode !== 302 || typeof setCookie !== "string") throw new Error(`test login failed: ${res.statusCode} ${res.body}`);
  return setCookie.split(";")[0]!;
}

/**
 * 测试用：直接在库里开一个会话（不走 /auth），拿到要放进 cookie 头的值。把同一个 db 传给几个界面服务，它们认同一份会话。
 * cookie(port) 是浏览器用这个端口访问时带的 cookie（名字带端口，见 uiCookieName）。
 */
export function testLogin(db: Db, port: number) {
  const { token } = createBrowserSessions(db).create({ userAgent: "test", entry: `127.0.0.1:${port}` });
  return { token, cookie: (at: number = port) => `${uiCookieName(`127.0.0.1:${at}`)}=${token}` };
}
