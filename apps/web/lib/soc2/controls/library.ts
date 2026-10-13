/**
 * Security TSC control library + deterministic mapping-rule seed (F1-004).
 *
 * Seeds `soc2_controls` with the 2017 Trust Services Criteria *common criteria*
 * (CC1.1 … CC9.2), Nexus-paraphrased with points of focus. AICPA criterion text
 * is NOT stored verbatim (licensing blocker) — these are original summaries.
 *
 * Also seeds `soc2_mapping_rules`, the deterministic pass-1 rules the mapper
 * applies before any model call (e.g. an IAM root-MFA artifact always proposes
 * CC6.1 + CC6.6).
 *
 * Both seeds are idempotent upserts so they can run on every deploy / page load.
 */

/** Minimal SQL client shape (matches @/lib/db buildDb()). */
export interface SqlClient {
  query<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
  execute(sql: string, ...params: unknown[]): Promise<void>;
}

export interface ControlSeed {
  readonly controlId: string;
  readonly category: string;
  readonly categoryTitle: string;
  readonly title: string;
  readonly paraphrase: string;
  readonly pointsOfFocus: readonly string[];
  readonly satisfyingArtifactTypes: readonly string[];
}

export interface MappingRuleSeed {
  readonly ruleKey: string;
  readonly artifactType: string;
  readonly matchKeywords: readonly string[];
  readonly controlIds: readonly string[];
  readonly confidence: number;
  readonly rationale: string;
}

const CATEGORY_TITLES: Readonly<Record<string, string>> = {
  CC1: "Control Environment",
  CC2: "Communication & Information",
  CC3: "Risk Assessment",
  CC4: "Monitoring Activities",
  CC5: "Control Activities",
  CC6: "Logical & Physical Access Controls",
  CC7: "System Operations",
  CC8: "Change Management",
  CC9: "Risk Mitigation",
};

/** Resolve the CC category ("CC6.1" -> "CC6"). */
export function categoryOf(controlId: string): string {
  const dot = controlId.indexOf(".");
  return dot === -1 ? controlId : controlId.slice(0, dot);
}

