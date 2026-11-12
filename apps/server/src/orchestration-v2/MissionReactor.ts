import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import { CommandId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as DueHint from "../scheduling/DueHint.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const scheduler = yield* Scheduler.Scheduler;
    const due = DueHint.make();
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        event.type.startsWith("thread.") ||
        event.type === "run.updated" ||
        event.type === "subagent.updated" ||
        event.type === "provider-thread.updated" ||
        event.type === "runtime-request.updated" ||
        (event.type === "turn-item.updated" &&
          ["completed", "failed", "cancelled", "interrupted"].includes(event.payload.status))
          ? due.invalidate
          : Effect.void,
      ),
    );
    const sweep = Effect.fn("MissionReactor.sweep")(function* () {
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      if (yield* due.isIdle(now)) return;
      const version = yield* due.version;
      const candidates = yield* projections.getActiveMissionThreads();
      let failed = false;
      for (const thread of candidates) {
        if (!thread.mission) continue;
        yield* threads
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(
              `mission-advance:${thread.id}:${thread.mission.id}:${thread.mission.revision}:${yield* randomUuidV4}`,
            ),
            threadId: thread.id,
            missionAction: { type: "advance", expectedRevision: thread.mission.revision },
          })
          .pipe(
            Effect.catchCause((cause) => {
              failed = true;
              return Effect.logWarning("Mission continuation failed", {
                threadId: thread.id,
                cause,
              });
            }),
          );
      }
      yield* due.record(version, failed ? now + 30_000 : Infinity, now);
    });
    yield* scheduler.register("missions", sweep());
  }),
);
