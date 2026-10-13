/**
 * SOC 2 policy template skeletons (F1-005).
 *
 * The 10 highest-frequency policies from ceo_briefing.mvp_scope. Each template is
 * a static skeleton: a title, a human summary, the Security TSC criteria the
 * policy documents (covered_control_ids — the retrieval key the drafter uses to
 * pull ONLY confirmed evidence for grounding), and an ordered list of required
 * section headings with per-section drafting guidance for the model.
 *
 * These are original Nexus summaries — AICPA criterion text is never stored
 * verbatim (licensing blocker, same posture as the control library). The
 * per-tenant soc2_policies registry is seeded from this list.
 */

/** One required section of a policy, with drafting guidance for the model. */
export interface PolicyTemplateSection {
  readonly heading: string;
  readonly guidance: string;
}

/** A policy skeleton. `policyKey` is the stable slug; UUID ids live per-org. */
export interface PolicyTemplate {
  readonly policyKey: string;
  readonly title: string;
  readonly summary: string;
  readonly coveredControlIds: readonly string[];
  readonly sections: readonly PolicyTemplateSection[];
  readonly sortOrder: number;
}

const PURPOSE_SECTION: PolicyTemplateSection = {
  heading: "Purpose & Scope",
  guidance:
    "State what this policy governs, which systems and personnel it applies to, and the business objective it protects. Keep it to two or three sentences.",
};

const ROLES_SECTION: PolicyTemplateSection = {
  heading: "Roles & Responsibilities",
  guidance:
    "Name the accountable owner and the responsibilities of personnel. Ground any specific role or review cadence in a confirmed artifact where one exists.",
};

const REVIEW_SECTION: PolicyTemplateSection = {
  heading: "Enforcement & Review",
  guidance:
    "Describe how compliance is monitored, how exceptions are handled, and the review cadence (at least annually). Cite the confirmed artifact that evidences monitoring where available.",
};

