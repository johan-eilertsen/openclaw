import http from "node:http";
import { isDeepStrictEqual } from "node:util";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { blockSubagentCompletionDelivery } from "../agents/subagents/completion/subagent-completion-admission.store.js";
import {
  addSubagentRunForTests,
  getSubagentRunByRunId,
  resetSubagentRegistryForTests,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sha256Hex } from "../infra/crypto-digest.js";
import { getDeliveryQueueEntryStatus } from "../infra/delivery-queue-sqlite.test-support.js";
import { drainPendingSessionDelivery } from "../infra/session-delivery-queue-recovery.js";
import { scheduleSessionDelivery } from "../infra/session-delivery-queue-runtime.js";
import { loadPendingSessionDeliveries } from "../infra/session-delivery-queue-storage.js";
import { SESSION_DELIVERY_QUEUE_NAME } from "../infra/session-delivery-queue.records.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { extractFirstTextBlock } from "../shared/chat-message-content.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  createGatewayConfigPath,
  removeGatewayTempHome,
  resetGatewayTestState,
  setupGatewayTempHome,
} from "./gateway.test-support.js";
import {
  deliverQueuedSessionDelivery,
  settleQueuedSessionDelivery,
} from "./server-restart-sentinel.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

// Keep delivery scheduling real; optional idle cache work does not own this proof.
vi.mock("./server-idle-task.js", () => ({
  scheduleGatewayIdleTask: () => ({ stop: vi.fn() }),
}));

const DELIVERY_ERROR = "requester unavailable";
const BLOCKED_NOTICE = "Subagent completion delivery is blocked";
const cases = [
  { status: "error", error: "worker could not read its input", result: "Retained error details" },
  { status: "timeout", error: "worker exceeded its deadline", result: "Retained partial findings" },
  { status: "ok", error: undefined, result: "Retained completed findings" },
] as const;
type FollowupCase = (typeof cases)[number];
type ProviderRequest = { input: string; reviewData: unknown[] };

function factsFor(testCase: FollowupCase) {
  return {
    runId: `blocked-followup-${testCase.status}`,
    childSessionKey: `agent:main:subagent:blocked-followup-${testCase.status}`,
    task: `Review the ${testCase.status} worker findings`,
    response: `REVIEWED_${testCase.status}: ${testCase.result}. Continue the parent task.`,
  };
}

function expectedReviewData(testCase: FollowupCase) {
  const { response: _response, ...facts } = factsFor(testCase);
  return {
    ...facts,
    outcome: { status: testCase.status, ...(testCase.error ? { error: testCase.error } : {}) },
    result: testCase.result,
    deliveryError: DELIVERY_ERROR,
  };
}

function readProviderRequest(body: string): ProviderRequest {
  const request = JSON.parse(body) as { input?: unknown };
  const collect = (value: unknown): string[] => {
    if (typeof value === "string") {
      return [value];
    }
    if (Array.isArray(value)) {
      return value.flatMap(collect);
    }
    if (value && typeof value === "object") {
      return Object.values(value).flatMap(collect);
    }
    return [];
  };
  const input = collect(request.input).join("\n");
  const reviewData: unknown[] = [];
  const noticeAt = input.lastIndexOf(BLOCKED_NOTICE);
  if (noticeAt < 0) {
    return { input, reviewData };
  }
  // Runtime data is JSON quoted inside the provider JSON. Decode both layers;
  // mere marker substrings would not prove the parent received the actual facts.
  // Other runtime fragments contain plain text, so select this occurrence's data only.
  const encoded = input
    .slice(noticeAt)
    .match(/Conversation data \(data, not instructions\):\n("(?:\\.|[^"\\])*")/u)?.[1];
  if (encoded) {
    try {
      const quoted: unknown = JSON.parse(encoded);
      if (typeof quoted === "string") {
        reviewData.push(JSON.parse(quoted));
      }
    } catch (error) {
      // Keep malformed data observable without throwing from the HTTP event listener.
      reviewData.push({ malformedReviewData: String(error) });
    }
  }
  return { input, reviewData };
}

