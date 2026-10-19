import { createClient, createRouterTransport } from "@connectrpc/connect";
import { expect, it, vi } from "vitest";
import { ConsoleService } from "../gen/agentos/console/v1/console_service_pb.js";
import { accessProfile, workspaceContext } from "../server/platform/access.js";

it("allows console operations without a browser identity and retains workspace context", async () => {
  const send = vi.fn(() => ({}));
  const update = vi.fn(() => ({}));
  const client = createClient(
    ConsoleService,
    createRouterTransport(
      (router) =>
        router.service(ConsoleService, {
          getAccessProfile: (_request, context) => ({ profile: context.values.get(accessProfile) }),
          sendMessage: send,
          updateRole: update,
        }),
      { router: { interceptors: [workspaceContext("workspace")] } },
    ),
  );
  for (const headers of [
    new Headers(),
    new Headers({ authorization: "Bearer expired-identity" }),
  ]) {
    expect((await client.getAccessProfile({}, { headers })).profile).toMatchObject({
      workspace: "workspace",
      subject: "console",
      operate: true,
      manage: true,
    });
  }
  await client.sendMessage({});
  await client.updateRole({});
  expect(send).toHaveBeenCalledOnce();
  expect(update).toHaveBeenCalledOnce();
});
