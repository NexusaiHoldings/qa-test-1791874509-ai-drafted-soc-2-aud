/**
 * Expert review queue — operator surface (F1-008).
 *
 * Admin-gated list of every item awaiting expert compliance review across all
 * tenants: low-confidence control mappings, policy versions over the NEEDS
 * REVIEW threshold, and held critical gap findings. Non-admins are redirected
 * to / (getAdminUser() returns null for anonymous / non-allow-listed users).
 */

import Link from "next/link";
import { redirect } from "next/navigation";
import { getAdminUser } from "@/lib/admin-auth";
import {
  getReviewQueueItems,
  type ReviewQueueItem,
  type ReviewQueueItemType,
} from "@/lib/soc2/review/queue";

export const dynamic = "force-dynamic";

function typeIcon(type: ReviewQueueItemType): string {
  if (type === "control_link") return "🔗";
  if (type === "policy_version") return "📄";
  return "⚠️";
}

function typeLabel(type: ReviewQueueItemType): string {
  if (type === "control_link") return "Control mapping";
  if (type === "policy_version") return "Policy version";
  return "Critical gap";
}

export default async function ReviewQueuePage(): Promise<JSX.Element> {
  const adminUser = await getAdminUser();
  if (!adminUser) {
    redirect("/");
  }

  const items: ReviewQueueItem[] = await getReviewQueueItems({ limit: 100 });

  return (
    <main>
      <h1>Expert review queue</h1>
      <p>
        Review AI-generated control mappings, policy drafts, and critical gap
        findings before they reach the customer. Every decision is audit-logged.
      </p>

      {items.length === 0 ? (
        <section className="empty">
          <p style={{ fontSize: "2.5rem", margin: 0 }} aria-hidden="true">
            🕊️
          </p>
          <p>Queue is clear</p>
          <p className="muted">
            No mappings, policies, or findings need expert review right now.
          </p>
        </section>
      ) : (
        <>
          <p className="muted">
            {items.length} item{items.length === 1 ? "" : "s"} awaiting review ·
            oldest first
          </p>
          <ul>
            {items.map((item) => (
              <li key={`${item.type}:${item.id}`} className="card">
                <Link href={`/admin/review-queue/${item.id}`}>
                  <strong>
                    <span aria-hidden="true">{typeIcon(item.type)}</span>{" "}
                    {item.title}
                  </strong>
                </Link>
                <div className="muted">
                  {item.orgName} · {typeLabel(item.type)}
                  {item.confidence !== null
                    ? ` · confidence ${item.confidence.toFixed(2)}`
                    : ""}{" "}
                  · {item.ageHours}h old
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
