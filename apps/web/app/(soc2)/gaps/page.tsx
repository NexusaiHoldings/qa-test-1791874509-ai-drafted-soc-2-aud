/**
 * /gaps — the weekly readiness dashboard (F1-006).
 *
 * Server component. Opens with a hero readiness ring (large numeral + accent arc)
 * beside a week-over-week trend chart, then a findings table grouped by severity
 * with status pills. Each row is a <details> accordion (no client JS) that expands
 * to the remediation instructions, the evidence that would close it, and an
 * assign/due-date control. A held report (critical findings) shows an operator
 * "Release digest" banner gated to org owners/admins.
 *
 * Empty state: "Your first gap report runs after the first sync" with a "Run it
 * now" accent action. All actions are Server Actions defined in this file, so
 * there is no page.tsx/route.ts collision.
 */
import type { CSSProperties, JSX } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { buildDb } from "@/lib/db";
import { getSessionUser } from "@/lib/admin-auth";
import { resolveOrgId } from "@/lib/soc2/controls/mapper";
import { isOrgApprover } from "@/lib/soc2/policies/approval";
import { generateGapReport } from "@/lib/soc2/gaps/scorer";
import {
  assignTask,
  closeTask,
  getGapReportDetail,
  getLatestReport,
  getReportHistory,
  releaseReport,
  reopenTask,
  sendGapDigest,
  SEVERITY_META,
  STATUS_META,
  type GapFindingRow,
  type GapReportSummary,
  type SeverityGroup,
} from "@/lib/soc2/gaps/remediation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ── Server Actions ────────────────────────────────────────────────────────────

async function runNowAction(): Promise<void> {
  "use server";
  const user = await getSessionUser();
  if (!user) return;
  const db = buildDb();
  const orgId = await resolveOrgId(db, user.id);
  if (!orgId) return;
  try {
    const report = await generateGapReport(db, orgId, { generatedBy: "manual" });
    if (report.released) {
      await sendGapDigest(db, orgId, report.reportId);
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        component: "soc2.gaps.page.run",
        org_id: orgId,
        message: error instanceof Error ? error.message : "run failed",
      }),
    );
    redirect("/gaps?error=run");
  }
  revalidatePath("/gaps");
}

async function assignAction(formData: FormData): Promise<void> {
  "use server";
  const taskId = String(formData.get("taskId") ?? "");
  if (!taskId) return;
  const user = await getSessionUser();
  if (!user) return;
  const db = buildDb();
  const orgId = await resolveOrgId(db, user.id);
  if (!orgId) return;

  const emailRaw = String(formData.get("assigneeEmail") ?? "").trim();
  const dueRaw = String(formData.get("dueDate") ?? "").trim();
  const email = emailRaw.length > 0 ? emailRaw : null;
  const dueDate = dueRaw.length > 0 ? dueRaw : null;

  // Resolve the email to an org member's user id when possible (best-effort).
  let userId: string | null = null;
  if (email) {
    const rows = await db.query<{ id: string }>(
      `SELECT u.id FROM users u
         JOIN org_members m ON m.user_id = u.id AND m.org_id = $2
        WHERE lower(u.email) = lower($1) LIMIT 1`,
      email,
      orgId,
    );
    userId = rows[0]?.id ?? null;
  }

  await assignTask(db, orgId, taskId, { userId, email }, dueDate);
  revalidatePath("/gaps");
}

async function closeTaskAction(formData: FormData): Promise<void> {
  "use server";
  const taskId = String(formData.get("taskId") ?? "");
  if (!taskId) return;
  const user = await getSessionUser();
  if (!user) return;
  const db = buildDb();
  const orgId = await resolveOrgId(db, user.id);
  if (!orgId) return;
  await closeTask(db, orgId, taskId, user.id || null);
  revalidatePath("/gaps");
}

async function reopenTaskAction(formData: FormData): Promise<void> {
  "use server";
  const taskId = String(formData.get("taskId") ?? "");
  if (!taskId) return;
  const user = await getSessionUser();
  if (!user) return;
  const db = buildDb();
  const orgId = await resolveOrgId(db, user.id);
  if (!orgId) return;
  await reopenTask(db, orgId, taskId);
  revalidatePath("/gaps");
}

async function releaseAction(formData: FormData): Promise<void> {
  "use server";
  const reportId = String(formData.get("reportId") ?? "");
  if (!reportId) return;
  const user = await getSessionUser();
  if (!user) return;
  const db = buildDb();
  const orgId = await resolveOrgId(db, user.id);
  if (!orgId) return;

  const approver = await isOrgApprover(db, orgId, user.id);
  if (!approver.isApprover) {
    redirect("/gaps?error=not_authorized");
  }
  await releaseReport(db, orgId, reportId, user.id || null);
  revalidatePath("/gaps");
}

