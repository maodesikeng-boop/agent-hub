# Mac 分发版安装包（第一期：unsigned preview，arm64 DMG）

## 目标与边界

- 让没有本机仓库、没有装 Node 的人也能下载 DMG、拖进「应用程序」就能用 Bellwood。
- 这一期只做 Apple 芯片（arm64），ad-hoc 签名（不是 Developer ID），跟 Windows 一样标 `unsigned-preview`。
- 第二期（Developer ID 签名 + 公证）只需补密钥：签名身份、entitlements、公证 profile 已经做成环境变量（见「签名」）。
- **源码开发模式不变**：`bash scripts/build-mac-app.sh [--install]` 照旧产出指向本机仓库与本机 Node 的 `build/Bellwood.app`，Info.plist 与改动前逐字一致（`hub self-reload` 靠它）。分发是新增的 `--dist` 模式，产物在 `build/dist/`，不会装到 `/Applications`。
- 不在本期：Intel、自动更新、发版工作流与 README 下载说明（任务图后续步骤）。

## 包结构

```
Bellwood.app/Contents/
  MacOS/AgentHub                 Swift 外壳（arm64）
  Info.plist                     AgentHubRuntimeMode = bundled；不写 AgentHubRepoDir / AgentHubNodePath
  Resources/contract.json        共用监管约定
  Resources/runtime/             scripts/stage-mac-runtime.ts 组装
    node/bin/node                官方 Node v24.22.3 darwin-arm64（压缩包与 bin/node 双重 SHA-256 校验）
    node/bin/npm, npx            官方包里的相对软链
    node/lib/node_modules/npm/   Providers 一键安装 CLI、agent 跑 npx 用
    daemon/                      后端 TS 源码、migrations、contract.json、dist/web、平铺生产依赖
    runtime-manifest.json        版本、平台、Node 版本、官方 node 的 SHA-256
```

外壳怎么找运行环境：`DaemonSupervisor.swift` 里的 `DaemonRuntimeLocator`（纯函数，`SupervisorTests` 直接测）。

- `AGENT_HUB_REPO_DIR` / `AGENT_HUB_NODE` 环境变量两种模式都优先（排查用）。
- `bundled` 模式只认 `Contents/Resources/runtime/`，缺了就报“安装包不完整，请重新下载安装”，**绝不回退**到本机仓库或本机 Node（否则在开发机上会悄悄依赖本机环境，测不出问题）。
- `source` 模式（Info.plist 没写 `AgentHubRuntimeMode`）沿用原来的 UserDefaults → Info.plist → mise/Homebrew 顺序。

`hub` 命令：守护进程启动时照旧写 `<数据目录>/run/bin/hub`（`agent-api/shim.ts`），里面写死 `process.execPath`（即包内 Node）和包内 `src/hub/main.ts`，PM/Worker 会话的 PATH 最前面就是这个目录。不需要在包里另放 `hub`。实测 PM 会话里 `which hub` 指向它，`hub status` 正常返回。

## 统一（与 Windows 共用）

- **运行环境组装代码共用**：`scripts/stage-runtime-common.ts` 放两边共用的部分，`stage-win-runtime.ts` 改成调它（对外导出不变，原有测试不改照过）：
  - 锁定的 Node 版本与按平台的下载地址、SHA-256：`BUNDLED_NODE_VERSION` + `BUNDLED_NODE_ARCHIVES`（一处改版本，两个平台一起升）；
  - `downloadVerifiedArchive` / `assertFileSha256`：下载缓存与严格校验；
  - `stageDaemonTree`：daemon/ 的源码、migrations、contract.json、dist/web、精简 package.json、`pnpm install --prod` 平铺安装；
  - `pruneStagedNodeModules(dir, "win32" | "darwin-arm64" | "host")`：按目标平台裁剪（macOS 去掉 `@microsoft/mxc-sdk` 的 Windows 二进制，只留 `koffi-darwin-arm64`）；
  - `readDesktopAppVersion`：两个安装包同一个版本号（`apps/windows/Cargo.toml`）。
