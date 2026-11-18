"use client";

import { useEffect, useRef, useState } from "react";
import { FileDiff, Files } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { TurnChangeTurn } from "@/lib/turn-changes";
import { SplitPatchView } from "./MessageView";

export function TurnChangesPanel({ turns, sessionId }: { turns: TurnChangeTurn[]; sessionId: string | null }) {
  const { t } = useI18n();
  const [turnId, setTurnId] = useState<string | null>(null);
  const latestId = turns[turns.length - 1]?.id ?? null;
  const previousLatestRef = useRef(latestId);
  const currentId = turns.find((turn) => turn.id === turnId)?.id ?? latestId;
  const current = turns.find((turn) => turn.id === currentId) ?? null;

  useEffect(() => {
    previousLatestRef.current = latestId;
    setTurnId(latestId);
  }, [sessionId]);
  useEffect(() => {
    const wasFollowingLatest = !turnId || turnId === previousLatestRef.current;
    if (wasFollowingLatest || !turns.some((turn) => turn.id === turnId)) setTurnId(latestId);
    previousLatestRef.current = latestId;
  }, [latestId, sessionId, turnId, turns]);

  return (
    <div style={{ height: "100%", minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ padding: "9px 10px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, color: "var(--text)", fontSize: 12, fontWeight: 650 }}>
          <FileDiff size={14} style={{ color: "var(--accent)" }} aria-hidden="true" />
          {t("rightWorkbench.changes")}
          {turns.length > 0 && <span style={{ color: "var(--text-dim)", font: "10px var(--font-mono)" }}>{turns.length}</span>}
        </div>
        {turns.length > 0 && (
          <select
            value={currentId ?? ""}
            onChange={(event) => setTurnId(event.target.value)}
            aria-label={t("rightWorkbench.changesSelectTurn")}
            style={{ width: "100%", marginTop: 7, padding: "6px 7px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", fontSize: 11 }}
          >
            {turns.map((turn, index) => (
              <option key={turn.id} value={turn.id}>
                {t("rightWorkbench.changesTurn", { number: index + 1 })} · {turn.prompt || t("rightWorkbench.changesNoPrompt")} · {turn.changes.length}
              </option>
            ))}
          </select>
        )}
      </div>
      {!current ? (
        <div style={{ flex: 1, display: "grid", placeItems: "center", padding: 20, color: "var(--text-dim)", fontSize: 11.5, textAlign: "center", lineHeight: 1.5 }}>
          {sessionId ? t("rightWorkbench.changesEmpty") : t("rightWorkbench.changesNoSession")}
        </div>
      ) : (
        <div style={{ minHeight: 0, flex: 1, overflowY: "auto", padding: 8, display: "grid", alignContent: "start", gap: 8 }}>
          {current.changes.map((change) => (
            <section key={change.id} style={{ minWidth: 0, overflow: "hidden", border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)" }}>
              <div style={{ padding: "7px 9px", borderBottom: change.patch ? "1px solid var(--border)" : "none" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text)", fontSize: 11, fontWeight: 600 }}>
                  <Files size={12} style={{ color: "var(--accent)", flexShrink: 0 }} aria-hidden="true" />
                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={change.paths.join("\n") || change.toolName}>
                    {change.paths.length > 0 ? change.paths.join(", ") : change.toolName}
                  </span>
                </div>
                <div style={{ marginTop: 3, color: "var(--text-dim)", fontSize: 10 }}>
                  {change.pending ? t("rightWorkbench.changesPending") : change.patch ? change.toolName : t("rightWorkbench.changesDiffUnavailable", { tool: change.toolName })}
                </div>
              </div>
              {change.patch && <SplitPatchView text={change.patch} />}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
