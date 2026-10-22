import { francAll } from "franc-min";

export function speechLanguage(text: string, languages: readonly string[]) {
  const prose = text.replace(/\p{Script_Extensions=Latin}+/gu, " ");
  for (const sample of [prose, text]) {
    if (!/\p{Letter}/u.test(sample)) continue;
    for (const [code] of francAll(sample, { minLength: 1 })) {
      const language = new Intl.Locale(code).language;
      if (languages.includes(language)) return language;
    }
  }
  return languages[0] ?? "";
}
