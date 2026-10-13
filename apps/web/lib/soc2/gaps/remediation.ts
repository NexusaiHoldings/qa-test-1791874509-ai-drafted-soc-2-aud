/**
 * Remediation layer (F1-006).
 *
 * Three responsibilities:
 *   1. buildRemediation — turn a scored criterion into the specific, actionable
 *      remediation instructions the finding + task store (ceo_briefing
 *      key_features[2] "specific remediation instructions").
 *   2. Read models for /gaps and /gaps/[reportId] — the latest report, the report
 *      list, and a full report detail (findings grouped by severity, each with its
 *      remediation task and a "closed since last week" strip).
 *   3. Mutations the customer + operator drive — assign/close/reopen a task, and
 *      release a held report (clears the critical-findings hold, then sends the
 *      @nexus/notifications email + in-app digest to org owners/admins).
 *
 * All DB access is raw parameterized SQL through the substrate Db ($1,$2…).
 */

import { buildDb } from "@/lib/db";
import { buildEventBus } from "@/lib/events";
import { handleSendNotification, type HandlerContext } from "@nexus/notifications";
import type { ControlSeed, SqlClient } from "@/lib/soc2/controls/library";

export type FindingSeverity = "critical" | "high" | "medium" | "low";
export type TaskStatus = "open" | "in_progress" | "done";

/** Severity order for grouping (most severe first). */
export const SEVERITY_ORDER: readonly FindingSeverity[] = ["critical", "high", "medium", "low"];

/** A human label + accent token per severity (monochrome-safe accents). */
export const SEVERITY_META: Readonly<Record<FindingSeverity, { label: string; color: string }>> = {
  critical: { label: "Critical", color: "var(--substrate-danger, #b00020)" },
  high: { label: "High", color: "#b26a00" },
  medium: { label: "Medium", color: "var(--substrate-accent, #6366f1)" },
  low: { label: "Low", color: "var(--substrate-fg-muted, #6b7280)" },
};

/** Human label per task status. */
export const STATUS_META: Readonly<Record<TaskStatus, string>> = {
  open: "Open",
  in_progress: "In progress",
  done: "Done",
};

export interface RemediationInput {
  readonly control: ControlSeed;
  readonly confirmedLinks: number;
  readonly hasApprovedPolicy: boolean;
  readonly freshEvidence: boolean;
  readonly missingEvidence: readonly string[];
}

/** Humanize a snake_case artifact type ("iam_root_mfa" -> "IAM root MFA"). */
function humanizeType(raw: string): string {
  const spaced = raw.replace(/[_-]+/g, " ").trim();
  return spaced.replace(/\b(iam|mfa|aws|vpc|s3|sso|api|hr)\b/gi, (m) => m.toUpperCase());
}

/**
 * Build specific remediation instructions for a sub-threshold criterion.
 *
 * The text names (a) what evidence to collect/confirm, (b) whether an approved
 * policy is still needed, and (c) the freshness problem when evidence is stale —
 * so the customer knows exactly what would close the gap.
 */
export function buildRemediation(input: RemediationInput): string {
  const { control, confirmedLinks, hasApprovedPolicy, freshEvidence, missingEvidence } = input;
  const steps: string[] = [];

  if (confirmedLinks === 0) {
    const types = missingEvidence.length > 0 ? missingEvidence.map(humanizeType) : ["supporting evidence"];
    steps.push(
      `Collect and CONFIRM evidence for ${control.controlId} (${control.title}). ` +
        `Expected artifact types: ${types.join(", ")}. Connect AWS/GitHub or upload a document on the Controls page, then Accept the proposed mapping.`,
    );
  } else if (confirmedLinks === 1) {
    steps.push(
      `Only one confirmed artifact backs ${control.controlId}. Confirm at least one more mapping so coverage is not single-sourced — auditors expect corroborating evidence.`,
    );
  }

  if (!freshEvidence && confirmedLinks > 0) {
    steps.push(
      `The confirmed evidence for ${control.controlId} is older than 90 days. Re-collect a current artifact so the control shows it is operating, not just designed.`,
    );
  }

  if (!hasApprovedPolicy) {
    steps.push(
      `No approved policy documents ${control.controlId}. Draft and approve the covering policy on the Policies page so the control has a written, management-approved statement.`,
    );
  }

  if (control.pointsOfFocus.length > 0) {
    steps.push(`Points of focus to address: ${control.pointsOfFocus.join(" ")}`);
  }

  if (steps.length === 0) {
    steps.push(
      `Review ${control.controlId} coverage and confirm the mapped evidence is current and complete.`,
    );
  }
  return steps.join(" ");
}

