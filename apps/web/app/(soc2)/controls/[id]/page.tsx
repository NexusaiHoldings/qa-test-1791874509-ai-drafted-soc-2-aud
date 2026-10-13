/**
 * /controls/[id] — criterion detail, two-pane (F1-004).
 *
 * Left pane: the criterion paraphrase + points of focus. Right pane: linked
 * evidence artifacts as chips (source icon, collected_at, confidence meter) with
 * Accept / Reject actions and the model rationale in a collapsible. The brand
 * accent is reserved for Accept. Accept/Reject are Server Actions — no route
 * handler, so no page.tsx/route.ts collision.
 */
import type { JSX } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { buildDb } from "@/lib/db";
import { getSessionUser } from "@/lib/admin-auth";
import {
  SECURITY_TSC_CONTROLS,
  controlLibraryIsSeeded,
  seedControlLibrary,
} from "@/lib/soc2/controls/library";
import {
  acceptLink,
  getControlDetail,
  rejectLink,
  resolveOrgId,
  type ControlDetail,
  type EvidenceLinkRow,
} from "@/lib/soc2/controls/mapper";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SOURCE_ICONS: Readonly<Record<string, string>> = {
  aws: "☁️",
  github: "🐙",
  upload: "📄",
  hris: "👥",
  manual: "✍️",
};

function sourceIcon(source: string): string {
  return SOURCE_ICONS[source.toLowerCase()] ?? "🔗";
}

function formatCollectedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 10)} · ${d.toISOString().slice(11, 16)} UTC`;
}

async function acceptAction(formData: FormData): Promise<void> {
  "use server";
  const linkId = String(formData.get("linkId") ?? "");
  const controlId = String(formData.get("controlId") ?? "");
  if (!linkId || !controlId) return;

  const user = await getSessionUser();
  if (!user) return;
  const db = buildDb();
  const orgId = await resolveOrgId(db, user.id);
  if (!orgId) return;

  await acceptLink(db, orgId, linkId, user.id || null);
  revalidatePath(`/controls/${controlId}`);
  revalidatePath("/controls");
}

async function rejectAction(formData: FormData): Promise<void> {
  "use server";
  const linkId = String(formData.get("linkId") ?? "");
  const controlId = String(formData.get("controlId") ?? "");
  if (!linkId || !controlId) return;

  const user = await getSessionUser();
  if (!user) return;
  const db = buildDb();
  const orgId = await resolveOrgId(db, user.id);
  if (!orgId) return;

  await rejectLink(db, orgId, linkId, user.id || null);
  revalidatePath(`/controls/${controlId}`);
  revalidatePath("/controls");
}

function ConfidenceMeter({ value }: { value: number }): JSX.Element {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  const color =
    value >= 0.7 ? "var(--substrate-success)" : value > 0 ? "var(--substrate-accent)" : "var(--substrate-border)";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem", minWidth: "140px" }}>
      <span
        aria-hidden="true"
        style={{
          display: "inline-block",
          height: "6px",
          flex: 1,
          borderRadius: "999px",
          background: "var(--substrate-surface-2)",
          overflow: "hidden",
          position: "relative",
        }}
      >
        <span
          style={{
            position: "absolute",
            inset: 0,
            width: `${pct}%`,
            background: color,
            borderRadius: "999px",
          }}
        />
      </span>
      <span className="muted" style={{ fontSize: "0.75rem", whiteSpace: "nowrap" }}>
        {pct}% confidence
      </span>
    </span>
  );
}

function EvidenceChip({
  link,
  controlId,
}: {
  link: EvidenceLinkRow;
  controlId: string;
}): JSX.Element {
  const isConfirmed = link.status === "confirmed";
  return (
    <li
      className="card"
      style={{
        listStyle: "none",
        display: "flex",
        flexDirection: "column",
        gap: "0.6rem",
        borderColor: isConfirmed ? "var(--substrate-success)" : undefined,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
        <span aria-hidden="true" style={{ fontSize: "1.1rem" }}>
          {sourceIcon(link.source)}
        </span>
        <strong style={{ flex: 1 }}>{link.artifactTitle}</strong>
        {isConfirmed ? (
          <span
            style={{
              fontSize: "0.75rem",
              fontWeight: 600,
              color: "var(--substrate-success)",
              border: "1px solid var(--substrate-success)",
              borderRadius: "999px",
              padding: "0.1rem 0.5rem",
            }}
          >
            Confirmed
          </span>
        ) : link.needsReview ? (
          <span
            className="muted"
            style={{
              fontSize: "0.75rem",
              border: "1px solid var(--substrate-border)",
              borderRadius: "999px",
              padding: "0.1rem 0.5rem",
            }}
          >
            Needs review
          </span>
        ) : (
          <span
            className="muted"
            style={{
              fontSize: "0.75rem",
              border: "1px solid var(--substrate-border)",
              borderRadius: "999px",
              padding: "0.1rem 0.5rem",
            }}
          >
            Proposed
          </span>
        )}
      </div>

      <div className="muted" style={{ fontSize: "0.8rem" }}>
        {link.source} · {link.artifactType} · collected {formatCollectedAt(link.collectedAt)} ·{" "}
        {link.method === "rule" ? "rule-matched" : `mapped by ${link.modelName ?? "model"}`}
      </div>

      {link.artifactSummary && (
        <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>
          {link.artifactSummary}
        </p>
      )}

      <ConfidenceMeter value={link.confidence} />

      <details>
        <summary style={{ cursor: "pointer", fontSize: "0.85rem" }}>Why this was proposed</summary>
        <p className="muted" style={{ marginTop: "0.5rem", fontSize: "0.85rem" }}>
          {link.rationale || "No rationale recorded."}
        </p>
      </details>

      {!isConfirmed && (
        <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
          <form action={acceptAction}>
            <input type="hidden" name="linkId" value={link.linkId} />
            <input type="hidden" name="controlId" value={controlId} />
            <button
              type="submit"
              style={{
                background: "var(--substrate-accent)",
                color: "var(--substrate-accent-text)",
                border: "none",
                transition: "filter var(--substrate-dur, 150ms) var(--substrate-ease, ease)",
              }}
            >
              Accept
            </button>
          </form>
          <form action={rejectAction}>
            <input type="hidden" name="linkId" value={link.linkId} />
            <input type="hidden" name="controlId" value={controlId} />
            <button type="submit" className="secondary">
              Reject
            </button>
          </form>
        </div>
      )}
    </li>
  );
}

export default async function ControlDetailPage({
  params,
}: {
  params: { id: string };
}): Promise<JSX.Element> {
  const controlId = decodeURIComponent(params.id);

  const user = await getSessionUser();
  if (!user) {
    return (
      <main>
        <p>
          <Link href="/controls">← All controls</Link>
        </p>
        <p className="empty">
          Please <Link href="/login">log in</Link> to view this criterion.
        </p>
      </main>
    );
  }

  const db = buildDb();
  try {
    if (!(await controlLibraryIsSeeded(db))) {
      await seedControlLibrary(db);
    }
  } catch {
    // Non-fatal: detail falls back to the static seed below.
  }

  const orgId = await resolveOrgId(db, user.id);

  let detail: ControlDetail | null = null;
  try {
    if (orgId) {
      detail = await getControlDetail(db, orgId, controlId);
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        component: "soc2.controls.detail",
        control_id: controlId,
        message: error instanceof Error ? error.message : "detail query failed",
      }),
    );
  }

  if (!detail) {
    // Either the user has no org yet, or the control id is unknown. Fall back to
    // the static seed so a valid criterion still renders (with no links).
    const staticControl = SECURITY_TSC_CONTROLS.find((c) => c.controlId === controlId);
    if (!staticControl) notFound();
    detail = { control: staticControl, links: [] };
  }

  const { control, links } = detail;
  const satisfying = control.satisfyingArtifactTypes;

  return (
    <main style={{ maxWidth: "var(--substrate-max-width, 1100px)" }}>
      <p>
        <Link href="/controls">← All controls</Link>
      </p>
      <h1>
        {control.controlId} · {control.title}
      </h1>
      <p>{control.category} — {control.categoryTitle}</p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(260px, 1fr) minmax(0, 1.4fr)",
          gap: "1.5rem",
          alignItems: "start",
        }}
      >
        {/* Left pane — criterion + points of focus */}
        <section className="card">
          <h2 style={{ marginTop: 0 }}>Criterion</h2>
          <p>{control.paraphrase}</p>
          <h3>Points of focus</h3>
          <ul>
            {control.pointsOfFocus.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
          <h3>Evidence that satisfies this</h3>
          <ul>
            {satisfying.map((t) => (
              <li key={t} className="muted">
                {t.replace(/_/g, " ")}
              </li>
            ))}
          </ul>
        </section>

        {/* Right pane — linked evidence */}
        <section>
          <h2 style={{ marginTop: 0 }}>Evidence ({links.length})</h2>
          {!orgId ? (
            <p className="empty">
              Set up your workspace on the <Link href="/org">organization page</Link> to start
              mapping evidence to this control.
            </p>
          ) : links.length === 0 ? (
            <div className="empty">
              <p style={{ marginTop: 0 }}>
                No evidence yet — connect AWS or upload a document that shows this control.
              </p>
              <p className="muted" style={{ marginBottom: 0 }}>
                Artifacts that would satisfy {control.controlId}:{" "}
                {satisfying.map((t) => t.replace(/_/g, " ")).join(", ")}.
              </p>
            </div>
          ) : (
            <ul style={{ display: "flex", flexDirection: "column", gap: "1rem", padding: 0, margin: 0 }}>
              {links.map((link) => (
                <EvidenceChip key={link.linkId} link={link} controlId={control.controlId} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
