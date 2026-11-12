import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { AsyncResult } from "effect/reactivity";
import type {
  EnvironmentId,
  MissionAction,
  ThreadId,
  ThreadMission as Mission,
} from "@t3tools/contracts";
import { AppText, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

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
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [objective, setObjective] = useState("");
  const [criteria, setCriteria] = useState("");
  const [pending, setPending] = useState(false);
  const update = useAtomCommand(threadEnvironment.updateMetadata, "update mission");
  const run = async (missionAction: MissionAction) => {
    setPending(true);
    const result = await update({ environmentId, input: { threadId, missionAction } }).finally(() =>
      setPending(false),
    );
    if (AsyncResult.isSuccess(result)) setEditing(false);
  };
  const expectedRevision = mission?.revision ?? 0;
  const disabled = !canOperate || pending;
  const criteriaList = criteria
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const canStart =
    !isWorking &&
    objective.trim().length > 0 &&
    criteriaList.length > 0 &&
    criteriaList.length <= 20 &&
    criteriaList.every((line) => line.length <= 8000);
  return (
    <View className="border-b border-border px-4 py-2">
      {mission && !editing ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            onPress={() => setExpanded(!expanded)}
            className="min-h-11 justify-center gap-1"
          >
            <AppText numberOfLines={1} className="font-t3-medium">
              {mission.objective}
            </AppText>
            <AppText className="text-sm text-foreground-muted">
              {mission.status === "ready" ? "Ready for review" : mission.status} · {mission.phase} ·{" "}
              {mission.turnsUsed}/{mission.maxTurns} turns
            </AppText>
          </Pressable>
          {expanded ? (
            <ScrollView className="max-h-72" keyboardShouldPersistTaps="handled">
              <View className="gap-3 py-2">
                <AppText selectable>{mission.summary}</AppText>
                <AppText className="font-t3-medium">Acceptance criteria</AppText>
                {[...new Set(mission.criteria)].map((criterion, index) => (
                  <AppText key={criterion} selectable>
                    {index + 1}. {criterion}
                  </AppText>
                ))}
                {mission.evidence.length ? (
                  <AppText className="font-t3-medium">Reported evidence</AppText>
                ) : null}
                {[...new Set(mission.evidence)].map((evidence) => (
                  <AppText key={evidence} selectable>
                    {evidence}
                  </AppText>
                ))}
                <View className="flex-row flex-wrap gap-2">
                  {mission.status === "active" ? (
                    <Button
                      size="compact"
                      label="Pause after this turn"
                      disabled={disabled}
                      onPress={() => void run({ type: "pause", expectedRevision })}
                    />
                  ) : null}
                  {["paused", "blocked"].includes(mission.status) ? (
                    <Button
                      size="compact"
                      label={
                        mission.turnsUsed >= mission.maxTurns
                          ? `Add ${Math.min(5, 30 - mission.maxTurns)} turns and resume`
                          : "Resume mission"
                      }
                      disabled={disabled || isWorking || mission.turnsUsed >= 30}
                      onPress={() =>
                        void run({
                          type: "resume",
                          expectedRevision,
                          additionalTurns: mission.turnsUsed >= mission.maxTurns ? 5 : 0,
                        })
                      }
                    />
                  ) : null}
                  {mission.status === "ready" ? (
                    <Button
                      size="compact"
                      label="Accept result"
                      disabled={disabled}
                      onPress={() => void run({ type: "accept", expectedRevision })}
                    />
                  ) : null}
                  {!["completed", "cancelled"].includes(mission.status) ? (
                    <Button
                      size="compact"
                      tone="text"
                      label="End mission"
                      disabled={disabled}
                      onPress={() => void run({ type: "cancel", expectedRevision })}
                    />
                  ) : (
                    <Button
                      size="compact"
                      label="Start another mission"
                      disabled={disabled || isWorking}
                      onPress={() => setEditing(true)}
                    />
                  )}
                </View>
                <AppText className="text-sm text-foreground-muted">
                  Pausing or ending stops follow-up turns. Use Stop to interrupt current work.
                  Review the evidence before accepting a result.
                </AppText>
              </View>
            </ScrollView>
          ) : null}
        </>
      ) : null}
      {!mission && !editing ? (
        <Button
          size="compact"
          tone="text"
          label="Run a mission"
          disabled={disabled || isWorking}
          onPress={() => setEditing(true)}
        />
      ) : null}
      {editing ? (
        <ScrollView className="max-h-80" keyboardShouldPersistTaps="handled">
          <View className="gap-3 py-2">
            <AppText className="font-t3-medium">Give the agent an outcome</AppText>
            <AppText className="text-sm text-foreground-muted">
              Plan, implement, and verify in up to 8 turns using this thread’s workspace and
              permissions. Each turn uses your selected provider.
            </AppText>
            <AppTextInput
              accessibilityLabel="Outcome"
              placeholder="What should the agent deliver?"
              value={objective}
              onChangeText={setObjective}
              multiline
              maxLength={8000}
            />
            <AppTextInput
              accessibilityLabel="Acceptance criteria, one per line"
              placeholder="Acceptance criteria, one per line"
              value={criteria}
              onChangeText={setCriteria}
              multiline
              maxLength={160000}
            />
            <View className="flex-row gap-2">
              <Button
                size="compact"
                tone="primary"
                label="Start mission"
                loading={pending}
                disabled={disabled || !canStart}
                onPress={() =>
                  void run({
                    type: "start",
                    expectedRevision,
                    objective: objective.trim(),
                    criteria: criteriaList,
                    maxTurns: 8,
                  })
                }
              />
              <Button
                size="compact"
                tone="text"
                label="Cancel"
                disabled={pending}
                onPress={() => setEditing(false)}
              />
            </View>
          </View>
        </ScrollView>
      ) : null}
    </View>
  );
}
