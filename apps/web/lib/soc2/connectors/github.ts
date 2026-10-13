import crypto from "crypto";
import { Pool } from "pg";

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

function getPool(): Pool {
  const url: string | undefined = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }
  return new Pool({ connectionString: url });
}

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
  const pool = getPool();
  const result = await pool.query<GithubInstallationRow>(
    `SELECT org_id, installation_id, account_login, account_type, status, config, last_error
     FROM soc2_connector_installations
     WHERE org_id = $1 AND provider = 'github'
     LIMIT 1`,
    [orgId],
  );
  await pool.end();
  return result.rows[0] ?? null;
}

export async function listGithubRepositories(orgId: string): Promise<GithubRepositoryRow[]> {
  const pool = getPool();
  const result = await pool.query<GithubRepositoryRow>(
    `SELECT repository_id, repository_name, full_name, default_branch, branch_protected, is_selected
     FROM soc2_connector_repositories
     WHERE org_id = $1 AND provider = 'github'
     ORDER BY repository_name ASC`,
    [orgId],
  );
  await pool.end();
  return result.rows;
}

type RepoApi = {
  id: number;
  name: string;
  full_name: string;
  default_branch: string;
  archived: boolean;
  private: boolean;
};

type BranchApi = {
  protected: boolean;
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

export async function syncGithubEvidence(orgId: string, startedBy: string | null): Promise<void> {
  const pool = getPool();
  const runInsert = await pool.query<{ id: string }>(
    `INSERT INTO soc2_sync_runs (org_id, provider, run_type, status, started_by)
     VALUES ($1, 'github', 'manual', 'running', $2)
     RETURNING id`,
    [orgId, startedBy],
  );

  const runId = runInsert.rows[0]?.id;
  try {
    const installation = await pool.query<GithubInstallationRow>(
      `SELECT org_id, installation_id, account_login, account_type, status, config, last_error
       FROM soc2_connector_installations
       WHERE org_id = $1 AND provider = 'github'
       LIMIT 1`,
      [orgId],
    );

    const row = installation.rows[0];
    if (!row?.installation_id) {
      throw new Error("GitHub App not installed for this organization");
    }

    const token = await createInstallationToken(row.installation_id);

    const repos = await githubRequest<RepoApi[]>("https://api.github.com/installation/repositories?per_page=100", token).then(
      (x: any) => x.repositories ?? [],
    );

    let artifactsWritten = 0;

    for (const repo of repos) {
      const branch = await githubRequest<BranchApi>(
        `https://api.github.com/repos/${repo.full_name}/branches/${repo.default_branch}`,
        token,
      );

      await pool.query(
        `INSERT INTO soc2_connector_repositories
         (org_id, provider, installation_id, repository_id, repository_name, full_name, default_branch, is_archived, private, branch_protected, last_synced_at)
         VALUES ($1, 'github', $2, $3, $4, $5, $6, $7, $8, $9, now())
         ON CONFLICT (org_id, provider, repository_id)
         DO UPDATE SET
           repository_name = EXCLUDED.repository_name,
           full_name = EXCLUDED.full_name,
           default_branch = EXCLUDED.default_branch,
           is_archived = EXCLUDED.is_archived,
           private = EXCLUDED.private,
           branch_protected = EXCLUDED.branch_protected,
           last_synced_at = now(),
           updated_at = now()`,
        [orgId, row.installation_id, String(repo.id), repo.name, repo.full_name, repo.default_branch, repo.archived, repo.private, branch.protected],
      );

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

        await pool.query(
          `INSERT INTO soc2_evidence_artifacts (org_id, source, artifact_type, title, summary, detail)
           VALUES ($1, 'github', 'github_pull_request_workflow', $2, $3, $4::jsonb)`,
          [
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
          ],
        );
        artifactsWritten += 1;
      }
    }

    await pool.query(
      `UPDATE soc2_sync_runs
       SET status = 'success',
           artifacts_written = $2,
           repositories_scanned = $3,
           finished_at = now()
       WHERE id = $1`,
      [runId, artifactsWritten, repos.length],
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown GitHub sync error";
    await pool.query(
      `UPDATE soc2_sync_runs
       SET status = 'failed', error = $2, finished_at = now()
       WHERE id = $1`,
      [runId, message],
    );
    throw error;
  } finally {
    await pool.end();
  }
}
