import crypto from "crypto";

export type TraceabilityStatus = "traceable" | "untraceable" | "stale";

export interface TraceabilityMatrixRow {
  claimId: string;
  policyId: string;
  policyTitle: string;
  policyVersionId: string;
  claimText: string;
  claimType: string;
  artifactId: string | null;
  artifactTitle: string | null;
  controlId: string | null;
  collectedAt: string | null;
  contentHash: string | null;
  status: TraceabilityStatus;
  reason: string | null;
}

export interface TraceabilityGateSummary {
  totalClaims: number;
  untraceableClaims: number;
  staleClaims: number;
  pass: boolean;
}

export interface TraceabilityBuildResult {
  rows: TraceabilityMatrixRow[];
  summary: TraceabilityGateSummary;
  matrixHash: string;
}

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

export function buildTraceabilityMatrix(
  rows: TraceabilityMatrixRow[],
): TraceabilityBuildResult {
  const now = Date.now();

  const normalized = rows.map((row: TraceabilityMatrixRow) => {
    if (!row.artifactId) {
      return {
        ...row,
        status: "untraceable" as const,
        reason: "No source artifact is linked to this claim.",
      };
    }

    if (!row.collectedAt) {
      return {
        ...row,
        status: "untraceable" as const,
        reason: "Source artifact has no collection timestamp.",
      };
    }

    const collectedTs = new Date(row.collectedAt).getTime();
    if (Number.isNaN(collectedTs)) {
      return {
        ...row,
        status: "untraceable" as const,
        reason: "Source artifact timestamp is invalid.",
      };
    }

    if (now - collectedTs > NINETY_DAYS_MS) {
      return {
        ...row,
        status: "stale" as const,
        reason: "Source artifact is older than 90 days.",
      };
    }

    return {
      ...row,
      status: "traceable" as const,
      reason: null,
    };
  });

  const summary: TraceabilityGateSummary = {
    totalClaims: normalized.length,
    untraceableClaims: normalized.filter((r) => r.status === "untraceable").length,
    staleClaims: normalized.filter((r) => r.status === "stale").length,
    pass:
      normalized.filter((r) => r.status === "untraceable").length === 0 &&
      normalized.filter((r) => r.status === "stale").length === 0,
  };

  const matrixHash = crypto
    .createHash("sha256")
    .update(JSON.stringify({ rows: normalized, summary }))
    .digest("hex");

  return { rows: normalized, summary, matrixHash };
}
