import { type Timestamp, timestampMs } from "@bufbuild/protobuf/wkt";
import i18n from "../../i18n/index.js";

export function scheduledTime(value?: Timestamp, timeZone?: string) {
  return value
    ? new Date(timestampMs(value)).toLocaleString(
        i18n.resolvedLanguage === "en" ? "en-US" : "zh-CN",
        { hour12: false, timeZone },
      )
    : "—";
}