/** The Security TSC common criteria, paraphrased. */
export const SECURITY_TSC_CONTROLS: readonly ControlSeed[] = [
  {
    controlId: "CC1.1",
    category: "CC1",
    categoryTitle: CATEGORY_TITLES.CC1,
    title: "Commitment to integrity and ethical values",
    paraphrase:
      "The organization demonstrates a commitment to integrity and ethical values through its stated standards of conduct and how it enforces them.",
    pointsOfFocus: [
      "A published code of conduct sets the tone from the top.",
      "Standards of conduct are communicated and acknowledged by personnel.",
      "Deviations from expected conduct are identified and remediated.",
    ],
    satisfyingArtifactTypes: ["code_of_conduct", "hr_policy_document", "employee_handbook"],
  },
  {
    controlId: "CC1.2",
    category: "CC1",
    categoryTitle: CATEGORY_TITLES.CC1,
    title: "Board independence and oversight",
    paraphrase:
      "The board of directors operates independently of management and exercises oversight of the design and operation of internal control.",
    pointsOfFocus: [
      "The board has members independent of management.",
      "The board reviews security and risk matters on a recurring cadence.",
    ],
    satisfyingArtifactTypes: ["board_minutes", "governance_charter"],
  },
  {
    controlId: "CC1.3",
    category: "CC1",
    categoryTitle: CATEGORY_TITLES.CC1,
    title: "Structures, reporting lines, authority",
    paraphrase:
      "Management establishes structures, reporting lines, and appropriate authorities and responsibilities in pursuit of its objectives.",
    pointsOfFocus: [
      "An organization chart defines reporting lines.",
      "Roles carry documented responsibilities and authority.",
    ],
    satisfyingArtifactTypes: ["org_chart", "role_definition", "hr_policy_document"],
  },
  {
    controlId: "CC1.4",
    category: "CC1",
    categoryTitle: CATEGORY_TITLES.CC1,
    title: "Commitment to competence",
    paraphrase:
      "The organization demonstrates a commitment to attract, develop, and retain competent individuals aligned with its objectives.",
    pointsOfFocus: [
      "Hiring considers the competencies the role requires.",
      "Security training is assigned and completed.",
    ],
    satisfyingArtifactTypes: ["training_certificate", "training_completion_report", "hr_policy_document"],
  },
  {
    controlId: "CC1.5",
    category: "CC1",
    categoryTitle: CATEGORY_TITLES.CC1,
    title: "Accountability for control responsibilities",
    paraphrase:
      "The organization holds individuals accountable for their internal control responsibilities in pursuit of its objectives.",
    pointsOfFocus: [
      "Performance and accountability measures reflect control duties.",
      "Corrective action follows control failures.",
    ],
    satisfyingArtifactTypes: ["performance_review_policy", "hr_policy_document"],
  },
  {
    controlId: "CC2.1",
    category: "CC2",
    categoryTitle: CATEGORY_TITLES.CC2,
    title: "Relevant, quality information",
    paraphrase:
      "The organization obtains or generates and uses relevant, quality information to support the functioning of internal control.",
    pointsOfFocus: [
      "Information sources are identified and kept current.",
      "Data used in controls is complete and accurate.",
    ],
    satisfyingArtifactTypes: ["data_inventory", "asset_inventory", "cloudtrail_log"],
  },
  {
    controlId: "CC2.2",
    category: "CC2",
    categoryTitle: CATEGORY_TITLES.CC2,
    title: "Internal communication",
    paraphrase:
      "The organization internally communicates information, including control objectives and responsibilities, necessary to support internal control.",
    pointsOfFocus: [
      "Security responsibilities are communicated to personnel.",
      "A channel exists to report control issues internally.",
    ],
    satisfyingArtifactTypes: ["security_policy_document", "incident_response_policy"],
  },
  {
    controlId: "CC2.3",
    category: "CC2",
    categoryTitle: CATEGORY_TITLES.CC2,
    title: "External communication",
    paraphrase:
      "The organization communicates with external parties about matters affecting the functioning of internal control.",
    pointsOfFocus: [
      "Commitments to customers (SLAs, security terms) are published.",
      "A mechanism exists for external parties to report issues.",
    ],
    satisfyingArtifactTypes: ["customer_agreement", "trust_center_page", "vulnerability_disclosure_policy"],
  },
  {
    controlId: "CC3.1",
    category: "CC3",
    categoryTitle: CATEGORY_TITLES.CC3,
    title: "Objectives for risk assessment",
    paraphrase:
      "The organization specifies objectives with sufficient clarity to enable the identification and assessment of risks relating to those objectives.",
    pointsOfFocus: [
      "Security objectives are defined and documented.",
      "Objectives consider applicable laws and commitments.",
    ],
    satisfyingArtifactTypes: ["risk_assessment", "security_policy_document"],
  },
  {
    controlId: "CC3.2",
    category: "CC3",
    categoryTitle: CATEGORY_TITLES.CC3,
    title: "Identification and analysis of risk",
    paraphrase:
      "The organization identifies risks to the achievement of its objectives and analyzes them as a basis for determining how they should be managed.",
    pointsOfFocus: [
      "A risk register captures identified risks.",
      "Risks are rated by likelihood and impact.",
    ],
    satisfyingArtifactTypes: ["risk_assessment", "risk_register"],
  },
  {
    controlId: "CC3.3",
    category: "CC3",
    categoryTitle: CATEGORY_TITLES.CC3,
    title: "Potential for fraud",
    paraphrase:
      "The organization considers the potential for fraud in assessing risks to the achievement of objectives.",
    pointsOfFocus: [
      "Fraud scenarios are considered during risk assessment.",
      "Incentives and pressures that could lead to fraud are evaluated.",
    ],
    satisfyingArtifactTypes: ["risk_assessment", "fraud_risk_assessment"],
  },
  {
    controlId: "CC3.4",
    category: "CC3",
    categoryTitle: CATEGORY_TITLES.CC3,
    title: "Significant change assessment",
    paraphrase:
      "The organization identifies and assesses changes that could significantly affect the system of internal control.",
    pointsOfFocus: [
      "Infrastructure and vendor changes are evaluated for risk.",
      "The risk assessment is refreshed when the environment changes.",
    ],
    satisfyingArtifactTypes: ["risk_assessment", "change_management_policy"],
  },
  {
    controlId: "CC4.1",
    category: "CC4",
    categoryTitle: CATEGORY_TITLES.CC4,
    title: "Ongoing and separate evaluations",
    paraphrase:
      "The organization selects, develops, and performs ongoing and/or separate evaluations to ascertain whether the components of internal control are present and functioning.",
    pointsOfFocus: [
      "Continuous monitoring is in place for key controls.",
      "Periodic assessments (e.g. pen tests) evaluate the control set.",
    ],
    satisfyingArtifactTypes: ["pentest_report", "config_rule_evaluation", "internal_audit_report"],
  },
  {
    controlId: "CC4.2",
    category: "CC4",
    categoryTitle: CATEGORY_TITLES.CC4,
    title: "Communicating deficiencies",
    paraphrase:
      "The organization evaluates and communicates internal control deficiencies in a timely manner to those responsible for taking corrective action.",
    pointsOfFocus: [
      "Findings are tracked to remediation.",
      "Deficiencies are reported to management.",
    ],
    satisfyingArtifactTypes: ["pentest_report", "remediation_tracker", "internal_audit_report"],
  },
  {
    controlId: "CC5.1",
    category: "CC5",
    categoryTitle: CATEGORY_TITLES.CC5,
    title: "Control activities that mitigate risk",
    paraphrase:
      "The organization selects and develops control activities that contribute to the mitigation of risks to the achievement of objectives to acceptable levels.",
    pointsOfFocus: [
      "Controls are mapped to the risks they mitigate.",
      "A mix of preventive and detective controls is used.",
    ],
    satisfyingArtifactTypes: ["control_matrix", "security_policy_document"],
  },
  {
    controlId: "CC5.2",
    category: "CC5",
    categoryTitle: CATEGORY_TITLES.CC5,
    title: "Technology control activities",
    paraphrase:
      "The organization selects and develops general control activities over technology to support the achievement of objectives.",
    pointsOfFocus: [
      "Access to technology is restricted and reviewed.",
      "Technology configurations are baselined and enforced.",
    ],
    satisfyingArtifactTypes: ["config_rule_evaluation", "iam_policy", "security_group_config"],
  },
  {
    controlId: "CC5.3",
    category: "CC5",
    categoryTitle: CATEGORY_TITLES.CC5,
    title: "Deployment through policies and procedures",
    paraphrase:
      "The organization deploys control activities through policies that establish what is expected and procedures that put policies into action.",
    pointsOfFocus: [
      "Policies are documented and approved.",
      "Procedures translate policy into repeatable action.",
    ],
    satisfyingArtifactTypes: ["security_policy_document", "standard_operating_procedure"],
  },
  {
    controlId: "CC6.1",
    category: "CC6",
    categoryTitle: CATEGORY_TITLES.CC6,
    title: "Logical access security",
    paraphrase:
      "The organization implements logical access security software, infrastructure, and architectures over protected information assets to protect them from security events.",
    pointsOfFocus: [
      "Access requires authenticated, authorized identities.",
      "Encryption protects data at rest and in transit.",
      "Root/privileged accounts are protected with MFA.",
    ],
    satisfyingArtifactTypes: [
      "iam_root_mfa",
      "iam_policy",
      "mfa_configuration",
      "encryption_config",
      "s3_bucket_policy",
    ],
  },
  {
    controlId: "CC6.2",
    category: "CC6",
    categoryTitle: CATEGORY_TITLES.CC6,
    title: "Registration and authorization of access",
    paraphrase:
      "Prior to issuing credentials, the organization registers and authorizes new internal and external users; credentials are removed when access is no longer required.",
    pointsOfFocus: [
      "Access is granted through an approval workflow.",
      "Deprovisioning removes access on termination.",
    ],
    satisfyingArtifactTypes: ["access_request_record", "offboarding_record", "iam_user_inventory"],
  },
  {
    controlId: "CC6.3",
    category: "CC6",
    categoryTitle: CATEGORY_TITLES.CC6,
    title: "Role-based access and least privilege",
    paraphrase:
      "The organization authorizes, modifies, or removes access to data and resources based on roles, responsibilities, and the principle of least privilege.",
    pointsOfFocus: [
      "Access follows least-privilege role definitions.",
      "Periodic access reviews confirm appropriateness.",
    ],
    satisfyingArtifactTypes: ["iam_policy", "access_review", "github_team_membership"],
  },
  {
    controlId: "CC6.4",
    category: "CC6",
    categoryTitle: CATEGORY_TITLES.CC6,
    title: "Physical access restriction",
    paraphrase:
      "The organization restricts physical access to facilities and protected information assets to authorized personnel.",
    pointsOfFocus: [
      "Data-center and office access is restricted and logged.",
      "Cloud hosting shifts physical controls to the provider (inherited).",
    ],
    satisfyingArtifactTypes: ["datacenter_attestation", "soc2_bridge_letter", "facility_access_log"],
  },
  {
    controlId: "CC6.5",
    category: "CC6",
    categoryTitle: CATEGORY_TITLES.CC6,
    title: "Disposal of assets and data",
    paraphrase:
      "The organization discontinues logical and physical protections over assets only after the ability to read or recover data has been removed.",
    pointsOfFocus: [
      "Media and storage are securely wiped before disposal.",
      "Decommissioning follows a documented procedure.",
    ],
    satisfyingArtifactTypes: ["data_disposal_policy", "asset_decommission_record"],
  },
  {
    controlId: "CC6.6",
    category: "CC6",
    categoryTitle: CATEGORY_TITLES.CC6,
    title: "Protection against external threats",
    paraphrase:
      "The organization implements controls to protect against threats from sources outside its system boundaries.",
    pointsOfFocus: [
      "Perimeter controls (firewalls, security groups) restrict ingress.",
      "MFA defends externally reachable authentication.",
      "Threat detection monitors for external attack.",
    ],
    satisfyingArtifactTypes: [
      "iam_root_mfa",
      "mfa_configuration",
      "security_group_config",
      "guardduty_finding",
      "waf_configuration",
    ],
  },
  {
    controlId: "CC6.7",
    category: "CC6",
    categoryTitle: CATEGORY_TITLES.CC6,
    title: "Restriction of information in transit",
    paraphrase:
      "The organization restricts the transmission, movement, and removal of information to authorized users and protects it during transmission.",
    pointsOfFocus: [
      "Data in transit is encrypted (TLS).",
      "Data movement to removable media is restricted.",
    ],
    satisfyingArtifactTypes: ["encryption_config", "tls_configuration", "dlp_policy"],
  },
  {
    controlId: "CC6.8",
    category: "CC6",
    categoryTitle: CATEGORY_TITLES.CC6,
    title: "Prevention of unauthorized software",
    paraphrase:
      "The organization implements controls to prevent or detect and act upon the introduction of unauthorized or malicious software.",
    pointsOfFocus: [
      "Endpoints run anti-malware / integrity monitoring.",
      "Code dependencies are scanned for known vulnerabilities.",
    ],
    satisfyingArtifactTypes: ["endpoint_protection_config", "dependency_scan", "guardduty_finding"],
  },
  {
    controlId: "CC7.1",
    category: "CC7",
    categoryTitle: CATEGORY_TITLES.CC7,
    title: "Detection of configuration changes",
    paraphrase:
      "The organization uses detection and monitoring procedures to identify changes to configurations that introduce new vulnerabilities and susceptibilities to newly discovered threats.",
    pointsOfFocus: [
      "Configuration drift is detected against a baseline.",
      "Vulnerability scanning runs on a defined cadence.",
    ],
    satisfyingArtifactTypes: ["config_rule_evaluation", "vulnerability_scan", "cloudtrail_log"],
  },
  {
    controlId: "CC7.2",
    category: "CC7",
    categoryTitle: CATEGORY_TITLES.CC7,
    title: "Monitoring for anomalies",
    paraphrase:
      "The organization monitors system components and the operation of controls to detect anomalies indicative of malicious acts, natural disasters, and errors.",
    pointsOfFocus: [
      "Security monitoring and alerting are enabled.",
      "Anomalous events generate investigable alerts.",
    ],
    satisfyingArtifactTypes: ["guardduty_finding", "cloudtrail_log", "siem_alert_config"],
  },
  {
    controlId: "CC7.3",
    category: "CC7",
    categoryTitle: CATEGORY_TITLES.CC7,
    title: "Evaluation of security events",
    paraphrase:
      "The organization evaluates security events to determine whether they could or did result in a failure to meet objectives, and if so, takes action.",
    pointsOfFocus: [
      "An incident response procedure classifies events.",
      "Events are triaged to determine impact.",
    ],
    satisfyingArtifactTypes: ["incident_response_policy", "incident_record"],
  },
  {
    controlId: "CC7.4",
    category: "CC7",
    categoryTitle: CATEGORY_TITLES.CC7,
    title: "Incident response program",
    paraphrase:
      "The organization responds to identified security incidents by executing a defined program to understand, contain, remediate, and communicate them.",
    pointsOfFocus: [
      "An incident response plan assigns roles and steps.",
      "Post-incident reviews capture lessons learned.",
    ],
    satisfyingArtifactTypes: ["incident_response_policy", "incident_record", "postmortem"],
  },
  {
    controlId: "CC7.5",
    category: "CC7",
    categoryTitle: CATEGORY_TITLES.CC7,
    title: "Recovery from incidents",
    paraphrase:
      "The organization identifies, develops, and implements activities to recover from identified security incidents and restore affected systems.",
    pointsOfFocus: [
      "Backups are configured and tested.",
      "A business-continuity / disaster-recovery plan exists.",
    ],
    satisfyingArtifactTypes: ["backup_configuration", "disaster_recovery_plan", "bcp_test_report"],
  },
  {
    controlId: "CC8.1",
    category: "CC8",
    categoryTitle: CATEGORY_TITLES.CC8,
    title: "Change management",
    paraphrase:
      "The organization authorizes, designs, develops, tests, approves, and implements changes to infrastructure, data, software, and procedures to meet its objectives.",
    pointsOfFocus: [
      "Changes follow a documented approval workflow.",
      "Code changes are peer-reviewed before merge.",
      "Branch protection enforces review and checks.",
    ],
    satisfyingArtifactTypes: [
      "change_management_policy",
      "github_branch_protection",
      "pull_request_review_record",
      "ci_pipeline_config",
    ],
  },
  {
    controlId: "CC9.1",
    category: "CC9",
    categoryTitle: CATEGORY_TITLES.CC9,
    title: "Risk mitigation for business disruptions",
    paraphrase:
      "The organization identifies, selects, and develops risk mitigation activities for risks arising from potential business disruptions.",
    pointsOfFocus: [
      "Insurance and continuity measures address disruption risk.",
      "Mitigations are tied to assessed risks.",
    ],
    satisfyingArtifactTypes: ["business_continuity_plan", "insurance_policy", "risk_assessment"],
  },
  {
    controlId: "CC9.2",
    category: "CC9",
    categoryTitle: CATEGORY_TITLES.CC9,
    title: "Vendor and business partner risk",
    paraphrase:
      "The organization assesses and manages risks associated with vendors and business partners that have access to the system or its data.",
    pointsOfFocus: [
      "Vendors are inventoried and risk-rated.",
      "Vendor security attestations are collected and reviewed.",
    ],
    satisfyingArtifactTypes: ["vendor_inventory", "vendor_soc2_report", "dpa_agreement"],
  },
];

