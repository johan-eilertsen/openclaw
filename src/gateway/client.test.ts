import { Buffer } from "node:buffer";
import type { ProxylineOptions } from "@openclaw/proxyline";
// Gateway client tests cover WebSocket protocol negotiation, auth persistence,
// proxy bypass setup, command dispatch, reconnect, and error handling.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import {
  MIN_NODE_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "../../packages/gateway-protocol/src/index.js";
import { signDevicePayload as signDevicePayloadWithKey } from "../infra/device-identity.js";
import { stopMockedProxylineHandles } from "../infra/net/proxy/proxyline.test-support.js";
import { captureEnv } from "../test-utils/env.js";
import type { GatewayClientOptions } from "./client.js";
import {
  createAuthFailureMessage,
  createClientTestIdentity,
  firstMockArg,
  waitForFast,
} from "./client.test-support.js";

type MockLoggingConfig = {
  redactPatterns?: string[];
  redactSensitive?: "off" | "tools";
};

const wsInstances = vi.hoisted((): MockWebSocket[] => []);
const wsConstructorObservers = vi.hoisted((): Array<(url: string, options: unknown) => void> => []);
const clearDeviceAuthTokenMock = vi.hoisted(() => vi.fn());
const clearOriginDeviceTokenMock = vi.hoisted(() => vi.fn());
const loadDeviceAuthTokenMock = vi.hoisted(() => vi.fn());
const loadDeviceAuthTokenReadOnlyMock = vi.hoisted(() => vi.fn());
const loadOriginDeviceTokenMock = vi.hoisted(() => vi.fn());
const loadOriginDeviceTokenReadOnlyMock = vi.hoisted(() => vi.fn());
const storeDeviceAuthTokenMock = vi.hoisted(() => vi.fn());
const storeOriginDeviceTokenMock = vi.hoisted(() => vi.fn());
const logDebugMock = vi.hoisted(() => vi.fn());
const logErrorMock = vi.hoisted(() => vi.fn());
const readLoggingConfigMock = vi.hoisted(() =>
  vi.fn<() => MockLoggingConfig | undefined>(() => undefined),
);
const { installGlobalProxyMock, proxylineStopMock } = vi.hoisted(() => {
  const proxylineStopMockLocal = vi.fn();
  return {
    proxylineStopMock: proxylineStopMockLocal,
    installGlobalProxyMock: vi.fn((_options: ProxylineOptions) => ({
      active: true,
      createNodeAgent: vi.fn(),
      createUndiciDispatcher: vi.fn(),
      createWebSocketAgent: vi.fn(),
      explain: vi.fn(),
      mode: "managed",
      stop: proxylineStopMockLocal,
      withBypass: vi.fn(),
    })),
  };
});

type WsEvent = "open" | "message" | "close" | "error";
type WsEventHandlers = {
  open: () => void;
  message: (data: string | Buffer) => void;
  close: (code: number, reason: Buffer) => void;
  error: (err: unknown) => void;
};

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  private openHandlers: WsEventHandlers["open"][] = [];
  private messageHandlers: WsEventHandlers["message"][] = [];
  private closeHandlers: WsEventHandlers["close"][] = [];
  private errorHandlers: WsEventHandlers["error"][] = [];
  readonly sent: string[] = [];
  closeCalls = 0;
  lastClose: { code?: number; reason?: string } | null = null;
  terminateCalls = 0;
  autoCloseOnClose = true;
  readyState = MockWebSocket.CONNECTING;
  readonly options: unknown;

  constructor(_url: string, options?: unknown) {
    this.options = options;
    wsInstances.push(this);
    for (const observer of wsConstructorObservers) {
      observer(_url, options);
    }
  }

  on(event: "open", handler: WsEventHandlers["open"]): void;
  on(event: "message", handler: WsEventHandlers["message"]): void;
  on(event: "close", handler: WsEventHandlers["close"]): void;
  on(event: "error", handler: WsEventHandlers["error"]): void;
  on(event: WsEvent, handler: WsEventHandlers[WsEvent]): void {
    switch (event) {
      case "open":
        this.openHandlers.push(handler as WsEventHandlers["open"]);
        return;
      case "message":
        this.messageHandlers.push(handler as WsEventHandlers["message"]);
        return;
      case "close":
        this.closeHandlers.push(handler as WsEventHandlers["close"]);
        return;
      case "error":
        this.errorHandlers.push(handler as WsEventHandlers["error"]);
      default:
    }
  }

  close(code?: number, reason?: string): void {
    this.closeCalls += 1;
    this.lastClose = { code, reason };
    this.readyState = MockWebSocket.CLOSING;
    if (this.autoCloseOnClose) {
      this.emitClose(code ?? 1000, reason ?? "");
    }
  }

  terminate(): void {
    this.terminateCalls += 1;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  emitOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    for (const handler of this.openHandlers) {
      handler();
    }
  }

  emitMessage(data: string): void {
    for (const handler of this.messageHandlers) {
      handler(data);
    }
  }

  emitClose(code: number, reason: string): void {
    this.readyState = MockWebSocket.CLOSED;
    for (const handler of this.closeHandlers) {
      handler(code, Buffer.from(reason));
    }
  }

  emitError(error: unknown): void {
    for (const handler of this.errorHandlers) {
      handler(error);
    }
  }
}

vi.mock("../../packages/gateway-client/src/websocket.js", () => ({
  WebSocket: MockWebSocket,
}));

vi.mock("../infra/net/proxyline-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/net/proxyline-runtime.js")>()),
  loadProxyline: () => ({ installGlobalProxy: installGlobalProxyMock }),
}));

vi.mock("../infra/device-auth-store.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/device-auth-store.js")>(
    "../infra/device-auth-store.js",
  );
  return {
    ...actual,
    loadDeviceAuthToken: (...args: unknown[]) => loadDeviceAuthTokenMock(...args),
    loadDeviceAuthTokenReadOnly: (...args: unknown[]) => loadDeviceAuthTokenReadOnlyMock(...args),
    loadOriginDeviceToken: (...args: unknown[]) => loadOriginDeviceTokenMock(...args),
    loadOriginDeviceTokenReadOnly: loadOriginDeviceTokenReadOnlyMock,
    storeDeviceAuthToken: (...args: unknown[]) => storeDeviceAuthTokenMock(...args),
    storeOriginDeviceToken: (...args: unknown[]) => storeOriginDeviceTokenMock(...args),
    clearDeviceAuthToken: (...args: unknown[]) => clearDeviceAuthTokenMock(...args),
    clearOriginDeviceToken: (...args: unknown[]) => clearOriginDeviceTokenMock(...args),
  };
});

vi.mock("../logger.js", async () => {
  const actual = await vi.importActual<typeof import("../logger.js")>("../logger.js");
  return {
    ...actual,
    logDebug: (...args: unknown[]) => logDebugMock(...args),
    logError: (...args: unknown[]) => logErrorMock(...args),
  };
});

vi.mock("../logging/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../logging/config.js")>("../logging/config.js");
  return {
    ...actual,
    readLoggingConfig: () => readLoggingConfigMock(),
  };
});

type GatewayClientModule = typeof import("./client.js");
type GatewayClientInstance = InstanceType<GatewayClientModule["GatewayClient"]>;

let GatewayClient: GatewayClientModule["GatewayClient"];

const defaultIdentity = createClientTestIdentity("fixture-client-device");

function createClient(options: GatewayClientOptions): GatewayClientInstance {
  return new GatewayClient({ deviceIdentity: defaultIdentity, ...options });
}

async function loadGatewayClientModule() {
  vi.resetModules();
  ({ GatewayClient } = await import("./client.js"));
}

function getLatestWs(): MockWebSocket {
  const ws = wsInstances.at(-1);
  if (!ws) {
    throw new Error("missing mock websocket instance");
  }
  return ws;
}

