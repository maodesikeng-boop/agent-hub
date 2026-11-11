// 各块共用的数字和名字，定在这里免得各写各的。只有一家厂商用的可调数在那家文件夹的 limits.ts（src/vendors/<厂商>/limits.ts）。

/** 一次返回多少条消息（/api/state 里每个对话、/messages?before= 每页）。 */
export const MESSAGE_PAGE_SIZE = 100;
/**
 * 初始快照（/api/state）里项目经理对话、在跑的 Worker 对话带最近几条；更早的往上翻再拉（/messages?before=）。
 * 往前带到最近一条要算的消息为止（没回答的提问、没处理完的、最近一条非安静的，见 shared/snapshot.ts），最多 MESSAGE_PAGE_SIZE 条。
 */
export const SNAPSHOT_RECENT_MESSAGES = 20;
/** 初始快照按“跑了一个月”（300 个已收工的 Worker、3 万条消息）算的上限（未压缩，守卫见 daemon/ledger/snapshot-size.test.ts）。 */
export const SNAPSHOT_MONTH_MAX_BYTES = 384 * 1024;

/** git 没跑成时，回给项目经理的原因行最多几个字（ledger/workers.ts 的 gitReasonLine）。 */
export const GIT_REASON_MAX_CHARS = 200;
/** 一次 git 调用最多等多久（毫秒）；超了就 SIGKILL 掉 git。调用时可以用 timeoutMs 改。 */
export const GIT_TIMEOUT_MS = 30_000;
/** git 输出最多收多少字节（status 遇到大量没跟踪的文件会很长）。 */
export const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
/** gh 输出最多收多少字节（hub worker show 查 PR 用）。 */
export const GH_MAX_BUFFER_BYTES = 1024 * 1024;

// ---- hub worker show / log（ledger/steps.ts、ledger/worker-view.ts）----
/** 每个会话在 session_steps 里最多留多少条（一轮结束时把更老的删掉）。 */
export const SESSION_STEPS_KEEP = 1_000;
/** hub worker log 默认看最近几步、最多几步。 */
export const WORKER_LOG_DEFAULT_STEPS = 20;
export const WORKER_LOG_MAX_STEPS = 200;
/** hub worker log --stats 里“读得最多的文件”“重复最多的命令”各列几个。 */
export const WORKER_STATS_TOP = 3;
/** hub worker search：默认列几条、最多几条；命中处的上下文（含关键词）最多几个字；关键词最多几个、每个最多几个字符。 */
export const WORKER_SEARCH_DEFAULT_LIMIT = 20;
export const WORKER_SEARCH_MAX_LIMIT = 100;
export const WORKER_SEARCH_CONTEXT_CHARS = 80;
export const WORKER_SEARCH_MAX_KEYWORDS = 10;
export const WORKER_SEARCH_MAX_KEYWORD_CHARS = 100;
/** hub worker list：进行中的全列，已收工的只列最近收工的这么多个（几百个全列会把几十 KB 塞进项目经理的上下文），更早的用 hub worker search / show 查。 */
export const WORKER_LIST_RECENT_ENDED = 20;
/** hub worker show / log 里一条命令、一段回复最多显示几个字符（超了截断加省略号）。 */
export const WORKER_VIEW_TEXT_MAX_CHARS = 100;
/** Worker 在干活、没有工具在跑、这么久没动静，hub worker show 提醒“可能卡住了”。 */
export const WORKER_STALL_HINT_MS = 5 * 60_000;
/** hub worker show 查 PR（gh pr list）最多等多久；超了当没有。 */
export const WORKER_PR_PROBE_TIMEOUT_MS = 5_000;
/** 一条用户消息最多 100 KB（按 UTF-8 字节算）。 */
export const MAX_MESSAGE_BYTES = 100 * 1024;
/** 流式增量文字推给网页的节流间隔（毫秒）：首块立即推，后续在窗口内合并成一次 session.status，不写 SQLite。 */
export const STREAMING_TEXT_THROTTLE_MS = 70;
/** 单段内存流式预览最多保留多少个 Unicode 字符（超长输出只截内存预览前缀，段结束 agent.text 落库仍是完整正文；防撑大内存与弱网帧）。 */
export const MAX_STREAMING_TEXT_CHARS = 16_000;
/**
 * 本地快工具（如 Read / Grep / Glob，SSD 上 2～5ms 即返回结果）在内存态 LiveSession.step 的最短可读驻留毫秒数：
 * openTools 清空准备回退到 Thinking 时，若距最近一次工具步骤显示尚不足该时长，先保留工具文案并设单会话唯一 setTimeout 到点回退；
 * 期间一旦来新工具、流式/完整文字、回合结束/停止或会话退出/关库立即打断清零。
 */
export const MIN_TOOL_STEP_VISIBLE_MS = 450;
/** 流式工具调用参数增量 JSON（如 Claude input_json_delta、Pi toolcall_delta）单块内存缓冲上限（UTF-16 码元）。 */
export const MAX_STREAMING_TOOL_JSON_CHARS = 8_192;
/** 单会话同时缓存的流式工具调用增量块上限（防异常流未发结束帧时无界增长）。 */
export const MAX_STREAMING_TOOL_BLOCKS = 32;
/** 推给网页的“在做什么”状态参数（文件路径、skill 名、连接器名等，见 step-labels.ts 的 STEP_INPUT_KEYS）每个最多这么多个 Unicode 字符。 */
export const MAX_STEP_ARG_CHARS = 300;
/** 账本在内存里留多少条变化，供 changesSince 补齐；更早的补不齐，要 resync。 */
export const CHANGE_BUFFER_SIZE = 1000;

// ---- M2：请求体的长度上限（界面服务、agent 接口校验请求体用，账本再查一遍）----

/** 项目名、项目经理名最多几个字符（按 Unicode 字符算，见 normalizeName）。 */
export const MAX_NAME_CHARS = 40;
/** 项目的一句话说明最多几个字符。 */
export const MAX_DESCRIPTION_CHARS = 200;
/** 性格设定正文最多 32 KB（UTF-8 字节）。 */
export const MAX_PERSONA_BYTES = 32 * 1024;
/** 改性格设定的理由最多几个字符。 */
export const MAX_REASON_CHARS = 500;
/** 文件夹路径最多 4096 字节（macOS 的 PATH_MAX 是 1024，留余量）。 */
export const MAX_PATH_BYTES = 4096;
/** 模型名最多几个字符。 */
export const MAX_MODEL_CHARS = 100;
/** 输入框指定派 Worker 的思考程度（PostMessageRequest.workerPick.effort）最多几个字符；档位名都是短词（xhigh、max……）。 */
export const MAX_WORKER_PICK_EFFORT_CHARS = 40;
/** hub ask 选项数量下限、上限及单个选项的最大字符数（按 Unicode 字符算）。 */
export const ASK_MIN_OPTIONS = 2;
export const ASK_MAX_OPTIONS = 10;
export const ASK_MAX_OPTION_CHARS = 200;
/**
 * agent 接口一个请求体最多多大（Fastify 的 bodyLimit）；比最长的字段大，字段超长由校验报 invalid。
 * 整个请求体超过它（Fastify 抛 FST_ERR_CTP_BODY_TOO_LARGE）也映射成 invalid、HTTP 400，不另开 413（见 hub.ts）。
 */
export const HUB_MAX_BODY_BYTES = 256 * 1024;
/** hub_calls 里 args 的每个字符串字段、result 最多存多少字节，超了截断（见 domain.ts 的 HubCall）。 */
export const HUB_CALL_FIELD_MAX_BYTES = 2 * 1024;

// ---- 后台写交接（docs/background-handover-design.md）----

