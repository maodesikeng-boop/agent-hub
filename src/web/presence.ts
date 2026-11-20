import { PRESENCE_REPORT_MS, isDeviceId, type PresenceMessage } from "../shared/index.ts";

const DEVICE_PREFIX = /^#\/d\/([^/]+)\//;
const CONVERSATION_ROUTE = /^#\/(?:c|w)\/([1-9]\d*)$/;

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