// ── Read models ──────────────────────────────────────────────────────────────

export interface GapReportSummary {
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
  readonly generatedBy: string;
  readonly released: boolean;
  readonly releasedAt: string | null;
  readonly createdAt: string;
}

export interface CategoryBreakdownRow {
  readonly category: string;
  readonly categoryTitle: string;
  readonly totalCriteria: number;
  readonly coveredCriteria: number;
  readonly averageScore: number;
}

export interface RemediationTaskRow {
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly assigneeId: string | null;
  readonly assigneeEmail: string | null;
  readonly dueDate: string | null;
  readonly closedAt: string | null;
}

export interface GapFindingRow {
  readonly findingId: string;
  readonly controlId: string;
  readonly category: string;
  readonly categoryTitle: string;
  readonly controlTitle: string;
  readonly coverageScore: number;
  readonly severity: FindingSeverity;
  readonly confirmedLinks: number;
  readonly hasApprovedPolicy: boolean;
  readonly freshEvidence: boolean;
  readonly missingEvidence: readonly string[];
  readonly remediation: string;
  readonly task: RemediationTaskRow | null;
}

export interface SeverityGroup {
  readonly severity: FindingSeverity;
  readonly findings: readonly GapFindingRow[];
}

export interface ClosedSinceItem {
  readonly controlId: string;
  readonly controlTitle: string;
}

export interface GapReportDetail {
  readonly report: GapReportSummary;
  readonly breakdown: readonly CategoryBreakdownRow[];
  readonly groups: readonly SeverityGroup[];
  readonly closedSinceLast: readonly ClosedSinceItem[];
}

function toIso(value: string | Date | null): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  return value instanceof Date ? value.toISOString() : String(value);
}

