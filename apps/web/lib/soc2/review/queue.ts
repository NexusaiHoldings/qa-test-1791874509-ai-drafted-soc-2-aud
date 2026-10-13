/**
 * Expert review queue (F1-008).
 *
 * feasibility_analysis.human_ops_required[0] — "Expert compliance review of
 * AI-generated policies, control mappings, and gap findings before customer
 * delivery" — is an operator workflow, so it lives at /admin/review-queue and is
 * admin-gated (see apps/web/lib/admin-auth.ts getAdminUser()).
 *
 * The queue pulls three item types across every tenant:
 *   1. control_link  — soc2_control_evidence_links still 'proposed' whose
 *                      mapping_confidence < 0.7 (or explicitly flagged needs_review).
 *   2. policy_version — soc2_policy_versions whose needs_review_count exceeds a
 *                       threshold (the grounded-drafting NEEDS REVIEW claims).
 *   3. critical_gap  — soc2_gap_findings with severity='critical' whose parent
 *                       report is still held (released_at IS NULL).
 *
 * The reviewer approves, edits, or returns with notes. Every decision is stored
 * immutably in soc2_expert_reviews AND mirrored to the @nexus/admin-console
 * admin_audit_log (the cross-lego immutable trail). Approving a critical finding
 * releases the parent gap report (sets released_at) so the customer digest can
 * finally include it.
 *
 * All DB access is raw parameterized SQL ($1,$2…) through the substrate Db.
 */

import { buildDb } from "@/lib/db";

/** The substrate Db shape (query returns rows directly; execute returns void). */
interface SqlClient {
  query<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
  execute(sql: string, ...params: unknown[]): Promise<void>;
}

export type ReviewQueueItemType = "control_link" | "policy_version" | "critical_gap";
export type ReviewDecision = "approved" | "returned";

export interface ReviewQueueItem {
  id: string;
  orgId: string;
  orgName: string;
  type: ReviewQueueItemType;
  title: string;
  subtitle: string;
  confidence: number | null;
  createdAt: string;
  ageHours: number;
  rationale: string | null;
  detail: Record<string, unknown>;
}

export interface ReviewQueueFilters {
  limit?: number;
  offset?: number;
  needsReviewThreshold?: number;
}

export interface ReviewDecisionInput {
  itemType: ReviewQueueItemType;
  itemId: string;
  decision: ReviewDecision;
  note?: string | null;
  editedRationale?: string | null;
  reviewerId: string;
  reviewerEmail?: string | null;
}

export interface ReviewDecisionResult {
  ok: boolean;
  reason?: string;
  orgId?: string;
}

const VALID_ITEM_TYPES: readonly ReviewQueueItemType[] = [
  "control_link",
  "policy_version",
  "critical_gap",
];

/** True if the string is a review-queue item type we understand. */
export function isReviewQueueItemType(value: unknown): value is ReviewQueueItemType {
  return typeof value === "string" && VALID_ITEM_TYPES.includes(value as ReviewQueueItemType);
}

/** Whole hours between `createdAt` and now, floored at 0. */
function toAgeHours(createdAt: string): number {
  const created = new Date(createdAt).getTime();
  if (Number.isNaN(created)) return 0;
  const now = Date.now();
  return Math.max(0, Math.round((now - created) / (1000 * 60 * 60)));
}

interface QueueRow {
  id: string;
  org_id: string;
  org_name: string;
  type: ReviewQueueItemType;
  title: string;
  subtitle: string;
  confidence: number | string | null;
  created_at: string | Date;
  rationale: string | null;
  detail: Record<string, unknown> | null;
}

function mapRow(row: QueueRow): ReviewQueueItem {
  const createdAt =
    row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    orgName: String(row.org_name),
    type: row.type,
    title: String(row.title),
    subtitle: String(row.subtitle),
    confidence: row.confidence === null ? null : Number(row.confidence),
    createdAt,
    ageHours: toAgeHours(createdAt),
    rationale: row.rationale ? String(row.rationale) : null,
    detail: (row.detail ?? {}) as Record<string, unknown>,
  };
}

/**
 * The three-way UNION that backs the queue. Oldest items first so the operator
 * drains the backlog FIFO (age is the primary SLA signal).
 */
