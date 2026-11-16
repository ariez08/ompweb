import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

function createWrapper() {
  const timeouts = [];
  const proc = {
    isAlive: true,
    sendCommand: async (command, timeout) => {
      timeouts.push(timeout);
      const error = new Error("timed out");
      error.name = "RpcCommandTimeoutError";
      throw error;
    },
  };
  return { wrapper: new AgentSessionWrapper(proc, process.cwd()), timeouts };
}

test("cached state never clears an active prompt without an authoritative reply", () => {
  const { wrapper } = createWrapper();
  wrapper.promptRunning = true;
  assert.equal(wrapper.getCachedWebState().isPromptRunning, true);
  assert.equal(wrapper.isRunning(), true);
});

test("an alive but idle wrapper reports not running", () => {
  const { wrapper } = createWrapper();
  try {
    assert.equal(wrapper.isAlive(), true);
    assert.equal(wrapper.isRunning(), false);
  } finally {
    clearTimeout(wrapper.idleTimer);
  }
});

test("bounded state read reports timeout and preserves the running session", async () => {
  const { wrapper, timeouts } = createWrapper();
  wrapper.promptRunning = true;
  try {
    await assert.rejects(
      wrapper.send({ type: "get_state" }, { stateTimeoutMs: 1000, propagateStateTimeout: true }),
      { name: "RpcCommandTimeoutError" },
    );
    assert.deepEqual(timeouts, [1000]);
    assert.equal(wrapper.isRunning(), true);
    assert.equal((await wrapper.send({ type: "get_state" })).isPromptRunning, true);
  } finally {
    clearTimeout(wrapper.idleTimer);
  }
});

test("unacknowledged prompt does not terminate a possibly running agent", async () => {
  const { wrapper } = createWrapper();
  try {
    await assert.rejects(wrapper.send({ type: "prompt", message: "continue" }), {
      code: "job_control_unacknowledged",
    });
    assert.equal(wrapper.isAlive(), true);
    assert.equal(wrapper.isRunning(), true);
  } finally {
    clearTimeout(wrapper.idleTimer);
  }
});

test("unacknowledged interrupt-and-reply does not terminate the agent", async () => {
  const { wrapper } = createWrapper();
  wrapper.promptRunning = true;
  try {
    await assert.rejects(wrapper.send({ type: "abort_and_prompt", message: "stop" }), {
      code: "job_control_unacknowledged",
    });
    assert.equal(wrapper.isAlive(), true);
    assert.equal(wrapper.isRunning(), true);
  } finally {
    clearTimeout(wrapper.idleTimer);
  }
});

test("an unacknowledged abort leaves the running state intact", async () => {
  const { wrapper } = createWrapper();
  wrapper.promptRunning = true;
  try {
    await assert.rejects(wrapper.send({ type: "abort" }), { code: "job_control_unacknowledged" });
    assert.equal(wrapper.isAlive(), true);
    assert.equal(wrapper.isRunning(), true);
  } finally {
    clearTimeout(wrapper.idleTimer);
  }
});

test("a lost prompt acknowledgement is reported uncertain without killing the agent", async () => {
  const { wrapper } = createWrapper();
  wrapper.proc.sendCommand = async () => {
    const error = new Error("stream gap");
    error.code = "rpc_stream_gap";
    throw error;
  };
  try {
    await assert.rejects(wrapper.send({ type: "prompt", message: "continue" }), {
      code: "job_control_unacknowledged",
    });
    assert.equal(wrapper.isAlive(), true);
    assert.equal(wrapper.isRunning(), true);
  } finally {
    clearTimeout(wrapper.idleTimer);
  }
});

test("transport interruption and recovery are reported without marking the run finished", () => {
  const { wrapper } = createWrapper();
  const events = [];
  wrapper.promptRunning = true;
  wrapper.onEvent((event) => events.push(event));
  try {
    wrapper.handleFrame({ type: "rpc_stream_gap" });
    wrapper.handleFrame({ type: "rpc_stream_restored" });
    assert.deepEqual(events.map((event) => [event.type, event.reason]), [
      ["notice", "rpc_stream_gap"],
      ["notice", "rpc_stream_restored"],
    ]);
    assert.equal(wrapper.isRunning(), true);
  } finally {
    clearTimeout(wrapper.idleTimer);
  }
});

test("an uncertain prompt keeps its start grace across an idle state response", async () => {
  const { wrapper } = createWrapper();
  wrapper.proc.sendCommand = async (command) => {
    if (command.type === "get_state") {
      return { sessionId: "test", isStreaming: false, isCompacting: false };
    }
    const error = new Error("timed out");
    error.name = "RpcCommandTimeoutError";
    throw error;
  };
  try {
    await assert.rejects(wrapper.send({ type: "prompt", message: "continue" }), {
      code: "job_control_unacknowledged",
    });
    assert.equal((await wrapper.send({ type: "get_state" })).isPromptRunning, true);
  } finally {
    clearTimeout(wrapper.idleTimer);
  }
});

test("unacknowledged steer, follow-up and bash abort are reported uncertain", async () => {
  for (const type of ["steer", "follow_up", "abort_bash", "abort_compaction"]) {
    const { wrapper } = createWrapper();
    wrapper.promptRunning = true;
    try {
      await assert.rejects(wrapper.send({ type, message: "continue" }), {
        code: "job_control_unacknowledged",
      });
      assert.equal(wrapper.isRunning(), true);
    } finally {
      clearTimeout(wrapper.idleTimer);
    }
  }
});
