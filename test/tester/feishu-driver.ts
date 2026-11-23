// Acts as the bench owner in Feishu. Sending uses a separate driver app with a user_access_token
// (scopes im:message and im:message.send_as_user); reading uses the test bot's tenant token, which already holds
// im:message:readonly and im:message.group_msg.
// Invariant: sendAsUser posts only into chats the test bot belongs to, because a user token can post anywhere the owner can,
// including the owner's real project groups.
// Invariant: Feishu rotates the refresh token on every refresh and voids the old one, so the new token is written to disk
// before the new access token is used, and only one process refreshes at a time.

export interface DriverTokens {
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string;
  refreshExpiresAt: number;
}

export interface FeishuDriverOptions {
  driverAppId: string;
  /** File holding the driver app secret and DriverTokens, mode 0600. */
  driverSecretsFile: string;
  testBotAppId: string;
  /** The test bot's credentials file inside a test instance's data dir. */
  botSecretsFile: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface FeishuMessage {
  messageId: string;
  chatId: string;
  senderType: "user" | "app";
  senderId: string;
  msgType: string;
  createTime: number;
  updateTime: number;
  deleted: boolean;
  updated: boolean;
  /** Raw content; for cards, the original card JSON (card_msg_content_type=user_card_content). */
  content: string;
}

export interface TestChat {
  chatId: string;
  kind: "router" | "project";
  /** From the group description marker, for project groups. */
  deviceId?: string;
  pmId?: number;
}

export class FeishuGuardError extends Error {}
export class FeishuApiError extends Error {
  readonly status: number;
  readonly code: number;
  constructor(message: string, status: number, code: number) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface FeishuDriver {
  /** Postcondition: chats the test bot is a member of: its 1-on-1 chat with the owner and its project groups. */
  testChats(): Promise<TestChat[]>;
  /** Throws FeishuGuardError when `chatId` is not in testChats(). Postcondition: the id of the message Feishu stored, sent as the owner. */
  sendAsUser(chatId: string, text: string): Promise<string>;
  /** Postcondition: messages created at or after `sinceMs`, oldest first, including deleted ones with deleted=true. */
  listMessages(chatId: string, sinceMs: number): Promise<FeishuMessage[]>;
  /** Postcondition: the first message from the test bot after `afterMessageId` that satisfies `done`; rejects on timeout with the messages seen so far. */
  waitForBotMessage(chatId: string, afterMessageId: string, done: (m: FeishuMessage) => boolean, timeoutMs: number): Promise<FeishuMessage>;
}

/**
 * Precondition: the driver secrets file holds tokens from authorizeDriver.
 * Postcondition: a driver whose access token is valid for at least TESTER_FEISHU_TOKEN_SKEW_MS.
 * Throws FeishuApiError with code 20037 when the refresh token expired (365 days after authorization), which the caller reports as a bench problem.
 */
export async function createFeishuDriver(options: FeishuDriverOptions): Promise<FeishuDriver> {
  throw new Error("Not implemented");
}

/**
 * One-time authorization, run by the owner outside any sandbox: opens the Feishu consent page with
 * scopes im:message, im:message.send_as_user, offline_access, receives the code on a loopback redirect, and writes DriverTokens.
 * Postcondition: the secrets file exists with mode 0600 and its refresh token is fresh.
 */
export async function authorizeDriver(options: { driverAppId: string; driverSecretsFile: string; redirectPort: number; openUrl: (url: string) => void }): Promise<void> {
  throw new Error("Not implemented");
}

/** Postcondition: true for a message the client shows as "recalled": deleted, or content equal to Feishu's recalled placeholder. */
export function isRecalled(message: Pick<FeishuMessage, "deleted" | "content">): boolean {
  throw new Error("Not implemented");
}

/** Postcondition: the visible text of a card or text message, with markdown and card structure removed; empty for media. */
export function visibleText(message: Pick<FeishuMessage, "msgType" | "content">): string {
  throw new Error("Not implemented");
}
