/**
 * /controls — Security TSC criteria grid (F1-004).
 *
 * Server component. Grouped by CC category; each category header carries a
 * coverage ring (confirmed criteria ÷ total) and each criterion a card with a
 * short paraphrase, an evidence-count badge and a confidence bar. The control
 * library + deterministic mapping rules are seeded lazily on first visit.
 */
import type { JSX } from "react";
import Link from "next/link";
import { buildDb } from "@/lib/db";
import { getSessionUser } from "@/lib/admin-auth";
import {
  controlLibraryIsSeeded,
  seedControlLibrary,
} from "@/lib/soc2/controls/library";
import {
  getControlsGrid,
  resolveOrgId,
  type CategoryGroup,
  type ControlGridItem,
} from "@/lib/soc2/controls/mapper";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function CoverageRing({ ratio, label }: { ratio: number; label: string }): JSX.Element {
  const pct = Math.round(ratio * 100);
  const size = 44;
  const stroke = 5;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const dash = circumference * ratio;
  const color =
    ratio >= 0.75
      ? "var(--substrate-success)"
      : ratio > 0
        ? "var(--substrate-accent)"
        : "var(--substrate-border-strong)";
  return (
    <span
      role="img"
      aria-label={`${label}: ${pct}% covered`}
      title={`${label}: ${pct}% covered`}
      style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--substrate-border)"
          strokeWidth={stroke}
        />
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
        <text
          x="50%"
          y="50%"
          dominantBaseline="central"
          textAnchor="middle"
          fontSize="11"
          fill="var(--substrate-fg)"
        >
          {pct}%
        </text>
      </svg>
    </span>
  );
}

function ConfidenceBar({ value }: { value: number }): JSX.Element {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  const color =
    value >= 0.7 ? "var(--substrate-success)" : value > 0 ? "var(--substrate-accent)" : "var(--substrate-border)";
  return (
    <span
      aria-label={`Top confidence ${pct}%`}
      title={`Top confidence ${pct}%`}
      style={{
        display: "block",
        height: "6px",
        width: "100%",
        borderRadius: "999px",
        background: "var(--substrate-surface-2)",
        overflow: "hidden",
      }}
    >
      <span
        style={{
          display: "block",
          height: "100%",
          width: `${pct}%`,
          background: color,
          transition: "width var(--substrate-dur, 150ms) var(--substrate-ease, ease)",
        }}
      />
    </span>
  );
}

function ControlCard({ control }: { control: ControlGridItem }): JSX.Element {
  const hasEvidence = control.evidenceCount > 0;
  return (
    <Link
      href={`/controls/${encodeURIComponent(control.controlId)}`}
      className="card"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
        textDecoration: "none",
        color: "inherit",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "0.5rem" }}>
        <strong>{control.controlId}</strong>
        <span
          className={hasEvidence ? undefined : "muted"}
          style={{
            fontSize: "0.8rem",
            padding: "0.1rem 0.5rem",
            borderRadius: "999px",
            border: "1px solid var(--substrate-border)",
            whiteSpace: "nowrap",
          }}
        >
          {control.evidenceCount} evidence
        </span>
      </div>
      <span style={{ fontWeight: 500 }}>{control.title}</span>
      <span className="muted" style={{ fontSize: "0.85rem", lineHeight: 1.4 }}>
        {control.paraphrase}
      </span>
      <ConfidenceBar value={control.topConfidence} />
      <span className="muted" style={{ fontSize: "0.75rem" }}>
        {control.confirmedCount} confirmed
        {control.proposedCount > 0 ? ` · ${control.proposedCount} proposed` : ""}
        {control.reviewCount > 0 ? ` · ${control.reviewCount} need review` : ""}
      </span>
    </Link>
  );
}

function CategorySection({ group }: { group: CategoryGroup }): JSX.Element {
  return (
    <section style={{ marginTop: "2rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
        <CoverageRing ratio={group.coverage} label={`${group.category} ${group.categoryTitle}`} />
        <div>
          <h2 style={{ margin: 0 }}>
            {group.category} · {group.categoryTitle}
          </h2>
          <p className="muted" style={{ margin: 0 }}>
            {group.coveredCount} of {group.totalCount} criteria with confirmed evidence
          </p>
        </div>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
          gap: "1rem",
          marginTop: "1rem",
        }}
      >
        {group.controls.map((c) => (
          <ControlCard key={c.controlId} control={c} />
        ))}
      </div>
    </section>
  );
}

export default async function ControlsPage(): Promise<JSX.Element> {
  const user = await getSessionUser();
  if (!user) {
    return (
      <main>
        <h1>Controls</h1>
        <p className="empty">
          Please <Link href="/login">log in</Link> to view your SOC 2 control coverage.
        </p>
      </main>
    );
  }

  const db = buildDb();

  // Lazy, idempotent seed of the Security TSC library + deterministic rules.
  try {
    if (!(await controlLibraryIsSeeded(db))) {
      await seedControlLibrary(db);
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        component: "soc2.controls.page",
        message: error instanceof Error ? error.message : "seed failed",
      }),
    );
  }

  const orgId = await resolveOrgId(db, user.id);
  if (!orgId) {
    return (
      <main>
        <h1>Controls</h1>
        <p>The Security Trust Services Criteria, mapped to your evidence.</p>
        <p className="empty">
          Set up your workspace first on the <Link href="/org">organization page</Link>, then
          connect AWS or upload documents to start collecting evidence.
        </p>
      </main>
    );
  }

  let groups: CategoryGroup[] = [];
  try {
    groups = await getControlsGrid(db, orgId);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        component: "soc2.controls.page",
        org_id: orgId,
        message: error instanceof Error ? error.message : "grid query failed",
      }),
    );
  }

  const totalCriteria = groups.reduce((n, g) => n + g.totalCount, 0);
  const totalCovered = groups.reduce((n, g) => n + g.coveredCount, 0);
  const overall = totalCriteria === 0 ? 0 : totalCovered / totalCriteria;

  return (
    <main>
      <h1>Controls</h1>
      <p>The Security Trust Services Criteria, mapped to your evidence.</p>

      {groups.length === 0 ? (
        <p className="empty">
          The control library is still initializing. Refresh in a moment — if this persists, check
          that the database is reachable.
        </p>
      ) : (
        <>
          <div className="card" style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
            <CoverageRing ratio={overall} label="Overall coverage" />
            <div>
              <strong>Overall coverage</strong>
              <p className="muted" style={{ margin: 0 }}>
                {totalCovered} of {totalCriteria} criteria have confirmed evidence. Nothing is
                counted until you Accept it.
              </p>
            </div>
          </div>
          {groups.map((g) => (
            <CategorySection key={g.category} group={g} />
          ))}
        </>
      )}
    </main>
  );
}
