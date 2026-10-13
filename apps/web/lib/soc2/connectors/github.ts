import crypto from "node:crypto";

type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

type RepoRow = {
  id: string;
  repository_id: string;
  repository_name: string;
  full_name: string;
  default_branch: string | null;
  branch_protected: boolean;
  is_selected: boolean;
};

export type GithubConnectorState = {
  installed: boolean;
  installationId: string | null;
  accountLogin: string | null;
  accountType: string | null;
  appInstallUrl: string;
  appSlug: string;
  appId: string;
  appInstalledOnOrganization: boolean;
  lastError: string | null;
};

export type GithubRepositoryView = {
  id: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  protected: boolean;
  selected: boolean;
};

export type GithubConnectorsPageData = {
  state: GithubConnectorState;
  repositories: GithubRepositoryView[];
  error: string | null;
};

type PoolLike = {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

let _pool: PoolLike | null = null;

async function getPool(): Promise<PoolLike> {
  if (_pool) return _pool;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const req = eval("require") as NodeRequire;
  const { Pool } = req("pg") as { Pool: new (cfg: { connectionString?: string }) => PoolLike };
  _pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return _pool;
}

function mustEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function getGithubConfig(): { appId: string; clientId: string; clientSecret: string; privateKey: string; webhookSecret: string; appSlug: string } {
  return {
    appId: mustEnv("GITHUB_APP_ID"),
    clientId: mustEnv("GITHUB_APP_CLIENT_ID"),
    clientSecret: mustEnv("GITHUB_APP_CLIENT_SECRET"),
    privateKey: mustEnv("GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n"),
    webhookSecret: mustEnv("GITHUB_WEBHOOK_SECRET"),
    appSlug: process.env.GITHUB_APP_SLUG || "nexus-soc2",
  };
}

function base64Url(input: Buffer): string {
  return input.toString("base64url");
}

function signJwt(payload: Record<string, unknown>, privateKey: string): string {
  const header = { alg: "RS256", typ: "JWT" };
  const h = base64Url(Buffer.from(JSON.stringify(header)));
  const p = base64Url(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${h}.${p}`;
  const sig = crypto.createSign("RSA-SHA256").update(signingInput).sign(privateKey);
  return `${signingInput}.${base64Url(sig)}`;
}

async function githubApi<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "nexus-soc2",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status}: ${body}`);
  }
  return (await res.json()) as T;
}

export async function verifyGithubWebhookSignature(rawBody: string, signatureHeader: string | null): Promise<boolean> {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const secret = getGithubConfig().webhookSecret;
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
}

export async function getAppJwt(): Promise<string> {
  const cfg = getGithubConfig();
  const now = Math.floor(Date.now() / 1000);
  return signJwt(
    {
      iat: now - 30,
      exp: now + 540,
      iss: cfg.appId,
    },
    cfg.privateKey
  );
}

export async function getInstallationToken(installationId: string): Promise<string> {
  const jwt = await getAppJwt();
  const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "nexus-soc2",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Unable to create installation token ${res.status}: ${body}`);
  }
  const json = (await res.json()) as { token: string };
  return json.token;
}

export async function getGithubConnectorPageData(orgId: string): Promise<GithubConnectorsPageData> {
  const pool = await getPool();
  const cfg = getGithubConfig();
  const appInstallUrl = `https://github.com/apps/${cfg.appSlug}/installations/new`;
  const install = await pool.query<{
    installation_id: string | null;
    account_login: string | null;
    account_type: string | null;
    status: string;
    last_error: string | null;
  }>(
    `SELECT installation_id, account_login, account_type, status, last_error
       FROM soc2_connector_installations
      WHERE org_id = $1 AND provider = 'github'
      LIMIT 1`,
    [orgId]
  );

  const row = install.rows[0];
  const installed = !!row?.installation_id && row.status !== "not_installed";
  const repos = await pool.query<RepoRow>(
    `SELECT id, repository_id, repository_name, full_name, default_branch, branch_protected, is_selected
       FROM soc2_connector_repositories
      WHERE org_id = $1 AND provider = 'github'
      ORDER BY repository_name ASC`,
    [orgId]
  );

  return {
    state: {
      installed,
      installationId: row?.installation_id ?? null,
      accountLogin: row?.account_login ?? null,
      accountType: row?.account_type ?? null,
      appInstallUrl,
      appSlug: cfg.appSlug,
      appId: cfg.appId,
      appInstalledOnOrganization: (row?.account_type ?? "").toLowerCase() === "organization",
      lastError: row?.last_error ?? null,
    },
    repositories: repos.rows.map((r) => ({
      id: r.id,
      name: r.repository_name,
      fullName: r.full_name,
      defaultBranch: r.default_branch ?? "main",
      protected: r.branch_protected,
      selected: r.is_selected,
    })),
    error: row?.last_error ?? null,
  };
}

