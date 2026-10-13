/**
 * LLM mapping prompt + zod-validated gateway call (F1-004, pass 2 of the mapper).
 *
 * For artifacts the deterministic rules do not cover, the mapper asks Claude
 * Sonnet (via the Nexus gateway) which Security TSC criteria the artifact
 * evidences. The model's output is constrained to a zod schema whose control_id
 * is an ENUM of the real criteria, so a hallucinated control can never be
 * persisted (feasibility key_technical_risks[0] "LLM hallucinations or incorrect
 * control mappings"). Any model output below 0.7 confidence is flagged for the
 * operator review queue downstream; none of it is ever auto-confirmed.
 *
 * The gateway endpoint + token come from env (NEXUS_GATEWAY_URL /
 * NEXUS_GATEWAY_TOKEN) — never hardcoded.
 */

import { z } from "zod";
import type { ControlSeed } from "./library";

/** Claude Sonnet via the Nexus gateway (JSON-schema constrained). */
export const MAPPING_MODEL = "claude-sonnet-5";

/** Shape of an artifact the model is asked to classify. */
export interface ArtifactForPrompt {
  readonly id: string;
  readonly source: string;
  readonly artifactType: string;
  readonly title: string;
  readonly summary: string | null;
}

/** One proposed criterion mapping from the model. */
export interface ModelMappingProposal {
  readonly controlId: string;
  readonly confidence: number;
  readonly rationale: string;
}

/**
 * Build the zod schema for a single mapping call. control_id is constrained to
 * the exact set of valid criteria IDs, so the model cannot invent a control.
 */
export function buildMappingSchema(validControlIds: readonly string[]) {
  const ids = validControlIds.length > 0 ? [...validControlIds] : ["CC1.1"];
  const controlIdSchema = z.enum([ids[0], ...ids.slice(1)] as [string, ...string[]]);

  const mapping = z.object({
    controlId: controlIdSchema,
    confidence: z.number().min(0).max(1),
    rationale: z.string().min(1).max(1000),
  });

  return z.object({
    mappings: z.array(mapping).max(8),
  });
}

/** System prompt: terse, grounded, refusal-on-uncertainty. */
export function buildSystemPrompt(): string {
  return [
    "You are a SOC 2 (Security Trust Services Criteria) evidence-mapping assistant.",
    "Given ONE evidence artifact, decide which common criteria (CC1.1–CC9.2) it",
    "provides evidence for. Only propose a criterion when the artifact genuinely",
    "supports it. Never invent a control id outside the provided list. Assign a",
    "confidence in [0,1]; use <0.7 when the link is plausible but not strong, and",
    "omit a criterion entirely when there is no real evidence. Keep each rationale",
    "to one sentence grounded in the artifact's content. Return STRICT JSON that",
    "matches the schema — an object with a `mappings` array. If nothing applies,",
    "return an empty array.",
  ].join(" ");
}

/** User prompt: the candidate criteria catalogue + the artifact to classify. */
export function buildMappingPrompt(
  artifact: ArtifactForPrompt,
  candidates: readonly ControlSeed[],
): string {
  const catalogue = candidates
    .map((c) => `- ${c.controlId} (${c.title}): ${c.paraphrase}`)
    .join("\n");

  return [
    "Candidate criteria:",
    catalogue,
    "",
    "Evidence artifact:",
    `- id: ${artifact.id}`,
    `- source: ${artifact.source}`,
    `- type: ${artifact.artifactType}`,
    `- title: ${artifact.title}`,
    `- summary: ${artifact.summary ?? "(none provided)"}`,
    "",
    'Respond with JSON only, e.g. {"mappings":[{"controlId":"CC6.1","confidence":0.82,"rationale":"..."}]}',
  ].join("\n");
}

/** Extract the assistant text from the common gateway response envelopes. */
function extractText(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const obj = payload as Record<string, unknown>;

  // Anthropic-style: { content: [{ type: "text", text: "..." }] }
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

  // OpenAI-style: { choices: [{ message: { content: "..." } }] }
  if (Array.isArray(obj.choices) && obj.choices.length > 0) {
    const first = obj.choices[0] as Record<string, unknown>;
    const message = first?.message as Record<string, unknown> | undefined;
    if (message && typeof message.content === "string") return message.content;
    if (typeof first?.text === "string") return first.text as string;
  }

  // Gateway-flat: { text: "..." } or { output_text: "..." }
  if (typeof obj.text === "string") return obj.text;
  if (typeof obj.output_text === "string") return obj.output_text;

  return null;
}

/** Pull the first balanced JSON object out of a text blob (handles code fences). */
function sliceJson(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return body.slice(start, end + 1);
}

export interface MappingModelResult {
  readonly proposals: ModelMappingProposal[];
  readonly model: string;
  readonly ok: boolean;
  readonly error?: string;
}

/**
 * Call Claude Sonnet via the Nexus gateway and return zod-validated proposals.
 *
 * Never throws: on any transport/parse/validation failure it returns
 * `{ ok: false, proposals: [] }` with a structured-log line, so the mapper can
 * fall through without persisting unvalidated output.
 */
export async function callMappingModel(
  artifact: ArtifactForPrompt,
  candidates: readonly ControlSeed[],
): Promise<MappingModelResult> {
  const baseUrl = process.env.NEXUS_GATEWAY_URL;
  const token = process.env.NEXUS_GATEWAY_TOKEN;
  const schema = buildMappingSchema(candidates.map((c) => c.controlId));

  if (!baseUrl || !token) {
    console.warn(
      JSON.stringify({
        level: "warn",
        component: "soc2.mapper.model",
        message: "gateway env missing — skipping model pass",
        artifact_id: artifact.id,
      }),
    );
    return { proposals: [], model: MAPPING_MODEL, ok: false, error: "gateway_env_missing" };
  }

  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: MAPPING_MODEL,
        max_tokens: 1024,
        temperature: 0,
        response_format: { type: "json_object" },
        system: buildSystemPrompt(),
        messages: [{ role: "user", content: buildMappingPrompt(artifact, candidates) }],
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
    return { proposals: parsed.mappings, model: MAPPING_MODEL, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown model error";
    console.error(
      JSON.stringify({
        level: "error",
        component: "soc2.mapper.model",
        artifact_id: artifact.id,
        message,
      }),
    );
    return { proposals: [], model: MAPPING_MODEL, ok: false, error: message };
  }
}
