"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  ArrowRightLeft,
  CheckCircle2,
  ChevronDown,
  Copy,
  Edit3,
  Layers,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { ConfirmDialog } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { useI18n } from "@/lib/i18n";

export interface ProfileSummary {
  profile: string;
  isDefault: boolean;
  isProcessProfile: boolean;
  agentDir: string;
  sessionsDir: string;
  sessionCount?: number;
  modelCount?: number;
  countError?: string;
}

interface ProfileDetails {
  profile: string;
  isDefault: boolean;
  agentDir: string;
  configRoot: string;
  configYaml: string;
  modelsYaml: string;
  mcpJson: string;
  agentsMd: string;
  rulesMd: string;
  mcpServersCount: number;
}

export function ProfileManager() {
  const { t } = useI18n();

  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [currentProfile, setCurrentProfile] = useState<string>("default");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create Modal State
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [newProfileName, setNewProfileName] = useState("");
  const [cloneSource, setCloneSource] = useState<string>("default");
  const [autoSwitchAfterCreate, setAutoSwitchAfterCreate] = useState(true);
  const [creating, setCreating] = useState(false);
  const [componentsToInclude, setComponentsToInclude] = useState({
    configYaml: true,
    modelsYaml: true,
    mcpJson: true,
    agentsMd: true,
    rulesMd: true,
  });

  // Edit / Config Drawer State
  const [editingProfile, setEditingProfile] = useState<string | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [activeConfigTab, setActiveConfigTab] = useState<"roles" | "mcp" | "agents" | "rules" | "models">("roles");
  const [editedConfigYaml, setEditedConfigYaml] = useState("");
  const [editedModelsYaml, setEditedModelsYaml] = useState("");
  const [editedMcpJson, setEditedMcpJson] = useState("");
  const [editedAgentsMd, setEditedAgentsMd] = useState("");
  const [editedRulesMd, setEditedRulesMd] = useState("");
  const [savingConfig, setSavingConfig] = useState(false);

  // Switching state
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  // Delete confirmation is a shared dialog, not window.confirm: a native modal
  // cannot be styled by the theme and ignores the locale.
  const [deletingProfile, setDeletingProfile] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // Load profiles list
  const loadProfiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/profiles?counts=1", { cache: "no-store" });
      if (!res.ok) {
        throw new Error(t("profileManager.loadFailed", { status: res.status }));
      }
      const data = (await res.json()) as { profiles: ProfileSummary[]; current: string };
      setProfiles(data.profiles || []);
      setCurrentProfile(data.current || "default");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  // Switch profile action
  const handleSwitchProfile = async (target: string) => {
    if (target === currentProfile || switchingTo) return;
    setSwitchingTo(target);
    try {
      const res = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile: target }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || t("profileManager.switchFailed"));
      }
      toast.success(t("profileManager.switched", { profile: target }));
      // Reload page to re-bind session list and storage
      window.location.assign(window.location.pathname);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setSwitchingTo(null);
    }
  };

  // Create Profile Action
  const handleCreateProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newProfileName.trim();
    if (!name) return;

    setCreating(true);
    try {
      const res = await fetch("/api/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          copyFrom: cloneSource === "empty" ? undefined : cloneSource,
          include: cloneSource === "empty" ? undefined : componentsToInclude,
        }),
      });

      const body = (await res.json().catch(() => null)) as { error?: string; profile?: string } | null;
      if (!res.ok || !body?.profile) {
        throw new Error(body?.error || t("profileManager.createFailed"));
      }

      toast.success(t("profileManager.created", { profile: body.profile }));
      setCreateModalOpen(false);
      setNewProfileName("");
      await loadProfiles();

      if (autoSwitchAfterCreate) {
        await handleSwitchProfile(body.profile);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  // Delete Profile Action
  const handleDeleteProfile = async (profileName: string) => {
    if (profileName === "default") {
      toast.error(t("profileManager.cannotDeleteDefault"));
      return;
    }
    if (profileName === currentProfile) {
      toast.error(t("profileManager.cannotDeleteActive"));
      return;
    }
    setDeletingProfile(profileName);
  };

  const confirmDeleteProfile = async () => {
    const profileName = deletingProfile;
    if (!profileName) return;
    setDeleteBusy(true);
    try {
      const res = await fetch(`/api/profiles/${encodeURIComponent(profileName)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || t("profileManager.deleteFailed"));
      }
      toast.success(t("profileManager.deleted", { profile: profileName }));
      if (editingProfile === profileName) {
        setEditingProfile(null);
      }
      setDeletingProfile(null);
      await loadProfiles();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleteBusy(false);
    }
  };

  // Load details for editing
  const handleOpenEditor = async (profileName: string) => {
    setEditingProfile(profileName);
    setDetailsLoading(true);
    try {
      const res = await fetch(`/api/profiles/${encodeURIComponent(profileName)}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || t("profileManager.loadDetailsFailed"));
      }
      const data = (await res.json()) as ProfileDetails;
      setEditedConfigYaml(data.configYaml);
      setEditedModelsYaml(data.modelsYaml);
      setEditedMcpJson(data.mcpJson);
      setEditedAgentsMd(data.agentsMd);
      setEditedRulesMd(data.rulesMd);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setEditingProfile(null);
    } finally {
      setDetailsLoading(false);
    }
  };

  // Save changes in editor
  const handleSaveConfig = async () => {
    if (!editingProfile) return;
    setSavingConfig(true);
    try {
      const payload: Record<string, string> = {};
      if (activeConfigTab === "roles") payload.configYaml = editedConfigYaml;
      if (activeConfigTab === "mcp") payload.mcpJson = editedMcpJson;
      if (activeConfigTab === "agents") payload.agentsMd = editedAgentsMd;
      if (activeConfigTab === "rules") payload.rulesMd = editedRulesMd;
      if (activeConfigTab === "models") payload.modelsYaml = editedModelsYaml;

      const res = await fetch(`/api/profiles/${encodeURIComponent(editingProfile)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || t("profileManager.saveFailed"));
      }

      toast.success(t("profileManager.saved", { profile: editingProfile }));
      await loadProfiles();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingConfig(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, height: "100%", minHeight: 0 }}>
      {/* Top Header & Actions */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
            <Layers size={18} style={{ color: "var(--accent)" }} />
            {t("profileManager.title")}
          </h2>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            type="button"
            onClick={() => void loadProfiles()}
            disabled={loading}
            title={t("profileManager.refreshTitle")}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              height: 30,
              padding: "0 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text)",
              fontSize: 12,
              cursor: loading ? "default" : "pointer",
            }}
          >
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
            {t("profileManager.refresh")}
          </button>

          <button
            type="button"
            onClick={() => {
              setNewProfileName("");
              setCloneSource(currentProfile || "default");
              setCreateModalOpen(true);
            }}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              height: 30,
              padding: "0 12px",
              borderRadius: 6,
              border: "none",
              background: "var(--accent)",
              color: "#fff",
              fontSize: 12,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            <Plus size={14} />
            {t("profileManager.create")}
          </button>
        </div>
      </div>

      {error && (
        <div style={{ padding: "10px 14px", borderRadius: 6, background: "rgba(239,68,68,0.1)", border: "1px solid var(--status-error)", color: "var(--status-error)", fontSize: 12, display: "flex", alignItems: "center", gap: 8 }}>
          <AlertCircle size={15} />
          {error}
        </div>
      )}

      {/* Profiles Cards List */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 12, overflowY: "auto", paddingBottom: 16 }}>
        {profiles.map((p) => {
          const isActive = p.profile === currentProfile;
          return (
            <div
              key={p.profile}
              style={{
                borderRadius: 8,
                border: isActive ? "2px solid var(--accent)" : "1px solid var(--border)",
                background: "var(--bg-panel)",
                padding: 14,
                display: "flex",
                flexDirection: "column",
                gap: 10,
                position: "relative",
              }}
            >
              {/* Header row */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{p.profile}</span>
                  {isActive && (
                    <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "rgba(34,197,94,0.15)", color: "var(--status-success)", fontWeight: 600, textTransform: "uppercase" }}>
                      {t("profileManager.active")}
                    </span>
                  )}
                  {p.isDefault && (
                    <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "rgba(59,130,246,0.15)", color: "#3b82f6", fontWeight: 600, textTransform: "uppercase" }}>
                      {t("profileManager.default")}
                    </span>
                  )}
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <button
                    type="button"
                    onClick={() => void handleOpenEditor(p.profile)}
                    title={t("profileManager.configureTitle")}
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 4,
                      border: "1px solid var(--border)",
                      background: "transparent",
                      color: "var(--text-muted)",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Edit3 size={13} />
                  </button>

                  {!p.isDefault && !isActive && (
                    <button
                      type="button"
                      onClick={() => void handleDeleteProfile(p.profile)}
                      title={t("profileManager.deleteTitle")}
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: 4,
                        border: "1px solid var(--border)",
                        background: "transparent",
                        color: "var(--status-error)",
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              </div>

              {/* Agent directory path */}
              <div style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-dim)", wordBreak: "break-all", background: "var(--bg-app)", padding: "4px 8px", borderRadius: 4 }}>
                {p.agentDir}
              </div>

              {/* Summary Stats */}
              <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 11.5, color: "var(--text-muted)" }}>
                <div>
                  {t("profileManager.sessions")} <strong style={{ color: "var(--text)" }}>{p.sessionCount ?? 0}</strong>
                </div>
                <div>
                  {t("profileManager.models")} <strong style={{ color: "var(--text)" }}>{p.modelCount ?? 0}</strong>
                </div>
              </div>

              {/* Bottom Actions */}
              <div style={{ marginTop: "auto", paddingTop: 8, borderTop: "1px solid var(--border-subtle)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                {isActive ? (
                  <span style={{ fontSize: 11, color: "var(--status-success)", display: "flex", alignItems: "center", gap: 4 }}>
                    <CheckCircle2 size={12} /> {t("profileManager.currentlyInUse")}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handleSwitchProfile(p.profile)}
                    disabled={switchingTo === p.profile}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      height: 26,
                      padding: "0 10px",
                      borderRadius: 4,
                      border: "1px solid var(--border)",
                      background: "var(--bg-app)",
                      color: "var(--text)",
                      fontSize: 11.5,
                      cursor: "pointer",
                    }}
                  >
                    <ArrowRightLeft size={12} />
                    {switchingTo === p.profile ? t("profileManager.switching") : t("profileManager.switchTo")}
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => {
                    setNewProfileName("");
                    setCloneSource(p.profile);
                    setCreateModalOpen(true);
                  }}
                  title={t("profileManager.cloneTitle")}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    height: 26,
                    padding: "0 8px",
                    borderRadius: 4,
                    border: "none",
                    background: "transparent",
                    color: "var(--text-dim)",
                    fontSize: 11,
                    cursor: "pointer",
                  }}
                >
                  <Copy size={11} /> {t("profileManager.clone")}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* CREATE PROFILE MODAL */}
      {createModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: 440,
              background: "var(--bg-panel)",
              borderRadius: 8,
              border: "1px solid var(--border)",
              boxShadow: "0 10px 25px -5px rgba(0,0,0,0.3)",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{t("profileManager.createTitle")}</h3>
              <button
                type="button"
                onClick={() => setCreateModalOpen(false)}
                style={{ background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer" }}
              >
                <X size={16} />
              </button>
            </div>

            <form onSubmit={(e) => void handleCreateProfile(e)} style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 6, color: "var(--text)" }}>
                  {t("profileManager.nameLabel")}
                </label>
                <input
                  type="text"
                  required
                  placeholder={t("profileManager.namePlaceholder")}
                  value={newProfileName}
                  onChange={(e) => setNewProfileName(e.target.value)}
                  style={{
                    width: "100%",
                    height: 32,
                    padding: "0 10px",
                    borderRadius: 6,
                    border: "1px solid var(--border)",
                    background: "var(--bg-app)",
                    color: "var(--text)",
                    fontSize: 12,
                    fontFamily: "inherit",
                  }}
                />
                <span style={{ fontSize: 10.5, color: "var(--text-dim)", marginTop: 4, display: "block" }}>
                  {t("profileManager.nameHint")}
                </span>
              </div>

              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 6, color: "var(--text)" }}>
                  {t("profileManager.templateLabel")}
                </label>
                <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
                  <select
                    value={cloneSource}
                    onChange={(e) => setCloneSource(e.target.value)}
                    style={{
                      width: "100%",
                      height: 32,
                      padding: "0 28px 0 10px",
                      borderRadius: 6,
                      border: "1px solid var(--border)",
                      background: "var(--bg-app)",
                      color: "var(--text)",
                      fontSize: 12,
                      fontFamily: "inherit",
                      appearance: "none",
                      WebkitAppearance: "none",
                      outline: "none",
                      cursor: "pointer",
                      colorScheme: "dark light",
                    }}
                    onFocus={(e) => {
                      e.currentTarget.style.borderColor = "var(--accent)";
                    }}
                    onBlur={(e) => {
                      e.currentTarget.style.borderColor = "var(--border)";
                    }}
                  >
                    <option value="empty" style={{ background: "var(--bg-panel)", color: "var(--text)" }}>
                      {t("profileManager.templateEmpty")}
                    </option>
                    <option value="default" style={{ background: "var(--bg-panel)", color: "var(--text)" }}>
                      {t("profileManager.templateDefault")}
                    </option>
                    {profiles
                      .filter((p) => !p.isDefault)
                      .map((p) => (
                        <option key={p.profile} value={p.profile} style={{ background: "var(--bg-panel)", color: "var(--text)" }}>
                          {t("profileManager.templateClone", { profile: p.profile })}
                        </option>
                      ))}
                  </select>
                  <ChevronDown
                    size={13}
                    aria-hidden="true"
                    style={{ position: "absolute", right: 10, color: "var(--text-dim)", pointerEvents: "none" }}
                  />
                </div>
              </div>
              {cloneSource !== "empty" && (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                    padding: "10px 12px",
                    borderRadius: 6,
                    background: "var(--bg-app)",
                    border: "1px solid var(--border)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text)" }}>
                      {t("profileManager.componentsTitle")}
                    </span>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <button
                        type="button"
                        onClick={() =>
                          setComponentsToInclude({
                            configYaml: true,
                            modelsYaml: true,
                            mcpJson: true,
                            agentsMd: true,
                            rulesMd: true,
                          })
                        }
                        style={{
                          border: "none",
                          background: "transparent",
                          color: "var(--accent)",
                          fontSize: 11,
                          cursor: "pointer",
                          padding: 0,
                        }}
                      >
                        {t("profileManager.componentsAll")}
                      </button>
                      <span style={{ color: "var(--text-dim)", fontSize: 11 }}>·</span>
                      <button
                        type="button"
                        onClick={() =>
                          setComponentsToInclude({
                            configYaml: false,
                            modelsYaml: false,
                            mcpJson: false,
                            agentsMd: false,
                            rulesMd: false,
                          })
                        }
                        style={{
                          border: "none",
                          background: "transparent",
                          color: "var(--text-muted)",
                          fontSize: 11,
                          cursor: "pointer",
                          padding: 0,
                        }}
                      >
                        {t("profileManager.componentsNone")}
                      </button>
                    </div>
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 2 }}>
                    {[
                      { key: "configYaml", label: t("profileManager.fileConfig"), file: "config.yml" },
                      { key: "modelsYaml", label: t("profileManager.fileModels"), file: "models.yml" },
                      { key: "mcpJson", label: t("profileManager.fileMcp"), file: "mcp.json" },
                      { key: "agentsMd", label: t("profileManager.fileAgents"), file: "AGENTS.md" },
                      { key: "rulesMd", label: t("profileManager.fileRules"), file: "RULES.md" },
                    ].map((item) => {
                      const isChecked = componentsToInclude[item.key as keyof typeof componentsToInclude];
                      return (
                        <label
                          key={item.key}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            fontSize: 11.5,
                            color: isChecked ? "var(--text)" : "var(--text-dim)",
                            cursor: "pointer",
                            padding: "2px 0",
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={(e) =>
                                setComponentsToInclude((prev) => ({
                                  ...prev,
                                  [item.key]: e.target.checked,
                                }))
                              }
                              style={{ accentColor: "var(--accent)", cursor: "pointer" }}
                            />
                            <span>
                              <strong>{item.label}</strong>{" "}
                              <span style={{ color: "var(--text-dim)", fontSize: 10.5 }}>({item.file})</span>
                            </span>
                          </div>
                          <span
                            style={{
                              fontSize: 10,
                              fontWeight: 500,
                              color: isChecked ? "var(--text-dim)" : "var(--status-warning)",
                            }}
                          >
                            {isChecked ? t("profileManager.copy") : t("profileManager.strip")}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  id="auto-switch-checkbox"
                  checked={autoSwitchAfterCreate}
                  onChange={(e) => setAutoSwitchAfterCreate(e.target.checked)}
                  style={{ accentColor: "var(--accent)", cursor: "pointer" }}
                />
                <label htmlFor="auto-switch-checkbox" style={{ fontSize: 12, color: "var(--text)", cursor: "pointer" }}>
                  {t("profileManager.autoSwitch")}
                </label>
              </div>

              <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
                <button
                  type="button"
                  onClick={() => setCreateModalOpen(false)}
                  style={{
                    height: 30,
                    padding: "0 12px",
                    borderRadius: 6,
                    border: "1px solid var(--border)",
                    background: "transparent",
                    color: "var(--text)",
                    fontSize: 12,
                    cursor: "pointer",
                  }}
                >
                  {t("profileManager.cancel")}
                </button>
                <button
                  type="submit"
                  disabled={creating || !newProfileName.trim()}
                  style={{
                    height: 30,
                    padding: "0 14px",
                    borderRadius: 6,
                    border: "none",
                    background: "var(--accent)",
                    color: "#fff",
                    fontSize: 12,
                    fontWeight: 500,
                    cursor: creating ? "default" : "pointer",
                  }}
                >
                  {creating ? t("profileManager.creating") : t("profileManager.create")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* CONFIGURATION EDITOR DRAWER / VIEW */}
      {editingProfile && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: 780,
              height: "85vh",
              background: "var(--bg-panel)",
              borderRadius: 8,
              border: "1px solid var(--border)",
              boxShadow: "0 15px 35px -5px rgba(0,0,0,0.3)",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            {/* Editor Header */}
            <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Edit3 size={16} style={{ color: "var(--accent)" }} />
                <span style={{ fontSize: 14, fontWeight: 600 }}>
                  {t("profileManager.editingProfile")} <strong style={{ color: "var(--accent)" }}>{editingProfile}</strong>
                </span>
              </div>
              <button
                type="button"
                onClick={() => setEditingProfile(null)}
                style={{ background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer" }}
              >
                <X size={16} />
              </button>
            </div>

            {/* Sub-tabs for configuration files */}
            <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "8px 16px", borderBottom: "1px solid var(--border)", background: "var(--bg-app)" }}>
              {[
                { id: "roles", label: t("profileManager.tabRoles") },
                { id: "mcp", label: t("profileManager.tabMcp") },
                { id: "agents", label: t("profileManager.tabAgents") },
                { id: "rules", label: t("profileManager.tabRules") },
                { id: "models", label: t("profileManager.tabModels") },
              ].map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveConfigTab(tab.id as typeof activeConfigTab)}
                  style={{
                    padding: "4px 10px",
                    borderRadius: 4,
                    border: "none",
                    background: activeConfigTab === tab.id ? "var(--bg-panel)" : "transparent",
                    color: activeConfigTab === tab.id ? "var(--text)" : "var(--text-muted)",
                    fontSize: 11.5,
                    fontWeight: activeConfigTab === tab.id ? 600 : 400,
                    boxShadow: activeConfigTab === tab.id ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
                    cursor: "pointer",
                  }}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Editor Content Area */}
            <div style={{ flex: 1, minHeight: 0, padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
              {detailsLoading ? (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-muted)", fontSize: 12 }}>
                  <RefreshCw size={16} className="animate-spin" style={{ marginRight: 8 }} />
                  {t("profileManager.loadingFiles")}
                </div>
              ) : (
                <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
                  <textarea
                    value={
                      activeConfigTab === "roles"
                        ? editedConfigYaml
                        : activeConfigTab === "mcp"
                        ? editedMcpJson
                        : activeConfigTab === "agents"
                        ? editedAgentsMd
                        : activeConfigTab === "rules"
                        ? editedRulesMd
                        : editedModelsYaml
                    }
                    onChange={(e) => {
                      const val = e.target.value;
                      if (activeConfigTab === "roles") setEditedConfigYaml(val);
                      if (activeConfigTab === "mcp") setEditedMcpJson(val);
                      if (activeConfigTab === "agents") setEditedAgentsMd(val);
                      if (activeConfigTab === "rules") setEditedRulesMd(val);
                      if (activeConfigTab === "models") setEditedModelsYaml(val);
                    }}
                    style={{
                      flex: 1,
                      width: "100%",
                      minHeight: 0,
                      resize: "none",
                      padding: 12,
                      fontFamily: "var(--font-mono)",
                      fontSize: 12,
                      lineHeight: 1.5,
                      borderRadius: 6,
                      border: "1px solid var(--border)",
                      background: "var(--bg-app)",
                      color: "var(--text)",
                    }}
                  />
                </div>
              )}
            </div>

            {/* Editor Footer */}
            <div style={{ padding: "10px 18px", borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                {t("profileManager.saveHint", { profile: editingProfile })}
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button
                  type="button"
                  onClick={() => setEditingProfile(null)}
                  style={{
                    height: 30,
                    padding: "0 12px",
                    borderRadius: 6,
                    border: "1px solid var(--border)",
                    background: "transparent",
                    color: "var(--text)",
                    fontSize: 12,
                    cursor: "pointer",
                  }}
                >
                  {t("profileManager.close")}
                </button>
                <button
                  type="button"
                  onClick={() => void handleSaveConfig()}
                  disabled={savingConfig || detailsLoading}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    height: 30,
                    padding: "0 14px",
                    borderRadius: 6,
                    border: "none",
                    background: "var(--accent)",
                    color: "#fff",
                    fontSize: 12,
                    fontWeight: 500,
                    cursor: savingConfig ? "default" : "pointer",
                  }}
                >
                  <Save size={13} />
                  {savingConfig ? t("profileManager.saving") : t("profileManager.saveChanges")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={deletingProfile !== null}
        onOpenChange={(open) => {
          if (!open && !deleteBusy) setDeletingProfile(null);
        }}
        title={t("profileManager.deleteTitle")}
        description={
          deletingProfile
            ? t("profileManager.deleteConfirm", { profile: deletingProfile })
            : undefined
        }
        confirmLabel={t("profileManager.deleteTitle")}
        cancelLabel={t("profileManager.cancel")}
        danger
        busy={deleteBusy}
        onConfirm={() => void confirmDeleteProfile()}
      />
    </div>
  );
}
