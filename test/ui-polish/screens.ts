// 界面清单（docs/ui-polish-loop-design.md 第 3.1 节）：要截、要评的每一个界面只在这里登记一次。
// 截图命令、评委分批、给用户看的清单都从这一份数据来。
// 不变量：id 全局唯一、以所属区域开头；一个界面在一个视口下出一张图，“一张图”的身份是 `<id>@<视口>`。
import { JUDGE_MAX_CONCURRENT, type ViewportName } from "./limits.ts";

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
 * - stress：超长名字、超长消息、长表格和代码、20 多个项目经理、十几个 Worker、300 条历史；
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
  /** 打开网址的 # 部分；`{c.lin}` 这样的占位换成种子里的编号（seed.ts 的 SeedResult.ids）。 */
  | { goto: string }
  | { click: string }
  | { clickIfPresent: string }
  | { hover: string }
  | { focus: string }
  | { type: { into: string; text: string } }
  | { press: string }
  | { scroll: { target: string; to: "top" | "bottom" | number } }
  | { drag: { files: readonly string[]; over: string; drop?: boolean } }
  /** 套一个命名补丁（patches.ts）：真守护进程撑不住的瞬时状态。 */
  | { patch: string }
  /** 预置这台浏览器的 localStorage（已读时间、界面大小、右栏收起）。 */
  | { storage: Record<string, string> }
  /** 等这个选择器出现才往下走。 */
  | { waitFor: string }
  /** 把浏览器钉住的时间拨到“固定时间 + 这么多毫秒”（界面按时间差判断的状态，比如断线满 30 秒才算离线）；之后要有一次重画才看得到。 */
  | { clock: number }
  /** 局部图裁哪个元素（清单里写了 focus 的界面才用）。 */
  | { crop: string }
  /** 清掉登录 cookie 再刷新（“没登录”那一屏）。 */
  | { signOut: true };

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
  s("shell.stack", "窄窗：右侧面板覆盖对话的堆叠档，点返回到工作面板", ["slim"], "normal", "standard", "#/c/1，slim 视口打开 Worker，进入 stack 档"),
  s("shell.work-closed", "右栏关闭：对话顶栏保留工作面板开关按钮", D, "normal", "standard", "#/c/1，localStorage 预置右侧面板关闭"),
  s("shell.resize-min", "拖宽下限：左栏与右侧面板宽度低于下限被夹紧", D, "normal", "standard", "#/c/1，localStorage 预置低于下限的宽度"),
  s("shell.resize-max", "拖宽上限：左栏宽度超出上限被夹紧到 25rem", D, "normal", "standard", "#/c/1，localStorage 预置超过上限的宽度（右侧关）"),
  s("sidebar.normal", "左栏：置顶分组、排序、等你和时间混排", D, "normal", "standard", "#/c/1；已读时间预置成只剩一个没看过", "左栏整列"),
  s("sidebar.fresh", "左栏：只有一个刚建的项目经理", D, "empty", "fresh", "点开本机列表"),
  s("sidebar.search", "左栏：搜索有结果", D, "normal", "standard", "搜索框输入“小”"),
  s("sidebar.search-empty", "左栏：搜索没结果", D, "empty", "standard", "搜索框输入“zzz”"),
  s("sidebar.archived", "左栏：已归档分组展开", D, "normal", "standard", "点开 Archived 组，行右边是 Deletes in 7d"),
  s("sidebar.long", "左栏：超长名字、超长预览、20 多个要滚动", DM, "long", "stress", "#/c/1，列表滚到中间，看上下渐隐"),
  s("sidebar.strip", "左栏：72px 头像窄条（置顶在上），带右侧面板", ["narrow"], "normal", "standard", "#/c/1，narrow 视口下收成 72px 头像条", "头像窄条"),
  s("sidebar.devices", "左栏：多台电脑最左栏与离线状态", D, "normal", "two-devices", "#/c/1；最左栏展示多台电脑及状态"),
  s("sidebar.row-hover", "左栏：行悬停显示置顶快捷键", D, "normal", "standard", "鼠标悬停在老马一行上", "悬停行"),
  s("sidebar.switcher", "左栏：切换电脑浮层（电脑）与抽屉（手机）", DM, "normal", "two-devices", "点左栏顶部 Studio Mac 切换器", "切换浮层"),
  s("sidebar.list-mobile", "手机列表页", M, "normal", "standard", "首页（网址为空）"),
  s("chat.normal", "对话：四栏主界面（含最左栏与置顶）", DNM, "normal", "standard", "#/c/1；手机从列表点进去"),
  s("chat.empty", "对话：空对话", DM, "empty", "fresh", "#/c/1"),
  s("chat.busy", "对话：在忙，状态词流光和停止键", DM, "busy", "standard", "#/c/1，补丁 session-working"),
  s("chat.streaming", "对话：文字流式生成中", D, "busy", "standard", "#/c/1，补丁 session-streaming"),
  s("chat.worked-open", "对话：Worked for 展开操作明细", D, "normal", "standard", "#/c/1，点 Worked for"),
  s("chat.markdown", "对话：Markdown 全套（标题、列表、表格、引用、代码块、链接）", DM, "long", "stress", "#/c/2，滚到那条长回复"),
  s("chat.charts", "对话：mermaid 和 vega-lite 图表块", D, "normal", "stress", "#/c/2，滚到图表那条"),
  s("chat.chart-zoom", "对话：图表放大窗", D, "normal", "stress", "点图表右上角放大", "放大窗"),
  s("chat.thread-cards", "对话：Worker 汇报行（Done 绿点、Problem 黄点）", D, "normal", "standard", "#/c/1，滚到汇报那几条"),
  s("chat.ask-answered", "对话：提问卡已回答、已关闭", DM, "normal", "standard", "#/c/3，一张选了选项加备注，一张 Closed"),
  s("chat.decision-files", "对话：拍板卡完整正文、文件与截图嵌在相关文字旁、醒目回复框", DM, "normal", "standard", "#/c/6，柚子的带文件与截图拍板卡"),
  s("chat.user-blocker", "对话：要你动手的提醒卡", D, "normal", "standard", "#/c/4，步骤指定的厂商没登录"),
  s("chat.system-lines", "对话：系统行（换新会话分隔线、定时任务、改性格设定带撤销）", D, "normal", "standard", "#/c/3，滚到系统行那段"),
  s("chat.failed", "对话：没发出去的红色感叹号、处理失败重试", DM, "error", "standard", "#/c/5，一条发送失败、一条处理失败"),
  s("chat.attachments", "对话：上传的文件、内联图片、文件已过期", D, "normal", "standard", "#/c/5，滚到带附件那几条"),
  s("chat.file-preview", "对话：文件预览窗", D, "normal", "standard", "点一个 .md 文件链接", "预览窗"),
  s("chat.scrolled", "对话：往上翻后出现回到底部", D, "normal", "stress", "#/c/2，滚到顶"),
  s("chat.notices", "对话：提示条（重连中、健康问题）", DM, "error", "standard", "#/c/1，补丁 ws-reconnecting、health-driver"),
  s("chat.device-offline", "对话：别的设备离线，输入框不可用", D, "error", "two-devices", "点最左栏 Tokyo Mini，补丁 device-offline"),
  s("chat.archived", "对话：已归档，底部是归档状态条", D, "normal", "standard", "打开已归档的那个项目经理"),
  s("chat.scale-compact", "对话：界面大小 Compact", D, "normal", "standard", "#/c/1，localStorage 预置 agent-hub.uiScale"),
  s("chat.scale-xl", "对话：界面大小 XL", D, "normal", "standard", "#/c/1，localStorage 预置 agent-hub.uiScale"),
  s("composer.focus", "输入框：聚焦框", D, "normal", "standard", "#/c/1，点进输入框", "输入框"),
  s("composer.multiline", "输入框：多行、待发文件、Worker 模型标签", DM, "normal", "standard", "输入三行字，加一个文件，选好 /hub:worker", "输入框"),
  s("composer.menu-commands", "输入框：“/” 命令列表", DM, "normal", "standard", "输入 /", "弹出列表"),
  s("composer.menu-files", "输入框：“@” 文件列表", D, "normal", "standard", "输入 @src", "弹出列表"),
  s("composer.menu-worker", "输入框：/hub:worker 选厂商，含没登录的", D, "normal", "standard", "输入 /hub:worker 加空格，补丁 vendors-mixed", "弹出列表"),
  s("composer.menu-empty", "输入框：没有匹配的命令", D, "empty", "standard", "输入 /zzz", "弹出列表"),
  s("composer.blocked", "输入框：发送被拦、上传失败的原因", D, "error", "standard", "补丁 send-rejected 后发送", "输入框和上方的错误"),
  s("composer.drop", "输入框：拖文件进来的虚线框", D, "normal", "standard", "把文件拖到对话区上方", "输入框"),
  s("rail.task-graph", "右栏 Active：任务图画布与独立 Workers", D, "normal", "standard", "#/c/1", "右栏整列"),
  s("rail.multi-graph", "右栏 Active：多张活跃图同时跑、并行分叉与窄时竖排", D, "long", "stress", "#/c/1", "右栏整列"),
  s("rail.workers", "右栏 Active：独立 Workers 列表（运行中）", D, "busy", "stress", "#/c/3，补丁 workers-busy", "右栏整列"),
  s("rail.empty", "右栏 Active：空态", D, "empty", "fresh", "#/c/1 打开工作面板", "右栏整列"),
  s("rail.completed", "右栏 Completed：按天分组与展开步骤", D, "long", "stress", "#/c/3，切到 Completed 并展开一张图", "右栏整列"),
  s("rail.blocker", "右栏 Active：要你动手的步骤是一行，提醒卡在对话里 Checking…", D, "busy", "standard", "#/c/4；再套补丁 blocker-checking 截第二态", "右栏整列"),
  s("rail.long", "右栏 Active：超长标题与十几个 Worker", D, "long", "stress", "#/c/3", "右栏整列"),
  s("rail.page-mobile", "手机整页工作面板（Active/Completed/Info 页签）", M, "normal", "standard", "聊天页点右上角工作面板按钮", "工作面板"),
  s("graph.dialog", "任务流图全览：进行中，新画布、内联拍板和 Skip step", D, "normal", "standard", "右栏任务标题点 Expand", "弹窗"),
  s("graph.dialog-wide", "任务流图全览：十几步、多层并行、横向画布滚动", D, "long", "stress", "打开最大的那张图", "弹窗"),
  s("graph.cancel-confirm", "任务流图：取消的二次确认", D, "normal", "standard", "全览里点 Cancel graph", "确认弹窗"),
  s("worker.normal", "Worker 详情：右侧面板（电脑）与全屏页（手机）", DM, "normal", "standard", "#/w/<第一个 Worker>"),
  s("worker.busy", "Worker 详情：在忙", D, "busy", "standard", "同上，补丁 session-working"),
  s("worker.menu", "Worker 详情：⋯ 菜单展开", D, "normal", "standard", "打开 Worker 后点顶栏 ⋯", "菜单浮层"),
  s("worker.ended", "Worker 详情：已收工", D, "normal", "standard", "从 Completed 或线程卡点进去"),
  s("router.normal", "总助：待拍板托盘和时间流（铺满整页）", DNM, "normal", "standard", "#/router；手机从底栏点进去"),
  s("router.decision-files", "总助：带文件与截图的拍板卡展开", D, "normal", "standard", "#/router，点开柚子的带文件拍板卡"),
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
  s("profile.normal", "Info 页：无框头像、名称与两段列表", DM, "normal", "standard", "#/pm/1"),
  s("profile.lower", "Info 页：头像悬停铅笔与底部操作", D, "normal", "standard", "#/pm/1 悬停头像"),
  s("profile.capabilities", "Info 子页：Capabilities 钻取页", DM, "normal", "standard", "#/pm/1 点 Capabilities"),
  s("profile.schedule-form", "Info 子页：新建定时任务表单和校验错误", D, "error", "standard", "点 Schedules 再点 New，名字填超长", "定时任务子页"),
  s("profile.memory-open", "Info 子页：记忆文件钻取子页与编辑态", D, "normal", "stress", "补丁 memory-files，点开 Memory files，点一个文件的编辑", "记忆文件子页"),
  s("profile.history", "Info 子页：修改记录钻取子页", D, "normal", "standard", "点开 History", "修改记录子页"),
  s("profile.history-empty", "Info 子页：修改记录是空的", D, "empty", "fresh", "#/pm/1，点开 History", "修改记录子页"),
  s("profile.new-session-confirm", "Info 页：开新会话的确认弹窗", D, "normal", "standard", "点 New session", "确认弹窗"),
  s("profile.archive-confirm", "Info 页：归档的确认弹窗", D, "normal", "standard", "点 Archive", "确认弹窗"),
  s("profile.archived", "Info 页：已归档", D, "normal", "standard", "打开已归档项目经理的 Info 页"),
  s("profile.vendor-unavailable", "Info 子页：Model 页里现在选的厂商没登录", D, "error", "standard", "老马的 Info 点进 Model（用 DeepSeek），补丁 vendors-mixed"),
  s("profile.long", "Info 页：超长名字与超长文件夹", D, "long", "stress", "#/pm/1"),
  s("new-pm.default", "新建项目经理：默认", DM, "normal", "standard", "点左栏的加号", "弹窗"),
  s("new-pm.more", "新建项目经理：展开更多设置，中间滚动", D, "normal", "standard", "点 More settings", "弹窗"),
  s("new-pm.select-open", "新建项目经理：自建下拉菜单展开（电脑与手机）", DM, "normal", "standard", "点 More settings 后点开 Model 下拉", "展开的下拉列表"),
  s("new-pm.invalid", "新建项目经理：名字超长", D, "error", "standard", "名字填 41 个字；一行只报一个原因，重名另算", "弹窗"),
  s("new-pm.devices", "新建项目经理：多台设备时第一行选设备", D, "normal", "two-devices", "点加号", "弹窗"),
  s("settings.general", "设置：通用（界面大小、通知）", D, "normal", "standard", "点最左栏底部齿轮，General", "弹窗"),
  s("settings.providers", "设置：厂商，各家状态混排", D, "normal", "standard", "Providers，补丁 vendors-mixed", "弹窗"),
  s("settings.providers-busy", "设置：厂商安装中，日志展开", D, "busy", "standard", "补丁 provider-installing，点 Show log", "弹窗"),
  s("settings.providers-sign-in", "设置：厂商登录弹窗（选方式、贴授权码）", D, "normal", "standard", "点 Sign in…，补丁 provider-login-code", "登录弹窗"),
  s("settings.providers-error", "设置：厂商安装或登录失败", D, "error", "standard", "补丁 provider-failed", "弹窗"),
  s("settings.sync-preview", "设置：跨厂商同步的预览弹窗", D, "long", "standard", "Providers 里点 Scan…，补丁 vendor-sync-preview", "预览弹窗"),
  s("settings.capabilities", "设置：能力权限页", D, "normal", "standard", "Capabilities", "弹窗"),
  s("settings.resources", "设置：资源与存储页（含待确认、概览与明细）", D, "normal", "standard", "Resources，补丁 resources-attention", "弹窗"),
  s("settings.computers", "设置：电脑，只有本机", D, "empty", "standard", "Computers", "弹窗"),
  s("settings.computers-multi", "设置：账号已登录，两台电脑与核对请求、中心顺序", D, "normal", "two-devices", "Computers，补丁 account-approvals", "弹窗"),
  s("settings.computers-remove", "设置：移除电脑的确认", D, "normal", "two-devices", "点一台的移除", "确认弹窗"),
  s("settings.security", "设置：登录与安全（登录二维码、浏览器会话收着）", D, "normal", "standard", "Security & Access", "弹窗"),
  s("settings.security-open", "设置：已登录的浏览器展开", D, "normal", "standard", "同上，补丁 browsers-multi，点 Signed-in browsers", "弹窗"),
  s("settings.long", "设置：自定义超长中继网址不把右栏撑出弹窗", D, "long", "standard", "Computers，点 Relay…，输入长网址", "弹窗"),
  s("settings.tabs-top", "设置：窗口窄于 720px 时分类在顶上一排", ["slim"], "normal", "standard", "窄窗口打开设置", "弹窗"),
  s("m-settings.home", "手机设置：一级主页（顶部含额度概览）", M, "normal", "standard", "#/settings"),
  s("m-settings.scale", "手机设置：界面大小", M, "normal", "standard", "#/settings/scale"),
  s("m-settings.notifications", "手机设置：通知", M, "normal", "standard", "#/settings/notifications"),
  s("m-settings.providers", "手机设置：厂商", M, "normal", "standard", "#/settings/providers，补丁 vendors-mixed"),
  s("m-settings.vendor-sync", "手机设置：跨厂商同步", M, "long", "standard", "#/settings/vendor-sync，补丁 vendor-sync-preview"),
  s("m-settings.capabilities", "手机设置：能力权限", M, "normal", "standard", "#/settings/capabilities"),
  s("m-settings.resources", "手机设置：资源与存储", M, "normal", "standard", "#/settings/resources，补丁 resources-attention"),
  s("m-settings.computers", "手机设置：电脑", M, "normal", "two-devices", "#/settings/computers"),
  s("m-settings.sign-in", "手机设置：在其他设备上登录", M, "normal", "standard", "#/settings/sign-in"),
  s("m-settings.browsers", "手机设置：已登录的浏览器", M, "normal", "standard", "#/settings/browsers，补丁 browsers-multi"),
  s("m-settings.drawer-confirm", "手机设置：危险操作的确认抽屉", M, "normal", "standard", "浏览器页点 Sign out all browsers…", "抽屉"),
  s("m-settings.drawer-form", "手机设置：短表单抽屉（改名）", M, "normal", "two-devices", "电脑页点改名", "抽屉"),
  s("quota.normal", "额度浮层：只列当前登录账号的那一家，两个窗口", D, "normal", "standard", "点最左栏额度沙漏，补丁 quota-normal", "浮层"),
  s("quota.max", "额度浮层：用满、偏高、Antigravity 两个模型族", D, "long", "standard", "同上，补丁 quota-max", "浮层"),
  s("quota.short-window", "额度浮层：窗口矮时在浮层里滚动", ["slim"], "long", "standard", "同上，补丁 quota-max", "浮层"),
  s("quota.rail", "额度浮层：在窄屏打开", ["narrow"], "normal", "standard", "点最左栏额度沙漏，补丁 quota-normal", "浮层"),
];

