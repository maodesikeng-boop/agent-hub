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

export function testLogin(db: Db, port: number) {
  const { token } = createBrowserSessions(db).create({ userAgent: "test", entry: `127.0.0.1:${port}` });
  return { token, cookie: (at: number = port) => `${uiCookieName(`127.0.0.1:${at}`)}=${token}` };
}
