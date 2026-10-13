import { redirect } from "next/navigation";
import { getAdminUser } from "@nexus/identity-and-access";
import { logAuditEvent } from "@nexus/admin-console";
import { getReviewItemById, submitReviewDecision } from "@/lib/soc2/review/queue";

interface PageProps {
  params: { id: string };
}

async function decide(formData: FormData): Promise<void> {
  "use server";
  const admin = await getAdminUser();
  if (!admin) redirect("/");

  const id = String(formData.get("id") ?? "");
  const action = String(formData.get("action") ?? "") as "approve" | "return";
  const note = String(formData.get("note") ?? "");
  const editedRationale = String(formData.get("editedRationale") ?? "");

  if (!id || (action !== "approve" && action !== "return")) return;

  await submitReviewDecision(id, {
    reviewerId: admin.id,
    reviewerEmail: admin.email ?? null,
    action,
    note: note || null,
    editedRationale: editedRationale || null,
  });

  redirect("/admin/review-queue");
}

export default async function ReviewQueueDetailPage({ params }: PageProps): Promise<JSX.Element> {
  const admin = await getAdminUser();
  if (!admin) {
    redirect("/");
  }

  const item = await getReviewItemById(params.id);
  if (!item) {
    redirect("/admin/review-queue");
  }

  await logAuditEvent({
    action: "soc2.operator.policy_view",
    actorId: admin.id,
    targetType: item.type,
    targetId: item.id,
    orgId: item.orgId,
    metadata: { route: "/admin/review-queue/[id]" },
  });

  return (
    <main>
      <h1>Review Item</h1>
      <p>{item.orgName} · {item.type}</p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: "1rem" }}>
        <section className="card">
          <h2>Queue context</h2>
          <p><strong>{item.title}</strong></p>
          <p className="muted">{item.subtitle}</p>
          <p className="muted">
            {item.confidence !== null ? `Confidence ${item.confidence.toFixed(3)} · ` : ""}
            {Math.round(item.ageHours)}h old
          </p>
        </section>

        <section className="card">
          <h2>Review pane</h2>
          <pre>{JSON.stringify(item.detail, null, 2)}</pre>

          <form action={decide}>
            <input type="hidden" name="id" value={item.id} />
            <label htmlFor="editedRationale">Edited rationale</label>
            <textarea id="editedRationale" name="editedRationale" rows={6} defaultValue="" />

            <label htmlFor="note">Return note (required if returning)</label>
            <textarea id="note" name="note" rows={4} defaultValue="" />

            <div className="toolbar">
              <button type="submit" name="action" value="approve">Approve</button>
              <button type="submit" name="action" value="return" className="secondary">
                Return with note
              </button>
            </div>
          </form>
        </section>
      </div>
    </main>
  );
}
