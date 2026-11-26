import { describe, expect, it } from "vitest";
import { appIdAlwaysDenied, formatAppApprovalCardText, normalizeAppId, normalizeAppName } from "./app-approval.ts";
import { APP_APPROVAL_APP_ID_MAX_CHARS, APP_APPROVAL_APP_NAME_MAX_CHARS } from "./limits.ts";

const appId = "com.apple.calculator";

describe("normalizeAppId", () => {
  it("accepts reverse-DNS bundle identifiers such as com.apple.calculator", () => {
    expect(normalizeAppId("  " + appId + " ")).toBe(appId);
    expect(normalizeAppId("/Applications/Tool.app/Contents/MacOS/Tool")).toBe("/Applications/Tool.app/Contents/MacOS/Tool");
  });
  it("rejects blank, non-string, whitespace-padded control characters, and over-length app ids", () => {
    for (const value of ["", "  ", 42, null, " \n" + appId, appId + "\u0000 ", "com." + "a".repeat(APP_APPROVAL_APP_ID_MAX_CHARS)]) {
      expect(normalizeAppId(value)).toBeNull();
    }
  });
});

describe("normalizeAppName", () => {
  it("falls back to the app id when the display name is blank", () => {
    expect(normalizeAppName("  ", appId)).toBe(appId);
    expect(normalizeAppName(undefined, appId)).toBe(appId);
    expect(normalizeAppName("  Calculator  ", appId)).toBe("Calculator");
  });
  it("caps the display name at APP_APPROVAL_APP_NAME_MAX_CHARS", () => {
    expect(normalizeAppName("A".repeat(APP_APPROVAL_APP_NAME_MAX_CHARS + 1), appId)).toBe("A".repeat(APP_APPROVAL_APP_NAME_MAX_CHARS));
  });
});

describe("appIdAlwaysDenied", () => {
  it("denies the Bellwood desktop shell bundle identifier", () => {
    expect(appIdAlwaysDenied("com.agenthub.desktop")).toBe(true);
    expect(appIdAlwaysDenied("COM.AGENTHUB.DESKTOP")).toBe(true);
  });
  it("allows ordinary third-party app ids", () => {
    expect(appIdAlwaysDenied(appId)).toBe(false);
    expect(appIdAlwaysDenied("org.mozilla.firefox")).toBe(false);
  });
});

describe("formatAppApprovalCardText", () => {
  const input = { workerId: 12, workerTitle: "Check totals", appId, appName: "Calculator", riskLevel: "low", warning: null } as const;
  it("names the Worker, app display name, exact app id, and that approval lasts for this Worker run", () => {
    const text = formatAppApprovalCardText(input);
    for (const part of ["Worker #12", "Check totals", "Calculator", appId, "this Worker run"]) expect(text).toContain(part);
  });
  it("includes the vendor warning line only when one is present", () => {
    const warning = "This app may contain sensitive content";
    expect(formatAppApprovalCardText({ ...input, warning })).toContain(warning);
    expect(formatAppApprovalCardText(input)).not.toContain(warning);
  });
});
