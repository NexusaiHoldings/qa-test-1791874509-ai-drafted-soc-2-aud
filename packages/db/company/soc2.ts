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
  content_hash text,
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

-- ── Audit package exports (F1-007) ──
CREATE TABLE IF NOT EXISTS soc2_audit_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  exported_by uuid NOT NULL,
  manifest_hash text NOT NULL,
  package_file_id text NOT NULL,
  pdf_file_id text NOT NULL,
  signed_url text,
  expires_at timestamptz,
  package_meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_soc2_audit_packages_org
  ON soc2_audit_packages (org_id, created_at DESC);

-- ── Expert review records (F1-008) ──
CREATE TABLE IF NOT EXISTS soc2_expert_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  item_type text NOT NULL,
  item_id uuid NOT NULL,
  decision text NOT NULL,
  note text,
  edited_rationale text,
  reviewer_id uuid NOT NULL,
  reviewer_email text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_soc2_expert_reviews_org
  ON soc2_expert_reviews (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_soc2_expert_reviews_item
  ON soc2_expert_reviews (item_type, item_id, created_at DESC);

-- ── GitHub connector registry + sync runs + webhook events (F1-003) ──
CREATE TABLE IF NOT EXISTS soc2_connector_installations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  provider text NOT NULL,
  installation_id text,
  account_login text,
  account_type text,
  status text NOT NULL DEFAULT 'not_installed',
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error text,
  connected_at timestamptz,
  disconnected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, provider)
);
CREATE INDEX IF NOT EXISTS idx_soc2_connector_installations_org
  ON soc2_connector_installations (org_id, provider);

CREATE TABLE IF NOT EXISTS soc2_connector_repositories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  provider text NOT NULL,
  installation_id text NOT NULL,
  repository_id text NOT NULL,
  repository_name text NOT NULL,
  full_name text NOT NULL,
  default_branch text,
  is_selected boolean NOT NULL DEFAULT true,
  is_archived boolean NOT NULL DEFAULT false,
  private boolean NOT NULL DEFAULT true,
  branch_protected boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, provider, repository_id)
);
CREATE INDEX IF NOT EXISTS idx_soc2_connector_repositories_org
  ON soc2_connector_repositories (org_id, provider, repository_name);

CREATE TABLE IF NOT EXISTS soc2_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  provider text NOT NULL,
  run_type text NOT NULL DEFAULT 'manual',
  status text NOT NULL DEFAULT 'running',
  started_by uuid,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  artifacts_written integer NOT NULL DEFAULT 0,
  repositories_scanned integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text
);
CREATE INDEX IF NOT EXISTS idx_soc2_sync_runs_org
  ON soc2_sync_runs (org_id, provider, started_at DESC);

CREATE TABLE IF NOT EXISTS soc2_connector_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid,
  provider text NOT NULL,
  event_name text NOT NULL,
  delivery_id text,
  installation_id text,
  repository_id text,
  action text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  status text NOT NULL DEFAULT 'received',
  error text
);
CREATE INDEX IF NOT EXISTS idx_soc2_connector_webhooks_installation
  ON soc2_connector_webhook_events (provider, installation_id, received_at DESC);
`;

/**
 * Weekly gap analysis + remediation tracker (F1-006).
 *
 * The 'gap assessment and readiness review' workstream becomes a weekly
 * automated report (Monday 06:00 UTC cron, also runnable on demand). The scorer
 * computes a 0..100 coverage score per Security TSC criterion from confirmed
 * evidence links, approved policy coverage and artifact freshness (<90 days),
 * then writes:
 *   - one soc2_gap_reports row (overall readiness %, week-over-week delta);
 *   - one soc2_gap_findings row per criterion below the readiness threshold
 *     (severity, missing evidence, specific remediation instructions);
 *   - one soc2_remediation_tasks row per finding the customer can assign/close.
 *
 * Critical findings hold the digest: a report with ≥1 critical finding is written
 * with released_at = NULL and sits in the operator review queue until an owner/
 * admin clears it (liability human_in_loop_required_for[1]). Only then is the
 * @nexus/notifications email + in-app digest sent. A report with no critical
 * finding auto-releases on generation.
 *
 * Idempotent (CREATE TABLE IF NOT EXISTS) and picked up by migrate.ts via the
 * *_DDL suffix convention.
 */
export const SOC2_GAPS_DDL = `
-- ── Weekly gap report (per-tenant, one immutable snapshot per week) ──
CREATE TABLE IF NOT EXISTS soc2_gap_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  report_week date NOT NULL,
  overall_readiness numeric(5,2) NOT NULL DEFAULT 0,
  previous_readiness numeric(5,2),
  readiness_delta numeric(6,2) NOT NULL DEFAULT 0,
  total_criteria integer NOT NULL DEFAULT 0,
  covered_criteria integer NOT NULL DEFAULT 0,
  findings_count integer NOT NULL DEFAULT 0,
  critical_count integer NOT NULL DEFAULT 0,
  resolved_since_last integer NOT NULL DEFAULT 0,
  generated_by text NOT NULL DEFAULT 'cron',
  category_breakdown jsonb NOT NULL DEFAULT '[]'::jsonb,
  released_at timestamptz,
  released_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, report_week)
);
CREATE INDEX IF NOT EXISTS idx_soc2_gap_reports_org
  ON soc2_gap_reports (org_id, report_week DESC);

-- ── Per-criterion findings below the readiness threshold ──
-- severity: 'critical' | 'high' | 'medium' | 'low'. Critical findings are held
-- (released_at on the parent report stays NULL) until an operator clears them.
CREATE TABLE IF NOT EXISTS soc2_gap_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  report_id uuid NOT NULL REFERENCES soc2_gap_reports (id) ON DELETE CASCADE,
  control_id text NOT NULL,
  severity text NOT NULL,
  score numeric(5,2) NOT NULL DEFAULT 0,
  missing_evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  remediation_instructions text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_soc2_gap_findings_report
  ON soc2_gap_findings (report_id, severity, created_at DESC);

-- ── Actionable remediation tasks ──
CREATE TABLE IF NOT EXISTS soc2_remediation_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  finding_id uuid NOT NULL REFERENCES soc2_gap_findings (id) ON DELETE CASCADE,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open',
  priority text NOT NULL DEFAULT 'medium',
  assignee_id uuid,
  due_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_soc2_remediation_tasks_org
  ON soc2_remediation_tasks (org_id, status, priority, created_at DESC);
`;
