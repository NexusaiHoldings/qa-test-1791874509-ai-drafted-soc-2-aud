/**
 * SOC 2 compliance company schema (F1-004 — Security TSC control-to-evidence mapper).
 *
 * Company-owned (not a lego): the Nexus SOC 2 engine seeds the Security Trust
 * Services Criteria common-criteria library, ingests read-only evidence
 * artifacts from AWS / GitHub / uploads, and maps those artifacts to criteria —
 * deterministic rules first, then a gateway call to Claude Sonnet for the
 * remainder. Every mapping lands as `proposed`; only a human Accept promotes a
 * link to `confirmed` (the structural answer to the 35/100 autonomous_operation
 * score and the "customer reliance on gap analysis" liability vector).
 *
 * Picked up by packages/db/migrate.ts via the *_DDL constant convention. All
 * statements are idempotent (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT
 * EXISTS) so repeated deploys are safe.
 *
 * NOTE: soc2_policy_versions / soc2_policy_claims are also declared here because
 * apps/web/lib/agent-tools/persist_policy_draft.ts queries them and the
 * integration TABLE-REF gate requires a creating DDL for every referenced table.
 */
export const SOC2_DDL = `
-- ── Control library (global — the Security TSC criteria are the same for every tenant) ──
CREATE TABLE IF NOT EXISTS soc2_controls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  control_id text UNIQUE NOT NULL,
  category text NOT NULL,
  category_title text NOT NULL,
  title text NOT NULL,
  paraphrase text NOT NULL,
  points_of_focus jsonb NOT NULL DEFAULT '[]'::jsonb,
  satisfying_artifact_types jsonb NOT NULL DEFAULT '[]'::jsonb,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_soc2_controls_category
  ON soc2_controls (category, sort_order);

-- ── Deterministic mapping rules (global) ──
-- Pass 1 of the mapper: an artifact whose type/signal matches a rule proposes
-- the listed criteria without a model call (e.g. IAM root-MFA -> CC6.1, CC6.6).
CREATE TABLE IF NOT EXISTS soc2_mapping_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_key text UNIQUE NOT NULL,
  artifact_type text NOT NULL,
  match_keywords jsonb NOT NULL DEFAULT '[]'::jsonb,
  control_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence numeric(4,3) NOT NULL DEFAULT 0.950,
  rationale text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_soc2_mapping_rules_type
  ON soc2_mapping_rules (artifact_type);

-- ── Evidence artifacts (per-tenant) ──
-- Read-only facts collected from AWS / GitHub / document uploads. The mapper
-- links these to criteria; /controls/[id] renders them as evidence chips.
CREATE TABLE IF NOT EXISTS soc2_evidence_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  source text NOT NULL,
  artifact_type text NOT NULL,
  title text NOT NULL,
  summary text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  collected_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_soc2_evidence_artifacts_org
  ON soc2_evidence_artifacts (org_id, collected_at DESC);
CREATE INDEX IF NOT EXISTS idx_soc2_evidence_artifacts_type
  ON soc2_evidence_artifacts (org_id, artifact_type);

-- ── Control <-> evidence links (per-tenant) ──
-- status: 'proposed' (default) | 'confirmed' (human-accepted) | 'rejected'.
-- mapping_method: 'rule' (deterministic) | 'model' (Claude Sonnet).
-- needs_review: proposed links under 0.7 confidence are held for the operator queue.
CREATE TABLE IF NOT EXISTS soc2_control_evidence_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  control_id text NOT NULL REFERENCES soc2_controls (control_id),
  artifact_id uuid NOT NULL REFERENCES soc2_evidence_artifacts (id) ON DELETE CASCADE,
  mapping_confidence numeric(4,3) NOT NULL DEFAULT 0.000,
  rationale text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'proposed',
  mapping_method text NOT NULL DEFAULT 'model',
  needs_review boolean NOT NULL DEFAULT false,
  model_name text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, control_id, artifact_id)
);
CREATE INDEX IF NOT EXISTS idx_soc2_cel_control
  ON soc2_control_evidence_links (org_id, control_id, status);
CREATE INDEX IF NOT EXISTS idx_soc2_cel_review_queue
  ON soc2_control_evidence_links (org_id, status, needs_review);

-- ── Policy drafting tables (queried by agent-tools/persist_policy_draft.ts) ──
CREATE TABLE IF NOT EXISTS soc2_policy_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  title text NOT NULL,
  body_markdown text NOT NULL,
  rationale text,
  status text NOT NULL DEFAULT 'in_review',
  drafted_by text,
  drafted_with_model text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_soc2_policy_versions_org
  ON soc2_policy_versions (org_id, policy_id, created_at DESC);

CREATE TABLE IF NOT EXISTS soc2_policy_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  policy_version_id uuid NOT NULL REFERENCES soc2_policy_versions (id) ON DELETE CASCADE,
  claim_type text NOT NULL,
  claim_text text NOT NULL,
  source_artifact_id uuid,
  source_excerpt text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_soc2_policy_claims_version
  ON soc2_policy_claims (policy_version_id);

-- ── Policy lifecycle columns (F1-005 — grounded drafting + approval gate) ──
-- A version carries a content_hash (sha256 of body_markdown) so an approval can
-- be pinned to the exact bytes that were approved; the lifecycle is
-- draft -> in_review -> approved. drafted_with_model records the gateway model.
ALTER TABLE soc2_policy_versions
  ADD COLUMN IF NOT EXISTS content_hash text;
ALTER TABLE soc2_policy_versions
  ADD COLUMN IF NOT EXISTS needs_review_count integer NOT NULL DEFAULT 0;
ALTER TABLE soc2_policy_versions
  ADD COLUMN IF NOT EXISTS submitted_by uuid;
ALTER TABLE soc2_policy_versions
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz;
ALTER TABLE soc2_policy_versions
  ADD COLUMN IF NOT EXISTS approved_by uuid;
ALTER TABLE soc2_policy_versions
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;

-- ── Per-tenant policy registry (F1-005) ──
-- The 10 highest-frequency policies from ceo_briefing.mvp_scope. Seeded lazily
-- per org from the soc2_policy_templates skeleton in
-- apps/web/lib/soc2/policies/templates.ts. covered_control_ids lists the Security
-- TSC criteria each policy documents; the drafter grounds a policy only in the
-- CONFIRMED evidence linked to those criteria.
CREATE TABLE IF NOT EXISTS soc2_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  policy_key text NOT NULL,
  title text NOT NULL,
  summary text NOT NULL DEFAULT '',
  covered_control_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, policy_key)
);
CREATE INDEX IF NOT EXISTS idx_soc2_policies_org
  ON soc2_policies (org_id, sort_order);

-- ── Approval records (F1-005 — the COO research_direction gate) ──
-- One immutable row per approval event. Pins the approver (must be an org
-- owner/admin per @nexus/organizations-and-teams) and the content_hash of the
-- version they approved; also mirrored to @nexus/admin-console admin_audit_log.
-- An unapproved version can never enter the audit package (see approval.ts).
CREATE TABLE IF NOT EXISTS soc2_policy_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  policy_version_id uuid NOT NULL REFERENCES soc2_policy_versions (id) ON DELETE CASCADE,
  approver_id uuid NOT NULL,
  approver_email text,
  approver_role text NOT NULL,
  content_hash text NOT NULL,
  decision text NOT NULL DEFAULT 'approved',
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_soc2_policy_approvals_version
  ON soc2_policy_approvals (policy_version_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_soc2_policy_approvals_org
  ON soc2_policy_approvals (org_id, policy_id, created_at DESC);
`;
