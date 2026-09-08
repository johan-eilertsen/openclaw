import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { assertInsideSkillsRoot } from "../lifecycle/workspace-skill-write.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";
import type { SkillProposalRecord } from "./types.js";

type Repository = NonNullable<NonNullable<OpenClawConfig["skills"]>["workshop"]>["repository"];

/** Configuration is the operator's ownership grant, never a skill's frontmatter. */
export function resolveWorkshopRepositoryRoot(repository: NonNullable<Repository>): string {
  if (!path.isAbsolute(repository.path)) {
    throw new Error("Workshop repository path must be absolute.");
  }
  const repositoryDir = path.resolve(repository.path);
  const skillsRoot = path.join(repositoryDir, "skills");
  for (const directory of [repositoryDir, skillsRoot]) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Workshop repository directories must be real directories.");
    }
  }
  const git = fs.lstatSync(path.join(repositoryDir, ".git"));
  if (git.isSymbolicLink() || (!git.isDirectory() && !git.isFile())) {
    throw new Error("Workshop repository must be a Git checkout.");
  }
  if (
    [repositoryDir, skillsRoot].some((dir) =>
      fs.existsSync(path.join(dir, ".agent-skills-receipt.json")),
    )
  ) {
    throw new Error("Workshop cannot author a published consumer directory.");
  }
  return skillsRoot;
}

function assertNoAgentLocalCopy(params: {
  config: OpenClawConfig;
  agentId: string;
  skillKey: string;
  env?: NodeJS.ProcessEnv;
}): void {
  const local = path.join(
    resolveWorkshopSkillsDir(params.config, params.agentId, params.env),
    params.skillKey,
  );
  try {
    fs.lstatSync(local);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  throw new Error(
    "An agent-local copy already exists; reconcile ownership before authoring the repository skill.",
  );
}

export function resolveWorkshopTargetRoot(params: {
  config: OpenClawConfig;
  agentId: string;
  env?: NodeJS.ProcessEnv;
  target: SkillProposalRecord["target"];
}): string {
  const { target } = params;
  let skillsRoot: string;
  if (target.source === "repository") {
    const repository = params.config.skills?.workshop?.repository;
    if (
      !repository ||
      repository.ownerAgentId !== params.agentId ||
      !repository.writableSkills.includes(target.skillKey)
    ) {
      throw new Error("Workshop repository ownership grant is missing or revoked.");
    }
    assertNoAgentLocalCopy({ ...params, skillKey: target.skillKey });
    skillsRoot = resolveWorkshopRepositoryRoot(repository);
    const localRoot = resolveWorkshopSkillsDir(params.config, params.agentId, params.env);
    if (fs.existsSync(path.join(localRoot, target.skillKey))) {
      throw new Error(
        "Workshop repository skill cannot be applied while an agent-local copy exists; remove or migrate the duplicate first.",
      );
    }
    if (
      target.skillName !== target.skillKey ||
      target.skillDir !== path.join(skillsRoot, target.skillKey) ||
      target.skillFile !== path.join(skillsRoot, target.skillKey, "SKILL.md")
    ) {
      throw new Error("Workshop repository target does not match its ownership grant.");
    }
  } else {
    if (params.config.skills?.workshop?.repository?.writableSkills.includes(target.skillKey)) {
      throw new Error(
        "This name is now repository-owned; old agent-local proposals are history only.",
      );
    }
    skillsRoot = resolveWorkshopSkillsDir(params.config, params.agentId, params.env);
  }
  assertInsideSkillsRoot(skillsRoot, target.skillDir, "skill directory");
  assertInsideSkillsRoot(skillsRoot, target.skillFile, "skill file");
  return skillsRoot;
}

/** A reserved repository name must never become a parallel agent-local skill. */
export function resolveWorkshopCreateRoot(params: {
  config: OpenClawConfig;
  agentId: string;
  skillKey: string;
  env?: NodeJS.ProcessEnv;
}): { skillsRoot: string; source?: string } {
  const repository = params.config.skills?.workshop?.repository;
  if (repository?.writableSkills.includes(params.skillKey)) {
    if (repository.ownerAgentId !== params.agentId) {
      throw new Error(
        "This name belongs to the Workshop repository; route changes to its owner agent.",
      );
    }
    const repositoryRoot = resolveWorkshopRepositoryRoot(repository);
    const localRoot = resolveWorkshopSkillsDir(params.config, params.agentId, params.env);
    const localSkillDir = path.join(localRoot, params.skillKey);
    if (fs.existsSync(localSkillDir)) {
      throw new Error(
        "Workshop repository skill cannot be created while an agent-local copy exists; remove or migrate the duplicate first.",
      );
    }
    return { skillsRoot: repositoryRoot, source: "repository" };
  }
  return { skillsRoot: resolveWorkshopSkillsDir(params.config, params.agentId, params.env) };
}
