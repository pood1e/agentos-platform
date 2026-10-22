import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import { StreamResponseSchema } from "../gen/a2a_pb.js";
import { ErrorInfoSchema } from "../gen/google/rpc/error_details_pb.js";
import { sendMessageStream } from "../server/kagent/send.js";

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

const request = { tenant: "team/assistant", message: { messageId: "message" } };

async function* failedStream(error: unknown) {
  yield await Promise.reject<never>(error);
}

async function collect<T>(stream: AsyncIterable<T>) {
  const events: T[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("native message admission", () => {
  it("reuses the original input when native admission proves rejection", async () => {
    const event = create(StreamResponseSchema);
    const sendStreamingMessage = vi
      .fn()
      .mockImplementationOnce(() => failedStream(rejection()))
      .mockImplementationOnce(async function* () {
        yield event;
      });
    const events = await collect(sendMessageStream({ sendStreamingMessage }, request, {}));
    expect(events).toEqual([event]);
    expect(sendStreamingMessage.mock.calls.map(([input]) => input)).toEqual([request, request]);
  });

  it.each([rejection("another.domain"), new ConnectError("lost", Code.Unavailable)])(
    "preserves errors without native rejection proof",
    async (error) => {
      const sendStreamingMessage = vi.fn(() => failedStream(error));
      await expect(collect(sendMessageStream({ sendStreamingMessage }, request, {}))).rejects.toBe(
        error,
      );
      expect(sendStreamingMessage).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps partial execution from being replayed", async () => {
    const error = rejection();
    const sendStreamingMessage = vi.fn(async function* () {
      yield create(StreamResponseSchema);
      throw error;
    });
    await expect(collect(sendMessageStream({ sendStreamingMessage }, request, {}))).rejects.toBe(
      error,
    );
    expect(sendStreamingMessage).toHaveBeenCalledTimes(1);
  });

  it("stops retrying when its caller aborts", async () => {
    const controller = new AbortController();
    const sendStreamingMessage = vi.fn(() => {
      controller.abort();
      return failedStream(rejection());
    });
    await expect(
      collect(sendMessageStream({ sendStreamingMessage }, request, { signal: controller.signal })),
    ).rejects.toHaveProperty("code", Code.FailedPrecondition);
    expect(sendStreamingMessage).toHaveBeenCalledTimes(1);
  });
});