const requireRecord = createRequireRecord("record", "expected-label-object");

function expectRecordFields(
  value: unknown,
  expected: Record<string, unknown>,
  label: string,
): Record<string, unknown> {
  const record = requireRecord(value, label);
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], `${label}.${key}`).toEqual(expectedValue);
  }
  return record;
}

function createClientWithIdentity(
  deviceId: string,
  onClose: (code: number, reason: string) => void,
  overrides: Partial<ConstructorParameters<typeof GatewayClient>[0]> = {},
) {
  return createClient({
    url: "ws://127.0.0.1:18789",
    deviceIdentity: createClientTestIdentity(deviceId),
    onClose,
    ...overrides,
  });
}

function expectSecurityConnectError(
  onConnectError: ReturnType<typeof vi.fn>,
  params?: { expectTailscaleHint?: boolean },
) {
  const error = firstMockArg(onConnectError, "connect error") as Error;
  expect(error.message).toContain("SECURITY ERROR");
  expect(error.message).toContain("openclaw doctor --fix");
  if (params?.expectTailscaleHint) {
    expect(error.message).toContain("Tailscale Serve/Funnel");
  }
}

beforeAll(loadGatewayClientModule);

beforeEach(() => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  logDebugMock.mockClear();
  logErrorMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GatewayClient security checks", () => {
  const envSnapshot = captureEnv([
    "OPENCLAW_ALLOW_INSECURE_PRIVATE_WS",
    "OPENCLAW_PROXY_ACTIVE",
    "OPENCLAW_PROXY_LOOPBACK_MODE",
    "OPENCLAW_PROXY_CA_FILE",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
    "NO_PROXY",
    "no_proxy",
  ]);

  beforeEach(() => {
    envSnapshot.restore();
    delete process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS;
    delete process.env.OPENCLAW_PROXY_ACTIVE;
    delete process.env.OPENCLAW_PROXY_LOOPBACK_MODE;
    delete process.env.HTTP_PROXY;
    installGlobalProxyMock.mockClear();
    proxylineStopMock.mockClear();
    wsInstances.length = 0;
    wsConstructorObservers.length = 0;
  });

  afterEach(async () => {
    envSnapshot.restore();
    delete process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS;
    delete process.env.OPENCLAW_PROXY_ACTIVE;
    delete process.env.OPENCLAW_PROXY_LOOPBACK_MODE;
    delete process.env.HTTP_PROXY;
    stopMockedProxylineHandles(installGlobalProxyMock.mock.results);
    const { getActiveManagedProxyUrl } = await import("../infra/net/proxy/active-proxy-state.js");
    expect(getActiveManagedProxyUrl()).toBeUndefined();
    wsConstructorObservers.length = 0;
  });

  it.each([
    { url: "ws://remote.example.com:18789", allowed: false },
    { url: "ws://127.example.com:18789", allowed: false },
    { url: "ws://127.0.0.1:18789", allowed: true, direct: true },
    { url: "ws://[::ffff:127.0.0.1]:18789", allowed: true },
    { url: "ws://192.168.1.100:18789", allowed: true },
    { url: "ws://openclaw-gateway.ai:18789", allowed: true, allowInsecure: true },
  ])("enforces the transport policy for $url", ({ url, allowed, direct, allowInsecure }) => {
    if (allowInsecure) {
      process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS = "1";
    }
    const onConnectError = vi.fn();
    const client = createClient({ url, onConnectError });

    expect(client.start()).toBeUndefined();
    expect(wsInstances).toHaveLength(allowed ? 1 : 0);
    if (allowed) {
      expect(onConnectError).not.toHaveBeenCalled();
      if (direct) {
        expect(getLatestWs().options).not.toHaveProperty("agent");
      }
    } else {
      expectSecurityConnectError(onConnectError, {
        expectTailscaleHint: url !== "not-a-valid-url",
      });
    }
    client.stop();
  });

  it("installs inherited loopback routing before WebSocket construction and forwards errors", () => {
    process.env.OPENCLAW_PROXY_ACTIVE = "1";
    process.env.OPENCLAW_PROXY_LOOPBACK_MODE = "gateway-only";
    process.env.HTTP_PROXY = "http://127.0.0.1:3128";
    const onConnectError = vi.fn();
    const bypassDecisions: Array<boolean | undefined> = [];
    wsConstructorObservers.push((url) => {
      const policy = installGlobalProxyMock.mock.lastCall?.[0].bypassPolicy;
      bypassDecisions.push(
        policy?.({ url, surface: "websocket" }),
        policy?.({ url: "wss://external.example/", surface: "websocket" }),
      );
    });
    const client = createClient({
      url: "ws://127.0.0.1:18789",
      onConnectError,
    });

    client.start();

    expect(bypassDecisions).toEqual([true, false]);
    const ws = getLatestWs();
    expect(onConnectError).not.toHaveBeenCalled();
    ws.emitError(new Error("loopback connection failed"));

    expect(onConnectError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "loopback connection failed" }),
    );
    client.stop();
  });

  it("blocks ws:// loopback addresses when active proxy loopbackMode is block", async () => {
    const { startProxy, stopProxy } = await import("../infra/net/proxy/proxy-lifecycle.js");
    const handle = await startProxy({
      proxyUrl: "http://127.0.0.1:3128",
      loopbackMode: "block",
    });
    const onConnectError = vi.fn();
    const client = createClient({
      url: "ws://127.0.0.1:18789",
      onConnectError,
    });

    try {
      expect(() => client.start()).toThrow("blocked by proxy.loopbackMode");
      expect(wsInstances.length).toBe(0);
    } finally {
      client.stop();
      await stopProxy(handle);
    }
  });
});

