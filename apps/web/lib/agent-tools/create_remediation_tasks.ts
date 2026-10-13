import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = {
  orgId?: string;
  reportId?: string;
  confirmed?: boolean;
  findings?: unknown;
  suggestedOwnersByFindingId?: unknown;
  dueDatesByFindingId?: unknown;
  defaultDueDate?: string;
};

type FindingInput = {
  findingId: string;
  title?: string;
  severity?: string;
  suggestedOwnerUserId?: string;
  dueDate?: string;
};

type DbExecutor = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows?: unknown[] } | unknown[]>;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function isIsoDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function normalizeFindings(raw: unknown): FindingInput[] {
  if (!Array.isArray(raw)) return [];
  const out: FindingInput[] = [];
  for (const item of raw) {
    const r = asRecord(item);
    const findingId = asString(r.findingId) ?? asString(r.id);
    if (!findingId) continue;

    out.push({
      findingId,
      title: asString(r.title),
      severity: asString(r.severity),
      suggestedOwnerUserId: asString(r.suggestedOwnerUserId) ?? asString(r.ownerUserId),
      dueDate: asString(r.dueDate),
    });
  }
  return out;
}

async function resolveDb(ctx: HandlerContext): Promise<DbExecutor | null> {
  const candidateCtx = ctx as unknown as { db?: DbExecutor; pg?: DbExecutor; sql?: DbExecutor };
  if (candidateCtx.db?.query) return candidateCtx.db;
  if (candidateCtx.pg?.query) return candidateCtx.pg;
  if (candidateCtx.sql?.query) return candidateCtx.sql;
  return null;
}

function getRows(result: { rows?: unknown[] } | unknown[]): unknown[] {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.rows)) return result.rows;
  return [];
}

export async function handleCreateRemediationTasks(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  const orgId = asString(args.orgId);
  const reportId = asString(args.reportId);
  const confirmed = asBoolean(args.confirmed);

  if (!orgId || !reportId) {
    return {
      ok: false,
      error: "invalid_arguments",
      message: "orgId and reportId are required",
    } as HandlerResult;
  }

  if (!confirmed) {
    return {
      ok: false,
      error: "confirmation_required",
      message: "This mutation requires explicit confirmation",
    } as HandlerResult;
  }

  const db = await resolveDb(ctx);
  if (!db) {
    return {
      ok: false,
      error: "db_unavailable",
      message: "No database executor found on handler context",
    } as HandlerResult;
  }

  const findings = normalizeFindings(args.findings);
  if (findings.length === 0) {
    return {
      ok: true,
      data: {
        created: 0,
        skipped: 0,
        reason: "no_findings",
      },
    } as HandlerResult;
  }

  const ownersMap = asRecord(args.suggestedOwnersByFindingId);
  const dueDatesMap = asRecord(args.dueDatesByFindingId);
  const defaultDueDate = asString(args.defaultDueDate);

  let created = 0;
  let skipped = 0;

  for (const finding of findings) {
    const mapOwner = asString(ownersMap[finding.findingId]);
    const mapDueDate = asString(dueDatesMap[finding.findingId]);

    const ownerUserId = mapOwner ?? finding.suggestedOwnerUserId ?? null;
    const dueDate = mapDueDate ?? finding.dueDate ?? defaultDueDate ?? null;
    const normalizedDueDate = dueDate && isIsoDateOnly(dueDate) ? dueDate : null;

    // de-dup: one task per org/report/finding
    const existing = await db.query(
      `
      SELECT id
      FROM soc2_remediation_tasks
      WHERE org_id = $1
        AND report_id = $2
        AND finding_id = $3
      LIMIT 1
      `,
      [orgId, reportId, finding.findingId],
    );
    const existingRows = getRows(existing);
    if (existingRows.length > 0) {
      skipped += 1;
      continue;
    }

    await db.query(
      `
      INSERT INTO soc2_remediation_tasks (
        id,
        org_id,
        report_id,
        finding_id,
        title,
        severity,
        suggested_owner_user_id,
        due_date,
        status,
        created_at,
        updated_at
      )
      VALUES (
        gen_random_uuid(),
        $1, $2, $3, $4, $5, $6, $7,
        'open',
        NOW(),
        NOW()
      )
      `,
      [
        orgId,
        reportId,
        finding.findingId,
        finding.title ?? null,
        finding.severity ?? null,
        ownerUserId,
        normalizedDueDate,
      ],
    );
    created += 1;
  }

  return {
    ok: true,
    data: {
      created,
      skipped,
      total: findings.length,
    },
  } as HandlerResult;
}
