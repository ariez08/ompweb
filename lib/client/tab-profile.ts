"use client";

const TAB_PROFILE_KEY = "omp_tab_profile";
const LAST_USED_PROFILE_KEY = "omp_last_used_profile";

/**
 * Returns the profile assigned to this specific browser tab.
 *
 * Tab Isolation Rules:
 * 1. If this tab already has a profile in sessionStorage, use it (tab-locked).
 * 2. If this is a newly opened tab (sessionStorage is empty):
 *    Inherit the last-used profile from localStorage (or fallback to cookie / "default"),
 *    and pin it into this tab's sessionStorage.
 */
export function getTabProfile(): string {
  if (typeof window === "undefined") return "default";
  try {
    let current = sessionStorage.getItem(TAB_PROFILE_KEY);
    if (current && current.trim()) return current.trim();

    // New tab: inherit the last used profile across tabs
    current = localStorage.getItem(LAST_USED_PROFILE_KEY);
    if (current && current.trim()) {
      sessionStorage.setItem(TAB_PROFILE_KEY, current.trim());
      return current.trim();
    }

    // Initial migration: read document cookie if present
    const match = document.cookie.match(/(?:^|;\s*)omp_web_profile=([^;]+)/);
    if (match && match[1]) {
      const fromCookie = decodeURIComponent(match[1]).trim();
      if (fromCookie) {
        sessionStorage.setItem(TAB_PROFILE_KEY, fromCookie);
        localStorage.setItem(LAST_USED_PROFILE_KEY, fromCookie);
        return fromCookie;
      }
    }
  } catch {
    // Ignore storage quota / security exceptions (e.g. sandboxed frames)
  }
  return "default";
}

/**
 * Sets the active profile for this tab and updates the last-used profile.
 */
export function setTabProfile(profile: string): void {
  if (typeof window === "undefined" || !profile) return;
  const normalized = profile.trim();
  try {
    sessionStorage.setItem(TAB_PROFILE_KEY, normalized);
    localStorage.setItem(LAST_USED_PROFILE_KEY, normalized);
  } catch {
    // Ignore storage quota / security exceptions
  }
}

let interceptorInstalled = false;

/**
 * Transparently attaches the active tab's profile to all fetch requests
 * (via x-omp-profile header) and EventSource connections (via ?profile= query param).
 * Keeps browser address bar URLs clean while giving every tab independent profile isolation.
 */
export function installTabProfileInterceptor(): void {
  if (typeof window === "undefined" || interceptorInstalled) return;
  interceptorInstalled = true;

  // 1. Wrap window.fetch to inject x-omp-profile header
  const originalFetch = window.fetch;
  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const profile = getTabProfile();
    if (!profile) return originalFetch.call(this, input, init);

    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    // Only intercept same-origin or relative /api/ endpoints
    const isApi = urlStr.startsWith("/api/") ||
      (urlStr.includes("/api/") && !urlStr.startsWith("http://") && !urlStr.startsWith("https://")) ||
      urlStr.startsWith(window.location.origin + "/api/");

    if (isApi) {
      let headers: Headers;
      if (init?.headers) {
        headers = new Headers(init.headers);
      } else if (typeof input === "object" && !(input instanceof URL) && "headers" in input && input.headers) {
        headers = new Headers(input.headers);
      } else {
        headers = new Headers();
      }

      if (!headers.has("x-omp-profile")) {
        headers.set("x-omp-profile", profile);
      }

      const nextInit: RequestInit = { ...init, headers };
      if (typeof input === "object" && !(input instanceof URL) && "url" in input) {
        return originalFetch.call(this, new Request(input, nextInit));
      }
      return originalFetch.call(this, input, nextInit);
    }

    return originalFetch.call(this, input, init);
  };

  // 2. Wrap window.EventSource to inject ?profile= query param for SSE streams
  const OriginalEventSource = window.EventSource;
  if (OriginalEventSource) {
    const EventSourceProxy = function (url: string | URL, eventSourceInitDict?: EventSourceInit) {
      const profile = getTabProfile();
      let targetUrl = url;
      if (profile) {
        try {
          const u = new URL(url, window.location.href);
          if (u.pathname.startsWith("/api/") && !u.searchParams.has("profile")) {
            u.searchParams.set("profile", profile);
            targetUrl = u.toString();
          }
        } catch {
          // Ignore URL parse error, pass through original
        }
      }
      return new OriginalEventSource(targetUrl, eventSourceInitDict);
    } as unknown as typeof EventSource;

    EventSourceProxy.prototype = OriginalEventSource.prototype;
    Object.defineProperty(EventSourceProxy, "CONNECTING", { value: OriginalEventSource.CONNECTING, writable: false });
    Object.defineProperty(EventSourceProxy, "OPEN", { value: OriginalEventSource.OPEN, writable: false });
    Object.defineProperty(EventSourceProxy, "CLOSED", { value: OriginalEventSource.CLOSED, writable: false });

    window.EventSource = EventSourceProxy;
  }
}

// Auto-install on client module load
if (typeof window !== "undefined") {
  installTabProfileInterceptor();
}