/** Deterministic pass-1 rules: artifact signal -> proposed criteria. */
export const DEFAULT_MAPPING_RULES: readonly MappingRuleSeed[] = [
  {
    ruleKey: "iam_root_mfa",
    artifactType: "iam_root_mfa",
    matchKeywords: ["root", "mfa"],
    controlIds: ["CC6.1", "CC6.6"],
    confidence: 0.98,
    rationale:
      "Root-account MFA is a canonical logical-access protection (CC6.1) and an external-threat defense (CC6.6).",
  },
  {
    ruleKey: "mfa_configuration",
    artifactType: "mfa_configuration",
    matchKeywords: ["mfa", "multi-factor"],
    controlIds: ["CC6.1", "CC6.6"],
    confidence: 0.92,
    rationale: "MFA enforcement evidences authenticated access (CC6.1) and external-threat defense (CC6.6).",
  },
  {
    ruleKey: "iam_policy_least_privilege",
    artifactType: "iam_policy",
    matchKeywords: ["iam", "policy", "least privilege"],
    controlIds: ["CC6.1", "CC6.3", "CC5.2"],
    confidence: 0.85,
    rationale: "IAM policies evidence logical access (CC6.1), least-privilege role assignment (CC6.3), and technology controls (CC5.2).",
  },
  {
    ruleKey: "access_review",
    artifactType: "access_review",
    matchKeywords: ["access review", "entitlement"],
    controlIds: ["CC6.2", "CC6.3"],
    confidence: 0.9,
    rationale: "Periodic access reviews evidence authorization (CC6.2) and least-privilege maintenance (CC6.3).",
  },
  {
    ruleKey: "encryption_config",
    artifactType: "encryption_config",
    matchKeywords: ["encryption", "kms", "at rest", "in transit"],
    controlIds: ["CC6.1", "CC6.7"],
    confidence: 0.9,
    rationale: "Encryption configuration protects assets (CC6.1) and information in transit (CC6.7).",
  },
  {
    ruleKey: "security_group_config",
    artifactType: "security_group_config",
    matchKeywords: ["security group", "firewall", "ingress"],
    controlIds: ["CC6.6"],
    confidence: 0.88,
    rationale: "Network security groups restrict external ingress, mitigating outside threats (CC6.6).",
  },
  {
    ruleKey: "guardduty_finding",
    artifactType: "guardduty_finding",
    matchKeywords: ["guardduty", "threat", "detection"],
    controlIds: ["CC7.2", "CC6.6", "CC6.8"],
    confidence: 0.86,
    rationale: "GuardDuty detection evidences anomaly monitoring (CC7.2), external-threat (CC6.6) and malicious-software (CC6.8) defenses.",
  },
  {
    ruleKey: "cloudtrail_log",
    artifactType: "cloudtrail_log",
    matchKeywords: ["cloudtrail", "audit log", "api activity"],
    controlIds: ["CC7.1", "CC7.2"],
    confidence: 0.84,
    rationale: "CloudTrail logging evidences configuration-change detection (CC7.1) and anomaly monitoring (CC7.2).",
  },
  {
    ruleKey: "config_rule_evaluation",
    artifactType: "config_rule_evaluation",
    matchKeywords: ["aws config", "config rule", "compliance"],
    controlIds: ["CC7.1", "CC5.2"],
    confidence: 0.85,
    rationale: "AWS Config rule evaluations evidence drift detection (CC7.1) and technology control activities (CC5.2).",
  },
  {
    ruleKey: "github_branch_protection",
    artifactType: "github_branch_protection",
    matchKeywords: ["branch protection", "required review", "github"],
    controlIds: ["CC8.1"],
    confidence: 0.95,
    rationale: "Branch protection enforcing review is a direct change-management control (CC8.1).",
  },
  {
    ruleKey: "pull_request_review_record",
    artifactType: "pull_request_review_record",
    matchKeywords: ["pull request", "code review", "approval"],
    controlIds: ["CC8.1"],
    confidence: 0.9,
    rationale: "Peer-reviewed pull requests evidence change authorization and testing (CC8.1).",
  },
  {
    ruleKey: "backup_configuration",
    artifactType: "backup_configuration",
    matchKeywords: ["backup", "snapshot", "retention"],
    controlIds: ["CC7.5"],
    confidence: 0.88,
    rationale: "Configured, tested backups evidence recovery capability (CC7.5).",
  },
  {
    ruleKey: "pentest_report",
    artifactType: "pentest_report",
    matchKeywords: ["penetration test", "pentest", "findings"],
    controlIds: ["CC4.1", "CC4.2"],
    confidence: 0.9,
    rationale: "A penetration test is a separate evaluation (CC4.1) whose findings are communicated for remediation (CC4.2).",
  },
  {
    ruleKey: "incident_response_policy",
    artifactType: "incident_response_policy",
    matchKeywords: ["incident response", "incident plan"],
    controlIds: ["CC7.3", "CC7.4"],
    confidence: 0.9,
    rationale: "An incident response policy evidences event evaluation (CC7.3) and the response program (CC7.4).",
  },
  {
    ruleKey: "vendor_soc2_report",
    artifactType: "vendor_soc2_report",
    matchKeywords: ["vendor", "soc 2", "subservice"],
    controlIds: ["CC9.2"],
    confidence: 0.92,
    rationale: "A vendor SOC 2 report evidences vendor risk management (CC9.2).",
  },
  {
    ruleKey: "security_policy_document",
    artifactType: "security_policy_document",
    matchKeywords: ["information security policy", "security policy"],
    controlIds: ["CC5.3", "CC2.2"],
    confidence: 0.8,
    rationale: "A published security policy evidences deployment through policy (CC5.3) and internal communication (CC2.2).",
  },
];

