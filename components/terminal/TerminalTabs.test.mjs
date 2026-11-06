import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { TerminalTabs, shouldAutoOpenInitialTab } = await jiti.import("./TerminalTabs.tsx");

const noop = () => {};

// TerminalTabs creates its first tab in an effect, so SSR cannot exercise
// multi-tab behavior (that needs a DOM + effect flush and lives in the
// browser E2E). These tests freeze the host's static contract: it must
// render an operable shell when open (new-tab + close affordances, queued
// run command tolerated), and stay MOUNTED but hidden when closed — an
// unmount reaps every PTY server-side while any process started in it keeps
// running with no tab attached.
test("renders the tab strip affordances when open", () => {
  const html = renderToStaticMarkup(React.createElement(TerminalTabs, {
    open: true,
    onClose: noop,
    cwd: "/repo",
  }));
  assert.match(html, /terminal\.newTab|New terminal/);
  // Per-tab close buttons only exist once tabs render (effect-driven); the
  // host-level close affordance is present immediately.
  assert.match(html, /Close Terminal/);
});

test("stays mounted but hidden when closed (panels keep their PTYs)", () => {
  const html = renderToStaticMarkup(React.createElement(TerminalTabs, {
    open: false,
    onClose: noop,
    cwd: "/repo",
  }));
  // The drawer is hidden with CSS, never unmounted: unmounting reaps each
  // PTY while anything it started keeps running detached.
  assert.match(html, /display:none/);
  assert.doesNotMatch(html, /display:flex;flex-direction:column;height:\d+px/);
});

test("accepts a queued run command without crashing (routing happens in effects)", () => {
  const html = renderToStaticMarkup(React.createElement(TerminalTabs, {
    open: true,
    onClose: noop,
    cwd: "/repo",
    runCommand: { text: "npm test", nonce: 7 },
    onRunCommandConsumed: noop,
  }));
  assert.match(html, /terminal\.newTab|New terminal/);
});

test("accepts an onRunCommandConsumed callback without crashing", () => {
  const html = renderToStaticMarkup(React.createElement(TerminalTabs, {
    open: true,
    onClose: noop,
    cwd: "/repo",
    runCommand: { text: "git status", nonce: 3 },
    onRunCommandConsumed: () => { throw new Error("must not fire during SSR"); },
  }));
  assert.match(html, /terminal\.newTab|New terminal/);
});

test("initial drawer opening creates one shell but a user-closed final tab stays empty", () => {
  const base = { open: true, tabsLength: 0, activeId: null };
  assert.equal(shouldAutoOpenInitialTab({ ...base, initialized: false, userClosedAll: false }), true);
  assert.equal(shouldAutoOpenInitialTab({ ...base, initialized: true, userClosedAll: false }), false);
  assert.equal(shouldAutoOpenInitialTab({ ...base, initialized: true, userClosedAll: true }), false);
});

test("keeps the close confirmation dormant until a tab with a live PTY is closed", () => {
  // SSR renders the confirm dialog closed (pendingClose === null); the copy it
  // will show lives in the dictionary, so a missing translation would ship a
  // bare key into a destructive prompt.
  const html = renderToStaticMarkup(React.createElement(TerminalTabs, {
    open: true,
    onClose: noop,
    cwd: "/repo",
  }));
  assert.doesNotMatch(html, /role="dialog"/);
  const en = JSON.parse(readFileSync(new URL("../../lib/i18n/locales/en.json", import.meta.url), "utf8"));
  for (const key of ["closeConfirmTitle", "closeConfirmBody", "closeConfirmAction", "closeConfirmCancel"]) {
    assert.equal(typeof en[`terminal.${key}`], "string", `missing terminal.${key}`);
  }
});
