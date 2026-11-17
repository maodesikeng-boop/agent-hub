# 总助的项目目录：示例

> 配合 `docs/router-project-catalog-design.md` 看。第 2 节的档案是 2026-11-17 用 `claude -p --model haiku` 实跑出来的（输入是本仓库 `README.md`、`AGENTS.md` 各前 4000 字，模拟一个刚建、还没聊过的项目首次建档），只把超长的“一句话”按上限截到 80 字。其余项目名、编号是示意。

## 1. 总助每次看到的名片（第一层）

### 现在

```
### PM #9 项目经理A [device=self | activity=working | pending=1]
- project: #7 agent-hub (/Users/me/agent-hub)
- summary: Providers 一键安装登录……已合入上线 | 共同维护者 / 界面审美去廉价感 | 收到，盖子已打开……
- activePieces (2): #641「方案与骨架」[working]；#642「修小问题」[idle]

### PM #12 项目经理B [device=self | activity=idle | pending=0]
- project: #10 mercury (/Users/me/mercury)
- activePieces (0): 无
```

`summary` 是三样东西拼的：项目经理手写的备忘（11 个项目里只有 1 个写过，还是旧的）、项目经理性格设定的前几行（写的是用户偏好，不是项目介绍）、最后一句回复。`mercury` 这种代号项目，总助只看得到名字。

### 改完

```
### PM #9 项目经理A [device=self | activity=working | pending=1]
- project: #7 agent-hub (/Users/me/agent-hub)
- 做什么: 给用户自己用的多 agent 系统：总助（Router）加每个项目一个项目经理，再派 Worker 进独立 git worktree 并行干活，每个角色可选不…
- 别名: agent-hub、Fusa
- 主线: 后台自动维护项目目录，让总助认得每个项目
- 最近: 方案 PR 已开，等用户拍板
- 档案: 3 小时前更新（细节：hub dispatch project-show --device self --project 7）
- activePieces (2): #641「方案与骨架」[working]；#642「修小问题」[idle]

### PM #12 项目经理B [device=self | activity=idle | pending=0]
- project: #10 mercury (/Users/me/mercury)
- 说明: 会议录音转文字（用户写的）
- 做什么: 把会议录音转成带说话人的文字稿，再出摘要
- 别名: mercury、语音转文字、会议纪要
- 主线: 换成本地 Whisper 模型，降低延迟
- 最近: Worker #88 做完说话人分离
- 档案: 1 天前更新（细节：hub dispatch project-show --device self --project 10）
- activePieces (0): 无
```

用户说“改一下语音转文字那个项目”，总助在别名里就能对上 `mercury`。还没建档的项目写“档案: 未建档”，用户写过说明的照样显示说明。

名片放不下时（项目很多）压成一行，也带“做什么”的前 40 字：

```
- PM #12 项目经理B | device=self | project=#10 mercury | 做什么=把会议录音转成带说话人的文字稿，再出摘要 | activePieces=0 | pending=0
```

## 2. 总助按需展开的档案（第二层）

总助看第一层拿不准，或用户追问细节时，调一次：

```
$ hub dispatch project-show --device self --project 7
```

输出（上面实跑的档案）：

```markdown
# 项目 #7 agent-hub（本机）

- 做什么：给用户自己用的多 agent 系统：总助（Router）加每个项目一个项目经理，再派 Worker 进独立 git worktree 并行干活，每个角色可选不…
- 别名：agent-hub、Fusa
- 主线：材料没有写明当前主线。现阶段是先在这台 Mac 上试跑，设计背景和下一步在主文件夹的 HANDOVER.md。

## 核心模块
- 总助（Router）：用户的总入口，判断一句话该交给哪个项目，不直接做项目里的事。
- 项目经理（PM）：每个项目一个，用户在一个对话里和它定目标、拍板；它拆任务、派 Worker、审 diff 和测试结果、合 PR。
- Worker：PM 用 hub worker start 派出的执行单元，在自己的 git worktree 和分支里做活，界面上叫 Pieces。
- 守护进程（daemon）：后端服务，提供 HTTP 与 WebSocket 接口，管理各角色的 agent 会话、数据库和缓存。
- 网页界面与桌面外壳：网页界面基于 React，桌面外壳有 macOS 原生 Fusa.app 与 Windows 版，手机可通过浏览器或 PWA 查看与回复。

## 已定的事
- 每个项目只对接一个项目经理，总助负责分流，Worker 不占用左侧会话列表。
- 每个角色（总助、PM、Worker）可独立选择命令行 agent（claude、agy、codex 等）和账号或 API key。
- Worker 各自在独立 git worktree 中工作，完成后合并进 main 或 3 天后自动清理。
- 开发优先用行业成熟的第三方库与标准组件，不手搓基础轮子。

## 悬着的事
无

（档案写于 2026-11-17 11:30，覆盖到消息 #69647）
```

这是只读了说明文件的首次建档。真实的存量老项目首次建档还会带上最新一份交接和最近 3 万字原话，“主线”“已定的事”会具体得多；之后每次增量刷新都在上一版上改。

总助看不到原始对话。名片和档案都回答不了的细节，照现在的规矩转给项目经理去查。

## 3. 后台什么时候写档（示意时间线）

```
09:00  守护进程启动 → 扫 11 个活跃项目（实测 16 毫秒）
       · 还没档案的 11 个全部进队列 → 后台一个一个写（每个十几秒），总助照常用
09:03  全部建档完成
10:40  用户新建项目 mercury → 同一个事务里进队列 → 十几秒后有档案
11:15  agent-hub 项目经理一轮结束 → 算切点之后的加权字数 = 23,400 ≥ 20,000，离上次 > 2 小时 → 进队列 → 刷新
11:50  agent-hub 又一轮结束 → 加权字数 4,100，不到门槛 → 什么都不做
14:20  agent-hub 一张任务图 graph finish → 记“要刷新”，离上次已 3 小时 → 进队列 → 刷新
```

按本机过去 7 天的真实对话回放，这个节奏一周约刷新 48 次（最忙的项目占 38 次），其余项目一周 0 到 3 次。