// ── Presentational helpers ────────────────────────────────────────────────────

const accentButton: CSSProperties = {
  background: "var(--substrate-accent)",
  color: "var(--substrate-accent-text, #fff)",
  border: "none",
};

function readinessColor(pct: number): string {
  if (pct >= 80) return "var(--substrate-success, #16a34a)";
  if (pct >= 60) return "var(--substrate-accent, #6366f1)";
  if (pct >= 40) return "#b26a00";
  return "var(--substrate-danger, #b00020)";
}

function ReadinessRing({ value }: { value: number }): JSX.Element {
  const pct = Math.max(0, Math.min(100, value));
  const size = 180;
  const stroke = 16;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const dash = (circumference * pct) / 100;
  const color = readinessColor(pct);
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`Overall readiness ${pct}%`}
    >
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--substrate-border)" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeDasharray={`${dash} ${circumference - dash}`}
        strokeDashoffset={circumference * 0.25}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x="50%" y="46%" dominantBaseline="central" textAnchor="middle" fontSize="40" fontWeight="700" fill="var(--substrate-fg)">
        {Math.round(pct)}%
      </text>
      <text x="50%" y="64%" dominantBaseline="central" textAnchor="middle" fontSize="12" fill="var(--substrate-fg-muted, #6b7280)">
        readiness
      </text>
    </svg>
  );
}

function DeltaBadge({ report }: { report: GapReportSummary }): JSX.Element {
  if (report.previousReadiness == null) {
    return <span className="muted">First report — no prior week to compare.</span>;
  }
  const up = report.delta > 0;
  const flat = report.delta === 0;
  const color = flat ? "var(--substrate-fg-muted, #6b7280)" : up ? "var(--substrate-success, #16a34a)" : "var(--substrate-danger, #b00020)";
  const arrow = flat ? "▬" : up ? "▲" : "▼";
  return (
    <span style={{ color, fontWeight: 600 }}>
      {arrow} {up ? "+" : ""}
      {report.delta}% week-over-week
    </span>
  );
}

/** Week-over-week trend sparkline from the report history (oldest → newest). */
function TrendChart({ history }: { history: readonly GapReportSummary[] }): JSX.Element {
  const series = [...history].reverse(); // oldest first
  if (series.length < 2) {
    return (
      <div className="empty" style={{ marginTop: 0 }}>
        <p style={{ margin: 0 }}>The trend chart appears once you have two or more weekly reports.</p>
      </div>
    );
  }
  const width = 320;
  const height = 160;
  const pad = 24;
  const n = series.length;
  const maxX = width - pad * 2;
  const points = series.map((r, i) => {
    const x = pad + (n === 1 ? 0 : (maxX * i) / (n - 1));
    const y = pad + (1 - r.overallReadiness / 100) * (height - pad * 2);
    return { x, y, value: r.overallReadiness, week: r.reportWeek };
  });
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const last = points[points.length - 1];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Readiness trend">
      <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} stroke="var(--substrate-border)" />
      <line x1={pad} y1={pad} x2={pad} y2={height - pad} stroke="var(--substrate-border)" />
      <path d={path} fill="none" stroke="var(--substrate-accent, #6366f1)" strokeWidth={2.5} strokeLinejoin="round" />
      {points.map((p) => (
        <circle key={p.week} cx={p.x} cy={p.y} r={3} fill="var(--substrate-accent, #6366f1)">
          <title>{`${p.week}: ${p.value}%`}</title>
        </circle>
      ))}
      <text x={last.x} y={last.y - 8} textAnchor="middle" fontSize="11" fill="var(--substrate-fg)">
        {Math.round(last.value)}%
      </text>
    </svg>
  );
}

function StatusPill({ status }: { status: keyof typeof STATUS_META }): JSX.Element {
  const bg =
    status === "done"
      ? "var(--substrate-success, #16a34a)"
      : status === "in_progress"
        ? "var(--substrate-accent, #6366f1)"
        : "var(--substrate-surface-2, #e5e7eb)";
  const fg = status === "open" ? "var(--substrate-fg)" : "#fff";
  return (
    <span
      style={{
        fontSize: "0.72rem",
        padding: "0.1rem 0.55rem",
        borderRadius: "999px",
        background: bg,
        color: fg,
        whiteSpace: "nowrap",
      }}
    >
      {STATUS_META[status]}
    </span>
  );
}

