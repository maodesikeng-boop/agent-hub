// 前台上报（联机 P4，shared/api.ts 的 PresenceMessage）：网页在入口那条 WebSocket 上报“在不在前台、正看着哪个对话”，
// 一开始报一次，之后每 PRESENCE_REPORT_MS 一次，切前台 / 后台、换对话时马上报。守护进程据此不推（网页自己提醒）。
import { PRESENCE_REPORT_MS, isDeviceId, type PresenceMessage } from "../shared/index.ts";

/** 网址里别的设备的前缀 #/d/<设备编号>/（route.ts）。 */
const DEVICE_PREFIX = /^#\/d\/([^/]+)\//;
/** 对话、Worker 对话的网址。资料页不算在看对话。 */
const CONVERSATION_ROUTE = /^#\/(?:c|w)\/([1-9]\d*)$/;

/** 网页在前台：标签页看得见，并且窗口有焦点（和 notify.ts 的口径一样）。 */
function isForeground(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

export function presenceMessage(): PresenceMessage {
  const hash = window.location.hash;
  const device = DEVICE_PREFIX.exec(hash);
  const deviceId = device !== null && isDeviceId(device[1]!) ? device[1]! : null;
  const conversation = CONVERSATION_ROUTE.exec(device === null ? hash : `#/${hash.slice(device[0].length)}`);
  const id = conversation === null ? null : Number(conversation[1]);
  return { type: "presence", visible: isForeground(), deviceId, conversationId: id !== null && Number.isSafeInteger(id) ? id : null };
}

/** 开始上报，返回停止函数。 */
export function startPresence(send: (message: PresenceMessage) => void): () => void {
  const report = () => send(presenceMessage());
  report();
  const timer = setInterval(report, PRESENCE_REPORT_MS);
  window.addEventListener("focus", report);
  window.addEventListener("blur", report);
  window.addEventListener("hashchange", report);
  window.addEventListener("popstate", report);
  document.addEventListener("visibilitychange", report);
  return () => {
    clearInterval(timer);
    window.removeEventListener("focus", report);
    window.removeEventListener("blur", report);
    window.removeEventListener("hashchange", report);
    window.removeEventListener("popstate", report);
    document.removeEventListener("visibilitychange", report);
  };
}