export async function setRepositorySelection(orgId: string, repositoryId: string, selected: boolean): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `UPDATE soc2_connector_repositories
        SET is_selected = $3, updated_at = now()
      WHERE org_id = $1 AND id = $2 AND provider = 'github'`,
    [orgId, repositoryId, selected]
  );
}

export async function persistInstallationFromWebhook(payload: Record<string, JsonValue>): Promise<void> {
  const pool = await getPool();
  const installation = payload.installation as Record<string, JsonValue> | undefined;
  const account = (installation?.account || payload.sender) as Record<string, JsonValue> | undefined;
  const installationId = installation?.id ? String(installation.id) : null;
  if (!installationId) return;

  const action = String(payload.action || "unknown");
  const accountLogin = account?.login ? String(account.login) : null;
  const accountType = account?.type ? String(account.type) : null;

  let orgId: string | null = null;
  const existing = await pool.query<{ org_id: string }>(
    `SELECT org_id
       FROM soc2_connector_installations
      WHERE provider = 'github' AND installation_id = $1
      LIMIT 1`,
    [installationId]
  );
  if (existing.rows[0]) orgId = existing.rows[0].org_id;
  if (!orgId) {
    const orgHint = (payload as { org_id?: string }).org_id;
    if (orgHint) orgId = orgHint;
  }
  if (!orgId) return;

  const status = action === "deleted" ? "disconnected" : "installed";
  await pool.query(
    `INSERT INTO soc2_connector_installations
      (org_id, provider, installation_id, account_login, account_type, status, connected_at, disconnected_at, updated_at)
     VALUES ($1, 'github', $2, $3, $4, $5, CASE WHEN $5='installed' THEN now() ELSE NULL END, CASE WHEN $5='disconnected' THEN now() ELSE NULL END, now())
     ON CONFLICT (org_id, provider) DO UPDATE
       SET installation_id = EXCLUDED.installation_id,
           account_login = EXCLUDED.account_login,
           account_type = EXCLUDED.account_type,
           status = EXCLUDED.status,
           connected_at = COALESCE(soc2_connector_installations.connected_at, EXCLUDED.connected_at),
           disconnected_at = EXCLUDED.disconnected_at,
           updated_at = now()`,
    [orgId, installationId, accountLogin, accountType, status]
  );
}

