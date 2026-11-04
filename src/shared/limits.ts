// 各块共用的数字和名字，定在这里免得各写各的。

/** 一次返回多少条消息（/api/state 里每个对话、/messages?before= 每页）。 */
export const MESSAGE_PAGE_SIZE = 100;
/** 一条用户消息最多 100 KB（按 UTF-8 字节算）。 */
export const MAX_MESSAGE_BYTES = 100 * 1024;
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
/**
 * agent 接口一个请求体最多多大（Fastify 的 bodyLimit）；比最长的字段大，字段超长由校验报 invalid。
 * 整个请求体超过它（Fastify 抛 FST_ERR_CTP_BODY_TOO_LARGE）也映射成 invalid、HTTP 400，不另开 413（见 hub.ts）。
 */
export const HUB_MAX_BODY_BYTES = 256 * 1024;
/** hub_calls 里 args 的每个字符串字段、result 最多存多少字节，超了截断（见 domain.ts 的 HubCall）。 */
export const HUB_CALL_FIELD_MAX_BYTES = 2 * 1024;
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

// ---- 聊天框上传文件 ----

/** 单个上传文件最多 20 MB。上传走单独的接口（POST /api/uploads，请求体就是文件原样的字节），不动普通消息接口 1 MB 的请求体上限。 */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
/** 一条消息最多带几个文件。 */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
/** 服务端同时在收的上传最多几个（超出的回 429，不收）：每个上传整个读进内存，不限的话一次拖一堆大文件会撑爆。 */
export const MAX_CONCURRENT_UPLOADS = 4;
/** 网页一条消息的文件同时最多传几个（要小于 MAX_CONCURRENT_UPLOADS，留出别的页面的余地）。 */
export const UPLOAD_CLIENT_CONCURRENCY = 3;
/** 文件名太长要截断时，扩展名（含点）最多留多少字节；再长的“扩展名”不当扩展名，一起截。 */
export const MAX_UPLOAD_EXTENSION_BYTES = 16;
/** 存到磁盘上的文件名最多多少字节（UTF-8；APFS、ext4 的单个文件名上限是 255）；超了截断，扩展名尽量留着。 */
export const MAX_UPLOAD_NAME_BYTES = 120;

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
/** 关机时最多等 10 秒，剩下的强制结束。 */
export const SHUTDOWN_GRACE_MS = 10_000;

// ---- 其他超时和间隔（可调的数都放这里；动作的重试次数和退避在 actions.ts 的 ACTION_RETRY，按动作类型和类型定义放一起）----

/** 驱动层：lastEventAt 最多每秒写一次库。 */
export const LAST_EVENT_WRITE_MS = 1_000;
/** 驱动层：进程退出后最多等多久把标准输出、标准错误读完；孙进程占着管道时到点强制关掉。 */
export const STDIO_DRAIN_MS = 300;
/** 驱动层：发了 SIGKILL 之后最多再等多久。 */
export const KILL_WAIT_MS = 2_000;
/** 驱动层：强制结束时跑一次 ps（找 claude 的后代、认残留的 claude）最多等多久，超时当 ps 跑不了。 */
export const PS_TIMEOUT_MS = 2_000;
/** 模型名单：问一次 claude（发 initialize 控制请求）最多等多久，超时用打包的名单。 */
export const MODEL_CATALOG_TIMEOUT_MS = 15_000;
/** 模型名单最多列几个模型（厂商报得再多也只取前面这些）；名字、说明最多几个字（超了截断）。 */
export const MAX_CATALOG_MODELS = 50;
export const MAX_CATALOG_LABEL_CHARS = 80;
export const MAX_CATALOG_DESCRIPTION_CHARS = 200;
/** 模型名单：问到之后多久算旧了，下次有人要时在后台再问一次（先给旧的）。 */
export const MODEL_CATALOG_FRESH_MS = 6 * 60 * 60_000;
/** 模型名单：没问到（claude 没装、超时、报错）时，隔多久才再问。 */
export const MODEL_CATALOG_RETRY_MS = 5 * 60_000;
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
/** hub 命令：连上之后多久没动静算守护进程没回应。 */
export const HUB_CLI_TIMEOUT_MS = 30_000;
/** hub 命令：--stdin 多久没收到数据就放弃。 */
export const HUB_CLI_STDIN_IDLE_MS = 60_000;
/** 关机：最多等执行器手上的动作多久；还没做完（比如在等 claude 启动）就先关驱动层，让它们结束。 */
export const EXECUTOR_STOP_GRACE_MS = 3_000;
/** 关机：整个关机过程（执行器、claude、界面服务、agent 接口、关库）的总上限；超了记一条日志，以非 0 退出码退出。 */
export const SHUTDOWN_TOTAL_MS = 30_000;
/** 关机：关 agent 接口最多等多久（它不等还连着的请求，正常一下就关掉；超了不再等，接着关库）。 */
export const AGENT_API_CLOSE_MS = 3_000;

