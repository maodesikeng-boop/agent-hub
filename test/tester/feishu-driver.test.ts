import { describe, it } from "vitest";

describe("createFeishuDriver", () => {
  it.todo("refreshes the user token when it expires within TESTER_FEISHU_TOKEN_SKEW_MS");
  it.todo("writes the rotated refresh token to disk before using the new access token");
  it.todo("keeps the secrets file at mode 0600");
  it.todo("reports refresh token expiry (code 20037) as a FeishuApiError");
});

describe("sendAsUser", () => {
  it.todo("refuses a chat the test bot is not a member of with FeishuGuardError");
  it.todo("sends with the user token and returns the stored message id");
});

describe("listMessages and waitForBotMessage", () => {
  it.todo("reads with the test bot's tenant token and asks for the original card JSON");
  it.todo("returns deleted messages with deleted=true");
  it.todo("pages oldest first until no more pages remain");
  it.todo("resolves with the first test bot message after the given one that satisfies the predicate");
  it.todo("rejects on timeout with the messages seen so far");
});

describe("testChats", () => {
  it.todo("lists the router chat and project groups with device and PM parsed from the group description marker");
});

describe("isRecalled and visibleText", () => {
  it.todo("treats deleted messages and the recalled placeholder as recalled");
  it.todo("extracts card body text and plain text, and returns empty text for media");
});
