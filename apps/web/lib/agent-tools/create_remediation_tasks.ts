/**
 * Company-local agent tool handler: `create_remediation_tasks`.
 *
 * Confirm-gated mutation (autonomy = confirm). After a SOC 2 gap report's
 * findings are released and the customer confirms the proposed task list, the
 * approved-actions bridge routes the tool call here. This handler materializes
 * one `soc2_remediation_tasks` row per finding, carrying a suggested owner and
 * a due date, de-duplicated on (org_id, report_id, finding_id).
 *
 * Signature matches the lego handler shape consumed by DOMAIN_DISPATCH:
 *   (ctx: HandlerContext, args: Record<string, unknown>) => Promise<HandlerResult>
 *
 * The real DB surface is `ctx.db.query<T>(sql, ...params)` (asyncpg-style $1,$2
 * placeholders, spread params) and `HandlerResult` is `{ status, body }`.
 */

import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

/** A single finding the customer confirmed for remediation. */
interface FindingInput {
  readonly findingId: string;
  readonly title: string | null;
  readonly severity: string | null;
  readonly suggestedOwnerUserId: string | null;
  readonly dueDate: string | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** A date-only ISO string (YYYY-MM-DD); anything else is treated as absent. */
function asIsoDate(value: unknown): string | null {
  const s = asString(value);
  if (!s) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function asStringKeyedMap(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

/**
 * Normalize the raw `findings` arg into a typed list. Accepts either a
 * `findingId` or an `id` key per item, and resolves the owner/due-date either
 * from the finding itself or from the parallel lookup maps the planner may pass
 * (`suggestedOwnersByFindingId` / `dueDatesByFindingId`). Items without a
 * finding id are dropped; duplicate finding ids keep their first occurrence.
 */
function normalizeFindings(
  rawFindings: unknown,
  ownersMap: Record<string, unknown>,
  dueDatesMap: Record<string, unknown>,
  defaultDueDate: string | null,
): FindingInput[] {
  if (!Array.isArray(rawFindings)) return [];

  const out: FindingInput[] = [];
  const seen = new Set<string>();

  for (const item of rawFindings) {
    if (!isObject(item)) continue;
    const findingId = asString(item.findingId) ?? asString(item.id);
    if (!findingId || seen.has(findingId)) continue;
    seen.add(findingId);

    const owner =
      asString(ownersMap[findingId]) ??
      asString(item.suggestedOwnerUserId) ??
      asString(item.ownerUserId) ??
      null;

    const dueDate =
      asIsoDate(dueDatesMap[findingId]) ?? asIsoDate(item.dueDate) ?? defaultDueDate;

    out.push({
      findingId,
      title: asString(item.title) ?? null,
      severity: asString(item.severity) ?? null,
      suggestedOwnerUserId: owner,
      dueDate,
    });
  }

  return out;
}

/**
 * Bulk-insert all confirmed findings as remediation tasks in one statement.
 * `ON CONFLICT DO NOTHING` on the (org_id, report_id, finding_id) unique index
 * makes the call idempotent: re-running the confirmed action never duplicates a
 * task. `RETURNING finding_id` lets us count exactly how many rows were created
 * versus skipped as pre-existing.
 */
const INSERT_SQL = `
  INSERT INTO soc2_remediation_tasks (
    id, org_id, report_id, finding_id, title, severity,
    suggested_owner_user_id, due_date, status, created_at, updated_at
  )
  SELECT
    gen_random_uuid(), $1, $2,
    t.finding_id, t.title, t.severity, t.owner_user_id, t.due_date,
    'open', NOW(), NOW()
  FROM unnest(
    $3::uuid[], $4::text[], $5::text[], $6::uuid[], $7::date[]
  ) AS t(finding_id, title, severity, owner_user_id, due_date)
  ON CONFLICT (org_id, report_id, finding_id) DO NOTHING
  RETURNING finding_id
`;

/**
 * Create remediation tasks for a confirmed gap report.
 *
 * @throws never — all failures are returned as a structured HandlerResult.
 */
export async function handleCreateRemediationTasks(
  ctx: HandlerContext,
  args: Record<string, unknown>,
): Promise<HandlerResult> {
  const orgId = asString(args.orgId);
  const reportId = asString(args.reportId);
  const confirmed = args.confirmed === true;

  if (!orgId || !reportId) {
    return { status: 400, body: "orgId and reportId are required" };
  }

  // Autonomy = confirm: this mutation only runs on explicit customer approval.
  if (!confirmed) {
    return {
      status: 409,
      body: "This mutation requires explicit confirmation (args.confirmed must be true)",
    };
  }

  const findings = normalizeFindings(
    args.findings,
    asStringKeyedMap(args.suggestedOwnersByFindingId),
    asStringKeyedMap(args.dueDatesByFindingId),
    asIsoDate(args.defaultDueDate),
  );

  if (findings.length === 0) {
    return {
      status: 200,
      body: { ok: true, created: 0, skipped: 0, total: 0, reason: "no_findings" },
    };
  }

  const findingIds = findings.map((f) => f.findingId);
  const titles = findings.map((f) => f.title);
  const severities = findings.map((f) => f.severity);
  const owners = findings.map((f) => f.suggestedOwnerUserId);
  const dueDates = findings.map((f) => f.dueDate);

  try {
    const rows = await ctx.db.query<{ finding_id: string }>(
      INSERT_SQL,
      orgId,
      reportId,
      findingIds,
      titles,
      severities,
      owners,
      dueDates,
    );

    const created = rows.length;
    const skipped = findings.length - created;

    return {
      status: 200,
      body: {
        ok: true,
        orgId,
        reportId,
        created,
        skipped,
        total: findings.length,
        createdFindingIds: rows.map((r) => r.finding_id),
      },
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown persistence error";
    console.error(
      JSON.stringify({
        level: "error",
        tool: "create_remediation_tasks",
        org_id: orgId,
        report_id: reportId,
        finding_count: findings.length,
        message,
      }),
    );
    return { status: 500, body: `create_remediation_tasks failed: ${message}` };
  }
}
