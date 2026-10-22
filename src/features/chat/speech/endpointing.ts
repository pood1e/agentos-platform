import type { MicVAD } from "@ricky0123/vad-web";

export async function detectSpeechEnd(stream: MediaStream, signal: AbortSignal, onEnd: () => void) {
  const { MicVAD } = await import("@ricky0123/vad-web");
  signal.throwIfAborted();
  let silence: ReturnType<typeof setTimeout> | undefined;
  let detector: MicVAD | undefined;
  const stop = () => {
    clearTimeout(silence);
    void detector?.destroy().catch(() => {});
  };
  const idle = () => {
    clearTimeout(silence);
    silence = setTimeout(onEnd, 12_000);
  };
  try {
    const prepared = await MicVAD.new({
      model: "v6",
      baseAssetPath: "/speech-vad/",
      onnxWASMBasePath: "/speech-vad/",
      startOnLoad: false,
      getStream: async () => stream,
      pauseStream: async () => {},
      resumeStream: async () => stream,
      redemptionMs: 1400,
      minSpeechMs: 160,
      submitUserSpeechOnPause: false,
      onSpeechRealStart: () => clearTimeout(silence),
      onVADMisfire: idle,
      onSpeechEnd: onEnd,
      ortConfig: (ort) => {
        ort.env.wasm.numThreads = 1;
      },
    });
    detector = prepared;
    signal.throwIfAborted();
    signal.addEventListener("abort", stop, { once: true });
    return {
      start: async () => {
        signal.throwIfAborted();
        await prepared.start();
        signal.throwIfAborted();
        idle();
      },
      stop: () => {
        signal.removeEventListener("abort", stop);
        stop();
      },
    };
  } catch (error) {
    signal.removeEventListener("abort", stop);
    stop();
    throw error;
  }
}
