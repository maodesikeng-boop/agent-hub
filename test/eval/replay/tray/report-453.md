已完成 `#/router` 手机外壳下 `Needs You` 托盘高度上限调整并提好 PR（未合并）。

### PR 与改动文件
- **PR**：https://github.com/maodesikeng-boop/agent-hub/pull/288
- **改动文件**：
  1. `src/web/components/RouterWorkbench.tsx`（`RouterNeedsYouTray`、`RouterWorkbench`）：沿用工作台现有的 `MOBILE_SHELL_QUERY`（`src/web/useMediaQuery.ts`）断点将 `mobile` 传入托盘，手机外壳用 `max-h-[33dvh]`、桌面端保持 `max-h-[50dvh]`，内部滚动与首张展开 / 其余单行逻辑不变。
  2. `docs/ui-standard.md`（第 508 行）：同步更新第 21 条（桌面最高 `50dvh`、手机外壳最高 `33dvh`）。
  3. `src/web/router-workbench.test.tsx`：补充桌面端不含 `33dvh` 守卫，并新增手机断点下托盘使用 `max-h-[33dvh]`、保持内部滚动及首卡展开/其余单行的测试。

### 实拍截图（3 条待拍板）
- 手机 `390×844`：`{SHOTS}/mobile-router-390x844.png`（滚动区 `clientHeight = 279px`、`scrollHeight = 478px` 可在托盘内滚动，顶栏下可用高度中时间流与底部区域占 `429 / 774 ≈ 55.4%` 约六成高度，`overflowX = 0`）
  ![手机 390×844 实拍]({SHOTS}/mobile-router-390x844.png)
- 桌面 `1440×900`：`{SHOTS}/desktop-router-1440x900.png`（保持 `max-h-[50dvh]` 不变，3 条待拍板完整展示，`overflowX = 0`）
  ![桌面 1440×900 实拍]({SHOTS}/desktop-router-1440x900.png)

### 跑过的测试
- `pnpm typecheck`：通过
- `pnpm vitest run src/web/router-workbench.test.tsx src/web/devices.test.tsx src/web/right-rail.test.tsx`：3 个文件 89 条用例全过
- `pnpm vitest run src/web/ui/ui-standard.test.tsx src/web/ui-scale.test.tsx src/web/web-guard.test.ts src/web/selectors-cache.test.ts`：4 个守卫文件 44 条用例全过
- `pnpm build`：通过

=== 汇报 ===
状态: 做完了
摘要: 手机外壳（MOBILE_SHELL_QUERY）下 Needs You 托盘上限降为 33dvh、桌面保持 50dvh，同步更新 ui-standard.md 第 21 条与单测，完成双端无头浏览器实拍并提 PR #288。
提交: da36ed7
测试: pnpm typecheck 通过；vitest 跑 router-workbench.test.tsx / devices.test.tsx / right-rail.test.tsx（89 条）及 ui-standard / ui-scale / web-guard / selectors-cache（44 条）全过；pnpm build 及本机无头 Chrome 390×844 与 1440×900 实拍验证通过。
问题: 无
=== 汇报结束 ===
