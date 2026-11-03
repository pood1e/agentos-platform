export function requiredEnv(name: string, env = process.env): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function listenConfig(env = process.env) {
  return { host: env.AGENTOS_HOST ?? "127.0.0.1", port: Number(env.AGENTOS_PORT ?? 8080) };
}
