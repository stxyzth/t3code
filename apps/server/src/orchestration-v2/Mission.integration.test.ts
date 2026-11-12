import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type MissionAction,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as MissionReactor from "./MissionReactor.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { isAutoSettlementCandidate } from "./ThreadSettlementService.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Mission decisions do not need a provider process"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const database = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  database,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "missions" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);
const threadId = ThreadId.make("mission-thread");

const setup = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-thread"),
    threadId,
    projectId: ProjectId.make("mission-project"),
    title: "Mission",
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  const act = (id: string, missionAction: MissionAction) =>
    orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make(id),
      threadId,
      missionAction,
    });
  const read = () => projections.getThreadProjection(threadId);
  const status = Effect.fn("test.mission.runStatus")(function* (
    run: OrchestrationV2Run,
    status: OrchestrationV2Run["status"],
  ) {
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make(`${run.id}:${status}`),
      type: "run.updated",
      threadId,
      providerInstanceId: instanceId,
      occurredAt: now,
      payload: { ...run, status, startedAt: now, completedAt: status === "running" ? null : now },
    });
  });
  const start = (maxTurns = 8) =>
    act("start", {
      type: "start",
      expectedRevision: 0,
      objective: "Add CSV export",
      criteria: ["Filtered records are exported", "Relevant tests pass"],
      maxTurns,
    });
  const advance = Effect.fn("test.mission.advance")(function* () {
    const mission = (yield* read()).thread.mission!;
    return yield* act(`advance:${mission.revision}`, {
      type: "advance",
      expectedRevision: mission.revision,
    });
  });
  const report = Effect.fn("test.mission.report")(function* (
    outcome: "progress" | "stage_complete" | "needs_work" | "blocked",
    evidence = ["CSV output matches the selected records", "Export tests passed"],
  ) {
    const snapshot = yield* read();
    const run = snapshot.runs.at(-1)!;
    yield* status(run, "running");
    yield* act(`report:${snapshot.thread.mission!.revision}`, {
      type: "report",
      expectedRevision: snapshot.thread.mission!.revision,
      runId: run.id,
      outcome,
      summary: "Stage result",
      evidence,
    });
    yield* status(run, "completed");
  });
  return { orchestrator, projections, act, read, status, start, advance, report };
});

