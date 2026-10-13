import crypto from "crypto";
import { buildDb } from "@/lib/db";

export type GithubInstallationRow = {
  org_id: string;
  installation_id: string | null;
  account_login: string | null;
  account_type: string | null;
  status: string;
  config: Record<string, unknown>;
  last_error: string | null;
};

export type GithubRepositoryRow = {
  repository_id: string;
  repository_name: string;
  full_name: string;
  default_branch: string | null;
  branch_protected: boolean;
  is_selected: boolean;
};

type GithubAppTokenResponse = {
  token: string;
  expires_at: string;
  permissions?: Record<string, string>;
};

async function githubRequest<T>(url: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API ${response.status}: ${text}`);
  }
  return (await response.json()) as T;
}

/**
 * Variant of {@link githubRequest} that tolerates "absence" responses.
 * Returns `null` on 404 (resource not configured, e.g. no branch protection
 * or no CODEOWNERS file) and treats 204/304 (used by the vulnerability-alerts
 * endpoint to signal "enabled") as a resolved empty body.
 */
async function githubRequestOptional<T>(
  url: string,
  token: string,
  init?: RequestInit,
): Promise<T | null> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });

  if (response.status === 404 || response.status === 403) {
    return null;
  }
  if (response.status === 204 || response.status === 304) {
    return {} as T;
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API ${response.status}: ${text}`);
  }
  const text = await response.text();
  return text ? ((JSON.parse(text) as T) ?? null) : null;
}

function parsePrivateKey(raw: string): string {
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

function buildJwt(appId: string, privateKey: string): string {
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iat: now - 60, exp: now + 540, iss: appId };

  const encode = (obj: unknown): string =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");

  const body = `${encode(header)}.${encode(payload)}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(body);
  signer.end();
  const sig = signer
    .sign(privateKey, "base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return `${body}.${sig}`;
}

async function createInstallationToken(installationId: string): Promise<string> {
  const appId = process.env.GITHUB_APP_ID;
  const appKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !appKey) {
    throw new Error("GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY is not configured");
  }

  const jwt = buildJwt(appId, parsePrivateKey(appKey));

  const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${jwt}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to create installation token (${res.status}): ${text}`);
  }

  const body = (await res.json()) as GithubAppTokenResponse;
  return body.token;
}

export async function getGithubInstallation(orgId: string): Promise<GithubInstallationRow | null> {
  const db = buildDb();
  const rows = await db.query<GithubInstallationRow>(
    `SELECT org_id, installation_id, account_login, account_type, status, config, last_error
     FROM soc2_connector_installations
     WHERE org_id = $1 AND provider = 'github'
     LIMIT 1`,
    orgId,
  );
  return rows[0] ?? null;
}

export async function listGithubRepositories(orgId: string): Promise<GithubRepositoryRow[]> {
  const db = buildDb();
  const rows = await db.query<GithubRepositoryRow>(
    `SELECT repository_id, repository_name, full_name, default_branch, branch_protected, is_selected
     FROM soc2_connector_repositories
     WHERE org_id = $1 AND provider = 'github'
     ORDER BY repository_name ASC`,
    orgId,
  );
  return rows;
}

type RepoApi = {
  id: number;
  name: string;
  full_name: string;
  default_branch: string;
  archived: boolean;
  private: boolean;
};

type PullApi = {
  number: number;
  title: string;
  merged_at: string | null;
  user: { login: string };
  merged_by: { login: string } | null;
  requested_reviewers: Array<{ login: string }>;
  html_url: string;
};

type ReviewApi = {
  state: string;
  user: { login: string };
  submitted_at: string | null;
};

type OrgApi = {
  login: string;
  two_factor_requirement_enabled: boolean | null;
};

type MemberApi = {
  login: string;
  id: number;
};

type BranchProtectionApi = {
  required_pull_request_reviews?: {
    required_approving_review_count?: number;
    require_code_owner_reviews?: boolean;
    dismiss_stale_reviews?: boolean;
  } | null;
  required_status_checks?: {
    strict?: boolean;
    contexts?: string[];
  } | null;
  allow_force_pushes?: { enabled: boolean } | null;
  allow_deletions?: { enabled: boolean } | null;
  enforce_admins?: { enabled: boolean } | null;
};

type SecurityAndAnalysisApi = {
  security_and_analysis?: {
    secret_scanning?: { status: string };
    secret_scanning_push_protection?: { status: string };
    dependabot_security_updates?: { status: string };
  } | null;
};

/** Normalised change-management posture for a single repository's default branch. */
type BranchProtectionSummary = {
  protected: boolean;
  required_reviews: number;
  require_code_owner_reviews: boolean;
  dismiss_stale_reviews: boolean;
  required_status_checks: string[];
  strict_status_checks: boolean;
  force_push_disabled: boolean;
  deletion_disabled: boolean;
  enforce_admins: boolean;
};

