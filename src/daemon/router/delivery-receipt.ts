import { ROUTER_PROJECT_SHOW_MAX_BYTES, type RouterCommandDispatchedTarget } from "../../shared/index.ts";
import { renderCatalogDetail } from "../../shared/project-catalog.ts";
import { sliceUtf8Safe } from "./prompt.ts";
import type { RouterTargetOpResult, RouterTargetPort } from "./target-port.ts";

export function toDispatchedTarget(
  port: RouterTargetPort,
  result: RouterTargetOpResult,
  verbatim?: boolean,
): RouterCommandDispatchedTarget | null {
  switch (result.kind) {
    case "pm.forward":
      return {
        deviceId: port.deviceId,
        deviceName: port.deviceName,
        pmId: result.pmId,
        pmName: result.pmName,
        projectId: result.projectId,
        projectName: result.projectName,
        conversationId: result.conversationId,
        messageId: result.messageId,
        ok: true,
        op: "pm.forward",
        ...(verbatim !== undefined ? { verbatim } : {}),
      };
    case "worker.start":
      return {
        deviceId: port.deviceId,
        deviceName: port.deviceName,
        pmId: result.pmId,
        pmName: result.pmName,
        projectId: result.projectId,
        projectName: result.projectName,
        workerId: result.workerId,
        workerConversationId: result.workerConversationId,
        title: result.title,
        readonly: result.readonly,
        messageId: result.pmMessageId,
        ok: true,
        op: "worker.start",
        ...(verbatim !== undefined ? { verbatim } : {}),
      };
    case "worker.send":
      return {
        deviceId: port.deviceId,
        deviceName: port.deviceName,
        pmId: result.pmId,
        workerId: result.workerId,
        workerConversationId: result.workerConversationId,
        title: result.title,
        messageId: result.messageId,
        ok: true,
        op: "worker.send",
        ...(verbatim !== undefined ? { verbatim } : {}),
      };
    case "worker.stop":
      return {
        deviceId: port.deviceId,
        deviceName: port.deviceName,
        pmId: result.pmId,
        workerId: result.workerId,
        workerConversationId: result.workerConversationId,
        title: result.title,
        messageId: 0,
        ok: true,
        op: "worker.stop",
      };
    case "worker.end":
      return {
        deviceId: port.deviceId,
        deviceName: port.deviceName,
        pmId: result.pmId,
        workerId: result.workerId,
        workerConversationId: result.workerConversationId,
        title: result.title,
        messageId: 0,
        ok: true,
        op: "worker.end",
      };
    case "project.create":
      return {
        deviceId: port.deviceId,
        deviceName: port.deviceName,
        pmId: result.pmId,
        pmName: result.pmName,
        projectId: result.projectId,
        projectName: result.projectName,
        conversationId: result.conversationId,
        messageId: 0,
        ok: true,
        op: "project.create",
      };
    case "worker.list":
    case "project.show":
      return null;
  }
}

export function formatOpReceiptText(port: RouterTargetPort, result: RouterTargetOpResult): string {
  const devLabel = port.isLocal ? `本机（${port.deviceName}）` : `设备「${port.deviceName}」`;
  switch (result.kind) {
    case "pm.forward":
      return `已投递给${devLabel} PM #${result.pmId}「${result.pmName}」${result.projectName ? `（项目：${result.projectName}）` : ""}`;
    case "worker.start":
      return `已在${devLabel}项目「${result.projectName}」启动${result.readonly ? "只读 " : ""}Piece #${result.workerId}「${result.title}」`;
    case "worker.send":
      return `已向${devLabel} Piece #${result.workerId}「${result.title}」追发消息`;
    case "worker.stop":
      return `已请求暂停${devLabel} Piece #${result.workerId}「${result.title}」`;
    case "worker.end":
      return `已结束收工${devLabel} Piece #${result.workerId}「${result.title}」`;
    case "project.create":
      return `已在${devLabel}创建项目 #${result.projectId}「${result.projectName}」（PM #${result.pmId}「${result.pmName}」）`;
    case "project.show":
      return result.detail === null
        ? `${devLabel}的项目 #${result.projectId} 还没有档案（未建档、不存在或已归档）。名片看不出来的细节转给它的项目经理`
        : sliceUtf8Safe(`${devLabel}的项目档案：\n\n${renderCatalogDetail(result.detail, Date.now())}`, ROUTER_PROJECT_SHOW_MAX_BYTES);
    case "worker.list": {
      if (result.workers.length === 0) return `${devLabel}当前没有 Piece 记录`;
      const lines = result.workers.map(
        (w) =>
          `- #${w.id}「${w.title}」[project=#${w.projectId}, status=${w.status}, activity=${w.activity}${w.readonly ? ", readonly" : ""}]`,
      );
      return `${devLabel} Piece 列表：\n${lines.join("\n")}`;
    }
  }
}
