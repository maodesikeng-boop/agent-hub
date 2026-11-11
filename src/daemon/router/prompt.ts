// 水果刀 Router 轨道 B 系统提示词与跨设备名片格式化模块（docs/router-design.md 第 5.2、5.3、7 节）：
// 集中管理四不准极薄系统提示词与 24 KB 严格上限的跨设备 PM 名片序列化，零单家厂商硬编码。
import {
  AGENT_VENDORS,
  ALL_EFFORTS,
  HUB_COMMAND as HUB,
  PM_MODES,
  PRODUCT_ID,
  PRODUCT_NAME,
  ROUTER_FLEET_DIGEST_MAX_BYTES,
  ROUTER_PERSONA_SUMMARY_MAX_CHARS,
  ROUTER_PM_ACTIVE_WORKERS_MAX,
  VENDOR_LIST,
  isSelectable,
  truncateChars,
  utf8Bytes,
  type AgentVendor,
  type PmMode,
  type VendorAvailabilityMap,
} from "../../shared/index.ts";

// 跨设备总名片 24 KB、名片里活跃 Piece 条数、职责摘要字数这几个上限在 src/shared/limits.ts，这里不另存一份。
/** 单张完整 PM 名片硬上限：1 KB（1_024 UTF-8 字节）。 */
export const ROUTER_PM_CARD_MAX_BYTES = 1_024;
/** 注入上下文的最近指令回执条数上限。 */
export const ROUTER_RECENT_RECEIPTS_CONTEXT = 5;
/** 最近指令回执分节最大字节预算。 */
export const ROUTER_RECEIPTS_SECTION_MAX_BYTES = 600;
/** 状态问答建议的回答篇幅（docs/router-workbench-v2-design.md 第 9.2 节选项 A）；入库上限另见 ROUTER_REPLY_MAX_CHARS。 */
const ROUTER_ANSWER_SUGGESTED_MAX_CHARS = "1,500";

export interface RouterSystemPromptOptions {
  readonly vendorAvailability?: VendorAvailabilityMap;
}

export interface PromptActiveWorker {
  readonly id: number;
  readonly title: string;
  readonly activity: string;
  readonly readonly: boolean;
}

export interface PromptPmDigestCard {
  readonly pmId: number;
  readonly pmName: string;
  readonly mode?: PmMode;
  readonly conversationId?: number;
  readonly activity?: string;
  readonly project: {
    readonly id: number;
    readonly name: string;
    readonly mainFolder?: string;
  } | null;
  readonly roleSummary: string;
  readonly activeWorkers: readonly PromptActiveWorker[];
  readonly activeWorkerTotal: number;
  readonly pendingDecisionCount: number;
}

export interface PromptDeviceDigest {
  readonly deviceId: string;
  readonly deviceName: string;
  readonly platform?: string;
  readonly online: boolean;
  readonly stale?: boolean;
  readonly generatedAt?: number;
  readonly pms: readonly PromptPmDigestCard[];
}

export type PromptReceiptAction =
  | {
      readonly op: "pm.forward";
      readonly deviceId: string;
      readonly deviceName: string;
      readonly pmId: number;
      readonly pmName: string;
      readonly conversationId?: number;
      readonly verbatim: boolean;
    }
  | {
      readonly op: "worker.start";
      readonly deviceId: string;
      readonly deviceName: string;
      readonly projectId: number;
      readonly projectName: string;
      readonly workerId: number;
      readonly workerConversationId?: number;
      readonly title: string;
      readonly readonly: boolean;
    }
  | {
      readonly op: "worker.send" | "worker.stop" | "worker.end";
      readonly deviceId: string;
      readonly deviceName: string;
      readonly workerId: number;
      readonly workerConversationId?: number;
      readonly title: string;
    }
  | {
      readonly op: "project.create";
      readonly deviceId: string;
      readonly deviceName: string;
      readonly pmId: number;
      readonly pmName: string;
      readonly projectId: number;
      readonly projectName: string;
      readonly conversationId?: number;
    };

