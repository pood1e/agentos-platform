type Snapshot = {
  type?: string;
  status?: string;
  lines?: { text?: string; speaker?: number }[];
  buffer_transcription?: string;
  buffer_diarization?: string;
};

export function whisperLiveKitResult(data: string) {
  const snapshot = JSON.parse(data) as Snapshot;
  if (snapshot.type === "error" || snapshot.status === "error")
    throw new Error("Transcription unavailable");
  if (snapshot.type === "ready_to_stop") return "done";
  if (!Array.isArray(snapshot.lines)) return undefined;
  const transcript =
    snapshot.lines
      .filter((line) => line.speaker !== -2 && typeof line.text === "string")
      .map((line) => line.text)
      .join("") +
    (snapshot.buffer_diarization ?? "") +
    (snapshot.buffer_transcription ?? "");
  return JSON.stringify({
    type: "Results",
    channel_index: [0, 1],
    is_final: false,
    speech_final: false,
    channel: { alternatives: [{ transcript, confidence: 1, words: [] }] },
  });
}
