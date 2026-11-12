import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { ThreadMission } from "./ThreadMission";

const { update } = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock(import("../../state/use-orchestration-command"), () => ({
  useOrchestrationCommand: () => update,
}));
vi.mock(import("../../state/threads"), () => ({
  threadEnvironment: { updateMetadata: {} } as never,
}));

it("requires an outcome and criteria, then sends one mission to the selected environment", async () => {
  update.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  const environmentId = EnvironmentId.make("remote");
  const threadId = ThreadId.make("mission");
  await using screen = await render(
    <ThreadMission
      environmentId={environmentId}
      threadId={threadId}
      mission={undefined}
      canOperate
      isWorking={false}
    />,
  );
  await screen.getByRole("button", { name: "Run a mission" }).click();
  const start = screen.getByRole("button", { name: "Start mission", exact: true });
  await expect.element(start).toBeDisabled();
  await screen.getByLabelText("Outcome", { exact: true }).fill(" Export filtered records ");
  await screen
    .getByLabelText("Acceptance criteria, one per line")
    .fill("Active filters apply\n\nTests pass");
  await screen.getByLabelText("Maximum turns").fill("4");
  await start.click();
  expect(update).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: {
      threadId,
      missionAction: {
        type: "start",
        expectedRevision: 0,
        objective: "Export filtered records",
        criteria: ["Active filters apply", "Tests pass"],
        maxTurns: 4,
      },
    },
  });
  await expect.element(screen.getByRole("button", { name: "Run a mission" })).toBeVisible();
});

it("does not allow a read-only connection to start a mission", async () => {
  await using screen = await render(
    <ThreadMission
      environmentId={EnvironmentId.make("readonly")}
      threadId={ThreadId.make("mission")}
      mission={undefined}
      canOperate={false}
      isWorking={false}
    />,
  );
  await expect.element(screen.getByRole("button", { name: "Run a mission" })).toBeDisabled();
});
