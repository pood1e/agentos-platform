import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import enAutomation from "./locales/automation.en.json";
import zhAutomation from "./locales/automation.zh-CN.json";
import en from "./locales/en.json";
import enEvaluation from "./locales/evaluation.en.json";
import zhEvaluation from "./locales/evaluation.zh-CN.json";
import enManagement from "./locales/management.en.json";
import zhManagement from "./locales/management.zh-CN.json";
import enTools from "./locales/tools.en.json";
import zhTools from "./locales/tools.zh-CN.json";
import zh from "./locales/zh-CN.json";

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      zh: {
        translation: {
          ...zh,
          management: zhManagement,
          evaluation: zhEvaluation,
          automation: zhAutomation,
        },
        tools: zhTools,
      },
      en: {
        translation: {
          ...en,
          management: enManagement,
          evaluation: enEvaluation,
          automation: enAutomation,
        },
        tools: enTools,
      },
    },
    supportedLngs: ["zh", "en"],
    fallbackLng: "zh",
    load: "languageOnly",
    interpolation: { escapeValue: false },
    react: { bindI18nStore: "added" },
    detection: {
      order: ["localStorage", "navigator"],
      lookupLocalStorage: "agentos-language",
      caches: ["localStorage"],
    },
  });
if (typeof document !== "undefined") {
  document.documentElement.lang = i18n.resolvedLanguage === "en" ? "en" : "zh-CN";
  i18n.on("languageChanged", (language) => {
    document.documentElement.lang = language.startsWith("en") ? "en" : "zh-CN";
  });
}
export const tr = i18n.t.bind(i18n);
export default i18n;
