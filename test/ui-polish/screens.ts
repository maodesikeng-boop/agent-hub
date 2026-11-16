// 界面清单（docs/ui-polish-loop-design.md 第 3.1 节）：要截、要评的每一个界面只在这里登记一次。
// 截图命令、评委分批、给用户看的清单都从这一份数据来。
// 不变量：id 全局唯一、以所属区域开头；一个界面在一个视口下出一张图，“一张图”的身份是 `<id>@<视口>`。
import type { ViewportName } from "./limits.ts";

export const SCREEN_AREAS = [
  "shell",
  "sidebar",
  "chat",
  "composer",
  "rail",
  "graph",
  "worker",
  "router",
  "profile",
  "new-pm",
  "settings",
  "m-settings",
  "quota",
] as const;
export type ScreenArea = (typeof SCREEN_AREAS)[number];

/** 给用户看的区域名。 */
export const AREA_TITLES: Record<ScreenArea, string> = {
  shell: "整页状态",
  sidebar: "左栏",
  chat: "项目经理对话",
  composer: "输入框",
  rail: "右栏",
  graph: "任务流图全览",
  worker: "Worker 对话",
  router: "总助",
  profile: "资料页",
  "new-pm": "新建项目经理",
  settings: "设置（电脑）",
  "m-settings": "设置（手机）",
  quota: "额度",
};

export type ScreenState = "normal" | "empty" | "loading" | "error" | "long" | "busy";

/**
 * 种子数据的剧本（seed.ts）：
 * - fresh：刚装好，只有第一次启动自动建的那个项目经理，没有消息；
 * - standard：6 个项目经理、一张带拍板卡的任务图、几个 Worker、总助有待拍板和简报，基准图用它；
 * - stress：超长名字、超长消息、长表格和代码、20 多个项目经理、十几个 Piece、300 条历史；
 * - two-devices：standard 再配一台别的设备（在线、重连中、离线各截）。
 */
export type Scenario = "fresh" | "standard" | "stress" | "two-devices";

export interface ScreenSpec {
  id: string;
  area: ScreenArea;
  /** 给用户看的名字。 */
  title: string;
  viewports: readonly ViewportName[];
  state: ScreenState;
  scenario: Scenario;
  /** 怎么到达：从哪个网址进、点什么、用哪个补丁（patches.ts）。给人看；可执行的步骤在 SCREEN_STEPS。 */
  how: string;
  /** 这一屏要评的局部（浮层、弹窗、卡片）：另外裁一张 2 倍图给评委看细节。不写就只有整屏。 */
  focus?: string;
}

/** 到达一个界面的可执行步骤，由截图命令逐条照做。 */
export type ScreenStep =
  | { goto: string }
  | { click: string }
  | { hover: string }
  | { focus: string }
  | { type: { into: string; text: string } }
  | { press: string }
  | { scroll: { target: string; to: "top" | "bottom" | number } }
  | { drag: { files: readonly string[]; over: string } }
  /** 套一个命名补丁（patches.ts）：真守护进程撑不住的瞬时状态。 */
  | { patch: string }
  /** 预置这台浏览器的 localStorage（已读时间、界面大小、右栏收起）。 */
  | { storage: Record<string, string> }
  /** 等这个选择器出现才往下走。 */
  | { waitFor: string };

const s = (
  id: string,
  title: string,
  viewports: readonly ViewportName[],
  state: ScreenState,
  scenario: Scenario,
  how: string,
  focus?: string,
): ScreenSpec => {
  const area = SCREEN_AREAS.find((a) => id.startsWith(`${a}.`));
  if (area === undefined) throw new Error(`界面 ${id} 的开头不是已登记的区域`);
  return focus === undefined ? { id, area, title, viewports, state, scenario, how } : { id, area, title, viewports, state, scenario, how, focus };
};

const D = ["desktop"] as const;
const M = ["mobile"] as const;
const DM = ["desktop", "mobile"] as const;
const DNM = ["desktop", "narrow", "mobile"] as const;

