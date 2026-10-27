import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import { MessageSchema, SendMessageResponseSchema, TaskSchema } from "../gen/a2a_pb.js";
import { ErrorInfoSchema } from "../gen/google/rpc/error_details_pb.js";
import { acceptMessage } from "../server/kagent/send.js";

function rejection(domain = "a2a-protocol.org") {
  return new ConnectError("not accepted", Code.FailedPrecondition, undefined, [
    {
      desc: ErrorInfoSchema,
      value: create(ErrorInfoSchema, {
        reason: "UNSUPPORTED_OPERATION",
        domain,
        metadata: { reason: "KAGENT_SEND_NOT_ACCEPTED" },
      }),
    },
  ]);
}

const message = create(MessageSchema, { messageId: "message", contextId: "session" });
const accepted = create(SendMessageResponseSchema, {
  payload: { case: "task", value: create(TaskSchema, { id: "task", contextId: "session" }) },
});

describe("native message admission", () => {
  it("reuses the original input when native admission proves rejection", async () => {
    const sendMessage = vi.fn().mockRejectedValueOnce(rejection()).mockResolvedValueOnce(accepted);
    const task = await acceptMessage({ sendMessage }, "team/assistant", message);
    expect(task.history.map((item) => item.messageId)).toEqual(["message"]);
    expect(sendMessage.mock.calls.map(([input]) => input.message)).toEqual([message, message]);
    expect(sendMessage.mock.calls[0]?.[0].configuration.returnImmediately).toBe(true);
  });

  it.each([rejection("another.domain"), new ConnectError("lost", Code.Unavailable)])(
    "preserves errors without native rejection proof",
    async (error) => {
      const sendMessage = vi.fn().mockRejectedValue(error);
      await expect(acceptMessage({ sendMessage }, "team/assistant", message)).rejects.toBe(error);
      expect(sendMessage).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects a response for another conversation", async () => {
    const sendMessage = vi.fn().mockResolvedValue(
      create(SendMessageResponseSchema, {
        payload: { case: "task", value: create(TaskSchema, { id: "task", contextId: "other" }) },
      }),
    );
    await expect(acceptMessage({ sendMessage }, "team/assistant", message)).rejects.toThrow(
      "traceable",
    );
  });

  it("stops retrying when its caller aborts", async () => {
    const controller = new AbortController();
    const sendMessage = vi.fn(async () => {
      controller.abort();
      throw rejection();
    });
    await expect(
      acceptMessage({ sendMessage }, "team/assistant", message, {}, controller.signal),
    ).rejects.toHaveProperty("code", Code.FailedPrecondition);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
