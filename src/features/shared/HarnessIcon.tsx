import { Blocks } from "lucide-react";
import { type Brand, BrandIcon } from "./BrandIcon.js";

const runtimes: Record<string, Brand> = {
  kagent: { name: "kagent", icon: "/icons/kagent.svg" },
  codex: { name: "Codex", icon: "/icons/openai.svg" },
  claude: { name: "Claude Code", icon: "/icons/claude.png" },
  byo: { name: "BYO", icon: Blocks },
};

const runtimeBrand = (runtime: string) =>
  runtimes[runtime] ?? { name: runtime || "BYO", icon: Blocks };

export const runtimeName = (runtime: string) => runtimeBrand(runtime).name;

export function HarnessIcon({ runtime, className }: { runtime: string; className?: string }) {
  return (
    <BrandIcon
      brand={runtimeBrand(runtime)}
      className={className}
      data-testid="harness-icon"
      data-harness-runtime={runtime}
      aria-hidden="true"
    />
  );
}
