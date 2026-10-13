import { db } from "@nexus/db";
import { logAuditEvent } from "@nexus/admin-console";

export type ReviewQueueItemType = "control_link" | "policy_version" | "critical_gap";

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
  decision: "approved" | "returned";
  note?: string;
  editedRationale?: string;
  reviewerId: string;
  reviewerEmail?: string | null;
}

function toAgeHours(createdAt: string): number {
  const created = new Date(createdAt).getTime();
  const now = Date.now();
  return Math.max(0, Math.round((now - created) / (1000 * 60 * 60)));
}

export async function getReviewQueueItems(filters: ReviewQueueFilters = {}): Promise<ReviewQueueItem[]> {
  const limit: number = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const offset: number = Math.max(filters.offset ?? 0, 0);
  const needsReviewThreshold: number = Math.max(filters.needsReviewThreshold ?? 3, 1);

  const sql = `
    WITH org_names AS (
      SELECT id::text AS org_id, name
      FROM organizations
    ),
    control_items AS (
      SELECT
        cel.id::text AS id,
        cel.org_id::text AS org_id,
        coalesce(onm.name, cel.org_id::text) AS org_name,
        'control_link'::text AS type,
        ('Control ' || cel.control_id || ' ↔ ' || ea.title) AS title,
        ('Mapping method: ' || cel.mapping_method) AS subtitle,
        cel.mapping_confidence::float AS confidence,
        cel.created_at,
        cel.rationale,
        jsonb_build_object(
          'control_id', cel.control_id,
          'artifact_id', cel.artifact_id::text,
          'artifact_title', ea.title,
          'artifact_summary', ea.summary,
          'artifact_type', ea.artifact_type
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
        coalesce(onm.name, pv.org_id::text) AS org_name,
        'policy_version'::text AS type,
        pv.title AS title,
        ('Needs review count: ' || pv.needs_review_count::text) AS subtitle,
        NULL::float AS confidence,
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
      WHERE pv.needs_review_count >= $1
    ),
    gap_items AS (
      SELECT
        gf.id::text AS id,
        gf.org_id::text AS org_id,
        coalesce(onm.name, gf.org_id::text) AS org_name,
        'critical_gap'::text AS type,
        ('Critical finding: ' || gf.control_id) AS title,
        ('Report week: ' || gr.report_week::text) AS subtitle,
        NULL::float AS confidence,
        gf.created_at,
        gf.model_rationale AS rationale,
        jsonb_build_object(
          'report_id', gr.id::text,
          'report_week', gr.report_week::text,
          'finding_id', gf.id::text,
          'control_id', gf.control_id,
          'severity', gf.severity,
          'missing_evidence', gf.missing_evidence,
          'remediation_steps', gf.remediation_steps
        ) AS detail
      FROM soc2_gap_findings gf
      INNER JOIN soc2_gap_reports gr ON gr.id = gf.report_id
      LEFT JOIN org_names onm ON onm.org_id = gf.org_id::text
      WHERE gf.severity = 'critical'
        AND gr.released_at IS NULL
    )
    SELECT *
    FROM (
      SELECT * FROM control_items
      UNION ALL
      SELECT * FROM policy_items
      UNION ALL
      SELECT * FROM gap_items
    ) q
    ORDER BY created_at ASC
    LIMIT $2 OFFSET $3;
  `;

  const result = await db.query(sql, [needsReviewThreshold, limit, offset]);
  return result.rows.map((row: Record<string, unknown>) => {
    const createdAt = String(row.created_at);
    return {
      id: String(row.id),
      orgId: String(row.org_id),
      orgName: String(row.org_name),
      type: row.type as ReviewQueueItemType,
      title: String(row.title),
      subtitle: String(row.subtitle),
      confidence: row.confidence === null ? null : Number(row.confidence),
      createdAt,
      ageHours: toAgeHours(createdAt),
      rationale: row.rationale ? String(row.rationale) : null,
      detail: (row.detail ?? {}) as Record<string, unknown>,
    };
  });
}

export async function getReviewQueueItemById(id: string): Promise<ReviewQueueItem | null> {
  const items = await getReviewQueueItems({ limit: 200, offset: 0 });
  const found = items.find((item: ReviewQueueItem) => item.id === id);
  return found ?? null;
}

export async function submitReviewDecision(input: ReviewDecisionInput): Promise<void> {
  const now = new Date().toISOString();

  await db.query(
    `
      INSERT INTO soc2_expert_reviews (
        org_id, item_type, item_id, decision, note, edited_rationale, reviewer_id, reviewer_email, created_at
      )
      SELECT org_id, $1, $2::uuid, $3, $4, $5, $6::uuid, $7, $8::timestamptz
      FROM (
        SELECT org_id FROM soc2_control_evidence_links WHERE id = $2::uuid
        UNION ALL
        SELECT org_id FROM soc2_policy_versions WHERE id = $2::uuid
        UNION ALL
        SELECT org_id FROM soc2_gap_findings WHERE id = $2::uuid
      ) src
      LIMIT 1
    `,
    [
      input.itemType,
      input.itemId,
      input.decision,
      input.note ?? null,
      input.editedRationale ?? null,
      input.reviewerId,
      input.reviewerEmail ?? null,
      now,
    ],
  );

  if (input.itemType === "control_link") {
    await db.query(
      `
        UPDATE soc2_control_evidence_links
        SET
          status = CASE WHEN $2 = 'approved' THEN 'confirmed' ELSE 'rejected' END,
          rationale = COALESCE($3, rationale),
          reviewed_by = $4::uuid,
          reviewed_at = $5::timestamptz,
          needs_review = false,
          updated_at = $5::timestamptz
        WHERE id = $1::uuid
      `,
      [input.itemId, input.decision, input.editedRationale ?? null, input.reviewerId, now],
    );
  }

  if (input.itemType === "policy_version") {
    await db.query(
      `
        UPDATE soc2_policy_versions
        SET
          status = CASE WHEN $2 = 'approved' THEN 'approved' ELSE 'in_review' END,
          rationale = COALESCE($3, rationale),
          needs_review_count = CASE WHEN $2 = 'approved' THEN 0 ELSE needs_review_count END,
          approved_by = CASE WHEN $2 = 'approved' THEN $4::uuid ELSE approved_by END,
          approved_at = CASE WHEN $2 = 'approved' THEN $5::timestamptz ELSE approved_at END,
          updated_at = $5::timestamptz
        WHERE id = $1::uuid
      `,
      [input.itemId, input.decision, input.editedRationale ?? null, input.reviewerId, now],
    );
  }

  if (input.itemType === "critical_gap" && input.decision === "approved") {
    await db.query(
      `
        UPDATE soc2_gap_reports gr
        SET released_at = $2::timestamptz, released_by = $3::uuid
        FROM soc2_gap_findings gf
        WHERE gf.id = $1::uuid
          AND gf.report_id = gr.id
          AND gr.released_at IS NULL
      `,
      [input.itemId, now, input.reviewerId],
    );
  }

  await logAuditEvent({
    action: "soc2.review_queue.decision",
    actorId: input.reviewerId,
    targetType: input.itemType,
    targetId: input.itemId,
    metadata: {
      decision: input.decision,
      note: input.note ?? null,
      editedRationale: input.editedRationale ?? null,
    },
  });
}
