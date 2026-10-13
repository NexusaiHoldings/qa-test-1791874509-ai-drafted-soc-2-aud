/**
 * Control-to-evidence mapper (F1-004) — the heart of "reliable control-to-evidence
 * mapping" named by build_complexity.
 *
 * Two passes link evidence artifacts to Security TSC criteria:
 *   1. Deterministic rules (soc2_mapping_rules) — e.g. an IAM root-MFA artifact
 *      always proposes CC6.1 + CC6.6. No model call, high confidence.
 *   2. For artifacts no rule covers, a gateway call to Claude Sonnet with a
 *      zod-validated schema (see prompts.ts) proposes criteria + rationale.
 *
 * Every link is written with status 'proposed'. NOTHING becomes 'confirmed'
 * without a human Accept click (acceptLink). Proposals under 0.7 confidence are
 * additionally flagged `needs_review` for the operator queue. This structural
 * gate is the answer to the 35/100 autonomous_operation_score and the
 * "customer reliance on gap analysis outputs" liability vector.
 */

import {
  SECURITY_TSC_CONTROLS,
  type ControlSeed,
  type MappingRuleSeed,
  type SqlClient,
  categoryOf,
} from "./library";
import {
  callMappingModel,
  type ArtifactForPrompt,
  type ModelMappingProposal,
} from "./prompts";

/** Confidence at/under which a proposal is held for operator review. */
export const REVIEW_THRESHOLD = 0.7;

export type LinkStatus = "proposed" | "confirmed" | "rejected";
export type MappingMethod = "rule" | "model";

export interface ControlGridItem {
  readonly controlId: string;
  readonly category: string;
  readonly categoryTitle: string;
  readonly title: string;
  readonly paraphrase: string;
  readonly evidenceCount: number;
  readonly confirmedCount: number;
  readonly proposedCount: number;
  readonly reviewCount: number;
  readonly topConfidence: number;
}

export interface CategoryGroup {
  readonly category: string;
  readonly categoryTitle: string;
  readonly controls: ControlGridItem[];
  /** Criteria with ≥1 confirmed link ÷ total criteria, as a 0..1 ratio. */
  readonly coverage: number;
  readonly coveredCount: number;
  readonly totalCount: number;
}

export interface EvidenceLinkRow {
  readonly linkId: string;
  readonly artifactId: string;
  readonly source: string;
  readonly artifactType: string;
  readonly artifactTitle: string;
  readonly artifactSummary: string | null;
  readonly collectedAt: string;
  readonly confidence: number;
  readonly rationale: string;
  readonly status: LinkStatus;
  readonly method: MappingMethod;
  readonly needsReview: boolean;
  readonly modelName: string | null;
}

export interface ControlDetail {
  readonly control: ControlSeed;
  readonly links: EvidenceLinkRow[];
}

export interface MappingSummary {
  readonly artifactsScanned: number;
  readonly ruleLinks: number;
  readonly modelLinks: number;
  readonly flaggedForReview: number;
}

interface ArtifactRow {
  id: string;
  source: string;
  artifact_type: string;
  title: string;
  summary: string | null;
}

interface RuleRow {
  rule_key: string;
  artifact_type: string;
  match_keywords: unknown;
  control_ids: unknown;
  confidence: string | number;
  rationale: string;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return [];
    }
  }
  return [];
}

