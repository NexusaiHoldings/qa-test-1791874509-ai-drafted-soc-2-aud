import { getServerSession } from "@nexus/identity-and-access";
import { redirect } from "next/navigation";
import { getGithubInstallation, listGithubRepositories } from "@/lib/soc2/connectors/github";

export default async function GithubConnectorPage(): Promise<JSX.Element> {
  const session = await getServerSession();
  const orgId = (session as { orgId?: string } | null)?.orgId;

  if (!session || !orgId) {
    redirect("/api/auth/login");
  }

  const installation = await getGithubInstallation(orgId);
  const repos = await listGithubRepositories(orgId);
  const appName = process.env.GITHUB_APP_SLUG ?? "Nexus GitHub App";
  const installUrl = process.env.GITHUB_APP_INSTALL_URL ?? "https://github.com/apps";

  return (
    <main>
      <h1>GitHub connector</h1>
      <p>Connect a read-only GitHub App to collect CC6/CC8 evidence from PR workflows and branch protections.</p>

      <p>
        <a className="btn" href={installUrl} target="_blank" rel="noreferrer">
          Install the Nexus GitHub App
        </a>
      </p>

      <section className="card">
        <h2>Permissions (read-only)</h2>
        <table>
          <thead>
            <tr>
              <th>Scope</th>
              <th>Access</th>
              <th>Why we need it</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Members</td>
              <td>Read</td>
              <td>Capture org member 2FA enforcement state for CC6 access controls.</td>
            </tr>
            <tr>
              <td>Administration</td>
              <td>Read</td>
              <td>Read default branch protection settings and detect weakening changes.</td>
            </tr>
            <tr>
              <td>Contents</td>
              <td>Read</td>
              <td>Verify CODEOWNERS file presence on default branches.</td>
            </tr>
            <tr>
              <td>Pull requests</td>
              <td>Read</td>
              <td>Sample merged PRs with reviewer approvals and timestamps (change-management evidence).</td>
            </tr>
            <tr>
              <td>Security events</td>
              <td>Read</td>
              <td>Record secret scanning / Dependabot security posture signals.</td>
            </tr>
          </tbody>
        </table>
      </section>

      {!installation || installation.status === "not_installed" ? (
        <section className="empty">
          <h3>Not installed yet</h3>
          <p className="muted">
            Install <strong>{appName}</strong> on your organization account (not a personal account), then return to select repositories.
          </p>
          <p>Flow: open PR → request review → approval timestamp → merge to protected default branch.</p>
        </section>
      ) : installation.last_error ? (
        <section className="card">
          <h3>GitHub API error</h3>
          <p className="muted">{installation.last_error}</p>
          <p>
            Installed as: <strong>{installation.account_login ?? "unknown"}</strong> ({installation.account_type ?? "unknown"})
          </p>
          {installation.account_type?.toLowerCase() === "user" ? (
            <p className="muted">Most common fix: reinstall the app on your organization instead of a user account.</p>
          ) : null}
        </section>
      ) : repos.length === 0 ? (
        <section className="empty">
          <p>No repositories discovered yet. Run an initial sync after installation.</p>
        </section>
      ) : (
        <section className="card">
          <h2>Repository picker</h2>
          <table>
            <thead>
              <tr>
                <th>Repository</th>
                <th>Default branch</th>
                <th>Protection</th>
                <th>Selected</th>
              </tr>
            </thead>
            <tbody>
              {repos.map((repo) => (
                <tr key={repo.repository_id}>
                  <td>{repo.full_name}</td>
                  <td>{repo.default_branch ?? "—"}</td>
                  <td>{repo.branch_protected ? "Protected" : "Unprotected"}</td>
                  <td>{repo.is_selected ? "Yes" : "No"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}