/** 新会话开场说明里带切点之前多少字用户和项目经理的原话（String.length，中文一个字算 1），从新往旧取、可以跨好几代。切点之后的全带，不算在里面。 */
export const HANDOVER_RECENT_CHARS = 30_000;
/** 切点之后的原话超过这么多字：交接太旧了，作废（abandoned）重新复制。 */
export const HANDOVER_POST_CUT_MAX_CHARS = 60_000;
/** 交接写好（ready）后最多等旧会话这么久（比如后台任务一直不完），过了作废、过退避重新复制，不算失败次数。 */
export const HANDOVER_READY_MAX_MS = 30 * 60_000;
/** 跑腿的同时最多复制、写几份（每个复制进程几百 MB 内存），多的在 queued 等。 */
export const HANDOVER_CONCURRENCY = 2;
/** 关机时等跑腿的这么久：abort 在写的复制进程、报 shutdown、清理复制那份；到点还没完就不等了（没清掉的下次启动补清）。 */
export const HANDOVER_STOP_GRACE_MS = 3_000;
/**
 * 项目经理的对话长到多少 token（会话的 usage.context：最近一次请求的上下文大小，各家驱动都写）就自动换新会话：这一轮结束时进队列（ledger/handover.ts）。
 * 只对项目经理；Worker 的会话不自动换。
 */
export const HANDOVER_TOKEN_THRESHOLD = 200_000;
export const AUTO_RENEW_CONTEXT_TOKENS = HANDOVER_TOKEN_THRESHOLD;
/** 本会话写交接（兜底，厂商复制不了时）：自动的要空闲这么久才发交接请求；期间来了新消息（用户的、Worker 汇报）就等下一次空闲。后台写交接不用等。 */
export const AUTO_RENEW_IDLE_MS = 20_000;
/** 守护进程多久看一次换新会话的队列（只看队列里的对话，队列空什么都不查；启动时先看一次）；跑腿的也按这个间隔自己领一次活兜底。 */
export const AUTO_RENEW_TICK_MS = 5_000;
/**
 * 写交接最多等这么久：超时就放弃这次换代，旧会话照常用（自动换的下次空闲再试）。本会话写交接从交接请求登记起算，
 * 后台写交接从跑腿的领到（forking）起算，到了跑腿的 abort（杀进程组）。
 */
export const HANDOVER_TIMEOUT_MS = 5 * 60_000;
/** 自动换新会话：每一代会话最多自动试几次（写交接出错、超时、写出来是空的都算一次）；用完这一代不再自动换，资料页的“开新会话”照常能点。 */
export const AUTO_RENEW_MAX_ATTEMPTS = 3;
/** 自动换新会话没成：至少过这么久才再试，之后每没成一次翻倍（10、20 分钟）；还要照常等又一轮回完、再空闲。 */
export const AUTO_RENEW_RETRY_BACKOFF_MS = 10 * 60_000;
/** PersonaView 里最多带几条修改记录。 */
export const PERSONA_CHANGES_LIMIT = 50;

// ---- M3：Worker ----

/** Worker 的标题（hub worker start --title）最多几个字符（按 Unicode 字符算）：超了不报错，normalizeWorkerTitle 截断。 */
export const MAX_WORKER_TITLE_CHARS = 80;
/** 任务说明（hub worker start --stdin）、hub worker send 的正文最多多大：它们就是发给 Worker 的消息，和用户消息一样。 */
export const MAX_TASK_BYTES = MAX_MESSAGE_BYTES;
/** 项目经理对话里那一行 Worker 汇报的摘要最多显示几个字符，超了截断（见 worker.ts 的 workerLineText）。完整原文照样交给项目经理。 */
export const WORKER_LINE_SUMMARY_CHARS = 120;
/** Worker 分支名 hub/<编号>-<短名> 里短名最多几个字符（见 worker.ts 的 workerBranchName）。 */
export const WORKER_BRANCH_SLUG_CHARS = 30;
/** Worker 对话长到多少 token 就别再打回，让它收工、新派一个（见 prompt.ts 的 buildPmWorkerPrompt）。 */
export const WORKER_SEND_MAX_TOKENS = 200_000;
/**
 * Worker 单轮最大容忍时间（`--max-time <时长>`）：
 * - 默认兜底 30 分钟（30m）；
 * - 最短 10 秒（10s，方便测试与短任务）；
 * - 最长 24 小时（24h）。
 * 超过该时间当前轮次仍未结束时，系统自动给所属项目经理发一条静默触发消息，唤醒项目经理检查，不直接打断或杀死 Worker。
 */
export const DEFAULT_WORKER_MAX_TIME_MS = 30 * 60 * 1000;
export const MIN_WORKER_MAX_TIME_MS = 10_000;
export const MAX_WORKER_MAX_TIME_MS = 24 * 60 * 60 * 1000;

// ---- M6：定时任务（见 src/shared/schedule.ts、daemon/ledger/schedules.ts）----

/** 守护进程里的调度器多久查一次有没有到点的定时任务（启动时先查一次）。 */
export const SCHEDULER_TICK_MS = 30_000;
/** 到点后过了这么久才跑算“补跑”（睡眠、守护进程没开）；正常的延迟最多一个 tick。 */
export const SCHEDULE_LATE_MS = 2 * SCHEDULER_TICK_MS;
/** “每隔 N 分钟/小时”最短 15 分钟，最长 7 天。 */
export const MIN_SCHEDULE_EVERY_MINUTES = 15;
export const MAX_SCHEDULE_EVERY_MINUTES = 7 * 24 * 60;
/** 一个项目经理最多建几个定时任务（含暂停的）。 */
export const MAX_SCHEDULES_PER_PM = 20;
/** 定时任务的名字最多几个字符（同项目经理的名字）。任务说明最多 MAX_TASK_BYTES，它就是发给项目经理的消息。 */
export const MAX_SCHEDULE_NAME_CHARS = MAX_NAME_CHARS;

// ---- 聊天框上传文件 ----

/** 单个上传文件最多 20 MB。上传走单独的接口（POST /api/uploads，请求体就是文件原样的字节），不动普通消息接口 1 MB 的请求体上限。 */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
/** 一条消息最多带几个文件。 */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
/** 拖进来的文件夹最多看多少项（文件和子文件夹都算）：误拖一个大项目文件夹时不把整棵树都翻一遍。 */
export const MAX_DROPPED_FOLDER_ENTRIES = 1_000;
/** 服务端同时在收的上传最多几个（超出的回 429，不收）：每个上传整个读进内存，不限的话一次拖一堆大文件会撑爆。 */
export const MAX_CONCURRENT_UPLOADS = 4;
/** 网页一条消息的文件同时最多传几个（要小于 MAX_CONCURRENT_UPLOADS，留出别的页面的余地）。 */
export const UPLOAD_CLIENT_CONCURRENCY = 3;
/** 文件名太长要截断时，扩展名（含点）最多留多少字节；再长的“扩展名”不当扩展名，一起截。 */
export const MAX_UPLOAD_EXTENSION_BYTES = 16;
/** 存到磁盘上的文件名最多多少字节（UTF-8；APFS、ext4 的单个文件名上限是 255）；超了截断，扩展名尽量留着。 */
export const MAX_UPLOAD_NAME_BYTES = 120;

// ---- 推送提醒（联机 P4，docs/multi-device-design.md 第 6.2 节；规则在 shared/reminders.ts）----

/** 网页多久在 WebSocket 上报一次“前台 / 后台、正在看哪个对话”（切前台、后台、换对话时马上报）。 */
export const PRESENCE_REPORT_MS = 30_000;
/** 守护进程认一条上报多久：过了就当那个网页不在前台了（网页被冻住、断网时不会再报）。 */
export const PRESENCE_STALE_MS = 75_000;
/** 推送服务替离线的手机留多久（秒）：超过就丢，提醒过时了。 */
export const PUSH_TTL_SECONDS = 24 * 60 * 60;
/** 一次推送请求最多等多久。 */
export const PUSH_SEND_TIMEOUT_MS = 10_000;
/** 推送服务临时失败（网络错误、5xx、429）后隔多久重试，只重试一次。 */
export const PUSH_RETRY_DELAY_MS = 30_000;
/** 账本来了和提醒有关的变化后，等多久再判断要不要推：流式输出时一串变化合成一次，不用每条都把所有对话扫一遍。 */
export const REMINDER_EVALUATE_DELAY_MS = 300;
/** 一台最多存多少条订阅，超了丢最早的（每个浏览器一条，正常用不到）。 */
export const MAX_PUSH_SUBSCRIPTIONS = 20;
/** 订阅里 endpoint 最长多少字符（推送服务的网址，实际 200 左右）。 */
export const MAX_PUSH_ENDPOINT_CHARS = 2_048;

