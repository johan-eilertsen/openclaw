import { expectDefined } from "@openclaw/normalization-core";
import { resolveConfigWidePluginMetadataSnapshotAsync } from "../config/io.plugin-metadata.js";
import { normalizeSubmittedConfigModelRefs } from "../config/model-input-normalization.js";
import { normalizeAgentModelRefForConfig } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withArtifactPreservingStateReads } from "../state/openclaw-state-db-readonly.js";
import type { PathSegment } from "./config-cli-path.js";

export async function normalizeConfigMutationModelRefs(
  cfg: OpenClawConfig,
): Promise<OpenClawConfig> {
  const needsCatalogPolicy = Object.values(cfg.models?.providers ?? {}).some(
    (provider) =>
      Array.isArray(provider?.models) &&
      provider.models.some((model) => typeof model?.id === "string" && model.id.trim()),
  );
  if (!needsCatalogPolicy) {
    return normalizeSubmittedConfigModelRefs(cfg);
  }
  return withArtifactPreservingStateReads(async () => {
    const metadata = await resolveConfigWidePluginMetadataSnapshotAsync({
      config: cfg,
      env: process.env,
    });
    return normalizeSubmittedConfigModelRefs(cfg, metadata.owners.modelIdNormalizationPolicies);
  });
}

export function normalizeConfigMutationExplicitSetPath(path: PathSegment[]): PathSegment[] {
  const modelKeyIndex =
    path[0] === "agents" && path[1] === "defaults" && path[2] === "models"
      ? 3
      : path[0] === "agents" &&
          (path[1] === "entries" || path[1] === "list") &&
          path[3] === "models"
        ? 4
        : undefined;
  if (modelKeyIndex !== undefined && path.length > modelKeyIndex) {
    const modelId = expectDefined(path[modelKeyIndex], `path entry at ${modelKeyIndex}`);
    const normalizedModelId = normalizeAgentModelRefForConfig(modelId);
    return normalizedModelId === modelId
      ? path
      : [...path.slice(0, modelKeyIndex), normalizedModelId, ...path.slice(modelKeyIndex + 1)];
  }
  return path;
}