function toStringArray(value: unknown): string[] {
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

function toSeverity(raw: string | null | undefined): FindingSeverity {
  if (raw === "critical" || raw === "high" || raw === "medium" || raw === "low") return raw;
  return "medium";
}

function toStatus(raw: string | null | undefined): TaskStatus {
  if (raw === "open" || raw === "in_progress" || raw === "done") return raw;
  return "open";
}

interface ReportRow {
  id: string;
  report_week: string | Date;
  overall_readiness: string | number;
  previous_readiness: string | number | null;
  readiness_delta: string | number;
  total_criteria: number;
  covered_criteria: number;
  findings_count: number;
  critical_count: number;
  resolved_since_last: number;
  generated_by: string;
  category_breakdown: unknown;
  released_at: string | Date | null;
  created_at: string | Date;
}

function mapReport(r: ReportRow): GapReportSummary {
  return {
    reportId: r.id,
    reportWeek: String(toIso(r.report_week) ?? r.report_week).slice(0, 10),
    overallReadiness: Number(r.overall_readiness),
    previousReadiness: r.previous_readiness == null ? null : Number(r.previous_readiness),
    delta: Number(r.readiness_delta),
    totalCriteria: Number(r.total_criteria),
    coveredCriteria: Number(r.covered_criteria),
    findingsCount: Number(r.findings_count),
    criticalCount: Number(r.critical_count),
    resolvedSinceLast: Number(r.resolved_since_last),
    generatedBy: r.generated_by,
    released: r.released_at != null,
    releasedAt: toIso(r.released_at),
    createdAt: toIso(r.created_at) ?? "",
  };
}

const REPORT_SELECT = `
  id, report_week, overall_readiness, previous_readiness, readiness_delta,
  total_criteria, covered_criteria, findings_count, critical_count,
  resolved_since_last, generated_by, category_breakdown, released_at, created_at
`;

/** The most recent report for an org (the one /gaps opens on), or null. */
export async function getLatestReport(db: SqlClient, orgId: string): Promise<GapReportSummary | null> {
  const rows = await db.query<ReportRow>(
    `SELECT ${REPORT_SELECT} FROM soc2_gap_reports
      WHERE org_id = $1 ORDER BY report_week DESC LIMIT 1`,
    orgId,
  );
  return rows[0] ? mapReport(rows[0]) : null;
}

/** Every report for the trend chart + the week picker, newest first. */
export async function getReportHistory(
  db: SqlClient,
  orgId: string,
  limit = 12,
): Promise<GapReportSummary[]> {
  const rows = await db.query<ReportRow>(
    `SELECT ${REPORT_SELECT} FROM soc2_gap_reports
      WHERE org_id = $1 ORDER BY report_week DESC LIMIT $2`,
    orgId,
    limit,
  );
  return rows.map(mapReport);
}

interface FindingJoinRow {
  finding_id: string;
  control_id: string;
  category: string;
  category_title: string;
  control_title: string;
  coverage_score: string | number;
  severity: string;
  confirmed_links: number;
  has_approved_policy: boolean;
  fresh_evidence: boolean;
  missing_evidence: unknown;
  remediation: string;
  task_id: string | null;
  task_status: string | null;
  assignee_id: string | null;
  assignee_email: string | null;
  due_date: string | Date | null;
  closed_at: string | Date | null;
}

const SEVERITY_RANK: Readonly<Record<FindingSeverity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** Load a report's findings joined to their remediation tasks, grouped by severity. */
async function loadFindingGroups(db: SqlClient, reportId: string): Promise<SeverityGroup[]> {
  const rows = await db.query<FindingJoinRow>(
    `SELECT f.id AS finding_id, f.control_id, f.category, f.category_title,
            f.control_title, f.coverage_score, f.severity, f.confirmed_links,
            f.has_approved_policy, f.fresh_evidence, f.missing_evidence, f.remediation,
            t.id AS task_id, t.status AS task_status, t.assignee_id, t.assignee_email,
            t.due_date, t.closed_at
       FROM soc2_gap_findings f
       LEFT JOIN soc2_remediation_tasks t ON t.finding_id = f.id
      WHERE f.report_id = $1
      ORDER BY f.coverage_score ASC, f.control_id ASC`,
    reportId,
  );

  const bySeverity = new Map<FindingSeverity, GapFindingRow[]>();
  for (const r of rows) {
    const severity = toSeverity(r.severity);
    const finding: GapFindingRow = {
      findingId: r.finding_id,
      controlId: r.control_id,
      category: r.category,
      categoryTitle: r.category_title,
      controlTitle: r.control_title,
      coverageScore: Number(r.coverage_score),
      severity,
      confirmedLinks: Number(r.confirmed_links),
      hasApprovedPolicy: Boolean(r.has_approved_policy),
      freshEvidence: Boolean(r.fresh_evidence),
      missingEvidence: toStringArray(r.missing_evidence),
      remediation: r.remediation,
      task: r.task_id
        ? {
            taskId: r.task_id,
            status: toStatus(r.task_status),
            assigneeId: r.assignee_id,
            assigneeEmail: r.assignee_email,
            dueDate: r.due_date ? String(toIso(r.due_date)).slice(0, 10) : null,
            closedAt: toIso(r.closed_at),
          }
        : null,
    };
    const list = bySeverity.get(severity) ?? [];
    list.push(finding);
    bySeverity.set(severity, list);
  }

  return SEVERITY_ORDER.filter((s) => bySeverity.has(s)).map((severity) => ({
    severity,
    findings: (bySeverity.get(severity) ?? []).sort(
      (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.coverageScore - b.coverageScore,
    ),
  }));
}

/**
 * Criteria that were findings in the PRIOR report but are not findings in this
 * one — the "closed since last week" strip on the snapshot page.
 */
async function loadClosedSinceLast(
  db: SqlClient,
  orgId: string,
  reportWeek: string,
  reportId: string,
): Promise<ClosedSinceItem[]> {
  const rows = await db.query<{ control_id: string; control_title: string }>(
    `WITH prev AS (
       SELECT id FROM soc2_gap_reports
        WHERE org_id = $1 AND report_week < $2::date
        ORDER BY report_week DESC LIMIT 1
     )
     SELECT pf.control_id, pf.control_title
       FROM soc2_gap_findings pf
      WHERE pf.report_id = (SELECT id FROM prev)
        AND NOT EXISTS (
          SELECT 1 FROM soc2_gap_findings cf
           WHERE cf.report_id = $3 AND cf.control_id = pf.control_id
        )
      ORDER BY pf.control_id ASC`,
    orgId,
    reportWeek,
    reportId,
  );
  return rows.map((r) => ({ controlId: r.control_id, controlTitle: r.control_title }));
}

/** Full detail for /gaps and /gaps/[reportId]. */
export async function getGapReportDetail(
  db: SqlClient,
  orgId: string,
  reportId: string,
): Promise<GapReportDetail | null> {
  const rows = await db.query<ReportRow>(
    `SELECT ${REPORT_SELECT} FROM soc2_gap_reports WHERE id = $1 AND org_id = $2 LIMIT 1`,
    reportId,
    orgId,
  );
  const reportRow = rows[0];
  if (!reportRow) return null;
  const report = mapReport(reportRow);

  const breakdown: CategoryBreakdownRow[] = Array.isArray(reportRow.category_breakdown)
    ? (reportRow.category_breakdown as unknown[]).map((raw) => {
        const o = (raw ?? {}) as Record<string, unknown>;
        return {
          category: String(o.category ?? ""),
          categoryTitle: String(o.categoryTitle ?? o.category ?? ""),
          totalCriteria: Number(o.totalCriteria ?? 0),
          coveredCriteria: Number(o.coveredCriteria ?? 0),
          averageScore: Number(o.averageScore ?? 0),
        };
      })
    : typeof reportRow.category_breakdown === "string"
      ? parseBreakdown(reportRow.category_breakdown)
      : [];

  const groups = await loadFindingGroups(db, reportId);
  const closedSinceLast = await loadClosedSinceLast(db, orgId, report.reportWeek, reportId);

  return { report, breakdown, groups, closedSinceLast };
}

function parseBreakdown(raw: string): CategoryBreakdownRow[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => {
      const o = (entry ?? {}) as Record<string, unknown>;
      return {
        category: String(o.category ?? ""),
        categoryTitle: String(o.categoryTitle ?? o.category ?? ""),
        totalCriteria: Number(o.totalCriteria ?? 0),
        coveredCriteria: Number(o.coveredCriteria ?? 0),
        averageScore: Number(o.averageScore ?? 0),
      };
    });
  } catch {
    return [];
  }
}

