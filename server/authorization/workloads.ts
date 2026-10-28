import { Code, ConnectError } from "@connectrpc/connect";
import { type AuthenticationV1Api, createConfiguration } from "@kubernetes/client-node";

/** TokenReview of a projected service account token issued for one audience. */
export function serviceAccountTokens(api: Pick<AuthenticationV1Api, "createTokenReview">) {
  const { middleware } = createConfiguration({
    promiseMiddleware: [
      {
        async pre(request) {
          request.setSignal(AbortSignal.timeout(5_000));
          return request;
        },
        post: async (response) => response,
      },
    ],
  });
  return async (token: string, audience: string, subjects: string[]) => {
    const { status } = await api.createTokenReview(
      {
        body: {
          apiVersion: "authentication.k8s.io/v1",
          kind: "TokenReview",
          spec: { token, audiences: [audience] },
        },
      },
      { middleware, middlewareMergeStrategy: "append" },
    );
    if (
      !status?.authenticated ||
      !status.audiences?.includes(audience) ||
      !subjects.includes(status.user?.username ?? "")
    )
      throw new ConnectError("Workload identity is invalid", Code.Unauthenticated);
  };
}
