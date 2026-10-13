import { Pool } from "pg";
import { logAuditEvent } from "@nexus/admin-console";

export type ReviewItemType = "control_link" | "policy_version" | "critical_gap";

export interface ReviewQueueItem {
  id: string;
  type: ReviewItemType;
  orgId: string;
  orgName: string;
  title: string;
  subtitle: string;
  confidence: number | null;
  ageHours: number;
  createdAt: string;
  payload: Record<string, unknown>;
}

export interface ReviewQueueListResult {
  items: ReviewQueueItem[];
}

export interface ReviewDecisionInput {
  reviewerId: string;
  reviewerEmail?: string | null;
  action: "approve" | "return";
  note?: string | null;
  editedRationale?: string | null;
}

export interface ReviewQueueDetail extends ReviewQueueItem {
  detail: Record<string, unknown>;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const POLICY_REVIEW_THRESHOLD = Number(process.env.SOC2_POLICY_REVIEW_THRESHOLD ?? "3");

function normalizeConfidence(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export async function listReviewQueue(): Promise<ReviewQueueListResult> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `
      WITH control_link_items AS (
        SELECT
          cel.id::text AS id,
          'control_link'::text AS type,
          cel.org_id::text AS org_id,
          COALESCE(o.name, cel.org_id::text) AS org_name,
          ('Control link: ' || cel.control_id) AS title,
          COALESCE(ea.title, 'Evidence artifact') AS subtitle,
          cel.mapping_confidence::text AS confidence,
          cel.created_at AS created_at,
          jsonb_build_object(
            'controlId', cel.control_id,
            'artifactId', cel.artifact_id::text,
            'artifactTitle', ea.title,
            'rationale', cel.rationale
          ) AS payload
        FROM soc2_control_evidence_links cel
        LEFT JOIN organizations o ON o.id = cel.org_id
        LEFT JOIN soc2_evidence_artifacts ea ON ea.id = cel.artifact_id
        WHERE cel.status = 'proposed'
          AND cel.mapping_confidence < 0.7
      ),
      policy_items AS (
        SELECT
          pv.id::text AS id,
          'policy_version'::text AS type,
          pv.org_id::text AS org_id,
          COALESCE(o.name, pv.org_id::text) AS org_name,
          ('Policy needs review: ' || pv.title) AS title,
          ('Needs review count: ' || pv.needs_review_count::text) AS subtitle,
          NULL::text AS confidence,
          pv.updated_at AS created_at,
          jsonb_build_object(
            'policyId', pv.policy_id::text,
            'status', pv.status,
            'needsReviewCount', pv.needs_review_count,
            'bodyMarkdown', pv.body_markdown,
            'rationale', pv.rationale
          ) AS payload
        FROM soc2_policy_versions pv
        LEFT JOIN organizations o ON o.id = pv.org_id
        WHERE pv.needs_review_count >= $1
      ),
      critical_gap_items AS (
        SELECT
          gf.id::text AS id,
          'critical_gap'::text AS type,
          gf.org_id::text AS org_id,
          COALESCE(o.name, gf.org_id::text) AS org_name,
          ('Critical gap: ' || gf.control_id) AS title,
          COALESCE(gf.control_title, gf.category_title) AS subtitle,
          NULL::text AS confidence,
          gf.created_at AS created_at,
          jsonb_build_object(
            'reportId', gf.report_id::text,
            'controlId', gf.control_id,
            'severity', gf.severity,
            'modelRationale', gf.model_rationale,
            'missingEvidence', gf.missing_evidence
          ) AS payload
        FROM soc2_gap_findings gf
        INNER JOIN soc2_gap_reports gr ON gr.id = gf.report_id
        LEFT JOIN organizations o ON o.id = gf.org_id
        WHERE gf.severity = 'critical'
          AND gr.released_at IS NULL
      )
      SELECT * FROM control_link_items
      UNION ALL
      SELECT * FROM policy_items
      UNION ALL
      SELECT * FROM critical_gap_items
      ORDER BY created_at ASC
      `,
      [POLICY_REVIEW_THRESHOLD],
    );

    const now = Date.now();
    const items: ReviewQueueItem[] = rows.map((r) => {
      const createdAt = new Date(r.created_at);
      const ageHours = Math.max(0, (now - createdAt.getTime()) / 36e5);
      return {
        id: r.id,
        type: r.type as ReviewItemType,
        orgId: r.org_id,
        orgName: r.org_name,
        title: r.title,
        subtitle: r.subtitle,
        confidence: normalizeConfidence(r.confidence),
        ageHours,
        createdAt: createdAt.toISOString(),
        payload: (r.payload ?? {}) as Record<string, unknown>,
      };
    });

    return { items };
  } finally {
    client.release();
  }
}

export async function getReviewItemById(id: string): Promise<ReviewQueueDetail | null> {
  const { items } = await listReviewQueue();
  const found = items.find((item) => item.id === id);
  if (!found) return null;
  return {
    ...found,
    detail: found.payload,
  };
}

export async function submitReviewDecision(
  itemId: string,
  input: ReviewDecisionInput,
): Promise<{ ok: true }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const item = await getReviewItemById(itemId);
    if (!item) {
      await client.query("ROLLBACK");
      throw new Error("Review item not found");
    }

    await client.query(
      `
      INSERT INTO soc2_expert_reviews (
        id, org_id, item_type, item_id, decision, note, edited_rationale, reviewer_id, reviewer_email, created_at
      )
      VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, now()
      )
      `,
      [
        item.orgId,
        item.type,
        item.id,
        input.action,
        input.note ?? null,
        input.editedRationale ?? null,
        input.reviewerId,
        input.reviewerEmail ?? null,
      ],
    );

    if (item.type === "control_link") {
      await client.query(
        `
        UPDATE soc2_control_evidence_links
        SET
          status = CASE WHEN $2 = 'approve' THEN 'confirmed' ELSE 'rejected' END,
          rationale = COALESCE($3, rationale),
          reviewed_by = $1,
          reviewed_at = now(),
          updated_at = now()
        WHERE id = $4::uuid
        `,
        [input.reviewerId, input.action, input.editedRationale ?? null, item.id],
      );
    }

    if (item.type === "policy_version") {
      await client.query(
        `
        UPDATE soc2_policy_versions
        SET
          status = CASE WHEN $2 = 'approve' THEN 'approved' ELSE 'in_review' END,
          rationale = COALESCE($3, rationale),
          approved_by = CASE WHEN $2 = 'approve' THEN $1::uuid ELSE approved_by END,
          approved_at = CASE WHEN $2 = 'approve' THEN now() ELSE approved_at END,
          updated_at = now()
        WHERE id = $4::uuid
        `,
        [input.reviewerId, input.action, input.editedRationale ?? null, item.id],
      );
    }

    if (item.type === "critical_gap" && input.action === "approve") {
      await client.query(
        `
        UPDATE soc2_gap_reports
        SET released_at = now(), released_by = $1::uuid
        WHERE id = (
          SELECT report_id FROM soc2_gap_findings WHERE id = $2::uuid
        )
        `,
        [input.reviewerId, item.id],
      );
    }

    await logAuditEvent({
      action: "soc2.expert_review.decision",
      actorId: input.reviewerId,
      targetType: item.type,
      targetId: item.id,
      orgId: item.orgId,
      metadata: {
        decision: input.action,
        note: input.note ?? null,
      },
    });

    await client.query("COMMIT");
    return { ok: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
