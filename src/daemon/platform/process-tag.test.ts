import { describe, it } from "vitest";

describe("session owner process tagging and reaping", () => {
  it.todo("builds a single-session tag and appends to parent tags up to SESSION_TAG_MAX_DEPTH");
  it.todo("matches only exact comma-delimited tokens in envContainsSessionTag");
  it.todo("lists detached grandchildren carrying the session tag on macOS (ps eww) and Linux (/proc/<pid>/environ)");
  it.todo("excludes PID <= 1 and ownPid from listed and reaped targets");
  it.todo("reaps a detached grandchild process whose intermediate parent already exited");
  it.todo("reaps a nested test daemon process that inherited the parent Worker tag");
  it.todo("returns empty list on win32 where fusa-run Job Objects own the process tree");
});
