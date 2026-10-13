/**
 * Expert review queue API (F1-008).
 *
 * GET  — list the queue as JSON (admin dashboards / polling).
 * POST — apply a decision (Approve / Return with note). Accepts either a JSON
 *        body (fetch clients) or a classic form POST from the review pane, in
 *        which case it 303-redirects back to the queue.
 *
 * getAdminUser() is called FIRST and returns 403 before any body parse or DB
 * read for non-admins.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminUser } from "@/lib/admin-auth";
import {
  getReviewQueueItems,
  submitReviewDecision,
  isReviewQueueItemType,
  type ReviewDecision,
  type ReviewQueueItemType,
} from "@/lib/soc2/review/queue";

export const dynamic = "force-dynamic";

interface DecisionFields {
  itemType: ReviewQueueItemType | null;
  itemId: string | null;
  decision: ReviewDecision | null;
  note: string | null;
  editedRationale: string | null;
  redirectTo: string | null;
}

function coerceDecision(value: unknown): ReviewDecision | null {
  return value === "approved" || value === "returned" ? value : null;
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Only allow same-origin relative redirect targets (no open-redirect). */
function safeRedirect(value: string | null): string {
  if (value && value.startsWith("/") && !value.startsWith("//")) return value;
  return "/admin/review-queue";
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const adminUser = await getAdminUser();
  if (!adminUser) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const limit = Number(searchParams.get("limit") ?? "50");
  const offset = Number(searchParams.get("offset") ?? "0");
  const threshold = Number(searchParams.get("needsReviewThreshold") ?? "1");

  const items = await getReviewQueueItems({
    limit: Number.isFinite(limit) ? limit : 50,
    offset: Number.isFinite(offset) ? offset : 0,
    needsReviewThreshold: Number.isFinite(threshold) ? threshold : 1,
  });

  return NextResponse.json({ items, count: items.length });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const adminUser = await getAdminUser();
  if (!adminUser) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const contentType = request.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");

  let fields: DecisionFields;
  try {
    if (isJson) {
      const body = (await request.json()) as Record<string, unknown>;
      fields = {
        itemType: isReviewQueueItemType(body.itemType) ? body.itemType : null,
        itemId: nonEmpty(body.itemId),
        decision: coerceDecision(body.decision),
        note: nonEmpty(body.note),
        editedRationale: nonEmpty(body.editedRationale),
        redirectTo: nonEmpty(body.redirectTo),
      };
    } else {
      const form = await request.formData();
      const itemType = form.get("itemType");
      fields = {
        itemType: isReviewQueueItemType(itemType) ? itemType : null,
        itemId: nonEmpty(form.get("itemId")),
        decision: coerceDecision(form.get("decision")),
        note: nonEmpty(form.get("note")),
        editedRationale: nonEmpty(form.get("editedRationale")),
        redirectTo: nonEmpty(form.get("redirectTo")),
      };
    }
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  if (!fields.itemType || !fields.itemId || !fields.decision) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // A return must carry a note (the whole point is actionable feedback).
  if (fields.decision === "returned" && !fields.note) {
    return NextResponse.json(
      { error: "note_required_on_return" },
      { status: 400 },
    );
  }

  const result = await submitReviewDecision({
    itemType: fields.itemType,
    itemId: fields.itemId,
    decision: fields.decision,
    note: fields.note,
    editedRationale: fields.editedRationale,
    reviewerId: adminUser.id,
    reviewerEmail: adminUser.email ?? null,
  });

  if (!result.ok) {
    const status = result.reason === "not_found" ? 404 : 400;
    return NextResponse.json({ error: result.reason ?? "failed" }, { status });
  }

  if (isJson) {
    return NextResponse.json({ ok: true, orgId: result.orgId });
  }

  return NextResponse.redirect(
    new URL(safeRedirect(fields.redirectTo), request.url),
    303,
  );
}
