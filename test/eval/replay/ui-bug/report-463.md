已按 TDD 流程定位根源并完成修复，PR 已提交：https://github.com/maodesikeng-boop/agent-hub/pull/295

### 根源与修法
1. **紧凑果皮轨同链连续 + 多泳道分道布线**（[PeelTrack.tsx](~/.agent-hub/worktrees/7/463/src/web/components/PeelTrack.tsx)）：
   - 旧版按正向拓扑层（rank）打平并逐层合回主轨 `x=11`，使两条在 `s2` 才汇合的多步链交错排布并产生完全二分图式假连线；3 路及以上并行时固定双轨还会把第 2、3 股串在同一条竖线上。
   - 改为 `git log --graph --topo-order` 组合方案：先在 [`reduceTransitiveEdges`](~/.agent-hub/worktrees/7/463/src/web/components/PeelTrack.tsx#L510-L550) 做传递约简（去掉已被更长有向路径覆盖的跨层冗余弦边如 `s1 -> s2`），再用 [`orderComponentNodes`](~/.agent-hub/worktrees/7/463/src/web/components/PeelTrack.tsx#L557-L642) 按链优先拓扑序把汇合前的同一条多步链挨着排，最后由 [`layoutDisplayTrack`](~/.agent-hub/worktrees/7/463/src/web/components/PeelTrack.tsx#L715-L903) 为每个仍有未渲染下游的上游节点分配独立平行泳道（1～2 股 `2.5rem`，3 股起按 `+0.875rem` 自适应加宽、封顶 `6rem`），保证**画出的每一条线段都严格对应一条真实依赖**。
   - [`PeelStageRow`](~/.agent-hub/worktrees/7/463/src/web/components/PeelTrack.tsx#L344-L501) 支持 `waiting_user` 门禁水果刀落在任意泳道，并用 `calc(100% - 2rem)` 延伸层将所有在途泳道不断线贯穿拍板卡左侧；[`canFoldDonePrefix`](~/.agent-hub/worktrees/7/463/src/web/components/PeelTrack.tsx#L906-L930) 防止 `N done` 把尚未汇合的独立旁链吞进同一个果皮卷。
2. **放大全览弹窗跨层长边避障**（[task-graph-layout.ts](~/.agent-hub/worktrees/7/463/src/web/task-graph-layout.ts)）：
   - 实拍检查弹窗发现图 #6 的跨层边 `s1 -> s2` 直连三次贝塞尔横穿了 `第 1 步审查` 卡片正文；新增 [`directLrCurveHitsBox`](~/.agent-hub/worktrees/7/463/src/web/task-graph-layout.ts#L389-L405) 与 [`buildMultiPointLrSplineAndArrow`](~/.agent-hub/worktrees/7/463/src/web/task-graph-layout.ts#L407-L423)，当跨层边直连擦碰中间卡片时沿 Dagre 分层方向从卡片外侧平滑绕行，单层边零改动。

### 改动文件名单
- [docs/ui-standard.md](~/.agent-hub/worktrees/7/463/docs/ui-standard.md)
- [src/web/components/PeelTrack.tsx](~/.agent-hub/worktrees/7/463/src/web/components/PeelTrack.tsx)
- [src/web/task-graph-layout.ts](~/.agent-hub/worktrees/7/463/src/web/task-graph-layout.ts)
- [src/web/task-graph-rail.test.tsx](~/.agent-hub/worktrees/7/463/src/web/task-graph-rail.test.tsx)
- [src/web/task-graph-layout.test.ts](~/.agent-hub/worktrees/7/463/src/web/task-graph-layout.test.ts)

### 新增与更新测试名
- [task-graph-rail.test.tsx](~/.agent-hub/worktrees/7/463/src/web/task-graph-rail.test.tsx)：
  - `任务图 #6 真实形状：两条多步并行链在汇合前各自连续排布并分道并行，任何连线都对应真实依赖（含 waiting_user 门禁）`
  - `三路不等长并行链再汇总：分三道并行且多步子链连续排布，无假串联，轨槽自适应加宽仍走 rem`
  - `N done 折叠边界守卫：链 A 已完成但链 B 仍在等待拍板时，只把链 A 卷成 2 done，不把链 B 的已完成起点吞进同一个果皮卷`
  - `一张图含 3 个互不相连的子图（独立单步 + 三步含门禁链 + 双起点合流）：分组排布，子图之间不画任何假连线`
  - `首层 %i 个无上游并行起点合流到同一下游：分道并行、无断头悬空线、无假串联`
  - `单连通子图：%s 严格按真实依赖分轨合流，无假连线、无悬空线`
- [task-graph-layout.test.ts](~/.agent-hub/worktrees/7/463/src/web/task-graph-layout.test.ts)：
  - `放大弹窗（dialog LR）：任务图 #6 跨层长边 s1->s2 沿 Dagre 哑节点绕开中间卡片 s1-review，不横穿卡片正文`

### 本机无头浏览器实拍图（修前 / 修后）

1. **任务图 #6 形状**
   - 修前：`~/.gemini/antigravity-cli/brain/52f1c1ef-1e23-4038-94a6-1a6d3d87d697/screenshots/1-graph6-before.png`
   - 修后：`~/.gemini/antigravity-cli/brain/52f1c1ef-1e23-4038-94a6-1a6d3d87d697/screenshots/1-graph6-after.png`

![图6修前](~/.gemini/antigravity-cli/brain/52f1c1ef-1e23-4038-94a6-1a6d3d87d697/screenshots/1-graph6-before.png)
![图6修后](~/.gemini/antigravity-cli/brain/52f1c1ef-1e23-4038-94a6-1a6d3d87d697/screenshots/1-graph6-after.png)

2. **三路并行再汇总**
   - 修前：`~/.gemini/antigravity-cli/brain/52f1c1ef-1e23-4038-94a6-1a6d3d87d697/screenshots/2-three-way-before.png`
   - 修后：`~/.gemini/antigravity-cli/brain/52f1c1ef-1e23-4038-94a6-1a6d3d87d697/screenshots/2-three-way-after.png`

![三路修前](~/.gemini/antigravity-cli/brain/52f1c1ef-1e23-4038-94a6-1a6d3d87d697/screenshots/2-three-way-before.png)
![三路修后](~/.gemini/antigravity-cli/brain/52f1c1ef-1e23-4038-94a6-1a6d3d87d697/screenshots/2-three-way-after.png)

3. **两张独立的子图**
   - 修前：`~/.gemini/antigravity-cli/brain/52f1c1ef-1e23-4038-94a6-1a6d3d87d697/screenshots/3-subgraphs-before.png`
   - 修后：`~/.gemini/antigravity-cli/brain/52f1c1ef-1e23-4038-94a6-1a6d3d87d697/screenshots/3-subgraphs-after.png`

![独立子图修前](~/.gemini/antigravity-cli/brain/52f1c1ef-1e23-4038-94a6-1a6d3d87d697/screenshots/3-subgraphs-before.png)
![独立子图修后](~/.gemini/antigravity-cli/brain/52f1c1ef-1e23-4038-94a6-1a6d3d87d697/screenshots/3-subgraphs-after.png)

4. **菱形（分叉后再汇合）**
   - 修前：`~/.gemini/antigravity-cli/brain/52f1c1ef-1e23-4038-94a6-1a6d3d87d697/screenshots/4-diamond-before.png`
   - 修后：`~/.gemini/antigravity-cli/brain/52f1c1ef-1e23-4038-94a6-1a6d3d87d697/screenshots/4-diamond-after.png`

![菱形修前](~/.gemini/antigravity-cli/brain/52f1c1ef-1e23-4038-94a6-1a6d3d87d697/screenshots/4-diamond-before.png)
![菱形修后](~/.gemini/antigravity-cli/brain/52f1c1ef-1e23-4038-94a6-1a6d3d87d697/screenshots/4-diamond-after.png)

5. **放大弹窗图 #6 跨层边绕行（附验）**
   - 修前：`~/.gemini/antigravity-cli/brain/52f1c1ef-1e23-4038-94a6-1a6d3d87d697/screenshots/dialog-graph6-before.png`
   - 修后：`~/.gemini/antigravity-cli/brain/52f1c1ef-1e23-4038-94a6-1a6d3d87d697/screenshots/dialog-graph6-after.png`

![弹窗修前](~/.gemini/antigravity-cli/brain/52f1c1ef-1e23-4038-94a6-1a6d3d87d697/screenshots/dialog-graph6-before.png)
![弹窗修后](~/.gemini/antigravity-cli/brain/52f1c1ef-1e23-4038-94a6-1a6d3d87d697/screenshots/dialog-graph6-after.png)

=== 汇报 ===
状态: 做完了
摘要: 采用传递约简 + 链优先拓扑序 + 源点独占多泳道布线修复果皮轨多步并行链交错假连线与三路并行假串联，并顺带修复放大弹窗图 #6 跨层长边穿卡问题，已提 PR #295。
提交: d67d224
测试: pnpm typecheck 通过；vitest 跑完 task-graph-rail.test.tsx、task-graph-layout.test.ts、task-graph-app.test.tsx、right-rail.test.tsx、selectors-cache.test.ts、ui-scale.test.tsx、web-guard.test.ts、write-scope.test.ts 共 8 个文件 128 项全过；无头 Chrome 实拍核验 4 组紧凑轨及全览弹窗修前修后截图。
问题: 无
=== 汇报结束 ===
