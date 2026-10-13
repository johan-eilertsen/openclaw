import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { minimatch } from "minimatch";
import { BUNDLED_PLUGIN_TEST_GLOB } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "vitest/node";
import { normalizeConfigPath } from "./helpers/vitest-config-paths.js";
import { createAgentsCoreIsolatedVitestConfig } from "./vitest/vitest.agents-core-isolated.config.ts";
import { createAgentsCoreVitestConfig } from "./vitest/vitest.agents-core.config.ts";
import { agentVitestProjectOwners } from "./vitest/vitest.agents-paths.mjs";
import { createAgentsSpawnProductionBoundaryVitestConfig } from "./vitest/vitest.agents-spawn-production-boundary.config.ts";
import { createAgentsVitestConfig } from "./vitest/vitest.agents.config.ts";
import { createCronVitestConfig } from "./vitest/vitest.cron.config.ts";
import { databaseWorkerCoreTestFiles } from "./vitest/vitest.database-worker-core-paths.mjs";
import { createDatabaseWorkerWatchVitestConfig } from "./vitest/vitest.database-worker-watch.config.ts";
import { databaseWorkerExtensionTestFiles } from "./vitest/vitest.extension-database-workers-paths.mjs";
import { createExtensionDatabaseWorkersVitestConfig } from "./vitest/vitest.extension-database-workers.config.ts";
import { createExtensionMatrixVitestConfig } from "./vitest/vitest.extension-matrix.config.ts";
import { diagnosticForksPool } from "./vitest/vitest.forks-pool.ts";
import { createInfraVitestConfig } from "./vitest/vitest.infra.config.ts";
import { createPluginsVitestConfig } from "./vitest/vitest.plugins.config.ts";
import { createRuntimeConfigVitestConfig } from "./vitest/vitest.runtime-config.config.ts";
import { createScopedVitestConfig } from "./vitest/vitest.scoped-config.ts";
import { sharedVitestConfig } from "./vitest/vitest.shared.config.ts";
import { isUnitFastTestFile } from "./vitest/vitest.unit-fast-paths.mjs";
import { createWizardVitestConfig } from "./vitest/vitest.wizard.config.ts";

const EXTENSIONS_CHANNEL_GLOB = ["extensions", "channel", "**"].join("/");

function matchingExcludePatterns(patterns: string[], file: string): string[] {
  return patterns.filter((pattern) => path.matchesGlob(file, pattern));
}

function requireTestConfig<T extends { test?: unknown }>(config: T): NonNullable<T["test"]> {
  if (!config.test) {
    throw new Error("expected scoped vitest test config");
  }
  return config.test as NonNullable<T["test"]>;
}

function expectForkedNonIsolatedRunner(
  config: { test?: { pool?: unknown; isolate?: unknown; runner?: unknown } },
  pool: "forks" | typeof diagnosticForksPool = "forks",
) {
  const testConfig = requireTestConfig(config);
  expect(testConfig.pool).toBe(pool);
  expect(testConfig.isolate).toBe(false);
  expect(normalizeConfigPath(testConfig.runner)).toBe("test/non-isolated-runner.ts");
}

describe("createScopedVitestConfig", () => {
  it("relativizes scoped include and exclude patterns to the configured dir", () => {
    const config = createScopedVitestConfig([BUNDLED_PLUGIN_TEST_GLOB], {
      dir: "extensions",
      env: {},
      exclude: [EXTENSIONS_CHANNEL_GLOB, "dist/**"],
    });
    const testConfig = requireTestConfig(config);

    expect(testConfig.include).toEqual(["**/*.test.ts"]);
    expect(testConfig.exclude).toContain("channel/**");
    expect(testConfig.exclude).toContain("dist/**");
  });
});

