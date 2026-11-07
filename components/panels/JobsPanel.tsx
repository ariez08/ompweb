"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useI18n } from "@/lib/i18n";
import type { BackgroundJob } from "@/lib/background-jobs";
import { listBackgroundJobs, requestBackgroundJob } from "@/lib/workbench-client";

const actionStyle: CSSProperties = { padding: "4px 7px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", fontSize: 11, cursor: "pointer" };

export function JobsPanel({ jobs, sessionId, error, connected, revision, onNavigateSource }: { jobs: BackgroundJob[] | null; sessionId: string | null; error: string | null; connected: boolean; revision: number; onNavigateSource?: (toolCallId: string) => boolean }) {
  const { t } = useI18n();
  const [trusted, setTrusted] = useState<Record<string, { toolCallId: string; state: string }>>({});
  const [trustedVersion, setTrustedVersion] = useState<{ sessionId: string; revision: number } | null>(null);
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  useEffect(() => {
    setTrusted({});
    setFeedback({});
    setBusy({});
  }, [sessionId]);
  useEffect(() => {
    setTrusted({});
    if (!sessionId || !connected) return;
    let active = true;
    void listBackgroundJobs(sessionId).then(({ jobs: observed }) => {
      if (!active) return;
      const next: Record<string, { toolCallId: string; state: string }> = {};
      for (const item of observed) next[item.id] = { toolCallId: item.toolCallId, state: item.state };
      setTrusted(next);
      setTrustedVersion({ sessionId, revision });
      setFeedback((previous) => {
        if (!previous.__general) return previous;
        const { __general: _ignored, ...rest } = previous;
        return rest;
      });
    }).catch(() => {
      if (!active) return;
      setTrusted({});
      setFeedback((previous) => ({ ...previous, __general: "Unable to verify background jobs." }));
    });
    return () => { active = false; };
  }, [sessionId, connected, revision]);
  const snapshotCurrent = connected && trustedVersion?.sessionId === sessionId && trustedVersion.revision === revision;
  const request = async (job: BackgroundJob, action: "inspect" | "stop") => {
    const match = trusted[job.id];
    if (!snapshotCurrent || !match || match.toolCallId !== job.toolCallId || (action === "stop" && match.state !== "running")) {
      setFeedback((previous) => ({ ...previous, [job.toolCallId]: "This job is no longer verifiable." }));
      return;
    }
    if (action === "stop" && !window.confirm(`Ask the agent to stop job ${job.id} (${job.toolCallId})?\n\n${job.command.slice(0, 160)}`)) return;
    setBusy((previous) => ({ ...previous, [job.toolCallId]: true }));
    try {
      await requestBackgroundJob(sessionId!, job.id, job.toolCallId, action);
      if (sessionRef.current !== sessionId) return;
      setFeedback((previous) => ({ ...previous, [job.toolCallId]: action === "stop" ? "Stop request sent; execution is not confirmed." : "Status request sent to the agent." }));
    } catch (requestError) {
      if (sessionRef.current === sessionId) setFeedback((previous) => ({ ...previous, [job.toolCallId]: requestError instanceof Error ? requestError.message : "Request failed." }));
    } finally {
      if (sessionRef.current === sessionId) setBusy((previous) => ({ ...previous, [job.toolCallId]: false }));
    }
  };
  if (!sessionId) return <div style={{ padding: 16, color: "var(--text-muted)" }}>{t("rightWorkbench.jobsSelectSession")}</div>;
  if (error) return <div role="alert" style={{ padding: 16, color: "var(--text-muted)" }}>{t("rightWorkbench.jobsError")}: {error}</div>;
  if (jobs === null) return <div role="status" style={{ padding: 16, color: "var(--text-muted)" }}>{t("rightWorkbench.jobsLoading")}</div>;
  if (jobs.length === 0) return <div style={{ padding: 16, color: "var(--text-muted)" }}>{t("rightWorkbench.jobsEmpty")}</div>;
  return <div style={{ height: "100%", overflowY: "auto", padding: 12 }}>
    {feedback.__general && <div role="alert" style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 8 }}>{feedback.__general}</div>}
    {jobs.map((job) => {
      const verified = snapshotCurrent && trusted[job.id]?.toolCallId === job.toolCallId;
      const status = verified && trusted[job.id].state !== "running" ? trusted[job.id].state : job.status;
      return <section key={job.toolCallId} style={{ borderBottom: "1px solid var(--border)", padding: "10px 4px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
          <strong style={{ color: "var(--text)", fontSize: 12 }}>{job.type} · {job.id}</strong>
          <span style={{ color: "var(--text-muted)", fontSize: 11, flexShrink: 0 }}>{t(`rightWorkbench.jobStatus.${status}`)}</span>
        </div>
        {job.command && <pre style={{ color: "var(--text)", fontSize: 12, marginTop: 6, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "inherit" }}>{job.command}</pre>}
        {status === "unknown" && <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 5 }}>{t("rightWorkbench.jobsUnconfirmed")}</div>}
        {job.output && <pre style={{ color: "var(--text-muted)", fontSize: 11, whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: "8px 0 0" }}>{job.output}</pre>}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
          <button type="button" style={actionStyle} disabled={!verified || busy[job.toolCallId]} onClick={() => request(job, "inspect")}>Ask agent for output</button>
          {verified && trusted[job.id].state === "running" && (status === "unknown" || status === "running") && <button type="button" style={actionStyle} disabled={busy[job.toolCallId]} onClick={() => request(job, "stop")}>Ask agent to stop</button>}
          <button type="button" style={actionStyle} onClick={async () => {
            try {
              await navigator.clipboard.writeText(job.command);
              if (sessionRef.current === sessionId) setFeedback((previous) => ({ ...previous, [job.toolCallId]: "Command copied." }));
            } catch {
              if (sessionRef.current === sessionId) setFeedback((previous) => ({ ...previous, [job.toolCallId]: "Unable to copy command." }));
            }
          }} disabled={!job.command}>Copy command</button>
          <button type="button" style={actionStyle} disabled={!onNavigateSource} onClick={() => {
            if (!onNavigateSource?.(job.toolCallId)) setFeedback((previous) => ({ ...previous, [job.toolCallId]: "Source message is unavailable in this session." }));
          }}>Open source</button>
        </div>
        {feedback[job.toolCallId] && !(status !== "unknown" && status !== "running" && feedback[job.toolCallId] === "Stop request sent; execution is not confirmed.") && <div role="status" style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 5 }}>{feedback[job.toolCallId]}</div>}
      </section>;
    })}
  </div>;
}
