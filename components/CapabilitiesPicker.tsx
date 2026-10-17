"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { SlidersHorizontal, ChevronDown, Check, Wrench, Sparkles, MessageSquare, Terminal } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type {
  CapabilityPreset,
  SessionCapabilities,
  WorkspaceCapabilitiesCatalog,
} from "@/lib/capabilities-types";
import { CAPABILITY_PRESETS } from "@/lib/capabilities-types";

interface Props {
  cwd?: string;
  sessionId?: string;
  disabled?: boolean;
  capabilities: SessionCapabilities;
  onCapabilitiesChange: (newCaps: SessionCapabilities, saveToWorkspace?: boolean) => void;
}

export function CapabilitiesPicker({
  cwd,
  sessionId,
  disabled = false,
  capabilities,
  onCapabilitiesChange,
}: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<WorkspaceCapabilitiesCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [saveToWorkspace, setSaveToWorkspace] = useState(false);

  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Fetch catalog on mount or when popover opens
  const fetchCatalog = useCallback(async () => {
    setLoading(true);
    try {
      const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
      const res = await fetch(`/api/capabilities${q}`);
      if (res.ok) {
        const data = (await res.json()) as { catalog: WorkspaceCapabilitiesCatalog };
        if (data.catalog) setCatalog(data.catalog);
      }
    } catch {
      // Degrade silently
    } finally {
      setLoading(false);
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
      }
    };
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [open]);

  const currentPreset = capabilities.preset;

  const handleSelectPreset = (preset: CapabilityPreset) => {
    if (preset === "chat_only") {
      onCapabilitiesChange(
        { preset: "chat_only", tools: [], skills: [] },
        saveToWorkspace,
      );
    } else if (preset === "code_editor") {
      onCapabilitiesChange(
        { preset: "code_editor", tools: ["read", "edit", "write", "bash", "glob", "grep"] },
        saveToWorkspace,
      );
    } else if (preset === "full_agent") {
      onCapabilitiesChange(
        { preset: "full_agent", tools: undefined, skills: undefined, disabledMcp: [] },
        saveToWorkspace,
      );
    } else {
      onCapabilitiesChange(
        { preset: "custom", tools: capabilities.tools ?? ["read", "edit", "write", "bash"], skills: capabilities.skills },
        saveToWorkspace,
      );
    }
    setOpen(false);
  };

  const getButtonLabel = () => {
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
            width: 320,
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-dropdown, 10px)",
            boxShadow: "var(--shadow-popover, 0 8px 24px rgba(0,0,0,0.18))",
            padding: 12,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          {/* Header */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid var(--border)", paddingBottom: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
              {t("capabilities.title")}
            </span>
            <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
              {currentPreset === "chat_only"
                ? t("capabilities.savingsBadge", { tokens: "6.000" })
                : currentPreset === "code_editor"
                ? t("capabilities.savingsBadge", { tokens: "3.700" })
                : "Baseline"}
            </span>
          </div>

          {/* Presets List */}
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
                transition: "background var(--dur-fast) var(--ease-out-warm)",
              }}
              onMouseEnter={(e) => { if (currentPreset !== "chat_only") e.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={(e) => { if (currentPreset !== "chat_only") e.currentTarget.style.background = "transparent"; }}
            >
              <MessageSquare size={14} style={{ marginTop: 2, flexShrink: 0, color: "var(--status-success)" }} aria-hidden="true" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
                    {t("capabilities.presetChatOnly")}
                  </span>
                  {currentPreset === "chat_only" && <Check size={12} color="var(--accent)" aria-hidden="true" />}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                  {t("capabilities.presetChatOnlyDesc")}
                </div>
              </div>
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
                transition: "background var(--dur-fast) var(--ease-out-warm)",
              }}
              onMouseEnter={(e) => { if (currentPreset !== "code_editor") e.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={(e) => { if (currentPreset !== "code_editor") e.currentTarget.style.background = "transparent"; }}
            >
              <Terminal size={14} style={{ marginTop: 2, flexShrink: 0, color: "var(--accent)" }} aria-hidden="true" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
                    {t("capabilities.presetCodeEditor")}
                  </span>
                  {currentPreset === "code_editor" && <Check size={12} color="var(--accent)" aria-hidden="true" />}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                  {t("capabilities.presetCodeEditorDesc")}
                </div>
              </div>
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
                background: currentPreset === "full_agent" ? "var(--bg-selected, var(--bg-hover))" : "transparent",
                border: "1px solid",
                borderColor: currentPreset === "full_agent" ? "var(--accent)" : "transparent",
                textAlign: "left",
                cursor: "pointer",
                transition: "background var(--dur-fast) var(--ease-out-warm)",
              }}
              onMouseEnter={(e) => { if (currentPreset !== "full_agent") e.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={(e) => { if (currentPreset !== "full_agent") e.currentTarget.style.background = "transparent"; }}
            >
              <Sparkles size={14} style={{ marginTop: 2, flexShrink: 0, color: "var(--text-muted)" }} aria-hidden="true" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
                    {t("capabilities.presetFullAgent")}
                  </span>
                  {currentPreset === "full_agent" && <Check size={12} color="var(--accent)" aria-hidden="true" />}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                  {t("capabilities.presetFullAgentDesc")}
                </div>
              </div>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
