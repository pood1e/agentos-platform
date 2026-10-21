import { francAll } from "franc-min";
import type { SpeechVoice } from "../../gen/agentos/console/v1/speech_pb.js";

export function selectVoice(text: string, voices: SpeechVoice[]) {
  if (voices.length > 1) {
    const prose = text.replace(/\p{Script_Extensions=Latin}+/gu, " ");
    for (const sample of [prose, text]) {
      if (!/\p{Letter}/u.test(sample)) continue;
      for (const [code] of francAll(sample, { minLength: 1 })) {
        const language = new Intl.Locale(code).language;
        const voice = voices.find((candidate) => candidate.languageCode === language);
        if (voice) return voice;
      }
    }
  }
  return voices[0];
}
