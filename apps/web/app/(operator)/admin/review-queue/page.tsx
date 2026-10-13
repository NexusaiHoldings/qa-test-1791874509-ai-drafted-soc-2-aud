import Link from "next/link";
import { redirect } from "next/navigation";
import { getAdminUser } from "@nexus/identity-and-access";
import { getReviewQueueItems } from "@/lib/soc2/review/queue";

function typeIcon(type: string): string {
  if (type === "control_link") return "🔗";
  if (type === "policy_version") return "📄";
  return "⚠️";
}

export default async function ReviewQueuePage(): Promise<JSX.Element> {
  const adminUser = await getAdminUser();
  if (!adminUser) {
    redirect("/");
  }

  const items = await getReviewQueueItems({ limit: 100 });

  return (
    <main>
      <h1>Expert Review Queue</h1>
      <p className="muted">
        Review low-confidence mappings, policy drafts, and critical gap findings before customer delivery.
      </p>

      {items.length === 0 ? (
        <section className="empty">
          <p>🕊️ Queue is clear</p>
          <p className="muted">No expert review items need action right now.</p>
        </section>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 16 }}>
          <section className="card">
            <h2>Items</h2>
            <ul>
              {items.map((item) => (
                <li key={item.id}>
                  <Link href={`/admin/review-queue/${item.id}`}>
                    {typeIcon(item.type)} {item.orgName} — {item.title}
                  </Link>
                  <div className="muted">
                    {item.confidence !== null ? `Confidence ${item.confidence.toFixed(3)} · ` : ""}
                    {item.ageHours}h old
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section className="card">
            <h2>Review Pane</h2>
            <p className="muted">Select an item from the left to review and decide.</p>
          </section>
        </div>
      )}
    </main>
  );
}