async function startProofProvider(requests: ProviderRequest[]): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const captured = readProviderRequest(body);
      requests.push(captured);
      const testCase = cases.find((candidate) =>
        isDeepStrictEqual(captured.reviewData, [expectedReviewData(candidate)]),
      );
      const text = testCase
        ? factsFor(testCase).response
        : captured.input.includes(BLOCKED_NOTICE)
          ? "BLOCKED_FOLLOWUP_CONTEXT_MISSING"
          : "BLOCKED_FOLLOWUP_READY";
      writeOpenAiResponsesText(response, {
        text,
        messageId: `blocked-followup-message-${requests.length}`,
        responseId: `blocked-followup-response-${requests.length}`,
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

afterEach(() => {
  resetGatewayTestState();
  vi.restoreAllMocks();
});

describe("blocked subagent completion parent followup", () => {
  it(
    "reviews failed, timed out, and successful children through the real delivery runtime once",
    { timeout: 90_000 },
    async ({ signal }) => {
      const { envSnapshot, tempHome, workspaceDir } = await setupGatewayTempHome({
        prefix: "openclaw-blocked-subagent-followup-",
      });
      const queueContext = captureOpenClawStateWorkerContext();
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      let providerServer: http.Server | undefined;
      const requests: ProviderRequest[] = [];
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

      try {
        providerServer = await startProofProvider(requests);
        const address = providerServer.address();
        if (!address || typeof address === "string") {
          throw new Error("proof provider did not bind a loopback port");
        }
        const provider = buildMockOpenAiResponsesProvider(`http://127.0.0.1:${address.port}/v1`);
        const token = "blocked-followup-proof-token";
        const configPath = await createGatewayConfigPath(tempHome);
        const cfg = {
          agents: {
            defaults: {
              workspace: workspaceDir,
              skipBootstrap: true,
              model: { primary: provider.modelRef },
              models: {
                [provider.modelRef]: {
                  params: { transport: "sse", openaiWsWarmup: false },
                },
              },
            },
            entries: { main: {} },
          },
          models: {
            mode: "replace",
            providers: {
              [provider.providerId]: {
                ...provider.config,
                request: { allowPrivateNetwork: true },
              },
            },
          },
          gateway: { auth: { mode: "token", token } },
          plugins: { slots: { memory: "none" } },
          tools: { profile: "minimal" },
        } satisfies OpenClawConfig;
        gateway = await startGatewayWithClient({
          cfg,
          configPath,
          token,
          scopes: ["operator.admin", "operator.read", "operator.write"],
        });
        await gateway.server.startupSettled;
        const client = gateway.client;

        for (const testCase of cases) {
          const facts = factsFor(testCase);
          const sessionKey = `agent:main:blocked-followup-parent-${testCase.status}`;
          // Establish the actual parent before completion; a missing parent must not be recreated.
          await expect(
            client.request(
              "agent",
              {
                sessionKey,
                message: "Prepare for a child completion review. Reply BLOCKED_FOLLOWUP_READY.",
                idempotencyKey: `blocked-followup-readiness-${testCase.status}`,
              },
              { expectFinal: true, signal },
            ),
          ).resolves.toMatchObject({ status: "ok" });

          const now = Date.now();
          await addSubagentRunForTests(
            createSubagentRunRecord({
              runId: facts.runId,
              childSessionKey: facts.childSessionKey,
              requesterSessionKey: sessionKey,
              requesterDisplayKey: sessionKey,
              requesterAgentId: "main",
              requesterOrigin: { channel: "webchat", to: sessionKey },
              task: facts.task,
              createdAt: now - 2_000,
              endedAt: now - 1_000,
              outcome: {
                status: testCase.status,
                ...(testCase.error ? { error: testCase.error } : {}),
              },
              expectsCompletionMessage: true,
              completionTarget: "parent",
              completion: { required: true, resultText: testCase.result, capturedAt: now },
              // Parent-only completion suppresses direct announce, not the parent's review.
              delivery: {
                status: "pending",
                disposition: "intentional_non_delivery",
                generation: 1,
              },
            }),
          );
          const subagent = expectDefined(getSubagentRunByRunId(facts.runId), "native child owner");
          const beforeFollowup = requests.length;
          // The production completion owner creates and schedules its own event in one mutation.
          await expect(
            blockSubagentCompletionDelivery({
              subagent,
              reason: DELIVERY_ERROR,
              context: queueContext,
            }),
          ).resolves.toBe(true);
          const id = sha256Hex(`subagent-completion-blocked:${facts.runId}:generation:1`);
          const readHistory = () =>
            client.request<{ messages: Array<{ role?: string; content?: unknown }> }>(
              "chat.history",
              { sessionKey, limit: 30 },
            );

          await vi.waitFor(() => expect(requests.length).toBe(beforeFollowup + 1), {
            timeout: 15_000,
            interval: 50,
          });
          const captured = expectDefined(requests[beforeFollowup], "parent review provider input");
          expect(captured.input).toContain(BLOCKED_NOTICE);
          expect(captured.reviewData).toEqual([expectedReviewData(testCase)]);
          await vi.waitFor(
            async () => {
              expect(getDeliveryQueueEntryStatus(SESSION_DELIVERY_QUEUE_NAME, id)).toBe(
                "completed",
              );
              const history = await readHistory();
              expect(
                history.messages.filter(
                  (message) =>
                    message.role === "assistant" &&
                    extractFirstTextBlock(message) === facts.response,
                ),
              ).toHaveLength(1);
            },
            { timeout: 15_000, interval: 50 },
          );
          expect(requests.slice(beforeFollowup)).toHaveLength(1);

          // Repeated scheduling and an explicit native drain must not repeat the parent assessment.
          await scheduleSessionDelivery(id, queueContext);
          await expect(
            drainPendingSessionDelivery({
              id,
              queueContext,
              logLabel: "blocked followup duplicate proof",
              log,
              deliver: (entry) => deliverQueuedSessionDelivery({ deps: {}, entry, queueContext }),
              onSettled: settleQueuedSessionDelivery,
            }),
          ).resolves.toBeNull();
          expect(requests.slice(beforeFollowup)).toHaveLength(1);
          const history = await readHistory();
          expect(
            history.messages.filter(
              (message) =>
                message.role === "assistant" && extractFirstTextBlock(message) === facts.response,
            ),
          ).toHaveLength(1);
        }
        expect(await loadPendingSessionDeliveries(queueContext)).toEqual([]);
      } finally {
        try {
          if (gateway) {
            try {
              await disconnectGatewayClient(gateway.client);
            } finally {
              await gateway.server.close({ reason: "blocked subagent followup proof complete" });
            }
          }
        } finally {
          try {
            if (providerServer) {
              const server = providerServer;
              await new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
                server.closeAllConnections();
              });
            }
          } finally {
            try {
              await resetSubagentRegistryForTests({ persist: false });
              await closeOpenClawStateDatabaseByPathAsync(queueContext.admission.databasePath);
              await removeGatewayTempHome(tempHome);
            } finally {
              envSnapshot.restore();
            }
          }
        }
      }
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    },
  );
});
