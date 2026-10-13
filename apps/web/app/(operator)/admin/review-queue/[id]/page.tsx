/**
 * Expert review pane — single item (F1-008).
 *
 * The right-hand review surface: renders the policy excerpt OR the
 * artifact-vs-criterion pair with the model rationale, plus the decision bar
 * (Approve / Return with note). Only Approve carries the accent (default
 * button); Return is secondary. Opening the pane logs an operator view against
 * the tenant item (read-side audit trail). Admin-gated; non-admins redirect to /.
 */

import Link from "next/link";
import { redirect } from "next/navigation";
import { getAdminUser } from "@/lib/admin-auth";
import {
  getReviewQueueItemById,
  logReviewQueueView,
  type ReviewQueueItem,
} from "@/lib/soc2/review/queue";

export const dynamic = "force-dynamic";

interface PageProps {
  params: { id: string };
}

function detailString(detail: Record<string, unknown>, key: string): string | null {
  const value = detail[key];
  if (value === null || value === undefined) return null;
  return String(value);
}

function detailList(detail: Record<string, unknown>, key: string): string[] {
  const value = detail[key];
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry));
}

function ControlLinkPane({ item }: { item: ReviewQueueItem }): JSX.Element {
  const { detail } = item;
  return (
    <section className="card">
      <h2>Artifact ↔ criterion</h2>
      <table>
        <tbody>
          <tr>
            <th scope="row">Criterion</th>
            <td>{detailString(detail, "control_id") ?? "—"}</td>
          </tr>
          <tr>
            <th scope="row">Artifact</th>
            <td>{detailString(detail, "artifact_title") ?? "—"}</td>
          </tr>
          <tr>
            <th scope="row">Artifact type</th>
            <td>{detailString(detail, "artifact_type") ?? "—"}</td>
          </tr>
          <tr>
            <th scope="row">Mapping method</th>
            <td>{detailString(detail, "mapping_method") ?? "—"}</td>
          </tr>
          <tr>
            <th scope="row">Confidence</th>
            <td>{item.confidence !== null ? item.confidence.toFixed(3) : "—"}</td>
          </tr>
        </tbody>
      </table>
      {detailString(detail, "artifact_summary") ? (
        <>
          <p className="muted">Artifact summary</p>
          <p>{detailString(detail, "artifact_summary")}</p>
        </>
      ) : null}
    </section>
  );
}

function PolicyPane({ item }: { item: ReviewQueueItem }): JSX.Element {
  const body = detailString(item.detail, "body_markdown") ?? "";
  const excerpt = body.length > 2000 ? `${body.slice(0, 2000)}…` : body;
  return (
    <section className="card">
      <h2>Policy excerpt</h2>
      <p className="muted">
        Status {detailString(item.detail, "status") ?? "—"} · needs-review claims{" "}
        {detailString(item.detail, "needs_review_count") ?? "0"}
      </p>
      <pre style={{ whiteSpace: "pre-wrap" }}>{excerpt || "No policy body."}</pre>
    </section>
  );
}

function GapPane({ item }: { item: ReviewQueueItem }): JSX.Element {
  const missing = detailList(item.detail, "missing_evidence");
  const steps = detailList(item.detail, "remediation_steps");
  return (
    <section className="card">
      <h2>Critical gap finding</h2>
      <table>
        <tbody>
          <tr>
            <th scope="row">Criterion</th>
            <td>{detailString(item.detail, "control_id") ?? "—"}</td>
          </tr>
          <tr>
            <th scope="row">Severity</th>
            <td>{detailString(item.detail, "severity") ?? "—"}</td>
          </tr>
          <tr>
            <th scope="row">Report week</th>
            <td>{detailString(item.detail, "report_week") ?? "—"}</td>
          </tr>
        </tbody>
      </table>
      {missing.length > 0 ? (
        <>
          <p className="muted">Missing evidence</p>
          <ul>
            {missing.map((m, idx) => (
              <li key={idx}>{m}</li>
            ))}
          </ul>
        </>
      ) : null}
      {steps.length > 0 ? (
        <>
          <p className="muted">Remediation steps</p>
          <ul>
            {steps.map((s, idx) => (
              <li key={idx}>{s}</li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

export default async function ReviewQueueItemPage({
  params,
}: PageProps): Promise<JSX.Element> {
  const adminUser = await getAdminUser();
  if (!adminUser) {
    redirect("/");
  }

  const item = await getReviewQueueItemById(params.id);
  if (!item) {
    return (
      <main>
        <h1>Review item</h1>
        <p className="muted">
          This item is no longer in the queue — it may already have been reviewed.
        </p>
        <p>
          <Link className="btn secondary" href="/admin/review-queue">
            Back to queue
          </Link>
        </p>
      </main>
    );
  }

  // Read-side audit: operator views of tenant items are logged.
  await logReviewQueueView(adminUser.id, item);

  return (
    <main>
      <h1>{item.title}</h1>
      <p>
        {item.orgName} · {item.ageHours}h old
      </p>
      <p>
        <Link className="btn secondary" href="/admin/review-queue">
          ← Back to queue
        </Link>
      </p>

      {item.type === "control_link" ? <ControlLinkPane item={item} /> : null}
      {item.type === "policy_version" ? <PolicyPane item={item} /> : null}
      {item.type === "critical_gap" ? <GapPane item={item} /> : null}

      <section className="card">
        <h2>Model rationale</h2>
        <p>{item.rationale ?? "No model rationale recorded."}</p>
      </section>

      <section className="card">
        <h2>Decision</h2>
        <form method="post" action="/admin/api/review-queue">
          <input type="hidden" name="itemType" value={item.type} />
          <input type="hidden" name="itemId" value={item.id} />
          <input type="hidden" name="redirectTo" value="/admin/review-queue" />

          <label htmlFor="editedRationale">Edited rationale (optional)</label>
          <textarea
            id="editedRationale"
            name="editedRationale"
            rows={4}
            defaultValue={item.rationale ?? ""}
          />

          <label htmlFor="note">Reviewer note</label>
          <textarea
            id="note"
            name="note"
            rows={3}
            placeholder="Required when returning; recommended on approve."
          />

          <div className="toolbar">
            <button type="submit" name="decision" value="approved">
              Approve
            </button>
            <button
              type="submit"
              name="decision"
              value="returned"
              className="secondary"
            >
              Return with note
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}