/** Fetch and normalise the default-branch protection rule for CC8 evidence. */
async function fetchBranchProtection(
  fullName: string,
  branch: string,
  token: string,
): Promise<BranchProtectionSummary> {
  const data = await githubRequestOptional<BranchProtectionApi>(
    `https://api.github.com/repos/${fullName}/branches/${encodeURIComponent(branch)}/protection`,
    token,
  );

  if (!data) {
    return {
      protected: false,
      required_reviews: 0,
      require_code_owner_reviews: false,
      dismiss_stale_reviews: false,
      required_status_checks: [],
      strict_status_checks: false,
      force_push_disabled: false,
      deletion_disabled: false,
      enforce_admins: false,
    };
  }

  return {
    protected: true,
    required_reviews: data.required_pull_request_reviews?.required_approving_review_count ?? 0,
    require_code_owner_reviews: data.required_pull_request_reviews?.require_code_owner_reviews ?? false,
    dismiss_stale_reviews: data.required_pull_request_reviews?.dismiss_stale_reviews ?? false,
    required_status_checks: data.required_status_checks?.contexts ?? [],
    strict_status_checks: data.required_status_checks?.strict ?? false,
    force_push_disabled: !(data.allow_force_pushes?.enabled ?? false),
    deletion_disabled: !(data.allow_deletions?.enabled ?? false),
    enforce_admins: data.enforce_admins?.enabled ?? false,
  };
}

/** Detect a CODEOWNERS file in any of the three GitHub-recognised locations. */
async function fetchCodeownersPresence(fullName: string, token: string): Promise<boolean> {
  const paths = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];
  for (const path of paths) {
    const found = await githubRequestOptional<{ name: string }>(
      `https://api.github.com/repos/${fullName}/contents/${path}`,
      token,
    );
    if (found && found.name) {
      return true;
    }
  }
  return false;
}

/** Secret-scanning / Dependabot posture derived from the repo's security_and_analysis block. */
async function fetchSecurityPosture(
  fullName: string,
  token: string,
): Promise<{ secret_scanning: boolean; secret_scanning_push_protection: boolean; dependabot_alerts: boolean }> {
  const repo = await githubRequestOptional<SecurityAndAnalysisApi>(
    `https://api.github.com/repos/${fullName}`,
    token,
  );
  const block = repo?.security_and_analysis ?? null;

  // The vulnerability-alerts endpoint answers 204 when Dependabot alerts are on.
  const alerts = await githubRequestOptional<Record<string, never>>(
    `https://api.github.com/repos/${fullName}/vulnerability-alerts`,
    token,
  );

  return {
    secret_scanning: block?.secret_scanning?.status === "enabled",
    secret_scanning_push_protection: block?.secret_scanning_push_protection?.status === "enabled",
    dependabot_alerts: alerts !== null,
  };
}

