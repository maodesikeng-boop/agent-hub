// 端到端测试用的假 GitHub：设备码登录（立刻授权）和 GET /user。守护进程和自建中继都指到它，不连真的 GitHub。
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

export interface FakeGithub {
  origin: string;
  close(): Promise<void>;
}

/** 后置：所有设备码都立刻授权成 users[token] 的那个用户（默认 alice）；GET /user 认 Bearer token。 */
export async function startFakeGithub(users: Record<string, { id: number; login: string }> = { tok_alice: { id: 1, login: "alice" } }, token = "tok_alice"): Promise<FakeGithub> {
  const server: Server = createServer((req, res) => {
    const reply = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.method === "POST" && req.url === "/login/device/code") {
      return reply(200, { device_code: randomBytes(8).toString("hex"), user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 0 });
    }
    if (req.method === "POST" && req.url === "/login/oauth/access_token") return reply(200, { access_token: token, token_type: "bearer", scope: "" });
    if (req.method === "GET" && req.url === "/user") {
      const user = users[(req.headers.authorization ?? "").replace("Bearer ", "")];
      return user === undefined ? reply(401, { message: "Bad credentials" }) : reply(200, user);
    }
    reply(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
