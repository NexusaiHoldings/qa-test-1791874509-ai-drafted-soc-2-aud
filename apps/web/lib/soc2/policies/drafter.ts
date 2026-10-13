/**
 * Grounded policy drafter (F1-005).
 *
 * Builds a prompt from a soc2_policy_templates skeleton PLUS only the CONFIRMED
 * evidence artifacts linked to the Security TSC criteria that policy covers, then
 * asks Claude Sonnet (via the Nexus gateway) for markdown + a `claims` array in
 * which every factual sentence carries an `artifactId`. Any sentence the model
 * cannot ground is emitted with `needsReview = true` (rendered as a NEEDS REVIEW
 * flag). Output is zod-validated — artifactId is constrained to the exact set of
 * confirmed artifact ids, so a hallucinated citation can never be persisted.
 *
 * The draft is stored as a soc2_policy_versions row (status 'draft') with the
 * claims in soc2_policy_claims. Retrieval is deterministic:
 *   policy -> covered control_ids -> CONFIRMED soc2_control_evidence_links ->
 *   soc2_evidence_artifacts. No vector DB (design: a Series A tenant produces
 *   hundreds, not millions, of artifacts; grounding must be exact).
 *
 * Gateway env (NEXUS_GATEWAY_URL / NEXUS_GATEWAY_TOKEN) is read at call time,
 * never hardcoded. If the gateway is unavailable the drafter falls back to a
 * deterministic skeleton draft so the page still renders a reviewable document.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import type { SqlClient } from "@/lib/soc2/controls/library";
import type { PolicyTemplate } from "@/lib/soc2/policies/templates";

/** Claude Sonnet via the Nexus gateway (JSON-schema constrained). */
export const DRAFTING_MODEL = "claude-sonnet-5";

/** A confirmed evidence artifact available to ground a policy. */
export interface ConfirmedArtifact {
  readonly id: string;
  readonly source: string;
  readonly artifactType: string;
  readonly title: string;
  readonly summary: string | null;
  readonly collectedAt: string;
  readonly controlIds: readonly string[];
}

/** One factual sentence of the draft, grounded or flagged for review. */
export interface PolicyClaim {
  readonly sentence: string;
  readonly artifactId: string | null;
  readonly needsReview: boolean;
  readonly excerpt: string | null;
}

/** The validated result of a drafting call. */
export interface PolicyDraftResult {
  readonly bodyMarkdown: string;
  readonly claims: readonly PolicyClaim[];
  readonly model: string;
  readonly grounded: boolean;
}

interface EvidenceRow {
  id: string;
  source: string;
  artifact_type: string;
  title: string;
  summary: string | null;
  collected_at: string | Date;
  control_ids: unknown;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return [];
    }
  }
  return [];
}

function toIso(value: string | Date): string {
  if (typeof value === "string") return value;
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * Load the CONFIRMED evidence artifacts linked to the criteria a policy covers.
 *
 * Only `status = 'confirmed'` links are returned — proposed/rejected mappings are
 * never used for grounding (the structural answer to the autonomy score). One
 * row per artifact; `control_ids` aggregates every covered criterion it supports.
 */
export async function getConfirmedArtifactsForPolicy(
  db: SqlClient,
  orgId: string,
  coveredControlIds: readonly string[],
): Promise<ConfirmedArtifact[]> {
  if (coveredControlIds.length === 0) return [];
  const rows = await db.query<EvidenceRow>(
    `SELECT a.id, a.source, a.artifact_type, a.title, a.summary, a.collected_at,
            jsonb_agg(DISTINCT l.control_id) AS control_ids
       FROM soc2_control_evidence_links l
       JOIN soc2_evidence_artifacts a ON a.id = l.artifact_id
      WHERE l.org_id = $1
        AND l.status = 'confirmed'
        AND l.control_id = ANY($2::text[])
      GROUP BY a.id, a.source, a.artifact_type, a.title, a.summary, a.collected_at
      ORDER BY a.collected_at DESC
      LIMIT 200`,
    orgId,
    [...coveredControlIds],
  );
  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    artifactType: r.artifact_type,
    title: r.title,
    summary: r.summary,
    collectedAt: toIso(r.collected_at),
    controlIds: toStringArray(r.control_ids),
  }));
}

