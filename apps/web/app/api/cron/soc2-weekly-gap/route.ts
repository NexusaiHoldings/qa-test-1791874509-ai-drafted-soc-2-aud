/**
 * /api/cron/soc2-weekly-gap — the weekly gap-analysis cron (F1-006).
 *
 * Runs Monday 06:00 UTC (Vercel cron) and is also runnable on demand. For every
 * tenant that has at least one synced evidence artifact it:
 *   1. scores all Security TSC criteria + writes the soc2_gap_reports row,
 *      findings and remediation tasks (lib/soc2/gaps/scorer.ts);
 *   2. for a CLEAN report (no critical findings) it auto-releases and sends the
 *      @nexus/notifications email + in-app digest immediately;
 *   3. for a report with ≥1 CRITICAL finding it leaves released_at = NULL — the
 *      digest is held until an operator clears it in the /gaps review queue
 *      (liability human_in_loop_required_for[1]).
 *
 * Auth: when CRON_SECRET is set, Vercel sends `Authorization: Bearer <secret>`;
 * we validate it. Unset (local/dev) runs unguarded. POST is accepted for manual
 * triggering with the same guard.
 */

import { NextResponse } from "next/server";
import { buildDb } from "@/lib/db";
import { generateGapReport } from "@/lib/soc2/gaps/scorer";
import { sendGapDigest } from "@/lib/soc2/gaps/remediation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs"; // pg + raw SQL — not edge-compatible
export const maxDuration = 300;

interface OrgRow {
  org_id: string;
}

interface OrgOutcome {
  orgId: string;
  reportId?: string;
  reportWeek?: string;
  overallReadiness?: number;
  findings?: number;
  critical?: number;
  released?: boolean;
  digestRecipients?: number;
  error?: string;
}

function cronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // unguarded in dev; prod sets CRON_SECRET
  const header = request.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

/** Every org that has at least one evidence artifact (reports only make sense then). */
async function orgsWithEvidence(
  db: ReturnType<typeof buildDb>,
): Promise<string[]> {
  const rows = await db.query<OrgRow>(
    `SELECT DISTINCT org_id FROM soc2_evidence_artifacts ORDER BY org_id`,
  );
  return rows.map((r) => r.org_id).filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** Run the weekly report for a single org, releasing + sending if clean. */
async function runForOrg(
  db: ReturnType<typeof buildDb>,
  orgId: string,
): Promise<OrgOutcome> {
  try {
    const report = await generateGapReport(db, orgId, { generatedBy: "cron" });
    const outcome: OrgOutcome = {
      orgId,
      reportId: report.reportId,
      reportWeek: report.reportWeek,
      overallReadiness: report.overallReadiness,
      findings: report.findingsCount,
      critical: report.criticalCount,
      released: report.released,
    };

    // A clean report auto-releases on generation — send its digest now. A report
    // with critical findings stays held for the operator review queue.
    if (report.released) {
      outcome.digestRecipients = await sendGapDigest(db, orgId, report.reportId);
    }
    return outcome;
  } catch (error) {
    const message = error instanceof Error ? error.message : "report generation failed";
    console.error(
      JSON.stringify({
        level: "error",
        component: "soc2.cron.weekly-gap",
        org_id: orgId,
        message,
      }),
    );
    return { orgId, error: message.slice(0, 300) };
  }
}

async function run(request: Request): Promise<NextResponse> {
  if (!cronAuthorized(request)) {
    return new NextResponse("forbidden", { status: 403 });
  }

  const db = buildDb();
  let orgIds: string[];
  try {
    orgIds = await orgsWithEvidence(db);
  } catch (error) {
    const message = error instanceof Error ? error.message : "org enumeration failed";
    console.error(
      JSON.stringify({ level: "error", component: "soc2.cron.weekly-gap", message }),
    );
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const results: OrgOutcome[] = [];
  for (const orgId of orgIds) {
    results.push(await runForOrg(db, orgId));
  }

  const released = results.filter((r) => r.released).length;
  const held = results.filter((r) => r.released === false).length;
  console.info(
    JSON.stringify({
      level: "info",
      component: "soc2.cron.weekly-gap",
      message: "weekly gap run complete",
      orgs: orgIds.length,
      released,
      held,
    }),
  );

  return NextResponse.json({
    processed: results.length,
    released,
    held,
    results,
  });
}

export async function GET(request: Request): Promise<NextResponse> {
  return run(request);
}

export async function POST(request: Request): Promise<NextResponse> {
  return run(request);
}
