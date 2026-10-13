import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = {
  report_id?: unknown;
  org_id?: unknown;
  findings?: unknown;
  default_due_in_days?: unknown;
};

type FindingInput = {
  finding_id?: unknown;
  title?: unknown;
  description?: unknown;
  severity?: unknown;
  suggested_owner_user_id?: unknown;
  suggested_owner_email?: unknown;
  due_date?: unknown;
  due_in_days?: unknown;
};

type TaskRow = {
  id: string;
  finding_id: string | null;
  title: string;
  owner_user_id: string | null;
  owner_email: string | null;
  due_date: string | null;
  status: string;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asDate(value: unknown): string | null {
  const s = asString(value);
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function computeDueDate(
  explicitDueDate: unknown,
  dueInDays: unknown,
  defaultDueInDays: number,
): string {
  const explicit = asDate(explicitDueDate);
  if (explicit) return explicit;

  const perFinding = asNumber(dueInDays);
  const days = Math.max(1, Math.floor(perFinding ?? defaultDueInDays));
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function normalizeFindings(raw: unknown): FindingInput[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v) => typeof v === "object" && v !== null) as FindingInput[];
}

function buildTitle(finding: FindingInput, idx: number): string {
  const title = asString(finding.title);
  if (title) return `Remediate: ${title}`;
  const description = asString(finding.description);
  if (description) return `Remediate finding ${idx + 1}: ${description.slice(0, 80)}`;
  return `Remediate finding ${idx + 1}`;
}

export async function handleCreateRemediationTasks(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  try {
    const orgId = asString(args.org_id) ?? asString((ctx as { orgId?: unknown }).orgId);
    const reportId = asString(args.report_id);

    if (!orgId || !reportId) {
      return {
        ok: false,
        error: "invalid_arguments",
        message: "org_id and report_id are required",
      } as HandlerResult;
    }

    const findings = normalizeFindings(args.findings);
    if (findings.length === 0) {
      return {
        ok: false,
        error: "invalid_arguments",
        message: "findings must be a non-empty array",
      } as HandlerResult;
    }

    const defaultDueInDays = Math.max(1, Math.floor(asNumber(args.default_due_in_days) ?? 30));
    const createdByUserId =
      asString((ctx as { userId?: unknown }).userId) ??
      asString((ctx as { session?: { user?: { id?: unknown } } }).session?.user?.id);

    const db = (ctx as { db?: { query?: (sql: string, params?: unknown[]) => Promise<{ rows?: unknown[] }> } }).db;
    if (!db?.query) {
      return {
        ok: false,
        error: "runtime_unavailable",
        message: "database client not available in handler context",
      } as HandlerResult;
    }

    const created: TaskRow[] = [];

    await db.query("BEGIN");
    for (let i = 0; i < findings.length; i += 1) {
      const f = findings[i];
      const title = buildTitle(f, i);
      const findingId = asString(f.finding_id);
      const ownerUserId = asString(f.suggested_owner_user_id);
      const ownerEmail = asString(f.suggested_owner_email);
      const dueDate = computeDueDate(f.due_date, f.due_in_days, defaultDueInDays);
      const severity = asString(f.severity) ?? "unspecified";
      const description = asString(f.description);

      const insertSql = `
        INSERT INTO soc2_remediation_tasks (
          id,
          org_id,
          report_id,
          finding_id,
          title,
          description,
          severity,
          owner_user_id,
          owner_email,
          due_date,
          status,
          source,
          created_by_user_id,
          created_at,
          updated_at
        )
        VALUES (
          gen_random_uuid(),
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9::date,
          'open',
          'agent_create_remediation_tasks',
          $10,
          NOW(),
          NOW()
        )
        RETURNING id, finding_id, title, owner_user_id, owner_email, due_date::text AS due_date, status
      `;

      const result = await db.query(insertSql, [
        orgId,
        reportId,
        findingId,
        title,
        description,
        severity,
        ownerUserId,
        ownerEmail,
        dueDate,
        createdByUserId,
      ]);

      const row = (result.rows?.[0] ?? null) as TaskRow | null;
      if (row) created.push(row);
    }
    await db.query("COMMIT");

    return {
      ok: true,
      data: {
        report_id: reportId,
        org_id: orgId,
        created_count: created.length,
        tasks: created,
      },
    } as HandlerResult;
  } catch (error) {
    const db = (ctx as { db?: { query?: (sql: string, params?: unknown[]) => Promise<{ rows?: unknown[] }> } }).db;
    if (db?.query) {
      try {
        await db.query("ROLLBACK");
      } catch {
        // ignore rollback secondary failure
      }
    }

    return {
      ok: false,
      error: "create_remediation_tasks_failed",
      message: error instanceof Error ? error.message : "Unknown error",
    } as HandlerResult;
  }
}