/**
 * Build the zod schema for a drafting call. artifactId is constrained to the
 * confirmed artifact ids (plus null), so a fabricated citation fails validation.
 */
export function buildDraftSchema(artifactIds: readonly string[]) {
  const idSchema =
    artifactIds.length > 0
      ? z.enum([artifactIds[0], ...artifactIds.slice(1)] as [string, ...string[]]).nullable()
      : z.null();

  const claim = z.object({
    sentence: z.string().min(1).max(2000),
    artifactId: idSchema,
    needsReview: z.boolean(),
    excerpt: z.string().max(2000).nullable().optional(),
  });

  return z.object({
    bodyMarkdown: z.string().min(1).max(60000),
    claims: z.array(claim).max(400),
  });
}

/** System prompt: grounded, cite-or-flag, no invented evidence. */
export function buildDraftSystemPrompt(): string {
  return [
    "You are a SOC 2 policy-drafting assistant for a Series A SaaS company.",
    "Draft a clear, professional policy in GitHub-flavored Markdown following the",
    "provided section skeleton exactly (use the given headings as ## headings).",
    "You are given a set of CONFIRMED evidence artifacts, each with an id. Every",
    "factual sentence — any sentence asserting that a specific control exists, is",
    "configured, or is operating — MUST be grounded in one of those artifacts by",
    "its id. If you cannot ground a factual sentence in a provided artifact, you",
    "MUST still write it (policies need complete coverage) but mark it with",
    "needsReview=true and artifactId=null. Principled, non-factual framing",
    "sentences (purpose statements, definitions) may use needsReview=false with",
    "artifactId=null. Never invent an artifact id outside the provided list.",
    "Return STRICT JSON matching the schema: an object with `bodyMarkdown` (the",
    "full policy) and `claims` (one entry per factual sentence, in document order,",
    "each with sentence, artifactId, needsReview, and an optional excerpt quoting",
    "the artifact detail you relied on).",
  ].join(" ");
}

/** User prompt: the skeleton + the confirmed evidence catalogue. */
export function buildDraftUserPrompt(
  template: PolicyTemplate,
  artifacts: readonly ConfirmedArtifact[],
): string {
  const skeleton = template.sections
    .map((s, i) => `${i + 1}. ## ${s.heading}\n   Guidance: ${s.guidance}`)
    .join("\n");

  const evidence =
    artifacts.length === 0
      ? "(no confirmed evidence yet — draft principled language and flag every factual sentence with needsReview=true)"
      : artifacts
          .map(
            (a) =>
              `- id: ${a.id}\n  source: ${a.source}\n  type: ${a.artifactType}\n  covers: ${a.controlIds.join(", ")}\n  title: ${a.title}\n  summary: ${a.summary ?? "(none)"}`,
          )
          .join("\n");

  return [
    `Policy: ${template.title}`,
    `Criteria documented: ${template.coveredControlIds.join(", ")}`,
    "",
    "Required sections (use these headings, in order):",
    skeleton,
    "",
    "Confirmed evidence artifacts available for grounding:",
    evidence,
    "",
    'Respond with JSON only, e.g. {"bodyMarkdown":"# ...","claims":[{"sentence":"...","artifactId":"<uuid|null>","needsReview":false,"excerpt":null}]}',
  ].join("\n");
}

/** Extract assistant text from the common gateway response envelopes. */
function extractText(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const obj = payload as Record<string, unknown>;

  if (Array.isArray(obj.content)) {
    const parts = obj.content
      .map((p) =>
        typeof p === "object" && p !== null && typeof (p as Record<string, unknown>).text === "string"
          ? ((p as Record<string, unknown>).text as string)
          : "",
      )
      .join("");
    if (parts.trim().length > 0) return parts;
  }

  if (Array.isArray(obj.choices) && obj.choices.length > 0) {
    const first = obj.choices[0] as Record<string, unknown>;
    const message = first?.message as Record<string, unknown> | undefined;
    if (message && typeof message.content === "string") return message.content;
    if (typeof first?.text === "string") return first.text as string;
  }

  if (typeof obj.text === "string") return obj.text;
  if (typeof obj.output_text === "string") return obj.output_text;
  return null;
}

