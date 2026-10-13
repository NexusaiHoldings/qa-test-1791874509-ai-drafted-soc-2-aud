/**
 * /policies/[id] — the split policy editor (F1-005).
 *
 * Left: the drafted markdown at a confident reading width, with NEEDS REVIEW
 * sentences underlined in amber and grounded sentences linked to their evidence.
 * Right: an evidence rail of artifact chips. Hovering a grounded sentence
 * highlights its chip and vice versa (pure-CSS :has() cross-highlight, keyed by a
 * server-generated <style> block — no client JS, CSP-safe).
 *
 * A sticky footer carries the single accent action for the current state
 * (Generate draft / Submit for review / Approve) plus the standing disclaimer.
 * Draft / Submit / Approve are Server Actions (defined in this file), so there is
 * no page.tsx/route.ts collision. Approval is gated to org owners/admins.
 */
import type { CSSProperties, JSX } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { buildDb } from "@/lib/db";
import { getSessionUser } from "@/lib/admin-auth";
import { resolveOrgId } from "@/lib/soc2/controls/mapper";
import { draftPolicy, type ConfirmedArtifact } from "@/lib/soc2/policies/drafter";
import {
  approvePolicy,
  getPolicyDetail,
  isOrgApprover,
  resolvePolicy,
  seedPoliciesForOrg,
  submitForReview,
  type PolicyClaimRow,
  type PolicyDetail,
} from "@/lib/soc2/policies/approval";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DISCLAIMER = "AI-drafted; you remain responsible for accuracy.";

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

/** Sanitize an id for safe use in an HTML attribute / CSS selector. */
function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9-]/g, "");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Minimal, safe markdown → HTML (all content is escaped first). */
function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inList = false;
  const closeList = (): void => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  const inline = (s: string): string =>
    escapeHtml(s)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");

  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = Math.min(heading[1].length + 1, 5); // h1 title is the page <h1>
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inline(line.replace(/^[-*]\s+/, ""))}</li>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      closeList();
      out.push(`<blockquote>${inline(line.replace(/^>\s?/, ""))}</blockquote>`);
      continue;
    }
    if (line.trim() === "") {
      closeList();
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join("\n");
}

/**
 * Wrap each claim sentence found in the rendered HTML in a highlight span. Claim
 * text is escaped the same way the body was, so grounded/model sentences match.
 * Grounded sentences carry data-claim-art (for :has() cross-highlight); unmatched
 * sentences are underlined amber.
 */
function annotateClaims(html: string, claims: readonly PolicyClaimRow[]): string {
  let result = html;
  for (const claim of claims) {
    const needle = escapeHtml(claim.claimText.trim())
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
    if (!needle) continue;
    const idx = result.indexOf(needle);
    if (idx === -1) continue;
    const needsReview = claim.claimType === "needs_review" || !claim.sourceArtifactId;
    const artAttr = claim.sourceArtifactId ? ` data-claim-art="${safeId(claim.sourceArtifactId)}"` : "";
    const cls = needsReview ? "claim needs-review" : "claim grounded";
    const title = needsReview
      ? ' title="NEEDS REVIEW — not grounded in confirmed evidence"'
      : "";
    const span = `<span class="${cls}"${artAttr}${title}>${needle}</span>`;
    result = result.slice(0, idx) + span + result.slice(idx + needle.length);
  }
  return result;
}

/** Build the per-artifact :has() cross-highlight rules + base editor styles. */
function buildHighlightCss(artifacts: readonly ConfirmedArtifact[]): string {
  const base = [
    ".policy-split .claim{border-radius:3px;transition:background 120ms ease;}",
    ".policy-split .needs-review{text-decoration:underline wavy #b26a00;text-underline-offset:3px;cursor:help;}",
    ".policy-split .art-chip{transition:background 120ms ease,border-color 120ms ease;}",
  ];
  const rules = artifacts.map((a) => {
    const id = safeId(a.id);
    const hl = "background:rgba(99,102,241,0.16);";
    return (
      `.policy-split:has([data-claim-art="${id}"]:hover) [data-art-chip="${id}"],` +
      `.policy-split:has([data-art-chip="${id}"]:hover) [data-claim-art="${id}"]{${hl}border-color:var(--substrate-accent);}`
    );
  });
  return [...base, ...rules].join("\n");
}

// ── Server Actions ──────────────────────────────────────────────────────────