// ---- agent 发给用户的文件（回复里的 Markdown 链接指向本机文件，发出时存副本，见 daemon/sent-files.ts）----

/** 上传的文件和发出文件的副本留多少天：目录修改时间超过这么久的，守护进程启动时和之后每天清一次。 */
export const FILE_RETENTION_DAYS = 30;
/** 多久清一次。 */
export const FILE_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** 单个文件最多 50 MB，超了不存副本，卡片写“太大”。 */
export const MAX_SENT_FILE_BYTES = 50 * 1024 * 1024;
/** 一条消息的副本合计最多 200 MB，超出的那几个不存。 */
export const MAX_SENT_FILES_TOTAL_BYTES = 200 * 1024 * 1024;
/** 一条消息最多处理几个文件链接（按出现顺序，多出来的照普通链接显示）。 */
export const MAX_SENT_FILES_PER_MESSAGE = 10;
/** 存发出文件副本时一次从文件句柄读多少字节（daemon/sent-files.ts）。 */
export const SENT_FILE_COPY_CHUNK_BYTES = 1024 * 1024;

// ---- 预览窗（web/components/FilePreview.tsx）----

/** 文本、代码、Markdown、CSV 预览最多读多少字节：大文件只取前面这么多（Range 请求）。 */
export const MAX_PREVIEW_TEXT_BYTES = 1024 * 1024;
/** CSV 预览最多显示多少行数据（不含表头）。 */
export const MAX_PREVIEW_CSV_ROWS = 1000;

// ---- worktree 准备命令（hub project setup，见 src/daemon/setup/setup.ts）----

/** 准备命令（hub project setup --stdin 的正文）最多多大（UTF-8 字节）。 */
export const MAX_SETUP_COMMAND_BYTES = 16 * 1024;
/** 准备命令最多跑多久，到点连同所有后代一起强制结束；Worker 照常开工，任务说明前附上“超时”。 */
export const SETUP_TIMEOUT_MS = 10 * 60_000;
/** 准备命令没跑成功时，附在任务说明前的输出最多几行（取最后这么多）…… */
export const SETUP_OUTPUT_TAIL_LINES = 40;
/** ……最多多少字节。 */
export const SETUP_OUTPUT_TAIL_BYTES = 4 * 1024;
/** 准备命令的日志（state/logs/setup/worker-<编号>.log）每跑一次最多写多少字节，超了写一行“后面省略”，输出照样读完。 */
export const SETUP_LOG_MAX_BYTES = 5 * 1024 * 1024;

/** 打断：控制消息 5 秒没回应就发 SIGINT。 */
export const INTERRUPT_GRACE_MS = 5_000;
/** 启动后 60 秒没有 system/init，结束进程。 */
export const START_TIMEOUT_MS = 60_000;
/** 一轮结束后空闲 10 分钟，关掉标准输入。 */
export const IDLE_CLOSE_MS = 10 * 60_000;
/**
 * 会话里还有后台任务（Bash 的 run_in_background、Monitor、后台子代理）时，这一轮结束后最多不关多久；到点照常关。
 * 后台任务在跑就不算闲着（否则等 CI、跑冒烟的命令超过 IDLE_CLOSE_MS 会连进程一起被杀），但卡死的任务不能让 claude 进程一直占着。
 * 定 4 小时：等 CI、冒烟、构建这类事一般几十分钟，偶尔一两个小时；4 小时还没结束基本是卡死了，关掉后下次发消息 --resume 就行。
 */
export const BACKGROUND_TASKS_HOLD_MAX_MS = 4 * 60 * 60_000;
/**
 * Worker 的会话有后台命令时最多等多久（LaunchFiles.backgroundHoldMaxMs，比上面的短）：Worker 有后台命令时一轮结束不汇报，
 * 等命令跑完它被叫醒、真做完再汇报（ledger/workers.ts），项目经理一直在等。到点驱动层关进程（后台命令一起停），账本照常汇报并说明。
 * 定 150 分钟：claude 自己给后台命令的上限最长 2 小时（2.1.314 实测，到点它会停掉命令并叫醒 agent），正常走不到这里，这是它没停时的兜底。
 */
export const WORKER_BACKGROUND_HOLD_MAX_MS = 150 * 60_000;
/** 关机时最多等 10 秒，剩下的强制结束。 */
export const SHUTDOWN_GRACE_MS = 10_000;

// ---- 其他超时和间隔（可调的数都放这里；动作的重试次数和退避在 actions.ts 的 ACTION_RETRY，按动作类型和类型定义放一起）----

/** 驱动层：lastEventAt 最多每秒写一次库。 */
export const LAST_EVENT_WRITE_MS = 1_000;
/** 驱动层：一个会话的 token 累计最多每秒更新（写库、推给网页）一次；一轮里请求很密时合并，轮结束时马上更新。 */
export const USAGE_PUSH_MS = 1_000;
/** 驱动层：进程退出后最多等多久把标准输出、标准错误读完；孙进程占着管道时到点强制关掉。 */
export const STDIO_DRAIN_MS = 300;
/** 驱动层：发了 SIGKILL 之后最多再等多久。 */
export const KILL_WAIT_MS = 2_000;
/** 驱动层：强制结束时跑一次 ps（找 claude 的后代、认残留的 claude）最多等多久，超时当 ps 跑不了。 */
export const PS_TIMEOUT_MS = 2_000;
/** 模型名单：问一次 claude（发 initialize 控制请求）最多等多久，超时用打包的名单。 */
export const MODEL_CATALOG_TIMEOUT_MS = 15_000;
/** 只读 DeepSeek Worker 起之前在沙箱外初始化 dsh 的 acp profile（`dsh --profile acp --dump-config`，实测 0.3 秒）最多等多久。 */
export const DEEPSEEK_PROFILE_INIT_TIMEOUT_MS = 30_000;
/** 模型名单最多列几个模型（厂商报得再多也只取前面这些）；名字、说明最多几个字（超了截断）。 */
export const MAX_CATALOG_MODELS = 50;
export const MAX_CATALOG_LABEL_CHARS = 80;
export const MAX_CATALOG_DESCRIPTION_CHARS = 200;
/** 模型名单：问到之后多久算旧了，下次有人要时在后台再问一次（先给旧的）。 */
export const MODEL_CATALOG_FRESH_MS = 6 * 60 * 60_000;
/** 模型名单：没问到（claude 没装、超时、报错）时，隔多久才再问。 */
export const MODEL_CATALOG_RETRY_MS = 5 * 60_000;
/**
 * 模型名单：同一家厂商的 stat 指纹（可执行文件 + 本地凭据/模型缓存文件）多久内不重算。list()/ensureUsable() 高频调用、
 * 命中缓存时直接用上次的结果，不碰磁盘；代价是本地文件变了最多晚这么久才发现。
 */
export const MODEL_CATALOG_FINGERPRINT_COOLDOWN_MS = 3_000;
// ---- 输入框的“/”命令和“@”文件（daemon/commands-catalog.ts、daemon/workspace-files.ts）----

