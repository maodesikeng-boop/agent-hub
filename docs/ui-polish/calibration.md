# 评委校准报告

- 校准轮次：`C2`
- 截图提交：`4550f6cd9d60195959dad485da45b851bebe866e`（chromium 159.0.8154.6）
- 正式评审批大小：`28`

## 批大小 28 张（通过）

- 两家页面分一致率（差 ≤ 1）：100.0%
- 基准图 P0 发现：0 条
- 基准图页面分（agy/gemini-4-carbon）：6
- 基准图页面分（claude/opus）：6
- 复评稳定率（agy/gemini-4-carbon）：100.0%
- 复评稳定率（claude/opus）：100.0%

| 弄坏 | 评委 | 注入的项 | 这一项 基准 → 弄坏（封顶） | 命中次数 | 结果 |
| --- | --- | --- | --- | --- | --- |
| `clip-right` | agy/gemini-4-carbon | 行业标准 | 6 → 4（4） | 3/3 | 合格 |
| `covered-message` | agy/gemini-4-carbon | 行业标准 | 6 → 4（4） | 3/3 | 合格 |
| `low-contrast` | agy/gemini-4-carbon | 行业标准 | 6 → 4（4） | 3/3 | 合格 |
| `misalign` | agy/gemini-4-carbon | 美学 | 7 → 6（6） | 2/3 | 合格 |
| `gradient-shadow` | agy/gemini-4-carbon | 风格一致 | 9 → 6（6） | 3/3 | 合格 |
| `cramped` | agy/gemini-4-carbon | 风格一致 | 9 → 6（6） | 3/3 | 合格 |
| `two-primaries` | agy/gemini-4-carbon | 美学 | 7 → 6（6） | 3/3 | 合格 |
| `small-preview` | agy/gemini-4-carbon | 风格一致 | 9 → 6（8） | 3/3 | 合格 |
| `dot-suffix` | agy/gemini-4-carbon | 风格一致 | 9 → 6（8） | 3/3 | 合格 |
| `radius-mix` | agy/gemini-4-carbon | 风格一致 | 9 → 6（8） | 3/3 | 合格 |
| `clip-right` | claude/opus | 行业标准 | 6 → 4（4） | 3/3 | 合格 |
| `covered-message` | claude/opus | 行业标准 | 6 → 4（4） | 3/3 | 合格 |
| `low-contrast` | claude/opus | 行业标准 | 6 → 4（4） | 3/3 | 合格 |
| `misalign` | claude/opus | 美学 | 7 → 6（6） | 2/3 | 合格 |
| `gradient-shadow` | claude/opus | 风格一致 | 8 → 6（6） | 3/3 | 合格 |
| `cramped` | claude/opus | 风格一致 | 8 → 6（6） | 3/3 | 合格 |
| `two-primaries` | claude/opus | 美学 | 7 → 6（6） | 3/3 | 合格 |
| `small-preview` | claude/opus | 风格一致 | 8 → 6（8） | 3/3 | 合格 |
| `dot-suffix` | claude/opus | 风格一致 | 8 → 6（8） | 3/3 | 合格 |
| `radius-mix` | claude/opus | 风格一致 | 8 → 6（8） | 3/3 | 合格 |

## 结论

### 基准图真实得分

基准图 `chat.normal@desktop` 两家 6 次评分，页面分都是 6 分，落在用户给的 6～7 分里，也落在校准要求的 6～8 分里。四项中位数：

| 评委 | 风格一致 | 行业标准 | 美学 | 体验 | 页面分 |
| --- | --- | --- | --- | --- | --- |
| agy/gemini-4-carbon | 9 | 6 | 7 | 7 | 6 |
| claude/opus | 8 | 6 | 7 | 8 | 6 |

拉低页面分的是行业标准这一项：左栏灰字 #71717a 和拍板卡 Recommended 的半透明白字对比度不到 4.5:1，axe 在这张图上量出 14 处，最低 3.73:1，两家每次都记了 P1。美学 7 分，扣在留白、层级这类 P2 上。风格一致 8～9 分，说明基准图只管气质不跑偏，不再当 9 分样板。基准图上没人记 P0。

### 两家一致率

16 张图两家页面分中位数相差都不超过 1 分，一致率 100%（门槛 80%）。

### 复评稳定度

两家各评 3 次，16 张图的页面分 3 次之内最大差都不超过 1 分，稳定率两家都是 100%。

### 检出率

10 个弄坏两家都判合格，P0、P1 的 7 个弄坏两家都抓到了，检出率 7/7。`misalign` 两家都是 3 次抓到 2 次，刚过最少命中次数。

### 这一轮改的算分口径

上一次校准（Worker #664）退出码 1，原因在算分代码里，评委本身没有漏看。这次只改了 `test/ui-polish/score.ts`，门槛数字没动，评委也没重跑：

- P0 命中不看算在哪一项：`covered-message` 两家 6 次都在目标位置记了 P0，但引的是 U3/U5，旧代码要求必须算在行业标准这一项，结果判成 0 次命中。P0 本来就不分项、四项一起封顶，现在预期 P0 的弄坏只看严重度和位置。
- 同一张图上同一条规则只算一条：一家（或机器检查）在同一张图上引同一条规则的几条，只留最重的一条。`WCAG 1.4.3` 和 `machine:contrast` 算同一条规则，`HIG touch-44` 和 `machine:touch-target` 也算同一条。claude 第 2、3 次把基准图的对比度拆成两条 P1，之前行业标准被压到 5 分，现在按一条算是 6 分。正式轮合分和校准用的是同一套归并，axe 在一屏上量出的十几条对比度问题也不会再把这一项压到 4 分。
