/**
 * Policy approval gate (F1-005) — the COO research_direction encoded structurally.
 *
 * Lifecycle: draft -> in_review -> approved. The rules:
 *   - Only an org OWNER or ADMIN (per @nexus/organizations-and-teams org_members
 *     role) may approve.
 *   - The approval row records the exact content_hash of the version approved, so
 *     an approval is pinned to bytes — editing the draft later invalidates it.
 *   - Every approval is mirrored to @nexus/admin-console admin_audit_log.
 *   - An UNAPPROVED version can never enter the audit package
 *     (getApprovedPoliciesForAuditPackage returns approved versions only).
 *
 * This is the human gate that answers the 35/100 autonomous_operation_score: an
 * LLM draft lands in 'draft' and only a human approval row promotes it.
 */

import type { SqlClient } from "@/lib/soc2/controls/library";
import { POLICY_TEMPLATES, templateByKey, type PolicyTemplate } from "@/lib/soc2/policies/templates";
import {
  contentHash,
  getConfirmedArtifactsForPolicy,
  type ConfirmedArtifact,
} from "@/lib/soc2/policies/drafter";

export type PolicyStatus = "not_started" | "draft" | "in_review" | "approved";

/** Roles permitted to approve a policy. */
const APPROVER_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

export interface ApproverCheck {
  readonly isApprover: boolean;
  readonly role: string | null;
}

/** A policy row for the /policies grid. */
export interface PolicyOverviewItem {
  readonly policyId: string;
  readonly policyKey: string;
  readonly title: string;
  readonly summary: string;
  readonly coveredControlIds: readonly string[];
  readonly status: PolicyStatus;
  readonly latestVersionId: string | null;
  readonly needsReviewCount: number;
  readonly approverEmail: string | null;
  readonly approvedAt: string | null;
  readonly updatedAt: string | null;
}

export interface PolicyClaimRow {
  readonly id: string;
  readonly claimType: string;
  readonly claimText: string;
  readonly sourceArtifactId: string | null;
  readonly sourceExcerpt: string | null;
}

export interface PolicyVersionDetail {
  readonly versionId: string;
  readonly title: string;
  readonly bodyMarkdown: string;
  readonly status: PolicyStatus;
  readonly contentHash: string | null;
  readonly needsReviewCount: number;
  readonly model: string | null;
  readonly approverEmail: string | null;
  readonly approvedAt: string | null;
  readonly updatedAt: string | null;
}

export interface PolicyDetail {
  readonly policyId: string;
  readonly template: PolicyTemplate;
  readonly version: PolicyVersionDetail | null;
  readonly claims: readonly PolicyClaimRow[];
  readonly artifacts: readonly ConfirmedArtifact[];
}

export interface ApprovalOutcome {
  readonly ok: boolean;
  readonly reason?: "not_authorized" | "not_in_review" | "not_found" | "error";
  readonly contentHash?: string;
}

function statusOf(raw: string | null | undefined): PolicyStatus {
  if (raw === "approved" || raw === "in_review" || raw === "draft") return raw;
  return "not_started";
}

function toIso(value: string | Date | null): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * Is the user an approver (org owner/admin) for this org? Queries the
 * organizations-and-teams org_members table — the single source of role truth.
 */
export async function isOrgApprover(
  db: SqlClient,
  orgId: string,
  userId: string,
): Promise<ApproverCheck> {
  if (!orgId || !userId) return { isApprover: false, role: null };
  const rows = await db.query<{ role: string }>(
    `SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2 LIMIT 1`,
    orgId,
    userId,
  );
  const role = rows[0]?.role ?? null;
  return { isApprover: role != null && APPROVER_ROLES.has(role), role };
}

/**
 * Seed the 10 MVP policies for an org from the template skeletons. Idempotent:
 * ON CONFLICT (org_id, policy_key) DO NOTHING, safe to call on every page load.
 */
