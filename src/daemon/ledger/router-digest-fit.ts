// 本机 PM 团队摘要（GET /api/router/digest，ledger/router.ts 的 getDigest）压进字节上限：
// 先按顺序一级级去掉次要字段，每一级对所有项目经理一起做；最简条目还放不下，按优先级从低到高去掉整条。
import { truncateChars } from "../../shared/domain.ts";
import { PROJECT_CATALOG_COMPACT_ONE_LINER_CHARS, ROUTER_FLEET_DIGEST_MAX_BYTES } from "../../shared/limits.ts";
import type { ProjectCatalogCard } from "../../shared/project-catalog.ts";
import type { DeviceRouterDigest, PmDigestEntry } from "../../shared/router.ts";

type DigestProject = NonNullable<PmDigestEntry["project"]>;

const withProject = (pm: PmDigestEntry, fn: (project: DigestProject) => DigestProject): PmDigestEntry =>
  pm.project === null ? pm : { ...pm, project: fn(pm.project) };

const withCatalog = (project: DigestProject, fn: (catalog: ProjectCatalogCard) => ProjectCatalogCard): DigestProject =>
  project.catalog ? { ...project, catalog: fn(project.catalog) } : project;

/** 裁剪阶梯，后一级在前一级的结果上接着裁。 */
const TRIM_STEPS: ReadonlyArray<(pm: PmDigestEntry) => PmDigestEntry> = [
  (pm) => ({ ...pm, activeWorkers: pm.activeWorkers.slice(0, 2) }),
  (pm) => ({ ...pm, recentBrief: null }),
  // Worker 明细去掉，个数还在 activeWorkerTotal
  (pm) => withProject({ ...pm, activeWorkers: [] }, (p) => withCatalog(p, (c) => ({ ...c, focus: "", aliases: c.aliases.slice(0, 3) }))),
  // 有档案的项目靠档案的一句话认，说明全文总助用 project-show 看
  (pm) => withProject(pm, (p) => ({ ...p, otherFolders: [], description: p.catalog ? null : p.description })),
  // 最简条目：和总助提示词里的单行摘要（router/prompt.ts 的 formatCompactPmLine）一样长
  (pm) =>
    withProject(pm, (p) =>
      withCatalog(
        { ...p, description: p.description === null ? null : truncateChars(p.description, PROJECT_CATALOG_COMPACT_ONE_LINER_CHARS) },
        (c) => ({ ...c, aliases: [], oneLiner: truncateChars(c.oneLiner, PROJECT_CATALOG_COMPACT_ONE_LINER_CHARS) }),
      ),
    ),
];

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

/** 有待拍板或开着的 Worker 最先留，其次正在干活的，最后空闲的；同一档里最近活跃的先留。 */
function keepPriority(pm: PmDigestEntry): number {
  if (pm.pendingDecisionCount > 0 || pm.activeWorkerTotal > 0) return 2;
  return pm.activity === "idle" ? 0 : 1;
}

/**
 * 后置：返回值 JSON 序列化后不超过 maxBytes 字节；没超时原样返回入参，超了返回新对象，不改入参。
 * 留下的项目经理保持原来的顺序；去掉了整条时 omittedPms 是去掉的个数。
 */
export function fitRouterDigest(digest: DeviceRouterDigest, maxBytes: number = ROUTER_FLEET_DIGEST_MAX_BYTES): DeviceRouterDigest {
  if (jsonBytes(digest) <= maxBytes) return digest;
  let pms = digest.pms;
  for (const step of TRIM_STEPS) {
    pms = pms.map(step);
    if (jsonBytes({ ...digest, pms }) <= maxBytes) return { ...digest, pms };
  }

  // 数组里每条占自己的字节加一个逗号；omittedPms 按最多位数先算上
  let total = jsonBytes({ ...digest, pms, omittedPms: pms.length });
  const dropOrder = pms
    .map((pm, index) => ({ index, priority: keepPriority(pm), lastActiveAt: pm.lastActiveAt ?? 0, bytes: jsonBytes(pm) + 1 }))
    .sort((a, b) => a.priority - b.priority || a.lastActiveAt - b.lastActiveAt || b.index - a.index);
  const dropped = new Set<number>();
  for (const entry of dropOrder) {
    if (total <= maxBytes) break;
    dropped.add(entry.index);
    total -= entry.bytes;
  }
  return { ...digest, pms: pms.filter((_, index) => !dropped.has(index)), omittedPms: dropped.size };
}