export async function runGithubEvidenceSync(orgId: string, installationId: string, runType: "manual" | "webhook" = "manual"): Promise<void> {
  const pool = await getPool();
  const run = await pool.query<{ id: string }>(
    `INSERT INTO soc2_sync_runs (org_id, provider, run_type, status)
     VALUES ($1, 'github', $2, 'running')
     RETURNING id`,
    [orgId, runType]
  );
  const runId = run.rows[0].id;
  let artifactsWritten = 0;
  let repositoriesScanned = 0;

  try {
    const token = await getInstallationToken(installationId);

    const members = await githubApi<{ total_count: number; members: Array<{ login: string; two_factor_authentication?: boolean }> }>(
      `/orgs/${encodeURIComponent((await getGithubConnectorPageData(orgId)).state.accountLogin || "")}/members?per_page=100`,
      token
    ).catch(() => ({ total_count: 0, members: [] }));

    if (members.members.length > 0) {
      await pool.query(
        `INSERT INTO soc2_evidence_artifacts (org_id, source, artifact_type, title, summary, detail)
         VALUES ($1, 'github', 'github_org_members_2fa', 'GitHub org member 2FA posture', $2, $3::jsonb)`,
        [
          orgId,
          `${members.members.length} org members sampled for 2FA posture`,
          JSON.stringify({
            totalCount: members.total_count,
            sampledMembers: members.members.slice(0, 100),
            collectedAt: new Date().toISOString(),
          }),
        ]
      );
      artifactsWritten += 1;
    }

    const repos = await githubApi<{ repositories: Array<{ id: number; name: string; full_name: string; default_branch: string; private: boolean; archived: boolean }> }>(
      `/installation/repositories?per_page=100`,
      token
    );

    for (const repo of repos.repositories) {
      repositoriesScanned += 1;

      const branch = await githubApi<{ protected: boolean }>(
        `/repos/${encodeURIComponent(repo.full_name)}/branches/${encodeURIComponent(repo.default_branch)}`,
        token
      ).catch(() => ({ protected: false }));

      await pool.query(
        `INSERT INTO soc2_connector_repositories
          (org_id, provider, installation_id, repository_id, repository_name, full_name, default_branch, private, is_archived, branch_protected, metadata, last_synced_at, updated_at)
         VALUES ($1, 'github', $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, now(), now())
         ON CONFLICT (org_id, provider, repository_id) DO UPDATE
           SET repository_name = EXCLUDED.repository_name,
               full_name = EXCLUDED.full_name,
               default_branch = EXCLUDED.default_branch,
               private = EXCLUDED.private,
               is_archived = EXCLUDED.is_archived,
               branch_protected = EXCLUDED.branch_protected,
               metadata = EXCLUDED.metadata,
               last_synced_at = now(),
               updated_at = now()`,
        [
          orgId,
          installationId,
          String(repo.id),
          repo.name,
          repo.full_name,
          repo.default_branch,
          repo.private,
          repo.archived,
          branch.protected,
          JSON.stringify({}),
        ]
      );

      await pool.query(
        `INSERT INTO soc2_evidence_artifacts (org_id, source, artifact_type, title, summary, detail)
         VALUES ($1, 'github', 'github_branch_protection', $2, $3, $4::jsonb)`,
        [
          orgId,
          `Branch protection for ${repo.full_name}`,
          `Default branch ${repo.default_branch} is ${branch.protected ? "protected" : "unprotected"}`,
          JSON.stringify({
            repository: repo.full_name,
            defaultBranch: repo.default_branch,
            protected: branch.protected,
            requiredReviews: null,
            requiredStatusChecks: [],
            forcePushesAllowed: false,
            sampledAt: new Date().toISOString(),
          }),
        ]
      );
      artifactsWritten += 1;
    }

    await pool.query(
      `UPDATE soc2_sync_runs
          SET status = 'completed',
              finished_at = now(),
              artifacts_written = $2,
              repositories_scanned = $3
        WHERE id = $1`,
      [runId, artifactsWritten, repositoriesScanned]
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown GitHub sync error";
    await pool.query(
      `UPDATE soc2_sync_runs
          SET status = 'failed',
              finished_at = now(),
              error = $2
        WHERE id = $1`,
      [runId, message]
    );
    await pool.query(
      `UPDATE soc2_connector_installations
          SET last_error = $2, updated_at = now()
        WHERE org_id = $1 AND provider = 'github'`,
      [orgId, message]
    );
    throw error;
  }
}