const QUEUE_SQL = `
  WITH org_names AS (
    SELECT id::text AS org_id, name FROM organizations
  ),
  control_items AS (
    SELECT
      cel.id::text AS id,
      cel.org_id::text AS org_id,
      COALESCE(onm.name, cel.org_id::text) AS org_name,
      'control_link'::text AS type,
      ('Control ' || cel.control_id || ' ↔ ' || ea.title) AS title,
      ('Mapping method: ' || cel.mapping_method) AS subtitle,
      cel.mapping_confidence::float8 AS confidence,
      cel.created_at,
      cel.rationale,
      jsonb_build_object(
        'control_id', cel.control_id,
        'artifact_id', cel.artifact_id::text,
        'artifact_title', ea.title,
        'artifact_summary', ea.summary,
        'artifact_type', ea.artifact_type,
        'mapping_method', cel.mapping_method
      ) AS detail
    FROM soc2_control_evidence_links cel
    INNER JOIN soc2_evidence_artifacts ea ON ea.id = cel.artifact_id
    LEFT JOIN org_names onm ON onm.org_id = cel.org_id::text
    WHERE cel.status = 'proposed'
      AND (cel.needs_review = true OR cel.mapping_confidence < 0.700)
  ),
  policy_items AS (
    SELECT
      pv.id::text AS id,
      pv.org_id::text AS org_id,
      COALESCE(onm.name, pv.org_id::text) AS org_name,
      'policy_version'::text AS type,
      pv.title AS title,
      ('Needs review count: ' || pv.needs_review_count::text) AS subtitle,
      NULL::float8 AS confidence,
      pv.updated_at AS created_at,
      pv.rationale,
      jsonb_build_object(
        'policy_id', pv.policy_id::text,
        'status', pv.status,
        'needs_review_count', pv.needs_review_count,
        'body_markdown', pv.body_markdown
      ) AS detail
    FROM soc2_policy_versions pv
    LEFT JOIN org_names onm ON onm.org_id = pv.org_id::text
    WHERE pv.status = 'in_review'
      AND pv.needs_review_count >= $1
  ),
  gap_items AS (
    SELECT
      gf.id::text AS id,
      gf.org_id::text AS org_id,
      COALESCE(onm.name, gf.org_id::text) AS org_name,
      'critical_gap'::text AS type,
      ('Critical gap: ' || gf.control_id) AS title,
      ('Report week ' || gr.report_week::text) AS subtitle,
      gf.score::float8 AS confidence,
      gf.created_at,
      gf.model_rationale AS rationale,
      jsonb_build_object(
        'report_id', gr.id::text,
        'report_week', gr.report_week::text,
        'finding_id', gf.id::text,
        'control_id', gf.control_id,
        'severity', gf.severity,
        'score', gf.score,
        'missing_evidence', gf.missing_evidence,
        'remediation_steps', gf.remediation_steps
      ) AS detail
    FROM soc2_gap_findings gf
    INNER JOIN soc2_gap_reports gr ON gr.id = gf.report_id
    LEFT JOIN org_names onm ON onm.org_id = gf.org_id::text
    WHERE gf.severity = 'critical'
      AND gr.released_at IS NULL
  )
  SELECT * FROM (
    SELECT * FROM control_items
    UNION ALL
    SELECT * FROM policy_items
    UNION ALL
    SELECT * FROM gap_items
  ) q
  ORDER BY created_at ASC
  LIMIT $2 OFFSET $3
`;

/** Pull the full operator review queue across all tenants, oldest first. */
export async function getReviewQueueItems(
  filters: ReviewQueueFilters = {},
): Promise<ReviewQueueItem[]> {
  const db = buildDb() as SqlClient;
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);
  const needsReviewThreshold = Math.max(filters.needsReviewThreshold ?? 1, 1);

  const rows = await db.query<QueueRow>(QUEUE_SQL, needsReviewThreshold, limit, offset);
  return rows.map(mapRow);
}

/**
 * Resolve a single queue item by its primary id. The three item types share no
 * id space in practice, so we scan the (bounded) queue and match — simpler than
 * three branch-specific lookups and always consistent with the list view.
 */
export async function getReviewQueueItemById(id: string): Promise<ReviewQueueItem | null> {
  const items = await getReviewQueueItems({ limit: 200, offset: 0 });
  return items.find((item) => item.id === id) ?? null;
}

/**
 * Mirror an event to the admin-console immutable audit log. Failures are logged
 * loudly but never bubble — an audit mirror hiccup must not 500 the operator.
 */
async function mirrorAudit(
  db: SqlClient,
  event: {
    adminUserId: string;
    action: string;
    targetType: string;
    targetId: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await db.execute(
      `INSERT INTO admin_audit_log (admin_user_id, action, target_type, target_id, payload)
       VALUES ($1::uuid, $2, $3, $4, $5::jsonb)`,
      event.adminUserId,
      event.action,
      event.targetType,
      event.targetId,
      JSON.stringify(event.payload),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        component: "soc2.review.queue",
        message: error instanceof Error ? error.message : "audit mirror failed",
        action: event.action,
        target_id: event.targetId,
      }),
    );
  }
}

/**
 * Record that an operator OPENED a tenant item in the review pane. "Operator
 * views of tenant policies are themselves logged" (task objective) — this is the
 * read-side audit trail, distinct from the decision trail.
 */
export async function logReviewQueueView(
  reviewerId: string,
  item: Pick<ReviewQueueItem, "id" | "type" | "orgId">,
): Promise<void> {
  const db = buildDb() as SqlClient;
  await mirrorAudit(db, {
    adminUserId: reviewerId,
    action: "soc2.review_queue.view_item",
    targetType: item.type,
    targetId: item.id,
    payload: { org_id: item.orgId },
  });
}

