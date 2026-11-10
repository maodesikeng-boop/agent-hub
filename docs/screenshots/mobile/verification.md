# PR4 手机外壳验收

2026-11-10，本机 Chromium，production build，隔离 HTTP/WebSocket 假实例 `127.0.0.1:4398`。未连接用户 4317、东京或现有模拟器。原始数字见 [measurements.json](./measurements.json)。

## #305 审查修复（Worker #307 改，#309 核对后提交）

2026-11-10，基于 head `06c1d176c26e1878e690f531ae8ba55fbea82229`。下方原始 2213ms 记录只来自约 16KB 假快照，不代表真实账户弱网首屏或 PWA 网络成本。

- 先失败：新建 HTTP 成功早于 WS 时 URL 被清空；远端清单/目标快照未到时远端 URL 被本机 ready 状态清空；同 PM 切 Piece 后顶栏返回盲目 `history.back()`。把 `shell-model.ts` 换回旧版，这 3 条新测试都失败。
- 路由校验：等入口 shell 和目标设备快照都 ready 才判无效；HTTP 新建成功只记一个待同步槽（React state），所属条目同步或离开该网址即释放，无超时、轮询、集合增长。真实无效编号在目标快照到达后仍 replace 到列表。
- 历史：push 记 `previous`（前一页网址）；顶栏返回只在 `previous` 等于上级时 `history.back()`，否则 replace 到上级。手机同层（PM↔PM、Piece↔Piece）切换 replace 当前条目并保留 state；抽屉提问回 PM 走同一返回逻辑。
- 抽屉随路由、设备、内容可用性和手机模式变化关闭。删 `MobileChat`，电脑也经过 `MobileShell`（`display: contents`），断点切换后输入框仍是同一 DOM 节点。返回按钮 `size="icon"`（标准档 36px，默认 Large 档 39.375px），`touch-target` 热区 44px；leading 注释已更新。
- 本机 `pnpm typecheck`、11 个相关测试文件 234 条、`pnpm build`、`git diff --check` 通过（mobile-shell、mobile/back、shell、route、App、sidebar-layout、right-rail、composer-wiring、selectors-cache、ui-standard、devices）。
- production 页面在隔离假 HTTP/WS `127.0.0.1:4409` 用 390×844 触屏验证：列表→PM→Piece→同 PM 切 Piece（history.length 不变）→返回→PM→返回→列表；PM→Piece→抽屉点提问→回 PM 并高亮该消息→浏览器后退→列表；抽屉开着浏览器后退→进无 Piece 的 PM，无抽屉、无开关→返回列表；直达 `#/w/301`→返回 `#/c/70`→返回列表。全程页面异常 0、导航新增 `/api/state` 请求 0，没有循环。截图 [309-drawer](./309-drawer.png)、[309-piece](./309-piece.png)、[309-ask-pm](./309-ask-pm.png)、[309-empty-pm](./309-empty-pm.png) 已逐张查看。
- 效率：未新增全量请求、定时器、轮询、订阅或无界集合；只多一个新建待同步槽和每条历史一个前页字符串。300 Worker/约 3 万消息的 selectors-cache 守卫通过，未改 Messages/selectors。
- 限制：真机、PWA 系统返回手势、真实远端网络及软键盘未验证；键盘与整屏设置留 PR5。

## 行为与截图

390×844、hasTouch/isMobile，实际 `matchMedia('(pointer: coarse)').matches === true`。安全区模拟为顶部 59px、底部 34px。列表 11 行；输入框底边距 42px = 34 + 8，未聚焦，页面宽 390px。返回后列表是同一 DOM 节点，scrollTop 保持 120px；列表→聊天→Piece→资料→返回期间新增 `/api/state` 请求 0。

逐张查看了 01–10 和 desktop 三张截图。列表无选中底色；聊天和 Piece 顶栏、抽屉正常；资料已完成加载。设置现有标题仍挤压，留 PR5。横屏 844×390 仍是手机外壳；横屏聊天未模拟安全区，底距 8px。鼠标 1440/900/390 均保留电脑布局。另一水果（草莓）列表和聊天见 08、09。

## 性能

- 首次列表 DOM 出现：Slow4G（下行 1.6Mbps、上行 750Kbps、RTT 150ms）+ CDP CPU 4×，5 个新 context，2194/2211/2213/2232/2236ms，中位 2213ms，零失败请求。计时从导航发起到 Search 可见，数据列表已挂载；不等待所有头像解码。均低于 2.5s。
- 页面资源传输：首次 437427B，再次 16667B（含 ResourceTiming 每请求 300B 开销，未含 HTML）。这组禁用 SW、使用 HTTP 缓存；真实 SW 安装额外预缓存流量未量，不能当作 PWA 完整网络账单。假 `/api/state` 未压缩 16053B，生产接口有压缩，不能据此推断真实账户响应体积。JS gzip 265423B、CSS gzip 10362B。
- 300 个已收工 Piece 的 fixture，CPU 4×，点击 Completed 到下一帧 DOM 更新：6.3/10.3/5.4/14.0/5.9ms，中位 6.3ms，范围 5.4–14.0ms。展开首批实际挂载 10 行（复用现有分页），没有一次性挂载 300 行。零页面异常。该数字不是展开全部 300 行的耗时。
- 桌面 App 渲染计数：对 `origin/main` 原 App 与本轮 App，以同一当前 shell-model、同一 1 PM 假夹具交替测 5 轮；spy 计数 `useShellModel` 调用，首屏/输入草稿/打开设置均为 5/5/5 → 5/5/5。未开启 StrictMode、未打开假 WS。旧报告 6/6/7 的测量夹具不在仓库，本次未复现，不能跨夹具比较。没有观察到本次改动引起的桌面渲染增加。

按 benchmark-checklist 检查：机器 10 核，开始 load average 8.02/6.19/8.82，有共享机器噪声；渲染对照交替五轮。弱网首屏主要等待资源下载的判断未经单独 profiler 隔离，因此只报告达标观测，不宣称提速或确定瓶颈。production 构建、成功响应、真实挂载行数和错误数均已检查。

## 状态与上限

手机外壳没有增加接口、订阅或数据缓存。列表 `Activity` 隐藏保留 DOM，切页共用原 fleet、query client、草稿与 staging；selector WeakMap 仍以 conversations/sessions 引用失效，缓存守卫测试通过。RailGroups 的 Completed 继续延迟挂载、分批显示；本轮没有解除已有接口/消息页上限。未新增失败缓存或随消息增长的 Map。草稿槽及全量快照仍沿用既有实现；真实账户一个月数据规模、初始快照体积和 SW 预缓存弱网开销未在本轮模拟，不能声称已验证其上限表现。

## 测试与未验证

先运行手机回归测试确认失败（首页自动选中、缺少返回、push 无标记），再实现；最终 `pnpm typecheck`、8 个相关测试文件共 178 条、production build 和 `git diff --check` 通过。包含 App、shell、right-rail、composer-wiring、route、sidebar-layout、mobile-shell、selectors-cache。

真机、PWA 系统返回、软键盘、真实远端/离线设备未验证；键盘 inset 和设置/新建整屏是 PR5 范围。