// ── Mutations ────────────────────────────────────────────────────────────────

/** Assign a remediation task to a user + set an optional due date. */
export async function assignTask(
  db: SqlClient,
  orgId: string,
  taskId: string,
  assignee: { userId: string | null; email: string | null },
  dueDate: string | null,
): Promise<boolean> {
  const due = dueDate && /^\d{4}-\d{2}-\d{2}$/.test(dueDate) ? dueDate : null;
  const rows = await db.query<{ id: string }>(
    `UPDATE soc2_remediation_tasks
        SET assignee_id = $3, assignee_email = $4, due_date = $5::date,
            status = CASE WHEN status = 'done' THEN status
                         WHEN $3 IS NULL AND $4 IS NULL AND $5 IS NULL THEN 'open'
                         ELSE 'in_progress' END,
            updated_at = now()
      WHERE id = $1 AND org_id = $2
      RETURNING id`,
    taskId,
    orgId,
    assignee.userId,
    assignee.email,
    due,
  );
  return rows.length > 0;
}

/** Close a remediation task (status -> done), stamping who/when. */
export async function closeTask(
  db: SqlClient,
  orgId: string,
  taskId: string,
  userId: string | null,
): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `UPDATE soc2_remediation_tasks
        SET status = 'done', closed_at = now(), closed_by = $3, updated_at = now()
      WHERE id = $1 AND org_id = $2 AND status <> 'done'
      RETURNING id`,
    taskId,
    orgId,
    userId,
  );
  return rows.length > 0;
}

/** Reopen a closed task (status -> open). */
export async function reopenTask(db: SqlClient, orgId: string, taskId: string): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `UPDATE soc2_remediation_tasks
        SET status = CASE WHEN assignee_id IS NULL THEN 'open' ELSE 'in_progress' END,
            closed_at = NULL, closed_by = NULL, updated_at = now()
      WHERE id = $1 AND org_id = $2 AND status = 'done'
      RETURNING id`,
    taskId,
    orgId,
  );
  return rows.length > 0;
}

export interface ReleaseOutcome {
  readonly ok: boolean;
  readonly reason?: "not_found" | "already_released" | "digest_failed";
  readonly recipients?: number;
}

/**
 * Release a held report: clear the critical-findings hold (set released_at) and
 * send the digest. Only an operator should call this (the page gates on
 * owner/admin). Idempotent — a report already released returns already_released.
 */
