import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { buildDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function verifySignature(body: string, signatureHeader: string | null, secret: string): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Webhook secret missing" }, { status: 500 });
  }

  const rawBody = await req.text();
  const signature = req.headers.get("x-hub-signature-256");
  if (!verifySignature(rawBody, signature, secret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const event = req.headers.get("x-github-event") ?? "unknown";
  const deliveryId = req.headers.get("x-github-delivery");
  const payload = JSON.parse(rawBody) as Record<string, any>;

  const installationId = payload.installation?.id ? String(payload.installation.id) : null;
  const repositoryId = payload.repository?.id ? String(payload.repository.id) : null;
  const action = typeof payload.action === "string" ? payload.action : null;
  const accountLogin = payload.installation?.account?.login ?? payload.sender?.login ?? null;
  const accountType = payload.installation?.account?.type ?? payload.sender?.type ?? null;

  const db = buildDb();

  try {
    let orgId: string | null = null;

    if (installationId) {
      const orgLookup = await db.query<{ org_id: string }>(
        `SELECT org_id
         FROM soc2_connector_installations
         WHERE provider = 'github' AND installation_id = $1
         LIMIT 1`,
        installationId,
      );
      orgId = orgLookup[0]?.org_id ?? null;
    }

    await db.execute(
      `INSERT INTO soc2_connector_webhook_events
       (org_id, provider, event_name, delivery_id, installation_id, repository_id, action, payload, received_at, processed_at)
       VALUES ($1, 'github', $2, $3, $4, $5, $6, $7::jsonb, now(), now())`,
      orgId,
      event,
      deliveryId,
      installationId,
      repositoryId,
      action,
      JSON.stringify(payload),
    );

    if (event === "installation" && installationId) {
      if (action === "deleted") {
        await db.execute(
          `UPDATE soc2_connector_installations
           SET status = 'disconnected',
               disconnected_at = now(),
               updated_at = now()
           WHERE provider = 'github' AND installation_id = $1`,
          installationId,
        );
      } else {
        await db.execute(
          `UPDATE soc2_connector_installations
           SET installation_id = $1,
               account_login = $2,
               account_type = $3,
               status = 'connected',
               connected_at = COALESCE(connected_at, now()),
               last_error = NULL,
               updated_at = now()
           WHERE provider = 'github' AND installation_id = $1`,
          installationId,
          accountLogin,
          accountType,
        );
      }
    }

    if (event === "branch_protection_rule" && orgId && repositoryId) {
      const protectedState = action !== "deleted";
      await db.execute(
        `UPDATE soc2_connector_repositories
         SET branch_protected = $1,
             metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
             updated_at = now()
         WHERE org_id = $3 AND provider = 'github' AND repository_id = $4`,
        protectedState,
        JSON.stringify({
          last_branch_protection_event: {
            action,
            received_at: new Date().toISOString(),
          },
        }),
        orgId,
        repositoryId,
      );

      await db.execute(
        `INSERT INTO soc2_evidence_artifacts
         (org_id, source, artifact_type, title, summary, detail)
         VALUES ($1, 'github', 'github_branch_protection_event', $2, $3, $4::jsonb)`,
        orgId,
        `Branch protection ${action ?? "updated"}: ${payload.repository?.full_name ?? "unknown repo"}`,
        "Webhook-captured branch protection change",
        JSON.stringify(payload),
      );
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown webhook error";
    console.error(
      JSON.stringify({
        level: "error",
        component: "soc2.webhooks.github",
        event,
        delivery_id: deliveryId,
        message,
      }),
    );
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
