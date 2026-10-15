export interface KagentConfig {
  url: string;
  namespace: string;
  userId: string;
  token?: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function kagentConfig(env = process.env): KagentConfig {
  return {
    url: required(env, "KAGENT_URL"),
    namespace: env.KAGENT_NAMESPACE ?? "agentos",
    userId: env.KAGENT_USER_ID ?? "agentos",
    token: env.KAGENT_TOKEN || undefined,
  };
}

export function listenConfig(env = process.env, port = 8080) {
  return { host: env.AGENTOS_HOST ?? "127.0.0.1", port: Number(env.AGENTOS_PORT ?? port) };
}

export function roleDefaults(env = process.env) {
  return {
    modelConfig: env.AGENTOS_MODEL_CONFIG ?? "default-model-config",
    harness: env.AGENTOS_HARNESS ?? "standard",
  };
}