const APP_RAIL = 'role=navigation[name="Workspace"]';
const LIST = 'role=region[name="Studio Mac"]';
const PM_LIST = 'role=region[name="Project managers"]';
const RAIL = 'role=complementary[name="Work panel"]';
const LOG = 'role=log[name="Messages"]';
const ROUTER_LOG = 'role=log[name="Router timeline"]';
const COMPOSER = 'role=textbox[name="Message"]';
const DIALOG = "role=dialog";
const POPOVER = "[data-radix-popper-content-wrapper]";
/** 叠在别的弹窗上的那一个（确认、登录、同步预览）。 */
const TOP_DIALOG = "role=dialog >> nth=-1";
/** 输入框上方弹出的列表，没有匹配时是一行“No matching …”。 */
const MENU = 'div:has(> ul[role="listbox"]), div:has(> p:text-matches("^No matching"))';
/** 按名字认按钮：名字是整段里的一个词就算（左栏的行名前后还跟着状态和预览，窄栏里状态在前）。 */
const btn = (name: string, within?: string) => `${within === undefined ? "" : `${within} >> `}role=button[name=/(?:^| )${name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?: |$)/]`;
const ensureList: ScreenStep[] = [
  { waitFor: 'nav[aria-label="Workspace"] button:has([data-testid="rail-device-dot-local"]), section[aria-label="Studio Mac"]' },
  { clickIfPresent: 'nav[aria-label="Workspace"] button:has([data-testid="rail-device-dot-local"])' },
  { waitFor: LIST },
];
const pmRow = (name: string) => `section[aria-label="Studio Mac"] :is(button:has([title="${name}"]), button[title="${name}"])`;
/** 从左栏点进一个项目经理的对话（桌面先点最左栏本机进入列表，手机直接从列表点）。 */
const openPm = (name: string): ScreenStep[] => [...ensureList, { click: pmRow(name) }, { waitFor: LOG }];
const waitCharts: ScreenStep[] = [{ waitFor: ".vega-embed canvas, .vega-embed svg" }, { waitFor: 'svg[id^="chart-mermaid-"]' }];
const stickBottom: ScreenStep = { scroll: { target: LOG, to: "bottom" } };
const openRouter: ScreenStep[] = [{ waitFor: 'role=button[name=/^Router/]' }, { click: 'role=button[name=/^Router/]' }, { waitFor: ROUTER_LOG }];
const profileScope = (name: string) => `[aria-label="${name}'s settings"]`;
const openProfile = (name: string): ScreenStep[] => [...openPm(name), { click: `role=button[name="View ${name}'s profile"]` }, { waitFor: profileScope(name) }];
const openSettings = (tab?: string): ScreenStep[] => [{ waitFor: APP_RAIL }, { click: btn("Settings", APP_RAIL) }, { waitFor: DIALOG }, ...(tab === undefined ? [] : [{ click: `role=tab[name="${tab}"]` }])];
/** 手机设置：底部 TabBar 点 Settings，再点一行。 */
const openMobileSettings = (row?: string): ScreenStep[] => [{ click: btn("Settings") }, { waitFor: 'role=heading[name="Settings"]' }, ...(row === undefined ? [] : [{ click: btn(row, "role=main") }])];
const openQuota = (patch: string): ScreenStep[] => [{ patch }, { waitFor: APP_RAIL }, { click: `role=button[name=/usage/i]` }, { crop: 'role=dialog[name="Usage"]' }];
/** 断线满 30 秒（src/web/devices.ts 的 OFFLINE_AFTER_MS）才从“重连中”变“离线”：截图的时间是钉住的，要拨过去。 */
const PAST_OFFLINE: ScreenStep = { clock: 31_000 };
const typeInComposer = (text: string): ScreenStep => ({ type: { into: COMPOSER, text } });
const storage = (items: Record<string, string>): ScreenStep => ({ storage: items });

