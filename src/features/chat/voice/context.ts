import { createContext, useContext } from "react";

export const VoiceCallContext = createContext(false);
export const useVoiceCallActive = () => useContext(VoiceCallContext);