/** Pull the first balanced JSON object out of a text blob (handles fences). */
function sliceJson(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return body.slice(start, end + 1);
}

/**
 * Deterministic fallback draft, used when the gateway is unavailable or errors.
 *
 * Produces a complete, reviewable skeleton: each required section becomes a
 * heading with a framing sentence; every confirmed artifact becomes a grounded
 * claim, and sections with no evidence get a NEEDS REVIEW sentence. This keeps
 * the page functional (and honest about gaps) without the model.
 */
export function buildFallbackDraft(
  template: PolicyTemplate,
  artifacts: readonly ConfirmedArtifact[],
): PolicyDraftResult {
  const lines: string[] = [`# ${template.title}`, "", `_${template.summary}_`, ""];
  const claims: PolicyClaim[] = [];

  for (const section of template.sections) {
    lines.push(`## ${section.heading}`, "");
    const framing = `This section describes ${section.heading.toLowerCase()} for ${template.title}.`;
    lines.push(framing, "");
    claims.push({ sentence: framing, artifactId: null, needsReview: false, excerpt: null });

    const relevant = artifacts.filter((a) =>
      a.controlIds.some((c) => template.coveredControlIds.includes(c)),
    );
    if (relevant.length > 0) {
      for (const a of relevant.slice(0, 3)) {
        const sentence = `Evidence "${a.title}" (${a.source}/${a.artifactType}) supports ${a.controlIds.join(", ")}.`;
        lines.push(`- ${sentence}`);
        claims.push({
          sentence,
          artifactId: a.id,
          needsReview: false,
          excerpt: a.summary,
        });
      }
      lines.push("");
    } else {
      const gap = `No confirmed evidence is yet linked for this section; the control statement requires review before approval.`;
      lines.push(`> ${gap}`, "");
      claims.push({ sentence: gap, artifactId: null, needsReview: true, excerpt: null });
    }
  }

  return {
    bodyMarkdown: lines.join("\n").trim(),
    claims,
    model: "deterministic-fallback",
    grounded: artifacts.length > 0,
  };
}

/**
 * Call the drafting model via the Nexus gateway and return a validated result.
 *
 * Never throws: on any transport/parse/validation failure it returns the
 * deterministic fallback draft with a structured-log line, so a drafting attempt
 * always yields a reviewable document.
 */
export async function callPolicyDraftModel(
  template: PolicyTemplate,
  artifacts: readonly ConfirmedArtifact[],
): Promise<PolicyDraftResult> {
  const baseUrl = process.env.NEXUS_GATEWAY_URL;
  const token = process.env.NEXUS_GATEWAY_TOKEN;

  if (!baseUrl || !token) {
    console.warn(
      JSON.stringify({
        level: "warn",
        component: "soc2.policies.drafter",
        message: "gateway env missing — using deterministic fallback draft",
        policy_key: template.policyKey,
      }),
    );
    return buildFallbackDraft(template, artifacts);
  }

  const schema = buildDraftSchema(artifacts.map((a) => a.id));

  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: DRAFTING_MODEL,
        max_tokens: 4096,
        temperature: 0.2,
        response_format: { type: "json_object" },
        system: buildDraftSystemPrompt(),
        messages: [{ role: "user", content: buildDraftUserPrompt(template, artifacts) }],
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`gateway ${res.status}: ${detail.slice(0, 200)}`);
    }

    const payload: unknown = await res.json();
    const text = extractText(payload);
    if (!text) throw new Error("no text in gateway response");

    const jsonText = sliceJson(text);
    if (!jsonText) throw new Error("no JSON object in model output");

    const parsed = schema.parse(JSON.parse(jsonText));
    const claims: PolicyClaim[] = parsed.claims.map((c) => ({
      sentence: c.sentence,
      artifactId: c.artifactId ?? null,
      // Defense-in-depth: a factual claim with no artifact is always review-worthy.
      needsReview: c.needsReview || (c.artifactId == null && /\b(is|are|has|have|was|were|enforces?|requires?)\b/i.test(c.sentence)),
      excerpt: c.excerpt ?? null,
    }));
    return {
      bodyMarkdown: parsed.bodyMarkdown,
      claims,
      model: DRAFTING_MODEL,
      grounded: claims.some((c) => c.artifactId != null),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown drafting error";
    console.error(
      JSON.stringify({
        level: "error",
        component: "soc2.policies.drafter",
        policy_key: template.policyKey,
        message,
      }),
    );
    return buildFallbackDraft(template, artifacts);
  }
}

