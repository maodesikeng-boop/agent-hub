import {
  AGENT_VENDORS,
  ALL_EFFORTS,
  HUB_COMMAND as HUB,
  PM_MODES,
  PRODUCT_NAME,
  PROJECT_CATALOG_COMPACT_ONE_LINER_CHARS,
  PROJECT_CATALOG_ITEM_MAX_CHARS,
  STDIN_SHELL_NOTE,
  ROUTER_FLEET_DIGEST_MAX_BYTES,
  ROUTER_PM_ACTIVE_WORKERS_MAX,
  ROUTER_PM_BRIEF_MAX_CHARS,
  ROUTER_PM_CARD_MAX_BYTES,
  ROUTER_PROJECT_SHOW_PER_TURN_MAX,
  VENDOR_LIST,
  isSelectable,
  truncateChars,
  utf8Bytes,
  type AgentVendor,
  type PmMode,
  type VendorAvailabilityMap,
} from "../../shared/index.ts";
import { catalogAgeText, type ProjectCatalogCard } from "../../shared/project-catalog.ts";

export const ROUTER_RECENT_RECEIPTS_CONTEXT = 5;
export const ROUTER_RECEIPTS_SECTION_MAX_BYTES = 600;
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
    readonly description?: string | null;
    readonly catalog?: ProjectCatalogCard | null;
  } | null;
  readonly recentBrief?: string | null;
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
  readonly omittedPms?: number;
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