/** 命令列表：问正在跑的会话（再发一次 initialize，实测约 10 毫秒）最多等多久，超时当问不到。 */
export const RUNNING_COMMANDS_TIMEOUT_MS = 3_000;
/** 命令列表：会话没在跑时另起一个 claude 问（约 0.9 秒）最多等多久。 */
export const COMMANDS_QUERY_TIMEOUT_MS = 15_000;
/** 命令列表：按（厂商、目录）缓存，多久算旧了，下次有人要时先给旧的、在后台再问。 */
export const COMMANDS_FRESH_MS = 10 * 60_000;
/** 命令列表：没问到时，隔多久才再问（这期间给空列表）。 */
export const COMMANDS_RETRY_MS = 60_000;
/** 命令列表：同一时间另起的 agent 进程最多几个（每个都在项目目录里起一个完整的 claude，别一次起一堆），多的排队。 */
export const MAX_CONCURRENT_COMMAND_QUERIES = 2;
/** 命令列表：缓存最多存几份（按厂商、目录），多了淘汰最旧的。 */
export const MAX_COMMAND_CACHE_ENTRIES = 50;
/** 命令列表最多几项；说明、参数提示最多几个字（插件命令的说明有几百字）。 */
export const MAX_COMMANDS = 500;
export const MAX_COMMAND_DESCRIPTION_CHARS = 200;
export const MAX_COMMAND_HINT_CHARS = 80;
/** “@”文件：每个文件夹最多列多少个文件，多了不再列（truncated）。 */
export const MAX_WORKSPACE_FILES = 25_000;
/** “@”文件：一个文件夹的文件清单缓存多久。 */
export const WORKSPACE_FILES_FRESH_MS = 30_000;
/** “@”文件：清单缓存最多存几个文件夹，多了淘汰最旧的。 */
export const MAX_WORKSPACE_FILE_CACHES = 20;
/** “@”文件：一次最多回几条。 */
export const MAX_FILE_RESULTS = 50;
/** “@”文件：搜索词最多几个字（多的截掉）。 */
export const MAX_FILE_QUERY_CHARS = 200;
/** “@”文件：列一个文件夹（git ls-files 或自己遍历）最多等多久。 */
export const WORKSPACE_LIST_TIMEOUT_MS = 10_000;

/** 驱动层：清理残留进程时多久看一次它还在不在。 */
export const STALE_POLL_MS = 50;
/** 处理函数：会话正忙、消息在驱动层排队时，隔多久再问一次。 */
export const QUEUED_RECHECK_MS = 1_000;
/** 处理函数：Worker 还没开工（在建 worktree、跑准备命令）或任务说明还没写进去时，发给它的别的消息隔多久再看一次。 */
export const WORKER_FIRST_TURN_RECHECK_MS = 2_000;
/** 处理函数：额度用完时最多推迟多久再看一次。 */
export const RATE_LIMIT_RECHECK_MAX_MS = 5 * 60_000;
/** 处理函数：额度用完、知道恢复时间时，在恢复时间之后多等一会儿再发，免得卡在边界上。 */
export const RATE_LIMIT_RECHECK_PAD_MS = 1_000;
/** 执行器：没有到点的动作时最多隔多久再查一次（兜底，平时靠 wake 和下一个到点时间）。 */
export const ACTION_POLL_INTERVAL_MS = 30_000;
/** 执行器：同时最多跑几个动作（同一个会话一次只跑一个）。 */
export const ACTION_CONCURRENCY = 4;
/** 数据库：别的连接占着写锁时，最多忙等多久再报错（SQLite 的 busy timeout）。 */
export const DB_BUSY_TIMEOUT_MS = 5_000;
/**
 * 数据库：按 SQL 原文缓存的预编译语句最多留几条，多了淘汰最久没用的。代码里写死的 SQL 约 400 条，全放得下；
 * 把编号拼进 SQL 的（删项目经理时的 IN (...)）每次都是新原文，不设上限会一直攒着。
 */
export const MAX_CACHED_STATEMENTS = 1_000;
/** 驱动层：错误信息里最多带多少个字符的标准错误（取最后这么多）。 */
export const STDERR_TAIL_CHARS = 2_000;
/** agent 接口：一个请求从连上到收完的上限，半截请求挂着不放，到点就断。 */
export const HUB_REQUEST_TIMEOUT_MS = 15_000;
/** agent 接口：多久查一次有没有超时的请求（Node 的 connectionsCheckingInterval，默认 30 秒，太粗）。 */
export const HUB_TIMEOUT_CHECK_MS = 1_000;
/** agent 接口：启动时试连旧 socket 的上限，连得上说明有活实例。 */
export const HUB_SOCKET_PROBE_MS = 1_000;
/**
 * agent 接口：hub worker start 之前探主文件夹的 git（是不是有提交的仓库、有没有没提交的改动），每次 git 调用最多等多久。
 * 要比 HUB_CLI_TIMEOUT_MS 短得多：git 卡住时这一次派活报错，不能拖到 hub 那边报“可能已执行”。
 */
export const GIT_PROBE_TIMEOUT_MS = 5_000;
/**
 * agent 接口：hub worker start --vendor 选的这家现在不能用时，当场重问一次（ModelCatalogs.ensureUsable）最多等多久；
 * 没问完就按现在的状态回答（重问在后台接着跑，下一次调用看得到新结果）。
 * 整个请求受 HUB_REQUEST_TIMEOUT_MS 限制，后面还要探 git（最多两次 git，各 GIT_PROBE_TIMEOUT_MS），所以取
 * HUB_REQUEST_TIMEOUT_MS − 2 × GIT_PROBE_TIMEOUT_MS − 1 秒余量 = 4 秒：重问再慢，git 也卡住，也在请求上限之内回到项目经理。
 * 问一次名单要 MODEL_CATALOG_TIMEOUT_MS（15 秒），所以这个预算比一次完整的重问短，卡住时会走“按现在的状态回答”。
 */
export const VENDOR_RECHECK_BUDGET_MS = HUB_REQUEST_TIMEOUT_MS - 2 * GIT_PROBE_TIMEOUT_MS - 1_000;
/** hub 命令：连上之后多久没动静算守护进程没回应。 */
export const HUB_CLI_TIMEOUT_MS = 30_000;
/** hub 命令：--stdin 多久没收到数据就放弃。 */
export const HUB_CLI_STDIN_IDLE_MS = 60_000;
/** 关机：最多等执行器手上的动作多久；还没做完（比如在等 claude 启动）就先关驱动层，让它们结束。 */
export const EXECUTOR_STOP_GRACE_MS = 3_000;
/** 关机：整个关机过程（执行器、claude、界面服务、agent 接口、关库）的总上限；超了记一条日志，以非 0 退出码退出。 */
export const SHUTDOWN_TOTAL_MS = 30_000;
/** 运行中未捕获异常：先试着正常关机（停 Worker / 项目经理的子进程、关库）最多等多久，到点直接退出码 1 退出。比 SHUTDOWN_TOTAL_MS 短，状态已经不可信，别拖。 */
export const FATAL_SHUTDOWN_MS = 15_000;
/** state/logs/daemon.log 超过这个大小就改名成 daemon.log.1（覆盖旧的）再新写，磁盘上最多两份。崩溃循环（systemd 每 5 秒拉起一次）也撑不大。 */
export const DAEMON_LOG_MAX_BYTES = 2 * 1024 * 1024;
/** 关机：关 agent 接口最多等多久（它不等还连着的请求，正常一下就关掉；超了不再等，接着关库）。 */
export const AGENT_API_CLOSE_MS = 3_000;

/**
 * 界面登录后设的 cookie 名的前缀（HttpOnly、SameSite=Strict）。值是随机的会话令牌（每个浏览器一条，库里只存它的 sha256，
 * 见 daemon/ui-server/sessions.ts），不是界面用户令牌。界面用户令牌（state/ui-token）只当“主钥匙”：用来登录、生成登录链接，
 * 全部退出时换掉。守护进程重启后会话还在（存在库里）。
 * cookie 按主机名存、不分端口：同一个浏览器里 127.0.0.1:4317（本机）和 127.0.0.1:4318（ssh -L 转来的东京）会互相顶掉，
 * 所以名字带上网址里的端口（uiCookieName），各用各的。
 */
export const UI_COOKIE_NAME = "agent_hub_ui";

/** 这次请求的 cookie 名：Host 头里有端口就是 `agent_hub_ui_<端口>`，没有（默认端口，如 https 的 443）就是 UI_COOKIE_NAME。 */
export function uiCookieName(hostHeader: string | undefined): string {
  const port = /:(\d{1,5})$/.exec(hostHeader ?? "")?.[1];
  return port === undefined ? UI_COOKIE_NAME : `${UI_COOKIE_NAME}_${port}`;
}

