"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  SlidersHorizontal,
  ChevronDown,
  Check,
  Sparkles,
  MessageSquare,
  Terminal,
  Trash2,
  Save,
  Wrench,
  Plus,
  ArrowLeft,
} from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { toast } from "@/components/ui/toast";
import type {
  CapabilityPreset,
  SessionCapabilities,
  WorkspaceCapabilitiesCatalog,
  CustomPresetDefinition,
} from "@/lib/capabilities-types";
import { BUILTIN_TOOLS } from "@/lib/capabilities-types";
interface Props {
  cwd?: string;
  sessionId?: string;
  disabled?: boolean;
  capabilities: SessionCapabilities;
  onCapabilitiesChange: (newCaps: SessionCapabilities, saveToWorkspace?: boolean) => void;
}

export function CapabilitiesPicker(props: Props) {
  const { cwd, disabled = false, capabilities, onCapabilitiesChange } = props;
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"presets" | "custom">("presets");
  const [catalog, setCatalog] = useState<WorkspaceCapabilitiesCatalog | null>(null);
  const [saveToWorkspace, setSaveToWorkspace] = useState(false);

  // Custom preset editing state
  const [customTools, setCustomTools] = useState<string[]>(
    () => capabilities.tools ?? BUILTIN_TOOLS.map((bt) => bt.id),
  );
  const [customDisabledMcp, setCustomDisabledMcp] = useState<string[]>(
    () => capabilities.disabledMcp ?? [],
  );
  const [customSkills, setCustomSkills] = useState<string[] | undefined>(
    () => capabilities.skills,
  );
  const [presetNameInput, setPresetNameInput] = useState("");
  const [savingPreset, setSavingPreset] = useState(false);
  const [showSavePresetInput, setShowSavePresetInput] = useState(false);

  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Synchronize internal custom selection when external capabilities prop changes
  useEffect(() => {
    if (capabilities.tools !== undefined) {
      setCustomTools(capabilities.tools);
    } else {
      setCustomTools(BUILTIN_TOOLS.map((bt) => bt.id));
    }
    setCustomDisabledMcp(capabilities.disabledMcp ?? []);
    setCustomSkills(capabilities.skills);
  }, [capabilities]);

  // Fetch catalog on mount or when popover opens
  const fetchCatalog = useCallback(async () => {
    try {
      const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
      const res = await fetch(`/api/capabilities${q}`);
      if (res.ok) {
        const data = (await res.json()) as { catalog: WorkspaceCapabilitiesCatalog };
        if (data.catalog) setCatalog(data.catalog);
      }
    } catch {
      // Degrade silently
    }
  }, [cwd]);

  useEffect(() => {
    if (open && !catalog) {
      void fetchCatalog();
    }
  }, [open, catalog, fetchCatalog]);

  // Click outside to close
  useEffect(() => {
    if (!open) return;
    const handleOutside = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
        setShowSavePresetInput(false);
      }
    };
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [open]);

  const currentPreset = capabilities.preset;

  const handleSelectPreset = (preset: CapabilityPreset) => {
    if (preset === "chat_only") {
      onCapabilitiesChange(
        { preset: "chat_only", tools: [], skills: [], disabledMcp: [] },
        saveToWorkspace,
      );
    } else if (preset === "code_editor") {
      onCapabilitiesChange(
        { preset: "code_editor", tools: ["read", "edit", "write", "bash", "glob", "grep"], disabledMcp: [] },
        saveToWorkspace,
      );
    } else if (preset === "full_agent") {
      onCapabilitiesChange(
        { preset: "full_agent", tools: undefined, skills: undefined, disabledMcp: [] },
        saveToWorkspace,
      );
    }
    setOpen(false);
  };

  const handleSelectCustomPreset = (p: CustomPresetDefinition) => {
    onCapabilitiesChange(
      {
        preset: "custom",
        customPresetName: p.name,
        tools: p.tools,
        disabledMcp: p.disabledMcp,
        skills: p.skills,
      },
      saveToWorkspace,
    );
    setOpen(false);
  };

  const handleDeleteCustomPreset = async (presetId: string, name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const res = await fetch(`/api/capabilities?id=${encodeURIComponent(presetId)}`, {
        method: "DELETE",
      });
      if (res.ok) {
        toast.success(t("capabilities.presetDeleted", { name }));
        await fetchCatalog();
      }
    } catch {
      // ignore
    }
  };

  const handleSaveAsProfilePreset = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = presetNameInput.trim();
    if (!name) return;
    setSavingPreset(true);
    try {
      const res = await fetch("/api/capabilities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          savePreset: {
            name,
            tools: customTools,
            disabledMcp: customDisabledMcp,
            skills: customSkills,
          },
        }),
      });
      if (res.ok) {
        toast.success(t("capabilities.presetSaved", { name }));
        setPresetNameInput("");
        setShowSavePresetInput(false);
        await fetchCatalog();
        onCapabilitiesChange(
          {
            preset: "custom",
            customPresetName: name,
            tools: customTools,
            disabledMcp: customDisabledMcp,
            skills: customSkills,
          },
          saveToWorkspace,
        );
      }
    } catch {
      // ignore
    } finally {
      setSavingPreset(false);
    }
  };

  const handleApplyCustom = () => {
    onCapabilitiesChange(
      {
        preset: "custom",
        tools: customTools,
        disabledMcp: customDisabledMcp,
        skills: customSkills,
      },
      saveToWorkspace,
    );
    setOpen(false);
  };

  const toggleTool = (toolId: string) => {
    setCustomTools((prev) =>
      prev.includes(toolId) ? prev.filter((id) => id !== toolId) : [...prev, toolId],
    );
  };

  const toggleMcpServer = (serverName: string) => {
    setCustomDisabledMcp((prev) =>
      prev.includes(serverName)
        ? prev.filter((name) => name !== serverName)
        : [...prev, serverName],
    );
  };

  const getButtonLabel = () => {
    if (capabilities.customPresetName) {
      return capabilities.customPresetName;
    }
    switch (currentPreset) {
      case "chat_only":
        return t("capabilities.presetChatOnly");
      case "code_editor":
        return t("capabilities.presetCodeEditor");
      case "full_agent":
        return t("capabilities.presetFullAgent");
      case "custom":
        return t("capabilities.presetCustom");
      default:
        return t("capabilities.buttonLabel");
    }
  };

  return (
    <div style={{ position: "relative" }}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        title={t("capabilities.title")}
        aria-label={t("capabilities.title")}
        aria-expanded={open}
        aria-haspopup="dialog"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          height: 28,
          padding: "0 8px",
          background: open ? "var(--bg-hover)" : "none",
          border: "none",
          borderRadius: 7,
          color: currentPreset === "full_agent" ? "var(--text-muted)" : "var(--accent)",
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.5 : 1,
          fontSize: 12,
          fontWeight: currentPreset === "full_agent" ? 400 : 600,
          transition: "background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)",
        }}
        onMouseEnter={(e) => {
          if (!disabled) {
            e.currentTarget.style.background = "var(--bg-hover)";
            e.currentTarget.style.color = currentPreset === "full_agent" ? "var(--text)" : "var(--accent)";
          }
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = open ? "var(--bg-hover)" : "none";
          e.currentTarget.style.color = currentPreset === "full_agent" ? "var(--text-muted)" : "var(--accent)";
        }}
      >
        <SlidersHorizontal size={12} strokeWidth={1.8} aria-hidden="true" style={{ flexShrink: 0 }} />
        <span>{getButtonLabel()}</span>
        <ChevronDown size={10} strokeWidth={2} style={{ opacity: 0.7, flexShrink: 0 }} aria-hidden="true" />
      </button>

      {open && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={t("capabilities.title")}
          style={{
            position: "absolute",
            bottom: "calc(100% + 6px)",
            left: 0,
            zIndex: 100,
            width: 360,
            maxHeight: "80vh",
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-dropdown, 10px)",
            boxShadow: "var(--shadow-popover, 0 8px 24px rgba(0,0,0,0.18))",
            padding: 12,
            display: "flex",
            flexDirection: "column",
            gap: 10,
            overflowY: "auto",
          }}
        >
          {/* Header & View Tabs */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid var(--border)", paddingBottom: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <button
                type="button"
                onClick={() => setActiveTab("presets")}
                style={{
                  border: "none",
                  background: activeTab === "presets" ? "var(--bg-hover)" : "transparent",
                  color: activeTab === "presets" ? "var(--text)" : "var(--text-muted)",
                  fontSize: 11.5,
                  fontWeight: activeTab === "presets" ? 600 : 400,
                  padding: "3px 8px",
                  borderRadius: 4,
                  cursor: "pointer",
                }}
              >
                {t("capabilities.tabPresets")}
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("custom")}
                style={{
                  border: "none",
                  background: activeTab === "custom" ? "var(--bg-hover)" : "transparent",
                  color: activeTab === "custom" ? "var(--accent)" : "var(--text-muted)",
                  fontSize: 11.5,
                  fontWeight: activeTab === "custom" ? 600 : 400,
                  padding: "3px 8px",
                  borderRadius: 4,
                  cursor: "pointer",
                }}
              >
                {t("capabilities.tabCustom")}
              </button>
            </div>
            <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
              {currentPreset === "chat_only"
                ? t("capabilities.savingsBadge", { tokens: "6.000" })
                : currentPreset === "code_editor"
                ? t("capabilities.savingsBadge", { tokens: "3.700" })
                : "Baseline"}
            </span>
          </div>

          {/* TAB 1: PRESETS */}
          {activeTab === "presets" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {/* Chat Only */}
              <button
                type="button"
                onClick={() => handleSelectPreset("chat_only")}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                  padding: "8px 10px",
                  borderRadius: 8,
                  background: currentPreset === "chat_only" ? "var(--bg-selected, var(--bg-hover))" : "transparent",
                  border: "1px solid",
                  borderColor: currentPreset === "chat_only" ? "var(--accent)" : "transparent",
                  textAlign: "left",
                  cursor: "pointer",
                }}
              >
                <MessageSquare size={14} style={{ marginTop: 2, flexShrink: 0, color: "var(--status-success)" }} aria-hidden="true" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{t("capabilities.presetChatOnly")}</span>
                    <span style={{ fontSize: 9.5, color: "var(--status-success)", fontWeight: 500, fontFamily: "var(--font-mono)" }}>~6.000 tkn</span>
                  </div>
                  <p style={{ margin: "2px 0 0", fontSize: 11, color: "var(--text-muted)", lineHeight: 1.3 }}>
                    {t("capabilities.presetChatOnlyDesc")}
                  </p>
                </div>
                {currentPreset === "chat_only" && <Check size={12} style={{ color: "var(--accent)", flexShrink: 0, marginTop: 4 }} />}
              </button>

              {/* Code Editor */}
              <button
                type="button"
                onClick={() => handleSelectPreset("code_editor")}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                  padding: "8px 10px",
                  borderRadius: 8,
                  background: currentPreset === "code_editor" ? "var(--bg-selected, var(--bg-hover))" : "transparent",
                  border: "1px solid",
                  borderColor: currentPreset === "code_editor" ? "var(--accent)" : "transparent",
                  textAlign: "left",
                  cursor: "pointer",
                }}
              >
                <Terminal size={14} style={{ marginTop: 2, flexShrink: 0, color: "var(--accent)" }} aria-hidden="true" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{t("capabilities.presetCodeEditor")}</span>
                    <span style={{ fontSize: 9.5, color: "var(--accent)", fontWeight: 500, fontFamily: "var(--font-mono)" }}>~3.700 tkn</span>
                  </div>
                  <p style={{ margin: "2px 0 0", fontSize: 11, color: "var(--text-muted)", lineHeight: 1.3 }}>
                    {t("capabilities.presetCodeEditorDesc")}
                  </p>
                </div>
                {currentPreset === "code_editor" && <Check size={12} style={{ color: "var(--accent)", flexShrink: 0, marginTop: 4 }} />}
              </button>

              {/* Full Agent */}
              <button
                type="button"
                onClick={() => handleSelectPreset("full_agent")}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                  padding: "8px 10px",
                  borderRadius: 8,
                  background: currentPreset === "full_agent" && !capabilities.customPresetName ? "var(--bg-selected, var(--bg-hover))" : "transparent",
                  border: "1px solid",
                  borderColor: currentPreset === "full_agent" && !capabilities.customPresetName ? "var(--accent)" : "transparent",
                  textAlign: "left",
                  cursor: "pointer",
                }}
              >
                <Sparkles size={14} style={{ marginTop: 2, flexShrink: 0, color: "var(--status-warning, #f59e0b)" }} aria-hidden="true" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{t("capabilities.presetFullAgent")}</span>
                    <span style={{ fontSize: 9.5, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>Default</span>
                  </div>
                  <p style={{ margin: "2px 0 0", fontSize: 11, color: "var(--text-muted)", lineHeight: 1.3 }}>
                    {t("capabilities.presetFullAgentDesc")}
                  </p>
                </div>
                {currentPreset === "full_agent" && !capabilities.customPresetName && (
                  <Check size={12} style={{ color: "var(--accent)", flexShrink: 0, marginTop: 4 }} />
                )}
              </button>

              {/* Profile Saved Presets List */}
              {catalog?.customPresets && catalog.customPresets.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4, paddingTop: 6, borderTop: "1px solid var(--border-subtle)" }}>
                  <span style={{ fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase" }}>
                    Profile Presets
                  </span>
                  {catalog.customPresets.map((p) => {
                    const isSelected = capabilities.customPresetName === p.name;
                    return (
                      <div
                        key={p.id}
                        onClick={() => handleSelectCustomPreset(p)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "6px 8px",
                          borderRadius: 6,
                          background: isSelected ? "var(--bg-selected, var(--bg-hover))" : "transparent",
                          border: "1px solid",
                          borderColor: isSelected ? "var(--accent)" : "var(--border-subtle)",
                          cursor: "pointer",
                        }}
                      >
                        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                          <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text)" }}>{p.name}</span>
                          <span style={{ fontSize: 9.5, color: "var(--text-dim)" }}>
                            {(p.tools?.length ?? BUILTIN_TOOLS.length)} tools
                            {p.disabledMcp && p.disabledMcp.length > 0 ? ` · ${p.disabledMcp.length} MCP off` : ""}
                          </span>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          {isSelected && <Check size={12} style={{ color: "var(--accent)" }} />}
                          <button
                            type="button"
                            title={t("capabilities.deletePresetTitle")}
                            onClick={(e) => void handleDeleteCustomPreset(p.id, p.name, e)}
                            style={{
                              border: "none",
                              background: "transparent",
                              color: "var(--text-dim)",
                              cursor: "pointer",
                              padding: 2,
                            }}
                          >
                            <Trash2 size={11} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Switch to Custom view button */}
              <button
                type="button"
                onClick={() => setActiveTab("custom")}
                style={{
                  marginTop: 4,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                  height: 28,
                  borderRadius: 6,
                  border: "1px dashed var(--border)",
                  background: "transparent",
                  color: "var(--accent)",
                  fontSize: 11.5,
                  cursor: "pointer",
                }}
              >
                <Wrench size={12} />
                {t("capabilities.tabCustom")}
              </button>
            </div>
          )}

          {/* TAB 2: GRANULAR CUSTOM & MCP */}
          {activeTab === "custom" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {/* Section 1: Built-in Tools */}
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text)" }}>
                    {t("capabilities.customToolsTitle")} ({customTools.length}/{BUILTIN_TOOLS.length})
                  </span>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <button
                      type="button"
                      onClick={() => setCustomTools(BUILTIN_TOOLS.map((t) => t.id))}
                      style={{ border: "none", background: "transparent", color: "var(--accent)", fontSize: 10.5, cursor: "pointer", padding: 0 }}
                    >
                      {t("capabilities.selectAll")}
                    </button>
                    <span style={{ color: "var(--text-dim)", fontSize: 10 }}>·</span>
                    <button
                      type="button"
                      onClick={() => setCustomTools([])}
                      style={{ border: "none", background: "transparent", color: "var(--text-muted)", fontSize: 10.5, cursor: "pointer", padding: 0 }}
                    >
                      {t("capabilities.selectNone")}
                    </button>
                  </div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
                  {BUILTIN_TOOLS.map((tool) => {
                    const enabled = customTools.includes(tool.id);
                    return (
                      <label
                        key={tool.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          padding: "4px 6px",
                          borderRadius: 4,
                          background: enabled ? "var(--bg-app)" : "transparent",
                          border: "1px solid",
                          borderColor: enabled ? "var(--border)" : "transparent",
                          fontSize: 11,
                          color: enabled ? "var(--text)" : "var(--text-dim)",
                          cursor: "pointer",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={enabled}
                          onChange={() => toggleTool(tool.id)}
                          style={{ accentColor: "var(--accent)", margin: 0, cursor: "pointer" }}
                        />
                        <span>{tool.name}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              {/* Section 2: MCP Servers */}
              <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingTop: 6, borderTop: "1px solid var(--border-subtle)" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text)" }}>
                    {t("capabilities.customMcpTitle")} {catalog?.mcpServers ? `(${catalog.mcpServers.length - customDisabledMcp.length}/${catalog.mcpServers.length})` : ""}
                  </span>
                  {catalog?.mcpServers && catalog.mcpServers.length > 0 && (
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <button
                        type="button"
                        onClick={() => setCustomDisabledMcp([])}
                        style={{ border: "none", background: "transparent", color: "var(--accent)", fontSize: 10.5, cursor: "pointer", padding: 0 }}
                      >
                        {t("capabilities.selectAll")}
                      </button>
                      <span style={{ color: "var(--text-dim)", fontSize: 10 }}>·</span>
                      <button
                        type="button"
                        onClick={() => setCustomDisabledMcp(catalog.mcpServers.map((s) => s.name))}
                        style={{ border: "none", background: "transparent", color: "var(--text-muted)", fontSize: 10.5, cursor: "pointer", padding: 0 }}
                      >
                        {t("capabilities.selectNone")}
                      </button>
                    </div>
                  )}
                </div>

                {!catalog?.mcpServers || catalog.mcpServers.length === 0 ? (
                  <span style={{ fontSize: 10.5, color: "var(--text-dim)", fontStyle: "italic" }}>
                    {t("capabilities.noMcpFound")}
                  </span>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {catalog.mcpServers.map((server) => {
                      const isEnabled = !customDisabledMcp.includes(server.name);
                      return (
                        <label
                          key={server.name}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            padding: "4px 6px",
                            borderRadius: 4,
                            background: isEnabled ? "var(--bg-app)" : "transparent",
                            border: "1px solid",
                            borderColor: isEnabled ? "var(--border)" : "transparent",
                            fontSize: 11,
                            color: isEnabled ? "var(--text)" : "var(--text-dim)",
                            cursor: "pointer",
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <input
                              type="checkbox"
                              checked={isEnabled}
                              onChange={() => toggleMcpServer(server.name)}
                              style={{ accentColor: "var(--accent)", margin: 0, cursor: "pointer" }}
                            />
                            <span style={{ fontFamily: "var(--font-mono)" }}>{server.name}</span>
                          </div>
                          <span style={{ fontSize: 9.5, color: isEnabled ? "var(--status-success)" : "var(--text-dim)" }}>
                            {isEnabled ? "Enabled" : "Off"}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Section 3: Save as Profile Preset */}
              <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingTop: 6, borderTop: "1px solid var(--border-subtle)" }}>
                {!showSavePresetInput ? (
                  <button
                    type="button"
                    onClick={() => setShowSavePresetInput(true)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      border: "none",
                      background: "transparent",
                      color: "var(--accent)",
                      fontSize: 11,
                      cursor: "pointer",
                      padding: 0,
                    }}
                  >
                    <Plus size={12} />
                    {t("capabilities.savePresetTitle")}
                  </button>
                ) : (
                  <form onSubmit={(e) => void handleSaveAsProfilePreset(e)} style={{ display: "flex", gap: 4 }}>
                    <input
                      type="text"
                      placeholder={t("capabilities.presetNamePlaceholder")}
                      value={presetNameInput}
                      onChange={(e) => setPresetNameInput(e.target.value)}
                      autoFocus
                      style={{
                        flex: 1,
                        height: 26,
                        padding: "0 6px",
                        borderRadius: 4,
                        border: "1px solid var(--border)",
                        background: "var(--bg-app)",
                        color: "var(--text)",
                        fontSize: 11,
                      }}
                    />
                    <button
                      type="submit"
                      disabled={savingPreset || !presetNameInput.trim()}
                      style={{
                        height: 26,
                        padding: "0 8px",
                        borderRadius: 4,
                        border: "none",
                        background: "var(--accent)",
                        color: "#fff",
                        fontSize: 11,
                        cursor: "pointer",
                      }}
                    >
                      <Save size={11} style={{ marginRight: 3 }} />
                      {t("capabilities.savePresetButton")}
                    </button>
                  </form>
                )}
              </div>

              {/* Action: Apply Custom */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: 8, borderTop: "1px solid var(--border)" }}>
                <button
                  type="button"
                  onClick={() => setActiveTab("presets")}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    border: "none",
                    background: "transparent",
                    color: "var(--text-muted)",
                    fontSize: 11,
                    cursor: "pointer",
                  }}
                >
                  <ArrowLeft size={11} />
                  {t("capabilities.tabPresets")}
                </button>

                <button
                  type="button"
                  onClick={handleApplyCustom}
                  style={{
                    height: 26,
                    padding: "0 12px",
                    borderRadius: 4,
                    border: "none",
                    background: "var(--accent)",
                    color: "#fff",
                    fontSize: 11.5,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  {t("capabilities.applyCustom")}
                </button>
              </div>
            </div>
          )}

          {/* Workspace persistence toggle */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              paddingTop: 8,
              borderTop: "1px solid var(--border-subtle)",
              fontSize: 11,
              color: "var(--text-muted)",
            }}
          >
            <input
              type="checkbox"
              id="save-to-workspace"
              checked={saveToWorkspace}
              onChange={(e) => setSaveToWorkspace(e.target.checked)}
              style={{ accentColor: "var(--accent)", cursor: "pointer", margin: 0 }}
            />
            <label htmlFor="save-to-workspace" style={{ cursor: "pointer" }}>
              {t("capabilities.saveToWorkspace")}
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
