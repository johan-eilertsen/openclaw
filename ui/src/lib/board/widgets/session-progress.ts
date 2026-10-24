import { consume } from "@lit/context";
import type { BoardGetParams, ProgressCardGetParams } from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../../../app/context.ts";
import { SessionProgressCardController } from "../../../components/session-progress-card-controller.ts";
import { renderSessionProgressCard } from "../../../components/session-progress-card.ts";
import { t } from "../../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../../lit/subscriptions-controller.ts";
import { resolveSessionProgressCardTarget } from "../../session-progress-cards.ts";
import { isSessionRunActive } from "../../session-run-state.ts";
import type { SessionRowObservation } from "../../sessions/session-capability.ts";
import { parseAgentSessionKey } from "../../sessions/session-key.ts";
import type { BoardWidget } from "../types.ts";

function resolveSessionTarget(
  widget: BoardWidget | undefined,
  boardSession: BoardGetParams,
): ProgressCardGetParams {
  const value = widget?.props?.sessionKey;
  const key = typeof value === "string" ? value.trim() : "";
  // Unqualified overrides retain the board's captured owner; qualified links name their own.
  return key
    ? { sessionKey: key, agentId: parseAgentSessionKey(key)?.agentId ?? boardSession.agentId }
    : boardSession;
}

class OpenClawSessionProgressWidget extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @property({ attribute: false }) widget?: BoardWidget;
  @property({ attribute: false }) session: BoardGetParams = { sessionKey: "" };
  @property({ attribute: false }) active = true;

  private rowBinding?: {
    sessions: ApplicationContext["sessions"];
    sessionKey: string;
    agentId: string;
    observation?: SessionRowObservation;
    unavailable: boolean;
    reading: boolean;
    retry?: () => void;
  };

  private readonly progressCard = new SessionProgressCardController(this, {
    gateway: () =>
      this.active && resolveSessionTarget(this.widget, this.session).sessionKey
        ? this.context?.gateway
        : undefined,
    target: () => resolveSessionTarget(this.widget, this.session),
  });

  constructor() {
    super();
    new SubscriptionsController(this)
      .watchStore(() => this.context?.gateway)
      .watchStore(() => this.context?.agentSelection);
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.bindSessionRow();
  }

  override disconnectedCallback(): void {
    this.releaseSessionRow();
    super.disconnectedCallback();
  }

  override willUpdate(): void {
    this.bindSessionRow();
  }

  override render() {
    const loadError = this.progressCard.error;
    const card = this.progressCard.card;
    const errorNotice = loadError
      ? html`<div
          class=${card ? "callout info" : "board-widget__plugin-loading"}
          data-test-id="session-progress-error"
          role="alert"
        >
          <span
            >${t(
              loadError === "access-denied"
                ? "sessionProgressCard.widgetAccessDenied"
                : "sessionProgressCard.widgetUnavailable",
            )}</span
          >
          ${
            loadError === "unavailable"
              ? html`<button class="btn btn--sm" type="button" @click=${this.progressCard.retry}>
                  ${t("common.retry")}
                </button>`
              : null
          }
        </div>`
      : nothing;
    if (loadError && !card) {
      return errorNotice;
    }
    if (this.progressCard.loading) {
      return html`<p class="board-widget__plugin-loading">
        ${t("sessionProgressCard.widgetLoading")}
      </p>`;
    }
    if (card === null) {
      return html`<p class="board-widget__plugin-loading">
        ${t("sessionProgressCard.widgetEmpty")}
      </p>`;
    }
    const row = this.rowBinding?.observation?.row;
    return html`${errorNotice}${renderSessionProgressCard(
      card,
      "board",
      undefined,
      row?.status,
      row?.startedAt,
      row?.endedAt,
      isSessionRunActive(row ?? {}),
      false,
      undefined,
      undefined,
      undefined,
      {
        hasActiveSubagentRun: row?.hasActiveSubagentRun,
        known: Boolean(row) && !this.rowBinding?.unavailable,
        connected: this.context?.gateway.snapshot.phase === "connected",
        lastRunError: row?.lastRunError,
      },
    )}${
      this.rowBinding?.unavailable
        ? html`<button
            class="btn btn--sm"
            type="button"
            data-test-id="session-progress-runtime-retry"
            title=${t("sessionProgressCard.runtime.unknown")}
            ?disabled=${this.rowBinding.reading}
            @click=${this.rowBinding.retry}
          >
            ${t("common.retry")}
          </button>`
        : nothing
    }`;
  }

  private bindSessionRow(): void {
    const context = this.context;
    // Lit can flush queued updates after removal; don't reacquire the released listener.
    if (!this.isConnected || !context) {
      return;
    }
    const sessions = context.sessions;
    const identity = resolveSessionProgressCardTarget(
      context.gateway.snapshot,
      resolveSessionTarget(this.widget, this.session),
    );
    const targetAgentId = identity.agentId;
    const shouldObserve =
      this.active &&
      Boolean(resolveSessionTarget(this.widget, this.session).sessionKey) &&
      context.gateway.snapshot.phase === "connected";
    if (!shouldObserve || !targetAgentId) {
      this.releaseSessionRow();
      return;
    }
    if (
      sessions === this.rowBinding?.sessions &&
      targetAgentId === this.rowBinding.agentId &&
      identity.sessionKey === this.rowBinding.sessionKey &&
      this.rowBinding.observation?.isCurrent()
    ) {
      return;
    }
    this.releaseSessionRow();
    const binding: NonNullable<OpenClawSessionProgressWidget["rowBinding"]> = {
      sessions,
      sessionKey: identity.sessionKey,
      agentId: targetAgentId,
      unavailable: false,
      reading: false,
    };
    this.rowBinding = binding;
    const current = () =>
      this.rowBinding === binding && this.context === context && this.isConnected && this.active;
    const refresh = async () => {
      if (binding.reading || !current() || !binding.observation?.isCurrent()) {
        return;
      }
      binding.reading = true;
      this.requestUpdate();
      try {
        while (current() && binding.observation.isCurrent()) {
          const reconcile = binding.observation.captureReconcile();
          const { session } = await sessions.describe({
            key: binding.sessionKey,
            agentId: binding.agentId,
          });
          if (!current()) {
            break;
          }
          const outcome = reconcile(session ?? undefined);
          if (outcome.status === "current") {
            binding.unavailable = false;
          }
          if (outcome.status !== "invalidated") {
            break;
          }
        }
      } catch {
        // Keep the saved plan; unknown runtime state is rendered explicitly.
        if (current()) {
          binding.unavailable = true;
        }
      } finally {
        binding.reading = false;
        if (current()) {
          this.requestUpdate();
        }
      }
    };
    binding.retry = () => void refresh();
    binding.observation = sessions.observeRow(
      { key: binding.sessionKey, agentId: binding.agentId },
      () => {
        binding.unavailable = false;
        this.requestUpdate();
      },
      { onInvalidate: () => void refresh() },
    );
    void refresh();
  }

  private releaseSessionRow(): void {
    this.rowBinding?.observation?.dispose();
    this.rowBinding = undefined;
  }
}

if (!customElements.get("openclaw-session-progress-widget")) {
  customElements.define("openclaw-session-progress-widget", OpenClawSessionProgressWidget);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-session-progress-widget": OpenClawSessionProgressWidget;
  }
}
