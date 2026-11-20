import agy from "./agy/spec.ts";
import claude from "./claude/spec.ts";
import codex from "./codex/spec.ts";
import cursor from "./cursor/spec.ts";
import deepseek from "./deepseek/spec.ts";
import pi from "./pi/spec.ts";

// Order sets the dropdown order; the first entry is the default vendor.
export const VENDOR_LIST = [claude, agy, codex, pi, deepseek, cursor] as const;

// Stored in agent_sessions.vendor and pms.vendor; never rename after release.
export type AgentVendor = (typeof VENDOR_LIST)[number]["id"];
