import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";
import { randomUUID } from "node:crypto";

type Args = {
  orgId: string;
  policyId: string;
  title: string;
  bodyMarkdown: string;
  rationale?: string;
  claims: Array<{
    claimType: string;
    claimText: string;
    sourceArtifactId?: string | null;
    sourceExcerpt?: string | null;
  }>;
  modelName?: string;
};

type DbLike = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows?: Record<string, unknown>[] }>;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toArgs(input: unknown): Args {
  if (!isObject(input)) {
    throw new Error("Invalid args: expected object");
  }

  const {
    orgId,
    policyId,
    title,
    bodyMarkdown,
    rationale,
    claims,
    modelName,
  } = input as Record<string, unknown>;

  if (typeof orgId !== "string" || orgId.length === 0) {
    throw new Error("Invalid args.orgId");
  }
  if (typeof policyId !== "string" || policyId.length === 0) {
    throw new Error("Invalid args.policyId");
  }
  if (typeof title !== "string" || title.length === 0) {
    throw new Error("Invalid args.title");
  }
  if (typeof bodyMarkdown !== "string" || bodyMarkdown.length === 0) {
    throw new Error("Invalid args.bodyMarkdown");
  }
  if (!Array.isArray(claims)) {
    throw new Error("Invalid args.claims");
  }

  const normalizedClaims = claims.map((claim, idx) => {
    if (!isObject(claim)) {
      throw new Error(`Invalid args.claims[${idx}]`);
    }
    const claimType = claim.claimType;
    const claimText = claim.claimText;
    const sourceArtifactId = claim.sourceArtifactId;
    const sourceExcerpt = claim.sourceExcerpt;

    if (typeof claimType !== "string" || claimType.length === 0) {
      throw new Error(`Invalid args.claims[${idx}].claimType`);
    }
    if (typeof claimText !== "string" || claimText.length === 0) {
      throw new Error(`Invalid args.claims[${idx}].claimText`);
    }
    if (sourceArtifactId != null && typeof sourceArtifactId !== "string") {
      throw new Error(`Invalid args.claims[${idx}].sourceArtifactId`);
    }
    if (sourceExcerpt != null && typeof sourceExcerpt !== "string") {
      throw new Error(`Invalid args.claims[${idx}].sourceExcerpt`);
    }

    return {
      claimType,
      claimText,
      sourceArtifactId: sourceArtifactId ?? null,
      sourceExcerpt: sourceExcerpt ?? null,
    };
  });

  return {
    orgId,
    policyId,
    title,
    bodyMarkdown,
    rationale: typeof rationale === "string" ? rationale : undefined,
    claims: normalizedClaims,
    modelName: typeof modelName === "string" ? modelName : undefined,
  };
}

async function getDbFromContext(ctx: HandlerContext): Promise<DbLike> {
  const maybeDb = (ctx as unknown as { db?: DbLike }).db;
  if (!maybeDb || typeof maybeDb.query !== "function") {
    throw new Error("Database handle is missing from handler context");
  }
  return maybeDb;
}

export async function handlePersistPolicyDraft(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  try {
    const parsed = toArgs(args);
    const db = await getDbFromContext(ctx);

    const versionId = randomUUID();
    const insertedBy =
      (ctx as unknown as { actorId?: string; userId?: string }).actorId ??
      (ctx as unknown as { actorId?: string; userId?: string }).userId ??
      null;

    await db.query("BEGIN");

    await db.query(
      `
        INSERT INTO soc2_policy_versions (
          id,
          org_id,
          policy_id,
          title,
          body_markdown,
          rationale,
          status,
          drafted_by,
          drafted_with_model,
          created_at,
          updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,'in_review',$7,$8,NOW(),NOW())
      `,
      [
        versionId,
        parsed.orgId,
        parsed.policyId,
        parsed.title,
        parsed.bodyMarkdown,
        parsed.rationale ?? null,
        insertedBy,
        parsed.modelName ?? null,
      ],
    );

    for (const claim of parsed.claims) {
      await db.query(
        `
          INSERT INTO soc2_policy_claims (
            id,
            org_id,
            policy_version_id,
            claim_type,
            claim_text,
            source_artifact_id,
            source_excerpt,
            created_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
        `,
        [
          randomUUID(),
          parsed.orgId,
          versionId,
          claim.claimType,
          claim.claimText,
          claim.sourceArtifactId,
          claim.sourceExcerpt,
        ],
      );
    }

    await db.query("COMMIT");

    return {
      ok: true,
      data: {
        versionId,
        policyId: parsed.policyId,
        status: "in_review",
        claimsPersisted: parsed.claims.length,
      },
    } as HandlerResult;
  } catch (error) {
    const dbMaybe = (ctx as unknown as { db?: DbLike }).db;
    if (dbMaybe && typeof dbMaybe.query === "function") {
      try {
        await dbMaybe.query("ROLLBACK");
      } catch {
        // no-op: preserve original error
      }
    }

    return {
      ok: false,
      error: {
        code: "persist_policy_draft_failed",
        message: error instanceof Error ? error.message : "Unknown error",
      },
    } as HandlerResult;
  }
}