/** Resolve the owning org_id of an item across the three source tables. */
async function resolveOrgId(
  db: SqlClient,
  itemType: ReviewQueueItemType,
  itemId: string,
): Promise<string | null> {
  const table =
    itemType === "control_link"
      ? "soc2_control_evidence_links"
      : itemType === "policy_version"
        ? "soc2_policy_versions"
        : "soc2_gap_findings";
  const rows = await db.query<{ org_id: string }>(
    `SELECT org_id::text AS org_id FROM ${table} WHERE id = $1::uuid LIMIT 1`,
    itemId,
  );
  return rows[0]?.org_id ?? null;
}

/**
 * Apply an operator decision. Writes the immutable soc2_expert_reviews row,
 * promotes/returns the underlying record, releases the gap report on a critical
 * approval, and mirrors everything to admin_audit_log.
 */
export async function submitReviewDecision(
  input: ReviewDecisionInput,
): Promise<ReviewDecisionResult> {
  if (!isReviewQueueItemType(input.itemType)) {
    return { ok: false, reason: "invalid_item_type" };
  }
  if (input.decision !== "approved" && input.decision !== "returned") {
    return { ok: false, reason: "invalid_decision" };
  }

  const db = buildDb() as SqlClient;
  const now = new Date().toISOString();

  const orgId = await resolveOrgId(db, input.itemType, input.itemId);
  if (!orgId) {
    return { ok: false, reason: "not_found" };
  }

  const note = input.note ?? null;
  const editedRationale = input.editedRationale ?? null;

  // 1) Immutable review record.
  await db.execute(
    `INSERT INTO soc2_expert_reviews
       (org_id, item_type, item_id, decision, note, edited_rationale,
        reviewer_id, reviewer_email, created_at)
     VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7::uuid, $8, $9::timestamptz)`,
    orgId,
    input.itemType,
    input.itemId,
    input.decision,
    note,
    editedRationale,
    input.reviewerId,
    input.reviewerEmail ?? null,
    now,
  );

  // 2) Promote / return the underlying record.
  if (input.itemType === "control_link") {
    await db.execute(
      `UPDATE soc2_control_evidence_links
         SET status = CASE WHEN $2 = 'approved' THEN 'confirmed' ELSE 'rejected' END,
             rationale = COALESCE($3, rationale),
             needs_review = false,
             reviewed_by = $4::uuid,
             reviewed_at = $5::timestamptz,
             updated_at = $5::timestamptz
       WHERE id = $1::uuid`,
      input.itemId,
      input.decision,
      editedRationale,
      input.reviewerId,
      now,
    );
  } else if (input.itemType === "policy_version") {
    await db.execute(
      `UPDATE soc2_policy_versions
         SET status = CASE WHEN $2 = 'approved' THEN 'approved' ELSE 'in_review' END,
             rationale = COALESCE($3, rationale),
             needs_review_count = CASE WHEN $2 = 'approved' THEN 0 ELSE needs_review_count END,
             approved_by = CASE WHEN $2 = 'approved' THEN $4::uuid ELSE approved_by END,
             approved_at = CASE WHEN $2 = 'approved' THEN $5::timestamptz ELSE approved_at END,
             updated_at = $5::timestamptz
       WHERE id = $1::uuid`,
      input.itemId,
      input.decision,
      editedRationale,
      input.reviewerId,
      now,
    );
  } else if (input.itemType === "critical_gap") {
    // Approving a critical finding clears the hold on its parent report so the
    // customer digest can finally go out (F1-006 release gate).
    if (input.decision === "approved") {
      await db.execute(
        `UPDATE soc2_gap_findings
           SET status = 'acknowledged'
         WHERE id = $1::uuid`,
        input.itemId,
      );
      await db.execute(
        `UPDATE soc2_gap_reports gr
           SET released_at = $2::timestamptz, released_by = $3::uuid
         FROM soc2_gap_findings gf
         WHERE gf.id = $1::uuid
           AND gf.report_id = gr.id
           AND gr.released_at IS NULL`,
        input.itemId,
        now,
        input.reviewerId,
      );
    }
  }

  // 3) Immutable cross-lego audit trail.
  await mirrorAudit(db, {
    adminUserId: input.reviewerId,
    action: "soc2.review_queue.decision",
    targetType: input.itemType,
    targetId: input.itemId,
    payload: {
      org_id: orgId,
      decision: input.decision,
      note,
      edited_rationale: editedRationale,
      reviewer_email: input.reviewerEmail ?? null,
    },
  });

  console.info(
    JSON.stringify({
      level: "info",
      component: "soc2.review.queue",
      message: "review decision applied",
      org_id: orgId,
      item_type: input.itemType,
      item_id: input.itemId,
      decision: input.decision,
      reviewer_id: input.reviewerId,
    }),
  );

  return { ok: true, orgId };
}
