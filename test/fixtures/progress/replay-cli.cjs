const { readFileSync, appendFileSync } = require("node:fs");
const { createInterface } = require("node:readline");

const { frames, nextFrames, vendor, launchEnv } = JSON.parse(readFileSync(process.env.PROGRESS_REPLAY, "utf8"));
const log = (entry) => appendFileSync(process.env.PROGRESS_LOG, JSON.stringify(entry) + "\n");
log({ argv: process.argv.slice(2), env: Object.fromEntries(launchEnv.map((name) => [name, process.env[name]])) });

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
let turn = 0;
const currentFrames = () => turn > 0 && nextFrames !== undefined ? nextFrames : frames;
const replay = () => {
  currentFrames().filter((frame) => frame.method || frame.type || frame.event).forEach(send);
  turn++;
};
const acpId = frames.find((frame) => frame.method === "session/update")?.params?.sessionId;
const codexTurn = frames.find((frame) => frame.method === "turn/started")?.params;
const reply = (msg, result) => send({ jsonrpc: "2.0", id: msg.id, result });

if (vendor === "claude") send({ type: "system", subtype: "init", tools: [] });

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (vendor === "claude") {
    if (msg.type === "user") replay();
    return;
  }
  if (vendor === "pi") {
    if (!msg.id) return;
    send({ type: "response", id: msg.id, command: msg.type, success: true, data: {} });
    if (msg.type === "prompt") {
      replay();
      send({ type: "agent_settled", aborted: false });
    }
    return;
  }
  if (vendor === "codex") {
    if (msg.method === "thread/start") reply(msg, { thread: { id: codexTurn.threadId } });
    else if (msg.method === "turn/start") {
      reply(msg, { turn: currentFrames().find((frame) => frame.method === "turn/started").params.turn });
      replay();
    } else if (msg.id !== undefined) reply(msg, {});
    return;
  }
  if (!msg.method) {
    log({ reply: msg });
    return;
  }
  switch (msg.method) {
    case "initialize":
      reply(msg, { protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
      break;
    case "session/new":
      reply(msg, { sessionId: acpId });
      break;
    case "session/prompt":
      replay();
      reply(msg, { stopReason: "end_turn" });
      break;
    default:
      if (msg.id !== undefined) reply(msg, {});
  }
});
