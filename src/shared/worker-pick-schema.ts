// 输入框指定派 Worker 的厂商、模型、思考程度（WorkerPick，shared/worker.ts）的请求校验。
// 单独一个文件、不放进 shared/index.ts：它用 zod，网页只要类型和拼句子的函数，不该把 zod 打进网页的包里（只有界面服务 import 它）。
import { z } from "zod";
import { MAX_WORKER_PICK_EFFORT_CHARS } from "./limits.ts";
import { AGENT_VENDORS, checkModel } from "./vendors.ts";

/** 档位名：字母、数字和 . _ -（会原样拼进给项目经理的参数句子，不能带空格、括号这类能改写句子的字符）。 */
const WORKER_PICK_EFFORT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * 校验请求里的 workerPick：厂商在 AGENT_VENDORS 里，模型过 checkModel（和 hub worker start --model 同一条规则），档位是短词；
 * 多一个字段、少一个字段都不行。不查这台设备现在能不能用这家厂商（那是 hub worker start 的事）。
 */
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