describe("scoped vitest configs", () => {
  const defaultInfraConfig = createInfraVitestConfig({});
  const defaultRuntimeConfig = createRuntimeConfigVitestConfig({});
  const defaultAgentsCoreConfig = createAgentsCoreVitestConfig({});
  const defaultAgentsCoreIsolatedConfig = createAgentsCoreIsolatedVitestConfig({});
  const defaultAgentsSpawnProductionBoundaryConfig =
    createAgentsSpawnProductionBoundaryVitestConfig({});
  const defaultPluginsConfig = createPluginsVitestConfig({});
  const defaultWizardConfig = createWizardVitestConfig({});

  it("keeps native SQLite runtime config tests in forked workers", () => {
    expectForkedNonIsolatedRunner(defaultRuntimeConfig);
  });

  it("isolates agent suites with conflicting shared-module mocks", () => {
    const sharedConfig = requireTestConfig(defaultAgentsCoreConfig);
    const isolatedConfig = requireTestConfig(defaultAgentsCoreIsolatedConfig);
    const productionBoundaryConfig = requireTestConfig(defaultAgentsSpawnProductionBoundaryConfig);

    const scopedIsolatedFiles = agentVitestProjectOwners.coreIsolated.include.map((file) =>
      file.replace("src/agents/", ""),
    );
    expect(sharedConfig.exclude).toEqual(expect.arrayContaining(scopedIsolatedFiles));
    expect(isolatedConfig.include).toEqual(scopedIsolatedFiles);
    for (const file of agentVitestProjectOwners.coreIsolated.include) {
      expect(isUnitFastTestFile(file), file).toBe(false);
      expect(
        matchingExcludePatterns(isolatedConfig.exclude ?? [], file.replace("src/agents/", "")),
        file,
      ).toEqual([]);
    }
    expect(isolatedConfig.isolate).toBe(true);
    expect(isolatedConfig.runner).toBeUndefined();
    expect(productionBoundaryConfig.include).toEqual(
      agentVitestProjectOwners.spawnProductionBoundary.include.map((file) =>
        file.replace("src/agents/", ""),
      ),
    );
    expect(productionBoundaryConfig.fileParallelism).toBe(false);
    expect(productionBoundaryConfig.isolate).toBe(true);
    expect(productionBoundaryConfig.pool).toBe("forks");
    expect(productionBoundaryConfig.runner).toBeUndefined();
  });

  it("keeps infra and database worker consumers rooted at the repository", () => {
    const testConfig = requireTestConfig(defaultInfraConfig);
    expect(testConfig.pool).toBe(diagnosticForksPool);
    expect(testConfig.isolate).toBe(true);
    expect(testConfig.runner).toBeUndefined();
    expect(testConfig.dir).toBe(process.cwd());
    expect(testConfig.include).toEqual(["src/infra/**/*.test.ts", ...databaseWorkerCoreTestFiles]);
    const imageAuthFile = "src/agents/tools/image-generate-tool.auth.test.ts";
    expect(testConfig.include).toContain(imageAuthFile);
    expect(agentVitestProjectOwners.tools.exclude).toContain(imageAuthFile);
    const recoveryFile = "src/wizard/setup.inference-recovery.integration.test.ts";
    expect(testConfig.include?.filter((file) => file === recoveryFile)).toEqual([recoveryFile]);
    expect(requireTestConfig(defaultWizardConfig).exclude).toContain(
      "wizard/setup.inference-recovery.integration.test.ts",
    );
    for (const file of databaseWorkerCoreTestFiles) {
      expect(matchingExcludePatterns(testConfig.exclude ?? [], file), file).toEqual([]);
    }
  });

  it.each([
    {
      root: "src/agents",
      createOwner: createAgentsVitestConfig,
      workerFiles: databaseWorkerCoreTestFiles,
      names: ["agents", "infra"],
      existing: "src/agents/memory-write-provenance.test.ts",
      createWorker: createInfraVitestConfig,
    },
    {
      root: "extensions/matrix",
      createOwner: createExtensionMatrixVitestConfig,
      workerFiles: databaseWorkerExtensionTestFiles,
      names: ["extension-matrix", "extension-database-workers"],
      existing: "extensions/matrix/src/matrix/client/storage.test.ts",
      createWorker: createExtensionDatabaseWorkersVitestConfig,
    },
  ])(
    "discovers current and new $root watch files once across database owners",
    async ({ root, createOwner, workerFiles, names, existing, createWorker }) => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-worker-watch-"));
      try {
        const includeFile = path.join(tempDir, "include.json");
        fs.writeFileSync(includeFile, JSON.stringify([`${root}/**/*.test.ts`]));
        const env = { OPENCLAW_VITEST_INCLUDE_FILE: includeFile };
        const owner = createOwner(env);
        const aggregate = createDatabaseWorkerWatchVitestConfig(
          owner,
          workerFiles.filter((file) => file.startsWith(`${root}/`)),
          env,
        );
        const resolved = await resolveConfig({ config: false }, aggregate);
        const projects = resolved.test.resolvedProjects.map(({ projectConfig }) => projectConfig);
        const resolvedOwner = await resolveConfig({ config: false }, owner);
        expect(resolved.test.reporters).toEqual(resolvedOwner.test.reporters);
        const { exclude: exclusions, ...coverage } = resolved.test.coverage;
        const { exclude: ownerExclusions, ...ownerCoverage } = resolvedOwner.test.coverage;
        expect(coverage).toEqual(ownerCoverage);
        expect(exclusions).toEqual(expect.arrayContaining(ownerExclusions));
        expect(
          exclusions
            .filter((pattern) => !ownerExclusions.includes(pattern))
            .every((pattern) => /\.test\.[cm]?[jt]sx?$/u.test(pattern)),
        ).toBe(true);
        expect(projects.map((project) => project.name)).toEqual(names);
        expect(projects.map((project) => project.pool)).toEqual([
          process.platform === "win32" ? "forks" : "threads",
          diagnosticForksPool.name,
        ]);
        expect(projects[0]?.setupFiles).toEqual(owner.test?.setupFiles);
        expect(projects[0]?.maxWorkers).toBe(owner.test?.maxWorkers);
        const workerConfig = await resolveConfig(
          { config: false },
          createWorker({ ...env, OPENCLAW_VITEST_INCLUDE_FILE: undefined }),
        );
        expect(projects[1]?.maxWorkers).toBe(workerConfig.test.maxWorkers);

        const discover = (fixtureRoot: string) =>
          projects.flatMap((project) => {
            const scopedDir = path.relative(process.cwd(), project.dir);
            const exclude = project.exclude.map((pattern) =>
              path.isAbsolute(pattern) ? path.relative(project.dir, pattern) : pattern,
            );
            return fs
              .globSync(project.include, {
                cwd: path.join(fixtureRoot, scopedDir),
                exclude,
              })
              .map((file) => path.join(scopedDir, file).replaceAll("\\", "/"));
          });
        const current = discover(process.cwd());
        expect(new Set(current).size).toBe(current.length);
        for (const file of workerFiles.filter((candidate) => candidate.startsWith(`${root}/`))) {
          expect(current).toContain(file);
        }

        const fixtureRoot = path.join(tempDir, "repo");
        fs.mkdirSync(path.dirname(path.join(fixtureRoot, existing)), { recursive: true });
        fs.writeFileSync(path.join(fixtureRoot, existing), "// discovery only\n");
        expect(discover(fixtureRoot)).toEqual([existing]);
        const added = `${root}/new-watch-consumer.test.ts`;
        fs.writeFileSync(path.join(fixtureRoot, added), "// discovery only\n");
        expect(discover(fixtureRoot).toSorted()).toEqual([existing, added].toSorted());

        fs.writeFileSync(includeFile, JSON.stringify([existing]));
        const narrowed = createDatabaseWorkerWatchVitestConfig(
          createOwner(env),
          workerFiles.filter((file) => file.startsWith(`${root}/`)),
          env,
        );
        const narrowedConfig = await resolveConfig({ config: false }, narrowed);
        const workerProject = narrowedConfig.test.resolvedProjects[1]?.projectConfig;
        expect(workerProject?.include).toEqual([
          path.relative(workerProject!.dir, path.resolve(existing)),
        ]);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it("keeps cron scoped while honoring shared workers", () => {
    const maxWorkers = 8;
    const original = sharedVitestConfig.test;
    try {
      sharedVitestConfig.test = {
        ...original,
        maxWorkers,
        fileParallelism: maxWorkers > 1,
      };
      const config = createCronVitestConfig({});
      const testConfig = requireTestConfig(config);
      expect(testConfig.dir).toBe(path.join(process.cwd(), "src"));
      expect(testConfig.include).toEqual(["cron/**/*.test.ts"]);
      expectForkedNonIsolatedRunner(config);
      expect(testConfig.maxWorkers).toBe(maxWorkers);
      expect(testConfig.fileParallelism).toBe(maxWorkers > 1);
    } finally {
      sharedVitestConfig.test = original;
    }
  });

  it("keeps plugin source forks and native-loader forks on their own loaders", async () => {
    const testConfig = requireTestConfig(defaultPluginsConfig);
    expect(testConfig.dir).toBe(path.join(process.cwd(), "src", "plugins"));
    expect(testConfig.include).toEqual(["**/*.test.ts"]);
    expect(testConfig.exclude).toContain("contracts/**");
    const resolved = await resolveConfig({ config: false }, defaultPluginsConfig);
    const projects = resolved.test.resolvedProjects.map(({ projectConfig }) => projectConfig);
    expect(
      projects.map((project) => ({
        name: project.name,
        pool: project.pool,
        execArgv: project.execArgv,
      })),
    ).toEqual([
      {
        name: "plugins",
        pool: "forks",
        execArgv: [
          ...(process.versions.bun
            ? ["--tsconfig-override", path.join(process.cwd(), "tsconfig.json")]
            : ["--import", expect.any(String)]),
          `--import=${new URL("./vitest/vitest.jsdom-preload.mts", import.meta.url).href}`,
        ],
      },
      {
        name: "plugins-native-loader",
        pool: "forks",
        execArgv: process.versions.bun ? ["--no-install"] : [],
      },
    ]);
    for (const file of [
      "loader.lazy-alias.test.ts",
      "plugin-module-loader-cache.source-prescan.test.ts",
      "plugin-sdk-native-resolver.test.ts",
      "sdk-alias.test.ts",
    ]) {
      expect(
        projects
          .filter(
            (project) =>
              project.include.some((pattern) => minimatch(file, pattern)) &&
              !project.exclude.some((pattern) => minimatch(file, pattern)),
          )
          .map((project) => project.name),
      ).toEqual(["plugins-native-loader"]);
    }
  });
});
