/** PCM16LE playback on the browser's audio clock, including partial network samples. */
export class PcmPlayback {
  private sources = new Set<AudioBufferSourceNode>();
  private trailing?: number;
  private next = 0;
  private samples = 0;
  private ended = () => {};

  constructor(
    private context: AudioContext,
    private rate: number,
    private signal: AbortSignal,
    private onPlaying: () => void,
  ) {
    signal.addEventListener("abort", this.cancel, { once: true });
  }

  async append(data: Uint8Array) {
    this.signal.throwIfAborted();
    await this.context.resume();
    this.signal.throwIfAborted();
    const bytes = new Uint8Array(data.length + (this.trailing === undefined ? 0 : 1));
    if (this.trailing !== undefined) bytes[0] = this.trailing;
    bytes.set(data, this.trailing === undefined ? 0 : 1);
    const length = Math.floor(bytes.length / 2);
    this.trailing = bytes.length % 2 ? bytes.at(-1) : undefined;
    if (!length) return;
    const buffer = this.context.createBuffer(1, length, this.rate);
    const samples = buffer.getChannelData(0);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < length; index++)
      samples[index] = view.getInt16(index * 2, true) / 32768;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    source.onended = () => {
      source.disconnect();
      this.sources.delete(source);
      if (!this.sources.size) this.ended();
    };
    this.sources.add(source);
    // Open the output device before the first sample, then keep adjacent chunks contiguous.
    this.next = Math.max(this.next, this.context.currentTime + (this.samples ? 0.02 : 0.16));
    source.start(this.next);
    this.next += buffer.duration;
    if (!this.samples) this.onPlaying();
    this.samples += length;
  }

  async finish() {
    this.signal.throwIfAborted();
    if (this.trailing !== undefined || !this.samples) throw new Error("Incomplete PCM audio");
    let aborted = () => {};
    try {
      if (this.sources.size)
        await new Promise<void>((resolve, reject) => {
          this.ended = resolve;
          aborted = () => reject(this.signal.reason);
          this.signal.addEventListener("abort", aborted, { once: true });
        });
    } finally {
      this.signal.removeEventListener("abort", this.cancel);
      this.signal.removeEventListener("abort", aborted);
    }
  }

  cancel = () => {
    for (const source of this.sources) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    this.sources.clear();
  };
}