const UPSERT_CONTROL_SQL = `
  INSERT INTO soc2_controls
    (control_id, category, category_title, title, paraphrase,
     points_of_focus, satisfying_artifact_types, sort_order, updated_at)
  VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, now())
  ON CONFLICT (control_id) DO UPDATE SET
    category = EXCLUDED.category,
    category_title = EXCLUDED.category_title,
    title = EXCLUDED.title,
    paraphrase = EXCLUDED.paraphrase,
    points_of_focus = EXCLUDED.points_of_focus,
    satisfying_artifact_types = EXCLUDED.satisfying_artifact_types,
    sort_order = EXCLUDED.sort_order,
    updated_at = now()
`;

const UPSERT_RULE_SQL = `
  INSERT INTO soc2_mapping_rules
    (rule_key, artifact_type, match_keywords, control_ids, confidence, rationale)
  VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6)
  ON CONFLICT (rule_key) DO UPDATE SET
    artifact_type = EXCLUDED.artifact_type,
    match_keywords = EXCLUDED.match_keywords,
    control_ids = EXCLUDED.control_ids,
    confidence = EXCLUDED.confidence,
    rationale = EXCLUDED.rationale
`;

/**
 * Idempotently seed the control library and default mapping rules.
 *
 * Safe to call on every request (upserts). Returns the counts written so the
 * caller can log/telemeter the seed.
 */
