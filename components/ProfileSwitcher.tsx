"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { useI18n } from "@/lib/i18n";

interface ProfileSummary {
  profile: string;
  isDefault: boolean;
  isProcessProfile: boolean;
  sessionCount?: number;
  modelCount?: number;
}

interface ProfilesPayload {
  profiles: ProfileSummary[];
  current: string;
}

/**
 * Profile switcher for the sidebar footer.
 *
 * Selection lives in a server cookie (lib/omp/profile-cookie.ts); same-origin
 * fetches carry it automatically, so switching only needs the PUT plus a list
 * reload. Profiles are discovered read-only from disk — creating one is an
 * `omp --profile <name>` operation, not a mkdir here, because an empty profile
 * directory without config.yml/models.yml leaves the UI half-broken.
 */
export function ProfileSwitcher({
  onProfileChange,
  onProfileReady,
}: {
  /** Fired after the cookie PUT succeeded, with the canonical profile key. */
  onProfileChange?: (profile: string) => void;
  /** Fires once the server-resolved current profile is known, so the parent
   *  can discard SSE frames / caches belonging to another profile. */
  onProfileReady?: (profile: string) => void;
}) {
  const { t } = useI18n();
  const [payload, setPayload] = useState<ProfilesPayload | null>(null);
  const [busy, setBusy] = useState(false);
  // Mirror of `busy` for re-entrancy: the select is disabled while busy, but
  // onChange can still fire twice from fast keyboard interaction before the
  // disabled attribute commits.
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/profiles", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: ProfilesPayload | null) => {
        if (cancelled || !data) return;
        setPayload(data);
        onProfileReady?.(data.current);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [onProfileReady]);

  const switchTo = useCallback(async (profile: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || t("profile.switchFailed"));
      }
      // Trust the server's canonical name over the requested one: the PUT
      // route normalizes, and downstream frame filtering compares against
      // this exact key.
      const body = (await res.json().catch(() => null)) as { profile?: string } | null;
      const resolved = typeof body?.profile === "string" && body.profile ? body.profile : profile;
      setPayload((prev) => (prev ? { ...prev, current: resolved } : prev));
      onProfileChange?.(resolved);
      // Reload rather than re-restore in place. Last-session restore is gated by
      // a restored-once ref plus AppShell's boot gate, both of which are
      // per-mount, and the project registry, models catalog and FileExplorer all
      // re-derive from the new cookie too. A reload is the state users already
      // verified as correct after switching.
      // The query string is dropped on purpose: ?session=<id> names a session in
      // the PREVIOUS profile, and carrying it into the reload would ask the new
      // profile to open an id it does not have.
      window.location.assign(window.location.pathname);
    } catch (switchError) {
      setError(switchError instanceof Error ? switchError.message : String(switchError));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [onProfileChange, t]);

  if (!payload || payload.profiles.length <= 1) return null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        height: 32,
        padding: "0 12px",
        flexShrink: 0,
      }}
    >
      <label
        htmlFor="omp-profile-select"
        style={{ flexShrink: 0, fontSize: 11, color: "var(--text-dim)" }}
      >
        {t("profile.label")}
      </label>
      <div style={{ position: "relative", flex: 1, minWidth: 0, display: "flex", alignItems: "center" }}>
        <select
          id="omp-profile-select"
          disabled={busy}
          value={payload.current}
          onChange={(event) => void switchTo(event.target.value)}
          style={{
            width: "100%",
            minWidth: 0,
            height: 24,
            padding: "0 24px 0 8px",
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg-panel)",
            color: "var(--text)",
            fontSize: 12,
            fontFamily: "inherit",
            cursor: busy ? "default" : "pointer",
            appearance: "none",
            WebkitAppearance: "none",
            opacity: busy ? 0.6 : 1,
            outline: "none",
            // Native popups follow the active theme instead of staying white
            // under a dark theme.
            colorScheme: "dark light",
            textOverflow: "ellipsis",
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border)"; }}
        >
          {payload.profiles.map((profile) => {
            const counts =
              profile.sessionCount === undefined
                ? ""
                : ` · ${profile.sessionCount} ${t("profile.sessions")} · ${profile.modelCount ?? 0} ${t("profile.models")}`;
            return (
              <option key={profile.profile} value={profile.profile} style={{ background: "var(--bg-panel)", color: "var(--text)" }}>
                {profile.profile}
                {counts}
              </option>
            );
          })}
        </select>
        {/* currentColor chevron (same as the Select primitive in ui/field):
            a baked gray data-URI would not follow theme switches. */}
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          style={{ position: "absolute", right: 8, color: "var(--text-dim)", pointerEvents: "none" }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>
      {busy && <LoaderCircle size={12} className="animate-spin" aria-hidden="true" style={{ flexShrink: 0, color: "var(--text-dim)" }} />}
      {error ? (
        <span
          title={error}
          style={{ flexShrink: 1, minWidth: 0, maxWidth: 90, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, color: "var(--status-error)" }}
        >
          {error}
        </span>
      ) : null}
    </div>
  );
}
