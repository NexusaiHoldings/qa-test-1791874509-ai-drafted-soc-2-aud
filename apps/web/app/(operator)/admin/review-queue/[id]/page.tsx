import { redirect } from "next/navigation";
import { getAdminUser } from "@nexus/identity-and-access";
import { db } from "@nexus/db";
import { logAuditEvent } from "@nexus/admin-console";
import { getReviewQueueItemById } from "@/lib/soc2/review/queue";

interface PageProps {
  params: { id: string };
}

export default async function ReviewQueueItemPage({ params }: PageProps): Promise<JSX.Element> {
  const adminUser = await getAdminUser();
  if (!adminUser) {
    redirect("/");
  }

  const item = await getReviewQueueItemById(params.id);
  if (!item) {
    return (
      <main>
        <h1>Review Queue</h1>
        <p className="muted">Item not found.</p>
      </main>
    );
  }

  await db.query("SELECT 1");
  await logAuditEvent({
    action: "soc2.review_queue.view_item",
    actorId: String(adminUser.id),
    targetType: item.type,
    targetId: item.id,
    metadata: { orgId: item.orgId },
  });

  return (
    <main>
      <h1>Review Item</h1>
      <p className="muted">
        {item.orgName} · {item.type} · {item.ageHours}h old
      </p>

      <section className="card">
        <h2>{item.title}</h2>
        <p>{item.subtitle}</p>
        {item.confidence !== null ? <p>Confidence: {item.confidence.toFixed(3)}</p> : null}
        <p className="muted">Rationale</p>
        <p>{item.rationale ?? "No rationale provided."}</p>
      </section>

      <section className="card">
        <h2>Details</h2>
        <pre>{JSON.stringify(item.detail, null, 2)}</pre>
      </section>

      <section className="card">
        <h2>Decision</h2>
        <form method="post" action="/admin/api/review-queue">
          <input type="hidden" name="itemType" value={item.type} />
          <input type="hidden" name="itemId" value={item.id} />
          <label htmlFor="editedRationale">Edited rationale (optional)</label>
          <textarea id="editedRationale" name="editedRationale" />
          <label htmlFor="note">Reviewer note</label>
          <textarea id="note" name="note" required />
          <div style={{ display: "flex", gap: 8 }}>
            <button type="submit" name="decision" value="approved">
              Approve
            </button>
            <button type="submit" name="decision" value="returned" className="secondary">
              Return with note
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}
