import { getEventListeners, once } from "node:events";
import { Agent, createServer } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { agentFetch } from "./agent-fetch.ts";

type DialCallback = (error: Error | null, socket: Socket) => void;

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** A keep-alive agent over a local HTTP server that counts dials; `failDials` makes every dial fail asynchronously. */
async function countingAgent(options: { failDials?: boolean } = {}) {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => res.writeHead(200, { "content-type": "text/plain" }).end("ok"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const dials = { count: 0 };
  class CountingAgent extends Agent {
    override createConnection(_options: unknown, callback?: DialCallback): Socket {
      dials.count += 1;
      if (options.failDials) {
        setImmediate(() => callback?.(new Error("connect ECONNREFUSED"), undefined as unknown as Socket));
        return undefined as unknown as Socket;
      }
      return netConnect(port, "127.0.0.1");
    }
  }
  const agent = new CountingAgent({ keepAlive: true });
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        agent.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { agent, dials };
}

describe("agentFetch", () => {
  it("rejects an already-aborted signal without dialing", async () => {
    const { agent, dials } = await countingAgent();
    const controller = new AbortController();
    const reason = new Error("closed before the call");
    controller.abort(reason);

    const pending = agentFetch(agent, "/ok", { signal: controller.signal });
    const dialsAtCall = dials.count;

    await expect(pending).rejects.toBe(reason);
    expect(dialsAtCall).toBe(0);
    expect(dials.count).toBe(0);
  });

  it("removes its abort listener after a response", async () => {
    const { agent } = await countingAgent();
    const shared = new AbortController();

    for (let i = 0; i < 3; i += 1) {
      // Node drops its own abort listener when the request closes, just before the socket returns to the pool.
      const released = once(agent, "free");
      const res = await agentFetch(agent, "/ok", { signal: shared.signal });
      expect(await res.text()).toBe("ok");
      await released;
    }

    expect(getEventListeners(shared.signal, "abort")).toHaveLength(0);
  });

  it("removes its abort listener after a failed dial", async () => {
    const { agent } = await countingAgent({ failDials: true });
    const shared = new AbortController();

    await expect(agentFetch(agent, "/ok", { signal: shared.signal })).rejects.toThrow("ECONNREFUSED");

    expect(getEventListeners(shared.signal, "abort")).toHaveLength(0);
  });
});
