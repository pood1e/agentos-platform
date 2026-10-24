import {
  type McpUiHostContext,
  McpUiHostContextSchema,
} from "@modelcontextprotocol/ext-apps/app-bridge";

export function hostContext(
  theme: string | undefined,
  locale: string,
  fullscreen: boolean,
): McpUiHostContext {
  const style = getComputedStyle(document.documentElement);
  const css = (name: string) => style.getPropertyValue(name).trim();
  return McpUiHostContextSchema.parse({
    theme: theme === "dark" ? "dark" : "light",
    locale,
    displayMode: fullscreen ? "fullscreen" : "inline",
    availableDisplayModes: ["inline", "fullscreen"],
    styles: {
      variables: {
        "--color-background-primary": css("--background"),
        "--color-background-secondary": css("--muted"),
        "--color-text-primary": css("--foreground"),
        "--color-text-secondary": css("--muted-foreground"),
        "--color-border-primary": css("--border"),
        "--color-ring-primary": css("--ring"),
        "--color-background-info": css("--primary"),
        "--border-radius-md": css("--radius"),
        "--font-sans": css("--font-sans") || "system-ui, sans-serif",
      },
    },
  });
}
