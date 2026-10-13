/**
 * /gaps/[reportId] — the immutable weekly snapshot (F1-006).
 *
 * Server component, read-only. Renders the readiness ring + the trend up to that
 * week, a "closed since last week" strip, the per-category breakdown, and the
 * findings grouped by severity with status pills + remediation detail. Unlike
 * /gaps, there are no assign/close controls — a snapshot is a point-in-time record
 * of where the org stood that week (the auditor-facing artifact).
 */
import type { JSX } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { buildDb } from "@/lib/db";
import { getSessionUser } from "@/lib/admin-auth";
import { resolveOrgId } from "@/lib/soc2/controls/mapper";
import {
  getGapReportDetail,
  getReportHistory,
  SEVERITY_META,
  STATUS_META,
  type ClosedSinceItem,
  type GapFindingRow,
  type GapReportDetail,
  type GapReportSummary,
  type SeverityGroup,
} from "@/lib/soc2/gaps/remediation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function readinessColor(pct: number): string {
  if (pct >= 80) return "var(--substrate-success, #16a34a)";
  if (pct >= 60) return "var(--substrate-accent, #6366f1)";
  if (pct >= 40) return "#b26a00";
  return "var(--substrate-danger, #b00020)";
}

function ReadinessRing({ value }: { value: number }): JSX.Element {
  const pct = Math.max(0, Math.min(100, value));
  const size = 160;
  const stroke = 14;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const dash = (circumference * pct) / 100;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`Readiness ${pct}%`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--substrate-border)" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={readinessColor(pct)}
        strokeWidth={stroke}
        strokeDasharray={`${dash} ${circumference - dash}`}
        strokeDashoffset={circumference * 0.25}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" fontSize="36" fontWeight="700" fill="var(--substrate-fg)">
        {Math.round(pct)}%
      </text>
    </svg>
  );
}

function DeltaText({ report }: { report: GapReportSummary }): JSX.Element {
  if (report.previousReadiness == null) {
    return <span className="muted">First report.</span>;
  }
  const up = report.delta > 0;
  const flat = report.delta === 0;
  const color = flat
    ? "var(--substrate-fg-muted, #6b7280)"
    : up
      ? "var(--substrate-success, #16a34a)"
      : "var(--substrate-danger, #b00020)";
  const arrow = flat ? "▬" : up ? "▲" : "▼";
  return (
    <span style={{ color, fontWeight: 600 }}>
      {arrow} {up ? "+" : ""}
      {report.delta}% vs. prior week
    </span>
  );
}

function TrendChart({ history }: { history: readonly GapReportSummary[] }): JSX.Element {
  const series = [...history].reverse(); // oldest first
  if (series.length < 2) {
    return <p className="muted">Trend appears once two or more reports exist.</p>;
  }
  const width = 320;
  const height = 150;
  const pad = 24;
  const n = series.length;
  const maxX = width - pad * 2;
  const points = series.map((r, i) => ({
    x: pad + (n === 1 ? 0 : (maxX * i) / (n - 1)),
    y: pad + (1 - r.overallReadiness / 100) * (height - pad * 2),
    value: r.overallReadiness,
    week: r.reportWeek,
  }));
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
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
    </svg>
  );
}

function ClosedStrip({ items }: { items: readonly ClosedSinceItem[] }): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <div
      className="card"
      style={{
        borderColor: "var(--substrate-success, #16a34a)",
        display: "flex",
        flexWrap: "wrap",
        gap: "0.5rem",
        alignItems: "center",
      }}
    >
      <strong style={{ color: "var(--substrate-success, #16a34a)" }}>
        ✅ Closed since last week ({items.length})
      </strong>
      {items.map((c) => (
        <span
          key={c.controlId}
          title={c.controlTitle}
          style={{
            fontSize: "0.78rem",
            padding: "0.1rem 0.5rem",
            borderRadius: "999px",
            border: "1px solid var(--substrate-border)",
          }}
        >
          {c.controlId}
        </span>
      ))}
    </div>
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

function StatusPill({ status }: { status: keyof typeof STATUS_META }): JSX.Element {
  const bg =
    status === "done"
      ? "var(--substrate-success, #16a34a)"
      : status === "in_progress"
        ? "var(--substrate-accent, #6366f1)"
        : "var(--substrate-surface-2, #e5e7eb)";
  const fg = status === "open" ? "var(--substrate-fg)" : "#fff";
  return (
    <span style={{ fontSize: "0.72rem", padding: "0.1rem 0.55rem", borderRadius: "999px", background: bg, color: fg }}>
      {STATUS_META[status]}
    </span>
  );
}

