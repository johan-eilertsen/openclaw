import { readFile, writeFile } from "node:fs/promises";
import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { resetGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import {
  createEmptyPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toCodexDynamicToolProtocolResponse } from "./dynamic-tool-execution.js";
import { createBridge, createDynamicToolCall } from "./dynamic-tools.test-support.js";

afterEach(() => {
  resetGlobalHookRunner();
  setActivePluginRegistry(createEmptyPluginRegistry());
  clearRuntimeConfigSnapshot();
});

describe("Codex tool operator hints", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps Codex apply_patch containment diagnostics operator-only", async () => {
    await withOpenClawTestState({ layout: "split", prefix: "codex-patch-hint-" }, async (state) => {
      const root = state.workspaceDir;
      const outside = state.path("outside.txt");
      await writeFile(outside, "original\n");
      const tools = createOpenClawCodingTools({
        workspaceDir: root,
        config: {},
        toolConstructionPlan: {
          includeBaseCodingTools: false,
          includeShellTools: true,
          includeChannelTools: false,
          includeOpenClawTools: false,
          includePluginTools: false,
        },
      }).filter((tool) => tool.name === "apply_patch");
      expect(tools).toHaveLength(1);
      const logError = vi.spyOn(embeddedAgentLog, "error").mockImplementation(() => {});
      const onAgentToolResult = vi.fn();
      const bridge = createBridge(tools);
      const call = createDynamicToolCall(
        "apply_patch",
        {
          input: `*** Begin Patch\n*** Update File: ${outside}\n@@\n-original\n+changed\n*** End Patch`,
        },
        "outside-patch",
      );
      const response = await bridge.handleToolCall(call, { onAgentToolResult });
      const hint = "workspace-contained by configuration";
      const message = expect.stringContaining(`Path escapes sandbox root (${root}): ${outside}`);
      const protocolResponse = toCodexDynamicToolProtocolResponse(response);
      expect(logError).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(hint));
      expect(JSON.stringify(logError.mock.calls)).not.toContain(outside);
      expect(protocolResponse).toEqual({
        contentItems: [{ type: "inputText", text: message }],
        success: false,
      });
      expect(onAgentToolResult).toHaveBeenCalledExactlyOnceWith({
        toolName: "apply_patch",
        result: expect.objectContaining({ content: [{ type: "text", text: message }] }),
        isError: true,
      });
      const modelVisibleResults = JSON.stringify([protocolResponse, onAgentToolResult.mock.calls]);
      expect(modelVisibleResults).not.toContain(hint);
      expect(modelVisibleResults).not.toContain("workspaceOnly");
      await expect(readFile(outside, "utf8")).resolves.toBe("original\n");
    });
  });
});
