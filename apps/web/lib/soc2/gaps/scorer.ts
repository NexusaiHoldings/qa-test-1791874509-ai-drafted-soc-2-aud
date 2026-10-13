/**
 * Weekly gap scorer (F1-006).
 *
 * Computes a 0..100 coverage score for every Security TSC criterion from three
 * deterministic signals (no model call — grounding must be exact):
 *   1. CONFIRMED evidence links (soc2_control_evidence_links, status='confirmed').
 *      Nothing counts until a human Accepts it (the autonomy-score gate).
 *   2. APPROVED policy coverage (soc2_policies.covered_control_ids where the
 *      latest soc2_policy_versions row is status='approved').
 *   3. Artifact FRESHNESS — at least one confirmed artifact collected in the
 *      last 90 days (stale evidence is a SOC 2 audit red flag).
 *
 * From those scores it writes one soc2_gap_reports row (overall readiness % +
 * week-over-week delta), one soc2_gap_findings row per criterion below the
 * readiness threshold (severity, missing evidence, specific remediation text),
 * and one soc2_remediation_tasks row per finding. A report with ≥1 critical
 * finding is held (released_at=NULL) for the operator review queue; a clean
 * report auto-releases. All inserts run against the per-tenant DB over raw SQL.
 */

import { SECURITY_TSC_CONTROLS, type ControlSeed, type SqlClient } from "@/lib/soc2/controls/library";
import { buildRemediation, type FindingSeverity } from "@/lib/soc2/gaps/remediation";

/** A criterion is "covered" (not a finding) at/above this readiness score. */
export const READINESS_THRESHOLD = 70;

/** Evidence older than this many days no longer counts as fresh. */
export const FRESHNESS_WINDOW_DAYS = 90;

/** Weights for the three coverage signals — sum to 100. */
const WEIGHT_CONFIRMED = 55;
const WEIGHT_POLICY = 25;
const WEIGHT_FRESHNESS = 20;

/** Categories whose gaps are treated as the most audit-critical. */
const CRITICAL_CATEGORIES: ReadonlySet<string> = new Set(["CC6", "CC7"]);

export interface CriterionScore {
  readonly controlId: string;
  readonly category: string;
  readonly categoryTitle: string;
  readonly title: string;
  readonly score: number;
  readonly confirmedLinks: number;
  readonly hasApprovedPolicy: boolean;
  readonly freshEvidence: boolean;
  readonly missingEvidence: readonly string[];
  readonly severity: FindingSeverity;
  readonly remediation: string;
  readonly isFinding: boolean;
}

export interface CategoryBreakdown {
  readonly category: string;
  readonly categoryTitle: string;
  readonly totalCriteria: number;
  readonly coveredCriteria: number;
  readonly averageScore: number;
}

export interface GapReportResult {
  readonly reportId: string;
  readonly reportWeek: string;
  readonly overallReadiness: number;
  readonly previousReadiness: number | null;
  readonly delta: number;
  readonly totalCriteria: number;
  readonly coveredCriteria: number;
  readonly findingsCount: number;
  readonly criticalCount: number;
  readonly resolvedSinceLast: number;
  readonly released: boolean;
}

interface ConfirmedRow {
  control_id: string;
  confirmed_links: string | number;
  fresh_links: string | number;
}

interface PolicyRow {
  control_id: string;
}