/** 登录 cookie 的有效期：一年（距最后一次活动）。过了这么久没用的会话删掉。 */
export const SESSION_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
/** 会话的“最后活动”最多隔这么久写一次库（每个请求都写会白白吵库）。 */
export const SESSION_TOUCH_INTERVAL_MS = 60 * 1000;
/** 最多同时留多少个浏览器登录；满了新登录会挤掉最久没用的。 */
export const MAX_BROWSER_SESSIONS = 100;
/** 记下的 User-Agent 最多多少个字符。 */
export const MAX_USER_AGENT_CHARS = 300;
/** 二维码登录链接几分钟有效，用一次就失效。 */
export const LOGIN_LINK_TTL_MS = 5 * 60 * 1000;
/** 同时有效的登录链接最多几个（每个都在内存里；多了新的会挤掉最早的）。 */
export const MAX_PENDING_LOGIN_LINKS = 20;
/** state/ui-token 的权限：只有自己能读写。启动时发现权限更宽要改回来。 */
export const UI_TOKEN_FILE_MODE = 0o600;
/** 公网入口会话的不活动有效期：30 天（本机与 tailnet 会话为 SESSION_MAX_AGE_MS = 365 天）。 */
export const PUBLIC_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** 公网扫码后待已登录设备批准的会话超时：10 分钟未批准自动作废。 */
export const PENDING_SESSION_TTL_MS = 10 * 60 * 1000;
/** 公网 /auth 失败限流：单 IP 每分钟最多失败 5 次。 */
export const PUBLIC_AUTH_IP_MAX_FAILURES = 5;
export const PUBLIC_AUTH_IP_WINDOW_MS = 60_000;
/** 公网 /auth 失败限流：全局每小时最多失败 30 次。 */
export const PUBLIC_AUTH_GLOBAL_MAX_FAILURES = 30;
export const PUBLIC_AUTH_GLOBAL_WINDOW_MS = 3_600_000;
/** 公网 /auth 触发任一失败阈值后的锁定时长：15 分钟。 */
export const PUBLIC_AUTH_LOCKOUT_MS = 15 * 60_000;
/** 公网 /auth 按 IP 限流桶数量上限（防公网扫描撑大内存）。 */
export const MAX_PUBLIC_AUTH_IP_BUCKETS = 1_000;

/** 环境变量（各家可执行文件的 AGENT_HUB_<大写编号> 在各自 spec 的 cli.envVar）。 */
export const ENV_HOME = "AGENT_HUB_HOME";
/** 界面服务的端口，默认 DEFAULT_UI_PORT；0 表示由系统分配（测试用）。 */
export const ENV_PORT = "AGENT_HUB_PORT";
/** 第一次启动自动建项目经理时用的默认模型（如 claude-haiku-5-5，冒烟测试用）；不设就用 claude 自己的默认。 */
export const ENV_DEFAULT_MODEL = "AGENT_HUB_DEFAULT_MODEL";
/** 准备命令里能用的：项目主文件夹（比如 cp "$AGENT_HUB_ROOT_PATH/.env" .）、这个 worktree 的目录。 */
export const ENV_SETUP_ROOT_PATH = "AGENT_HUB_ROOT_PATH";
export const ENV_SETUP_WORKTREE_PATH = "AGENT_HUB_WORKTREE_PATH";
/** 联机（daemon/platform/）：tailscale 命令行在哪，默认 macOS 用 App 里的、别的系统用 PATH 里的 tailscale。 */
export const ENV_TAILSCALE = "AGENT_HUB_TAILSCALE";
/** 联机：本机的 tailnet 名字（<机器>.<tailnet>.ts.net）写死，不问 tailscale status。 */
export const ENV_TAILNET_NAME = "AGENT_HUB_TAILNET_NAME";
/** 联机：设备主人的 Tailscale 登录名写死。打了 tag 的设备 status 里没有主人，必须写这个，否则经 serve 的请求一律 403。 */
export const ENV_TAILNET_OWNER = "AGENT_HUB_TAILNET_OWNER";
/** 联机：serve 转发目标 unix | tcp，默认 Linux unix、macOS tcp（老版本 tailscale 不支持 unix: 时改 tcp）。 */
export const ENV_SERVE_TARGET = "AGENT_HUB_SERVE_TARGET";
/** 只给开发用：`pnpm dev` 时 vite 把 /api、/auth 和 WebSocket 代理到这个端口上的守护进程。 */
export const ENV_DEV_DAEMON_PORT = "AGENT_HUB_DAEMON_PORT";

/** 界面服务默认端口。固定端口：重启后浏览器刷新同一个地址就能接着用。 */
export const DEFAULT_UI_PORT = 4317;
/**
 * 设备入口（docs/hub-tunnel-design.md 第 4 节）在中心（东京）上听的 TCP 端口，只听 127.0.0.1。连入设备经 ssh -L 连到它；
 * 隧道用户读不了守护进程的 socket，所以中心用端口。连入方用 unix socket（paths.ts 的 peerSock）。
 */
export const DEFAULT_PEER_ENTRY_PORT = 4319;

/** system/api_retry 里的 error 字符串最多留多少个字符（Claude 给的是类别，正常很短；防着异常长的）。 */
export const MAX_API_RETRY_ERROR_CHARS = 200;

/** 升级数据库前自动备份的 hub.sqlite.bak-* 最多留几份：新备份写好后删掉更早的。 */
export const MAX_DB_BACKUPS = 2;

/** 同一个模块连续失败几次就算“坏了”（界面标红）。 */
export const HEALTH_FAILURE_THRESHOLD = 3;

// ---- 测试 ----

/**
 * 测试：单条用例和 beforeAll/afterEach 等钩子的超时（vitest 默认 5 秒）。很多用例起真进程（假 claude、真守护进程），
 * 好几个工作树同时跑测试、机器忙的时候，起一个进程就要好几秒；超时只用来拦真正卡死的用例，所以放宽。
 * 个别用例要更久的（重启、重试）在用例上单独写。
 */
export const TEST_TIMEOUT_MS = 20_000;
/**
 * 测试收尾时（每个测试文件的 afterAll，test/spawn-guard.ts）等本文件起的子进程退出最多多久；超了算残留，测试失败。
 * 正常没有残留时第一次检查就过，不会慢；只有收尾时刚发出 SIGKILL 的进程要等它真的没了。
 */
export const TEST_CHILD_EXIT_WAIT_MS = 5_000;

// ---- 守护进程起的子进程记账（daemon/process-ledger.ts）----
/** state/child-processes.json 里最多记多少个还活着的子进程；超了丢最老的（它们早已不在了才会堆到这个数）。 */
export const PROCESS_LEDGER_MAX_ENTRIES = 200;
/** 记录里的用途（purpose）最多留多少字符。 */
export const PROCESS_LEDGER_PURPOSE_MAX_CHARS = 64;

// ---- 新建项目经理时选主文件夹（守护进程替网页弹 macOS 原生的“选择文件夹”，见 daemon/pick-folder.ts）----

/** 选文件夹的对话框最多开多久；超了结束 osascript、当用户取消处理（用户走开了不能一直占着“同时只有一个”）。 */
export const PICK_FOLDER_TIMEOUT_MS = 5 * 60 * 1000;

// ---- 额度（只能另起进程问的厂商，agy；daemon/quota/fetched-quota.ts）----
/** 问到的额度缓存多久；用户打开额度面板时才问，期内再开直接用缓存。 */
export const FETCHED_QUOTA_FRESH_MS = 5 * 60_000;
/** 没问到（起不来、超时、报错）或问到了但一组都认不出时，只记这么久：偶发失败不会让面板空着 5 分钟，又不会每开一次面板就起一个进程。 */
export const FETCHED_QUOTA_RETRY_MS = 30_000;
/** 问一次最多等多久；超了当没有。 */
export const FETCHED_QUOTA_TIMEOUT_MS = 30_000;

/** 联机：tailscale status 的结果缓存多久（毫秒）。问到了 5 分钟，没问到（没装、没开）30 秒后再问；都是有请求时才在后台问，不是每个请求都跑。 */
export const TAILNET_PROBE_OK_TTL_MS = 5 * 60_000;
export const TAILNET_PROBE_FAIL_TTL_MS = 30_000;
/** 联机：跑一次 tailscale status --json 最多等多久。 */
export const TAILSCALE_STATUS_TIMEOUT_MS = 5_000;

