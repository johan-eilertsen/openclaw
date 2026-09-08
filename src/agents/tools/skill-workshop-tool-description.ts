import { SKILL_AUTHORING_STANDARDS_PROMPT } from "../../skills/workshop/skill-authoring-standards.js";
import { SKILL_WORKSHOP_TOOL_DISPLAY_SUMMARY } from "../tool-description-presets.js";

export function buildSkillWorkshopToolDescription(params: {
  autonomousMode: "off" | "propose" | "auto";
  proposalRevision: boolean;
}): string {
  if (params.proposalRevision) {
    return `Inspect and revise only the proposal revision selected by the operator. The proposal id and expected revision hash are bound by the run and cannot be replaced by tool arguments. Never apply, reject, quarantine, or create another proposal.\n\n${SKILL_AUTHORING_STANDARDS_PROMPT}`;
  }
  const repairPolicy =
    params.autonomousMode === "off"
      ? "Foreground repair is disabled."
      : params.autonomousMode === "propose"
        ? "A foreground patch to a skill used in this run stays pending for review."
        : "A foreground patch to a skill used in this run is scanned and applied immediately.";
  return `${SKILL_WORKSHOP_TOOL_DISPLAY_SUMMARY} Stage pending proposals to create or update reusable-procedure skills in your agent's Workshop directory, or author explicitly authorized canonical repository skills through their configured owner agent. Create and update do not write skill sources. Apply writes the bound source; repository skills still require their repository's validation and publisher before runtime activation. Read, prepare an exact bounded patch, patch, revise, inspect, evaluate, and apply Workshop proposals. Never edit repository consumer copies or create Workshop duplicates of repository-owned names. Unregistered sources remain outside Workshop ownership. Restore a retained backup from the previous collection-review implementation when the user asks. New reviews use automation history and do not create collection backups. ${repairPolicy}\n\n${SKILL_AUTHORING_STANDARDS_PROMPT}`;
}