export interface PromptRecentReceipt {
  readonly id: number;
  readonly text: string;
  readonly status?: string;
  readonly actions: readonly PromptReceiptAction[];
  readonly replyNote?: string;
  readonly createdAt?: number;
}

function selectableVendorsOf(availability: VendorAvailabilityMap = {}): AgentVendor[] {
  const allowed = AGENT_VENDORS.filter((v) => isSelectable(availability[v] ?? "unknown"));
  return allowed.length > 0 ? allowed : [...AGENT_VENDORS];
}

function formatSubagentBanNote(): string {
  const tools = [...new Set(VENDOR_LIST.flatMap((s) => s.prompt.subagentTools))];
  if (tools.length === 0) return "";
  return `严禁调用任何内置子代理工具（如 ${tools.map((t) => `\`${t}\``).join("、")}）。`;
}

/**
 * 构建轨道 B 单轮极薄系统提示词（跑完即焚，严明四不准与 --verbatim 零拷贝规则）。
 */
export function buildRouterSystemPrompt(options: RouterSystemPromptOptions = {}): string {
  const vendors = selectableVendorsOf(options.vendorAvailability);
  const vendorChoices = vendors.join("|");
  const effortChoices = ALL_EFFORTS.join("|");
  const modeChoices = PM_MODES.join("|");
  const subagentBan = formatSubagentBanNote();

  return `# 你的角色