export async function seedControlLibrary(
  db: SqlClient,
): Promise<{ controls: number; rules: number }> {
  for (const [index, c] of SECURITY_TSC_CONTROLS.entries()) {
    await db.execute(
      UPSERT_CONTROL_SQL,
      c.controlId,
      c.category,
      c.categoryTitle,
      c.title,
      c.paraphrase,
      JSON.stringify(c.pointsOfFocus),
      JSON.stringify(c.satisfyingArtifactTypes),
      index,
    );
  }

  for (const r of DEFAULT_MAPPING_RULES) {
    await db.execute(
      UPSERT_RULE_SQL,
      r.ruleKey,
      r.artifactType,
      JSON.stringify(r.matchKeywords),
      JSON.stringify(r.controlIds),
      r.confidence,
      r.rationale,
    );
  }

  return { controls: SECURITY_TSC_CONTROLS.length, rules: DEFAULT_MAPPING_RULES.length };
}

/** True once at least one control row exists (cheap guard before re-seeding). */
export async function controlLibraryIsSeeded(db: SqlClient): Promise<boolean> {
  const rows = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM soc2_controls`,
  );
  return (rows[0]?.n ?? 0) >= SECURITY_TSC_CONTROLS.length;
}

/** The full set of valid control IDs — used to constrain model output. */
export function allControlIds(): string[] {
  return SECURITY_TSC_CONTROLS.map((c) => c.controlId);
}
