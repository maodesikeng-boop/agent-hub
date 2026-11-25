import { describe, it } from "vitest";

describe("parseQuotaResetAt", () => {
  it.todo("parses Claude human reset phrases such as 'You've hit your 5-hour limit · resets 7:10pm (Asia/Shanghai)' into future epoch seconds");
  it.todo("rolls over past clock times to the next day in the stated IANA time zone");
  it.todo("parses Unix epoch markers and ISO-8601 timestamps");
  it.todo("returns null when an error message contains no unambiguous reset time");
});

describe("createObservedQuotaStore", () => {
  it.todo("records a limited observation when a failed turn matches quota patterns across all 8 registered vendors");
  it.todo("recognizes Claude 5-hour and weekly limit messages via COMMON_QUOTA_PATTERN");
  it.todo("expires an observation automatically once resetsAt passes");
  it.todo("expires an observation without resetsAt after OBSERVED_QUOTA_FALLBACK_TTL_MS so a vendor is never stuck limited");
  it.todo("clears a vendor's active limitation immediately when any turn succeeds");
  it.todo("clears a vendor's active limitation when a rate_limit event reports allowed status or when clearVendor is called");
  it.todo("bounds stored observations with LRUCache capped at OBSERVED_QUOTA_CACHE_MAX and clips raw reason to MAX_QUOTA_REASON_CHARS");
});

describe("mergeVendorQuota and formatVendorQuotaStatus", () => {
  it.todo("marks a vendor as limited in hub models when ObservedQuotaStore has an active rejection");
  it.todo("marks a vendor as limited when providerQuota reports an exhausted window with utilization >= 1");
  it.todo("preserves not_installed and signed_out availability precedence over quota status");
  it.todo("reverts hub models status to available after resetsAt expires or a subsequent turn succeeds");
});