/**
 * 界面登录后设的 cookie（HttpOnly、SameSite=Strict）。值就是界面用户令牌：
 * 令牌第一次启动时随机生成，存在数据目录的 state/ui-token（权限 UI_TOKEN_FILE_MODE），之后每次启动读同一个，
 * 所以守护进程重启后旧 cookie 仍然有效。删掉这个文件再启动就换新令牌，旧 cookie 全部失效。
 */
export const UI_COOKIE_NAME = "agent_hub_ui";
/** state/ui-token 的权限：只有自己能读写。启动时发现权限更宽要改回来。 */
export const UI_TOKEN_FILE_MODE = 0o600;

/** 环境变量。 */
export const ENV_HOME = "AGENT_HUB_HOME";
export const ENV_CLAUDE = "AGENT_HUB_CLAUDE";
/** 界面服务的端口，默认 DEFAULT_UI_PORT；0 表示由系统分配（测试用）。 */
export const ENV_PORT = "AGENT_HUB_PORT";
/** 第一次启动自动建项目经理时用的默认模型（如 claude-haiku-5-5，冒烟测试用）；不设就用 claude 自己的默认。 */
export const ENV_DEFAULT_MODEL = "AGENT_HUB_DEFAULT_MODEL";
/** 准备命令里能用的：项目主文件夹（比如 cp "$AGENT_HUB_ROOT_PATH/.env" .）、这个 worktree 的目录。 */
export const ENV_SETUP_ROOT_PATH = "AGENT_HUB_ROOT_PATH";
export const ENV_SETUP_WORKTREE_PATH = "AGENT_HUB_WORKTREE_PATH";
/** 只给开发用：`pnpm dev` 时 vite 把 /api、/auth 和 WebSocket 代理到这个端口上的守护进程。 */
export const ENV_DEV_DAEMON_PORT = "AGENT_HUB_DAEMON_PORT";

/** 界面服务默认端口。固定端口：重启后浏览器刷新同一个地址就能接着用。 */
export const DEFAULT_UI_PORT = 4317;

/** system/api_retry 里的 error 字符串最多留多少个字符（Claude 给的是类别，正常很短；防着异常长的）。 */
export const MAX_API_RETRY_ERROR_CHARS = 200;

/** 同一个模块连续失败几次就算“坏了”（界面标红）。 */
export const HEALTH_FAILURE_THRESHOLD = 3;

// ---- 测试 ----

/**
 * 测试：单条用例和 beforeAll/afterEach 等钩子的超时（vitest 默认 5 秒）。很多用例起真进程（假 claude、真守护进程），
 * 好几个工作树同时跑测试、机器忙的时候，起一个进程就要好几秒；超时只用来拦真正卡死的用例，所以放宽。
 * 个别用例要更久的（重启、重试）在用例上单独写。
 */
export const TEST_TIMEOUT_MS = 20_000;

// ---- 新建项目经理时选主文件夹（守护进程替网页弹 macOS 原生的“选择文件夹”，见 daemon/pick-folder.ts）----

/** 选文件夹的对话框最多开多久；超了结束 osascript、当用户取消处理（用户走开了不能一直占着“同时只有一个”）。 */
export const PICK_FOLDER_TIMEOUT_MS = 5 * 60 * 1000;
