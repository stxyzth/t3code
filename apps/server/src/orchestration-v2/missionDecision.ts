import {
  MessageId,
  type CommandId,
  type MissionAction,
  type OrchestrationV2ThreadProjection,
  type ThreadMission,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  backgroundWorkHoldsCompletion,
  derivePendingBackgroundWork,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

type Decision =
  | { readonly mission: ThreadMission; readonly prompt?: string }
  | { readonly error: string }
  | null;

export function missionPrompt(mission: ThreadMission): string {
  const stage = {
    plan: "Inspect the project and produce a concise, actionable plan for the outcome. Do not implement yet.",
    implement:
      "Implement the agreed plan. Run relevant checks and fix failures. Stay within the requested scope.",
    verify:
      "Verify the result against every acceptance criterion. Inspect the actual changes and run relevant checks. Report needs_work if any criterion fails or lacks evidence.",
  }[mission.phase];
  return [
    `Mission: ${mission.objective}`,
    `Acceptance criteria:\n${mission.criteria.map((criterion, index) => `${index + 1}. ${criterion}`).join("\n")}`,
    `Stage: ${mission.phase}. ${stage}`,
    `Turn ${mission.turnsUsed} of ${mission.maxTurns}.`,
    mission.summary ? `Previous report: ${mission.summary}` : "",
    "Before ending this turn, call t3_mission_report with progress, stage_complete, needs_work, or blocked, a concise summary, and evidence (test results, file paths, commit SHAs or artifact URLs). stage_complete during verification requires evidence for every acceptance criterion.",
    "Work within existing permissions. Do not merge, deploy, publish, or contact others unless already authorized. Report blocked for a decision or access you need. A report does not itself finish the user's mission; verification is followed by user acceptance.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function decideMissionAction(input: {
  readonly commandId: CommandId;
  readonly now: DateTime.Utc;
  readonly action: MissionAction;
  readonly projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "runtimeRequests" | "providerThreads" | "turnItems"
  >;
}): Decision {
  const { action, projection } = input;
  const current = projection.thread.mission;
  if (action.expectedRevision !== (current?.revision ?? 0)) {
    return action.type === "advance"
      ? null
      : { error: "The mission changed. Reload it before trying again." };
  }
  const busy = projection.runs.some((run) =>
    ["queued", "preparing", "starting", "running", "waiting"].includes(run.status),
  );
  const latestRun = projection.runs.reduce<
    OrchestrationV2ThreadProjection["runs"][number] | undefined
  >((latest, run) => (!latest || run.ordinal > latest.ordinal ? run : latest), undefined);
  const waiting =
    projection.runtimeRequests.some((request) => request.status === "pending") ||
    backgroundWorkHoldsCompletion(
      derivePendingBackgroundWork({
        ...projection,
        latestRun,
        activeProviderThreadId: projection.thread.activeProviderThreadId,
        pullRequests: projection.thread.pullRequests,
      }),
    );
  const nativeGoal = projection.providerThreads.some((thread) => thread.goal?.status === "active");
  const unavailable =
    projection.thread.archivedAt !== null ||
    projection.thread.deletedAt !== null ||
    projection.thread.settledOverride === "settled" ||
    (projection.thread.snoozedUntil != null &&
      DateTime.toEpochMillis(projection.thread.snoozedUntil) > DateTime.toEpochMillis(input.now)) ||
    projection.thread.lineage.relationshipToParent === "subagent" ||
    projection.thread.lineage.sideChat === true ||
    projection.thread.delegatedFrom !== undefined;
  if (action.type === "start") {
    if (current && !["completed", "cancelled"].includes(current.status)) {
      return { error: "Finish or cancel the existing mission first." };
    }
    if (
      busy ||
      waiting ||
      nativeGoal ||
      unavailable ||
      projection.thread.interactionMode === "plan"
    ) {
      return {
        error:
          "Start a mission in an idle, active thread in default mode, without other background work or a native goal.",
      };
    }
    return {
      mission: {
        id: input.commandId,
        revision: (current?.revision ?? 0) + 1,
        objective: action.objective,
        criteria: action.criteria,
        maxTurns: action.maxTurns,
        turnsUsed: 0,
        status: "active",
        phase: "plan",
        lastMessageId: null,
        summary: "Preparing a plan.",
        evidence: [],
        report: null,
      },
    };
  }
  if (!current) return { error: "This thread has no mission." };
  const next = { ...current, revision: current.revision + 1 };
  switch (action.type) {
    case "pause":
      return current.status === "active"
        ? { mission: { ...next, status: "paused" } }
        : { error: "Only an active mission can be paused." };
    case "cancel":
      return { mission: { ...next, status: "cancelled", report: null } };
    case "accept":
      return current.status === "ready"
        ? { mission: { ...next, status: "completed" } }
        : { error: "Only a mission ready for review can be accepted." };
    case "resume": {
      if (
        !["paused", "blocked"].includes(current.status) ||
        busy ||
        waiting ||
        unavailable ||
        nativeGoal ||
        projection.thread.interactionMode === "plan"
      ) {
        return {
          error: "Resume a paused or blocked mission after its thread and background work finish.",
        };
      }
      const maxTurns = Math.min(30, current.maxTurns + action.additionalTurns);
      if (current.turnsUsed >= maxTurns)
        return { error: "Add more turns to resume this mission (maximum 30)." };
      return {
        mission: { ...next, status: "active", maxTurns, lastMessageId: null, report: null },
      };
    }
    case "report": {
      const run = projection.runs.find((run) => run.id === action.runId);
      if (
        current.status !== "active" ||
        run?.status !== "running" ||
        run.userMessageId !== current.lastMessageId
      ) {
        return { error: "Only the mission's current running turn can report progress." };
      }
      if (
        current.phase === "verify" &&
        action.outcome === "stage_complete" &&
        action.evidence.length < current.criteria.length
      ) {
        return {
          error:
            "Provide at least one evidence entry for each acceptance criterion before finishing verification.",
        };
      }
      return {
        mission: {
          ...next,
          report: {
            runId: action.runId,
            outcome: action.outcome,
            summary: action.summary,
            evidence: action.evidence,
          },
        },
      };
    }
    case "advance": {
      if (current.status !== "active") return null;
      if (unavailable || nativeGoal || projection.thread.interactionMode === "plan") {
        return {
          mission: {
            ...next,
            status: "paused",
            summary:
              "Mission paused because the thread is unavailable or its execution mode changed.",
          },
        };
      }
      if (busy || waiting) return null;
      let mission = next;
      if (current.lastMessageId !== null) {
        if (
          latestRun?.userMessageId !== current.lastMessageId ||
          latestRun.status !== "completed"
        ) {
          return {
            mission: {
              ...next,
              status: "paused",
              summary:
                "The mission turn stopped, failed, or the conversation changed. Review the thread before resuming.",
            },
          };
        }
        const report = current.report;
        if (!report || report.runId !== latestRun.id) {
          return {
            mission: {
              ...next,
              status: "blocked",
              summary:
                "The agent ended its turn without a mission report. Review the result before resuming.",
            },
          };
        }
        mission = { ...next, summary: report.summary, evidence: report.evidence, report: null };
        if (report.outcome === "blocked") return { mission: { ...mission, status: "blocked" } };
        if (report.outcome === "stage_complete") {
          if (current.phase === "verify") return { mission: { ...mission, status: "ready" } };
          mission = { ...mission, phase: current.phase === "plan" ? "implement" : "verify" };
        }
        if (report.outcome === "needs_work") mission = { ...mission, phase: "implement" };
      }
      if (mission.turnsUsed >= mission.maxTurns) {
        return {
          mission: {
            ...mission,
            status: "paused",
            summary: `${mission.summary}\nTurn limit reached.`,
          },
        };
      }
      mission = {
        ...mission,
        turnsUsed: mission.turnsUsed + 1,
        lastMessageId: MessageId.make(`mission:${mission.id}:${mission.revision}`),
      };
      return { mission, prompt: missionPrompt(mission) };
    }
  }
}