export const SCREEN_INVENTORY: readonly ScreenSpec[] = [
  s("shell.loading", "整页加载中", DM, "loading", "standard", "打开首页，补丁 state-pending 让 /api/state 不回"),
  s("shell.signed-out", "没登录", DM, "error", "standard", "不带登录 cookie 打开首页"),
  s("shell.load-error", "连不上守护进程", D, "error", "standard", "补丁 state-500，出现 Retry"),
  s("sidebar.normal", "左栏：总助置顶，等你和时间混排", D, "normal", "standard", "#/c/1；已读时间预置成只剩一个没看过", "左栏整列"),
  s("sidebar.fresh", "左栏：只有一个刚建的项目经理", D, "empty", "fresh", "#/router"),
  s("sidebar.search", "左栏：搜索有结果", D, "normal", "standard", "搜索框输入“小”"),
  s("sidebar.search-empty", "左栏：搜索没结果", D, "empty", "standard", "搜索框输入“zzz”"),
  s("sidebar.archived", "左栏：已归档分组展开", D, "normal", "standard", "点开 Archived 组，行右边是 Deletes in 7d"),
  s("sidebar.long", "左栏：超长名字、超长预览、20 多个要滚动", DM, "long", "stress", "#/c/1，列表滚到中间，看上下渐隐"),
  s("sidebar.rail", "左栏：72px 头像窄栏", ["narrow"], "normal", "standard", "#/c/1，窄于 1100px", "头像窄栏"),
  s("sidebar.devices", "左栏：多设备分组，在线、重连中、离线", D, "normal", "two-devices", "#/c/1；第二台依次用补丁 device-reconnecting、device-offline"),
  s("sidebar.list-mobile", "手机列表页", M, "normal", "standard", "首页（网址为空）"),
  s("chat.normal", "对话：三栏，带任务图和拍板卡（基准图候选 A）", DNM, "normal", "standard", "#/c/1；手机从列表点进去"),
  s("chat.empty", "对话：空对话", DM, "empty", "fresh", "#/c/1"),
  s("chat.busy", "对话：在忙，状态词流光和停止键", DM, "busy", "standard", "#/c/1，补丁 session-working"),
  s("chat.streaming", "对话：文字流式生成中", D, "busy", "standard", "#/c/1，补丁 session-streaming"),
  s("chat.worked-open", "对话：Worked for 展开操作明细", D, "normal", "standard", "#/c/1，点 Worked for"),
  s("chat.markdown", "对话：Markdown 全套（标题、列表、表格、引用、代码块、链接）", DM, "long", "stress", "#/c/2，滚到那条长回复"),
  s("chat.charts", "对话：mermaid 和 vega-lite 图表块", D, "normal", "stress", "#/c/2，滚到图表那条"),
  s("chat.chart-zoom", "对话：图表放大窗", D, "normal", "stress", "点图表右上角放大", "放大窗"),
  s("chat.worker-speech", "对话：Worker 汇报气泡，三种状态点", D, "normal", "standard", "#/c/1，滚到汇报那几条"),
  s("chat.ask-answered", "对话：提问卡已回答、已关闭", DM, "normal", "standard", "#/c/3，一张选了选项加备注，一张 Closed"),
  s("chat.user-blocker", "对话：要你动手的提醒卡", D, "normal", "standard", "#/c/4，步骤指定的厂商没登录"),
  s("chat.system-lines", "对话：系统行（换新会话分隔线、定时任务、改性格设定带撤销）", D, "normal", "standard", "#/c/3，滚到系统行那段"),
  s("chat.failed", "对话：没发出去的红色感叹号、处理失败重试", DM, "error", "standard", "#/c/5，一条发送失败、一条处理失败"),
  s("chat.attachments", "对话：上传的文件、内联图片、文件已过期", D, "normal", "standard", "#/c/5，滚到带附件那几条"),
  s("chat.file-preview", "对话：文件预览窗", D, "normal", "standard", "点一个 .md 文件链接", "预览窗"),
  s("chat.scrolled", "对话：往上翻后出现回到底部", D, "normal", "stress", "#/c/2，滚到顶"),
  s("chat.notices", "对话：提示条（重连中、健康问题）", DM, "error", "standard", "#/c/1，补丁 ws-reconnecting、health-driver"),
  s("chat.device-offline", "对话：别的设备离线，输入框不可用", D, "error", "two-devices", "打开第二台的对话，补丁 device-offline"),
  s("chat.archived", "对话：已归档，底部是归档状态条", D, "normal", "standard", "打开已归档的那个项目经理"),
  s("chat.scale-compact", "对话：界面大小 Compact", D, "normal", "standard", "#/c/1，localStorage 预置 agent-hub.uiScale"),
  s("chat.scale-xl", "对话：界面大小 XL", D, "normal", "standard", "#/c/1，localStorage 预置 agent-hub.uiScale"),
  s("composer.focus", "输入框：聚焦光晕", D, "normal", "standard", "#/c/1，点进输入框", "输入框"),
  s("composer.multiline", "输入框：多行、待发文件、Worker 模型标签", DM, "normal", "standard", "输入三行字，加一个文件，选好 /hub:worker", "输入框"),
  s("composer.menu-commands", "输入框：“/” 命令列表", DM, "normal", "standard", "输入 /", "弹出列表"),
  s("composer.menu-files", "输入框：“@” 文件列表", D, "normal", "standard", "输入 @src", "弹出列表"),
  s("composer.menu-worker", "输入框：/hub:worker 选厂商，含没登录的", D, "normal", "standard", "输入 /hub:worker 加空格，补丁 vendors-mixed", "弹出列表"),
  s("composer.menu-empty", "输入框：没有匹配的命令", D, "empty", "standard", "输入 /zzz", "弹出列表"),
  s("composer.blocked", "输入框：发送被拦、上传失败的原因", D, "error", "standard", "补丁 send-rejected 后发送", "输入框和上方的错误"),
  s("composer.drop", "输入框：拖文件进来的虚线框", D, "normal", "standard", "把文件拖到对话区上方", "输入框"),
  s("rail.task-graph", "右栏：果皮轨和拍板卡", D, "normal", "standard", "#/c/1", "右栏整列"),
  s("rail.multi-graph", "右栏：几张活跃图、三股并行、N done 和 N next 折叠", D, "long", "stress", "#/c/1", "右栏整列"),
  s("rail.pieces", "右栏：Pieces 多于 3 条，在忙的流光，Show more", D, "busy", "stress", "#/c/3，补丁 workers-busy", "右栏整列"),
  s("rail.needs-you", "右栏：Needs You 展开一条提问", D, "normal", "standard", "#/c/6，点开第一条", "右栏整列"),
  s("rail.completed", "右栏：Completed 展开，带 Load more", D, "long", "stress", "#/c/1，点开 Completed", "右栏整列"),
  s("rail.collapsed", "右栏：收起，开关上有圆点", D, "normal", "standard", "#/c/1，localStorage 预置收起"),
  s("rail.under-header", "右栏：窗口窄于 720px 时在顶栏下面", ["slim"], "normal", "standard", "#/c/1，点顶栏开关"),
  s("rail.blocker", "右栏：提醒卡 Waiting on you 和 Checking…", D, "busy", "standard", "#/c/4；再套补丁 blocker-checking 截第二态", "右栏整列"),
  s("rail.long", "右栏：超长标题、十几个 Piece", D, "long", "stress", "#/c/3，Show more 展开", "右栏整列"),
  s("rail.drawer-mobile", "手机 Pieces 抽屉", M, "normal", "standard", "聊天页点右上角开关", "抽屉"),
  s("graph.dialog", "任务流图全览：进行中，内联拍板和 Skip step", D, "normal", "standard", "右栏任务标题点 Zoom", "弹窗"),
  s("graph.dialog-history", "任务流图全览：已完成的历史图", D, "normal", "stress", "Completed 里点一张历史图", "弹窗"),
  s("graph.dialog-wide", "任务流图全览：十几步、多层并行、要横向滚动", D, "long", "stress", "打开最大的那张图", "弹窗"),
  s("graph.cancel-confirm", "任务流图：取消的二次确认", D, "normal", "standard", "全览里点 Cancel graph", "确认弹窗"),
  s("worker.normal", "Worker 对话：顶栏右边模型、思考程度、对话长度", DM, "normal", "standard", "#/w/<第一个 Worker>"),
  s("worker.busy", "Worker 对话：在忙", D, "busy", "standard", "同上，补丁 session-working"),
  s("worker.ended", "Worker 对话：已收工", D, "normal", "standard", "从 Completed 点进去"),
  s("router.normal", "总助：待拍板托盘和时间流（基准图候选 B）", DNM, "normal", "standard", "#/router；手机从列表点进去"),
  s("router.empty", "总助：All clear", DM, "empty", "fresh", "#/router"),
  s("router.tray-many", "总助：5 张待拍板、长依据、Show more", DM, "long", "stress", "#/router"),
  s("router.timeline", "总助：指令回合、去向行、连着几条简报、New 分隔线", D, "normal", "stress", "#/router，滚到时间流"),
  s("router.working", "总助：Working…", D, "busy", "standard", "#/router，补丁 router-working"),
  s("router.failed", "总助：处理失败 Retry、没发出去", D, "error", "standard", "#/router，补丁 router-failed"),
  s("router.offline-card", "总助：待拍板卡所属设备离线", D, "error", "two-devices", "#/router，补丁 device-offline"),
  s("router.model-picker", "总助：模型面板，选着 Auto", D, "normal", "standard", "点顶栏右边的模型入口，补丁 vendors-mixed", "浮层"),
  s("router.model-picker-vendor", "总助：模型面板，选了厂商，Model & effort 展开", D, "normal", "standard", "同上，补丁 router-vendor-agy，点开 Model & effort", "浮层"),
  s("router.model-picker-long", "总助：模型面板，超长模型名", D, "long", "standard", "同上，补丁 models-long-names", "浮层"),
  s("router.model-drawer-mobile", "总助：手机模型抽屉", M, "normal", "standard", "手机上点模型入口", "抽屉"),
  s("profile.normal", "资料页：头部、厂商模型、工作方式、文件夹（基准图候选 C）", DM, "normal", "standard", "#/pm/1"),
  s("profile.lower", "资料页：下半（定时任务、性格设定、记忆文件、修改记录、会话）", DM, "normal", "standard", "#/pm/1 滚到底"),
  s("profile.schedule-form", "资料页：新建定时任务表单和校验错误", D, "error", "standard", "点 New，名字填超长", "定时任务那一组"),
  s("profile.memory-open", "资料页：记忆文件展开、编辑中、接近配额的提示", D, "normal", "stress", "点开 Memory files，点一个文件", "记忆文件那一组"),
  s("profile.history", "资料页：修改记录展开", D, "normal", "standard", "点开 History", "修改记录那一组"),
  s("profile.history-empty", "资料页：修改记录是空的", D, "empty", "fresh", "#/pm/1，点开 History", "修改记录那一组"),
  s("profile.new-session-confirm", "资料页：开新会话的确认弹窗", D, "normal", "standard", "点 Start…", "确认弹窗"),
  s("profile.archive-confirm", "资料页：归档的确认弹窗", D, "normal", "standard", "点 Archive…", "确认弹窗"),
  s("profile.archived", "资料页：已归档", D, "normal", "standard", "打开已归档项目经理的资料页"),
  s("profile.vendor-unavailable", "资料页：现在选的厂商没登录", D, "error", "standard", "#/pm/1，补丁 vendors-mixed"),
  s("profile.long", "资料页：超长名字、超长路径、十几个文件夹", D, "long", "stress", "#/pm/1"),
  s("new-pm.default", "新建项目经理：默认", DM, "normal", "standard", "点左栏的加号", "弹窗"),
  s("new-pm.more", "新建项目经理：展开更多设置，中间滚动", D, "normal", "standard", "点 More settings", "弹窗"),
  s("new-pm.invalid", "新建项目经理：名字超长、重名", D, "error", "standard", "名字填 41 个字", "弹窗"),
  s("new-pm.devices", "新建项目经理：多台设备时第一行选设备", D, "normal", "two-devices", "点加号", "弹窗"),
  s("settings.general", "设置：通用（界面大小、通知）", D, "normal", "standard", "点左下角齿轮，General", "弹窗"),
  s("settings.providers", "设置：厂商，各家状态混排", D, "normal", "standard", "Providers，补丁 vendors-mixed", "弹窗"),
  s("settings.providers-busy", "设置：厂商安装中，日志展开", D, "busy", "standard", "补丁 provider-installing，点 Show log", "弹窗"),
  s("settings.providers-sign-in", "设置：厂商登录弹窗（选方式、贴授权码）", D, "normal", "standard", "点 Sign in…，补丁 provider-login-code", "登录弹窗"),
  s("settings.providers-error", "设置：厂商安装或登录失败", D, "error", "standard", "补丁 provider-failed", "弹窗"),
  s("settings.sync-preview", "设置：跨厂商同步的预览弹窗", D, "long", "standard", "Providers 里点 Scan…，补丁 vendor-sync-preview", "预览弹窗"),
  s("settings.computers", "设置：电脑，只有本机", D, "empty", "standard", "Computers", "弹窗"),
  s("settings.computers-multi", "设置：电脑，两台，邀请向导展开", D, "normal", "two-devices", "Computers，点 Invite", "弹窗"),
  s("settings.computers-remove", "设置：移除电脑的确认", D, "normal", "two-devices", "点一台的移除", "确认弹窗"),
  s("settings.security", "设置：登录与安全（手机登录二维码、浏览器和公网入口收着）", D, "normal", "standard", "Security & Access", "弹窗"),
  s("settings.security-open", "设置：已登录的浏览器展开（有待批准），公网入口开着", D, "normal", "standard", "同上，补丁 browsers-pending、public-access-on", "弹窗"),
  s("settings.long", "设置：长域名、长路径不把右栏撑出弹窗", D, "long", "standard", "补丁 public-access-long-domain", "弹窗"),
  s("settings.tabs-top", "设置：窗口窄于 640px 时分类在顶上一排", ["slim"], "normal", "standard", "窄窗口打开设置", "弹窗"),
  s("m-settings.home", "手机设置：一级主页", M, "normal", "standard", "#/settings"),
  s("m-settings.scale", "手机设置：界面大小", M, "normal", "standard", "#/settings/scale"),
  s("m-settings.notifications", "手机设置：通知", M, "normal", "standard", "#/settings/notifications"),
  s("m-settings.providers", "手机设置：厂商", M, "normal", "standard", "#/settings/providers，补丁 vendors-mixed"),
  s("m-settings.vendor-sync", "手机设置：跨厂商同步", M, "long", "standard", "#/settings/vendor-sync，补丁 vendor-sync-preview"),
  s("m-settings.computers", "手机设置：电脑", M, "normal", "two-devices", "#/settings/computers"),
  s("m-settings.sign-in", "手机设置：在其他设备上登录", M, "normal", "standard", "#/settings/sign-in"),
  s("m-settings.browsers", "手机设置：已登录的浏览器，有待批准", M, "normal", "standard", "#/settings/browsers，补丁 browsers-pending"),
  s("m-settings.public-access", "手机设置：公网入口", M, "normal", "standard", "#/settings/public-access"),
  s("m-settings.drawer-confirm", "手机设置：危险操作的确认抽屉", M, "normal", "standard", "浏览器页点 Sign out all browsers…", "抽屉"),
  s("m-settings.drawer-form", "手机设置：短表单抽屉（改名）", M, "normal", "two-devices", "电脑页点改名", "抽屉"),
  s("quota.normal", "额度浮层：两家各两个窗口", D, "normal", "standard", "点左下角额度按钮，补丁 quota-normal", "浮层"),
  s("quota.max", "额度浮层：用满、偏高、Antigravity 两个模型族", D, "long", "standard", "同上，补丁 quota-max", "浮层"),
  s("quota.short-window", "额度浮层：窗口矮时在浮层里滚动", ["slim"], "long", "standard", "同上，补丁 quota-max", "浮层"),
  s("quota.rail", "额度浮层：从 72px 窄栏打开", ["narrow"], "normal", "standard", "窄栏底部点额度按钮，补丁 quota-normal", "浮层"),
];

