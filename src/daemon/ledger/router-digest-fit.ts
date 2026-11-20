// Fits the PM digest into a byte budget by dropping minor fields level by level across all PMs.
import { truncateChars } from "../../shared/domain.ts";
import { PROJECT_CATALOG_COMPACT_ONE_LINER_CHARS, ROUTER_FLEET_DIGEST_MAX_BYTES } from "../../shared/limits.ts";
import type { ProjectCatalogCard } from "../../shared/project-catalog.ts";
import type { DeviceRouterDigest, PmDigestEntry } from "../../shared/router.ts";

type DigestProject = NonNullable<PmDigestEntry["project"]>;

const withProject = (pm: PmDigestEntry, fn: (project: DigestProject) => DigestProject): PmDigestEntry =>
  pm.project === null ? pm : { ...pm, project: fn(pm.project) };

const withCatalog = (project: DigestProject, fn: (catalog: ProjectCatalogCard) => ProjectCatalogCard): DigestProject =>
  project.catalog ? { ...project, catalog: fn(project.catalog) } : project;

const TRIM_STEPS: ReadonlyArray<(pm: PmDigestEntry) => PmDigestEntry> = [
  (pm) => ({ ...pm, activeWorkers: pm.activeWorkers.slice(0, 2) }),
  (pm) => ({ ...pm, recentBrief: null }),
  (pm) => withProject({ ...pm, activeWorkers: [] }, (p) => withCatalog(p, (c) => ({ ...c, focus: "", aliases: c.aliases.slice(0, 3) }))),
  (pm) => withProject(pm, (p) => ({ ...p, otherFolders: [], description: p.catalog ? null : p.description })),
  (pm) =>
    withProject(pm, (p) =>
      withCatalog(
        { ...p, description: p.description === null ? null : truncateChars(p.description, PROJECT_CATALOG_COMPACT_ONE_LINER_CHARS) },
        (c) => ({ ...c, aliases: [], oneLiner: truncateChars(c.oneLiner, PROJECT_CATALOG_COMPACT_ONE_LINER_CHARS) }),
      ),
    ),
];

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

function keepPriority(pm: PmDigestEntry): number {
  if (pm.pendingDecisionCount > 0 || pm.activeWorkerTotal > 0) return 2;
  return pm.activity === "idle" ? 0 : 1;
}

export function fitRouterDigest(digest: DeviceRouterDigest, maxBytes: number = ROUTER_FLEET_DIGEST_MAX_BYTES): DeviceRouterDigest {
  if (jsonBytes(digest) <= maxBytes) return digest;
  let pms = digest.pms;
  for (const step of TRIM_STEPS) {
    pms = pms.map(step);
    if (jsonBytes({ ...digest, pms }) <= maxBytes) return { ...digest, pms };
  }

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