function SeverityPill({ severity }: { severity: GapFindingRow["severity"] }): JSX.Element {
  const meta = SEVERITY_META[severity];
  return (
    <span
      style={{
        fontSize: "0.72rem",
        padding: "0.1rem 0.55rem",
        borderRadius: "999px",
        border: `1px solid ${meta.color}`,
        color: meta.color,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      {meta.label}
    </span>
  );
}

function TaskControls({ finding, readOnly }: { finding: GapFindingRow; readOnly: boolean }): JSX.Element {
  const task = finding.task;
  if (!task) {
    return <p className="muted">No remediation task is attached to this finding.</p>;
  }
  if (readOnly) {
    return (
      <p className="muted">
        {task.assigneeEmail ? `Assigned to ${task.assigneeEmail}.` : "Unassigned."}
        {task.dueDate ? ` Due ${task.dueDate}.` : ""} Status: {STATUS_META[task.status]}.
      </p>
    );
  }
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem", alignItems: "flex-end", marginTop: "0.75rem" }}>
      <form action={assignAction} className="toolbar" style={{ marginTop: 0 }}>
        <input type="hidden" name="taskId" value={task.taskId} />
        <label style={{ display: "flex", flexDirection: "column", fontSize: "0.78rem", gap: "0.2rem" }}>
          Assignee email
          <input
            type="email"
            name="assigneeEmail"
            defaultValue={task.assigneeEmail ?? ""}
            placeholder="name@company.com"
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", fontSize: "0.78rem", gap: "0.2rem" }}>
          Due date
          <input type="date" name="dueDate" defaultValue={task.dueDate ?? ""} />
        </label>
        <button type="submit" className="btn secondary">
          Save
        </button>
      </form>
      {task.status === "done" ? (
        <form action={reopenTaskAction}>
          <input type="hidden" name="taskId" value={task.taskId} />
          <button type="submit" className="btn secondary">
            Reopen
          </button>
        </form>
      ) : (
        <form action={closeTaskAction}>
          <input type="hidden" name="taskId" value={task.taskId} />
          <button type="submit" style={accentButton}>
            Mark done
          </button>
        </form>
      )}
    </div>
  );
}

function FindingRow({ finding, readOnly }: { finding: GapFindingRow; readOnly: boolean }): JSX.Element {
  const status = finding.task?.status ?? "open";
  return (
    <details className="card" style={{ marginBottom: "0.75rem" }}>
      <summary style={{ cursor: "pointer", listStyle: "none" }}>
        <span style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.6rem" }}>
          <SeverityPill severity={finding.severity} />
          <strong>{finding.controlId}</strong>
          <span style={{ flex: 1, minWidth: "140px" }}>{finding.controlTitle}</span>
          <span className="muted" style={{ fontSize: "0.8rem" }}>
            {finding.coverageScore}%
          </span>
          <StatusPill status={status} />
        </span>
      </summary>
      <div style={{ marginTop: "0.9rem", display: "flex", flexDirection: "column", gap: "0.6rem" }}>
        <p style={{ margin: 0 }}>{finding.remediation}</p>
        <div>
          <strong style={{ fontSize: "0.82rem" }}>Evidence that would close it:</strong>
          {finding.missingEvidence.length > 0 ? (
            <ul style={{ margin: "0.3rem 0 0" }}>
              {finding.missingEvidence.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          ) : (
            <p className="muted" style={{ margin: "0.3rem 0 0" }}>
              Refresh the existing confirmed evidence so it is current.
            </p>
          )}
        </div>
        <p className="muted" style={{ fontSize: "0.78rem", margin: 0 }}>
          {finding.confirmedLinks} confirmed link{finding.confirmedLinks === 1 ? "" : "s"} ·{" "}
          {finding.hasApprovedPolicy ? "approved policy" : "no approved policy"} ·{" "}
          {finding.freshEvidence ? "fresh evidence" : "evidence stale/missing"}
        </p>
        <TaskControls finding={finding} readOnly={readOnly} />
      </div>
    </details>
  );
}

function FindingsSection({ groups, readOnly }: { groups: readonly SeverityGroup[]; readOnly: boolean }): JSX.Element {
  if (groups.length === 0) {
    return (
      <div className="empty">
        <p style={{ margin: 0 }}>No gaps this week — every criterion is at or above the readiness threshold. 🎉</p>
      </div>
    );
  }
  return (
    <>
      {groups.map((group) => (
        <section key={group.severity} style={{ marginTop: "1.5rem" }}>
          <h2 style={{ marginBottom: "0.5rem" }}>
            <span style={{ color: SEVERITY_META[group.severity].color }}>{SEVERITY_META[group.severity].label}</span>{" "}
            <span className="muted" style={{ fontWeight: 400, fontSize: "0.9rem" }}>
              ({group.findings.length})
            </span>
          </h2>
          {group.findings.map((f) => (
            <FindingRow key={f.findingId} finding={f} readOnly={readOnly} />
          ))}
        </section>
      ))}
    </>
  );
}

function errorMessage(code: string | undefined): string | null {
  switch (code) {
    case "run":
      return "The gap report could not be generated. Please try running it again.";
    case "not_authorized":
      return "Only an org owner or admin can release a held report.";
    default:
      return code ? "Something went wrong. Please try again." : null;
  }
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function GapsPage({
  searchParams,
}: {
  searchParams?: { error?: string };
}): Promise<JSX.Element> {
  const user = await getSessionUser();
  if (!user) {
    return (
      <main>
        <h1>Gap analysis</h1>
        <p className="empty">
          Please <Link href="/login">log in</Link> to view your weekly SOC 2 readiness report.
        </p>
      </main>
    );
  }

  const db = buildDb();
  const orgId = await resolveOrgId(db, user.id);
  if (!orgId) {
    return (
      <main>
        <h1>Gap analysis</h1>
        <p>Know in 30 minutes where you stand against the Security Trust Services Criteria.</p>
        <p className="empty">
          Set up your workspace on the <Link href="/org">organization page</Link> first, then connect
          AWS or upload documents to start collecting evidence.
        </p>
      </main>
    );
  }

  const latest = await getLatestReport(db, orgId);
  const notice = errorMessage(searchParams?.error);

  if (!latest) {
    return (
      <main>
        <h1>Gap analysis</h1>
        <p>Know in 30 minutes where you stand against the Security Trust Services Criteria.</p>
        {notice && (
          <div className="card" role="alert" style={{ borderColor: "var(--substrate-danger)" }}>
            {notice}
          </div>
        )}
        <div className="empty">
          <p style={{ marginTop: 0, fontSize: "2.5rem", lineHeight: 1 }} aria-hidden="true">
            ☑️ ⬜ ⬜
          </p>
          <p style={{ fontWeight: 600, marginBottom: "0.25rem" }}>Your first gap report runs after the first sync.</p>
          <p className="muted">
            Connect AWS or GitHub and confirm a few evidence mappings on{" "}
            <Link href="/controls">Controls</Link> — then run the report to see exactly where you stand.
          </p>
          <form action={runNowAction} style={{ marginTop: "1rem" }}>
            <button type="submit" style={accentButton}>
              Run it now
            </button>
          </form>
        </div>
      </main>
    );
  }

  const detail = await getGapReportDetail(db, orgId, latest.reportId);
  const history = await getReportHistory(db, orgId, 12);
  const approver = await isOrgApprover(db, orgId, user.id);
  const report = detail?.report ?? latest;
  const held = !report.released;

  return (
    <main>
      <h1>Gap analysis</h1>
      <p>Your weekly SOC 2 readiness — week of {report.reportWeek}.</p>

      {notice && (
        <div className="card" role="alert" style={{ borderColor: "var(--substrate-danger)", marginBottom: "1rem" }}>
          {notice}
        </div>
      )}

      {held && (
        <div
          className="card"
          role="alert"
          style={{
            borderColor: "var(--substrate-danger)",
            display: "flex",
            justifyContent: "space-between",
            gap: "1rem",
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <span>
            <strong>Held for review.</strong> This report has {report.criticalCount} critical finding
            {report.criticalCount === 1 ? "" : "s"}. The digest is not sent until an operator clears it.
          </span>
          {approver.isApprover ? (
            <form action={releaseAction}>
              <input type="hidden" name="reportId" value={report.reportId} />
              <button type="submit" style={accentButton}>
                Release digest
              </button>
            </form>
          ) : (
            <span className="muted">Awaiting release by an org owner or admin.</span>
          )}
        </div>
      )}

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "2rem",
          alignItems: "center",
          marginTop: "1rem",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "0.5rem" }}>
          <ReadinessRing value={report.overallReadiness} />
          <DeltaBadge report={report} />
        </div>
        <div style={{ flex: 1, minWidth: "280px" }}>
          <h2 style={{ marginTop: 0 }}>Trend</h2>
          <TrendChart history={history} />
          <p className="muted" style={{ fontSize: "0.82rem" }}>
            {report.coveredCriteria} of {report.totalCriteria} criteria covered · {report.findingsCount} open finding
            {report.findingsCount === 1 ? "" : "s"}
            {report.resolvedSinceLast > 0 ? ` · ${report.resolvedSinceLast} closed since last week` : ""}
          </p>
        </div>
      </div>

      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", marginTop: "1rem" }}>
        <form action={runNowAction}>
          <button type="submit" className="btn secondary">
            Re-run this week
          </button>
        </form>
        <Link href={`/gaps/${encodeURIComponent(report.reportId)}`} className="btn secondary">
          View this week&apos;s snapshot
        </Link>
      </div>

      <h2 style={{ marginTop: "2rem" }}>Findings</h2>
      <FindingsSection groups={detail?.groups ?? []} readOnly={false} />
    </main>
  );
}
