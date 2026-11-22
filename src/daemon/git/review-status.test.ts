import { describe, it } from "vitest";

describe("parseGithubPrUrl", () => {
  it.todo("解析 github.com 的 PR 链接为 host、owner、repo");
  it.todo("解析 GitHub Enterprise 主机的 PR 链接");
  it.todo("GitLab 合并请求、Gitee 等别家链接和乱写的字符串返回 null");
});

describe("redactGithubTokens", () => {
  it.todo("把 ghp_、gho_、ghu_、ghs_、ghr_、github_pat_ 形状的令牌换成占位符，别的文字不动");
});

describe("describeStatusFailure", () => {
  it.todo("gh 没装、没登录、指定账号没登录各给一句跳过原因，原因里有账号名、没有令牌");
  it.todo("不是 git 仓库、远端都不在 GitHub 上时给“不在 GitHub”的跳过原因");
  it.todo("403、404 给“账号没有写提交状态的权限”，422 给“提交没推到 GitHub”");
  it.todo("超时、网络错误、5xx 返回 retry");
});

describe("postReviewStatus", () => {
  it.todo("有 GitHub PR 时向 PR 所在仓库 POST statuses/<sha>，带 state、context、description，不带 target_url 以外的多余字段");
  it.todo("PR 链接不在 GitHub 上时安静跳过，不调用 gh");
  it.todo("没有 PR 时用 gh 的 {owner}/{repo} 占位符，在项目主文件夹里解析远端");
  it.todo("配了账号时先跑 gh auth token --user <账号>（有 PR 时加 --hostname），令牌只经 GH_TOKEN 传给 gh api，从不出现在参数里");
  it.todo("没配账号时不跑 gh auth token，也不设 GH_TOKEN，用 gh 当前账号");
  it.todo("gh auth token 失败时跳过并写明哪个账号没登录");
  it.todo("可重试的失败抛 ReviewStatusRetryableError，消息里没有令牌");
  it.todo("跳过原因截到 MAX_REVIEW_STAMP_REASON_CHARS，并去掉令牌形状的文字");
  it.todo("成功时返回 posted，带 sha、state 和账号名");
});

describe("postReviewStatus：真 gh 与真仓库（不联网）", () => {
  it.todo("没有 git 的文件夹里安静跳过，原因写进结果");
  it.todo("只有本地仓库、没有远端时安静跳过");
  it.todo("远端指向非 GitHub 主机时安静跳过");
});