// ---- 联机：设备配对、转发（daemon/peers/，docs/multi-device-design.md 第 3.2 节） ----
/** 邀请码：随机 128 位，10 分钟内、只能用一次。 */
export const PEER_INVITE_BYTES = 16;
export const PEER_INVITE_TTL_MS = 10 * 60_000;
/** 同一台来配对的设备（按它报的设备编号）邀请码错这么多次：锁住这一台，直到用户在本机重新生成邀请码。别的设备不受影响。 */
export const PEER_INVITE_MAX_FAILURES = 5;
/** 错误次数最多记这么多台来源，满了丢最早的（只在内存里）。 */
export const PEER_INVITE_FAILURE_SOURCES = 1_000;
/** 设备令牌：随机 32 字节（base64url 43 个字符）。对方的只存 sha256。 */
export const PEER_TOKEN_BYTES = 32;
/** 应邀配对后对方一直没来确认（它那边没存下来）：这么久后丢掉这条“待确认”。 */
export const PEER_PENDING_TTL_MS = PEER_INVITE_TTL_MS;
/** 记住移除过的设备（不让同步、介绍又把它配回来），最多这么多条，满了丢最早的。 */
export const MAX_REMOVED_PEERS = 100;
/** 设备清单最多这么多台（对方发来的清单超过就拒绝）。 */
export const MAX_PEERS = 100;
/** 设备之间的控制请求（配对、同步、移除、介绍、改名）最多等多久。 */
export const PEER_REQUEST_TIMEOUT_MS = 10_000;
/** 转发：等对方回响应头最多多久（含连接）；超了回 502 device_offline。响应体（下载）不限时。 */
export const PEER_PROXY_HEADERS_TIMEOUT_MS = 30_000;
/** 转发 WebSocket：连对方最多等多久。 */
export const PEER_WS_CONNECT_TIMEOUT_MS = 10_000;
/** 转发 WebSocket：每隔这么久 ping 一次对方，下一次 ping 时还没收到 pong 就当对方离线（断网后 10 秒内发现）。 */
export const PEER_WS_PING_MS = 5_000;

// ---- 网页实时连接保活、请求超时（daemon/ws-keepalive.ts、web/connection.ts、web/client.ts）----
// 手机 VPN、运营商 NAT 会把闲着的连接静默丢掉（不发 FIN/RST）：浏览器以为还连着，变化推不过来，请求挂在死连接上一直转圈。
/**
 * 服务端（本机 /api/ws 和入口转发的 /d/<设备>/api/ws）每隔这么久给浏览器那条发一条应用层心跳（api.ts 的 WS_HEARTBEAT_TEXT，
 * 连帧头约 22 字节；浏览器的 JS 收不到协议层 ping），同时 ping 一次，上一次 ping 没回 pong 就断掉（死连接不再占着监听、前台状态）。
 * 15 秒：短于常见 NAT、运营商、手机 VPN 的空闲回收（30 秒起），连接不会因“闲着”被丢；每条连接每 15 秒几十字节，和数据量无关。
 */
export const WS_HEARTBEAT_MS = 15_000;
/** 心跳允许迟到多久（网络抖动、手机切后台时定时器被节流）。 */
export const WS_HEARTBEAT_GRACE_MS = 5_000;
/** 网页这么久（35 秒）没收到任何消息（含心跳）就当连接死了，主动关掉重连：错过两次心跳再加余量，偶尔丢一次不误判。 */
export const WS_STALE_MS = 2 * WS_HEARTBEAT_MS + WS_HEARTBEAT_GRACE_MS;
/** 切回前台、请求超时时查一次：超过一次心跳加余量（20 秒）没消息就不等判死，马上重连（重连带 since，只补漏掉的）。 */
export const WS_CHECK_SILENCE_MS = WS_HEARTBEAT_MS + WS_HEARTBEAT_GRACE_MS;
/** 网页普通接口请求最多等多久（含读完响应体）：正常几百毫秒到 1 秒多，15 秒是十倍以上的余量；超了报“请求超时”，界面给 Retry。上传、下载文件、选文件夹不限。 */
export const API_REQUEST_TIMEOUT_MS = 15_000;
/** 服务端自己要等外部进程的接口（额度、重问模型名单、斜杠命令）和快照（手机上可能大）：比服务端最长的等待（额度 30 秒、转发等响应头 30 秒）再多 5 秒，不抢在服务端前面放弃。 */
export const SLOW_API_REQUEST_TIMEOUT_MS = Math.max(FETCHED_QUOTA_TIMEOUT_MS, PEER_PROXY_HEADERS_TIMEOUT_MS) + 5_000;

// ---- 防闲置睡眠（daemon/platform/sleep.ts） ----
/** 有会话在跑时起防闲置睡眠进程（macOS 的 caffeinate）；全部回到空闲后等这么久（2 分钟）再结束，免得两轮之间来回起停。 */
export const SLEEP_INHIBIT_GRACE_MS = 120_000;

// ───────────── ssh 隧道（docs/hub-tunnel-design.md 第 3、6、7 节）─────────────
/** 中心给连入设备分的 -R 端口（槽位）：从这个起往上取最小的空的，一台一个。 */
export const TUNNEL_FIRST_SLOT_PORT = 4401;
/** 槽位端口最大到这个（最多 99 台连入设备）。 */
export const TUNNEL_LAST_SLOT_PORT = 4499;
/** ssh 断了以后第一次等多久再连；每失败一次翻倍。 */
export const TUNNEL_BACKOFF_MIN_MS = 1_000;
/** 退避封顶。 */
export const TUNNEL_BACKOFF_MAX_MS = 60_000;
/** 连上后稳定这么久再断，退避从头算（也开始一个新的“退避周期”：提前重连又能用一次）。 */
export const TUNNEL_STABLE_MS = 60_000;
/** ssh 心跳：每隔几秒一次（ServerAliveInterval，秒）。东京那边 sshd 片段的 ClientAliveInterval 用同一个数。 */
export const TUNNEL_ALIVE_INTERVAL_S = 15;
/** 心跳几次没回就断（ServerAliveCountMax）：15 × 3 = 45 秒内发现断线。 */
export const TUNNEL_ALIVE_COUNT_MAX = 3;
/** ssh 连中心最多等几秒（ConnectTimeout）。 */
export const TUNNEL_CONNECT_TIMEOUT_S = 15;
/** 停隧道：SIGTERM 之后等这么久还没退就 SIGKILL。 */
export const TUNNEL_STOP_GRACE_MS = 3_000;
/** 隧道状态里留 ssh 最后一行报错，最多这么多字符。 */
export const TUNNEL_DETAIL_MAX_CHARS = 200;
/** 隧道命令等守护进程的管理 socket 回话最多多久。 */
export const TUNNEL_ADMIN_TIMEOUT_MS = 30_000;
/** 管理 socket 收的请求体上限。 */
export const TUNNEL_ADMIN_MAX_BODY_BYTES = 16 * 1024;

// ---- 项目经理归档（migrations/0016_pm_archives.sql、daemon/ledger/persona.ts）----
/** 项目经理归档后保留多少天，到期由守护进程清理该 PM 的全部账本与内部磁盘数据。 */
export const PM_ARCHIVE_RETENTION_DAYS = 7;
export const PM_ARCHIVE_RETENTION_MS = PM_ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
/** 每小时巡检一次到期归档 PM。 */
export const PM_ARCHIVE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

// ---- 已收工 Worker 的对话保留期（migrations/0020_conversation_purges.sql、daemon/ledger/worker-retention.ts、daemon/db-retention.ts）----
/** Worker 收工（workers.updated_at：收工时写，之后不再改）满这么多天，清掉它自己对话里的消息和步骤日志等；基本记录和项目经理对话里的汇报留着。 */
export const WORKER_RETENTION_DAYS = 30;
export const WORKER_RETENTION_MS = WORKER_RETENTION_DAYS * 24 * 60 * 60 * 1000;
/** 守护进程多久巡检一次（启动时先巡一次）。 */
export const WORKER_RETENTION_INTERVAL_MS = 60 * 60 * 1000;
/** 一批（一个事务、一次写锁）最多删多少行（消息、步骤日志等各表加起来）：删得少，锁库的时间就短。 */
export const WORKER_PURGE_BATCH_ROWS = 500;
/** 一批最多看几个候选 Worker（预算花完就停，多取没用；取少了下一批还会取）。 */
export const WORKER_PURGE_CANDIDATES_PER_BATCH = 20;
/** 一轮巡检最多删多少行：超了留给下一轮（批与批之间让出事件循环，别的请求照常进来）。按一个月 3 万条消息、5 万步日志算，一小时 5000 行一天能清 12 万行。 */
export const WORKER_PURGE_ROUND_MAX_ROWS = 5_000;
/** 增量回收数据库空间（PRAGMA incremental_vacuum）：每次最多回收多少页（4 KB 一页，1000 页约 4 MB）、一轮最多回收多少页。 */
export const DB_INCREMENTAL_VACUUM_PAGES = 1_000;
export const DB_INCREMENTAL_VACUUM_ROUND_MAX_PAGES = 25_000;

