import { NextRequest, NextResponse } from "next/server";
import { getAdminUser } from "@nexus/identity-and-access";
import {
  getReviewItemById,
  listReviewQueue,
  submitReviewDecision,
} from "@/lib/soc2/review/queue";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const admin = await getAdminUser();
  if (!admin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (id) {
    const item = await getReviewItemById(id);
    if (!item) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ item });
  }

  const queue = await listReviewQueue();
  return NextResponse.json(queue);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const admin = await getAdminUser();
  if (!admin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await request.json()) as {
    id?: string;
    action?: "approve" | "return";
    note?: string;
    editedRationale?: string;
  };

  if (!body.id || !body.action) {
    return NextResponse.json({ error: "id and action are required" }, { status: 400 });
  }

  await submitReviewDecision(body.id, {
    reviewerId: admin.id,
    reviewerEmail: admin.email ?? null,
    action: body.action,
    note: body.note ?? null,
    editedRationale: body.editedRationale ?? null,
  });

  return NextResponse.json({ ok: true });
}
