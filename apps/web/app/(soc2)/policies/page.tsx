/**
 * /policies — the ten MVP policy cards (F1-005).
 *
 * Server component. A top progress ring shows "x of 10 approved"; each policy is
 * a card with a status pill (Not started / Draft / In review / Approved), the
 * approver avatar (initials) once approved, and the criteria it documents.
 *
 * Empty state: drafting unlocks once at least one connector has synced — until
 * then the page points the user at the connectors. The policy registry is seeded
 * lazily (idempotently) on first visit.
 */
import type { JSX } from "react";
import Link from "next/link";
import { buildDb } from "@/lib/db";
import { getSessionUser } from "@/lib/admin-auth";
import { resolveOrgId } from "@/lib/soc2/controls/mapper";
import {
  getPoliciesOverview,
  orgHasEvidence,
  seedPoliciesForOrg,
  type PolicyOverviewItem,
  type PolicyStatus,
} from "@/lib/soc2/policies/approval";
import { POLICY_TEMPLATES } from "@/lib/soc2/policies/templates";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATUS_LABELS: Readonly<Record<PolicyStatus, string>> = {
  not_started: "Not started",
  draft: "Draft",
  in_review: "In review",
  approved: "Approved",
};

function statusColor(status: PolicyStatus): string {
  switch (status) {
    case "approved":
      return "var(--substrate-success)";
    case "in_review":
      return "var(--substrate-accent)";
    case "draft":
      return "var(--substrate-fg)";
    default:
      return "var(--substrate-border-strong)";
  }
}

function initials(email: string): string {
  const name = email.split("@")[0] ?? email;
  const parts = name.split(/[.\-_]+/).filter(Boolean);
  const chars = parts.length >= 2 ? parts[0][0] + parts[1][0] : name.slice(0, 2);
  return chars.toUpperCase();
}

function ProgressRing({ approved, total }: { approved: number; total: number }): JSX.Element {
  const ratio = total === 0 ? 0 : approved / total;
  const pct = Math.round(ratio * 100);
  const size = 72;
  const stroke = 7;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const dash = circumference * ratio;
  return (
    <span
      role="img"
      aria-label={`${approved} of ${total} policies approved`}
      title={`${approved} of ${total} approved`}
      style={{ display: "inline-flex" }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--substrate-border)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={ratio >= 1 ? "var(--substrate-success)" : "var(--substrate-accent)"}
          strokeWidth={stroke}
          strokeDasharray={`${dash} ${circumference - dash}`}
          strokeDashoffset={circumference * 0.25}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <text x="50%" y="46%" dominantBaseline="central" textAnchor="middle" fontSize="16" fontWeight={600} fill="var(--substrate-fg)">
          {approved}/{total}
        </text>
        <text x="50%" y="64%" dominantBaseline="central" textAnchor="middle" fontSize="9" fill="var(--substrate-fg)">
          {pct}%
        </text>
      </svg>
    </span>
  );
}

function StatusPill({ status }: { status: PolicyStatus }): JSX.Element {
  const color = statusColor(status);
  return (
    <span
      style={{
        fontSize: "0.75rem",
        fontWeight: 600,
        color,
        border: `1px solid ${color}`,
        borderRadius: "999px",
        padding: "0.1rem 0.6rem",
        whiteSpace: "nowrap",
      }}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

function Avatar({ email }: { email: string }): JSX.Element {
  return (
    <span
      aria-label={`Approved by ${email}`}
      title={`Approved by ${email}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: "28px",
        height: "28px",
        borderRadius: "999px",
        background: "var(--substrate-surface-2)",
        border: "1px solid var(--substrate-success)",
        color: "var(--substrate-fg)",
        fontSize: "0.7rem",
        fontWeight: 600,
      }}
    >
      {initials(email)}
    </span>
  );
}

function PolicyCard({ policy }: { policy: PolicyOverviewItem }): JSX.Element {
  return (
    <Link
      href={`/policies/${encodeURIComponent(policy.policyId)}`}
      className="card"
      style={{ display: "flex", flexDirection: "column", gap: "0.6rem", textDecoration: "none", color: "inherit" }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem" }}>
        <StatusPill status={policy.status} />
        {policy.status === "approved" && policy.approverEmail ? (
          <Avatar email={policy.approverEmail} />
        ) : policy.needsReviewCount > 0 ? (
          <span className="muted" style={{ fontSize: "0.72rem", color: "var(--substrate-warning, #b26a00)" }}>
            {policy.needsReviewCount} to review
          </span>
        ) : null}
      </div>
      <strong style={{ fontSize: "1.02rem" }}>{policy.title}</strong>
      <span className="muted" style={{ fontSize: "0.85rem", lineHeight: 1.4 }}>
        {policy.summary}
      </span>
      <span className="muted" style={{ fontSize: "0.72rem" }}>
        Criteria: {policy.coveredControlIds.join(", ")}
      </span>
    </Link>
  );
}

export default async function PoliciesPage(): Promise<JSX.Element> {
  const user = await getSessionUser();
  if (!user) {
    return (
      <main>
        <h1>Policies</h1>
        <p className="empty">
          Please <Link href="/login">log in</Link> to draft and approve your SOC 2 policies.
        </p>
      </main>
    );
  }

  const db = buildDb();
  const orgId = await resolveOrgId(db, user.id);
  if (!orgId) {
    return (
      <main>
        <h1>Policies</h1>
        <p>Grounded SOC 2 policy drafting, with a human approval gate on every document.</p>
        <p className="empty">
          Set up your workspace first on the <Link href="/org">organization page</Link>, then connect
          a source to start collecting evidence.
        </p>
      </main>
    );
  }

  let hasEvidence = false;
  let policies: PolicyOverviewItem[] = [];
  try {
    await seedPoliciesForOrg(db, orgId);
    hasEvidence = await orgHasEvidence(db, orgId);
    policies = await getPoliciesOverview(db, orgId);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        component: "soc2.policies.page",
        org_id: orgId,
        message: error instanceof Error ? error.message : "policies load failed",
      }),
    );
  }

  const total = POLICY_TEMPLATES.length;
  const approved = policies.filter((p) => p.status === "approved").length;

  return (
    <main>
      <h1>Policies</h1>
      <p>Grounded SOC 2 policy drafting, with a human approval gate on every document.</p>

      {!hasEvidence ? (
        <div className="empty">
          <p style={{ marginTop: 0 }}>Drafting unlocks once at least one connector has synced.</p>
          <p>
            <Link href="/controls" className="btn">
              Go to connectors
            </Link>
          </p>
        </div>
      ) : (
        <>
          <div className="card" style={{ display: "flex", alignItems: "center", gap: "1.25rem" }}>
            <ProgressRing approved={approved} total={total} />
            <div>
              <strong>
                {approved} of {total} approved
              </strong>
              <p className="muted" style={{ margin: 0 }}>
                Each policy is drafted from your confirmed evidence, then approved by an org owner or
                admin before it can enter an audit package.
              </p>
            </div>
          </div>

          {policies.length === 0 ? (
            <p className="empty">The policy set is still initializing. Refresh in a moment.</p>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
                gap: "1rem",
                marginTop: "1.5rem",
              }}
            >
              {policies.map((p) => (
                <PolicyCard key={p.policyId} policy={p} />
              ))}
            </div>
          )}
        </>
      )}
    </main>
  );
}
