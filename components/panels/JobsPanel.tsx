"use client";

import { useI18n } from "@/lib/i18n";
import type { BackgroundJob } from "@/lib/background-jobs";

export function JobsPanel({ jobs, sessionId, error }: { jobs: BackgroundJob[] | null; sessionId: string | null; error: string | null }) {
  const { t } = useI18n();
  if (!sessionId) return <div style={{ padding: 16, color: "var(--text-muted)" }}>{t("rightWorkbench.jobsSelectSession")}</div>;
  if (error) return <div role="alert" style={{ padding: 16, color: "var(--text-muted)" }}>{t("rightWorkbench.jobsError")}: {error}</div>;
  if (jobs === null) return <div role="status" style={{ padding: 16, color: "var(--text-muted)" }}>{t("rightWorkbench.jobsLoading")}</div>;
  if (jobs.length === 0) return <div style={{ padding: 16, color: "var(--text-muted)" }}>{t("rightWorkbench.jobsEmpty")}</div>;

  return <div style={{ height: "100%", overflowY: "auto", padding: 12 }}>
    {jobs.map((job) => <section key={job.id} style={{ borderBottom: "1px solid var(--border)", padding: "10px 4px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
        <strong style={{ color: "var(--text)", fontSize: 12 }}>{job.type} · {job.id}</strong>
        <span style={{ color: "var(--text-muted)", fontSize: 11, flexShrink: 0 }}>{t(`rightWorkbench.jobStatus.${job.status}`)}</span>
      </div>
      {job.command && <div style={{ color: "var(--text)", fontSize: 12, marginTop: 6, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{job.command}</div>}
      {job.status === "unknown" && <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 5 }}>{t("rightWorkbench.jobsUnconfirmed")}</div>}
      {job.output && <pre style={{ color: "var(--text-muted)", fontSize: 11, whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: "8px 0 0" }}>{job.output}</pre>}
    </section>)}
  </div>;
}