function FindingRow({ finding }: { finding: GapFindingRow }): JSX.Element {
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
        {finding.missingEvidence.length > 0 && (
          <div>
            <strong style={{ fontSize: "0.82rem" }}>Evidence that would close it:</strong>
            <ul style={{ margin: "0.3rem 0 0" }}>
              {finding.missingEvidence.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </div>
        )}
        {finding.task && (
          <p className="muted" style={{ fontSize: "0.78rem", margin: 0 }}>
            {finding.task.assigneeEmail ? `Assigned to ${finding.task.assigneeEmail}.` : "Unassigned."}
            {finding.task.dueDate ? ` Due ${finding.task.dueDate}.` : ""}
          </p>
        )}
      </div>
    </details>
  );
}

function FindingsSection({ groups }: { groups: readonly SeverityGroup[] }): JSX.Element {
  if (groups.length === 0) {
    return (
      <div className="empty">
        <p style={{ margin: 0 }}>No gaps were recorded in this snapshot — every criterion was at or above threshold.</p>
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
            <FindingRow key={f.findingId} finding={f} />
          ))}
        </section>
      ))}
    </>
  );
}

function Breakdown({ detail }: { detail: GapReportDetail }): JSX.Element | null {
  if (detail.breakdown.length === 0) return null;
  return (
    <section style={{ marginTop: "2rem" }}>
      <h2>By category</h2>
      <table>
        <thead>
          <tr>
            <th>Category</th>
            <th>Covered</th>
            <th>Avg. score</th>
          </tr>
        </thead>
        <tbody>
          {detail.breakdown.map((b) => (
            <tr key={b.category}>
              <td>
                {b.category} · {b.categoryTitle}
              </td>
              <td>
                {b.coveredCriteria}/{b.totalCriteria}
              </td>
              <td>{b.averageScore}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export default async function GapSnapshotPage({
  params,
}: {
  params: { reportId: string };
}): Promise<JSX.Element> {
  const reportId = decodeURIComponent(params.reportId);

  const user = await getSessionUser();
  if (!user) {
    return (
      <main>
        <p>
          <Link href="/gaps">← Back to gap analysis</Link>
        </p>
        <p className="empty">
          Please <Link href="/login">log in</Link> to view this snapshot.
        </p>
      </main>
    );
  }

  const db = buildDb();
  const orgId = await resolveOrgId(db, user.id);
  if (!orgId) {
    return (
      <main>
        <p>
          <Link href="/gaps">← Back to gap analysis</Link>
        </p>
        <p className="empty">
          Set up your workspace on the <Link href="/org">organization page</Link> first.
        </p>
      </main>
    );
  }

  let detail: GapReportDetail | null = null;
  try {
    detail = await getGapReportDetail(db, orgId, reportId);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        component: "soc2.gaps.snapshot",
        org_id: orgId,
        report_id: reportId,
        message: error instanceof Error ? error.message : "snapshot load failed",
      }),
    );
  }
  if (!detail) notFound();

  const report = detail.report;
  const fullHistory = await getReportHistory(db, orgId, 24);
  const history = fullHistory.filter((r) => r.reportWeek <= report.reportWeek);

  return (
    <main>
      <p>
        <Link href="/gaps">← Back to gap analysis</Link>
      </p>
      <h1>Readiness snapshot — week of {report.reportWeek}</h1>
      <p>
        An immutable record of where you stood that week.{" "}
        {report.released
          ? report.releasedAt
            ? `Released ${report.releasedAt.slice(0, 10)}.`
            : "Released."
          : "Held for operator review (not yet released)."}
      </p>

      <ClosedStrip items={detail.closedSinceLast} />

      <div style={{ display: "flex", flexWrap: "wrap", gap: "2rem", alignItems: "center", marginTop: "1rem" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "0.5rem" }}>
          <ReadinessRing value={report.overallReadiness} />
          <DeltaText report={report} />
        </div>
        <div style={{ flex: 1, minWidth: "280px" }}>
          <h2 style={{ marginTop: 0 }}>Trend to this week</h2>
          <TrendChart history={history} />
          <p className="muted" style={{ fontSize: "0.82rem" }}>
            {report.coveredCriteria} of {report.totalCriteria} criteria covered · {report.findingsCount} finding
            {report.findingsCount === 1 ? "" : "s"} ({report.criticalCount} critical)
            {report.resolvedSinceLast > 0 ? ` · ${report.resolvedSinceLast} closed since last week` : ""}
          </p>
        </div>
      </div>

      <Breakdown detail={detail} />

      <h2 style={{ marginTop: "2rem" }}>Findings</h2>
      <FindingsSection groups={detail.groups} />
    </main>
  );
}
