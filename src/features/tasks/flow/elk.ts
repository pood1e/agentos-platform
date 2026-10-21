import elkWorkerUrl from "elkjs/lib/elk-worker.min.js?url";

export const elk = import.meta.env.SSR
  ? import("elkjs/lib/elk.bundled.js").then(
      ({ default: ELK }) => new ELK({ algorithms: ["layered"] }),
    )
  : import("elkjs/lib/elk-api.js").then(
      ({ default: ELK }) => new ELK({ algorithms: ["layered"], workerUrl: elkWorkerUrl }),
    );
