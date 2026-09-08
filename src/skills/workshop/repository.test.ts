import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  inspectLegacySkillWorkshopMigration,
  migrateLegacySkillWorkshopProposals,
} from "../../commands/doctor-skill-workshop-sqlite.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { loadWorkspaceSkills } from "../loading/workspace-skill-loader.js";
import { bumpSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import { stripProposalFrontmatterForSkill } from "./frontmatter.js";
import { hashSkillProposalContent } from "./proposal-hash.js";
import {
  applySkillProposal,
  inspectSkillProposal,
  proposeCreateSkill,
  proposeUpdateSkill,
  reviseSkillProposal,
} from "./service.js";
import { writeSkillProposalRollback } from "./store-sqlite-rollback.js";
import { importLegacySkillProposal, readSkillProposalRecord } from "./store.js";
import { SKILL_WORKSHOP_ROLLBACK_SCHEMA } from "./types.js";
import { listWritableWorkshopSkillSummaries } from "./workspace-skill-read.js";

const dirs = createTrackedTempDirs();
let state: OpenClawTestState;
let repository: string;
let config: OpenClawConfig;
let source: string;
const original =
  "---\nname: release-review\ndescription: Review a release\n---\n\n# Review\nPreserve existing checks.\n";

beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only", prefix: "workshop-repository-" });
  repository = await dirs.make("workshop-source-");
  await fs.mkdir(path.join(repository, ".git"));
  source = path.join(repository, "skills", "release-review", "SKILL.md");
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, original);
  config = {
    skills: {
      workshop: {
        repository: { path: repository, ownerAgentId: "main", writableSkills: ["release-review"] },
      },
    },
  };
});
afterEach(async () => {
  await state.cleanup();
  await dirs.cleanup();
});
function options() {
  return { config, agentId: "main", env: state.env, workspaceDir: repository };
}

