import { useQuery } from "@connectrpc/connect-query";
import { ConsoleService } from "../../gen/agentos/console/v1/console_service_pb.js";

/** Voice entry points appear only where the deployment includes voice. */
export const useSpeechCapabilities = () =>
  useQuery(ConsoleService.method.getSpeechCapabilities, {}, { staleTime: 60_000 });
