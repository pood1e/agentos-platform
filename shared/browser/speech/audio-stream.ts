import type { SynthesizeSpeechResponse } from "../../../gen/agentos/console/v1/speech_pb.js";
import type { PcmPlayback } from "./pcm-playback.js";

function event(target: EventTarget, type: string, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      target.removeEventListener(type, ready);
      target.removeEventListener("error", failed);
      signal.removeEventListener("abort", aborted);
    };
    const ready = () => {
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(new Error("Audio stream failed"));
    };
    const aborted = () => {
      cleanup();
      reject(signal.reason);
    };
    target.addEventListener(type, ready, { once: true });
    target.addEventListener("error", failed, { once: true });
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

export async function streamAudio(
  responses: AsyncIterable<SynthesizeSpeechResponse>,
  signal: AbortSignal,
  attach: (url: string) => void,
  pcm?: (rate: number) => PcmPlayback,
) {
  const buffered: Uint8Array<ArrayBuffer>[] = [];
  let contentType = "";
  let source: MediaSource | undefined;
  let buffer: SourceBuffer | undefined;
  let size = 0;
  let playback: PcmPlayback | undefined;
  for await (const { audio } of responses) {
    signal.throwIfAborted();
    if (!audio?.data.length) continue;
    if (!contentType) {
      contentType = audio.contentType;
      if (contentType.startsWith("audio/pcm")) {
        const rate = Number(/(?:^|;)\s*rate=(\d+)(?:;|$)/u.exec(contentType)?.[1]);
        if (!pcm || !Number.isInteger(rate) || rate < 8000 || rate > 96000)
          throw new Error("Unsupported PCM format");
        playback = pcm(rate);
      } else if (typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(contentType)) {
        source = new MediaSource();
        const opened = event(source, "sourceopen", signal);
        attach(URL.createObjectURL(source));
        await opened;
        buffer = source.addSourceBuffer(contentType);
      }
    }
    if (audio.contentType !== contentType) throw new Error("Audio format changed");
    size += audio.data.length;
    if (size > 16 * 1024 * 1024) throw new Error("Audio limit exceeded");
    const data = new Uint8Array(audio.data);
    if (playback) await playback.append(data);
    else if (buffer) {
      const appended = event(buffer, "updateend", signal);
      buffer.appendBuffer(data);
      await appended;
    } else buffered.push(data);
  }
  if (!size) throw new Error("Empty speech response");
  signal.throwIfAborted();
  if (playback) await playback.finish();
  else if (source) source.endOfStream();
  else attach(URL.createObjectURL(new Blob(buffered, { type: contentType })));
}
