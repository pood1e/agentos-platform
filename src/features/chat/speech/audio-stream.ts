import type { SynthesizeSpeechResponse } from "../../../../gen/agentos/console/v1/speech_pb.js";

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
) {
  const buffered: Uint8Array<ArrayBuffer>[] = [];
  let contentType = "";
  let source: MediaSource | undefined;
  let buffer: SourceBuffer | undefined;
  let size = 0;
  for await (const { audio } of responses) {
    signal.throwIfAborted();
    if (!audio?.data.length) continue;
    if (!contentType) {
      contentType = audio.contentType;
      if (typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(contentType)) {
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
    if (buffer) {
      const appended = event(buffer, "updateend", signal);
      buffer.appendBuffer(data);
      await appended;
    } else buffered.push(data);
  }
  if (!size) throw new Error("Empty speech response");
  signal.throwIfAborted();
  if (source) source.endOfStream();
  else attach(URL.createObjectURL(new Blob(buffered, { type: contentType })));
}
