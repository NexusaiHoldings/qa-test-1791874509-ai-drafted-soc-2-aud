import Link from "next/link";
import { buildPackageSnapshot } from "@/lib/soc2/package/assembler";

export default async function Soc2PackagePage(): Promise<JSX.Element> {
  const snapshot = buildPackageSnapshot({
    policiesInScope: 1,
    approvedPolicies: [],
    evidenceIndex: [],
    traceabilityRows: [],
    disclaimersAcknowledged: false,
    previous: [],
  });

  const noPoliciesYet = snapshot.policies.length === 0;

  return (
    <main>
      <h1>SOC 2 audit package</h1>
      <p>
        Export the board-ready and CPA-ready evidence package with approved policies, traceable
        claims, and a signed manifest hash.
      </p>

      <section className="card">
        <h2>Readiness checklist</h2>
        <ul>
          {snapshot.gates.map((gate) => (
            <li key={gate.key} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <span>
                <strong>{gate.label}</strong> — <span className="muted">{gate.reason}</span>{" "}
                <Link href={gate.fixHref}>Fix</Link>
              </span>
              <span aria-label={gate.pass ? "pass" : "fail"}>{gate.pass ? "PASS" : "FAIL"}</span>
            </li>
          ))}
        </ul>

        <form action="#" style={{ marginTop: 12 }}>
          <button type="button" disabled={!snapshot.canExport} title={snapshot.exportDisabledReason ?? ""}>
            Export package
          </button>
          {!snapshot.canExport && snapshot.exportDisabledReason ? (
            <p className="muted">{snapshot.exportDisabledReason}</p>
          ) : null}
        </form>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>Evidence index preview</h2>
        {snapshot.evidenceIndex.length === 0 ? (
          <div className="empty">
            <p>No evidence indexed yet.</p>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Criterion</th>
                <th>Artifact</th>
                <th>Collected</th>
                <th>Hash</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.evidenceIndex.map((row) => (
                <tr key={`${row.controlId}-${row.artifactId}`}>
                  <td>{row.controlId}</td>
                  <td>{row.artifactTitle}</td>
                  <td>{new Date(row.collectedAt).toLocaleDateString()}</td>
                  <td>{row.contentHash ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={{ marginTop: 16 }}>
        <h2>Previous exports</h2>
        {snapshot.previous.length === 0 ? (
          <div className="empty">
            {noPoliciesYet ? (
              <>
                <p>📚</p>
                <p>Approve your first policy to start assembling the package.</p>
              </>
            ) : (
              <p>No exports yet.</p>
            )}
          </div>
        ) : (
          snapshot.previous.map((item) => (
            <article key={item.id} className="card">
              <h3>{new Date(item.createdAt).toLocaleString()}</h3>
              <p className="muted">Manifest hash: {item.manifestHash}</p>
              {item.signedUrl ? (
                <p>
                  <a className="btn secondary" href={item.signedUrl}>
                    Download
                  </a>
                </p>
              ) : (
                <p className="muted">Download link pending</p>
              )}
            </article>
          ))
        )}
      </section>
    </main>
  );
}
