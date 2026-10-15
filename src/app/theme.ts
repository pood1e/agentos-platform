import type { ThemeProviderProps } from "next-themes";

export const themeOptions = {
  attribute: "class",
  defaultTheme: "system",
  storageKey: "agentos-theme",
  enableSystem: true,
  disableTransitionOnChange: true,
} satisfies ThemeProviderProps;
