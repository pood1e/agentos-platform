import { afterEach, expect, it, vi } from "vitest";
import { PcmPlayback } from "../shared/browser/speech/pcm-playback.js";

function playback() {
  const samples: Float32Array[] = [];
  const sources: {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    onended: (() => void) | null;
  }[] = [];
  const context = {
    currentTime: 1,
    destination: {},
    resume: vi.fn(async () => {}),
    createBuffer: (_channels: number, size: number, rate: number) => {
      const data = new Float32Array(size);
      samples.push(data);
      return { duration: size / rate, getChannelData: () => data };
    },
    createBufferSource: () => {
      const source = {
        buffer: null,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        onended: null,
      };
      sources.push(source);
      return source;
    },
  };
  const controller = new AbortController();
  const playing = vi.fn();
  const player = new PcmPlayback(
    context as unknown as AudioContext,
    22050,
    controller.signal,
    playing,
  );
  return { player, context, controller, sources, samples, playing };
}

afterEach(() => vi.restoreAllMocks());

it("preserves the first and last PCM samples across odd network boundaries and plays before EOF", async () => {
  const { player, sources, samples, playing } = playback();
  await player.append(new Uint8Array([0x34]));
  expect(sources).toHaveLength(0);
  await player.append(new Uint8Array([0x12, 0, 0x80, 0xff]));
  expect(playing).toHaveBeenCalledOnce();
  expect(samples[0]).toEqual(new Float32Array([0x1234 / 32768, -1]));
  await player.append(new Uint8Array([0x7f]));
  expect(samples[1]).toEqual(new Float32Array([32767 / 32768]));
  expect(sources[0]?.start).toHaveBeenCalledWith(1.16);
  expect(sources[1]?.start).toHaveBeenCalledWith(1.16 + 2 / 22050);
  const drained = vi.fn();
  const done = player.finish().then(drained);
  sources[0]?.onended?.();
  await Promise.resolve();
  expect(drained).not.toHaveBeenCalled();
  sources[1]?.onended?.();
  await done;
  expect(drained).toHaveBeenCalledOnce();
});

it("stops queued audio immediately on cancellation and rejects late audio", async () => {
  const { player, controller, sources } = playback();
  await player.append(new Uint8Array([0, 1]));
  const done = player.finish();
  controller.abort(new DOMException("Canceled", "AbortError"));
  await expect(done).rejects.toMatchObject({ name: "AbortError" });
  expect(sources[0]?.stop).toHaveBeenCalledOnce();
  await expect(player.append(new Uint8Array([0, 2]))).rejects.toMatchObject({ name: "AbortError" });
});

it("rejects an incomplete final sample instead of dropping a byte", async () => {
  const { player, controller } = playback();
  await player.append(new Uint8Array([1, 2, 3]));
  await expect(player.finish()).rejects.toThrow("Incomplete PCM audio");
  controller.abort();
});
