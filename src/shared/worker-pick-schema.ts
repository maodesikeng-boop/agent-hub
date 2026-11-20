import { z } from "zod";
import { MAX_WORKER_PICK_EFFORT_CHARS } from "./limits.ts";
import { AGENT_VENDORS, checkModel } from "./vendors.ts";

const WORKER_PICK_EFFORT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const workerPickSchema = z
  .object({
    vendor: z.enum(AGENT_VENDORS),
    model: z.string().nullable(),
    effort: z
      .string()
      .min(1)
      .max(MAX_WORKER_PICK_EFFORT_CHARS)
      .regex(WORKER_PICK_EFFORT, "invalid effort")
      .nullable(),
  })
  .strict()
  .superRefine((pick, ctx) => {
    const problem = checkModel(pick.vendor, pick.model);
    if (problem !== null) ctx.addIssue({ code: "custom", message: problem, path: ["model"] });
  });