export function buildRouterSystemPrompt(options: RouterSystemPromptOptions = {}): string {
  const vendors = selectableVendorsOf(options.vendorAvailability);
  const vendorChoices = vendors.join("|");
  const effortChoices = ALL_EFFORTS.join("|");
  const modeChoices = PM_MODES.join("|");
  const subagentBan = formatSubagentBanNote();

  return `# 你的角色与工作环境

你是 **${PRODUCT_NAME}**（用户的多设备、多项目本地 Agent 工作台）里的**总助（Router）**。

## 你在哪里工作
${PRODUCT_NAME} 采用三层分工：**总助（你） → 项目经理（PM） → Worker**。
- 用户可能有多台设备，每台设备上有多个项目；每个项目配有一位专属的**项目经理（PM）**，项目经理底下再派 **Worker** 干具体的活。
- 你工作在 ${PRODUCT_NAME} 首页的**全局总助台**，不在任何一个具体项目的目录里（当前是只读的隔离空目录，每次也是单轮独立运行）。
- 在 ${PRODUCT_NAME} 里，你获得了专属的 \`${HUB} dispatch\` 命令行工具。用户找你，是因为不想每次自己去翻找哪台设备、哪个项目经理，而是直接对你说一句话，由你用 \`${HUB} dispatch\` 替他转交，或看着手头的名片替他汇总。

## 你负责干嘛
每次收到用户的输入，你下方都会附有一份实时的「跨设备 PM 与项目名片」。你只做两件事：
1. **替用户把话精准带给对的人**：凡是要干活、查代码、看日志、写方案、改状态（派活、暂停、追发、收工、建项目）的输入，你对照名片找到目标设备和目标项目经理（或 Worker），调 \`${HUB} dispatch ...\` 投递过去。**只要目标项目已有 PM，默认一律转交给 PM**；只有用户点名要直接起 Worker、操作某个在跑的 Worker 或新建项目时，才调其他子命令。
2. **看着名片回答全局状态**：如果用户只是问全局情况（比如现在谁在忙、哪个项目卡在拍板、某项目在哪台设备上），名片里直接看得出来的，不用分派，直接看着名片用清晰的 Markdown 简洁回答（建议不超过 ${ROUTER_ANSWER_SUGGESTED_MAX_CHARS} 字）；名片里看不出来的细节不准猜，转交给对应的项目经理去查。

## 怎么认项目
用户常用口头叫法、产品名或代号指项目，不一定是文件夹名。名片里每个项目有「做什么」「别名」「主线」，是后台按你和项目经理的对话自动整理的项目档案；对照它们认项目。
名片看不准是哪个项目（几个项目都像、档案太旧）或用户问到某个项目的模块、已定的事时，先用 \`${HUB} dispatch project-show\` 展开那个项目的完整档案再判断，一轮最多查 ${ROUTER_PROJECT_SHOW_PER_TURN_MAX} 个。档案里也没有的细节照旧转给项目经理。

# 四条硬规矩

1. **不碰业务文件，不起子代理**：你在全局总助台，严禁读取、搜索任何代码或目录，一切具体查改一律用 \`${HUB} dispatch\` 分派下去。${subagentBan}
2. **不替项目经理出方案**：不分析业务架构、不写技术方案，你只判断这件事归谁管。
3. **传话不走样（单目标一律 \`--verbatim\`）**：只要用户的输入是发给**单一目标**（转给单个 PM、新派单个 Worker、追发单个 Worker），**必须传 \`--verbatim\`**，让系统把用户的原话和附件原封不动搬过去，严禁用 \`--stdin\` 自己重写或缩写。只有当用户一句话里同时交代了发往**多个不同目标**的事，才拆成多条命令，用 \`--stdin\` 按原意分别投递。
4. **不讲客套废话**：严禁回复“好的”“收到”“马上处理”。调完 \`${HUB} dispatch\` 分派成功就直接结束本轮（界面会自动显示投递回执）；因信息不足分不清发给谁，或目标设备在名片里标为 \`online: false\`（离线）时，**不要**对该设备发起 \`${HUB} dispatch\` 调用，直接跟用户用同一种语言、一两句话说明原因。

# 系统命令 \`${HUB} dispatch\`

直接在 shell 里运行，**不要**写环境变量，**不要**接 \`echo $?\`。\`--stdin\` 的正文从标准输入原样传：${STDIN_SHELL_NOTE}\`--device\` 取名片上设备标题里的 \`device=\` 值（本机是 \`self\`），\`pmId\`、\`projectId\`、\`workerId\` 取名片或近期回执里的 \`#编号\`：

- **转交给项目经理（默认首选）**
  \`${HUB} dispatch pm --device <self|deviceId> --pm <pmId> [--verbatim | --stdin]\`
  把用户的消息和附件交给该项目的 PM 分析、拆解或跟进。
- **直接新派一个 Worker**
  \`${HUB} dispatch worker-start --device <self|deviceId> --project <projectId> --title "<简短标题>" [--vendor <${vendorChoices}>] [--model <模型>] [--effort <${effortChoices}>] [--readonly] [--no-worktree] [--verbatim | --stdin]\`
  用户点名绕过 PM 直接起 Worker 查小问题或干独立小活时用。只读排查加 \`--readonly\`；直接在主文件夹干活加 \`--no-worktree\`；用户没指定厂商模型就不传 \`--vendor\`/\`--model\`。
- **给在跑或空闲的 Worker 追发消息**
  \`${HUB} dispatch worker-send --device <self|deviceId> --worker <workerId> [--verbatim | --stdin]\`
  结合名片或近期回执找到目标 Worker，把用户的补充指示发给它接着干。
- **暂停 Worker 当前这一轮**
  \`${HUB} dispatch worker-stop --device <self|deviceId> --worker <workerId>\`
  打断它正在跑的这一轮让它停下来（会话和分支保留，以后还能 \`worker-send\` 继续）。用户说“先停一下”“打断它”时用这条。
- **让 Worker 彻底收工**
  \`${HUB} dispatch worker-end --device <self|deviceId> --worker <workerId>\`
  彻底结束并关掉这个 Worker。用户说“收工”“关掉这个 Worker”时用这条。
- **查看项目的活跃 Worker 完整列表**
  \`${HUB} dispatch worker-list --device <self|deviceId> [--project <projectId>]\`
  名片里活跃 Worker 太多被折叠省略、需要查全量名单时用。
- **展开一个项目的完整档案（只读，不算分派）**
  \`${HUB} dispatch project-show --device <self|deviceId> --project <projectId>\`
  看项目的核心模块、已定的事、悬着的事；名片上写“未建档”的项目没有档案可看。
- **在设备上新建项目和它的项目经理**
  \`${HUB} dispatch project-create --device <self|deviceId> --folder <路径> [--name <项目名>] [--pm-name <PM名>] [--vendor <${vendorChoices}>] [--mode <${modeChoices}>]\`
  把指定文件夹注册成新项目并创建配套 PM（\`--mode\` 默认 \`manage_only\` 只管不写代码，\`hands_on\` 为亲自写代码）。
`;
}

function cleanInline(raw: string | null | undefined, maxChars: number): string {
  if (!raw) return "";
  const singleLine = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return truncateChars(singleLine, maxChars);
}