function clampConfidence(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Load the deterministic rules, indexed by artifact_type. */
async function loadRules(db: SqlClient): Promise<Map<string, MappingRuleSeed[]>> {
  const rows = await db.query<RuleRow>(
    `SELECT rule_key, artifact_type, match_keywords, control_ids, confidence, rationale
       FROM soc2_mapping_rules`,
  );
  const byType = new Map<string, MappingRuleSeed[]>();
  for (const r of rows) {
    const seed: MappingRuleSeed = {
      ruleKey: r.rule_key,
      artifactType: r.artifact_type,
      matchKeywords: toStringArray(r.match_keywords),
      controlIds: toStringArray(r.control_ids),
      confidence: clampConfidence(Number(r.confidence)),
      rationale: r.rationale,
    };
    const list = byType.get(seed.artifactType) ?? [];
    list.push(seed);
    byType.set(seed.artifactType, list);
  }
  return byType;
}

const INSERT_LINK_SQL = `
  INSERT INTO soc2_control_evidence_links
    (org_id, control_id, artifact_id, mapping_confidence, rationale,
     status, mapping_method, needs_review, model_name, created_at, updated_at)
  VALUES ($1, $2, $3, $4, $5, 'proposed', $6, $7, $8, now(), now())
  ON CONFLICT (org_id, control_id, artifact_id) DO NOTHING
  RETURNING id
`;

async function insertProposedLink(
  db: SqlClient,
  orgId: string,
  controlId: string,
  artifactId: string,
  confidence: number,
  rationale: string,
  method: MappingMethod,
  modelName: string | null,
): Promise<boolean> {
  const conf = clampConfidence(confidence);
  const needsReview = conf < REVIEW_THRESHOLD;
  const rows = await db.query<{ id: string }>(
    INSERT_LINK_SQL,
    orgId,
    controlId,
    artifactId,
    conf,
    rationale,
    method,
    needsReview,
    modelName,
  );
  return rows.length > 0;
}

/**
 * Run both mapping passes over the org's not-yet-mapped artifacts.
 *
 * Only artifacts with no existing link are processed, so this is safe to call
 * repeatedly (e.g. after a new collection run). Validation of model output has
 * already happened inside callMappingModel via zod.
 */
export async function runMappingForOrg(
  db: SqlClient,
  orgId: string,
): Promise<MappingSummary> {
  const validControlIds = new Set(SECURITY_TSC_CONTROLS.map((c) => c.controlId));
  const controls = SECURITY_TSC_CONTROLS;
  const rulesByType = await loadRules(db);

  const artifacts = await db.query<ArtifactRow>(
    `SELECT a.id, a.source, a.artifact_type, a.title, a.summary
       FROM soc2_evidence_artifacts a
      WHERE a.org_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM soc2_control_evidence_links l
           WHERE l.org_id = a.org_id AND l.artifact_id = a.id
        )
      ORDER BY a.collected_at ASC
      LIMIT 500`,
    orgId,
  );

  let ruleLinks = 0;
  let modelLinks = 0;
  let flagged = 0;

  for (const artifact of artifacts) {
    const matchingRules = rulesByType.get(artifact.artifact_type) ?? [];

    if (matchingRules.length > 0) {
      // Pass 1 — deterministic. Deduplicate control ids across matching rules,
      // keeping the highest confidence + its rationale for each.
      const best = new Map<string, { confidence: number; rationale: string }>();
      for (const rule of matchingRules) {
        for (const controlId of rule.controlIds) {
          if (!validControlIds.has(controlId)) continue;
          const prior = best.get(controlId);
          if (!prior || rule.confidence > prior.confidence) {
            best.set(controlId, { confidence: rule.confidence, rationale: rule.rationale });
          }
        }
      }
      for (const [controlId, { confidence, rationale }] of best) {
        const inserted = await insertProposedLink(
          db,
          orgId,
          controlId,
          artifact.id,
          confidence,
          rationale,
          "rule",
          null,
        );
        if (inserted) {
          ruleLinks += 1;
          if (confidence < REVIEW_THRESHOLD) flagged += 1;
        }
      }
      continue;
    }

    // Pass 2 — model. Only for artifacts no rule covered.
    const promptArtifact: ArtifactForPrompt = {
      id: artifact.id,
      source: artifact.source,
      artifactType: artifact.artifact_type,
      title: artifact.title,
      summary: artifact.summary,
    };
    const result = await callMappingModel(promptArtifact, controls);
    for (const proposal of result.proposals) {
      if (!validControlIds.has(proposal.controlId)) continue; // defense-in-depth
      const inserted = await insertProposedLink(
        db,
        orgId,
        proposal.controlId,
        artifact.id,
        proposal.confidence,
        proposal.rationale,
        "model",
        result.model,
      );
      if (inserted) {
        modelLinks += 1;
        if (proposal.confidence < REVIEW_THRESHOLD) flagged += 1;
      }
    }
  }

  const summary: MappingSummary = {
    artifactsScanned: artifacts.length,
    ruleLinks,
    modelLinks,
    flaggedForReview: flagged,
  };
  console.info(
    JSON.stringify({ level: "info", component: "soc2.mapper", org_id: orgId, ...summary }),
  );
  return summary;
}

/** Export the model-proposal type for callers that re-run a single artifact. */
export type { ModelMappingProposal };

interface GridRow {
  control_id: string;
  category: string;
  category_title: string;
  title: string;
  paraphrase: string;
  evidence_count: string | number;
  confirmed_count: string | number;
  proposed_count: string | number;
  review_count: string | number;
  top_confidence: string | number;
}

/**
 * Load every criterion with its per-org evidence rollup, grouped by CC category
 * with a coverage ratio — the data behind the /controls grid.
 */
export async function getControlsGrid(
  db: SqlClient,
  orgId: string,
): Promise<CategoryGroup[]> {
  const rows = await db.query<GridRow>(
    `SELECT c.control_id, c.category, c.category_title, c.title, c.paraphrase,
            COUNT(l.id) FILTER (WHERE l.status <> 'rejected')      AS evidence_count,
            COUNT(l.id) FILTER (WHERE l.status = 'confirmed')      AS confirmed_count,
            COUNT(l.id) FILTER (WHERE l.status = 'proposed')       AS proposed_count,
            COUNT(l.id) FILTER (WHERE l.status = 'proposed' AND l.needs_review) AS review_count,
            COALESCE(MAX(l.mapping_confidence) FILTER (WHERE l.status <> 'rejected'), 0) AS top_confidence
       FROM soc2_controls c
       LEFT JOIN soc2_control_evidence_links l
         ON l.control_id = c.control_id AND l.org_id = $1
      GROUP BY c.control_id, c.category, c.category_title, c.title, c.paraphrase, c.sort_order
      ORDER BY c.category ASC, c.sort_order ASC`,
    orgId,
  );

  const groups = new Map<string, CategoryGroup & { controls: ControlGridItem[] }>();
  for (const r of rows) {
    const item: ControlGridItem = {
      controlId: r.control_id,
      category: r.category,
      categoryTitle: r.category_title,
      title: r.title,
      paraphrase: r.paraphrase,
      evidenceCount: Number(r.evidence_count),
      confirmedCount: Number(r.confirmed_count),
      proposedCount: Number(r.proposed_count),
      reviewCount: Number(r.review_count),
      topConfidence: clampConfidence(Number(r.top_confidence)),
    };
    const existing = groups.get(r.category);
    if (existing) {
      existing.controls.push(item);
    } else {
      groups.set(r.category, {
        category: r.category,
        categoryTitle: r.category_title,
        controls: [item],
        coverage: 0,
        coveredCount: 0,
        totalCount: 0,
      });
    }
  }

  const result: CategoryGroup[] = [];
  for (const group of groups.values()) {
    const total = group.controls.length;
    const covered = group.controls.filter((c) => c.confirmedCount > 0).length;
    result.push({
      category: group.category,
      categoryTitle: group.categoryTitle,
      controls: group.controls,
      coveredCount: covered,
      totalCount: total,
      coverage: total === 0 ? 0 : covered / total,
    });
  }
  return result;
}

interface DetailLinkRow {
  link_id: string;
  artifact_id: string;
  source: string;
  artifact_type: string;
  artifact_title: string;
  artifact_summary: string | null;
  collected_at: string;
  confidence: string | number;
  rationale: string;
  status: string;
  method: string;
  needs_review: boolean;
  model_name: string | null;
}

/** Load one criterion (static seed) plus its per-org evidence links. */
export async function getControlDetail(
  db: SqlClient,
  orgId: string,
  controlId: string,
): Promise<ControlDetail | null> {
  const control = SECURITY_TSC_CONTROLS.find((c) => c.controlId === controlId);
  if (!control) return null;

  const rows = await db.query<DetailLinkRow>(
    `SELECT l.id AS link_id, l.artifact_id, a.source, a.artifact_type,
            a.title AS artifact_title, a.summary AS artifact_summary,
            a.collected_at, l.mapping_confidence AS confidence, l.rationale,
            l.status, l.mapping_method AS method, l.needs_review, l.model_name
       FROM soc2_control_evidence_links l
       JOIN soc2_evidence_artifacts a ON a.id = l.artifact_id
      WHERE l.org_id = $1 AND l.control_id = $2 AND l.status <> 'rejected'
      ORDER BY (l.status = 'confirmed') DESC, l.mapping_confidence DESC, a.collected_at DESC`,
    orgId,
    controlId,
  );

  const links: EvidenceLinkRow[] = rows.map((r) => ({
    linkId: r.link_id,
    artifactId: r.artifact_id,
    source: r.source,
    artifactType: r.artifact_type,
    artifactTitle: r.artifact_title,
    artifactSummary: r.artifact_summary,
    collectedAt: typeof r.collected_at === "string" ? r.collected_at : new Date(r.collected_at).toISOString(),
    confidence: clampConfidence(Number(r.confidence)),
    rationale: r.rationale,
    status: (r.status as LinkStatus) ?? "proposed",
    method: (r.method as MappingMethod) ?? "model",
    needsReview: Boolean(r.needs_review),
    modelName: r.model_name,
  }));

  return { control, links };
}

/** Human Accept — promote a proposed link to 'confirmed'. Returns success. */
export async function acceptLink(
  db: SqlClient,
  orgId: string,
  linkId: string,
  reviewerId: string | null,
): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `UPDATE soc2_control_evidence_links
        SET status = 'confirmed', needs_review = false,
            reviewed_by = $3, reviewed_at = now(), updated_at = now()
      WHERE id = $1 AND org_id = $2 AND status <> 'confirmed'
      RETURNING id`,
    linkId,
    orgId,
    reviewerId,
  );
  return rows.length > 0;
}

