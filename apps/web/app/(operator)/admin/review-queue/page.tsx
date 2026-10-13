import Link from "next/link";
import { redirect } from "next/navigation";
import { getAdminUser } from "@nexus/identity-and-access";
import { listReviewQueue } from "@/lib/soc2/review/queue";

function iconForType(type: string): string {
  if (type === "control_link") return "🔗";
  if (type === "policy_version") return "📄";
  return "⚠️";
}

export default async function ReviewQueuePage(): Promise<JSX.Element> {
  const admin = await getAdminUser();
  if (!admin) {
    redirect("/");
  }

  const { items } = await listReviewQueue();

  return (
    <main>
      <h1>Expert Review Queue</h1>
      <p>Review low-confidence mappings, policy drafts, and unreleased critical findings.</p>

      {items.length === 0 ? (
        <section className="empty">
          <p><strong>Queue is clear</strong></p>
          <p className="muted">🌿 No items need expert action right now.</p>
        </section>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: "1rem" }}>
          <section className="card">
            <h2>Items</h2>
            <ul>
              {items.map((item) => (
                <li key={item.id}>
                  <Link href={`/admin/review-queue/${item.id}`}>
                    {iconForType(item.type)} {item.orgName} — {item.title}
                  </Link>
                  <div className="muted">
                    {item.confidence !== null ? `confidence ${item.confidence.toFixed(3)} · ` : ""}
                    {Math.round(item.ageHours)}h old
                  </div>
                </li>
              ))}
            </ul>
          </section>
          <section className="card">
            <h2>Review pane</h2>
            <p className="muted">Select an item from the left to open details and submit a decision.</p>
            <p>Loading preview unavailable on list page.</p>
          </section>
        </div>
      )}
    </main>
  );
}