你是 ${PRODUCT_NAME}（${PRODUCT_ID}）的总调度员 Router（水果刀），运行在无历史单轮极速分派模式（轨道 B）下。
当前工作目录是隔离空目录，且处于只读沙箱中。你的职责是根据下方跨设备名片摘要，调用 \`${HUB} dispatch ...\` 把用户指令瞬间投递给目标设备的项目经理（PM）或项目 Piece（Worker）；名片里直接看得出来的全局状态问题可以当场回答（见第 4 条）。

# 四不准硬规矩（必须严守）

1. **不准读任何代码文件**：严禁读取、搜索或列举任何业务代码库、配置文件或目录；凡涉及看代码、查日志、改文件的任务一律派给目标 PM 或启动 Piece。${subagentBan}
2. **不准设计技术方案**：严禁替项目经理分析架构、编写技术方案或自行回答业务实现问题；你只负责判断发给谁、调哪条 \`${HUB} dispatch\` 命令。
3. **不准改写用户原话（单目标一律 \`--verbatim\` 原文零拷贝）**：只要用户当前指令针对**单一目标**（转交单个 PM、新启动单个 Piece、追发单个 Piece），**必须一律传 \`--verbatim\`**，由守护进程从内存字节级原样搬运用户原文与全部附件，严禁用 \`--stdin\` 重写、概括或缩减用户原话！只有当用户一句话里明确包含发往**多个不同目标**的独立事项时，才分别调用命令并用 \`--stdin <<'EOF'\` 按原意拆分投递。
4. **不准寒暄废话，名片内可答**：严禁输出“好的”“收到”“马上处理”等套话。
   - **该分派的必须分派**：凡需要读代码、查日志、写方案、改状态（启动、暂停、结束、追发、新建）的请求，必须调 \`${HUB} dispatch ...\` 分派给对应 PM 或 Piece，分派完直接结束本轮，不另写说明。
   - **名片里看得出来的可以直接答**：只看下方跨设备名片摘要和近期指令回执就能回答的全局状态问题（谁在忙、哪个项目卡在拍板、某项目在哪台设备、某个 PM 上一条汇报说了什么），不分派，直接用结构清晰的 Markdown（按设备或项目分组的小标题、列表、加粗）完整作答，建议不超过 ${ROUTER_ANSWER_SUGGESTED_MAX_CHARS} 字。名片里看不出来的不准猜，按上一条分派给对应 PM 去查。
   - 因信息不足或设备离线无法分派时，用一两句简洁中文直接说明原因。

# 分派决策规则

- **转交已有 PM（默认首选）**：目标项目已有 PM 且任务需拆解、讨论或持续跟进 → \`${HUB} dispatch pm --device <self|deviceId> --pm <pmId> --verbatim\`。
- **直接启动 Piece**：用户明确要求在某项目直接派一个 Piece/Worker 查问题或做独立小任务 → \`${HUB} dispatch worker-start --device <self|deviceId> --project <projectId> --title "<简短标题>" [--readonly] --verbatim\`（只读排查加 \`--readonly\`）。
- **操作已有 Piece**：用户要暂停、继续追发、结束收工或查看已有 Piece（结合名片活跃 Piece 与近期指令回执消解指代） → 调 \`worker-stop\` / \`worker-send\` / \`worker-end\` / \`worker-list\`。
- **新建项目**：用户要求在某台设备新建项目或 PM → 调 \`${HUB} dispatch project-create\`。
- **离线设备拦截**：若目标设备在名片表中标为 \`online: false\`（离线），**不要**对该设备发起远端 \`${HUB} dispatch\` 调用，直接用一句简洁中文告知用户该设备当前离线。

# 系统命令 \`${HUB} dispatch\`

直接在 shell 中执行，**不要**在命令前设置环境变量，**不要**在末尾接 \`echo $?\`：

- \`${HUB} dispatch pm --device <self|deviceId> --pm <pmId> [--verbatim | --stdin]\`
- \`${HUB} dispatch worker-start --device <self|deviceId> --project <projectId> --title <标题> [--vendor <${vendorChoices}>] [--model <模型>] [--effort <${effortChoices}>] [--readonly] [--no-worktree] [--verbatim | --stdin]\`
- \`${HUB} dispatch worker-stop --device <self|deviceId> --worker <workerId>\`
- \`${HUB} dispatch worker-send --device <self|deviceId> --worker <workerId> [--verbatim | --stdin]\`
- \`${HUB} dispatch worker-end --device <self|deviceId> --worker <workerId>\`
- \`${HUB} dispatch worker-list --device <self|deviceId> [--project <projectId>]\`
- \`${HUB} dispatch project-create --device <self|deviceId> --folder <路径> [--name <项目名>] [--pm-name <PM名>] [--vendor <${vendorChoices}>] [--mode ${modeChoices}]\`
`;
}

/** 清洗控制字符与换行，保证外部名字/摘要不会破坏单行结构，并截断至最大字符数。 */
function cleanInline(raw: string | null | undefined, maxChars: number): string {
  if (!raw) return "";
  const singleLine = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return truncateChars(singleLine, maxChars);
}

/** 按 UTF-8 字节上限安全截断字符串（按 Unicode 码点累加，绝不切碎多字节字符）。 */
function sliceUtf8Safe(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (utf8Bytes(text) <= maxBytes) return text;
  const suffix = "…";
  const suffixBytes = utf8Bytes(suffix);
  if (maxBytes <= suffixBytes) return "";
  const budget = maxBytes - suffixBytes;
  let used = 0;
  let out = "";
  for (const ch of text) {
    const chBytes = utf8Bytes(ch);
    if (used + chBytes > budget) break;
    out += ch;
    used += chBytes;
  }
  return `${out}${suffix}`;
}