describe("GatewayClient close handling", () => {
  beforeEach(() => {
    wsInstances.length = 0;
    clearDeviceAuthTokenMock.mockClear();
    clearDeviceAuthTokenMock.mockImplementation(() => undefined);
  });

  it.each([
    {
      reason: "unauthorized: DEVICE token mismatch (rotate/reissue device token)",
      clear: "success",
    },
    { reason: "unauthorized: device token mismatch", clear: "failure" },
    { reason: "unauthorized: device token mismatch", clear: "none", token: "shared-token" },
  ])("contains close cleanup failures: %j", ({ reason, clear, token }) => {
    if (clear === "failure") {
      clearDeviceAuthTokenMock.mockImplementation(() => {
        throw new Error("disk unavailable");
      });
    }
    const onClose = vi.fn();
    const env = { OPENCLAW_HOME: "/tmp/custom-openclaw-home" };
    const client = createClientWithIdentity("dev-1", onClose, { env, token });
    client.start();
    expect(getLatestWs().emitClose(1008, reason)).toBeUndefined();
    expect(onClose).toHaveBeenCalledWith(1008, reason, {
      phase: "pre-hello",
      socketOpened: false,
      transportValidated: false,
      connectRequestSent: false,
      transientPreHelloCleanClose: false,
    });
    if (clear === "none") {
      expect(clearDeviceAuthTokenMock).not.toHaveBeenCalled();
    } else if (clear === "failure") {
      expect(logDebugMock).toHaveBeenCalledWith(
        expect.stringContaining("failed clearing stale device-auth token"),
      );
    } else {
      expect(clearDeviceAuthTokenMock).toHaveBeenCalledWith({
        deviceId: "dev-1",
        role: "operator",
        env,
        assertCurrent: expect.any(Function),
      });
      expect(logDebugMock).toHaveBeenCalledWith("cleared stale device-auth token for device dev-1");
    }
    client.stop();
  });

  it("reconnects quietly after one clean pre-hello close with a pending connect", async () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const onConnectError = vi.fn();
    const onHelloOk = vi.fn();
    const client = createClient({
      url: "ws://127.0.0.1:18789",
      deviceIdentity: null,
      token: "shared-token",
      onClose,
      onConnectError,
      onHelloOk,
    });
    try {
      client.start();
      const firstWs = getLatestWs();
      firstWs.emitOpen();
      firstWs.emitMessage(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "nonce-1", ts: 1_777_777_777_000 },
        }),
      );
      expect(firstWs.sent.some((frame) => frame.includes('"method":"connect"'))).toBe(true);

      firstWs.emitClose(1000, "");
      await vi.advanceTimersByTimeAsync(0);

      expect(onConnectError).not.toHaveBeenCalled();
      expect(logErrorMock).not.toHaveBeenCalledWith(
        expect.stringContaining("gateway connect failed:"),
      );
      expect(onClose).toHaveBeenCalledWith(1000, "", {
        phase: "pre-hello",
        socketOpened: true,
        transportValidated: true,
        connectRequestSent: true,
        transientPreHelloCleanClose: true,
      });

      await vi.advanceTimersByTimeAsync(1_000);

      expect(wsInstances).toHaveLength(2);
      const secondWs = getLatestWs();
      secondWs.emitOpen();
      secondWs.emitMessage(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "nonce-2", ts: 1_777_777_778_000 },
        }),
      );
      const connectFrame = JSON.parse(
        secondWs.sent.find((frame) => frame.includes('"method":"connect"')) ?? "{}",
      ) as { id?: string };
      secondWs.emitMessage(
        JSON.stringify({
          type: "res",
          id: connectFrame.id,
          ok: true,
          payload: {
            type: "hello-ok",
            auth: { role: "operator", scopes: ["operator.admin"] },
          },
        }),
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(onHelloOk).toHaveBeenCalledOnce();
    } finally {
      client.stop();
      vi.useRealTimers();
    }
  });

  it("surfaces repeated clean pre-hello closes with a pending connect", async () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const onConnectError = vi.fn();
    const client = createClient({
      url: "ws://127.0.0.1:18789",
      deviceIdentity: null,
      token: "shared-token",
      onClose,
      onConnectError,
    });
    try {
      client.start();
      const firstWs = getLatestWs();
      firstWs.emitOpen();
      firstWs.emitMessage(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "nonce-1", ts: 1_777_777_777_000 },
        }),
      );
      firstWs.emitClose(1000, "");
      await vi.advanceTimersByTimeAsync(0);

      expect(onConnectError).not.toHaveBeenCalled();
      expect(logErrorMock).not.toHaveBeenCalledWith(
        expect.stringContaining("gateway connect failed:"),
      );

      await vi.advanceTimersByTimeAsync(1_000);

      const secondWs = getLatestWs();
      secondWs.emitOpen();
      secondWs.emitMessage(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "nonce-2", ts: 1_777_777_778_000 },
        }),
      );
      secondWs.emitClose(1000, "");
      await vi.advanceTimersByTimeAsync(0);

      expect(onClose).toHaveBeenNthCalledWith(1, 1000, "", {
        phase: "pre-hello",
        socketOpened: true,
        transportValidated: true,
        connectRequestSent: true,
        transientPreHelloCleanClose: true,
      });
      expect(onClose).toHaveBeenNthCalledWith(2, 1000, "", {
        phase: "pre-hello",
        socketOpened: true,
        transportValidated: true,
        connectRequestSent: true,
        transientPreHelloCleanClose: true,
      });
      expect(onConnectError).toHaveBeenCalledOnce();
      expect(onConnectError.mock.calls[0]?.[0]).toMatchObject({
        message: "gateway closed (1000): ",
      });
      expect(logErrorMock).toHaveBeenCalledWith(expect.stringContaining("gateway connect failed:"));
    } finally {
      client.stop();
      vi.useRealTimers();
    }
  });

  it("does not force-terminate a socket that closes during stop", async () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const client = createClient({
      url: "ws://127.0.0.1:18789",
      onClose,
    });

    client.start();
    const ws = getLatestWs();

    client.stop();

    expect(ws.closeCalls).toBe(1);
    expect(onClose).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(250);

    expect(ws.terminateCalls).toBe(0);
  });

  it("waits for a lingering socket to terminate in stopAndWait", async () => {
    vi.useFakeTimers();
    const client = createClient({
      url: "ws://127.0.0.1:18789",
    });

    client.start();
    const ws = getLatestWs();
    ws.autoCloseOnClose = false;

    let settled = false;
    const stopPromise = client.stopAndWait().then(() => {
      settled = true;
    });

    expect(ws.closeCalls).toBe(1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(249);
    expect(ws.terminateCalls).toBe(0);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await stopPromise;

    expect(ws.terminateCalls).toBe(1);
    expect(settled).toBe(true);
  });
});

