import { useId, useState } from "react";
import { AsyncResult } from "effect/reactivity";
import type {
  EnvironmentId,
  MissionAction,
  ThreadId,
  ThreadMission as Mission,
} from "@t3tools/contracts";
import { TargetIcon } from "lucide-react";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";

const statuses = {
  active: "Working",
  paused: "Paused",
  blocked: "Needs your input",
  ready: "Ready for review",
  completed: "Completed",
  cancelled: "Cancelled",
};
const phases = { plan: "Plan", implement: "Implement", verify: "Verify" };

export function ThreadMission({
  environmentId,
  threadId,
  mission,
  canOperate,
  isWorking,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly mission: Mission | undefined;
  readonly canOperate: boolean;
  readonly isWorking: boolean;
}) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [objective, setObjective] = useState("");
  const [criteria, setCriteria] = useState("");
  const [maxTurns, setMaxTurns] = useState("8");
  const [pending, setPending] = useState(false);
  const update = useOrchestrationCommand(
    threadEnvironment.updateMetadata,
    "Could not update mission.",
  );
  const run = async (missionAction: MissionAction) => {
    setPending(true);
    const result = await update({ environmentId, input: { threadId, missionAction } }).finally(() =>
      setPending(false),
    );
    if (AsyncResult.isSuccess(result)) setEditing(false);
  };
  const disabled = !canOperate || pending;
  const expectedRevision = mission?.revision ?? 0;
  const criteriaList = criteria
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const turns = Number(maxTurns);
  const canStart =
    !isWorking &&
    objective.trim().length > 0 &&
    objective.length <= 8000 &&
    criteriaList.length > 0 &&
    criteriaList.length <= 20 &&
    criteriaList.every((line) => line.length <= 8000) &&
    Number.isInteger(turns) &&
    turns >= 1 &&
    turns <= 30;
  return (
    <section aria-label="Mission" className="shrink-0 border-b border-border px-4 py-2 text-sm">
      {mission && !editing ? (
        <details>
          <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 rounded-sm py-1 focus-visible:outline-2 focus-visible:outline-ring">
            <TargetIcon className="size-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate font-medium">{mission.objective}</span>
            <span className="text-muted-foreground">
              {statuses[mission.status]} · {phases[mission.phase]} · {mission.turnsUsed}/
              {mission.maxTurns}
            </span>
          </summary>
          <div className="max-h-64 space-y-3 overflow-y-auto pt-3 pb-2">
            <p className="max-w-prose whitespace-pre-wrap wrap-anywhere">{mission.summary}</p>
            <div>
              <p className="font-medium">Acceptance criteria</p>
              <ol className="list-decimal space-y-1 pl-5">
                {[...new Set(mission.criteria)].map((criterion) => (
                  <li key={criterion} className="wrap-anywhere">
                    {criterion}
                  </li>
                ))}
              </ol>
            </div>
            {mission.evidence.length > 0 ? (
              <div>
                <p className="font-medium">Reported evidence</p>
                <ul className="list-disc space-y-1 pl-5">
                  {[...new Set(mission.evidence)].map((evidence) => (
                    <li key={evidence} className="whitespace-pre-wrap wrap-anywhere">
                      {evidence}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {mission.status === "active" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => void run({ type: "pause", expectedRevision })}
                >
                  Pause after this turn
                </Button>
              ) : null}
              {mission.status === "paused" || mission.status === "blocked" ? (
                <Button
                  size="sm"
                  disabled={disabled || isWorking || mission.turnsUsed >= 30}
                  onClick={() =>
                    void run({
                      type: "resume",
                      expectedRevision,
                      additionalTurns: mission.turnsUsed >= mission.maxTurns ? 5 : 0,
                    })
                  }
                >
                  {mission.turnsUsed >= mission.maxTurns
                    ? `Add ${Math.min(5, 30 - mission.maxTurns)} turns and resume`
                    : "Resume mission"}
                </Button>
              ) : null}
              {mission.status === "ready" ? (
                <Button
                  size="sm"
                  disabled={disabled}
                  onClick={() => void run({ type: "accept", expectedRevision })}
                >
                  Accept result
                </Button>
              ) : null}
              {!["completed", "cancelled"].includes(mission.status) ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => void run({ type: "cancel", expectedRevision })}
                >
                  End mission
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled || isWorking}
                  onClick={() => setEditing(true)}
                >
                  Start another mission
                </Button>
              )}
            </div>
            {mission.status === "active" ||
            mission.status === "paused" ||
            mission.status === "cancelled" ? (
              <p className="text-xs text-muted-foreground">
                Pausing or ending stops automatic follow-up turns. Use Stop in the composer to
                interrupt current work.
              </p>
            ) : null}
            {mission.status === "ready" ? (
              <p className="text-xs text-muted-foreground">
                Review the agent’s evidence and changes before accepting the result.
              </p>
            ) : null}
          </div>
        </details>
      ) : null}
      {!mission && !editing ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled || isWorking}
          onClick={() => setEditing(true)}
        >
          <TargetIcon aria-hidden />
          Run a mission
        </Button>
      ) : null}
      {editing ? (
        <form
          className="max-h-80 space-y-3 overflow-y-auto py-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!disabled && canStart)
              void run({
                type: "start",
                expectedRevision,
                objective: objective.trim(),
                criteria: criteriaList,
                maxTurns: turns,
              });
          }}
        >
          <p className="font-medium">Give the agent an outcome</p>
          <p className="max-w-prose text-muted-foreground">
            T3 continues through planning, implementation, and verification, then brings the result
            back for review. Runs on this thread’s workspace and permissions.
          </p>
          <div className="space-y-1">
            <Label htmlFor={`${id}-objective`}>Outcome</Label>
            <Textarea
              id={`${id}-objective`}
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
              maxLength={8000}
              required
              rows={2}
              placeholder="Add a working CSV export to the reports page"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-criteria`}>Acceptance criteria, one per line</Label>
            <Textarea
              id={`${id}-criteria`}
              value={criteria}
              onChange={(event) => setCriteria(event.target.value)}
              required
              rows={3}
              placeholder="Export includes the active filters&#10;Relevant tests pass"
            />
          </div>
          <div className="w-32 space-y-1">
            <Label htmlFor={`${id}-turns`}>Maximum turns</Label>
            <Input
              id={`${id}-turns`}
              type="number"
              min={1}
              max={30}
              value={maxTurns}
              onChange={(event) => setMaxTurns(event.target.value)}
              required
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Each turn uses your selected provider. The limit counts mission turns, not tokens or
            delegated work.
          </p>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={disabled || !canStart}>
              {pending ? "Starting…" : "Start mission"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setEditing(false)}
              disabled={pending}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