/**
 * 每个界面的到达步骤。清单里的每个 id 都要有一条。
 * 手机外壳的界面从列表点进去，不直接改网址（直接改网址其实也到得了，统一点进去更像真人用法）。
 */
export const SCREEN_STEPS: Readonly<Partial<Record<string, readonly ScreenStep[]>>> = {
  "shell.loading": [{ patch: "state-pending" }, { waitFor: "text=Loading…" }],
  "shell.signed-out": [{ signOut: true }],
  "shell.load-error": [{ patch: "state-500" }, { waitFor: btn("Retry") }],
  "shell.stack": [...ensureList, { waitFor: RAIL }, { click: btn("Close work panel", RAIL) }, { click: `${LOG} >> button:has-text("排查只读 Worker 超时")` }, { waitFor: 'role=button[name="Back to 小林"]' }],
  "shell.work-closed": [storage({ "agent-hub.rightRail": "closed" }), ...openPm("小林")],
  "shell.resize-min": [storage({ "agent-hub.paneWidths": '{"list":5,"panel":5}' }), ...openPm("小林")],
  "shell.resize-max": [storage({ "agent-hub.rightRail": "closed", "agent-hub.paneWidths": '{"list":99,"panel":99}' }), ...openPm("小林")],
  "sidebar.normal": [...openPm("小林"), { crop: LIST }],
  "sidebar.fresh": ensureList,
  "sidebar.search": [...ensureList, { type: { into: 'role=searchbox[name="Search conversations"]', text: "小" } }],
  "sidebar.search-empty": [...ensureList, { type: { into: 'role=searchbox[name="Search conversations"]', text: "zzz" } }],
  "sidebar.archived": [...ensureList, { click: `${LIST} >> role=button[name=/^Archived/]` }, { waitFor: `${LIST} >> text=旧博客` }],
  "sidebar.long": [...ensureList, { scroll: { target: `${LIST} >> .page-fade`, to: 600 } }],
  "sidebar.strip": [...openPm("小林"), { crop: LIST }],
  "sidebar.devices": [...openPm("小林"), { waitFor: `${APP_RAIL} >> role=button[name=/^Tokyo Mini/]` }],
  "sidebar.row-hover": [...openPm("小林"), { hover: `${LIST} >> .project-row:has([title="老马"])` }, { crop: `${LIST} >> .project-row:has([title="老马"])` }],
  "sidebar.switcher": [
    ...ensureList,
    { waitFor: 'role=button[name="Switch computer (Studio Mac)"]' },
    { click: 'role=button[name="Switch computer (Studio Mac)"]' },
    { waitFor: 'role=list[name="Linked computers"]' },
    { crop: '[role="dialog"]:has([aria-label="Linked computers"]), [data-radix-popper-content-wrapper]:has([aria-label="Linked computers"])' },
  ],
  "sidebar.list-mobile": [{ waitFor: PM_LIST }],
  "chat.normal": openPm("小林"),
  "chat.empty": openPm("项目经理"),
  "chat.busy": [{ patch: "session-working" }, ...openPm("小林"), { waitFor: btn("Stop") }],
  "chat.streaming": [{ patch: "session-streaming" }, ...openPm("小林"), { waitFor: "text=所以后面几次" }],
  "chat.worked-open": [...openPm("小林"), { click: btn("Worked for", LOG) }],
  "chat.markdown": [...openPm("文档整理"), ...waitCharts, { waitFor: "text=1.5 发布说明" }, stickBottom],
  "chat.charts": [...openPm("文档整理"), ...waitCharts, stickBottom],
  "chat.chart-zoom": [...openPm("文档整理"), ...waitCharts, { click: btn("Zoom", LOG) }, { crop: DIALOG }],
  "chat.thread-cards": [...openPm("小林"), { waitFor: `${LOG} >> role=button[name*="MCP 首次握手超过 30 秒"]` }],
  "chat.ask-answered": openPm("阿青"),
  "chat.decision-files": [...openPm("柚子"), { waitFor: "text=回归核对清单" }],
  "chat.user-blocker": [...openPm("小周"), { waitFor: "text=Antigravity 没登录" }],
  "chat.system-lines": [...openPm("阿青"), { waitFor: "text=Handed off to a new session" }],
  "chat.failed": [...openPm("Momo"), { waitFor: "text=Translate the weekly draft into Japanese" }, { waitFor: "text=Post the summary to the team channel" }],
  "chat.attachments": [...openPm("Momo"), { waitFor: "text=dashboard.png" }],
  "chat.file-preview": [...openPm("Momo"), { click: `${LOG} >> text=metrics-2026-46.csv` }, { crop: DIALOG }],
  "chat.scrolled": [...openPm("文档整理"), ...waitCharts, { scroll: { target: LOG, to: "top" } }, { waitFor: btn("Scroll to bottom") }],
  "chat.notices": [{ patch: "ws-reconnecting" }, { patch: "health-driver" }, ...openPm("小林"), { waitFor: "text=找不到 Claude" }, { waitFor: "text=Reconnecting…" }],
  "chat.device-offline": [
    { patch: "device-offline" },
    { waitFor: `${APP_RAIL} >> role=button[name*="reconnecting"]` },
    PAST_OFFLINE,
    { waitFor: `${APP_RAIL} >> role=button[name*="Tokyo Mini"][name*="offline"]` },
    { click: `${APP_RAIL} >> role=button[name*="Tokyo Mini"]` },
    { waitFor: "text=Showing content from" },
  ],
  "chat.archived": [...ensureList, { click: `${LIST} >> role=button[name=/^Archived/]` }, { click: pmRow("旧博客") }, { waitFor: LOG }],
  "chat.scale-compact": [storage({ "agent-hub.uiScale": "sm" }), ...openPm("小林")],
  "chat.scale-xl": [storage({ "agent-hub.uiScale": "xl" }), ...openPm("小林")],
  "composer.focus": [...openPm("小林"), { focus: COMPOSER }, stickBottom, { crop: "[data-multiline]" }],
  "composer.multiline": [
    ...openPm("小林"),
    typeInComposer("/hub:worker "),
    { press: "Enter" },
    { press: "Enter" },
    { press: "Enter" },
    { drag: { files: ["notes.md"], over: "[aria-label='Messages']", drop: true } },
    typeInComposer("第一行：先看超时日志"),
    { press: "Shift+Enter" },
    typeInComposer("第二行：再看缓存"),
    { press: "Shift+Enter" },
    typeInComposer("第三行：最后补测试"),
    stickBottom,
    { crop: "[data-multiline]" },
  ],
  "composer.menu-commands": [...openPm("小林"), typeInComposer("/"), stickBottom, { crop: MENU }],
  "composer.menu-files": [...openPm("小林"), typeInComposer("@src"), stickBottom, { crop: MENU }],
  "composer.menu-worker": [{ patch: "vendors-mixed" }, ...openPm("小林"), typeInComposer("/hub:worker "), { waitFor: `${MENU} >> text=Add provider…` }, stickBottom, { crop: MENU }],
  "composer.menu-empty": [...openPm("小林"), typeInComposer("/zzz"), stickBottom, { crop: MENU }],
  "composer.blocked": [{ patch: "send-rejected" }, ...openPm("小林"), typeInComposer("/clear"), { press: "Enter" }, { waitFor: "role=alert" }, stickBottom, { crop: "[data-multiline]" }],
  "composer.drop": [...openPm("小林"), { drag: { files: ["notes.md", "screenshot.png"], over: "[aria-label='Messages']" } }, { crop: "[data-multiline]" }],
  "rail.task-graph": [...openPm("小林"), { crop: RAIL }],
  "rail.multi-graph": [...openPm("小林"), { crop: RAIL }],
  "rail.workers": [{ patch: "workers-busy" }, ...openPm("阿青"), { crop: RAIL }],
  "rail.empty": [...openPm("项目经理"), { click: 'role=button[name="Show work panel"]' }, { waitFor: `${RAIL} >> text=Nothing running` }, { crop: RAIL }],
  "rail.completed": [...openPm("阿青"), { click: `${RAIL} >> role=tab[name^="Completed"]` }, { waitFor: `${RAIL} >> role=button[name=/上周的发布/]` }, { click: `${RAIL} >> role=button[name=/上周的发布/]` }, { crop: RAIL }],
  "rail.blocker": [{ patch: "blocker-checking" }, ...openPm("小周"), { click: btn("Done", LOG) }, { waitFor: "text=Checking…" }, { crop: RAIL }],
  "rail.long": [...openPm("阿青"), { crop: RAIL }],
  "rail.page-mobile": [...openPm("小林"), { click: 'role=button[name=/Show work panel/]' }, { waitFor: RAIL }, { crop: RAIL }],
  "graph.dialog": [...openPm("小林"), { click: `${RAIL} >> role=button[name^="Expand "] >> nth=0` }, { crop: DIALOG }],
  "graph.dialog-wide": [...openPm("小林"), { click: `${RAIL} >> role=button[name^="Expand "] >> nth=1` }, { crop: DIALOG }],
  "graph.cancel-confirm": [...openPm("小林"), { click: `${RAIL} >> role=button[name^="Expand "] >> nth=0` }, { click: btn("Cancel graph", DIALOG) }, { crop: TOP_DIALOG }],
  "worker.normal": [...openPm("小林"), { click: `${LOG} >> button:has-text("排查只读 Worker 超时")` }, { waitFor: "text=只读排查：为什么只读 Worker 偶发超时" }],
  "worker.busy": [{ patch: "session-working" }, ...openPm("小林"), { click: `${LOG} >> button:has-text("排查只读 Worker 超时")` }, { waitFor: btn("Stop") }],
  "worker.menu": [...openPm("小林"), { click: `${LOG} >> button:has-text("排查只读 Worker 超时")` }, { click: 'role=button[name="More worker actions"]' }, { crop: POPOVER }],
  "worker.ended": [...openPm("小林"), { click: `${LOG} >> button:has-text("按厂商配置换会话阈值")` }, { waitFor: "text=把 AUTO_RENEW_CONTEXT_TOKENS 改成按厂商配置" }],
  "router.normal": openRouter,
  "router.decision-files": [...openRouter, { click: 'role=main >> button:has-text("证书续期要不要改成自动")' }, { waitFor: 'role=main >> text=续期方案' }],
  "router.empty": openRouter,
  "router.tray-many": [...openRouter, { click: btn("Show more", "role=main") }],
  "router.timeline": [...openRouter, { scroll: { target: ROUTER_LOG, to: "bottom" } }],
  "router.working": [{ patch: "router-working" }, ...openRouter, { waitFor: "text=Working…" }],
  "router.failed": [{ patch: "router-failed" }, ...openRouter, { waitFor: btn("Retry", ROUTER_LOG) }],
  "router.offline-card": [
    { patch: "device-offline" },
    { waitFor: `${APP_RAIL} >> role=button[name*="reconnecting"]` },
    PAST_OFFLINE,
    ...openRouter,
    { waitFor: `${APP_RAIL} >> role=button[name*="Tokyo Mini"][name*="offline"]` },
    { click: 'role=main >> button:has-text("夜间构建要不要挪到凌晨 3 点")' },
    { waitFor: "role=main >> text=Offline" },
  ],
  "router.model-picker": [{ patch: "vendors-mixed" }, ...openRouter, { click: 'role=button[name^="Router model"]' }, { crop: POPOVER }],
  "router.model-picker-vendor": [{ patch: "router-vendor-agy" }, ...openRouter, { click: 'role=button[name^="Router model"]' }, { click: `${POPOVER} >> text=Model & effort` }, { crop: POPOVER }],
  "router.model-picker-long": [{ patch: "models-long-names" }, ...openRouter, { click: 'role=button[name^="Router model"]' }, { crop: POPOVER }],
  "router.model-drawer-mobile": [{ patch: "vendors-mixed" }, ...openRouter, { click: 'role=button[name^="Router model"]' }, { crop: DIALOG }],
  "profile.normal": openProfile("小林"),
  "profile.lower": [...openProfile("小林"), { hover: `${profileScope("小林")} >> role=button[name="Change look"]` }],
  "profile.capabilities": [...openProfile("小林"), { click: `${profileScope("小林")} >> role=button[name^="Capabilities"]` }, { waitFor: 'role=button[name="Back to Info"]' }],
  // 名字要超过 40 个字（MAX_SCHEDULE_NAME_CHARS）才会出校验提示
  "profile.schedule-form": [...openProfile("阿青"), { click: `${profileScope("阿青")} >> role=button[name^="Schedules"]` }, { click: btn("New", 'role=region[name="Schedules"]') }, { type: { into: 'role=region[name="Schedules"] >> role=textbox >> nth=0', text: "一个特别特别长的定时任务名字用来测试表单校验会不会提示太长了再长一点再长一点再长一点" } }, { crop: 'role=region[name="Schedules"]' }],
  "profile.memory-open": [{ patch: "memory-files" }, ...openProfile("小林"), { click: `${profileScope("小林")} >> role=button[name^="Memory files"]` }, { click: 'role=button[name="Edit conventions.md"]' }, { waitFor: 'role=region[name="Memory files"] >> role=textbox' }, { crop: 'role=region[name="Memory files"]' }],
  "profile.history": [...openProfile("阿青"), { click: 'role=button[name^="History"]' }, { crop: 'role=region[name="History"]' }],
  "profile.history-empty": [...openProfile("项目经理"), { click: 'role=button[name^="History"]' }, { crop: 'role=region[name="History"]' }],
  "profile.new-session-confirm": [...openProfile("小林"), { click: 'role=button[name="New session"]' }, { crop: TOP_DIALOG }],
  "profile.archive-confirm": [...openProfile("小林"), { click: 'role=button[name="Archive"]' }, { crop: TOP_DIALOG }],
  "profile.archived": [...ensureList, { click: `${LIST} >> role=button[name=/^Archived/]` }, { click: pmRow("旧博客") }, { waitFor: LOG }, { click: `role=button[name="View 旧博客's profile"]` }, { waitFor: profileScope("旧博客") }],
  "profile.vendor-unavailable": [{ patch: "vendors-mixed" }, ...openProfile("老马"), { click: `${profileScope("老马")} >> role=button[name^="Model"]` }, { waitFor: 'role=button[name="Back to Info"]' }],
  "profile.long": openProfile("一个名字特别特别长的项目经理用来测试左栏和顶栏会不会被撑开"),
  "new-pm.default": [...ensureList, { click: btn("New project manager", LIST) }, { crop: DIALOG }],
  "new-pm.more": [...ensureList, { click: btn("New project manager", LIST) }, { click: btn("More settings", DIALOG) }, { crop: DIALOG }],
  "new-pm.select-open": [
    ...ensureList,
    { click: btn("New project manager", LIST) },
    { click: btn("More settings", DIALOG) },
    { click: 'role=combobox[name="Model"]' },
    { waitFor: "role=listbox" },
    { crop: '[data-slot="select-content"]' },
  ],
  "new-pm.invalid": [...ensureList, { click: btn("New project manager", LIST) }, { type: { into: `${DIALOG} >> role=textbox >> nth=0`, text: "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一" } }, { crop: DIALOG }],
  "new-pm.devices": [...ensureList, { click: btn("New project manager", LIST) }, { crop: DIALOG }],
  "settings.general": [...openSettings("General"), { crop: DIALOG }],
  "settings.providers": [{ patch: "vendors-mixed" }, ...openSettings("Providers"), { crop: DIALOG }],
  "settings.providers-busy": [{ patch: "provider-installing" }, ...openSettings("Providers"), { waitFor: "text=Installing package…" }, { click: `${DIALOG} >> role=button[name^="Show log"]` }, { crop: DIALOG }],
  "settings.providers-sign-in": [{ patch: "provider-login-code" }, ...openSettings("Providers"), { click: `${DIALOG} >> role=button >> text=Sign in…` }, { crop: TOP_DIALOG }],
  "settings.providers-error": [{ patch: "provider-failed" }, ...openSettings("Providers"), { crop: DIALOG }],
  "settings.sync-preview": [{ patch: "vendor-sync-preview" }, { patch: "vendors-mixed" }, ...openSettings("Providers"), { waitFor: `${DIALOG} >> text=Sign in…` }, { click: btn("Scan…", DIALOG) }, { crop: TOP_DIALOG }],
  "settings.capabilities": [...openSettings("Capabilities"), { waitFor: `${DIALOG} >> role=searchbox[name="Search capabilities"]` }, { crop: DIALOG }],
  "settings.resources": [{ patch: "resources-attention" }, ...openSettings("Resources"), { waitFor: `${DIALOG} >> text=#42 Fix auth flow` }, { crop: DIALOG }],
  "settings.computers": [...openSettings("Computers"), { crop: DIALOG }],
  "settings.computers-multi": [{ patch: "account-approvals" }, ...openSettings("Computers"), { waitFor: `${DIALOG} >> text=042 917` }, { crop: DIALOG }],
  "settings.computers-remove": [...openSettings("Computers"), { waitFor: `${DIALOG} >> text=Hub order` }, { click: `${DIALOG} >> role=button[name^="Remove"]` }, { crop: TOP_DIALOG }],
  "settings.security": [...openSettings("Security & Access"), { crop: DIALOG }],
  "settings.security-open": [{ patch: "browsers-multi" }, ...openSettings("Security & Access"), { click: `${DIALOG} >> role=button[name^="Signed-in browsers"]` }, { crop: DIALOG }],
  "settings.long": [
    { patch: "account-long-name" },
    ...openSettings("Computers"),
    { click: btn("Relay…", DIALOG) },
    { type: { into: `${DIALOG} >> role=textbox[name="Relay URL"]`, text: "https://relay-server-with-an-unusually-long-subdomain-name.organization-internal-network.example.com" } },
    { crop: DIALOG },
  ],
  "settings.tabs-top": [...openSettings("General"), { crop: DIALOG }],
  "m-settings.home": openMobileSettings(),
  "m-settings.scale": openMobileSettings("Interface scale"),
  "m-settings.notifications": openMobileSettings("Notifications"),
  "m-settings.providers": [{ patch: "vendors-mixed" }, ...openMobileSettings("Providers")],
  "m-settings.vendor-sync": [{ patch: "vendor-sync-preview" }, { patch: "vendors-mixed" }, ...openMobileSettings("Vendor sync")],
  "m-settings.capabilities": [...openMobileSettings("Capabilities"), { waitFor: 'role=searchbox[name="Search capabilities"]' }],
  "m-settings.resources": [{ patch: "resources-attention" }, ...openMobileSettings("Resources"), { waitFor: "text=#42 Fix auth flow" }],
  "m-settings.computers": openMobileSettings("Computers"),
  "m-settings.sign-in": openMobileSettings("Sign in on another device"),
  "m-settings.browsers": [{ patch: "browsers-multi" }, ...openMobileSettings("Signed-in browsers")],
  "m-settings.drawer-confirm": [...openMobileSettings("Signed-in browsers"), { click: btn("Sign out all browsers…") }, { crop: DIALOG }],
  "m-settings.drawer-form": [...openMobileSettings("Computers"), { click: "role=main >> text=Tokyo Mini" }, { click: "text=Rename…" }, { crop: DIALOG }],
  "quota.normal": openQuota("quota-normal"),
  "quota.max": openQuota("quota-max"),
  "quota.short-window": openQuota("quota-max"),
  "quota.rail": openQuota("quota-normal"),
};

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
  if (only !== undefined) {
    const unknown = only.filter((name) => !inventory.some((spec) => spec.id === name || spec.area === name));
    if (unknown.length > 0) throw new RangeError(`清单里没有这些界面或区域：${unknown.join("、")}`);
  }
  const picked = only === undefined ? inventory : inventory.filter((spec) => only.includes(spec.id) || only.includes(spec.area));
  const shots = picked.flatMap((screen) => screen.viewports.map((viewport) => ({ key: `${screen.id}@${viewport}`, screen, viewport })));
  const keys = new Set(shots.map((shot) => shot.key));
  if (keys.size !== shots.length) throw new Error("清单里有重复的界面 id");
  return shots;
}