async function draftAction(formData: FormData): Promise<void> {
  "use server";
  const policyId = String(formData.get("policyId") ?? "");
  if (!policyId) return;
  const user = await getSessionUser();
  if (!user) return;
  const db = buildDb();
  const orgId = await resolveOrgId(db, user.id);
  if (!orgId) return;

  const resolved = await resolvePolicy(db, orgId, policyId);
  if (!resolved) return;

  try {
    await draftPolicy(db, orgId, policyId, resolved.template, user.id || null);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        component: "soc2.policies.detail.draft",
        org_id: orgId,
        policy_id: policyId,
        message: error instanceof Error ? error.message : "draft failed",
      }),
    );
    redirect(`/policies/${encodeURIComponent(policyId)}?error=draft`);
  }
  revalidatePath(`/policies/${policyId}`);
  revalidatePath("/policies");
}

async function submitAction(formData: FormData): Promise<void> {
  "use server";
  const policyId = String(formData.get("policyId") ?? "");
  const versionId = String(formData.get("versionId") ?? "");
  if (!policyId || !versionId) return;
  const user = await getSessionUser();
  if (!user) return;
  const db = buildDb();
  const orgId = await resolveOrgId(db, user.id);
  if (!orgId) return;

  await submitForReview(db, orgId, versionId, user.id);
  revalidatePath(`/policies/${policyId}`);
  revalidatePath("/policies");
}

async function approveAction(formData: FormData): Promise<void> {
  "use server";
  const policyId = String(formData.get("policyId") ?? "");
  const versionId = String(formData.get("versionId") ?? "");
  if (!policyId || !versionId) return;
  const user = await getSessionUser();
  if (!user) return;
  const db = buildDb();
  const orgId = await resolveOrgId(db, user.id);
  if (!orgId) return;

  const outcome = await approvePolicy(db, orgId, versionId, user.id, user.email ?? null);
  if (!outcome.ok) {
    redirect(`/policies/${encodeURIComponent(policyId)}?error=${outcome.reason ?? "approve"}`);
  }
  revalidatePath(`/policies/${policyId}`);
  revalidatePath("/policies");
}

// ── View ────────────────────────────────────────────────────────────────────

