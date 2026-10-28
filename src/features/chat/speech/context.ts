import { createContext, useContext } from "react";
import type { DictationPhase } from "../../../../shared/browser/voice/dictation.js";

export type SpeechControls = {
  phase: DictationPhase;
  language: string;
  languages: string[];
  setLanguage: (language: string) => void;
  cancel: () => void;
};

export const SpeechContext = createContext<SpeechControls | undefined>(undefined);

export function useSpeechControls() {
  return useContext(SpeechContext);
}