/**
 * 每个界面的到达步骤。实现时补全：清单里的每个 id 都要有一条。
 * 手机外壳的界面从列表点进去，不直接改网址（试跑时直接改网址停在了列表页）。
 */
export const SCREEN_STEPS: Readonly<Partial<Record<string, readonly ScreenStep[]>>> = {};

/** 一张要截的图：一个界面配一个视口。 */
export interface Shot {
  /** `<界面 id>@<视口>`，也是文件名（不带扩展名）。 */
  key: string;
  screen: ScreenSpec;
  viewport: ViewportName;
}

/**
 * 后置：清单里每个界面按它的每个视口各出一张，顺序同清单；key 不重复。
 * only 给了就只留 id 或区域在里面的界面；写了清单里没有的 id 或区域抛 RangeError。
 */
export function expandShots(inventory: readonly ScreenSpec[], only?: readonly string[]): Shot[] {
  throw new Error("未实现");
}

/**
 * 把图分给评委：同一区域的尽量在一批，每批不超过 batchSize 张，哨兵图平均混进各批。
 * 后置：每张图恰好在一批里；seed 相同分法相同，换 seed 批内顺序不同（两家评委用不同的 seed，抵消先后次序的影响）。
 * batchSize 不是正整数抛 RangeError。
 */
export function batchShots(shots: readonly Shot[], sentinels: readonly Shot[], seed: number, batchSize: number): Shot[][] {
  throw new Error("未实现");
}

/**
 * 把一家评委的各批排成波次：每个波次里两家评委合起来不超过 JUDGE_MAX_CONCURRENT 个 Worker，前一波全部交卷后一波才开工。
 * 后置：返回每个波次里的批次下标（两家用同一套波次）；每批恰好在一个波次里，顺序不变。
 */
export function judgeWaves(batchCount: number, judgeCount: number): number[][] {
  throw new Error("未实现");
}

/** 给用户看的界面清单（Markdown）：按区域分组，每行是名字、视口、状态、怎么到达，最后是界面数和图数。 */
export function inventoryMarkdown(inventory: readonly ScreenSpec[]): string {
  throw new Error("未实现");
}
