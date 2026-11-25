import { describe, it } from "vitest";

describe("normalizeAppId", () => {
  it.todo("accepts reverse-DNS bundle identifiers such as com.apple.calculator");
  it.todo("rejects blank, non-string, whitespace-padded control characters, and over-length app ids");
});

describe("normalizeAppName", () => {
  it.todo("falls back to the app id when the display name is blank");
  it.todo("caps the display name at APP_APPROVAL_APP_NAME_MAX_CHARS");
});

describe("appIdAlwaysDenied", () => {
  it.todo("denies the Bellwood desktop shell bundle identifier");
  it.todo("allows ordinary third-party app ids");
});

describe("formatAppApprovalCardText", () => {
  it.todo("names the Worker, app display name, exact app id, and that approval lasts for this Worker run");
  it.todo("includes the vendor warning line only when one is present");
});
