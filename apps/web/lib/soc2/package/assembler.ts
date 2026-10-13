import crypto from "crypto";
import { buildTraceabilityMatrix, type TraceabilityMatrixRow } from "./traceability";

export interface PolicyForPackage {
  policyId: string;
  title: string;
  versionId: string;
  bodyMarkdown: string;
  approvedAt: string;
  contentHash: string | null;
}

export interface EvidenceIndexRow {
  controlId: string;
  criterionTitle: string;
  artifactId: string;
  artifactTitle: string;
  source: string;
  collectedAt: string;
  contentHash: string | null;
}

export interface GateResult {
  key: "policies" | "evidenceFreshness" | "disclaimers" | "traceability";
  label: string;
  pass: boolean;
  reason: string;
  fixHref: string;
}

export interface PreviousPackage {
  id: string;
  createdAt: string;
  manifestHash: string;
  signedUrl: string | null;
}

export interface AuditPackageSnapshot {
  gates: GateResult[];
  canExport: boolean;
  exportDisabledReason: string | null;
  policies: PolicyForPackage[];
  evidenceIndex: EvidenceIndexRow[];
  traceability: ReturnType<typeof buildTraceabilityMatrix>;
  previous: PreviousPackage[];
}

export interface ExportPayload {
  orgId: string;
  exportedBy: string;
  policies: PolicyForPackage[];
  evidenceIndex: EvidenceIndexRow[];
  traceabilityRows: TraceabilityMatrixRow[];
  disclaimersAcknowledged: boolean;
}

export interface ExportResult {
  packageId: string;
  manifestHash: string;
  pdfFileId: string;
  zipFileId: string;
  signedUrl: string | null;
}

export function buildPackageSnapshot(input: {
  policiesInScope: number;
  approvedPolicies: PolicyForPackage[];
  evidenceIndex: EvidenceIndexRow[];
  traceabilityRows: TraceabilityMatrixRow[];
  disclaimersAcknowledged: boolean;
  previous: PreviousPackage[];
}): AuditPackageSnapshot {
  const traceability = buildTraceabilityMatrix(input.traceabilityRows);
  const staleEvidence = input.evidenceIndex.filter((row) => {
    const ageMs = Date.now() - new Date(row.collectedAt).getTime();
    return ageMs > 90 * 24 * 60 * 60 * 1000;
  });

  const gates: GateResult[] = [
    {
      key: "policies",
      label: "Policies approved",
      pass: input.approvedPolicies.length >= input.policiesInScope && input.policiesInScope > 0,
      reason:
        input.policiesInScope === 0
          ? "No policies are in scope yet."
          : `${input.approvedPolicies.length}/${input.policiesInScope} approved`,
      fixHref: "/policies",
    },
    {
      key: "evidenceFreshness",
      label: "Evidence freshness",
      pass: staleEvidence.length === 0,
      reason:
        staleEvidence.length === 0
          ? "All evidence used is within 90 days."
          : `${staleEvidence.length} artifact(s) are older than 90 days.`,
      fixHref: "/controls",
    },
    {
      key: "disclaimers",
      label: "Liability disclaimers acknowledged",
      pass: input.disclaimersAcknowledged,
      reason: input.disclaimersAcknowledged
        ? "Required disclaimers acknowledged."
        : "Required legal disclaimer not acknowledged.",
      fixHref: "/legal",
    },
    {
      key: "traceability",
      label: "Claim traceability",
      pass: traceability.summary.pass,
      reason: traceability.summary.pass
        ? "Every claim is traceable to fresh evidence."
        : `${traceability.summary.untraceableClaims} untraceable, ${traceability.summary.staleClaims} stale`,
      fixHref: "/policies",
    },
  ];

  const failing = gates.find((g) => !g.pass);

  return {
    gates,
    canExport: !failing,
    exportDisabledReason: failing ? `${failing.label}: ${failing.reason}` : null,
    policies: input.approvedPolicies,
    evidenceIndex: input.evidenceIndex,
    traceability,
    previous: input.previous,
  };
}

export async function exportAuditPackage(payload: ExportPayload): Promise<ExportResult> {
  const traceability = buildTraceabilityMatrix(payload.traceabilityRows);

  const staleEvidence = payload.evidenceIndex.some((row) => {
    const ageMs = Date.now() - new Date(row.collectedAt).getTime();
    return ageMs > 90 * 24 * 60 * 60 * 1000;
  });

  if (!payload.disclaimersAcknowledged) {
    throw new Error("Cannot export package: required legal disclaimers are not acknowledged.");
  }
  if (!traceability.summary.pass) {
    throw new Error("Cannot export package: traceability gate failed.");
  }
  if (staleEvidence) {
    throw new Error("Cannot export package: evidence freshness gate failed.");
  }

  const manifest = {
    orgId: payload.orgId,
    exportedBy: payload.exportedBy,
    exportedAt: new Date().toISOString(),
    policies: payload.policies.map((p) => ({
      policyId: p.policyId,
      title: p.title,
      versionId: p.versionId,
      contentHash: p.contentHash,
      approvedAt: p.approvedAt,
    })),
    evidenceIndex: payload.evidenceIndex,
    traceabilitySummary: traceability.summary,
    traceabilityHash: traceability.matrixHash,
  };

  const manifestHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(manifest))
    .digest("hex");

  const packageId = crypto.randomUUID();

  return {
    packageId,
    manifestHash,
    pdfFileId: `soc2-pkg-pdf-${packageId}`,
    zipFileId: `soc2-pkg-zip-${packageId}`,
    signedUrl: null,
  };
}