function EvidenceRail({ artifacts }: { artifacts: readonly ConfirmedArtifact[] }): JSX.Element {
  if (artifacts.length === 0) {
    return (
      <div className="empty" style={{ marginTop: 0 }}>
        <p style={{ margin: 0 }}>No confirmed evidence yet for this policy&apos;s criteria.</p>
        <p className="muted" style={{ marginBottom: 0 }}>
          Confirm mappings on <Link href="/controls">Controls</Link> to ground more sentences.
        </p>
      </div>
    );
  }
  return (
    <ul style={{ display: "flex", flexDirection: "column", gap: "0.75rem", padding: 0, margin: 0 }}>
      {artifacts.map((a) => (
        <li
          key={a.id}
          className="card art-chip"
          data-art-chip={safeId(a.id)}
          style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: "0.35rem" }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span aria-hidden="true">{sourceIcon(a.source)}</span>
            <strong style={{ flex: 1, fontSize: "0.9rem" }}>{a.title}</strong>
          </div>
          <span className="muted" style={{ fontSize: "0.72rem" }}>
            {a.source} · {a.artifactType} · {a.controlIds.join(", ")}
          </span>
          {a.summary && (
            <span className="muted" style={{ fontSize: "0.78rem", lineHeight: 1.35 }}>
              {a.summary}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function FooterAction({
  detail,
  canApprove,
}: {
  detail: PolicyDetail;
  canApprove: boolean;
}): JSX.Element {
  const { policyId, version } = detail;
  const status = version?.status ?? "not_started";

  let action: JSX.Element;
  if (!version || status === "not_started") {
    action = (
      <form action={draftAction}>
        <input type="hidden" name="policyId" value={policyId} />
        <button type="submit" style={accentButton}>
          Generate draft
        </button>
      </form>
    );
  } else if (status === "draft") {
    action = (
      <form action={submitAction}>
        <input type="hidden" name="policyId" value={policyId} />
        <input type="hidden" name="versionId" value={version.versionId} />
        <button type="submit" style={accentButton}>
          Submit for review
        </button>
      </form>
    );
  } else if (status === "in_review") {
    action = canApprove ? (
      <form action={approveAction}>
        <input type="hidden" name="policyId" value={policyId} />
        <input type="hidden" name="versionId" value={version.versionId} />
        <button type="submit" style={accentButton}>
          Approve
        </button>
      </form>
    ) : (
      <span className="muted">Awaiting approval by an org owner or admin.</span>
    );
  } else {
    action = (
      <span style={{ color: "var(--substrate-success)", fontWeight: 600 }}>
        ✓ Approved{version.approverEmail ? ` by ${version.approverEmail}` : ""}
      </span>
    );
  }

  return (
    <div
      style={{
        position: "sticky",
        bottom: 0,
        marginTop: "1.5rem",
        padding: "0.9rem 0",
        background: "var(--substrate-bg)",
        borderTop: "1px solid var(--substrate-border)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "1rem",
        flexWrap: "wrap",
      }}
    >
      <span className="muted" style={{ fontSize: "0.8rem" }}>
        {DISCLAIMER}
      </span>
      {action}
    </div>
  );
}

const accentButton: CSSProperties = {
  background: "var(--substrate-accent)",
  color: "var(--substrate-accent-text)",
  border: "none",
};

function errorMessage(code: string | undefined): string | null {
  switch (code) {
    case "draft":
      return "The drafting gateway failed. Nothing was saved — try generating the draft again.";
    case "not_authorized":
      return "Only an org owner or admin can approve a policy.";
    case "not_in_review":
      return "This version is no longer awaiting review. Refresh to see its current status.";
    case "not_found":
      return "That version could not be found.";
    default:
      return code ? "Something went wrong. Please try again." : null;
  }
}

export default async function PolicyDetailPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams?: { error?: string };
}): Promise<JSX.Element> {
  const policyId = decodeURIComponent(params.id);

  const user = await getSessionUser();
  if (!user) {
    return (
      <main>
        <p>
          <Link href="/policies">← All policies</Link>
        </p>
        <p className="empty">
          Please <Link href="/login">log in</Link> to view this policy.
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
          <Link href="/policies">← All policies</Link>
        </p>
        <p className="empty">
          Set up your workspace on the <Link href="/org">organization page</Link> first.
        </p>
      </main>
    );
  }

  let detail: PolicyDetail | null = null;
  try {
    await seedPoliciesForOrg(db, orgId);
    detail = await getPolicyDetail(db, orgId, policyId);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        component: "soc2.policies.detail",
        org_id: orgId,
        policy_id: policyId,
        message: error instanceof Error ? error.message : "detail load failed",
      }),
    );
  }

  if (!detail) notFound();

  const approverCheck = await isOrgApprover(db, orgId, user.id);
  const { template, version, claims, artifacts } = detail;
  const notice = errorMessage(searchParams?.error);
  const needsReviewCount = version?.needsReviewCount ?? claims.filter((c) => c.claimType === "needs_review").length;

  const bodyHtml = version ? annotateClaims(renderMarkdown(version.bodyMarkdown), claims) : "";
  const css = buildHighlightCss(artifacts);

  return (
    <main style={{ maxWidth: "var(--substrate-max-width, 1100px)" }}>
      <style dangerouslySetInnerHTML={{ __html: css }} />
      <p>
        <Link href="/policies">← All policies</Link>
      </p>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
        <h1 style={{ marginBottom: 0 }}>{template.title}</h1>
        {needsReviewCount > 0 && (
          <span style={{ color: "#b26a00", fontWeight: 600, fontSize: "0.9rem" }}>
            {needsReviewCount} sentence{needsReviewCount === 1 ? "" : "s"} need review
          </span>
        )}
      </div>
      <p>
        {template.summary} · Criteria: {template.coveredControlIds.join(", ")}
      </p>

      {notice && (
        <div
          className="card"
          role="alert"
          style={{ borderColor: "var(--substrate-danger)", display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}
        >
          <span>{notice}</span>
          <Link href={`/policies/${encodeURIComponent(policyId)}`} className="btn secondary">
            Retry
          </Link>
        </div>
      )}

      {!version ? (
        <div className="empty">
          <p style={{ marginTop: 0 }}>
            No draft yet. Generate one from your confirmed evidence — every factual sentence will be
            grounded to an artifact, and anything ungrounded is flagged for review.
          </p>
          <p className="muted">
            {artifacts.length} confirmed artifact{artifacts.length === 1 ? "" : "s"} available for grounding.
          </p>
        </div>
      ) : (
        <div
          className="policy-split"
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1.7fr) minmax(260px, 1fr)",
            gap: "1.5rem",
            alignItems: "start",
          }}
        >
          <article
            style={{ fontSize: "1.02rem", lineHeight: 1.7, maxWidth: "68ch" }}
            dangerouslySetInnerHTML={{ __html: bodyHtml }}
          />
          <aside>
            <h2 style={{ marginTop: 0, fontSize: "1rem" }}>Evidence ({artifacts.length})</h2>
            <EvidenceRail artifacts={artifacts} />
          </aside>
        </div>
      )}

      <FooterAction detail={detail} canApprove={approverCheck.isApprover} />
    </main>
  );
}