function formatFullPmCard(deviceId: string, pm: PromptPmDigestCard): string {
  const name = cleanInline(pm.pmName, 40) || `PM-${pm.pmId}`;
  const activity = cleanInline(pm.activity ?? "idle", 24) || "idle";
  const projectText = pm.project
    ? `#${pm.project.id} ${cleanInline(pm.project.name, 60)}${pm.project.mainFolder ? ` (${cleanInline(pm.project.mainFolder, 140)})` : ""}`
    : "无项目";

  const shownWorkers = pm.activeWorkers.slice(0, ROUTER_PM_ACTIVE_WORKERS_MAX);
  const totalWorkers = Math.max(pm.activeWorkerTotal, shownWorkers.length);
  const workerParts = shownWorkers.map((w) => {
    const flags = [w.readonly ? "readonly" : null, cleanInline(w.activity, 20) || null].filter(Boolean).join(", ");
    return `#${w.id}「${cleanInline(w.title, 60)}」${flags ? `[${flags}]` : ""}`;
  });
  if (totalWorkers > shownWorkers.length) {
    workerParts.push(`另有 ${totalWorkers - shownWorkers.length} 个活跃 Piece`);
  }
  const workersLine = workerParts.length > 0 ? workerParts.join("；") : "无";

  const buildWithSummary = (summaryText: string): string => {
    const lines = [
      `### PM #${pm.pmId} ${name} [device=${deviceId} | activity=${activity} | pending=${pm.pendingDecisionCount}]`,
      `- project: ${projectText}`,
    ];
    if (summaryText !== "") lines.push(`- summary: ${summaryText}`);
    lines.push(`- activePieces (${totalWorkers}): ${workersLine}`);
    return lines.join("\n");
  };

  let summary = cleanInline(pm.roleSummary, ROUTER_PERSONA_SUMMARY_MAX_CHARS);
  let card = buildWithSummary(summary);
  if (utf8Bytes(card) > ROUTER_PM_CARD_MAX_BYTES) {
    const withoutSummaryBytes = utf8Bytes(buildWithSummary(""));
    const summaryBudget = Math.max(0, ROUTER_PM_CARD_MAX_BYTES - withoutSummaryBytes - 16);
    summary = summaryBudget > 0 ? sliceUtf8Safe(summary, summaryBudget) : "";
    card = buildWithSummary(summary);
    if (utf8Bytes(card) > ROUTER_PM_CARD_MAX_BYTES) {
      card = sliceUtf8Safe(card, ROUTER_PM_CARD_MAX_BYTES);
    }
  }
  return card;
}

function formatCompactPmLine(deviceId: string, pm: PromptPmDigestCard): string {
  const name = cleanInline(pm.pmName, 40) || `PM-${pm.pmId}`;
  const projectText = pm.project ? `#${pm.project.id} ${cleanInline(pm.project.name, 60)}` : "无";
  const totalWorkers = Math.max(pm.activeWorkerTotal, pm.activeWorkers.length);
  return `- PM #${pm.pmId} ${name} | device=${deviceId} | project=${projectText} | activePieces=${totalWorkers} | pending=${pm.pendingDecisionCount}`;
}

function formatReceiptAction(action: PromptReceiptAction): string {
  switch (action.op) {
    case "pm.forward":
      return `pm.forward(${cleanInline(action.deviceId, 24)}, pm=#${action.pmId} ${cleanInline(action.pmName, 20)}${action.verbatim ? ", verbatim" : ""})`;
    case "worker.start":
      return `worker.start(${cleanInline(action.deviceId, 24)}, project=#${action.projectId}, worker=#${action.workerId}「${cleanInline(action.title, 24)}」)`;
    case "worker.send":
    case "worker.stop":
    case "worker.end":
      return `${action.op}(${cleanInline(action.deviceId, 24)}, worker=#${action.workerId}「${cleanInline(action.title, 24)}」)`;
    case "project.create":
      return `project.create(${cleanInline(action.deviceId, 24)}, pm=#${action.pmId}, project=#${action.projectId} ${cleanInline(action.projectName, 20)})`;
  }
}

