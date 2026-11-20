import { WebSocket } from "ws";
import { WS_HEARTBEAT_MS, WS_HEARTBEAT_TEXT } from "../shared/index.ts";

export function keepAlive(socket: WebSocket, intervalMs: number = WS_HEARTBEAT_MS): void {
  let alive = true;
  socket.on("pong", () => {
    alive = true;
  });
  const timer = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (!alive) {
      socket.terminate();
      return;
    }
    alive = false;
    socket.ping();
    socket.send(WS_HEARTBEAT_TEXT);
  }, intervalMs);
  timer.unref();
  socket.once("close", () => clearInterval(timer));
}