export function sliceUtf8Safe(text: string, maxBytes: number): string {
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

function catalogLines(deviceId: string, pm: PromptPmDigestCard, nowMs: number, keep: { focus: boolean; aliases: boolean }): string[] {
  const project = pm.project;
  if (project === null) return [];
  const lines: string[] = [];
  const description = cleanInline(project.description, PROJECT_CATALOG_ITEM_MAX_CHARS);
  if (description !== "") lines.push(`- 说明: ${description}（用户写的）`);
  const catalog = project.catalog;
  if (catalog) {
    lines.push(`- 做什么: ${cleanInline(catalog.oneLiner, PROJECT_CATALOG_ITEM_MAX_CHARS)}`);
    if (keep.aliases && catalog.aliases.length > 0) lines.push(`- 别名: ${catalog.aliases.map((a) => cleanInline(a, 40)).join("、")}`);
    const focus = cleanInline(catalog.focus, PROJECT_CATALOG_ITEM_MAX_CHARS);
    if (keep.focus && focus !== "") lines.push(`- 主线: ${focus}`);
  }
  const brief = cleanInline(pm.recentBrief, ROUTER_PM_BRIEF_MAX_CHARS);
  if (brief !== "") lines.push(`- 最近: ${brief}`);
  lines.push(
    catalog
      ? `- 档案: ${catalogAgeText(catalog.refreshedAt, nowMs)}（细节：${HUB} dispatch project-show --device ${deviceId} --project ${project.id}）`
      : "- 档案: 未建档",
  );
  return lines;
}

function formatFullPmCard(deviceId: string, pm: PromptPmDigestCard, nowMs: number): string {
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

  const build = (keep: { focus: boolean; aliases: boolean }): string =>
    [
      `### PM #${pm.pmId} ${name} [device=${deviceId} | activity=${activity} | pending=${pm.pendingDecisionCount}]`,
      `- project: ${projectText}`,
      ...catalogLines(deviceId, pm, nowMs, keep),
      `- activePieces (${totalWorkers}): ${workersLine}`,
    ].join("\n");

  for (const keep of [
    { focus: true, aliases: true },
    { focus: false, aliases: true },
    { focus: false, aliases: false },
  ]) {
    const card = build(keep);
    if (utf8Bytes(card) <= ROUTER_PM_CARD_MAX_BYTES) return card;
  }
  return sliceUtf8Safe(build({ focus: false, aliases: false }), ROUTER_PM_CARD_MAX_BYTES);
}

function formatCompactPmLine(deviceId: string, pm: PromptPmDigestCard): string {
  const name = cleanInline(pm.pmName, 40) || `PM-${pm.pmId}`;
  const projectText = pm.project ? `#${pm.project.id} ${cleanInline(pm.project.name, 60)}` : "无";
  const oneLiner = pm.project?.catalog ? cleanInline(pm.project.catalog.oneLiner, PROJECT_CATALOG_COMPACT_ONE_LINER_CHARS) : "";
  const totalWorkers = Math.max(pm.activeWorkerTotal, pm.activeWorkers.length);
  return `- PM #${pm.pmId} ${name} | device=${deviceId} | project=${projectText}${oneLiner === "" ? "" : ` | 做什么=${oneLiner}`} | activePieces=${totalWorkers} | pending=${pm.pendingDecisionCount}`;
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

function pmPriorityOf(deviceOnline: boolean, pm: PromptPmDigestCard): number {
  const hasActiveOrPending =
    pm.activeWorkerTotal > 0 || pm.activeWorkers.length > 0 || pm.pendingDecisionCount > 0;
  if (hasActiveOrPending && deviceOnline) return 3;
  if (hasActiveOrPending || (deviceOnline && pm.activity === "working")) return 2;
  return deviceOnline ? 1 : 0;
}

export function formatFleetDigestForPrompt(
  devices: readonly PromptDeviceDigest[],
  recentReceipts: readonly PromptRecentReceipt[] = [],
  maxBytes: number = ROUTER_FLEET_DIGEST_MAX_BYTES,
  nowMs: number = Date.now(),
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
      const fullText = formatFullPmCard(devId, pm, nowMs);
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
    devices.forEach((device, dIdx) => {
      const header = deviceHeaders[dIdx]!;
      const deviceSlots = slotsByDevice[dIdx]!;
      if (deviceSlots.length === 0 && !device.omittedPms) {
        sections.push(`${header}\n（无项目经理）`);
        return;
      }
      const bodyLines: string[] = [];
      let omittedCount = device.omittedPms ?? 0;
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

  const downgradeOrder = [...slots].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.deviceIndex !== b.deviceIndex) return b.deviceIndex - a.deviceIndex;
    return b.pmIndex - a.pmIndex;
  });

  for (const slot of downgradeOrder) {
    slot.mode = "compact";
    currentBytes -= slot.fullBytes - slot.compactBytes;
    if (currentBytes <= maxBytes) break;
  }

  output = renderAll();
  if (utf8Bytes(output) <= maxBytes) return output;

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
