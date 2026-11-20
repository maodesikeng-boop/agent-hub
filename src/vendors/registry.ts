import agy from "./agy/spec.ts";
import claude from "./claude/spec.ts";
import codex from "./codex/spec.ts";
import cursor from "./cursor/spec.ts";
import deepseek from "./deepseek/spec.ts";
import kimi from "./kimi/spec.ts";
import opencode from "./opencode/spec.ts";
import pi from "./pi/spec.ts";

// Order sets the dropdown order; the first entry is the default vendor.
export const VENDOR_LIST = [claude, agy, codex, pi, deepseek, cursor, opencode, kimi] as const;

// Stored in agent_sessions.vendor and pms.vendor; never rename after release.
export type AgentVendor = (typeof VENDOR_LIST)[number]["id"];
