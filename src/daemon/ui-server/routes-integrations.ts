import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { API_PATHS, type PushKeyResponse } from "../../shared/index.ts";
import { feishuChatPolicyBodySchema, feishuCredentialsSchema, feishuDisconnectSchema, type FeishuSetupService } from "../feishu/setup.ts";
import { parseSubscription } from "../push/subscriptions.ts";
import { peerOf, type UiCtx } from "./context.ts";
import { fail, parseId, parseWithSchema } from "./http.ts";
import { emptyObjectBodySchema, pushUnsubscribeBodySchema } from "./schemas.ts";

function registerPushRoutes(routes: FastifyInstance, c: UiCtx): void {
  const push = c.opts.push;
  if (push === undefined) return;
  routes.get(API_PATHS.pushKey, async (): Promise<PushKeyResponse> => ({ publicKey: push.publicKey }));
  routes.post(API_PATHS.pushSubscriptions, async (req, reply) => {
    const subscription = parseSubscription(req.body);
    if (subscription === null) return fail(reply, "invalid", "订阅内容不对");
    push.subscribe(subscription);
    return reply.code(204).send();
  });
  routes.post(API_PATHS.pushUnsubscribe, async (req, reply) => {
    const parsed = pushUnsubscribeBodySchema.safeParse(req.body);
    if (!parsed.success) return fail(reply, "invalid", "endpoint 不对");
    push.unsubscribe(parsed.data.endpoint);
    return reply.code(204).send();
  });
}

function registerFeishuRoutes(routes: FastifyInstance, c: UiCtx): void {
  const feishuOf = (req: FastifyRequest, reply: FastifyReply): FeishuSetupService | null => {
    if (peerOf(c, req) !== undefined) {
      fail(reply, "forbidden_peer");
      return null;
    }
    if (c.opts.feishu === undefined) {
      fail(reply, "unavailable", "这台没开飞书");
      return null;
    }
    return c.opts.feishu;
  };
  routes.get(API_PATHS.feishu, async (req, reply) => {
    const feishu = feishuOf(req, reply);
    return feishu === null ? reply : feishu.status();
  });
  routes.post(API_PATHS.feishuRegistration, async (req, reply) => {
    const feishu = feishuOf(req, reply);
    if (feishu === null) return reply;
    parseWithSchema(emptyObjectBodySchema, req.body ?? {});
    return feishu.startRegistration();
  });
  routes.delete(API_PATHS.feishuRegistration, async (req, reply) => {
    const feishu = feishuOf(req, reply);
    return feishu === null ? reply : feishu.cancelRegistration();
  });
  routes.put(API_PATHS.feishuCredentials, async (req, reply) => {
    const feishu = feishuOf(req, reply);
    if (feishu === null) return reply;
    const body = parseWithSchema(feishuCredentialsSchema, req.body);
    return feishu.saveCredentials(body);
  });
  routes.post(API_PATHS.feishuBindCode, async (req, reply) => {
    const feishu = feishuOf(req, reply);
    if (feishu === null) return reply;
    parseWithSchema(emptyObjectBodySchema, req.body ?? {});
    return feishu.issueBindCode();
  });
  routes.put("/api/feishu/chats/:pmId/policy", async (req, reply) => {
    const feishu = feishuOf(req, reply);
    if (feishu === null) return reply;
    const pmId = parseId((req.params as { pmId?: unknown }).pmId, "pm id");
    const body = parseWithSchema(feishuChatPolicyBodySchema, req.body);
    return feishu.setChatPolicy({ pmId, ...body });
  });
  routes.post(API_PATHS.feishuResync, async (req, reply) => {
    const feishu = feishuOf(req, reply);
    if (feishu === null) return reply;
    parseWithSchema(emptyObjectBodySchema, req.body ?? {});
    return feishu.resync();
  });
  routes.post(API_PATHS.feishuDisconnect, async (req, reply) => {
    const feishu = feishuOf(req, reply);
    if (feishu === null) return reply;
    const body = parseWithSchema(feishuDisconnectSchema, req.body);
    return feishu.disconnect(body);
  });
}

export function registerIntegrationRoutes(routes: FastifyInstance, c: UiCtx): void {
  registerPushRoutes(routes, c);
  registerFeishuRoutes(routes, c);
}