function formatReceiptsSection(
  receipts: readonly PromptRecentReceipt[],
  maxBytes: number = ROUTER_RECEIPTS_SECTION_MAX_BYTES,
): string {
  const recent = receipts.slice(0, ROUTER_RECENT_RECEIPTS_CONTEXT);
  if (recent.length === 0 || maxBytes <= 0) return "";
  const header = "## 近期指令回执（仅供指代消解）";
  const headerBytes = utf8Bytes(header);
  if (headerBytes >= maxBytes) return "";
  const perRowMaxBytes = Math.max(64, Math.floor((maxBytes - headerBytes - recent.length) / recent.length));
  const lines: string[] = [header];
  let usedBytes = headerBytes;
  for (const r of recent) {
    const actionsText =
      r.actions.length > 0
        ? r.actions.map(formatReceiptAction).join("; ")
        : cleanInline(r.replyNote ?? r.status ?? "无动作", 36);
    const rawRow = `- #${r.id}「${cleanInline(r.text, 32)}」→ ${actionsText}`;
    const row = sliceUtf8Safe(rawRow, perRowMaxBytes);
    const rowBytes = utf8Bytes(row);
    if (usedBytes + 1 + rowBytes > maxBytes) break;
    lines.push(row);
    usedBytes += 1 + rowBytes;
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

type PmRenderMode = "full" | "compact" | "omitted";

interface IndexedPmSlot {
  readonly deviceIndex: number;
  readonly pmIndex: number;
  readonly priority: number;
  readonly fullText: string;
  readonly fullBytes: number;
  readonly compactText: string;
  readonly compactBytes: number;
  mode: PmRenderMode;
}

/**
 * 计算 PM 保留完整名片的优先级（值越大越优先保留完整名片）：
 * - 3：在线设备且（有活跃 Worker 或有未决项）——最高优，优先完整保留
 * - 2：离线设备但（有活跃 Worker 或有未决项），或在线且正在 working
 * - 1：在线设备的普通空闲 PM
 * - 0：离线设备的普通空闲 PM
 */
function pmPriorityOf(deviceOnline: boolean, pm: PromptPmDigestCard): number {
  const hasActiveOrPending =
    pm.activeWorkerTotal > 0 || pm.activeWorkers.length > 0 || pm.pendingDecisionCount > 0;
  if (hasActiveOrPending && deviceOnline) return 3;
  if (hasActiveOrPending || (deviceOnline && pm.activity === "working")) return 2;
  return deviceOnline ? 1 : 0;
}

/**
 * 将跨设备名片与近期指令回执格式化为轨道 B 上下文文本，严格遵守 24_576 字节（24 KB）总上限：
 * - 预算充足时，全部 PM 展示完整名片；
 * - 超出 24 KB 预算时，按优先级从低到高将空闲无未决项的 PM 自动降级为单行摘要，优先完整保留有活跃 Worker 或未决项的 PM；
 * - 极端超大规模（如数百个 PM）连单行摘要都超限时，用二分裁剪尾部低优空闲项并做 UTF-8 安全兜底，O(N) 极速且绝不超限。
 */
export function formatFleetDigestForPrompt(
  devices: readonly PromptDeviceDigest[],
  recentReceipts: readonly PromptRecentReceipt[] = [],
  maxBytes: number = ROUTER_FLEET_DIGEST_MAX_BYTES,
): string {
  if (devices.length === 0) {
    const receiptsBlock = formatReceiptsSection(recentReceipts, Math.min(ROUTER_RECEIPTS_SECTION_MAX_BYTES, maxBytes));
    const base = "# 跨设备 PM 与项目名片\n\n（当前暂无已配置的设备或项目经理）";
    const combined = receiptsBlock ? `${base}\n\n${receiptsBlock}` : base;
    return sliceUtf8Safe(combined, maxBytes);
  }

  const slots: IndexedPmSlot[] = [];
  const slotsByDevice: IndexedPmSlot[][] = devices.map(() => []);
  const deviceHeaders: string[] = [];

  devices.forEach((device, dIdx) => {
    const devId = cleanInline(device.deviceId, 48) || `device-${dIdx}`;
    const devName = cleanInline(device.deviceName, 48) || devId;
    const flags = [
      `device=${devId}`,
      `online: ${device.online ? "true" : "false"}`,
      ...(device.stale ? ["stale: true"] : []),
      ...(device.platform ? [`platform=${cleanInline(device.platform, 16)}`] : []),
    ].join(", ");
    deviceHeaders.push(`## 设备：${devName} (${flags})`);

    device.pms.forEach((pm, pIdx) => {
      const fullText = formatFullPmCard(devId, pm);
      const compactText = formatCompactPmLine(devId, pm);
      const slot: IndexedPmSlot = {
        deviceIndex: dIdx,
        pmIndex: pIdx,
        priority: pmPriorityOf(device.online, pm),
        fullText,
        fullBytes: utf8Bytes(fullText),
        compactText,
        compactBytes: utf8Bytes(compactText),
        mode: "full",
      };
      slots.push(slot);
      slotsByDevice[dIdx]!.push(slot);
    });
  });

  let receiptsText = formatReceiptsSection(recentReceipts);

  const renderAll = (): string => {
    const sections: string[] = ["# 跨设备 PM 与项目名片"];
    devices.forEach((_device, dIdx) => {
      const header = deviceHeaders[dIdx]!;
      const deviceSlots = slotsByDevice[dIdx]!;
      if (deviceSlots.length === 0) {
        sections.push(`${header}\n（无项目经理）`);
        return;
      }
      const bodyLines: string[] = [];
      let omittedCount = 0;
      for (const slot of deviceSlots) {
        if (slot.mode === "full") {
          bodyLines.push(slot.fullText);
        } else if (slot.mode === "compact") {
          bodyLines.push(slot.compactText);
        } else {
          omittedCount++;
        }
      }
      if (omittedCount > 0) {
        bodyLines.push(`- …另有 ${omittedCount} 个低优空闲 PM 因预算上限已省略`);
      }
      sections.push(`${header}\n${bodyLines.join("\n")}`);
    });
    if (receiptsText !== "") sections.push(receiptsText);
    return sections.join("\n\n");
  };

  let output = renderAll();
  let currentBytes = utf8Bytes(output);
  if (currentBytes <= maxBytes) return output;

  // 按优先级从低到高排序（同优先级下排在后面的先降级，保留排在前面的完整名片）
  const downgradeOrder = [...slots].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.deviceIndex !== b.deviceIndex) return b.deviceIndex - a.deviceIndex;
    return b.pmIndex - a.pmIndex;
  });

  // 第一阶段：O(N) 增量核算字节差值，把低优先级 PM 逐个从 full 降级为单行 compact 摘要
  for (const slot of downgradeOrder) {
    slot.mode = "compact";
    currentBytes -= slot.fullBytes - slot.compactBytes;
    if (currentBytes <= maxBytes) break;
  }

  output = renderAll();
  if (utf8Bytes(output) <= maxBytes) return output;

  // 第二阶段（极端百级 PM 兜底）：若全部单行摘要仍超 24 KB，先省掉近期回执，再用二分查找定位最少省略数
  if (receiptsText !== "") {
    receiptsText = "";
    output = renderAll();
    if (utf8Bytes(output) <= maxBytes) return output;
  }

  let lo = 1;
  let hi = downgradeOrder.length;
  let bestCount = downgradeOrder.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    for (let i = 0; i < downgradeOrder.length; i++) {
      downgradeOrder[i]!.mode = i < mid ? "omitted" : "compact";
    }
    const candidate = renderAll();
    if (utf8Bytes(candidate) <= maxBytes) {
      bestCount = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  for (let i = 0; i < downgradeOrder.length; i++) {
    downgradeOrder[i]!.mode = i < bestCount ? "omitted" : "compact";
  }
  output = renderAll();
  return sliceUtf8Safe(output, maxBytes);
}
