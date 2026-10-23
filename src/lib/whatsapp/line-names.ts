/**
 * Plain-word names for the Monitoring read (WA-LINE-HEALTH-1023): each line says
 * "+77776879632, distribute.you (org Distribute)" without the dashboard joining
 * anything. Brand name = brand-service, org name = client-service, each read under
 * the line's OWN org and the user who linked it (one org run per (org, brand) on a
 * cache miss), cached 1 h. Unresolvable = null with the reason.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { matrixLinks } from "../../db/schema.js";
import { SERVICE_NAME } from "../../middleware/auth.js";
import { createRun, updateRun } from "../runs-client.js";
import { siblingGet } from "../people/siblings.js";

const TTL_MS = 60 * 60 * 1000;
type Named = { name: string | null; reason: string | null; at: number };
const brandCache = new Map<string, Named>();
const orgCache = new Map<string, Named>();

export interface LineNames {
  brandName: string | null;
  orgName: string | null;
  /** Why a name is null, in words (e.g. "brand-service answered 404"); null when both resolved. */
  namesUnresolvedReason: string | null;
}

const fresh = (n: Named | undefined) => !!n && Date.now() - n.at < TTL_MS;

async function resolveOne(orgId: string, brandId: string, userId: string | null): Promise<void> {
  if (!userId) {
    const reason = "no user linked a line of this brand: nobody to read its name as";
    brandCache.set(brandId, { name: null, reason, at: Date.now() });
    orgCache.set(orgId, { name: null, reason, at: Date.now() });
    return;
  }
  const run = await createRun({ orgId, userId, brandIds: [brandId], serviceName: SERVICE_NAME, taskName: "whatsapp-lines.names" });
  const identity = { orgId, userId, runId: run.id, brandId };
  const read = async (sibling: "brand" | "client", path: string, pick: (b: Record<string, unknown>) => unknown): Promise<Named> => {
    try {
      const r = await siblingGet(sibling, path, identity);
      if (r.status !== 200) return { name: null, reason: `${sibling}-service answered ${r.status}`, at: Date.now() };
      const v = pick(r.body as Record<string, unknown>);
      const name = typeof v === "string" && v.trim() ? v.trim() : null;
      return { name, reason: name ? null : `${sibling}-service holds no name`, at: Date.now() };
    } catch (err) {
      return { name: null, reason: `${sibling}-service unreadable: ${(err as Error).message}`, at: Date.now() };
    }
  };
  try {
    if (!fresh(brandCache.get(brandId))) {
      brandCache.set(brandId, await read("brand", `/internal/brands/${encodeURIComponent(brandId)}`, (b) => (b.brand as { name?: unknown } | undefined)?.name));
    }
    if (!fresh(orgCache.get(orgId))) {
      orgCache.set(orgId, await read("client", `/internal/orgs/${encodeURIComponent(orgId)}`, (b) => b.name));
    }
    await updateRun(run.id, "completed", identity);
  } catch (err) {
    await updateRun(run.id, "failed", identity).catch(() => {});
    throw err;
  }
}

/** Names for each (org, brand). A sibling failure never fails the read: the name is null with its reason. */
export async function lineNames(keys: { orgId: string; brandId: string }[]): Promise<Map<string, LineNames>> {
  const pairs = [...new Map(keys.map((k) => [`${k.orgId}|${k.brandId}`, k])).values()];
  const missing = pairs.filter((p) => !fresh(brandCache.get(p.brandId)) || !fresh(orgCache.get(p.orgId)));
  if (missing.length) {
    const creators = await db
      .select({ orgId: matrixLinks.orgId, brandId: matrixLinks.brandId, userId: matrixLinks.createdByUserId })
      .from(matrixLinks)
      .where(and(eq(matrixLinks.channel, "whatsapp"), inArray(matrixLinks.brandId, missing.map((m) => m.brandId))))
      .orderBy(desc(matrixLinks.createdAt));
    await Promise.all(
      missing.map((p) =>
        resolveOne(p.orgId, p.brandId, creators.find((c) => c.orgId === p.orgId && c.brandId === p.brandId)?.userId ?? null).catch((err) => {
          // Run tracking down: no name this time, asked again on the next read.
          console.error(`[crm-service][wa-line-health] names of ${p.orgId}/${p.brandId} unreadable:`, (err as Error).message);
        }),
      ),
    );
  }
  const out = new Map<string, LineNames>();
  for (const p of pairs) {
    const b = brandCache.get(p.brandId);
    const o = orgCache.get(p.orgId);
    const reasons = [b?.reason && `brand: ${b.reason}`, o?.reason && `org: ${o.reason}`, !b && !o && "run tracking unavailable, asked again on the next read"].filter(Boolean);
    out.set(`${p.orgId}|${p.brandId}`, { brandName: b?.name ?? null, orgName: o?.name ?? null, namesUnresolvedReason: reasons.length ? reasons.join("; ") : null });
  }
  return out;
}

/** Tests only. */
export function clearLineNameCache(): void {
  brandCache.clear();
  orgCache.clear();
}