/** The 10 MVP policies, in display order. */
export const POLICY_TEMPLATES: readonly PolicyTemplate[] = [
  {
    policyKey: "information-security",
    title: "Information Security Policy",
    summary:
      "The umbrella policy establishing the security program, management commitment, and the control environment.",
    coveredControlIds: ["CC1.1", "CC1.2", "CC1.3", "CC2.1", "CC2.2", "CC5.1", "CC5.2"],
    sortOrder: 1,
    sections: [
      PURPOSE_SECTION,
      {
        heading: "Security Governance",
        guidance:
          "Describe management's commitment to security, the reporting line, and board oversight. Ground statements about governance bodies or charters in confirmed artifacts.",
      },
      {
        heading: "Control Framework",
        guidance:
          "Explain that the program is organized around the Security Trust Services Criteria and how control activities are selected and operated.",
      },
      ROLES_SECTION,
      REVIEW_SECTION,
    ],
  },
  {
    policyKey: "acceptable-use",
    title: "Acceptable Use Policy",
    summary:
      "Defines permitted and prohibited use of company systems, data, and devices by personnel.",
    coveredControlIds: ["CC1.1", "CC2.2", "CC6.1", "CC6.6"],
    sortOrder: 2,
    sections: [
      PURPOSE_SECTION,
      {
        heading: "Acceptable Use",
        guidance:
          "Enumerate permitted uses of corporate systems and data. Keep statements principled unless a confirmed artifact documents a specific control.",
      },
      {
        heading: "Prohibited Activities",
        guidance:
          "List prohibited activities (credential sharing, unapproved software, data exfiltration). Flag any claim you cannot ground in a confirmed artifact.",
      },
      ROLES_SECTION,
      REVIEW_SECTION,
    ],
  },
  {
    policyKey: "access-control",
    title: "Access Control Policy",
    summary:
      "Governs provisioning, least-privilege, authentication, and deprovisioning of logical access.",
    coveredControlIds: ["CC6.1", "CC6.2", "CC6.3"],
    sortOrder: 3,
    sections: [
      PURPOSE_SECTION,
      {
        heading: "Access Provisioning & Least Privilege",
        guidance:
          "Describe how access is requested, approved, and granted on a least-privilege basis. Cite confirmed IAM or role artifacts where present.",
      },
      {
        heading: "Authentication",
        guidance:
          "Describe authentication requirements (MFA, password strength, SSO). Ground any specific control (e.g. root MFA enabled) in a confirmed artifact.",
      },
      {
        heading: "Deprovisioning & Access Reviews",
        guidance:
          "Describe timely revocation on termination and periodic access reviews. Cite the confirmed artifact evidencing reviews where available.",
      },
      REVIEW_SECTION,
    ],
  },
  {
    policyKey: "change-management",
    title: "Change Management Policy",
    summary:
      "Governs how changes to production systems are proposed, reviewed, approved, and deployed.",
    coveredControlIds: ["CC8.1"],
    sortOrder: 4,
    sections: [
      PURPOSE_SECTION,
      {
        heading: "Change Process",
        guidance:
          "Describe the change workflow from request through review to deployment. Cite confirmed pull-request, CI, or branch-protection artifacts where present.",
      },
      {
        heading: "Testing & Approval",
        guidance:
          "Describe required testing and approval gates before a change reaches production. Ground specific gates in confirmed artifacts.",
      },
      {
        heading: "Emergency Changes",
        guidance:
          "Describe how emergency changes are handled and retroactively reviewed.",
      },
      REVIEW_SECTION,
    ],
  },
  {
    policyKey: "incident-response",
    title: "Incident Response Policy",
    summary:
      "Defines detection, triage, containment, eradication, and post-incident review for security events.",
    coveredControlIds: ["CC7.3", "CC7.4", "CC7.5"],
    sortOrder: 5,
    sections: [
      PURPOSE_SECTION,
      {
        heading: "Detection & Reporting",
        guidance:
          "Describe how incidents are detected and reported. Cite confirmed monitoring or alerting artifacts (e.g. GuardDuty, CloudTrail) where present.",
      },
      {
        heading: "Response Procedure",
        guidance:
          "Describe the triage, containment, and eradication steps and the response roles involved.",
      },
      {
        heading: "Post-Incident Review",
        guidance:
          "Describe the post-incident review, root-cause analysis, and remediation tracking.",
      },
      REVIEW_SECTION,
    ],
  },
  {
    policyKey: "vendor-management",
    title: "Vendor Management Policy",
    summary:
      "Governs selection, risk assessment, and ongoing monitoring of third-party vendors and subprocessors.",
    coveredControlIds: ["CC9.2"],
    sortOrder: 6,
    sections: [
      PURPOSE_SECTION,
      {
        heading: "Vendor Risk Assessment",
        guidance:
          "Describe how vendors are assessed before onboarding (security review, SOC 2 request). Ground specific assessments in confirmed artifacts.",
      },
      {
        heading: "Ongoing Monitoring",
        guidance:
          "Describe periodic re-assessment of critical vendors and subprocessor change handling.",
      },
      ROLES_SECTION,
      REVIEW_SECTION,
    ],
  },
  {
    policyKey: "business-continuity-dr",
    title: "Business Continuity & Disaster Recovery Policy",
    summary:
      "Defines resilience objectives, backup, and recovery procedures to sustain operations through disruption.",
    coveredControlIds: ["CC7.5", "CC9.1"],
    sortOrder: 7,
    sections: [
      PURPOSE_SECTION,
      {
        heading: "Recovery Objectives",
        guidance:
          "State the recovery time and recovery point objectives. Keep targets principled unless a confirmed artifact documents a tested value.",
      },
      {
        heading: "Backup & Recovery",
        guidance:
          "Describe backup frequency, retention, and restoration testing. Cite confirmed backup-configuration artifacts (e.g. S3 versioning, RDS snapshots) where present.",
      },
      {
        heading: "Continuity Testing",
        guidance:
          "Describe the cadence for exercising the continuity and recovery plan.",
      },
      REVIEW_SECTION,
    ],
  },
  {
    policyKey: "data-classification-retention",
    title: "Data Classification & Retention Policy",
    summary:
      "Classifies data by sensitivity and defines handling, encryption, and retention/disposal requirements.",
    coveredControlIds: ["CC3.2", "CC6.1", "CC6.5"],
    sortOrder: 8,
    sections: [
      PURPOSE_SECTION,
      {
        heading: "Data Classification",
        guidance:
          "Define the classification tiers and examples of each. Keep tiers principled unless a confirmed artifact documents them.",
      },
      {
        heading: "Handling & Encryption",
        guidance:
          "Describe handling and encryption-at-rest/in-transit requirements per tier. Cite confirmed encryption artifacts (e.g. S3 default encryption) where present.",
      },
      {
        heading: "Retention & Disposal",
        guidance:
          "Describe retention periods and secure disposal. Ground specific media-disposal controls in confirmed artifacts.",
      },
      REVIEW_SECTION,
    ],
  },
  {
    policyKey: "risk-assessment",
    title: "Risk Assessment Policy",
    summary:
      "Defines how security and operational risks are identified, scored, treated, and tracked.",
    coveredControlIds: ["CC3.1", "CC3.2", "CC3.3", "CC3.4", "CC9.1"],
    sortOrder: 9,
    sections: [
      PURPOSE_SECTION,
      {
        heading: "Risk Identification & Scoring",
        guidance:
          "Describe how risks are identified and scored (likelihood x impact). Cite confirmed risk-register artifacts where present.",
      },
      {
        heading: "Risk Treatment",
        guidance:
          "Describe how risks are accepted, mitigated, transferred, or avoided, and how treatment is tracked to closure.",
      },
      {
        heading: "Fraud & Change Risk",
        guidance:
          "Describe how the assessment considers fraud risk and risk from significant change.",
      },
      REVIEW_SECTION,
    ],
  },
  {
    policyKey: "vulnerability-management",
    title: "Vulnerability Management Policy",
    summary:
      "Governs scanning, prioritization, and remediation of vulnerabilities across the environment.",
    coveredControlIds: ["CC6.6", "CC6.8", "CC7.1", "CC7.2"],
    sortOrder: 10,
    sections: [
      PURPOSE_SECTION,
      {
        heading: "Scanning & Detection",
        guidance:
          "Describe scanning cadence and tooling. Cite confirmed vulnerability-scan or configuration-baseline artifacts (e.g. Config, dependency alerts) where present.",
      },
      {
        heading: "Prioritization & Remediation SLAs",
        guidance:
          "Describe how findings are prioritized by severity and the remediation SLAs. Ground specific SLA values in confirmed artifacts.",
      },
      {
        heading: "Patch Management",
        guidance:
          "Describe how patches are applied and tracked across managed systems.",
      },
      REVIEW_SECTION,
    ],
  },
];

/** Resolve a template by its stable slug. */
export function templateByKey(policyKey: string): PolicyTemplate | undefined {
  return POLICY_TEMPLATES.find((t) => t.policyKey === policyKey);
}

/** The full set of covered control ids (deduplicated) across all policies. */
export function allCoveredControlIds(): string[] {
  const set = new Set<string>();
  for (const t of POLICY_TEMPLATES) {
    for (const id of t.coveredControlIds) set.add(id);
  }
  return [...set];
}