- 平台专属只剩各自的 Node 布局：Windows 是 `node/node.exe + npm.cmd`，macOS 是官方 `bin/ + lib/node_modules/npm` 布局（守护进程按 `<node 目录>/../lib/node_modules/npm/bin/npm-cli.js` 找 npm，`provider-manager/recipes.ts` 原本就支持）。
- **监管约定共用**：Swift 外壳与 Windows 外壳都读 `apps/desktop/contract.json`（启动预算、关机宽限、崩溃退避、日志位置），分发包把它拷进 `Resources/contract.json`，守护进程那份在 `runtime/daemon/apps/desktop/contract.json`。
- **自检对齐**：`AgentHub --self-test` 对应 Windows 的 `fusa-desktop.exe --self-test`：临时数据目录 + 空闲端口拉起守护进程，核对运行环境在包内、Node 版本与清单一致、npm 可用、未鉴权 401 / 鉴权后 200 且身份一致、`hub` 外壳指向包内并能跑、优雅关机后进程退出端口释放，打印 `[fusa-self-test] PASS …`。
- 产物命名、校验文件格式与 Windows 一致：`Bellwood_<版本>_arm64-unsigned-preview.dmg` + `.sha256`（`<hash>  <文件名>`）。

## 签名

`scripts/build-mac-app.sh --dist`：内层二进制先签（随包 `node` 带 `apps/macos/node.entitlements`，原生 `.node` 扩展），再签整个 `.app`，不用 `--deep` 签名（Apple 不建议），最后 `codesign --verify --deep --strict`。

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `MAC_SIGN_IDENTITY` | `-`（ad-hoc） | 填 `Developer ID Application: …` 时自动加 `--options runtime --timestamp`，DMG 名去掉 `-unsigned-preview` 并给 DMG 签名 |
| `MAC_NODE_ENTITLEMENTS` | `apps/macos/node.entitlements` | 取自官方 Node 构建的权限（JIT、加载原生扩展），去掉了公证不允许的 `get-task-allow` |
| `MAC_APP_ENTITLEMENTS` | 不用 | 主程序要权限时再给 |
| `MAC_NOTARY_PROFILE` | 不设 | `notarytool` keychain profile；设了且身份不是 `-` 才公证并 staple |

未签名预览版首次打开会被 Gatekeeper 拦下：「系统设置 → 隐私与安全性」点「仍要打开」。实测：被隔离（quarantine）的包直接执行会被系统杀掉（退出码 137）；包目录带上「用户已批准」标记后（`仍要打开` 写的就是它），包内仍带隔离标记的 `node` 照常能起，自检 PASS——不用逐个文件去掉隔离。

## DMG

`hdiutil create -srcfolder <含 Bellwood.app 与 /Applications 软链的目录> -fs HFS+ -format ULMO`（LZMA，macOS 10.15+ 可挂载，本应用最低 13.0）。没用 `hdiutil makehybrid`：它会给文件加 `com.apple.FinderInfo`，`codesign --strict` 不过。

注意：`-srcfolder` 要临时挂载一个可写映像。装了 MDM 并强制磁盘映像只读挂载的机器（比如本机）上这一步会报“只读文件系统”，.app 已经签好在 `build/dist/Bellwood.app`；DMG 以 CI（GitHub macOS runner）产物为准。

## 性能

| 项 | 数 | 怎么量的 |
| --- | --- | --- |
| 包内运行环境（未压缩） | 171 MiB：Node 117 MiB、npm 13 MiB、daemon 56 MiB（node_modules 35、dist/web 17、src 4） | `stage-mac-runtime` 输出、`du` |
| Bellwood.app（未压缩） | 172–191 MiB（本机 / CI runner 的 `du` 块大小不同） | `du -sh build/dist/Bellwood.app` |
| DMG（ULMO） | 41.3 MiB（43,332,424 字节，CI 实测） | `stat -f %z`；CI 上限 60 MiB（`DMG_BUDGET_MIB`），超了失败 |
| 守护进程冷启动（拉起 → `/api/auth/status` 有响应） | 包内 0.77–0.82 s，源码模式同机 0.80–0.83 s，没有变慢；CI runner 1.15 s | 本机各 3 次；自检 `startupMs`（本机约 0.81 s） |
| 优雅关机 | 约 0.16 s | 自检 `shutdownMs` |

