import { existsSync } from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import * as sessionActors from "../../config/sessions/session-actor.js";
import { recordSessionParticipantInWorker } from "../../config/sessions/session-sharing-store.async.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { runOutsideStoreWriterContext } from "../../shared/store-writer-queue.js";
import {
  closeOpenClawAgentDatabasesAsync,
  getOpenClawAgentDatabaseIfOpen,
} from "../../state/openclaw-agent-db.js";
import {
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { withAgentTurnCompletion } from "./agent-runner-completion.js";
import { createReplyOperation } from "./reply-run-registry.js";
import { prepareSessionUsageUpdate } from "./session-usage.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    cleanup();
  }),
);

describe("session actor usage accounting", () => {
  type UsageUpdate = Parameters<typeof prepareSessionUsageUpdate>[0];
  async function usageSession(seed: Partial<SessionEntry> = {}, sessionKey = "agent:main:main") {
    const root = tempDirs.make("openclaw-usage-");
    const env = { OPENCLAW_STATE_DIR: root };
    const storePath = seed.incognito
      ? resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env })
      : path.join(root, "agents", "main", "sessions", "sessions.json");
    const scope = {
      agentId: "main",
      storePath,
      sessionKey,
      ...(seed.incognito ? { env } : {}),
    };
    await replaceSessionEntry(scope, { sessionId: "s1", updatedAt: 1, ...seed });
    const read = () => expectDefined(loadSessionEntry(scope), "stored session");
    return {
      scope,
      update: async (update: UsageUpdate) => {
        const entry = read();
        const operation = createReplyOperation({
          sessionId: entry.sessionId,
          sessionKey,
          resetTriggered: false,
        });
        operation.setPhase("running");
        try {
          await withAgentTurnCompletion(
            {
              ...scope,
              entry,
              operation,
              publish() {},
            },
            async (completion) => {
              if (!completion) {
                throw new Error("Missing usage completion owner");
              }
              const prepared = prepareSessionUsageUpdate({ cfg: {}, ...update });
              if (prepared) {
                completion.patch((current) => ({
                  kind: "usage",
                  update: { ...prepared.update, estimatedCostUsd: prepared.estimateCost(current) },
                  updatedAt: Date.now(),
                }));
              }
            },
          );
        } finally {
          operation.complete();
        }
      },
      read,
    };
  }

  const producingUpdate = {
    usage: { input: 120, output: 8, total: 128 },
    providerUsed: "openai",
    modelUsed: "gpt-5.6-sol",
    contextTokensUsed: 1_000_000,
    contextTokensSource: "runtime",
  } satisfies UsageUpdate;

  it("persists terminal usage through an actor rebase while participant writes queue", async () => {
    const session = await usageSession();
    const competingWrites: Promise<unknown>[] = [];
    const createActor = sessionActors.createSessionActor;
    vi.spyOn(sessionActors, "createSessionActor").mockImplementation((params) => {
      const actor = createActor(params);
      if (params.target.sessionKey === session.scope.sessionKey) {
        const complete = actor.completeTurn;
        vi.spyOn(actor, "completeTurn").mockImplementationOnce(async (...command) => {
          const recordParticipant = (promptedAt: number) =>
            recordSessionParticipantInWorker(session.scope, {
              identity: {
                type: "observation",
                pluginId: null,
                accountId: null,
                senderKind: "unknown",
                id: "gateway-client",
              },
              promptedAt,
              sessionAgentId: "main",
            });
          await recordParticipant(1);
          const pending = complete(...command);
          competingWrites.push(runOutsideStoreWriterContext(() => recordParticipant(2)));
          const outcome = await pending;
          expect(outcome).toMatchObject({
            kind: "stale-version",
            postimage: { target: actor.target },
          });
          return outcome;
        });
      }
      return actor;
    });
    try {
      await expect(session.update(producingUpdate)).resolves.toBeUndefined();
      await Promise.all(competingWrites);
      expect(session.read()).toMatchObject({ inputTokens: 120, outputTokens: 8 });
    } finally {
      await Promise.all(competingWrites);
      vi.restoreAllMocks();
    }
  });

  it("completes usage in the existing unbound native incognito owner", async () => {
    const session = await usageSession(
      { incognito: true },
      "agent:main:dashboard:incognito-native-completion",
    );
    const { scope } = session;
    const database = { agentId: scope.agentId, path: scope.storePath, env: scope.env };
    const native = expectDefined(
      getOpenClawAgentDatabaseIfOpen(database),
      "native incognito owner",
    );
    expect(captureOpenClawAgentDatabaseExecution.listIncognito(scope.env)).toEqual([]);

    await session.update(producingUpdate);

    expect(session.read()).toMatchObject({ incognito: true, inputTokens: 120, outputTokens: 8 });
    expect(getOpenClawAgentDatabaseIfOpen(database)).toBe(native);
    expect(captureOpenClawAgentDatabaseExecution.listIncognito(scope.env)).toEqual([]);
    expect(existsSync(scope.storePath)).toBe(false);
    expect(
      existsSync(resolveOpenClawAgentSqlitePath({ agentId: scope.agentId, env: scope.env })),
    ).toBe(false);
  });

  const cases: Array<{
    name: string;
    seed: Partial<SessionEntry>;
    update: UsageUpdate;
    expected: Partial<SessionEntry>;
    absent?: Array<keyof SessionEntry>;
  }> = [
    {
      name: "clears a previous complete snapshot after an interrupted response",
      seed: {
        inputTokens: 123,
        outputTokens: 45,
        cacheRead: 12,
        estimatedCostUsd: 0.25,
        totalTokens: 135,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      },
      update: {
        usage: { usageReport: { state: "unavailable" }, contextUsage: { state: "unavailable" } },
        currentContextSnapshot: { tokens: undefined },
      },
      expected: {
        usageReport: { state: "unavailable" },
        inputTokens: undefined,
        outputTokens: undefined,
        cacheRead: undefined,
        estimatedCostUsd: undefined,
        totalTokens: undefined,
        totalTokensFresh: false,
        totalTokensVersion: undefined,
      },
    },
    {
      name: "persists complete zero accounting without a price over a previous snapshot",
      seed: {
        inputTokens: 100,
        outputTokens: 20,
        cacheRead: 5,
        cacheWrite: 2,
        estimatedCostUsd: 0.5,
      },
      update: {
        usage: { input: 0, output: 0, total: 0, usageReport: { state: "available" } },
      },
      expected: {
        usageReport: { state: "available" },
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      absent: ["estimatedCostUsd"],
    },
    {
      name: "marks the prior total stale when last-call context is unavailable",
      seed: { totalTokens: 148_874, totalTokensFresh: true, totalTokensVersion: 1 },
      update: {
        usage: { input: 12, output: 15_104, cacheRead: 819_661, cacheWrite: 93_130 },
        lastCallUsage: {
          input: 12,
          output: 15_104,
          cacheRead: 819_661,
          cacheWrite: 93_130,
          contextUsage: { state: "unavailable" },
          total: 927_907,
        },
      },
      expected: {
        totalTokens: 148_874,
        totalTokensFresh: false,
        totalTokensVersion: undefined,
        inputTokens: 12,
        cacheRead: 819_661,
      },
    },
  ];
  it.each(cases)("$name", async ({ seed, update, expected, absent, name }) => {
    const session = await usageSession(seed);
    await session.update({ contextTokensUsed: 200_000, ...update });
    const stored = session.read();
    for (const [field, value] of Object.entries(expected)) {
      expect(Reflect.get(stored, field), name).toEqual(value);
    }
    for (const field of absent ?? []) {
      expect(stored, name).not.toHaveProperty(field);
    }
  });

  it("snapshots estimatedCostUsd instead of accumulating (fixes #69347)", async () => {
    const session = await usageSession({
      sessionId: "s1",
      updatedAt: Date.now(),
    });

    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: { main: {}, other: {} },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [
              {
                id: "gpt-5.4",
                name: "GPT 5.4",
                reasoning: true,
                input: ["text"],
                cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0.5 },
                contextWindow: 200_000,
                maxTokens: 8_192,
              },
            ],
          },
        },
      },
    };

    for (let commit = 0; commit < 2; commit += 1) {
      await session.update({
        cfg,
        agentDir: "/tmp/openclaw-main-agent",
        usage: { input: 2_000, output: 500, cacheRead: 1_000, cacheWrite: 200 },
        lastCallUsage: { input: 800, output: 200, cacheRead: 300, cacheWrite: 50 },
        providerUsed: "openai",
        modelUsed: "gpt-5.4",
        contextTokensUsed: 200_000,
      });
      expect(session.read().estimatedCostUsd).toBeCloseTo(0.007725, 8);
    }
  });
});