/**
 * 把图分给评委：同一区域的尽量在一批，每批不超过 batchSize 张，哨兵图平均混进各批。
 * 后置：每张图恰好在一批里；批数够时，哨兵图不和同一界面同一视口的图在一批；
 * seed 相同分法相同，换 seed 批内顺序不同（两家评委用不同的 seed，抵消先后次序的影响）。
 * batchSize 不是正整数抛 RangeError。
 */
export function batchShots<T extends Pick<Shot, "screen" | "viewport">>(shots: readonly T[], sentinels: readonly T[], seed: number, batchSize: number): T[][] {
  if (!Number.isInteger(batchSize) || batchSize <= 0) throw new RangeError(`批大小 ${batchSize} 不是正整数`);
  const total = shots.length + sentinels.length;
  if (total === 0) return [];
  const count = Math.ceil(total / batchSize);
  const batches: T[][] = Array.from({ length: count }, () => []);
  sentinels.forEach((shot, i) => batches[count - 1 - (i % count)]!.push(shot));
  const same = (a: T, b: T) => a.screen.id === b.screen.id && a.viewport === b.viewport;
  for (const shot of shots) {
    const open = batches.filter((b) => b.length < batchSize);
    (open.find((b) => !b.some((other) => same(other, shot))) ?? open[0]!).push(shot);
  }
  const random = mulberry32(seed);
  return batches.map((batch) => shuffle(batch, random));
}