体积大头是官方 Node 本身（117 MiB，已是 strip 过的官方构建），压缩后 DMG 仍小于 Windows 安装包的 60 MiB 上限。守护进程跑 TS 源码（Node 24 原生去类型），冷启动和源码模式一样，暂不需要 V8 编译缓存。

## CI

`.github/workflows/mac-desktop.yml`（`macos-15`，Apple 芯片）：装依赖 → `pnpm build` → 打包相关单测（含 Swift 监管契约测试）→ `build-mac-app.sh --dist` → 挂载 DMG、把 app 拷到临时目录、核验签名与架构、Info.plist 不含本机路径 → 在 `env -i`（PATH 里没有 node、HOME 是空目录）下跑 `--self-test` → DMG 体积上限与 SHA-256 校验 → 上传产物（14 天）。

## 发布到 GitHub Release

`.github/workflows/release.yml`：推 `v*` 标签 → 建 Release 并挂上两平台安装包。`mac-desktop.yml` 与 `windows-desktop.yml` 加了 `workflow_call`，发布工作流用 `uses: ./.github/workflows/…` 直接复用，构建步骤只有一份。

流程：`verify`（标签版本 = `apps/windows/Cargo.toml` 版本 = `tauri.conf.json` 版本，不一致就在构建前失败）→ `windows` 与 `mac` 两个复用构建并行 → `assemble`（改成固定文件名、核对并重写 `.sha256`、上传 `fusa-release-assets`）→ `publish`（只有标签触发才跑，也是唯一有 `contents: write` 的任务）。代码在 `scripts/release-assets.ts`，有单测。

- **固定文件名**：`Bellwood-macos-arm64.dmg`、`Bellwood-windows-x64-setup.exe`（各带 `.sha256`）。不含版本号，也不含 `unsigned-preview`，所以 `releases/latest/download/<文件名>` 永远指向最新正式版，第二期签名公证后链接也不用改。版本号看 Release 的标签。
- **latest 与预发布**：GitHub 的 `releases/latest` 只算最新的正式（非预发布、非草稿）Release。所以 README 固定链接要求 Release 不能标预发布。标签 `vX.Y.Z` 发正式版（`--latest`），“未签名预览”写在标题 `Bellwood vX.Y.Z (unsigned preview)` 和发布说明（`.github/release-notes.md`，含 Mac 的「仍要打开」步骤）里；标签带后缀（`vX.Y.Z-rc.1`）自动标预发布，不会成为 latest，用来先试发。第一个正式 Release 发出之前，README 的下载链接是 404。
- **试运行**：`workflow_dispatch` 和改到发布文件的 PR 只跑到 `assemble`，不建 Release；组装好的文件在产物 `fusa-release-assets` 里（14 天）。
- **重跑**：同一标签的 Release 已存在时，`publish` 改为 `gh release upload --clobber` 刷新文件，不重复建。
- **发版步骤**：改版本号（`apps/windows/Cargo.toml` 与 `tauri.conf.json`）合进 main → 在 main 上 `git tag vX.Y.Z && git push origin vX.Y.Z`。
- **第二期**：签名用 `MAC_SIGN_IDENTITY` / `MAC_NOTARY_PROFILE`（见上文“签名”），还需在 `mac-desktop.yml` 里加导入证书到 runner 钥匙串的步骤；发布工作流不用改。
- 发布的 DMG 一律由 CI 打（本机有 MDM 只读挂载限制，做不出 DMG）。