describe("GatewayClient connect auth payload", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    wsInstances.length = 0;
    clearDeviceAuthTokenMock.mockReset();
    clearOriginDeviceTokenMock.mockReset();
    loadDeviceAuthTokenMock.mockReset();
    loadDeviceAuthTokenReadOnlyMock.mockReset();
    loadOriginDeviceTokenMock.mockReset();
    loadOriginDeviceTokenReadOnlyMock.mockReset();
    storeDeviceAuthTokenMock.mockReset();
    storeOriginDeviceTokenMock.mockReset();
    readLoggingConfigMock.mockReset();
    readLoggingConfigMock.mockReturnValue(undefined);
  });

  type ParsedConnectRequest = {
    id?: string;
    params?: {
      minProtocol?: number;
      maxProtocol?: number;
      scopes?: string[];
      client?: {
        id?: string;
        mode?: string;
        platform?: string;
      };
      auth?: {
        token?: string;
        bootstrapToken?: string;
        deviceToken?: string;
        password?: string;
        approvalRuntimeToken?: string;
        agentRuntimeIdentityToken?: string;
      };
      device?: {
        signedAt?: number;
      };
    };
  };

  function parseConnectRequest(ws: MockWebSocket): ParsedConnectRequest {
    const raw = ws.sent.find((frame) => frame.includes('"method":"connect"'));
    if (!raw) {
      throw new Error("missing connect frame");
    }
    return JSON.parse(raw) as ParsedConnectRequest;
  }

  function connectFrameFrom(ws: MockWebSocket) {
    return parseConnectRequest(ws).params?.auth ?? {};
  }

  function connectScopesFrom(ws: MockWebSocket) {
    return parseConnectRequest(ws).params?.scopes ?? [];
  }

  function connectRequestFrom(ws: MockWebSocket) {
    return parseConnectRequest(ws);
  }

  async function advanceToNextReconnect(): Promise<MockWebSocket> {
    const previousCount = wsInstances.length;
    await vi.advanceTimersToNextTimerAsync();
    expect(wsInstances).toHaveLength(previousCount + 1);
    return getLatestWs();
  }

  it.each([{ canonical: "macos", legacy: "darwin", protocolBounds: {} }])(
    "retries a released-v3 Gateway with the shipped $legacy metadata envelope",
    async ({ canonical, legacy, protocolBounds }) => {
      const signDevicePayload = vi.fn((_privateKeyPem: string, _payload: string) => "signature");
      const deviceFamily = canonical === "macos" ? "Mac" : "Windows";
      const modelIdentifier = "TestMachine1,1";
      const client = createClientWithIdentity(`device-${legacy}`, vi.fn(), {
        role: "node",
        mode: GATEWAY_CLIENT_MODES.NODE,
        clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
        platform: canonical,
        deviceFamily,
        modelIdentifier,
        hostDeps: { signDevicePayload },
        ...protocolBounds,
      });

      const { ws: currentWs, connect: currentConnect } = await startClientAndConnect({ client });
      expect(currentConnect.params).toMatchObject({
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: { platform: canonical, deviceFamily, modelIdentifier },
      });
      expect(signDevicePayload.mock.calls[0]?.[1]?.split("|").slice(9)).toEqual([
        canonical,
        deviceFamily.toLowerCase(),
      ]);

      emitConnectFailure(
        currentWs,
        currentConnect.id,
        { code: "PROTOCOL_MISMATCH", expectedProtocol: MIN_NODE_PROTOCOL_VERSION },
        "protocol mismatch",
      );
      const legacyWs = await advanceToNextReconnect();
      legacyWs.emitOpen();
      emitConnectChallenge(legacyWs, "nonce-v3");
      const legacyConnect = connectRequestFrom(legacyWs);

      expect(legacyConnect.params).toMatchObject({
        minProtocol: MIN_NODE_PROTOCOL_VERSION,
        maxProtocol: MIN_NODE_PROTOCOL_VERSION,
        client: { platform: legacy },
      });
      expect(legacyConnect.params?.client).not.toHaveProperty("deviceFamily");
      expect(legacyConnect.params?.client).not.toHaveProperty("modelIdentifier");
      expect(signDevicePayload.mock.calls.at(-1)?.[1]?.split("|").slice(9)).toEqual([legacy, ""]);
      client.stop();
    },
  );

  it("reconnects with the current envelope when a legacy probe reaches an upgraded Gateway", async () => {
    const onHelloOk = vi.fn();
    const client = createClientWithIdentity("device-gateway-upgrade", vi.fn(), {
      role: "node",
      mode: GATEWAY_CLIENT_MODES.NODE,
      clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
      platform: "macos",
      deviceFamily: "Mac",
      onHelloOk,
    });

    const { ws: currentWs, connect: currentConnect } = await startClientAndConnect({ client });
    emitConnectFailure(
      currentWs,
      currentConnect.id,
      { code: "PROTOCOL_MISMATCH", expectedProtocol: MIN_NODE_PROTOCOL_VERSION },
      "protocol mismatch",
    );
    const v3Ws = await advanceToNextReconnect();
    v3Ws.emitOpen();
    emitConnectChallenge(v3Ws, "nonce-v3-initial");
    const v3Connect = connectRequestFrom(v3Ws);
    emitHelloOk(v3Ws, v3Connect.id, MIN_NODE_PROTOCOL_VERSION);
    await waitForFast(() => expect(onHelloOk).toHaveBeenCalledOnce());

    v3Ws.emitClose(1012, "gateway restarting after upgrade");
    const upgradedProbeWs = await advanceToNextReconnect();
    upgradedProbeWs.emitOpen();
    emitConnectChallenge(upgradedProbeWs, "nonce-v3-upgraded");
    const upgradedProbeConnect = connectRequestFrom(upgradedProbeWs);
    expect(upgradedProbeConnect.params).toMatchObject({
      minProtocol: MIN_NODE_PROTOCOL_VERSION,
      maxProtocol: MIN_NODE_PROTOCOL_VERSION,
    });
    emitConnectFailure(
      upgradedProbeWs,
      upgradedProbeConnect.id,
      { code: "PROTOCOL_MISMATCH", expectedProtocol: PROTOCOL_VERSION },
      "protocol mismatch",
    );

    const currentReconnectWs = await advanceToNextReconnect();
    expect(onHelloOk).toHaveBeenCalledOnce();
    currentReconnectWs.emitOpen();
    emitConnectChallenge(currentReconnectWs, "nonce-v4-upgraded");
    const currentReconnect = connectRequestFrom(currentReconnectWs);
    expect(currentReconnect.params).toMatchObject({
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: { platform: "macos", deviceFamily: "Mac" },
    });
    emitHelloOk(currentReconnectWs, currentReconnect.id, PROTOCOL_VERSION);
    await waitForFast(() => expect(onHelloOk).toHaveBeenCalledTimes(2));

    currentReconnectWs.emitClose(1012, "gateway rolled back");
    const rolledBackProbeWs = await advanceToNextReconnect();
    rolledBackProbeWs.emitOpen();
    emitConnectChallenge(rolledBackProbeWs, "nonce-v4-rolled-back");
    const rolledBackProbeConnect = connectRequestFrom(rolledBackProbeWs);
    expect(rolledBackProbeConnect.params).toMatchObject({
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
    });
    emitConnectFailure(
      rolledBackProbeWs,
      rolledBackProbeConnect.id,
      { code: "PROTOCOL_MISMATCH", expectedProtocol: MIN_NODE_PROTOCOL_VERSION },
      "protocol mismatch",
    );
    const rolledBackLegacyWs = await advanceToNextReconnect();
    rolledBackLegacyWs.emitOpen();
    emitConnectChallenge(rolledBackLegacyWs, "nonce-v3-rolled-back");
    expect(connectRequestFrom(rolledBackLegacyWs).params).toMatchObject({
      minProtocol: MIN_NODE_PROTOCOL_VERSION,
      maxProtocol: MIN_NODE_PROTOCOL_VERSION,
    });
    client.stop();
  });

  it("returns to v3 when the Gateway rolls back before v4 readiness", async () => {
    const onHelloOk = vi.fn();
    const client = createClientWithIdentity("device-gateway-rollback-before-ready", vi.fn(), {
      role: "node",
      mode: GATEWAY_CLIENT_MODES.NODE,
      clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
      onHelloOk,
    });

    const { ws: initialWs, connect: initialConnect } = await startClientAndConnect({ client });
    emitConnectFailure(
      initialWs,
      initialConnect.id,
      { code: "PROTOCOL_MISMATCH", expectedProtocol: MIN_NODE_PROTOCOL_VERSION },
      "protocol mismatch",
    );
    const v3Ws = await advanceToNextReconnect();
    v3Ws.emitOpen();
    emitConnectChallenge(v3Ws, "nonce-v3-ready");
    const v3Connect = connectRequestFrom(v3Ws);
    emitHelloOk(v3Ws, v3Connect.id, MIN_NODE_PROTOCOL_VERSION);
    await waitForFast(() => expect(onHelloOk).toHaveBeenCalledOnce());

    v3Ws.emitClose(1012, "gateway upgrading");
    const v3UpgradeProbeWs = await advanceToNextReconnect();
    v3UpgradeProbeWs.emitOpen();
    emitConnectChallenge(v3UpgradeProbeWs, "nonce-v3-upgrade-probe");
    const v3UpgradeProbe = connectRequestFrom(v3UpgradeProbeWs);
    emitConnectFailure(
      v3UpgradeProbeWs,
      v3UpgradeProbe.id,
      { code: "PROTOCOL_MISMATCH", expectedProtocol: PROTOCOL_VERSION },
      "protocol mismatch",
    );

    const v4Ws = await advanceToNextReconnect();
    v4Ws.emitOpen();
    emitConnectChallenge(v4Ws, "nonce-v4-before-rollback");
    const v4Connect = connectRequestFrom(v4Ws);
    emitConnectFailure(
      v4Ws,
      v4Connect.id,
      { code: "PROTOCOL_MISMATCH", expectedProtocol: MIN_NODE_PROTOCOL_VERSION },
      "protocol mismatch",
    );

    const recoveredV3Ws = await advanceToNextReconnect();
    recoveredV3Ws.emitOpen();
    emitConnectChallenge(recoveredV3Ws, "nonce-v3-after-rollback");
    expect(connectRequestFrom(recoveredV3Ws).params).toMatchObject({
      minProtocol: MIN_NODE_PROTOCOL_VERSION,
      maxProtocol: MIN_NODE_PROTOCOL_VERSION,
    });
    expect(onHelloOk).toHaveBeenCalledOnce();
    client.stop();
  });

  it("pauses a node host after an unsupported protocol mismatch following a supported transition", async () => {
    const onReconnectPaused = vi.fn();
    const client = createClientWithIdentity("device-unsupported-node-protocol", vi.fn(), {
      role: "node",
      mode: GATEWAY_CLIENT_MODES.NODE,
      clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
      onReconnectPaused,
    });

    const { ws: currentWs, connect: currentConnect } = await startClientAndConnect({ client });
    emitConnectFailure(currentWs, currentConnect.id, {
      code: "PROTOCOL_MISMATCH",
      expectedProtocol: MIN_NODE_PROTOCOL_VERSION,
    });
    const legacyWs = await advanceToNextReconnect();
    legacyWs.emitOpen();
    emitConnectChallenge(legacyWs, "nonce-unsupported-node-protocol");
    const legacyConnect = connectRequestFrom(legacyWs);
    expect(legacyConnect.params).toMatchObject({
      minProtocol: MIN_NODE_PROTOCOL_VERSION,
      maxProtocol: MIN_NODE_PROTOCOL_VERSION,
    });
    expect(onReconnectPaused).not.toHaveBeenCalled();

    await expectNoReconnectAfterConnectFailure({
      client,
      firstWs: legacyWs,
      connectId: legacyConnect.id,
      failureDetails: {
        code: "PROTOCOL_MISMATCH",
        expectedProtocol: PROTOCOL_VERSION + 1,
      },
      failureMessage: "unsupported gateway protocol",
    });

    expect(onReconnectPaused).toHaveBeenCalledWith({
      code: 1008,
      reason: "connect failed",
      detailCode: "PROTOCOL_MISMATCH",
    });
  });

  it.each([{ platform: "win32", deviceFamily: undefined }])(
    "preserves explicit caller metadata: %j",
    async ({ platform, deviceFamily }) => {
      const client = createClientWithIdentity("device-third-party-node", vi.fn(), {
        role: "node",
        mode: GATEWAY_CLIENT_MODES.NODE,
        clientName: GATEWAY_CLIENT_NAMES.TEST,
        platform,
        deviceFamily,
      });

      const { connect } = await startClientAndConnect({ client });
      expect(connect.params?.client).toMatchObject({
        platform,
        ...(deviceFamily ? { deviceFamily } : {}),
      });
      if (deviceFamily === undefined) {
        expect(connect.params?.client).not.toHaveProperty("deviceFamily");
      }
      client.stop();
    },
  );

  it("signs device proof with Gateway time instead of client wall-clock time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2040-01-01T00:00:00.000Z"));
    const client = createClientWithIdentity("device-gateway-time", vi.fn());
    const challengeTs = 1_700_000_000_123;

    client.start();
    const ws = getLatestWs();
    ws.emitOpen();
    emitConnectChallenge(ws, "nonce-clock-skew", challengeTs);
    const connect = connectRequestFrom(ws);

    expect(connect.params?.device?.signedAt).toBe(challengeTs);
    client.stop();
    vi.useRealTimers();
  });

  it.each([undefined])("fails closed for invalid challenge timestamp %s", (ts) => {
    const onConnectError = vi.fn();
    const client = createClientWithIdentity("device-invalid-challenge-time", vi.fn(), {
      onConnectError,
    });
    client.start();
    const ws = getLatestWs();
    ws.emitOpen();
    ws.emitMessage(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "nonce-invalid-time", ts },
      }),
    );
    expect(ws.sent.some((frame) => frame.includes('"method":"connect"'))).toBe(false);
    expect(firstMockArg(onConnectError, "connect error")).toMatchObject({
      message: "gateway connect challenge timestamp invalid",
    });
    expect(ws.lastClose).toEqual({ code: 1008, reason: "connect failed" });
    client.stop();
  });

  function emitConnectChallenge(ws: MockWebSocket, nonce = "nonce-1", ts = 1_800_000_000_000) {
    ws.emitMessage(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce, ts },
      }),
    );
  }

  async function startClientAndConnect(params: { client: GatewayClientInstance; nonce?: string }) {
    params.client.start();
    const ws = getLatestWs();
    ws.emitOpen();
    emitConnectChallenge(ws, params.nonce);
    await vi.advanceTimersByTimeAsync(0);
    return { ws, connect: connectRequestFrom(ws) };
  }

  function startClientWithEarlyChallenge(params: {
    client: GatewayClientInstance;
    nonce?: string;
  }) {
    params.client.start();
    const ws = getLatestWs();
    emitConnectChallenge(ws, params.nonce);
    ws.emitOpen();
    return { ws, connect: connectRequestFrom(ws) };
  }

  function emitConnectFailure(
    ws: MockWebSocket,
    connectId: string | undefined,
    details: Record<string, unknown>,
    message = "unauthorized",
  ) {
    ws.emitMessage(
      JSON.stringify({
        type: "res",
        id: connectId,
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message,
          details,
        },
      }),
    );
  }

  function emitHelloOk(
    ws: MockWebSocket,
    connectId: string | undefined,
    protocol: number = PROTOCOL_VERSION,
  ) {
    ws.emitMessage(
      JSON.stringify({
        type: "res",
        id: connectId,
        ok: true,
        payload: {
          type: "hello-ok",
          protocol,
          auth: { role: "operator", scopes: ["operator.admin"] },
        },
      }),
    );
  }

  async function expectRetriedConnectAuth(params: {
    firstWs: MockWebSocket;
    connectId: string | undefined;
    failureDetails: Record<string, unknown>;
    failureMessage?: string;
  }) {
    emitConnectFailure(
      params.firstWs,
      params.connectId,
      params.failureDetails,
      params.failureMessage,
    );
    const ws = await advanceToNextReconnect();
    ws.emitOpen();
    emitConnectChallenge(ws, "nonce-2");
    return connectFrameFrom(ws);
  }

  async function expectNoReconnectAfterConnectFailure(params: {
    client: GatewayClientInstance;
    firstWs: MockWebSocket;
    connectId: string | undefined;
    failureDetails: Record<string, unknown>;
    failureMessage?: string;
  }) {
    vi.useFakeTimers();
    const socketCount = wsInstances.length;
    try {
      emitConnectFailure(
        params.firstWs,
        params.connectId,
        params.failureDetails,
        params.failureMessage,
      );
      await vi.advanceTimersByTimeAsync(30_000);
      expect(wsInstances).toHaveLength(socketCount);
    } finally {
      params.client.stop();
      vi.useRealTimers();
    }
  }

  it("binds stored device auth to the exact gateway origin", async () => {
    loadOriginDeviceTokenMock.mockImplementation(({ gatewayScope }: { gatewayScope: string }) =>
      gatewayScope === "wss://one.example/rpc"
        ? { token: "origin-one-token", scopes: ["operator.read"] }
        : null,
    );
    const first = createClientWithIdentity("device-1", () => {}, {
      deviceAuthScope: "wss://one.example/rpc",
    });

    const { ws: firstWs } = await startClientAndConnect({ client: first });
    expect(connectFrameFrom(firstWs)).toEqual({
      deviceToken: "origin-one-token",
    });
    first.stop();

    const second = createClientWithIdentity("device-1", () => {}, {
      deviceAuthScope: "wss://two.example/rpc",
    });
    const { ws: secondWs } = await startClientAndConnect({ client: second });
    expect(connectFrameFrom(secondWs).token).toBeUndefined();
    expect(connectFrameFrom(secondWs).deviceToken).toBeUndefined();
    expect(loadDeviceAuthTokenMock).not.toHaveBeenCalled();
    second.stop();
  });

  it.each([
    { completion: "clear", deviceAuthScope: undefined, store: "device" },
    { completion: "overwrite", deviceAuthScope: undefined, store: "device" },
    { completion: "clear", deviceAuthScope: "wss://one.example/rpc", store: "origin" },
    { completion: "overwrite", deviceAuthScope: "wss://one.example/rpc", store: "origin" },
  ] as const)(
    "does not $completion rotated $store auth after the prepared snapshot",
    async ({ completion, deviceAuthScope }) => {
      const preparedDeviceAuth = {
        token: "prepared-device-token",
        role: "operator",
        scopes: ["operator.read"],
        updatedAtMs: 123,
      };
      let durableToken: string | undefined = preparedDeviceAuth.token;
      const clearTokenMock = deviceAuthScope
        ? clearOriginDeviceTokenMock
        : clearDeviceAuthTokenMock;
      const storeTokenMock = deviceAuthScope
        ? storeOriginDeviceTokenMock
        : storeDeviceAuthTokenMock;
      clearTokenMock.mockImplementation(({ expectedToken }: { expectedToken?: string }) => {
        if (durableToken === expectedToken) {
          durableToken = undefined;
        }
      });
      storeTokenMock.mockImplementation(
        ({ expectedToken, token }: { expectedToken?: string; token: string }) => {
          if (durableToken === expectedToken) {
            durableToken = token;
          }
        },
      );
      const client = createClientWithIdentity("device-1", () => {}, {
        preparedDeviceAuth,
        ...(deviceAuthScope ? { deviceAuthScope } : {}),
      });

      client.start();
      const ws = getLatestWs();
      ws.emitOpen();
      emitConnectChallenge(ws);
      const connect = connectRequestFrom(ws);
      expect(connectFrameFrom(ws)).toEqual({ deviceToken: "prepared-device-token" });
      expect(loadDeviceAuthTokenMock).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(0);
      durableToken = "rotated-device-token";
      if (completion === "clear") {
        emitConnectFailure(ws, connect.id, { code: "AUTH_DEVICE_TOKEN_MISMATCH" });
        await waitForFast(() => expect(clearTokenMock).toHaveBeenCalledOnce());
      } else {
        ws.emitMessage(
          JSON.stringify({
            type: "res",
            id: connect.id,
            ok: true,
            payload: {
              type: "hello-ok",
              auth: {
                role: "operator",
                scopes: ["operator.write"],
                deviceToken: "stale-request-replacement",
              },
            },
          }),
        );
        await waitForFast(() => expect(storeTokenMock).toHaveBeenCalledOnce());
      }

      expect(durableToken).toBe("rotated-device-token");
      client.stop();
    },
  );

  it("keeps read-only origin auth loads and hello tokens off writable host callbacks", async () => {
    loadOriginDeviceTokenReadOnlyMock.mockReturnValue({
      token: "stored-origin-token",
      scopes: ["operator.read"],
    });
    const client = createClientWithIdentity("device-1", () => {}, {
      deviceAuthScope: "wss://one.example/rpc",
      sharedStateMode: "read-only",
    });

    const { ws, connect } = await startClientAndConnect({ client });
    expect(connectFrameFrom(ws)).toEqual({
      deviceToken: "stored-origin-token",
    });
    expect(loadOriginDeviceTokenReadOnlyMock).toHaveBeenCalledOnce();
    expect(loadOriginDeviceTokenMock).not.toHaveBeenCalled();

    ws.emitMessage(
      JSON.stringify({
        type: "res",
        id: connect.id,
        ok: true,
        payload: {
          type: "hello-ok",
          auth: {
            role: "operator",
            scopes: ["operator.admin"],
            deviceToken: "issued-origin-token",
          },
        },
      }),
    );

    await waitForFast(() => expect(ws.lastClose).toBeNull());
    expect(storeOriginDeviceTokenMock).not.toHaveBeenCalled();
    expect(clearOriginDeviceTokenMock).not.toHaveBeenCalled();
    client.stop();
  });

  it.each([
    {
      label: "normalized credentials",
      password: " shared-password ",
      scopes: ["operator.read"],
      token: "  ",
    },
  ])(
    "connects read-only password auth without reading unused device credentials ($label)",
    async ({ password, scopes, token }) => {
      loadDeviceAuthTokenReadOnlyMock.mockImplementation(() => {
        throw new Error("SQLite source did not stabilize for read-only inspection");
      });
      const onHello = vi.fn();
      const onConnectError = vi.fn();
      const client = createClientWithIdentity("device-1", () => {}, {
        password,
        token,
        sharedStateMode: "read-only",
        scopes,
        onHelloOk: onHello,
        onConnectError,
      });

      try {
        client.start();
        const ws = getLatestWs();
        ws.emitOpen();
        emitConnectChallenge(ws);
        expect(onConnectError).not.toHaveBeenCalled();
        const connect = connectRequestFrom(ws);
        expect(connect.params).toMatchObject({
          auth: { password: "shared-password" }, // pragma: allowlist secret
          scopes: scopes ?? ["operator.admin"],
          device: { id: "device-1", signature: expect.any(String), nonce: "nonce-1" },
        });
        expect(connect.params?.auth).toEqual({ password: "shared-password" }); // pragma: allowlist secret
        expect(loadDeviceAuthTokenReadOnlyMock).not.toHaveBeenCalled();
        ws.emitMessage(
          JSON.stringify({
            type: "res",
            id: connect.id,
            ok: true,
            payload: {
              type: "hello-ok",
              auth: { role: "operator", scopes: ["operator.read"], deviceToken: "issued-token" },
            },
          }),
        );
        await waitForFast(() => expect(onHello).toHaveBeenCalledOnce());
        const request = client.request("system.info");
        const frame = JSON.parse(ws.sent.at(-1) ?? "null");
        expect(frame.method).toBe("system.info");
        ws.emitMessage(
          JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { pid: 123 } }),
        );
        await expect(request).resolves.toEqual({ pid: 123 });
        expect(storeDeviceAuthTokenMock).not.toHaveBeenCalled();
        expect(clearDeviceAuthTokenMock).not.toHaveBeenCalled();
      } finally {
        client.stop();
      }
    },
  );

  it.each([
    { label: "bootstrap token", options: { bootstrapToken: "bootstrap-token" } },
    { label: "explicit device token", options: { deviceToken: "device-token" } },
    { label: "approval runtime token", options: { approvalRuntimeToken: "approval-token" } },
    {
      label: "agent runtime identity token",
      options: { agentRuntimeIdentityToken: "runtime-token" },
    },
  ])("retains stored-device auth failure for $label", ({ options }) => {
    const failure = new Error("stored device credentials unavailable");
    loadDeviceAuthTokenReadOnlyMock.mockImplementation(() => {
      throw failure;
    });
    loadDeviceAuthTokenMock.mockImplementation(() => {
      throw failure;
    });
    const onConnectError = vi.fn();
    const client = createClientWithIdentity("device-1", () => {}, {
      sharedStateMode: "read-only",
      password: "shared-password", // pragma: allowlist secret
      onConnectError,
      ...options,
    });
    try {
      client.start();
      const ws = getLatestWs();
      ws.emitOpen();
      emitConnectChallenge(ws);
      expect(onConnectError).toHaveBeenCalledWith(failure);
      expect(ws.sent).toEqual([]);
      expect(ws.lastClose).toEqual({ code: 1008, reason: "connect failed" });
    } finally {
      client.stop();
    }
  });

  it("keeps explicit shared auth ahead of origin-scoped auth across reconnects", async () => {
    loadOriginDeviceTokenMock.mockReturnValue({ token: "origin-token" });
    const onReconnectPaused = vi.fn();
    const client = createClientWithIdentity("device-1", () => {}, {
      deviceAuthScope: "wss://one.example/rpc",
      token: "explicit-token",
      onReconnectPaused,
    });

    const { ws, connect } = await startClientAndConnect({ client });

    expect(connectFrameFrom(ws)).toMatchObject({ token: "explicit-token" });
    expect(connectFrameFrom(ws).deviceToken).toBeUndefined();
    await expectNoReconnectAfterConnectFailure({
      client,
      firstWs: ws,
      connectId: connect.id,
      failureDetails: { code: "AUTH_TOKEN_MISMATCH", canRetryWithDeviceToken: true },
    });
    expect(loadOriginDeviceTokenMock).toHaveBeenCalledOnce();
    expect(onReconnectPaused).toHaveBeenCalledWith({
      code: 1008,
      reason: "connect failed",
      detailCode: "AUTH_TOKEN_MISMATCH",
    });
  });

  it.each([
    {
      label: "new token",
      token: "issued-origin-token",
      scopes: ["operator.read"],
    },
  ])("stores hello authorization in the bound origin for $label", async ({ token, scopes }) => {
    loadOriginDeviceTokenMock.mockReturnValue(undefined);
    const client = createClientWithIdentity("device-1", () => {}, {
      deviceAuthScope: "wss://one.example/rpc",
    });
    const { ws, connect } = await startClientAndConnect({ client });
    ws.emitMessage(
      JSON.stringify({
        type: "res",
        id: connect.id,
        ok: true,
        payload: {
          type: "hello-ok",
          auth: { role: "operator", scopes: ["operator.read"], deviceToken: token },
        },
      }),
    );
    await waitForFast(() => {
      expect(storeOriginDeviceTokenMock).toHaveBeenCalledWith({
        gatewayScope: "wss://one.example/rpc",
        deviceId: "device-1",
        role: "operator",
        token,
        scopes,
        env: undefined,
        expectedToken: null,
      });
    });
    expect(storeDeviceAuthTokenMock).not.toHaveBeenCalled();
    client.stop();
  });

  it("fails closed when a gateway rejects the required agent runtime identity auth field", async () => {
    const onConnectError = vi.fn();
    const client = createClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-token",
      agentRuntimeIdentityToken: "identity-token",
      deviceIdentity: null,
      onConnectError,
    });

    const { ws, connect } = await startClientAndConnect({ client });
    expectRecordFields(
      connect.params?.auth ?? {},
      {
        token: "shared-token",
        agentRuntimeIdentityToken: "identity-token",
      },
      "initial connect auth",
    );

    await expectNoReconnectAfterConnectFailure({
      client,
      firstWs: ws,
      connectId: connect.id,
      failureDetails: {},
      failureMessage:
        "invalid connect params: at /auth: unexpected property 'agentRuntimeIdentityToken'",
    });
    const error = firstMockArg(onConnectError, "connect error") as Error;
    expect(error.message).toBe(
      "gateway rejected required agent runtime identity auth field; refusing to retry without it",
    );
    expect(ws.lastClose).toEqual({ code: 1008, reason: "connect failed" });
    expect(logErrorMock).toHaveBeenCalledWith(
      "gateway connect failed: gateway rejected required agent runtime identity auth field; refusing to retry without it",
    );
  });

  it("waits for socket open before sending connect after an early challenge", () => {
    const client = createClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-token",
    });

    const { ws, connect } = startClientWithEarlyChallenge({ client });

    expect(connectFrameFrom(ws)).toMatchObject({
      token: "shared-token",
    });
    emitHelloOk(ws, connect.id);
    client.stop();
  });

  it("reports a transport close while the connect request is pending", async () => {
    const onConnectError = vi.fn();
    const client = createClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-token",
      onConnectError,
    });

    const { ws } = await startClientAndConnect({ client });
    ws.emitClose(1006, "socket lost");

    expect(firstMockArg(onConnectError, "connect error")).toMatchObject({
      message: "gateway closed (1006): socket lost",
    });
    client.stop();
  });

  it.each([
    {
      label: "credentials",
      message: createAuthFailureMessage(),
      present: ["Authorization: Bearer"],
      absent: ["sk-testsecret1234567890abcd", "user:pass", "secret-token"],
    },
    {
      label: "redaction disabled",
      message: "Authorization: Bearer sk-disabledredaction1234567890abcd", // pragma: allowlist secret
      present: ["Authorization: Bearer"],
      absent: ["sk-disabledredaction1234567890abcd"],
      redactionOff: true,
    },
    {
      label: "registered edge header",
      message: "edge rejected service token test-secret",
      present: ["edge rejected service token"],
      absent: ["test-secret"],
      edge: true,
    },
  ])(
    "redacts connect failure logs: $label",
    async ({ message, present, absent, redactionOff, edge }) => {
      if (redactionOff) {
        readLoggingConfigMock.mockReturnValue({ redactSensitive: "off" });
      }
      const client = createClient({
        url: edge ? "wss://gateway.example" : "ws://127.0.0.1:18789",
        ...(edge
          ? { edgeAuthHeaders: { "X-Edge-Auth": "test-secret" } }
          : { token: "shared-token" }),
        deviceIdentity: null,
      });
      const { ws, connect } = await startClientAndConnect({ client });
      emitConnectFailure(ws, connect.id, { code: "AUTH_UNAUTHORIZED" }, message);
      await waitForFast(() => {
        expect(logErrorMock).toHaveBeenCalledWith(
          expect.stringContaining("gateway connect failed:"),
        );
      });
      const logged = String(logErrorMock.mock.calls.at(-1)?.[0] ?? "");
      for (const text of present) {
        expect(logged).toContain(text);
      }
      for (const text of absent) {
        expect(logged).not.toContain(text);
      }
      client.stop();
    },
  );

  it.each([
    {
      label: "stored device token",
      stored: { token: "stored-device-token" },
      bootstrapToken: undefined,
    },
  ])("prefers explicit shared password over $label", ({ stored, bootstrapToken }) => {
    loadDeviceAuthTokenMock.mockReturnValue(stored);
    const client = createClient({
      url: "ws://127.0.0.1:18789",
      password: "shared-password", // pragma: allowlist secret
      bootstrapToken,
    });
    client.start();
    const ws = getLatestWs();
    ws.emitOpen();
    emitConnectChallenge(ws);
    expect(connectFrameFrom(ws)).toMatchObject({ password: "shared-password" }); // pragma: allowlist secret
    expect(connectFrameFrom(ws).bootstrapToken).toBeUndefined();
    expect(connectFrameFrom(ws).token).toBeUndefined();
    expect(connectFrameFrom(ws).deviceToken).toBeUndefined();
    client.stop();
  });

  it.each([
    {
      label: "stored scopes",
      storedScopes: ["operator.read", "operator.write"],
      requestedScopes: undefined,
      deviceToken: undefined,
      expectedScopes: ["operator.read", "operator.write"],
    },
    {
      label: "explicit device token",
      storedScopes: ["operator.admin", "operator.read"],
      requestedScopes: ["operator.pairing"],
      deviceToken: "explicit-device-token",
      expectedScopes: ["operator.pairing"],
    },
  ])(
    "selects and signs device auth with $label",
    ({ storedScopes, requestedScopes, deviceToken, expectedScopes }) => {
      loadDeviceAuthTokenMock.mockReturnValue({
        token: "stored-device-token",
        scopes: storedScopes,
      });
      const signDevicePayload = vi.fn(signDevicePayloadWithKey);
      const client = createClientWithIdentity("device-scopes", vi.fn(), {
        scopes: requestedScopes,
        deviceToken,
        hostDeps: { signDevicePayload },
      });
      client.start();
      const ws = getLatestWs();
      ws.emitOpen();
      emitConnectChallenge(ws);
      expect(connectFrameFrom(ws)).toEqual({ deviceToken: deviceToken ?? "stored-device-token" });
      expect(signDevicePayload.mock.calls[0]?.[1]?.split("|")[7]).toBe(
        deviceToken ?? "stored-device-token",
      );
      expect(connectScopesFrom(ws)).toEqual(expectedScopes);
      client.stop();
    },
  );

  it("uses bootstrap token when no shared or device token is available", () => {
    loadDeviceAuthTokenMock.mockReturnValue(undefined);
    const client = createClient({
      url: "ws://127.0.0.1:18789",
      bootstrapToken: "bootstrap-token",
    });

    client.start();
    const ws = getLatestWs();
    ws.emitOpen();
    emitConnectChallenge(ws);

    expect(connectFrameFrom(ws)).toMatchObject({
      bootstrapToken: "bootstrap-token",
    });
    expect(connectFrameFrom(ws).token).toBeUndefined();
    expect(connectFrameFrom(ws).deviceToken).toBeUndefined();
    client.stop();
  });

  it("emits only the signed bootstrap credential in a preferred node-host connect frame", async () => {
    loadDeviceAuthTokenMock.mockReturnValue({ token: "stale-device-token" });
    const signDevicePayload = vi.fn((_privateKeyPem: string, _payload: string) => "signature");
    const client = createClientWithIdentity("device-pairing-bootstrap", vi.fn(), {
      token: "shared-token",
      bootstrapToken: "bootstrap-token",
      password: "shared-password", // pragma: allowlist secret
      preferBootstrapToken: true,
      role: "node",
      mode: GATEWAY_CLIENT_MODES.NODE,
      clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
      scopes: [],
      hostDeps: { signDevicePayload },
    });

    const { connect } = await startClientAndConnect({ client });

    expect(connect.params?.client).toMatchObject({
      id: GATEWAY_CLIENT_NAMES.NODE_HOST,
      mode: GATEWAY_CLIENT_MODES.NODE,
    });
    expect(connect.params?.auth).toEqual({ bootstrapToken: "bootstrap-token" });
    expect(signDevicePayload.mock.calls[0]?.[1]?.split("|")[3]).toBe(connect.params?.client?.mode);
    expect(signDevicePayload.mock.calls[0]?.[1]?.split("|")[7]).toBe("bootstrap-token");
    client.stop();
  });

  it("prefers a paired bootstrap token once, then reconnects with stored device auth", async () => {
    loadDeviceAuthTokenMock.mockReturnValue({ token: "stale-device-token" });
    const onHelloOk = vi.fn();
    const client = createClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-token",
      bootstrapToken: "bootstrap-token",
      password: "shared-password", // pragma: allowlist secret
      preferBootstrapToken: true,
      onHelloOk,
    });

    const { ws, connect } = await startClientAndConnect({ client });
    expect(connectFrameFrom(ws)).toMatchObject({ bootstrapToken: "bootstrap-token" });
    expect(connectFrameFrom(ws).token).toBeUndefined();
    expect(connectFrameFrom(ws).deviceToken).toBeUndefined();

    loadDeviceAuthTokenMock.mockReturnValue({ token: "issued-device-token" });
    emitHelloOk(ws, connect.id);
    await waitForFast(() => expect(onHelloOk).toHaveBeenCalledOnce());
    ws.emitClose(1006, "socket lost");
    const reconnect = await advanceToNextReconnect();
    reconnect.emitOpen();
    emitConnectChallenge(reconnect, "nonce-reconnect");
    expect(connectFrameFrom(reconnect)).toEqual({
      deviceToken: "issued-device-token",
    });
    expect(connectFrameFrom(reconnect).password).toBeUndefined();
    expect(connectFrameFrom(reconnect).bootstrapToken).toBeUndefined();
    client.stop();
  });

  it.each([{ code: "AUTH_TOKEN_MISMATCH", canRetryWithDeviceToken: true }])(
    "retries trusted auth with a stored device token for %j",
    async (failureDetails) => {
      loadDeviceAuthTokenMock.mockReturnValue({
        token: "stored-device-token",
        scopes: ["operator.read"],
      });
      const client = createClient({ url: "ws://127.0.0.1:18789", token: "shared-token" });
      const { ws: firstWs, connect } = await startClientAndConnect({ client });
      expect(connect.params?.auth?.token).toBe("shared-token");
      expect(connect.params?.auth?.deviceToken).toBeUndefined();
      const retriedAuth = await expectRetriedConnectAuth({
        firstWs,
        connectId: connect.id,
        failureDetails,
      });
      expect(retriedAuth).toMatchObject({
        token: "shared-token",
        deviceToken: "stored-device-token",
      });
      expect(connectScopesFrom(getLatestWs())).toEqual(["operator.read"]);
      client.stop();
    },
  );

  it("reports AUTH_RATE_LIMITED before pausing reconnect on the following close", async () => {
    const onConnectError = vi.fn();
    const onReconnectPaused = vi.fn();
    const client = createClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-token",
      onConnectError,
      onReconnectPaused,
    });

    const { ws: ws1, connect: firstConnect } = await startClientAndConnect({ client });
    await expectNoReconnectAfterConnectFailure({
      client,
      firstWs: ws1,
      connectId: firstConnect.id,
      failureDetails: {
        code: "AUTH_RATE_LIMITED",
        authReason: "rate_limited",
        recommendedNextStep: "wait_then_retry",
      },
      failureMessage: "unauthorized: too many failed authentication attempts (retry later)",
    });

    expect(onConnectError).toHaveBeenCalledOnce();
    expect(onConnectError.mock.calls[0]?.[0]).toMatchObject({
      name: "GatewayClientRequestError",
      details: {
        code: "AUTH_RATE_LIMITED",
        authReason: "rate_limited",
        recommendedNextStep: "wait_then_retry",
      },
    });
    expect(onReconnectPaused).toHaveBeenCalledWith({
      code: 1008,
      reason: "connect failed",
      detailCode: "AUTH_RATE_LIMITED",
    });
    expect(logDebugMock).toHaveBeenCalledWith(
      expect.stringContaining("gateway connect failed: GatewayClientRequestError"),
    );
    expect(logErrorMock).not.toHaveBeenCalledWith(
      expect.stringContaining("gateway connect failed: GatewayClientRequestError"),
    );
  });

  it.each([{ OPENCLAW_HOME: "/tmp/custom-openclaw-home" }])(
    "clears rejected stored tokens from the selected environment: %j",
    async (env) => {
      loadDeviceAuthTokenMock.mockReturnValue({
        token: "stored-device-token",
        scopes: ["operator.read"],
      });
      const onReconnectPaused = vi.fn();
      const client = createClient({ url: "ws://127.0.0.1:18789", env, onReconnectPaused });
      const { ws: firstWs, connect } = await startClientAndConnect({ client });
      expect(connect.params?.auth).toEqual({ deviceToken: "stored-device-token" });
      await expectNoReconnectAfterConnectFailure({
        client,
        firstWs,
        connectId: connect.id,
        failureDetails: { code: "AUTH_DEVICE_TOKEN_MISMATCH" },
      });
      const params = expectRecordFields(
        firstMockArg(clearDeviceAuthTokenMock, "clear device token params"),
        { role: "operator", env },
        "clear device token params",
      );
      expect(params.deviceId).toBeTypeOf("string");
      expect(params).toHaveProperty("deviceId");
      expect(onReconnectPaused).toHaveBeenCalledWith({
        code: 1008,
        reason: "connect failed",
        detailCode: "AUTH_DEVICE_TOKEN_MISMATCH",
      });
    },
  );

  it("does not auto-reconnect on token mismatch when retry is not trusted", async () => {
    loadDeviceAuthTokenMock.mockReturnValue({ token: "stored-device-token" });
    const client = createClient({
      url: "wss://gateway.example.com:18789",
      token: "shared-token",
    });

    const { ws: ws1, connect: firstConnect } = await startClientAndConnect({ client });
    await expectNoReconnectAfterConnectFailure({
      client,
      firstWs: ws1,
      connectId: firstConnect.id,
      failureDetails: { code: "AUTH_TOKEN_MISMATCH", canRetryWithDeviceToken: true },
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
