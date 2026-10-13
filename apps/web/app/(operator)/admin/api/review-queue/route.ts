import { NextRequest, NextResponse } from "next/server";
import { getAdminUser } from "@nexus/identity-and-access";
import {
  getReviewQueueItems,
  submitReviewDecision,
  type ReviewQueueItemType,
} from "@/lib/soc2/review/queue";

interface DecisionRequestBody {
  itemType: ReviewQueueItemType;
  itemId: string;
  decision: "approved" | "returned";
  note?: string;
  editedRationale?: string;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const adminUser = await getAdminUser();
  if (!adminUser) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const limit = Number(searchParams.get("limit") ?? "50");
  const offset = Number(searchParams.get("offset") ?? "0");
  const threshold = Number(searchParams.get("needsReviewThreshold") ?? "3");

  const items = await getReviewQueueItems({
    limit: Number.isNaN(limit) ? 50 : limit,
    offset: Number.isNaN(offset) ? 0 : offset,
    needsReviewThreshold: Number.isNaN(threshold) ? 3 : threshold,
  });

  return NextResponse.json({ items });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const adminUser = await getAdminUser();
  if (!adminUser) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await request.json()) as DecisionRequestBody;

  if (!body.itemType || !body.itemId || !body.decision) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  await submitReviewDecision({
    itemType: body.itemType,
    itemId: body.itemId,
    decision: body.decision,
    note: body.note,
    editedRationale: body.editedRationale,
    reviewerId: String(adminUser.id),
    reviewerEmail: adminUser.email ?? null,
  });

  return NextResponse.json({ ok: true });
}