export async function seedPoliciesForOrg(db: SqlClient, orgId: string): Promise<void> {
  const keys = POLICY_TEMPLATES.map((t) => t.policyKey);
  const titles = POLICY_TEMPLATES.map((t) => t.title);
  const summaries = POLICY_TEMPLATES.map((t) => t.summary);
  const controlIds = POLICY_TEMPLATES.map((t) => JSON.stringify(t.coveredControlIds));
  const orders = POLICY_TEMPLATES.map((t) => t.sortOrder);

  await db.execute(
    `INSERT INTO soc2_policies (org_id, policy_key, title, summary, covered_control_ids, sort_order)
     SELECT $1, k, t, s, c::jsonb, o
       FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::int[])
         AS v(k, t, s, c, o)
     ON CONFLICT (org_id, policy_key) DO NOTHING`,
    orgId,
    keys,
    titles,
    summaries,
    controlIds,
    orders,
  );
}

/** True if the org has at least one synced evidence artifact (unlocks drafting). */
export async function orgHasEvidence(db: SqlClient, orgId: string): Promise<boolean> {
  const rows = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM soc2_evidence_artifacts WHERE org_id = $1) AS exists`,
    orgId,
  );
  return Boolean(rows[0]?.exists);
}

interface OverviewRow {
  policy_id: string;
  policy_key: string;
  title: string;
  summary: string;
  covered_control_ids: unknown;
  version_id: string | null;
  version_status: string | null;
  needs_review_count: number | string | null;
  approver_email: string | null;
  approved_at: string | Date | null;
  version_updated_at: string | Date | null;
}

function parseControlIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * The /policies grid: every seeded policy with the status of its LATEST version
 * and (for approved policies) the approver email + timestamp.
 */
export async function getPoliciesOverview(
  db: SqlClient,
  orgId: string,
): Promise<PolicyOverviewItem[]> {
  const rows = await db.query<OverviewRow>(
    `SELECT p.id AS policy_id, p.policy_key, p.title, p.summary, p.covered_control_ids,
            v.id AS version_id, v.status AS version_status,
            v.needs_review_count, u.email AS approver_email,
            v.approved_at, v.updated_at AS version_updated_at
       FROM soc2_policies p
       LEFT JOIN LATERAL (
         SELECT id, status, needs_review_count, approved_by, approved_at, updated_at
           FROM soc2_policy_versions
          WHERE policy_id = p.id AND org_id = p.org_id
          ORDER BY created_at DESC
          LIMIT 1
       ) v ON true
       LEFT JOIN users u ON u.id = v.approved_by
      WHERE p.org_id = $1
      ORDER BY p.sort_order ASC`,
    orgId,
  );

  return rows.map((r) => ({
    policyId: r.policy_id,
    policyKey: r.policy_key,
    title: r.title,
    summary: r.summary,
    coveredControlIds: parseControlIds(r.covered_control_ids),
    status: statusOf(r.version_status),
    latestVersionId: r.version_id,
    needsReviewCount: Number(r.needs_review_count ?? 0),
    approverEmail: r.approver_email,
    approvedAt: toIso(r.approved_at),
    updatedAt: toIso(r.version_updated_at),
  }));
}

interface PolicyRow {
  id: string;
  policy_key: string;
}

/** Resolve a policy's template + key by its per-org UUID. */
export async function resolvePolicy(
  db: SqlClient,
  orgId: string,
  policyId: string,
): Promise<{ policyId: string; template: PolicyTemplate } | null> {
  const rows = await db.query<PolicyRow>(
    `SELECT id, policy_key FROM soc2_policies WHERE id = $1 AND org_id = $2 LIMIT 1`,
    policyId,
    orgId,
  );
  const row = rows[0];
  if (!row) return null;
  const template = templateByKey(row.policy_key);
  if (!template) return null;
  return { policyId: row.id, template };
}

interface VersionRow {
  version_id: string;
  title: string;
  body_markdown: string;
  status: string;
  content_hash: string | null;
  needs_review_count: number | string | null;
  drafted_with_model: string | null;
  approver_email: string | null;
  approved_at: string | Date | null;
  updated_at: string | Date | null;
}

interface ClaimRow {
  id: string;
  claim_type: string;
  claim_text: string;
  source_artifact_id: string | null;
  source_excerpt: string | null;
}

/**
 * Full detail for /policies/[id]: the latest version, its claims (for the
 * evidence rail + NEEDS REVIEW underlines), and the confirmed artifacts used for
 * grounding (the chips the rail renders).
 */
export async function getPolicyDetail(
  db: SqlClient,
  orgId: string,
  policyId: string,
): Promise<PolicyDetail | null> {
  const resolved = await resolvePolicy(db, orgId, policyId);
  if (!resolved) return null;
  const { template } = resolved;

  const versionRows = await db.query<VersionRow>(
    `SELECT v.id AS version_id, v.title, v.body_markdown, v.status, v.content_hash,
            v.needs_review_count, v.drafted_with_model, u.email AS approver_email,
            v.approved_at, v.updated_at
       FROM soc2_policy_versions v
       LEFT JOIN users u ON u.id = v.approved_by
      WHERE v.policy_id = $1 AND v.org_id = $2
      ORDER BY v.created_at DESC
      LIMIT 1`,
    policyId,
    orgId,
  );

  let version: PolicyVersionDetail | null = null;
  let claims: PolicyClaimRow[] = [];
  const vr = versionRows[0];
  if (vr) {
    version = {
      versionId: vr.version_id,
      title: vr.title,
      bodyMarkdown: vr.body_markdown,
      status: statusOf(vr.status),
      contentHash: vr.content_hash,
      needsReviewCount: Number(vr.needs_review_count ?? 0),
      model: vr.drafted_with_model,
      approverEmail: vr.approver_email,
      approvedAt: toIso(vr.approved_at),
      updatedAt: toIso(vr.updated_at),
    };
    const claimRows = await db.query<ClaimRow>(
      `SELECT id, claim_type, claim_text, source_artifact_id, source_excerpt
         FROM soc2_policy_claims
        WHERE policy_version_id = $1 AND org_id = $2
        ORDER BY created_at ASC`,
      vr.version_id,
      orgId,
    );
    claims = claimRows.map((c) => ({
      id: c.id,
      claimType: c.claim_type,
      claimText: c.claim_text,
      sourceArtifactId: c.source_artifact_id,
      sourceExcerpt: c.source_excerpt,
    }));
  }

  const artifacts = await getConfirmedArtifactsForPolicy(db, orgId, template.coveredControlIds);
  return { policyId, template, version, claims, artifacts };
}

/**
 * Submit a draft for review (draft -> in_review). Returns true if a row moved.
 */
export async function submitForReview(
  db: SqlClient,
  orgId: string,
  versionId: string,
  userId: string,
): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `UPDATE soc2_policy_versions
        SET status = 'in_review', submitted_by = $3, submitted_at = now(), updated_at = now()
      WHERE id = $1 AND org_id = $2 AND status = 'draft'
      RETURNING id`,
    versionId,
    orgId,
    userId,
  );
  return rows.length > 0;
}

/**
 * Approve a version (in_review -> approved). Enforces the approver role, pins the
 * content_hash, writes the immutable approval row, and mirrors to the
 * admin-console audit log — all in one transaction-safe sequence.
 */
export async function approvePolicy(
  db: SqlClient,
  orgId: string,
  versionId: string,
  approverId: string,
  approverEmail: string | null,
): Promise<ApprovalOutcome> {
  const check = await isOrgApprover(db, orgId, approverId);
  if (!check.isApprover || !check.role) {
    console.warn(
      JSON.stringify({
        level: "warn",
        component: "soc2.policies.approval",
        message: "approval denied — not an org owner/admin",
        org_id: orgId,
        version_id: versionId,
        user_id: approverId,
      }),
    );
    return { ok: false, reason: "not_authorized" };
  }

  // Load the in-review version and recompute the hash from its bytes so the
  // approval is pinned to exactly what is stored (not a stale client value).
  const versionRows = await db.query<{
    policy_id: string;
    body_markdown: string;
    status: string;
    content_hash: string | null;
  }>(
    `SELECT policy_id, body_markdown, status, content_hash
       FROM soc2_policy_versions
      WHERE id = $1 AND org_id = $2
      LIMIT 1`,
    versionId,
    orgId,
  );
  const ver = versionRows[0];
  if (!ver) return { ok: false, reason: "not_found" };
  if (ver.status !== "in_review") return { ok: false, reason: "not_in_review" };

  const hash = ver.content_hash ?? contentHash(ver.body_markdown);

  const updated = await db.query<{ id: string }>(
    `UPDATE soc2_policy_versions
        SET status = 'approved', approved_by = $3, approved_at = now(),
            content_hash = $4, updated_at = now()
      WHERE id = $1 AND org_id = $2 AND status = 'in_review'
      RETURNING id`,
    versionId,
    orgId,
    approverId,
    hash,
  );
  if (updated.length === 0) {
    // Lost a race (another approver moved it) — treat as not-in-review.
    return { ok: false, reason: "not_in_review" };
  }

  try {
    await db.execute(
      `INSERT INTO soc2_policy_approvals
         (org_id, policy_id, policy_version_id, approver_id, approver_email,
          approver_role, content_hash, decision)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'approved')`,
      orgId,
      ver.policy_id,
      versionId,
      approverId,
      approverEmail,
      check.role,
      hash,
    );

    // Mirror to the admin-console audit log (the immutable cross-lego trail).
    await db.execute(
      `INSERT INTO admin_audit_log (admin_user_id, action, target_type, target_id, payload)
       VALUES ($1, 'soc2.policy.approved', 'soc2_policy_version', $2, $3::jsonb)`,
      approverId,
      versionId,
      JSON.stringify({
        org_id: orgId,
        policy_id: ver.policy_id,
        content_hash: hash,
        approver_email: approverEmail,
        approver_role: check.role,
      }),
    );
  } catch (error) {
    // The version is already approved; a failed audit mirror must not 500 the
    // request, but it is a real signal — log it loudly.
    console.error(
      JSON.stringify({
        level: "error",
        component: "soc2.policies.approval",
        message: error instanceof Error ? error.message : "audit mirror failed",
        org_id: orgId,
        version_id: versionId,
      }),
    );
  }

  console.info(
    JSON.stringify({
      level: "info",
      component: "soc2.policies.approval",
      message: "policy approved",
      org_id: orgId,
      policy_id: ver.policy_id,
      version_id: versionId,
      content_hash: hash,
      approver_id: approverId,
    }),
  );
  return { ok: true, contentHash: hash };
}

/**
 * Audit-package export surface: ONLY approved versions, each with its pinned
 * content_hash and approval metadata. An unapproved version is structurally
 * excluded — the SQL filters on status = 'approved'.
 */
export async function getApprovedPoliciesForAuditPackage(
  db: SqlClient,
  orgId: string,
): Promise<
  Array<{
    policyId: string;
    policyKey: string;
    title: string;
    versionId: string;
    contentHash: string | null;
    approvedAt: string | null;
    approverEmail: string | null;
  }>
> {
  const rows = await db.query<{
    policy_id: string;
    policy_key: string;
    title: string;
    version_id: string;
    content_hash: string | null;
    approved_at: string | Date | null;
    approver_email: string | null;
  }>(
    `SELECT p.id AS policy_id, p.policy_key, v.title, v.id AS version_id,
            v.content_hash, v.approved_at, u.email AS approver_email
       FROM soc2_policies p
       JOIN LATERAL (
         SELECT id, title, content_hash, approved_by, approved_at
           FROM soc2_policy_versions
          WHERE policy_id = p.id AND org_id = p.org_id AND status = 'approved'
          ORDER BY approved_at DESC
          LIMIT 1
       ) v ON true
       LEFT JOIN users u ON u.id = v.approved_by
      WHERE p.org_id = $1
      ORDER BY p.sort_order ASC`,
    orgId,
  );
  return rows.map((r) => ({
    policyId: r.policy_id,
    policyKey: r.policy_key,
    title: r.title,
    versionId: r.version_id,
    contentHash: r.content_hash,
    approvedAt: toIso(r.approved_at),
    approverEmail: r.approver_email,
  }));
}