// ---- Worker worktree 自动清理（daemon/worktree-cleanup.ts、daemon/ledger/workers.ts）----
/** 已收工且无未提交改动的 Worker worktree 保留多少天（PR 已合并的不等，直接清；分支保留）。 */
export const WORKTREE_RETENTION_DAYS = 3;
export const WORKTREE_RETENTION_MS = WORKTREE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
/** 后台多久跑一次 worktree 自动清理（每小时一次）。 */
export const WORKTREE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
/** 每轮最多检查多少个已收工的候选 worktree（避免一次跑太多 git 子进程卡住后台）。 */
export const WORKTREE_CLEANUP_BATCH_LIMIT = 10;

// ---- 输入框 /hub:worker 选择列表与二次 Esc 回退 ----
/** 同一份模型名单下按（级别、已选、筛选词）缓存的列表最多留几份；超了整份清掉重算（名单一换，旧的整份随 WeakMap 回收）。 */
export const WORKER_PICK_CACHE_MAX = 64;
/** 账本二次 Esc 回退按索引倒序最多查看最近多少条非 agent 消息（O(1) 截断，哪怕对话有几万条历史也不全表扫）。 */
export const REWIND_SCAN_LIMIT = 20;
/** 网页乐观回退发送路上的待发消息时，记住其去重键以防随后到达的 message.created 闪出气泡；最多留几条，满了丢最早的。 */
export const MAX_REWOUND_PENDING_KEYS = 32;

// ---- Router（总助）上限（docs/router-design.md §3.2 + 审定宽松水位）----
/** 单个 PM 同时挂起的独立待决项安全水位（只防内存溢出，不拦正常并行工作）。 */
export const ROUTER_PENDING_DECISIONS_PER_PM_MAX = 30;
/** 拍板卡问题字数上限。 */
export const ROUTER_QUESTION_MAX_CHARS = 160;
export const MAX_ROUTER_QUESTION_BYTES = 4 * ROUTER_QUESTION_MAX_CHARS;
/** 拍板卡背景说明与里程碑汇报摘要字数上限。 */
export const ROUTER_CONTEXT_MAX_CHARS = 400;
export const MAX_ROUTER_CONTEXT_BYTES = 4 * ROUTER_CONTEXT_MAX_CHARS;
/** 拍板卡选项数量下限与上限。 */
export const ROUTER_OPTION_MIN_COUNT = 2;
export const ROUTER_OPTION_MAX_COUNT = 4;
/** 单个选项字数上限。 */
export const ROUTER_OPTION_MAX_CHARS = 120;
export const MAX_ROUTER_OPTION_BYTES = 4 * ROUTER_OPTION_MAX_CHARS;
/** PM 给 Router 留的一句话备忘字数上限。 */
export const ROUTER_NOTE_MAX_CHARS = 500;
export const MAX_ROUTER_NOTE_BYTES = 4 * ROUTER_NOTE_MAX_CHARS;
/** 汇报附带链接上限及单条标签/目标长度上限。 */
export const ROUTER_REPORT_LINKS_MAX = 4;
export const ROUTER_REPORT_LINK_LABEL_MAX_CHARS = 80;
export const ROUTER_REPORT_LINK_TARGET_MAX_CHARS = 500;
export const MAX_ROUTER_REPORT_LINK_BYTES = 4 * (ROUTER_REPORT_LINK_LABEL_MAX_CHARS + ROUTER_REPORT_LINK_TARGET_MAX_CHARS + 4);
/** PM 卡片最新动态摘要字数上限。 */
export const ROUTER_PM_BRIEF_MAX_CHARS = 120;
/** StateSnapshot 里活跃 Router 项（pending + unread）上限。 */
export const ROUTER_ACTIVE_ITEMS_SNAPSHOT_MAX = 50;
/** StateSnapshot 里最近 Router 指令上限。 */
export const ROUTER_RECENT_COMMANDS_SNAPSHOT_MAX = 10;
/** Router 工作台 Recent 区最多同时展示多少条紧凑发令回执。 */
export const ROUTER_VISIBLE_RECEIPTS_MAX = 5;
/** 历史回执分页每页条数与前端内存缓存最多保留页数。 */
export const ROUTER_ARCHIVED_PAGE_SIZE = 30;
export const ROUTER_ARCHIVED_MAX_PAGES = 10;
/** Digest 中 PM 性格摘要最多取前几行、最多多少字。 */
export const ROUTER_PERSONA_SUMMARY_LINES = 4;
export const ROUTER_PERSONA_SUMMARY_MAX_CHARS = 200;
/** Digest 中单个 PM 附带的在跑 Worker 上限（超出只计总数）。 */
export const ROUTER_PM_ACTIVE_WORKERS_MAX = 6;
/** 单份 Fleet Digest JSON 字节上限（24 KB）。 */
export const ROUTER_FLEET_DIGEST_MAX_BYTES = 24_576;
/** Router Agent 单次只读规划超时（毫秒）。 */
export const ROUTER_AGENT_TIMEOUT_MS = 25_000;
/** 用户单条 Router 指令字数上限。 */
export const ROUTER_COMMAND_MAX_CHARS = 4_000;
/** 单条指令最多同时派发的目标 PM 数。 */
export const ROUTER_MAX_DISPATCH_TARGETS = 8;
/** 远端设备 Digest 成功缓存 TTL（毫秒）。 */
export const ROUTER_PEER_DIGEST_TTL_MS = 10_000;
/** 并发采集远端设备 Digest 单台超时（毫秒），确保单台卡顿不拖慢分派。 */
export const ROUTER_PEER_DIGEST_TIMEOUT_MS = 1_500;
/** 远端设备离线/失败短暂退避时长（毫秒，遵守缓存军规：失败不当正常结果长缓存）。 */
export const ROUTER_PEER_OFFLINE_BACKOFF_MS = 5_000;
/** 远端设备跨机投递消息或操作超时（毫秒）。 */
export const ROUTER_PEER_DISPATCH_TIMEOUT_MS = 15_000;
/** 轨道 B 同时运行的只读规划会话数上限（防止瞬间连点拉起过多进程）。 */
export const ROUTER_MAX_CONCURRENT_TRACK_B = 2;
/** 轨道 B 并发槽满时最多排队等待的指令数（超了直接拒，提示改用 @设备名/项目名 直通）。 */
export const ROUTER_TRACK_B_QUEUE_MAX = 16;
/** 轨道 B 单轮结束后回收临时会话（interrupt + end）最多等多久；厂商进程卡住也按时释放并发槽，不让调度队列永久卡死。 */
export const ROUTER_SESSION_CLEANUP_GRACE_MS = 5_000;
/** 守护进程关闭时最多等在途轨道 B 规划收尾多久。 */
export const ROUTER_CLOSE_GRACE_MS = 8_000;
/** 本机目标端口按 clientId + 操作指纹的幂等记忆条数上限（project.create / worker.start / worker.send）。 */
export const ROUTER_OP_DEDUPE_MAX = 256;
/** 本机目标端口幂等记忆保留时长（毫秒）：覆盖跨设备超时后重试的窗口。 */
export const ROUTER_OP_DEDUPE_TTL_MS = 10 * 60_000;
/** hub dispatch worker-list 单次最多返回的 Piece 条数（给 agent 的命令输出上限）。 */
export const ROUTER_WORKER_LIST_MAX = 30;
/** 跨设备 target-ops 的操作 clientId 最长字符数（界面 clientId 200 字 + 轨道后缀 :a0 / :bN）。 */
export const ROUTER_OP_CLIENT_ID_MAX_CHARS = 256;
/** 跨设备 target-ops 的标题、项目名、PM 名最长字符数（下游账本还会按自己的规则再校验）。 */
export const ROUTER_OP_NAME_MAX_CHARS = 200;
/** 跨设备 target-ops 单个附件编号最长字符数。 */
export const ROUTER_ATTACHMENT_ID_MAX_CHARS = 100;
/** 已决拍板与已读汇报保留天数。 */
export const ROUTER_ITEM_RETENTION_DAYS = 30;
export const ROUTER_ITEM_RETENTION_MS = ROUTER_ITEM_RETENTION_DAYS * 24 * 60 * 60 * 1000;
/** router_commands 保留的最近条数上限。 */
export const ROUTER_COMMANDS_RETENTION_MAX = 500;
/** router_audit_log 环形表保留行数上限。 */
export const ROUTER_AUDIT_LOG_MAX_ROWS = 500;

