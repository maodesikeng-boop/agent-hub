import {
  LedgerRequestError,
  type PostRouterCommandRequest,
  type RouterAgentPlan,
  type RouterCommandAttachment,
} from "../../shared/index.ts";

/** Request fields that every plan write and every retry of a command carries forward. */
export type PlanBase = Pick<RouterAgentPlan, "attachmentIds" | "attachments" | "target" | "routerOnly">;

export function planBaseOf(plan: RouterAgentPlan | null): PlanBase {
  return {
    ...(plan?.attachmentIds !== undefined && plan.attachmentIds.length > 0 ? { attachmentIds: plan.attachmentIds } : {}),
    ...(plan?.attachments !== undefined && plan.attachments.length > 0 ? { attachments: plan.attachments } : {}),
    ...(plan?.target !== undefined ? { target: plan.target } : {}),
    ...(plan?.routerOnly === true ? { routerOnly: true } : {}),
  };
}

/**
 * Precondition: attachmentIds are the request's non-blank upload ids and attachments their resolved metadata.
 * Postcondition: returns the plan fields a new command keeps through retries, with only the target fields the request set.
 * Throws LedgerRequestError "invalid" when routerOnly comes with a direct target.
 */
export function planBaseOfRequest(
  input: PostRouterCommandRequest,
  attachmentIds: string[],
  attachments: RouterCommandAttachment[],
): PlanBase {
  const { target } = input;
  const routerOnly = input.routerOnly === true;
  if (routerOnly && target !== undefined) {
    throw new LedgerRequestError("invalid", "交给总助本身规划的指令不能再指定直送目标");
  }
  return {
    ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(target !== undefined
      ? {
          target: {
            ...(target.deviceId !== undefined ? { deviceId: target.deviceId } : {}),
            ...(target.pmId !== undefined ? { pmId: target.pmId } : {}),
            ...(target.projectId !== undefined ? { projectId: target.projectId } : {}),
          },
        }
      : {}),
    ...(routerOnly ? { routerOnly: true } : {}),
  };
}