/** Human Reject — mark a proposed link 'rejected' so it leaves the queue. */
export async function rejectLink(
  db: SqlClient,
  orgId: string,
  linkId: string,
  reviewerId: string | null,
): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `UPDATE soc2_control_evidence_links
        SET status = 'rejected', needs_review = false,
            reviewed_by = $3, reviewed_at = now(), updated_at = now()
      WHERE id = $1 AND org_id = $2 AND status <> 'rejected'
      RETURNING id`,
    linkId,
    orgId,
    reviewerId,
  );
  return rows.length > 0;
}

/** Resolve the CC category for a control id (re-export for page grouping). */
export { categoryOf };

/**
 * Resolve the workspace org for the signed-in user (org = one Series A tenant).
 *
 * Returns the user's first org id, or null if they belong to none (the /org
 * page creates a default org on first visit). Querying the org lego's tables
 * directly mirrors apps/web/app/org/page.tsx.
 */
export async function resolveOrgId(
  db: SqlClient,
  userId: string,
): Promise<string | null> {
  if (!userId) return null;
  const rows = await db.query<{ id: string }>(
    `SELECT o.id
       FROM organizations o
       JOIN org_members m ON m.org_id = o.id
      WHERE m.user_id = $1
      ORDER BY o.created_at ASC
      LIMIT 1`,
    userId,
  );
  return rows[0]?.id ?? null;
}