// ---- 持久化任务图（Task DAG）上限（docs/task-graph-design.md §2.3 + 审定宽松水位）----
/** 单项目同时处于 active 的任务图安全水位。 */
export const MAX_ACTIVE_GRAPHS_PER_PROJECT = 20;
/** 单张任务图节点数上限。 */
export const MAX_GRAPH_NODES = 32;
/** 单张任务图有向边数上限。 */
export const MAX_GRAPH_EDGES = 64;
/** 任务图标题字数上限。 */
export const MAX_GRAPH_TITLE_CHARS = 120;
export const MAX_GRAPH_TITLE_BYTES = 4 * MAX_GRAPH_TITLE_CHARS;
/** 节点标题字数上限。 */
export const MAX_NODE_TITLE_CHARS = 80;
/** 节点 key 长度上限与合法字符格式。 */
export const MAX_NODE_KEY_CHARS = 48;
export const MAX_NODE_KEY_BYTES = 4 * MAX_NODE_KEY_CHARS;
/** 门禁问题字数上限。 */
export const MAX_GATE_QUESTION_CHARS = 300;
export const MAX_GATE_QUESTION_BYTES = 4 * MAX_GATE_QUESTION_CHARS;
/** 门禁选项个数上限。 */
export const MAX_GATE_OPTIONS = 6;
/** 门禁调研/背景 Markdown 摘要字数上限。 */
export const MAX_GATE_SUMMARY_CHARS = 2_000;
export const MAX_GATE_SUMMARY_BYTES = 4 * MAX_GATE_SUMMARY_CHARS;
/** 门禁/拍板定案选项字数上限。 */
export const MAX_DECISION_CHOICE_CHARS = 200;
export const MAX_DECISION_CHOICE_BYTES = 4 * MAX_DECISION_CHOICE_CHARS;
/** 门禁/拍板自由补充说明字数上限。 */
export const MAX_DECISION_NOTE_CHARS = 2_000;
export const MAX_DECISION_NOTE_BYTES = 4 * MAX_DECISION_NOTE_CHARS;
/** hub graph create / patch 输入 JSON 最大字节数（64 KB 充裕容纳 32 节点 + 摘要）。 */
export const MAX_GRAPH_SPEC_BYTES = 64 * 1024;
/** 节点完成产物摘要字数上限。 */
export const MAX_NODE_ARTIFACT_SUMMARY_CHARS = 500;
export const MAX_NODE_ARTIFACT_BYTES = 4 * MAX_NODE_ARTIFACT_SUMMARY_CHARS;
/** 历史任务图分页大小与 CLI 列表默认条数。 */
export const GRAPH_HISTORY_PAGE_SIZE = 20;
export const HUB_GRAPH_LIST_LIMIT = 20;
/** 右栏 Completed 历史任务图最多翻的页数（× GRAPH_HISTORY_PAGE_SIZE = 前端内存最多 300 张）；到顶不再显示 Load more。 */
export const MAX_COMPLETED_GRAPH_PAGES = 15;
/** 网页任务图选择器跨快照复用引用的兜底 Map 上限（按项目 / 按设备+对话 FIFO 淘汰）。 */
export const TASK_GRAPH_SELECTOR_CACHE_MAX = 64;
/** 已完结/已取消任务图保留天数。 */
export const COMPLETED_GRAPH_RETENTION_DAYS = 90;
export const COMPLETED_GRAPH_RETENTION_MS = COMPLETED_GRAPH_RETENTION_DAYS * 24 * 60 * 60 * 1000;

// ---- 项目经理专属记忆目录（state/pm-memory/<pmId>/，见 src/daemon/pm-memory.ts）----
/** 顶层主索引文件名（自动拼入项目经理系统提示词，与数据库 pms.persona 双向同步）。 */
export const PM_MEMORY_INDEX_FILE = "MEMORY.md";
/** 拼入系统提示词时 MEMORY.md 最多保留多少行；超出部分安全截断并附一行拆分提示（磁盘与资料页完整保留）。 */
export const PM_MEMORY_MAX_LINES = 200;
/** 拼入系统提示词时 MEMORY.md 最多占多少 UTF-8 字节（25 KB，含超限时附上的拆分提示）。 */
export const PM_MEMORY_MAX_BYTES = 25 * 1024;
/** 单个项目经理最多建多少个扁平 `<topic>.md` 按需参考子文件。 */
export const PM_MEMORY_MAX_SUBFILES = 50;
/** 单个 `<topic>.md` 子文件最多多少 UTF-8 字节（64 KB）。 */
export const PM_MEMORY_MAX_SUBFILE_BYTES = 64 * 1024;
/** 单个项目经理全部 `<topic>.md` 子文件合计最多多少 UTF-8 字节（1 MB）。 */
export const PM_MEMORY_MAX_TOTAL_BYTES = 1024 * 1024;
/** 资料页柔和提示水位比例（达到上限 80% 起才柔和提示，平时不挂配额数字）。 */
export const PM_MEMORY_SOFT_WARN_RATIO = 0.8;
/** `<topic>.md` 子文件名（含 `.md`）最多几个 Unicode 字符。 */
export const MAX_PM_MEMORY_FILE_NAME_CHARS = 80;
/** 扫描单个 PM 记忆目录时最多检查多少个目录项（防外部塞入海量无关文件卡住主线程）。 */
export const PM_MEMORY_MAX_DIR_SCAN = 256;
/** 账本内存里记住已同步过的 MEMORY.md 内容哈希的 LRU 上限（按跑了一个月数百个 PM 留足余量）。 */
export const PM_MEMORY_HASH_CACHE_MAX = 512;

// ---- 全厂商同步（daemon/vendor-sync/、web/components/VendorSyncSettings.tsx）----
/** `<dataDir>/backups/sync/` 轮转保留的备份快照目录上限，超了自动删最老的防无限堆积。 */
export const MAX_VENDOR_SYNC_BACKUPS = 20;
/** 单次扫描与预览返回的 MCP 服务条目上限。 */
export const MAX_VENDOR_SYNC_MCP_ITEMS = 200;
/** 单次扫描与预览返回的 Skill 条目上限。 */
export const MAX_VENDOR_SYNC_SKILL_ITEMS = 500;
/** 单次扫描返回的不可跨厂同步云端连接器说明上限。 */
export const MAX_VENDOR_SYNC_CLOUD_ITEMS = 200;
/** 扫描项目级 `.agents/skills` 时最多取多少个活跃项目文件夹。 */
export const MAX_VENDOR_SYNC_PROJECT_FOLDERS = 50;
/** 同步请求里单个 MCP / Skill 键名的最大字符数。 */
export const MAX_VENDOR_SYNC_KEY_CHARS = 512;
/** 预览里脱敏命令或 URL 展示字符串的最大字符数。 */
export const MAX_VENDOR_SYNC_PREVIEW_CHARS = 240;
/** 单个厂商 MCP 配置文件或 `SKILL.md` 读取字节上限（防异常超大文件撑爆内存）。 */
export const MAX_VENDOR_SYNC_CONFIG_BYTES = 2 * 1024 * 1024;