export async function releaseReport(
  db: SqlClient,
  orgId: string,
  reportId: string,
  operatorId: string | null,
): Promise<ReleaseOutcome> {
  const rows = await db.query<{ id: string }>(
    `UPDATE soc2_gap_reports
        SET released_at = now(), released_by = $3
      WHERE id = $1 AND org_id = $2 AND released_at IS NULL
      RETURNING id`,
    reportId,
    orgId,
    operatorId,
  );
  if (rows.length === 0) {
    // Either it does not exist or it was already released.
    const exists = await db.query<{ id: string }>(
      `SELECT id FROM soc2_gap_reports WHERE id = $1 AND org_id = $2 LIMIT 1`,
      reportId,
      orgId,
    );
    return { ok: false, reason: exists.length > 0 ? "already_released" : "not_found" };
  }

  const recipients = await sendGapDigest(db, orgId, reportId).catch((error) => {
    console.error(
      JSON.stringify({
        level: "error",
        component: "soc2.gaps.remediation",
        message: error instanceof Error ? error.message : "digest send failed",
        org_id: orgId,
        report_id: reportId,
      }),
    );
    return -1;
  });

  if (recipients < 0) return { ok: true, reason: "digest_failed", recipients: 0 };
  return { ok: true, recipients };
}

interface RecipientRow {
  user_id: string;
  email: string;
}

/**
 * Send the weekly digest via @nexus/notifications (email + in-app) to the org's
 * owners/admins. Returns the number of recipients the digest was dispatched to.
 */
export async function sendGapDigest(db: SqlClient, orgId: string, reportId: string): Promise<number> {
  const detail = await getGapReportDetail(db, orgId, reportId);
  if (!detail) return 0;

  const recipients = await db.query<RecipientRow>(
    `SELECT DISTINCT u.id AS user_id, u.email
       FROM org_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.org_id = $1 AND m.role IN ('owner', 'admin') AND u.email IS NOT NULL`,
    orgId,
  );
  if (recipients.length === 0) return 0;

  const html = buildDigestHtml(detail);
  const ctx: HandlerContext = { db: buildDb(), events: buildEventBus() } as HandlerContext;
  const config = { default_channels: ["email", "in_app"], resend_from_email: process.env.EMAIL_FROM || "" };

  let sent = 0;
  for (const recipient of recipients) {
    try {
      const result = await handleSendNotification({
        body: {
          user_id: recipient.user_id,
          template_name: "soc2_weekly_gap",
          category: "transactional",
          to_email: recipient.email,
          html_template: html,
          variables: {
            readiness: detail.report.overallReadiness,
            delta: detail.report.delta,
            findings: detail.report.findingsCount,
          },
        },
        config,
        ctx,
      });
      if (result.status < 400) sent += 1;
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          component: "soc2.gaps.remediation",
          message: error instanceof Error ? error.message : "notification failed",
          org_id: orgId,
          user_id: recipient.user_id,
        }),
      );
    }
  }

  console.info(
    JSON.stringify({
      level: "info",
      component: "soc2.gaps.remediation",
      message: "gap digest sent",
      org_id: orgId,
      report_id: reportId,
      recipients: sent,
    }),
  );
  return sent;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Build the HTML body of the weekly digest email (substrate wraps it). */
export function buildDigestHtml(detail: GapReportDetail): string {
  const { report, groups, closedSinceLast } = detail;
  const arrow = report.delta > 0 ? "▲" : report.delta < 0 ? "▼" : "▬";
  const deltaText =
    report.previousReadiness == null
      ? "First report"
      : `${arrow} ${report.delta > 0 ? "+" : ""}${report.delta}% week-over-week`;

  const findingLines = groups
    .flatMap((g) => g.findings)
    .slice(0, 10)
    .map(
      (f) =>
        `<li><strong>${escapeHtml(SEVERITY_META[f.severity].label)}</strong> — ` +
        `${escapeHtml(f.controlId)} ${escapeHtml(f.controlTitle)} (${f.coverageScore}%)</li>`,
    )
    .join("");

  const closedLine =
    closedSinceLast.length > 0
      ? `<p>✅ Closed since last week: ${closedSinceLast
          .map((c) => escapeHtml(c.controlId))
          .join(", ")}</p>`
      : "";

  return [
    `<h1>Weekly SOC 2 readiness: ${report.overallReadiness}%</h1>`,
    `<p>${escapeHtml(deltaText)} — week of ${escapeHtml(report.reportWeek)}.</p>`,
    `<p>${report.coveredCriteria} of ${report.totalCriteria} criteria covered · ` +
      `${report.findingsCount} open finding${report.findingsCount === 1 ? "" : "s"} ` +
      `(${report.criticalCount} critical).</p>`,
    closedLine,
    findingLines ? `<h2>Top findings</h2><ul>${findingLines}</ul>` : "<p>No gaps — you are audit-ready.</p>",
    `<p>Open the full report in your gap dashboard to assign remediation tasks.</p>`,
  ].join("\n");
}