/** sha256 of the policy body — the content pinned by the approval gate. */
export function contentHash(bodyMarkdown: string): string {
  return createHash("sha256").update(bodyMarkdown, "utf8").digest("hex");
}

const STORE_SQL = `
  WITH new_version AS (
    INSERT INTO soc2_policy_versions (
      org_id, policy_id, title, body_markdown, status,
      drafted_by, drafted_with_model, content_hash, needs_review_count,
      created_at, updated_at
    )
    VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7, $8, now(), now())
    RETURNING id
  ),
  inserted_claims AS (
    INSERT INTO soc2_policy_claims (
      org_id, policy_version_id, claim_type, claim_text,
      source_artifact_id, source_excerpt, created_at
    )
    SELECT $1, (SELECT id FROM new_version), c.claim_type, c.claim_text,
           c.source_artifact_id, c.source_excerpt, now()
    FROM unnest(
      $9::text[], $10::text[], $11::uuid[], $12::text[]
    ) AS c(claim_type, claim_text, source_artifact_id, source_excerpt)
    RETURNING id
  )
  SELECT (SELECT id FROM new_version) AS version_id,
         (SELECT count(*)::int FROM inserted_claims) AS claims_persisted
`;

/**
 * Persist a drafted policy version (status 'draft') + its claims, atomically.
 * Returns the new version id and the count of NEEDS REVIEW sentences.
 */
export async function storePolicyDraft(
  db: SqlClient,
  orgId: string,
  policyId: string,
  title: string,
  result: PolicyDraftResult,
  draftedBy: string | null,
): Promise<{ versionId: string; needsReviewCount: number }> {
  const claimTypes = result.claims.map((c) => (c.needsReview ? "needs_review" : "grounded"));
  const claimTexts = result.claims.map((c) => c.sentence);
  const claimArtifactIds = result.claims.map((c) => c.artifactId);
  const claimExcerpts = result.claims.map((c) => c.excerpt);
  const needsReviewCount = result.claims.filter((c) => c.needsReview).length;

  const rows = await db.query<{ version_id: string; claims_persisted: number }>(
    STORE_SQL,
    orgId,
    policyId,
    title,
    result.bodyMarkdown,
    draftedBy,
    result.model,
    contentHash(result.bodyMarkdown),
    needsReviewCount,
    claimTypes,
    claimTexts,
    claimArtifactIds,
    claimExcerpts,
  );

  const versionId = rows[0]?.version_id;
  if (!versionId) throw new Error("failed to persist policy draft");
  console.info(
    JSON.stringify({
      level: "info",
      component: "soc2.policies.drafter",
      org_id: orgId,
      policy_id: policyId,
      version_id: versionId,
      model: result.model,
      claims: result.claims.length,
      needs_review: needsReviewCount,
    }),
  );
  return { versionId, needsReviewCount };
}

/**
 * End-to-end: gather confirmed evidence, draft, and store a new policy version.
 * Returns the new version id, or throws on a persistence failure.
 */
export async function draftPolicy(
  db: SqlClient,
  orgId: string,
  policyId: string,
  template: PolicyTemplate,
  draftedBy: string | null,
): Promise<{ versionId: string; needsReviewCount: number; model: string }> {
  const artifacts = await getConfirmedArtifactsForPolicy(db, orgId, template.coveredControlIds);
  const result = await callPolicyDraftModel(template, artifacts);
  const stored = await storePolicyDraft(db, orgId, policyId, template.title, result, draftedBy);
  return { ...stored, model: result.model };
}
