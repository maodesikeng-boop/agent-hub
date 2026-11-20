import { existsSync, readFileSync, statSync } from "node:fs";
import { parse, patch } from "@decimalturn/toml-patch";
import { MAX_VENDOR_SYNC_CONFIG_BYTES } from "../../../shared/index.ts";
import { isPlainObject } from "./jsonc.ts";

// The library's error message embeds the offending line (often a token), so rethrow with only line and column.
function parseTomlSafely(raw: string, filePath: string): unknown {
  try {
    return parse(raw, { integersAsBigInt: false });
  } catch (err) {
    const pos = /\((\d+),\s*(\d+)\)/.exec(err instanceof Error ? err.message : "");
    throw new Error(`解析 TOML 失败（${filePath}${pos ? `，第 ${pos[1]} 行第 ${pos[2]} 列` : ""}）`);
  }
}

export interface TomlDocumentSnapshot {
  exists: boolean;
  raw: string;
  data: Record<string, unknown>;
}

export function readTomlObjectFile(filePath: string): TomlDocumentSnapshot {
  if (!existsSync(filePath)) {
    return { exists: false, raw: "", data: {} };
  }
  const st = statSync(filePath);
  if (st.size > MAX_VENDOR_SYNC_CONFIG_BYTES) {
    throw new Error(`TOML 配置文件过大（超过 ${MAX_VENDOR_SYNC_CONFIG_BYTES} 字节）：${filePath}`);
  }
  const raw = readFileSync(filePath, "utf8");
  if (raw.trim() === "") {
    return { exists: true, raw, data: {} };
  }
  const parsed = parseTomlSafely(raw, filePath);
  if (!isPlainObject(parsed)) {
    throw new Error(`TOML 顶层必须是表对象：${filePath}`);
  }
  return { exists: true, raw, data: parsed };
}

export function patchTomlMapEntries(input: {
  doc: TomlDocumentSnapshot;
  tableKey?: string;
  upsert: Readonly<Record<string, Record<string, unknown>>>;
  removeNames: ReadonlySet<string>;
}): string | null {
  const { doc, tableKey = "mcp_servers", upsert, removeNames } = input;
  const upsertNames = Object.keys(upsert).sort();
  if (!doc.exists && upsertNames.length === 0) {
    return null;
  }

  const rootClone: Record<string, unknown> = doc.raw.trim() === "" ? {} : (parseTomlSafely(doc.raw, "config.toml") as Record<string, unknown>);
  const existingTable = isPlainObject(rootClone[tableKey]) ? { ...(rootClone[tableKey] as Record<string, unknown>) } : {};

  let mutated = false;

  for (const name of removeNames) {
    if (Object.prototype.hasOwnProperty.call(upsert, name)) continue;
    if (Object.prototype.hasOwnProperty.call(existingTable, name)) {
      delete existingTable[name];
      mutated = true;
    }
  }

  for (const name of upsertNames) {
    // Union upsert: an existing table is never overwritten.
    if (Object.prototype.hasOwnProperty.call(existingTable, name)) continue;
    existingTable[name] = upsert[name]!;
    mutated = true;
  }

  if (!mutated) return null;

  if (Object.keys(existingTable).length === 0) {
    delete rootClone[tableKey];
  } else {
    rootClone[tableKey] = existingTable;
  }

  const patched = patch(doc.raw, rootClone, { inlineTableStart: 3 });
  const normalized = patched.endsWith("\n") || patched === "" ? patched : `${patched}\n`;
  return normalized === doc.raw && doc.exists ? null : normalized;
}
