import fs from "node:fs";
import path from "node:path";
import { build } from "tsdown";
import { describe, expect, it } from "vitest";
import buildConfigs from "../../tsdown.config.ts";
import { createScriptTestHarness } from "./test-helpers.js";

const configs = Array.isArray(buildConfigs) ? buildConfigs : [buildConfigs];
const { createTempDir } = createScriptTestHarness();
const handlersModule = "/src/state/openclaw-state-read-handlers.ts";

describe("state read worker artifacts", () => {
  it.each([
    ["state/openclaw-state-read.worker", ".js", handlersModule],
    ["worker/openclaw-state-read.worker", ".mjs", handlersModule],
    ["infra/sqlite-readonly-location.worker", ".js", "/src/state/openclaw-state-read-snapshot.ts"],
  ])("keeps unrelated handlers out of %s startup", async (entryName, extension, deferredModule) => {
    const selected = configs.find(
      (config) =>
        typeof config.entry === "object" &&
        config.entry !== null &&
        Object.hasOwn(config.entry, entryName),
    );
    if (!selected) {
      throw new Error(`Missing state read worker build config: ${entryName}`);
    }
    const { bundles } = await build({
      ...selected,
      config: false,
      outDir: fs.realpathSync(createTempDir("openclaw-state-read-build-")),
      dts: false,
      logLevel: "silent",
    });
    try {
      const chunks = new Map(
        bundles.flatMap((bundle) =>
          bundle.chunks
            .filter((chunk) => chunk.type === "chunk")
            .map((chunk) => [chunk.fileName, chunk] as const),
        ),
      );
      const queue = [`${entryName}${extension}`];
      const visited = new Set<string>();
      const startupModules = new Set<string>();
      for (const name of queue) {
        if (visited.has(name)) {
          continue;
        }
        visited.add(name);
        const chunk = chunks.get(name);
        if (!chunk) {
          throw new Error(`Missing state read worker chunk: ${name}`);
        }
        for (const [id, module] of Object.entries(chunk.modules)) {
          if (module.renderedLength > 0) {
            startupModules.add(id.replaceAll("\\", "/"));
          }
        }
        for (const specifier of chunk.imports) {
          const target = specifier.startsWith(".")
            ? path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier))
            : specifier;
          if (chunks.has(target)) {
            queue.push(target);
          }
        }
      }
      expect([...startupModules].some((id) => id.endsWith(deferredModule))).toBe(false);
      expect(
        [...chunks.values()].some((chunk) =>
          Object.entries(chunk.modules).some(
            ([id, module]) =>
              module.renderedLength > 0 && id.replaceAll("\\", "/").endsWith(deferredModule),
          ),
        ),
      ).toBe(true);
    } finally {
      for (const bundle of bundles) {
        await bundle[Symbol.asyncDispose]();
      }
    }
  });
});
