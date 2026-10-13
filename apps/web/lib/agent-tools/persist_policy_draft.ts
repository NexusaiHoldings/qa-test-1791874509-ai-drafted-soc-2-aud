/**
 * Company-local agent tool handler: `persist_policy_draft`.
 *
 * Confirm-gated mutation (autonomy = confirm). The LLM drafts a SOC 2 policy
 * version + its grounded claims; after the draft passes zod validation AND the
 * customer confirms, the approved-actions bridge routes the tool call here to
 * persist it. Writes one `soc2_policy_versions` row (status `in_review`) and a
 * `soc2_policy_claims` row per claim, atomically in a single statement.
 *
 * Signature matches the lego handler shape consumed by DOMAIN_DISPATCH:
 *   (ctx: HandlerContext, args: Args) => Promise<HandlerResult>
 */

import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";
import { randomUUID } from "node:crypto";

interface ClaimInput {
  readonly claimType: string;
  readonly claimText: string;
  readonly sourceArtifactId: string | null;
  readonly sourceExcerpt: string | null;
}

export interface Args {
  readonly orgId: string;
  readonly policyId: string;
  readonly title: string;
  readonly bodyMarkdown: string;
  readonly rationale?: string | null;
  readonly draftedBy?: string | null;
  readonly modelName?: string | null;
  readonly claims: ClaimInput[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid args.${field}: expected a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | null {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw new Error(`Invalid args.${field}: expected a string or null`);
  }
  return value;
}

function parseArgs(input: unknown): Args {
  if (!isObject(input)) {
    throw new Error("Invalid args: expected an object");
  }

  const orgId = requireNonEmptyString(input.orgId, "orgId");
  const policyId = requireNonEmptyString(input.policyId, "policyId");
  const title = requireNonEmptyString(input.title, "title");
  const bodyMarkdown = requireNonEmptyString(input.bodyMarkdown, "bodyMarkdown");

  if (!Array.isArray(input.claims)) {
    throw new Error("Invalid args.claims: expected an array");
  }

  const claims: ClaimInput[] = input.claims.map((raw, idx) => {
    if (!isObject(raw)) {
      throw new Error(`Invalid args.claims[${idx}]: expected an object`);
    }
    return {
      claimType: requireNonEmptyString(raw.claimType, `claims[${idx}].claimType`),
      claimText: requireNonEmptyString(raw.claimText, `claims[${idx}].claimText`),
      sourceArtifactId: optionalString(
        raw.sourceArtifactId,
        `claims[${idx}].sourceArtifactId`,
      ),
      sourceExcerpt: optionalString(
        raw.sourceExcerpt,
        `claims[${idx}].sourceExcerpt`,
      ),
    };
  });

  return {
    orgId,
    policyId,
    title,
    bodyMarkdown,
    rationale: optionalString(input.rationale, "rationale"),
    draftedBy: optionalString(input.draftedBy, "draftedBy"),
    modelName: optionalString(input.modelName, "modelName"),
    claims,
  };
}

const INSERT_SQL = `
  WITH new_version AS (
    INSERT INTO soc2_policy_versions (
      id, org_id, policy_id, title, body_markdown, rationale,
      status, drafted_by, drafted_with_model, created_at, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, 'in_review', $7, $8, NOW(), NOW())
    RETURNING id
  ),
  inserted_claims AS (
    INSERT INTO soc2_policy_claims (
      id, org_id, policy_version_id, claim_type, claim_text,
      source_artifact_id, source_excerpt, created_at
    )
    SELECT
      c.id, $2, (SELECT id FROM new_version),
      c.claim_type, c.claim_text, c.source_artifact_id, c.source_excerpt, NOW()
    FROM unnest(
      $9::uuid[], $10::text[], $11::text[], $12::uuid[], $13::text[]
    ) AS c(id, claim_type, claim_text, source_artifact_id, source_excerpt)
    RETURNING id
  )
  SELECT
    (SELECT id FROM new_version) AS version_id,
    (SELECT count(*)::int FROM inserted_claims) AS claims_persisted
`;

/**
 * Persist a confirmed, zod-validated policy draft.
 *
 * @throws never — all failures are returned as a structured HandlerResult.
 */
export async function handlePersistPolicyDraft(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  let parsed: Args;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    return {
      status: 400,
      body:
        error instanceof Error ? error.message : "Invalid persist_policy_draft args",
    };
  }

  const versionId = randomUUID();
  const claimIds = parsed.claims.map(() => randomUUID());
  const claimTypes = parsed.claims.map((c) => c.claimType);
  const claimTexts = parsed.claims.map((c) => c.claimText);
  const claimArtifactIds = parsed.claims.map((c) => c.sourceArtifactId);
  const claimExcerpts = parsed.claims.map((c) => c.sourceExcerpt);

  try {
    const rows = await ctx.db.query<{
      version_id: string;
      claims_persisted: number;
    }>(
      INSERT_SQL,
      versionId,
      parsed.orgId,
      parsed.policyId,
      parsed.title,
      parsed.bodyMarkdown,
      parsed.rationale,
      parsed.draftedBy,
      parsed.modelName,
      claimIds,
      claimTypes,
      claimTexts,
      claimArtifactIds,
      claimExcerpts,
    );

    const result = rows[0];
    return {
      status: 200,
      body: {
        ok: true,
        versionId: result?.version_id ?? versionId,
        policyId: parsed.policyId,
        status: "in_review",
        claimsPersisted: result?.claims_persisted ?? parsed.claims.length,
      },
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown persistence error";
    console.error(
      JSON.stringify({
        level: "error",
        tool: "persist_policy_draft",
        org_id: parsed.orgId,
        policy_id: parsed.policyId,
        message,
      }),
    );
    return {
      status: 500,
      body: `persist_policy_draft failed: ${message}`,
    };
  }
}
