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
        height: 36,
        padding: "0 12px",
        color: "var(--text-muted)",
        fontSize: 12,
      }}
    >
      <label htmlFor="omp-profile-select" style={{ flexShrink: 0 }}>
        {t("profile.label")}
      </label>
      <select
        id="omp-profile-select"
        disabled={busy}
        value={payload.current}
        onChange={(event) => void switchTo(event.target.value)}
        style={{
          flex: 1,
          minWidth: 0,
          height: 24,
          background: "none",
          border: "none",
          borderBottom: "1px solid var(--border)",
          color: "var(--text)",
          fontSize: 12,
          cursor: busy ? "default" : "pointer",
        }}
      >
        {payload.profiles.map((profile) => {
          const counts =
            profile.sessionCount === undefined
              ? ""
              : ` · ${profile.sessionCount} ${t("profile.sessions")} · ${profile.modelCount ?? 0} ${t("profile.models")}`;
          return (
            <option key={profile.profile} value={profile.profile}>
              {profile.profile}
              {counts}
            </option>
          );
        })}
      </select>
      {busy && <LoaderCircle size={12} className="animate-spin" aria-hidden="true" />}
      {error ? <span style={{ maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{error}</span> : null}
    </div>
  );
}