export async function syncGithubEvidence(orgId: string, startedBy: string | null): Promise<void> {
  const db = buildDb();
  const runInsert = await db.query<{ id: string }>(
    `INSERT INTO soc2_sync_runs (org_id, provider, run_type, status, started_by)
     VALUES ($1, 'github', 'manual', 'running', $2)
     RETURNING id`,
    orgId,
    startedBy,
  );

  const runId = runInsert[0]?.id;
  try {
    const installation = await db.query<GithubInstallationRow>(
      `SELECT org_id, installation_id, account_login, account_type, status, config, last_error
       FROM soc2_connector_installations
       WHERE org_id = $1 AND provider = 'github'
       LIMIT 1`,
      orgId,
    );

    const row = installation[0];
    if (!row?.installation_id) {
      throw new Error("GitHub App not installed for this organization");
    }

    const token = await createInstallationToken(row.installation_id);

    let artifactsWritten = 0;

    // ── CC6 developer-access evidence: org members + 2FA enforcement state ──
    if (row.account_login && (row.account_type ?? "").toLowerCase() === "organization") {
      try {
        const org = await githubRequest<OrgApi>(`https://api.github.com/orgs/${row.account_login}`, token);
        const members = await githubRequest<MemberApi[]>(
          `https://api.github.com/orgs/${row.account_login}/members?per_page=100`,
          token,
        );
        await db.execute(
          `INSERT INTO soc2_evidence_artifacts (org_id, source, artifact_type, title, summary, detail)
           VALUES ($1, 'github', 'github_org_2fa_enforcement', $2, $3, $4::jsonb)`,
          orgId,
          `GitHub org 2FA enforcement: ${row.account_login}`,
          org.two_factor_requirement_enabled
            ? "Two-factor authentication is required for all organization members."
            : "Two-factor authentication is NOT enforced at the organization level.",
          JSON.stringify({
            org: row.account_login,
            two_factor_requirement_enabled: org.two_factor_requirement_enabled ?? false,
            member_count: members.length,
            members: members.map((m) => m.login),
          }),
        );
        artifactsWritten += 1;
      } catch (memberErr) {
        // Member enumeration requires the "Members: read" scope; a missing scope
        // should not abort the whole sync, only skip this one artifact.
        const detail = memberErr instanceof Error ? memberErr.message : "unknown";
        await db.execute(
          `UPDATE soc2_sync_runs
           SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
           WHERE id = $1`,
          runId,
          JSON.stringify({ members_warning: detail }),
        );
      }
    }

    const repos = await githubRequest<{ repositories?: RepoApi[] }>(
      "https://api.github.com/installation/repositories?per_page=100",
      token,
    ).then((x) => x.repositories ?? []);

    for (const repo of repos) {
      const protection = await fetchBranchProtection(repo.full_name, repo.default_branch, token);
      const codeowners = await fetchCodeownersPresence(repo.full_name, token);
      const security = await fetchSecurityPosture(repo.full_name, token);

      const repoMetadata = {
        protection,
        codeowners_present: codeowners,
        security,
        last_full_sync_at: new Date().toISOString(),
      };

      await db.execute(
        `INSERT INTO soc2_connector_repositories
         (org_id, provider, installation_id, repository_id, repository_name, full_name, default_branch, is_archived, private, branch_protected, metadata, last_synced_at)
         VALUES ($1, 'github', $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, now())
         ON CONFLICT (org_id, provider, repository_id)
         DO UPDATE SET
           repository_name = EXCLUDED.repository_name,
           full_name = EXCLUDED.full_name,
           default_branch = EXCLUDED.default_branch,
           is_archived = EXCLUDED.is_archived,
           private = EXCLUDED.private,
           branch_protected = EXCLUDED.branch_protected,
           metadata = soc2_connector_repositories.metadata || EXCLUDED.metadata,
           last_synced_at = now(),
           updated_at = now()`,
        orgId,
        row.installation_id,
        String(repo.id),
        repo.name,
        repo.full_name,
        repo.default_branch,
        repo.archived,
        repo.private,
        protection.protected,
        JSON.stringify(repoMetadata),
      );

      // ── CC8 change-management evidence: default-branch protection posture ──
      await db.execute(
        `INSERT INTO soc2_evidence_artifacts (org_id, source, artifact_type, title, summary, detail)
         VALUES ($1, 'github', 'github_branch_protection', $2, $3, $4::jsonb)`,
        orgId,
        `Branch protection: ${repo.full_name}@${repo.default_branch}`,
        protection.protected
          ? `Default branch protected — ${protection.required_reviews} required review(s), force-push ${protection.force_push_disabled ? "disabled" : "ALLOWED"}.`
          : "Default branch has NO protection rule configured.",
        JSON.stringify({
          repository: repo.full_name,
          default_branch: repo.default_branch,
          ...protection,
          codeowners_present: codeowners,
          ...security,
        }),
      );
      artifactsWritten += 1;

      const pulls = await githubRequest<PullApi[]>(
        `https://api.github.com/repos/${repo.full_name}/pulls?state=closed&sort=updated&direction=desc&per_page=20`,
        token,
      );

      const merged = pulls.filter((p) => p.merged_at).slice(0, 10);

      for (const pr of merged) {
        const reviews = await githubRequest<ReviewApi[]>(
          `https://api.github.com/repos/${repo.full_name}/pulls/${pr.number}/reviews?per_page=100`,
          token,
        );

        const approvals = reviews
          .filter((r) => r.state === "APPROVED")
          .map((r) => ({ reviewer: r.user.login, approved_at: r.submitted_at }));

        await db.execute(
          `INSERT INTO soc2_evidence_artifacts (org_id, source, artifact_type, title, summary, detail)
           VALUES ($1, 'github', 'github_pull_request_workflow', $2, $3, $4::jsonb)`,
          orgId,
          `Merged PR #${pr.number} in ${repo.full_name}`,
          `PR merged with reviewer approvals for ${repo.name}`,
          JSON.stringify({
            repository: repo.full_name,
            pr_number: pr.number,
            title: pr.title,
            merged_at: pr.merged_at,
            author: pr.user.login,
            merged_by: pr.merged_by?.login ?? null,
            approvals,
            requested_reviewers: pr.requested_reviewers.map((r) => r.login),
            url: pr.html_url,
          }),
        );
        artifactsWritten += 1;
      }
    }

    await db.execute(
      `UPDATE soc2_sync_runs
       SET status = 'success',
           artifacts_written = $2,
           repositories_scanned = $3,
           finished_at = now()
       WHERE id = $1`,
      runId,
      artifactsWritten,
      repos.length,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown GitHub sync error";
    await db.execute(
      `UPDATE soc2_sync_runs
       SET status = 'failed', error = $2, finished_at = now()
       WHERE id = $1`,
      runId,
      message,
    );
    throw error;
  }
}