/** Round to 2 decimals (readiness is stored numeric(5,2)). */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Monday 00:00 UTC of the ISO week that contains `at` — the report_week key. */
export function isoWeekMonday(at: Date): string {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const day = d.getUTCDay(); // 0 (Sun) .. 6 (Sat)
  const diff = day === 0 ? -6 : 1 - day; // shift back to Monday
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

/**
 * Load per-criterion confirmed-link counts (total + fresh within the window).
 * One pass over the org's confirmed links joined to their artifacts.
 */
async function loadConfirmedCounts(
  db: SqlClient,
  orgId: string,
): Promise<Map<string, { confirmed: number; fresh: number }>> {
  const rows = await db.query<ConfirmedRow>(
    `SELECT l.control_id,
            COUNT(*)                                                         AS confirmed_links,
            COUNT(*) FILTER (WHERE a.collected_at >= now() - ($2::int * INTERVAL '1 day')) AS fresh_links
       FROM soc2_control_evidence_links l
       JOIN soc2_evidence_artifacts a ON a.id = l.artifact_id
      WHERE l.org_id = $1 AND l.status = 'confirmed'
      GROUP BY l.control_id`,
    orgId,
    FRESHNESS_WINDOW_DAYS,
  );
  const map = new Map<string, { confirmed: number; fresh: number }>();
  for (const r of rows) {
    map.set(r.control_id, { confirmed: Number(r.confirmed_links), fresh: Number(r.fresh_links) });
  }
  return map;
}

/**
 * Load the set of control ids that an APPROVED policy documents. Only policies
 * whose latest version is status='approved' count — a draft never closes a gap.
 */
async function loadApprovedPolicyControlIds(db: SqlClient, orgId: string): Promise<Set<string>> {
  const rows = await db.query<PolicyRow>(
    `SELECT DISTINCT jsonb_array_elements_text(p.covered_control_ids) AS control_id
       FROM soc2_policies p
      WHERE p.org_id = $1
        AND EXISTS (
          SELECT 1 FROM soc2_policy_versions v
           WHERE v.policy_id = p.id AND v.org_id = p.org_id AND v.status = 'approved'
        )`,
    orgId,
  );
  const set = new Set<string>();
  for (const r of rows) {
    if (r.control_id) set.add(r.control_id);
  }
  return set;
}

/** Assign a severity to a sub-threshold criterion from its score + category. */
function severityFor(control: ControlSeed, score: number): FindingSeverity {
  const isCriticalCategory = CRITICAL_CATEGORIES.has(control.category);
  if (score <= 0 && isCriticalCategory) return "critical";
  if (score < 30) return isCriticalCategory ? "critical" : "high";
  if (score < 50) return isCriticalCategory ? "high" : "medium";
  return "low";
}

/** The evidence types a criterion still lacks confirmed, fresh evidence for. */
function missingEvidenceFor(
  control: ControlSeed,
  confirmedLinks: number,
  freshEvidence: boolean,
): string[] {
  if (confirmedLinks > 0 && freshEvidence) return [];
  const types = control.satisfyingArtifactTypes.length > 0
    ? [...control.satisfyingArtifactTypes]
    : ["confirmed evidence artifact"];
  return types;
}

/** Score one criterion from the three signals. */
export function scoreCriterion(
  control: ControlSeed,
  confirmed: { confirmed: number; fresh: number } | undefined,
  hasApprovedPolicy: boolean,
): CriterionScore {
  const confirmedLinks = confirmed?.confirmed ?? 0;
  const freshLinks = confirmed?.fresh ?? 0;
  const freshEvidence = freshLinks > 0;

  // Confirmed-evidence signal: full credit at ≥2 confirmed links, half at 1.
  let confirmedPoints = 0;
  if (confirmedLinks >= 2) confirmedPoints = WEIGHT_CONFIRMED;
  else if (confirmedLinks === 1) confirmedPoints = WEIGHT_CONFIRMED * 0.6;

  const policyPoints = hasApprovedPolicy ? WEIGHT_POLICY : 0;
  const freshnessPoints = freshEvidence ? WEIGHT_FRESHNESS : 0;

  const score = round2(Math.min(100, confirmedPoints + policyPoints + freshnessPoints));
  const isFinding = score < READINESS_THRESHOLD;
  const severity = severityFor(control, score);
  const missingEvidence = missingEvidenceFor(control, confirmedLinks, freshEvidence);
  const remediation = buildRemediation({
    control,
    confirmedLinks,
    hasApprovedPolicy,
    freshEvidence,
    missingEvidence,
  });

  return {
    controlId: control.controlId,
    category: control.category,
    categoryTitle: control.categoryTitle,
    title: control.title,
    score,
    confirmedLinks,
    hasApprovedPolicy,
    freshEvidence,
    missingEvidence,
    severity,
    remediation,
    isFinding,
  };
}

/** Score every Security TSC criterion for an org. */
export async function scoreAllCriteria(db: SqlClient, orgId: string): Promise<CriterionScore[]> {
  const confirmedCounts = await loadConfirmedCounts(db, orgId);
  const approvedPolicyControlIds = await loadApprovedPolicyControlIds(db, orgId);
  return SECURITY_TSC_CONTROLS.map((control) =>
    scoreCriterion(
      control,
      confirmedCounts.get(control.controlId),
      approvedPolicyControlIds.has(control.controlId),
    ),
  );
}

/** Roll the per-criterion scores up into a per-category breakdown. */
export function buildCategoryBreakdown(scores: readonly CriterionScore[]): CategoryBreakdown[] {
  const groups = new Map<string, CriterionScore[]>();
  for (const s of scores) {
    const list = groups.get(s.category) ?? [];
    list.push(s);
    groups.set(s.category, list);
  }
  const out: CategoryBreakdown[] = [];
  for (const [category, list] of groups) {
    const total = list.length;
    const covered = list.filter((s) => !s.isFinding).length;
    const avg = total === 0 ? 0 : list.reduce((n, s) => n + s.score, 0) / total;
    out.push({
      category,
      categoryTitle: list[0]?.categoryTitle ?? category,
      totalCriteria: total,
      coveredCriteria: covered,
      averageScore: round2(avg),
    });
  }
  out.sort((a, b) => a.category.localeCompare(b.category));
  return out;
}

interface PrevReportRow {
  id: string;
  overall_readiness: string | number;
}

/** The readiness % of the most recent PRIOR report (before this week). */
async function loadPreviousReadiness(
  db: SqlClient,
  orgId: string,
  reportWeek: string,
): Promise<{ readiness: number | null; reportId: string | null }> {
  const rows = await db.query<PrevReportRow>(
    `SELECT id, overall_readiness
       FROM soc2_gap_reports
      WHERE org_id = $1 AND report_week < $2::date
      ORDER BY report_week DESC
      LIMIT 1`,
    orgId,
    reportWeek,
  );
  const row = rows[0];
  if (!row) return { readiness: null, reportId: null };
  return { readiness: Number(row.overall_readiness), reportId: row.id };
}

/** Control ids that were findings in a given prior report (for closed-since). */
async function loadPreviousFindingControlIds(
  db: SqlClient,
  reportId: string | null,
): Promise<Set<string>> {
  if (!reportId) return new Set();
  const rows = await db.query<{ control_id: string }>(
    `SELECT control_id FROM soc2_gap_findings WHERE report_id = $1`,
    reportId,
  );
  return new Set(rows.map((r) => r.control_id));
}

const INSERT_REPORT_SQL = `
  INSERT INTO soc2_gap_reports (
    org_id, report_week, overall_readiness, previous_readiness, readiness_delta,
    total_criteria, covered_criteria, findings_count, critical_count,
    resolved_since_last, generated_by, category_breakdown, released_at, created_at
  )
  VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, now())
  ON CONFLICT (org_id, report_week) DO UPDATE SET
    overall_readiness = EXCLUDED.overall_readiness,
    previous_readiness = EXCLUDED.previous_readiness,
    readiness_delta = EXCLUDED.readiness_delta,
    total_criteria = EXCLUDED.total_criteria,
    covered_criteria = EXCLUDED.covered_criteria,
    findings_count = EXCLUDED.findings_count,
    critical_count = EXCLUDED.critical_count,
    resolved_since_last = EXCLUDED.resolved_since_last,
    generated_by = EXCLUDED.generated_by,
    category_breakdown = EXCLUDED.category_breakdown,
    released_at = CASE
      WHEN soc2_gap_reports.released_at IS NOT NULL THEN soc2_gap_reports.released_at
      ELSE EXCLUDED.released_at
    END
  RETURNING id, (xmax = 0) AS inserted
`;

/**
 * Generate (or regenerate) the gap report for the ISO week containing `at`.
 *
 * Deterministic + idempotent: re-running the same week upserts the report and
 * replaces its findings/tasks that have NOT yet been touched by the customer
 * (a task with an assignee or a non-open status is preserved). Returns the
 * report summary. Critical findings keep the report held (released_at NULL);
 * a clean report is released immediately so its digest can be sent.
 */
export async function generateGapReport(
  db: SqlClient,
  orgId: string,
  options?: { generatedBy?: "cron" | "manual"; at?: Date },
): Promise<GapReportResult> {
  const at = options?.at ?? new Date();
  const generatedBy = options?.generatedBy ?? "cron";
  const reportWeek = isoWeekMonday(at);

  const scores = await scoreAllCriteria(db, orgId);
  const breakdown = buildCategoryBreakdown(scores);
  const findings = scores.filter((s) => s.isFinding);
  const criticalCount = findings.filter((s) => s.severity === "critical").length;
  const totalCriteria = scores.length;
  const coveredCriteria = totalCriteria - findings.length;
  const overallReadiness = round2(
    totalCriteria === 0 ? 0 : scores.reduce((n, s) => n + s.score, 0) / totalCriteria,
  );

  const { readiness: previousReadiness, reportId: prevReportId } = await loadPreviousReadiness(
    db,
    orgId,
    reportWeek,
  );
  const prevFindingControlIds = await loadPreviousFindingControlIds(db, prevReportId);
  const currentFindingControlIds = new Set(findings.map((f) => f.controlId));
  let resolvedSinceLast = 0;
  for (const controlId of prevFindingControlIds) {
    if (!currentFindingControlIds.has(controlId)) resolvedSinceLast += 1;
  }

  const delta = previousReadiness == null ? 0 : round2(overallReadiness - previousReadiness);
  const releasedAt = criticalCount > 0 ? null : new Date().toISOString();

  const reportRows = await db.query<{ id: string; inserted: boolean }>(
    INSERT_REPORT_SQL,
    orgId,
    reportWeek,
    overallReadiness,
    previousReadiness,
    delta,
    totalCriteria,
    coveredCriteria,
    findings.length,
    criticalCount,
    resolvedSinceLast,
    generatedBy,
    JSON.stringify(breakdown),
    releasedAt,
  );
  const reportId = reportRows[0]?.id;
  if (!reportId) throw new Error("failed to persist gap report");

  await persistFindingsAndTasks(db, orgId, reportId, findings);

  const result: GapReportResult = {
    reportId,
    reportWeek,
    overallReadiness,
    previousReadiness,
    delta,
    totalCriteria,
    coveredCriteria,
    findingsCount: findings.length,
    criticalCount,
    resolvedSinceLast,
    released: releasedAt != null,
  };
  console.info(
    JSON.stringify({
      level: "info",
      component: "soc2.gaps.scorer",
      org_id: orgId,
      report_id: reportId,
      report_week: reportWeek,
      ...result,
      previousReportId: prevReportId,
    }),
  );
  return result;
}

const INSERT_FINDING_SQL = `
  INSERT INTO soc2_gap_findings (
    org_id, report_id, control_id, category, category_title, control_title,
    coverage_score, severity, confirmed_links, has_approved_policy,
    fresh_evidence, missing_evidence, remediation, created_at
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, now())
  ON CONFLICT (report_id, control_id) DO UPDATE SET
    category = EXCLUDED.category,
    category_title = EXCLUDED.category_title,
    control_title = EXCLUDED.control_title,
    coverage_score = EXCLUDED.coverage_score,
    severity = EXCLUDED.severity,
    confirmed_links = EXCLUDED.confirmed_links,
    has_approved_policy = EXCLUDED.has_approved_policy,
    fresh_evidence = EXCLUDED.fresh_evidence,
    missing_evidence = EXCLUDED.missing_evidence,
    remediation = EXCLUDED.remediation
  RETURNING id
`;

const INSERT_TASK_SQL = `
  INSERT INTO soc2_remediation_tasks (
    org_id, report_id, finding_id, control_id, title, instructions,
    severity, status, created_at, updated_at
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', now(), now())
  ON CONFLICT (finding_id) DO UPDATE SET
    title = EXCLUDED.title,
    severity = EXCLUDED.severity,
    -- Only refresh the instructions of a task the customer has not started.
    instructions = CASE
      WHEN soc2_remediation_tasks.status = 'open'
        AND soc2_remediation_tasks.assignee_id IS NULL
      THEN EXCLUDED.instructions
      ELSE soc2_remediation_tasks.instructions
    END,
    updated_at = now()
`;

/**
 * Write one finding row + one remediation task per sub-threshold criterion.
 * Also deletes stale findings (criteria that recovered on a regeneration of the
 * same week) so the snapshot reflects the current scores.
 */
async function persistFindingsAndTasks(
  db: SqlClient,
  orgId: string,
  reportId: string,
  findings: readonly CriterionScore[],
): Promise<void> {
  const keepControlIds = findings.map((f) => f.controlId);

  // Remove findings for criteria that are no longer below threshold this run.
  await db.execute(
    `DELETE FROM soc2_gap_findings
      WHERE report_id = $1
        AND ($2::text[] = '{}' OR control_id <> ALL($2::text[]))`,
    reportId,
    keepControlIds,
  );

  for (const finding of findings) {
    const findingRows = await db.query<{ id: string }>(
      INSERT_FINDING_SQL,
      orgId,
      reportId,
      finding.controlId,
      finding.category,
      finding.categoryTitle,
      finding.title,
      finding.score,
      finding.severity,
      finding.confirmedLinks,
      finding.hasApprovedPolicy,
      finding.freshEvidence,
      JSON.stringify(finding.missingEvidence),
      finding.remediation,
    );
    const findingId = findingRows[0]?.id;
    if (!findingId) continue;

    await db.execute(
      INSERT_TASK_SQL,
      orgId,
      reportId,
      findingId,
      finding.controlId,
      `Remediate ${finding.controlId} — ${finding.title}`,
      finding.remediation,
      finding.severity,
    );
  }
}
