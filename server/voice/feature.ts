import { fastifyConnectPlugin } from "@connectrpc/connect-fastify";
import { createValidateInterceptor } from "@connectrpc/validate";
import { AuthenticationV1Api, type KubeConfig } from "@kubernetes/client-node";
import Fastify, { type FastifyInstance, LogController } from "fastify";
import { RoomServiceClient } from "livekit-server-sdk";
import { VoiceService } from "../../gen/agentos/voice/v1/voice_pb.js";
import { serviceAccountTokens } from "../authorization/workloads.js";
import { consoleErrors } from "../console/interceptor.js";
import { requiredEnv } from "../shared/config.js";
import { voiceConsole } from "./console.js";
import { voiceTickets } from "./tickets.js";
import { type VoiceWorkerDependencies, voiceService, voiceWorker } from "./worker.js";

// Audience of the worker's projected service account token.
const workerAudience = "agentos-voice";

/**
 * Voice is configured per deployment; without its agent name the API has no voice routes.
 * The worker API listens privately, apart from the public API port.
 */
export async function voiceFeature(
  app: FastifyInstance,
  options: Omit<VoiceWorkerDependencies, "tickets" | "gatewayURL"> & {
    kube: KubeConfig;
  },
) {
  const agent = process.env.AGENTOS_VOICE_AGENT;
  if (!agent) return undefined;
  const { kube, ...dependencies } = options;
  const tickets = voiceTickets(requiredEnv("AGENTOS_VOICE_SESSION_KEY"), options.agent.namespace);
  const apiKey = requiredEnv("LIVEKIT_API_KEY");
  const apiSecret = requiredEnv("LIVEKIT_API_SECRET");
  const rooms = new RoomServiceClient(requiredEnv("LIVEKIT_URL"), apiKey, apiSecret);
  const review = serviceAccountTokens(kube.makeApiClient(AuthenticationV1Api));
  const server = Fastify({
    loggerInstance: app.log,
    logController: new LogController({ disableRequestLogging: true }),
  });
  await server.register(fastifyConnectPlugin, {
    interceptors: [
      consoleErrors(app.log),
      voiceWorker(review, workerAudience, requiredEnv("AGENTOS_VOICE_SUBJECT")),
      createValidateInterceptor(),
    ],
    routes: (router) =>
      router.service(
        VoiceService,
        voiceService({
          ...dependencies,
          tickets,
          gatewayURL: requiredEnv("AGENTOS_VOICE_GATEWAY_URL"),
        }),
      ),
  });
  app.addHook("preClose", async () => {
    await server.close();
  });
  return {
    console: voiceConsole(
      dependencies.settings,
      tickets,
      {
        url: requiredEnv("AGENTOS_LIVEKIT_URL"),
        apiKey,
        apiSecret,
        agent,
        createRoom: rooms.createRoom.bind(rooms),
      },
      dependencies.clients,
      dependencies.agent,
    ),
    listen: (host: string) =>
      server.listen({ host, port: Number(process.env.AGENTOS_VOICE_PORT ?? "9093") }),
  };
}