describe("Workshop repository source", () => {
  it.each([false, true])("survives CLI legacy migration with revoked grant=%s", async (revoked) => {
    const proposal = await proposeUpdateSkill({
      ...options(),
      skillName: "release-review",
      content: "# Review\nKeep repository ownership.\n",
    });
    const migrationConfig = revoked ? {} : config;
    expect(
      (await inspectLegacySkillWorkshopMigration({ config: migrationConfig, env: state.env }))
        .externalProposalCount,
    ).toBe(0);
    await migrateLegacySkillWorkshopProposals({ config: migrationConfig, env: state.env });
    expect((await inspectSkillProposal(proposal.record.id, options()))?.record.status).toBe(
      "pending",
    );
    expect(await fs.readFile(source, "utf8")).toBe(original);
    await applySkillProposal({ ...options(), proposalId: proposal.record.id });
    expect(await fs.readFile(source, "utf8")).toContain("Keep repository ownership.");
  });

  it("keeps legacy claims for reserved names out of canonical relocation", async () => {
    const proposal = await proposeUpdateSkill({
      ...options(),
      skillName: "release-review",
      content: "# Review\nCanonical proposal.\n",
    });
    const legacyDir = path.join(repository, "legacy", "skills", "release-review");
    await fs.mkdir(legacyDir, { recursive: true });
    const legacyFile = path.join(legacyDir, "SKILL.md");
    await fs.writeFile(legacyFile, original);
    const legacy = {
      ...proposal.record,
      id: "legacy-review-20260908-1234567890",
      kind: "create" as const,
      status: "applied" as const,
      appliedAt: proposal.record.createdAt,
      draftHash: hashSkillProposalContent(original),
      target: {
        ...proposal.record.target,
        skillDir: legacyDir,
        skillFile: legacyFile,
        source: "openclaw-workspace",
      },
    };
    importLegacySkillProposal({ record: legacy, ownerAgentId: "main", store: { env: state.env } });
    await migrateLegacySkillWorkshopProposals({ config, env: state.env });
    const preserved = await readSkillProposalRecord(
      legacy.id,
      options(),
      { agentId: "main" },
      { config },
    );
    expect(preserved).toMatchObject({ status: "stale", target: legacy.target });
    expect(preserved?.statusReason).toContain("history only");
    expect(await fs.readFile(source, "utf8")).toBe(original);
    expect(await fs.readFile(legacyFile, "utf8")).toBe(original);
  });

  it("updates canonical source through propose, revise, apply and inspect without writing consumers", async () => {
    const consumer = path.join(repository, "consumer", "release-review", "SKILL.md");
    await fs.mkdir(path.dirname(consumer), { recursive: true });
    await fs.writeFile(consumer, original);
    const proposal = await proposeUpdateSkill({
      ...options(),
      skillName: "release-review",
      content: "# Review\nCheck the owned repository.\n",
    });
    expect(proposal.record.target).toMatchObject({ skillFile: source, source: "repository" });
    expect(await fs.readFile(source, "utf8")).toBe(original);
    const revised = await reviseSkillProposal({
      ...options(),
      proposalId: proposal.record.id,
      content: "# Review\nCheck the owned repository and preserve existing checks.\n",
    });
    await applySkillProposal({
      ...options(),
      proposalId: proposal.record.id,
      expectedRevisionHash: revised.revisionHash,
    });
    expect(await fs.readFile(source, "utf8")).toContain("owned repository and preserve");
    expect(await fs.readFile(consumer, "utf8")).toBe(original);
    expect((await inspectSkillProposal(proposal.record.id, options()))?.record.status).toBe(
      "applied",
    );
  });

  it("does not expose unpublished repository source to the runtime loader", async () => {
    const workspace = await dirs.make("workshop-consumer-workspace-");
    const selected = () =>
      loadWorkspaceSkills(workspace, { config, agentId: "main" }).filter(
        ({ skill }) => skill.name === "release-review",
      );
    expect(selected()).toEqual([]);
    const consumer = path.join(workspace, "skills", "release-review", "SKILL.md");
    await fs.mkdir(path.dirname(consumer), { recursive: true });
    await fs.writeFile(consumer, original);
    bumpSkillsSnapshotVersion({ reason: "manual", changedPath: consumer });
    const loaded = selected();
    expect(loaded.map(({ skill }) => skill.filePath)).toEqual([consumer]);
  });

  it("creates a new registered skill in the canonical source only", async () => {
    config.skills!.workshop!.repository!.writableSkills.push("new-procedure");
    const proposal = await proposeCreateSkill({
      ...options(),
      name: "new-procedure",
      description: "Review changes",
      content: "# Review\nCheck the diff.\n",
    });
    await applySkillProposal({ ...options(), proposalId: proposal.record.id });
    expect(proposal.record.target.source).toBe("repository");
    expect(
      await fs.readFile(path.join(repository, "skills", "new-procedure", "SKILL.md"), "utf8"),
    ).toContain("Check the diff.");
  });

  it.each([false, true])(
    "recovers an interrupted apply only while ownership is retained (revoked=%s)",
    async (revoked) => {
      const proposal = await proposeUpdateSkill({
        ...options(),
        skillName: "release-review",
        content: "# Review\nNew source.\n",
      });
      await writeSkillProposalRollback({
        proposalId: proposal.record.id,
        store: options(),
        rollback: {
          schema: SKILL_WORKSHOP_ROLLBACK_SCHEMA,
          proposalId: proposal.record.id,
          writtenAt: new Date().toISOString(),
          targetSkillFile: source,
          action: "update",
          previousContent: original,
          previousContentHash: hashSkillProposalContent(original),
        },
      });
      const appliedContent = stripProposalFrontmatterForSkill(proposal.content);
      await fs.writeFile(source, appliedContent);
      if (revoked) {
        config.skills!.workshop!.repository!.writableSkills = [];
      }
      const inspected = await inspectSkillProposal(proposal.record.id, options());
      expect(inspected?.record.status).toBe(revoked ? "pending" : "applied");
      expect(await fs.readFile(source, "utf8")).toBe(appliedContent);
    },
  );

  it("preserves edits made after proposal creation", async () => {
    const proposal = await proposeUpdateSkill({
      ...options(),
      skillName: "release-review",
      content: "# Changed",
    });
    await fs.writeFile(source, original + "\nConcurrent edit.\n");
    await expect(
      applySkillProposal({ ...options(), proposalId: proposal.record.id }),
    ).rejects.toThrow(/changed/i);
    expect(await fs.readFile(source, "utf8")).toContain("Concurrent edit.");
  });

  it("rejects agents and skills outside the explicit ownership grant", async () => {
    await expect(
      proposeUpdateSkill({
        ...options(),
        agentId: "other",
        skillName: "release-review",
        content: "# Changed",
      }),
    ).rejects.toThrow();
    config.skills!.workshop!.repository!.writableSkills = ["different-skill"];
    expect(listWritableWorkshopSkillSummaries(options())).toEqual([]);
    await expect(
      proposeUpdateSkill({ ...options(), skillName: "release-review", content: "# Changed" }),
    ).rejects.toThrow();
    expect(await fs.readFile(source, "utf8")).toBe(original);
  });

  it("revalidates ownership at apply after a proposal was created", async () => {
    const proposal = await proposeUpdateSkill({
      ...options(),
      skillName: "release-review",
      content: "# Changed",
    });
    config.skills!.workshop!.repository!.writableSkills = [];
    await expect(
      applySkillProposal({ ...options(), proposalId: proposal.record.id }),
    ).rejects.toThrow();
    expect(await fs.readFile(source, "utf8")).toBe(original);
  });

  it("does not apply a legacy agent-local proposal after its name becomes repository-owned", async () => {
    const legacy = await proposeCreateSkill({
      ...options(),
      config: {},
      name: "release-review",
      description: "Review a release",
      content: "# Old local draft",
    });
    await expect(
      applySkillProposal({ ...options(), proposalId: legacy.record.id }),
    ).rejects.toThrow(/repository-owned/i);
    expect(await fs.readFile(source, "utf8")).toBe(original);
    expect((await inspectSkillProposal(legacy.record.id, options()))?.record.status).toBe(
      "pending",
    );
  });

  it.each([false, true])(
    "rejects a pre-existing local copy at repository create/apply (late=%s)",
    async (late) => {
      config.skills!.workshop!.repository!.writableSkills.push("new-procedure");
      const draft = {
        name: "new-procedure",
        description: "Review changes",
        content: "# Review\nPreserve existing checks.\n",
      };
      const canonicalProposal = late
        ? await proposeCreateSkill({ ...options(), ...draft })
        : undefined;
      const local = await proposeCreateSkill({ ...options(), config: {}, ...draft });
      await applySkillProposal({ ...options(), config: {}, proposalId: local.record.id });
      if (canonicalProposal) {
        await expect(
          applySkillProposal({ ...options(), proposalId: canonicalProposal.record.id }),
        ).rejects.toThrow(/local.*cop|duplicate/i);
      } else {
        await expect(proposeCreateSkill({ ...options(), ...draft })).rejects.toThrow(
          /local.*cop|duplicate/i,
        );
      }
      await expect(
        fs.access(path.join(repository, "skills", "new-procedure", "SKILL.md")),
      ).rejects.toThrow();
      expect(await fs.readFile(local.record.target.skillFile, "utf8")).toContain(
        "Preserve existing checks.",
      );
    },
  );

  it("does not create a Workshop duplicate of a repository-owned skill", async () => {
    await expect(
      proposeCreateSkill({
        ...options(),
        agentId: "other",
        name: "release-review",
        description: "Review a release",
        content: "# Changed",
      }),
    ).rejects.toThrow(/repository/i);
    expect(await fs.readFile(source, "utf8")).toBe(original);
  });

  it("fails closed for consumer roots and symlinked source skills", async () => {
    await fs.writeFile(path.join(repository, ".agent-skills-receipt.json"), "{}");
    await expect(
      proposeUpdateSkill({ ...options(), skillName: "release-review", content: "# Changed" }),
    ).rejects.toThrow();
    await fs.unlink(path.join(repository, ".agent-skills-receipt.json"));
    const outside = await dirs.make("workshop-external-");
    await fs.rename(path.dirname(source), path.join(outside, "release-review"));
    await fs.symlink(path.join(outside, "release-review"), path.dirname(source), "dir");
    await expect(
      proposeUpdateSkill({ ...options(), skillName: "release-review", content: "# Changed" }),
    ).rejects.toThrow();
    expect(await fs.readFile(path.join(outside, "release-review", "SKILL.md"), "utf8")).toBe(
      original,
    );
  });
});
