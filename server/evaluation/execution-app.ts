import { createHash, timingSafeEqual } from "node:crypto";
import { toJson } from "@bufbuild/protobuf";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import { fastifyConnectPlugin } from "@connectrpc/connect-fastify";
import { createValidateInterceptor } from "@connectrpc/validate";
import type { FastifyInstance } from "fastify";
import { EvaluationExecutionService } from "../../gen/agentos/evaluation/v1/evaluation_pb.js";
import { object } from "../read-model/decode/messages.js";

export async function registerEvaluationExecution(
  app: FastifyInstance,
  service: ServiceImpl<typeof EvaluationExecutionService>,
  token: string,
) {
  const hash = (value: string) => createHash("sha256").update(value).digest();
  const expected = hash(`Bearer ${token}`);
  await app.register(fastifyConnectPlugin, {
    interceptors: [
      (next) => async (request) => {
        if (!timingSafeEqual(hash(request.header.get("authorization") ?? ""), expected))
          throw new ConnectError("Machine authentication required", Code.Unauthenticated);
        if (
          request.stream ||
          !request.header.get("x-agentos-candidate") ||
          object(toJson(request.method.input, request.message)).candidateId !==
            request.header.get("x-agentos-candidate")
        )
          throw new ConnectError("Machine candidate scope differs", Code.PermissionDenied);
        return next(request);
      },
      createValidateInterceptor(),
    ],
    routes: (router) => router.service(EvaluationExecutionService, service),
  });
}
