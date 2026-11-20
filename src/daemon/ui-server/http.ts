import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import { CONVERSATION_LOOKUP_MAX_IDS, MAX_NODE_KEY_CHARS, isAgentVendor, utf8Bytes, type AgentVendor } from "../../shared/index.ts";
import { API_ERRORS, errorBody, type ApiErrorCode } from "../../shared/errors.ts";

export const POSITIVE_INT = /^[1-9]\d*$/;
export const NON_NEGATIVE_INT = /^(0|[1-9]\d*)$/;
/** Cap length so clientId cannot inflate dedupe keys. */
export const MAX_CLIENT_ID_LENGTH = 200;

const STATUS_TO_CODE: Readonly<Record<number, ApiErrorCode>> = {
  400: "invalid",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "too_large",
  429: "busy",
  501: "unavailable",
};
export const codeOfStatus = (status: number): ApiErrorCode => STATUS_TO_CODE[status] ?? "internal";

export class HttpError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

export const fail = (reply: FastifyReply, code: ApiErrorCode, reason?: string) => reply.code(API_ERRORS[code].status).send(errorBody(code, reason));

export function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Compare sha256 digests so timing leaks neither token length nor prefix. */
export function tokenEquals(expected: Buffer, given: unknown): boolean {
  return typeof given === "string" && timingSafeEqual(expected, digest(given));
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function parseWithSchema<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new HttpError(400, parsed.error.issues[0]?.message ?? "invalid request");
  }
  return parsed.data;
}

const positiveIntIdSchema = z.string().regex(POSITIVE_INT).transform(Number).refine(Number.isSafeInteger, "must be a safe integer");

export function parseId(raw: unknown, what: string): number {
  const parsed = positiveIntIdSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(400, `${what} must be a positive integer`);
  }
  return parsed.data;
}

export const idParam = (params: unknown, what: string): number => parseId((params as { id?: unknown }).id, what);

export function parseIdList(raw: unknown, what: string): number[] {
  if (raw === undefined || raw === "") return [];
  if (typeof raw !== "string") throw new HttpError(400, `${what} must be a comma-separated list of positive integers`);
  const parts = raw.split(",");
  if (parts.length > CONVERSATION_LOOKUP_MAX_IDS) throw new HttpError(400, `${what} must have at most ${CONVERSATION_LOOKUP_MAX_IDS} items`);
  return parts.map((part) => parseId(part, what));
}

export function parseOptionalPositiveInt(raw: unknown, what: string): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  return parseId(raw, what);
}

export function parseNodeKeyParam(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "" || [...raw].length > MAX_NODE_KEY_CHARS) {
    throw new HttpError(400, "invalid nodeKey");
  }
  return raw;
}

export function parseVendorParam(raw: unknown): AgentVendor {
  if (typeof raw !== "string" || !isAgentVendor(raw)) {
    throw new HttpError(404, "unknown provider");
  }
  return raw;
}

export const boundedBytesSchema = (maxBytes: number, what: string) =>
  z.string().refine((s) => utf8Bytes(s) <= maxBytes, `${what} must be at most ${maxBytes} bytes`);

export const boundedCharsSchema = (maxChars: number, what: string) =>
  z.string().refine((s) => [...s].length <= maxChars, `${what} must be at most ${maxChars} characters`);
