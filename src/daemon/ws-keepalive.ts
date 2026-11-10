// 浏览器那条 WebSocket 的保活（本机 /api/ws 和入口转发的 /d/<设备>/api/ws 共用）：
// 手机 VPN、运营商 NAT 会把闲着的连接静默丢掉，两头都不知道。浏览器的 JS 看不到协议层的 ping，
// 所以每 WS_HEARTBEAT_MS 发一条应用层心跳（WS_HEARTBEAT_TEXT），网页（web/connection.ts）太久没收到任何消息就自己重连；
// 同时 ping 一次（浏览器自动回 pong），上一次 ping 没回就断掉这条，不让死连接一直占着监听、前台状态。
// 这是 ws 文档里“检测断掉的连接”的标准做法，加上一条给浏览器看的心跳。
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
