import type { SpeechVoice } from "../../gen/agentos/console/v1/speech_pb.js";
import { speechLanguage } from "../../shared/speech-language.js";

export function selectVoice(text: string, voices: SpeechVoice[]) {
  const language = speechLanguage(
    text,
    voices.map((voice) => voice.languageCode),
  );
  return voices.find((voice) => voice.languageCode === language);
}