it.effect("discovers persisted missions at startup and schedules the next reported stage", () =>
  Effect.gen(function* () {
    const t = yield* setup;
    yield* t.start();
    const receipts = yield* Queue.unbounded<void>();
    yield* Layer.build(
      MissionReactor.layer.pipe(
        Layer.provide(Scheduler.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            dispatch: (command) =>
              t.orchestrator
                .dispatch(command)
                .pipe(Effect.tap(() => Queue.offer(receipts, undefined))),
          }),
        ),
      ),
    );
    yield* Queue.take(receipts);
    assert.equal((yield* t.read()).runs.length, 1);
    yield* t.report("stage_complete");
    yield* TestClock.adjust("5 seconds");
    yield* Queue.take(receipts);
    const state = yield* t.read();
    assert.equal(state.runs.length, 2);
    assert.equal(state.thread.mission?.phase, "implement");
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "persists a mission, dispatches each stage once, and requires verification and acceptance",
  () =>
    Effect.gen(function* () {
      const t = yield* setup;
      yield* t.start();
      assert.equal((yield* t.projections.getActiveMissionThreads()).length, 1);
      const first = yield* t.advance();
      const state = yield* t.read();
      assert.equal(state.runs.length, 1);
      assert.equal(state.thread.runtimeMode, "approval-required");
      assert.equal(state.thread.mission?.turnsUsed, 1);
      assert.ok(first.storedEvents.some(({ event }) => event.type === "run.created"));
      assert.ok(first.storedEvents.some(({ event }) => event.type === "thread.metadata-updated"));
      yield* t.act("duplicate-wake", { type: "advance", expectedRevision: 1 });
      assert.equal((yield* t.read()).runs.length, 1);
      yield* t.report("stage_complete");
      yield* t.advance();
      assert.equal((yield* t.read()).thread.mission?.phase, "implement");
      yield* t.report("stage_complete");
      yield* t.advance();
      assert.equal((yield* t.read()).thread.mission?.phase, "verify");
      const verify = yield* t.read();
      const run = verify.runs.at(-1)!;
      yield* t.status(run, "running");
      const missingEvidence = yield* Effect.exit(
        t.act("missing-evidence", {
          type: "report",
          expectedRevision: verify.thread.mission!.revision,
          runId: run.id,
          outcome: "stage_complete",
          summary: "Done",
          evidence: [],
        }),
      );
      assert.equal(missingEvidence._tag, "Failure");
      yield* t.report("stage_complete");
      yield* t.advance();
      const ready = yield* t.read();
      assert.equal(ready.thread.mission?.status, "ready");
      assert.equal(ready.runs.length, 3);
      assert.equal((yield* t.projections.getActiveMissionThreads()).length, 0);
      yield* t.act("accept", { type: "accept", expectedRevision: ready.thread.mission!.revision });
      assert.equal((yield* t.read()).thread.mission?.status, "completed");
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "stops at the budget, preserves completed stages, and resumes only with a new allowance",
  () =>
    Effect.gen(function* () {
      const t = yield* setup;
      yield* t.start(1);
      yield* t.advance();
      yield* t.report("stage_complete");
      yield* t.advance();
      const paused = (yield* t.read()).thread.mission!;
      assert.equal(paused.status, "paused");
      assert.equal(paused.phase, "implement");
      assert.equal(
        (yield* Effect.exit(
          t.act("resume-without-budget", {
            type: "resume",
            expectedRevision: paused.revision,
            additionalTurns: 0,
          }),
        ))._tag,
        "Failure",
      );
      yield* t.act("resume", {
        type: "resume",
        expectedRevision: paused.revision,
        additionalTurns: 2,
      });
      yield* t.advance();
      const resumed = yield* t.read();
      assert.equal(resumed.thread.mission?.phase, "implement");
      assert.equal(resumed.thread.mission?.turnsUsed, 2);
      assert.equal(resumed.thread.mission?.maxTurns, 3);
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["missing-report", "interrupted", "cancelled", "paused", "unrelated-turn"] as const)(
  "does not continue after %s",
  (scenario) =>
    Effect.gen(function* () {
      const t = yield* setup;
      yield* t.start();
      yield* t.advance();
      const initial = yield* t.read();
      const run = initial.runs[0]!;
      if (scenario === "cancelled" || scenario === "paused") {
        yield* t.act("stop", {
          type: scenario === "cancelled" ? "cancel" : "pause",
          expectedRevision: initial.thread.mission!.revision,
        });
        yield* t.status(run, "running");
        assert.equal(
          (yield* Effect.exit(
            t.act("late-report", {
              type: "report",
              expectedRevision: initial.thread.mission!.revision,
              runId: run.id,
              outcome: "stage_complete",
              summary: "Late",
              evidence: [],
            }),
          ))._tag,
          "Failure",
        );
      }
      yield* t.status(run, scenario === "interrupted" ? "interrupted" : "completed");
      if (scenario === "unrelated-turn") {
        const now = yield* DateTime.now;
        yield* t.projections.apply({
          id: EventId.make("unrelated"),
          type: "run.created",
          threadId,
          occurredAt: now,
          payload: {
            ...run,
            id: RunId.make("unrelated"),
            userMessageId: MessageId.make("unrelated"),
            ordinal: 2,
            status: "completed",
          },
        });
      }
      yield* t.advance();
      const end = yield* t.read();
      assert.equal(end.runs.length, scenario === "unrelated-turn" ? 2 : 1);
      assert.equal(
        end.thread.mission?.status,
        scenario === "missing-report"
          ? "blocked"
          : scenario === "cancelled"
            ? "cancelled"
            : "paused",
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "returns verification failures to implementation and leaves blocked work for a person",
  () =>
    Effect.gen(function* () {
      const t = yield* setup;
      yield* t.start();
      yield* t.advance();
      yield* t.report("stage_complete");
      yield* t.advance();
      yield* t.report("stage_complete");
      yield* t.advance();
      yield* t.report("needs_work");
      yield* t.advance();
      assert.equal((yield* t.read()).thread.mission?.phase, "implement");
      yield* t.report("blocked");
      yield* t.advance();
      assert.equal((yield* t.read()).thread.mission?.status, "blocked");
      assert.equal((yield* t.read()).runs.length, 4);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("Stop between stages pauses a mission before it can launch another turn", () =>
  Effect.gen(function* () {
    const t = yield* setup;
    yield* t.start();
    yield* t.orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-between-stages"),
      threadId,
    });
    yield* t.advance();
    const end = yield* t.read();
    assert.equal(end.thread.mission?.status, "paused");
    assert.equal(end.runs.length, 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps missions visible and rechecks automatic settlement under the command lock", () =>
  Effect.gen(function* () {
    const t = yield* setup;
    yield* t.start();
    const mission = (yield* t.read()).thread.mission!;
    const shell = (yield* t.projections.getThreadShell(threadId))!;
    assert.isFalse(
      isAutoSettlementCandidate(
        { ...shell, mission, lastSnoozeWakeAt: null },
        DateTime.toEpochMillis(yield* DateTime.now),
      ),
    );
    const result = yield* Effect.exit(
      t.orchestrator.dispatch({
        type: "thread.auto-settle",
        commandId: CommandId.make("auto-settle"),
        threadId,
        snapshotAt: yield* DateTime.now,
      }),
    );
    assert.equal(result._tag, "Failure");
    assert.equal((yield* t.read()).thread.settledOverride, null);
  }).pipe(Effect.provide(layerTest)),
);
