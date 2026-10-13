import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type ClaimInput = {
  claim_id: string;
  claim_text: string;
  rationale?: string | null;
  source_artifact_ids?: string[] | null;
};

type Args = {
  policy_id: string;
  version_notes?: string | null;
  draft_text: string;
  claims: ClaimInput[];
};

type DbClient = {
  query: (
    text: string,
    params?: ReadonlyArray<unknown>
  ) => Promise<{ rows: Record<string, unknown>[] }>;
};

type HandlerContextWithDb = HandlerContext & {
  db?: DbClient;
};

function asNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`invalid_${fieldName}`);
  }
  return value.trim();
}

function asOptionalString(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error("invalid_optional_string");
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseClaims(value: unknown): ClaimInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("invalid_claims");
  }

  return value.map((item, index) => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`invalid_claims_item_${index}`);
    }
    const rec = item as Record<string, unknown>;
    const claimId = asNonEmptyString(rec.claim_id, "claim_id");
    const claimText = asNonEmptyString(rec.claim_text, "claim_text");
    const rationale = asOptionalString(rec.rationale);

    const sourceArtifactIdsRaw = rec.source_artifact_ids;
    let sourceArtifactIds: string[] | null = null;
    if (sourceArtifactIdsRaw !== undefined && sourceArtifactIdsRaw !== null) {
      if (!Array.isArray(sourceArtifactIdsRaw)) {
        throw new Error(`invalid_source_artifact_ids_${index}`);
      }
      sourceArtifactIds = sourceArtifactIdsRaw.map((v, sourceIndex) =>
        asNonEmptyString(v, `source_artifact_ids_${index}_${sourceIndex}`)
      );
    }

    return {
      claim_id: claimId,
      claim_text: claimText,
      rationale,
      source_artifact_ids: sourceArtifactIds,
    };
  });
}

function toErrorResult(code: string, message: string): HandlerResult {
  return {
    ok: false,
    error: {
      code,
      message,
    },
  } as unknown as HandlerResult;
}

function toOkResult(payload: Record<string, unknown>): HandlerResult {
  return {
    ok: true,
    data: payload,
  } as unknown as HandlerResult;
}

export async function handlePersistPolicyDraft(
  ctx: HandlerContext,
  args: Args
): Promise<HandlerResult> {
  try {
    const db = (ctx as HandlerContextWithDb).db;
    if (!db) {
      return toErrorResult("db_unavailable", "Database client not available in handler context.");
    }

    const policyId = asNonEmptyString(args.policy_id, "policy_id");
    const draftText = asNonEmptyString(args.draft_text, "draft_text");
    const versionNotes = asOptionalString(args.version_notes);
    const claims = parseClaims(args.claims);

    const actorId =
      (ctx as Record<string, unknown>).actorId ??
      (ctx as Record<string, unknown>).userId ??
      null;

    await db.query("BEGIN");

    const currentVersionRes = await db.query(
      "SELECT COALESCE(MAX(version_number), 0) AS max_version FROM soc2_policy_versions WHERE policy_id = $1",
      [policyId]
    );
    const currentVersionRaw = currentVersionRes.rows[0]?.max_version;
    const currentVersion =
      typeof currentVersionRaw === "number"
        ? currentVersionRaw
        : Number.parseInt(String(currentVersionRaw ?? "0"), 10);
    const nextVersion = Number.isFinite(currentVersion) ? currentVersion + 1 : 1;

    const versionInsertRes = await db.query(
      "INSERT INTO soc2_policy_versions (policy_id, version_number, draft_text, version_notes, status, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
      [policyId, nextVersion, draftText, versionNotes, "in_review", actorId]
    );

    const policyVersionId = String(versionInsertRes.rows[0]?.id ?? "");
    if (!policyVersionId) {
      throw new Error("version_insert_failed");
    }

    for (const claim of claims) {
      await db.query(
        "INSERT INTO soc2_policy_claims (policy_version_id, claim_id, claim_text, rationale, source_artifact_ids) VALUES ($1, $2, $3, $4, $5)",
        [
          policyVersionId,
          claim.claim_id,
          claim.claim_text,
          claim.rationale ?? null,
          JSON.stringify(claim.source_artifact_ids ?? []),
        ]
      );
    }

    await db.query("COMMIT");

    return toOkResult({
      policy_version_id: policyVersionId,
      policy_id: policyId,
      version_number: nextVersion,
      status: "in_review",
      claims_persisted: claims.length,
    });
  } catch (error) {
    try {
      const db = (ctx as HandlerContextWithDb).db;
      if (db) {
        await db.query("ROLLBACK");
      }
    } catch {
      // intentionally swallow rollback failures
    }

    const message = error instanceof Error ? error.message : "Unknown error";
    return toErrorResult("persist_policy_draft_failed", message);
  }
}
