import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { GroupHeightCache, computeWindow } from "../lib/chat-groups.ts";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});

const { estimateProcessItemHeight } = await jiti.import("./ChatWindow.tsx");

test("expanded 154-message run with 170 tool calls bounds mounted items using shared GroupHeightCache and computeWindow", () => {
  const itemCount = 154;
  const syntheticGroups = Array.from({ length: itemCount }, (_, i) => ({
    startIdx: i,
    endIdx: i + 1,
    userIdx: i,
    finalAssistantIdx: -1,
    processIndices: [],
    tailIndices: [],
  }));
  const syntheticMessages = Array.from({ length: itemCount }, (_, i) => ({
    role: "assistant",
    content: i % 2 === 0
      ? [{ type: "toolCall", toolCallId: `call-${i}`, toolName: "bash", args: {} }]
      : [{ type: "text", text: "step progress summary line ".repeat(3) }],
  }));
  const estimator = (g) => estimateProcessItemHeight(syntheticMessages[g.startIdx]);

  const cache = new GroupHeightCache(syntheticGroups, syntheticMessages, estimator);
  assert.equal(cache.count, 154);
  assert.ok(cache.totalHeight > 10000, `totalHeight was ${cache.totalHeight}`);

  // Viewport [0, 800]: only top items are mounted
  const topWin = computeWindow(cache, 0, 800, 4);
  assert.equal(topWin.startGroup, 0);
  assert.ok(topWin.endGroup <= 16, `endGroup=${topWin.endGroup} should be bounded`);
  assert.equal(topWin.topPad, 0);
  assert.ok(topWin.bottomPad > 0);
  let topMountedHeight = 0;
  for (let i = topWin.startGroup; i < topWin.endGroup; i++) topMountedHeight += cache.height(i);
  assert.ok(Math.abs(topWin.topPad + topMountedHeight + topWin.bottomPad - cache.totalHeight) < 0.001);

  // Viewport [5000, 5800]: middle items are mounted, both pads exist
  const midWin = computeWindow(cache, 5000, 800, 4);
  assert.ok(midWin.startGroup > 0, `startGroup=${midWin.startGroup}`);
  assert.ok(midWin.endGroup < 154, `endGroup=${midWin.endGroup}`);
  const midMountedCount = midWin.endGroup - midWin.startGroup;
  assert.ok(midMountedCount <= 20, `midMountedCount=${midMountedCount} should not mount 154 items`);
  assert.ok(midWin.topPad > 0);
  assert.ok(midWin.bottomPad > 0);
  let midMountedHeight = 0;
  for (let i = midWin.startGroup; i < midWin.endGroup; i++) midMountedHeight += cache.height(i);
  assert.ok(Math.abs(midWin.topPad + midMountedHeight + midWin.bottomPad - cache.totalHeight) < 0.001);

  // Viewport [99999, 100799]: clamped to the end
  const bottomWin = computeWindow(cache, 99999, 800, 4);
  assert.equal(bottomWin.endGroup, 154);
  assert.equal(bottomWin.bottomPad, 0);
  assert.ok(bottomWin.startGroup >= 140, `bottom startGroup=${bottomWin.startGroup}`);
});

