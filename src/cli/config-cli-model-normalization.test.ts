import { afterEach, expect, it, vi } from "vitest";
import * as metadata from "../config/io.plugin-metadata.js";
import type { OpenClawConfig } from "../config/types.js";
import * as synchronousMetadata from "../plugins/plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { normalizeConfigMutationModelRefs } from "./config-cli-model-normalization.js";

afterEach(() => vi.restoreAllMocks());

it("normalizes agent model references when plugin metadata is unavailable", async () => {
  vi.spyOn(synchronousMetadata, "loadPluginMetadataSnapshot").mockImplementation(() => {
    throw new Error("Plugin metadata is unavailable");
  });
  vi.spyOn(metadata, "resolveConfigWidePluginMetadataSnapshotAsync").mockImplementation(
    async () => {
      throw new Error("Plugin metadata is unavailable");
    },
  );
  const result = await normalizeConfigMutationModelRefs({
    agents: { defaults: { model: " openai/gpt-5.4 " } },
  });
  expect(result.agents?.defaults?.model).toBe("openai/gpt-5.4");
});

it("retains manifest normalization for authored provider catalog model IDs", async () => {
  vi.spyOn(metadata, "resolveConfigWidePluginMetadataSnapshotAsync").mockResolvedValue(
    createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "normalizer",
          providers: ["demo"],
          modelIdNormalization: { providers: { demo: { prefixWhenBare: "owner" } } },
        },
      ],
    }),
  );
  const config: OpenClawConfig = {
    models: {
      providers: {
        demo: {
          baseUrl: "https://example.invalid/v1",
          models: [
            {
              id: " example ",
              name: "Example",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 8192,
              maxTokens: 4096,
            },
          ],
        },
      },
    },
  };
  const result = await normalizeConfigMutationModelRefs(config);
  expect(result.models?.providers?.demo?.models[0]?.id).toBe("owner/example");
  expect(config.models?.providers?.demo?.models[0]?.id).toBe(" example ");
});
