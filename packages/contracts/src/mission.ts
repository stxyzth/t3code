import * as Schema from "effect/Schema";
import {
  CommandId,
  MessageId,
  NonNegativeInt,
  RunId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

const MissionText = TrimmedNonEmptyString.check(Schema.isMaxLength(8000));
const MissionEvidence = Schema.Array(MissionText).check(Schema.isMaxLength(20));
export const MissionReport = Schema.Struct({
  outcome: Schema.Literals(["progress", "stage_complete", "needs_work", "blocked"]),
  summary: MissionText,
  evidence: MissionEvidence,
});
export type MissionReport = typeof MissionReport.Type;

export const ThreadMission = Schema.Struct({
  id: CommandId,
  revision: NonNegativeInt,
  objective: MissionText,
  criteria: Schema.Array(MissionText).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  status: Schema.Literals(["active", "paused", "blocked", "ready", "completed", "cancelled"]),
  phase: Schema.Literals(["plan", "implement", "verify"]),
  maxTurns: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 30 })),
  turnsUsed: NonNegativeInt,
  lastMessageId: Schema.NullOr(MessageId),
  summary: Schema.String,
  evidence: MissionEvidence,
  report: Schema.NullOr(Schema.Struct({ ...MissionReport.fields, runId: RunId })),
});
export type ThreadMission = typeof ThreadMission.Type;

const version = { expectedRevision: NonNegativeInt };
export const MissionAction = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("start"),
    ...version,
    objective: ThreadMission.fields.objective,
    criteria: ThreadMission.fields.criteria,
    maxTurns: ThreadMission.fields.maxTurns,
  }),
  Schema.Struct({
    type: Schema.Literals(["pause", "cancel", "accept", "advance"]),
    ...version,
  }),
  Schema.Struct({
    type: Schema.Literal("resume"),
    ...version,
    additionalTurns: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20 })),
  }),
  Schema.Struct({
    type: Schema.Literal("report"),
    ...version,
    runId: RunId,
    ...MissionReport.fields,
  }),
]);
export type MissionAction = typeof MissionAction.Type;