/** 按 seed 打乱，同样的 seed 同样的顺序。 */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  return shuffle(items, mulberry32(seed));
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * 把一家评委的各批排成波次：每个波次里两家评委合起来不超过 JUDGE_MAX_CONCURRENT 个 Worker，前一波全部交卷后一波才开工。
 * 后置：返回每个波次里的批次下标（两家用同一套波次）；每批恰好在一个波次里，顺序不变。
 */
export function judgeWaves(batchCount: number, judgeCount: number): number[][] {
  if (!Number.isInteger(batchCount) || batchCount < 0) throw new RangeError(`批数 ${batchCount} 不对`);
  if (!Number.isInteger(judgeCount) || judgeCount <= 0 || judgeCount > JUDGE_MAX_CONCURRENT) throw new RangeError(`评委数 ${judgeCount} 不对`);
  const perWave = Math.floor(JUDGE_MAX_CONCURRENT / judgeCount);
  const waves: number[][] = [];
  for (let i = 0; i < batchCount; i += perWave) waves.push(Array.from({ length: Math.min(perWave, batchCount - i) }, (_, k) => i + k));
  return waves;
}

const STATE_TITLES: Record<ScreenState, string> = { normal: "正常", empty: "空", loading: "加载中", error: "出错", long: "超长", busy: "在忙" };

/** 给用户看的界面清单（Markdown）：按区域分组，每行是名字、视口、状态、怎么到达，最后是界面数和图数。 */
export function inventoryMarkdown(inventory: readonly ScreenSpec[]): string {
  const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");
  const lines = ["# 界面清单", ""];
  for (const area of SCREEN_AREAS) {
    const specs = inventory.filter((spec) => spec.area === area);
    if (specs.length === 0) continue;
    lines.push(`## ${AREA_TITLES[area]}`, "", "| 界面 | 视口 | 状态 | 怎么到达 |", "| --- | --- | --- | --- |");
    for (const spec of specs) lines.push(`| ${cell(spec.title)}（\`${spec.id}\`） | ${spec.viewports.join("、")} | ${STATE_TITLES[spec.state]} | ${cell(spec.how)} |`);
    lines.push("");
  }
  const shots = inventory.reduce((n, spec) => n + spec.viewports.length, 0);
  lines.push(`合计：${inventory.length} 个界面，${shots} 张图。`);
  return `${lines.join("\n")}\n`;
}
