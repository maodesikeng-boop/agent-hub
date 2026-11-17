// Slack 令牌（state/slack-secrets.json，权限 SLACK_SECRETS_FILE_MODE）。
// 不在数据库里：只读 Worker 能读库，读不到这个文件（实现步骤把它加进 readonly-policy.ts 的 READONLY_SECRET_STATE_FILES）。

export interface SlackSecrets {
  /** xoxb- 开头。 */
  botToken: string;
  /** xapp- 开头，带 connections:write。 */
  appToken: string;
}

/** 后置：文件不在返回 null；内容坏了也返回 null（当没配过）。发现权限比 0600 宽就改回来。 */
export function readSlackSecrets(file: string): SlackSecrets | null {
  throw new Error("未实现");
}

/** 后置：原子写入（同目录临时文件 + rename，用已有的 write-file-atomic），权限 0600。 */
export function writeSlackSecrets(file: string, secrets: SlackSecrets): Promise<void> {
  throw new Error("未实现");
}

/** 后置：文件删掉；本来就没有不报错。 */
export function removeSlackSecrets(file: string): void {
  throw new Error("未实现");
}

/** 后置：两个令牌前缀都对返回 null，否则返回给人看的原因。只看形状，不连 Slack。 */
export function slackSecretsShapeError(secrets: SlackSecrets): string | null {
  throw new Error("未实现");
}
