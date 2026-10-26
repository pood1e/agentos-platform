import type { ServerResponse } from "node:http";
import { object, text } from "../../server/read-model/decode/messages.js";
import type { FakeResources } from "./resources.js";

export function nativeWatch(resources: FakeResources, plural: string, response: ServerResponse) {
  const previous = new Map<string, string>();
  response.flushHeaders();
  const publish = () => {
    const current = new Map(
      resources
        .list(plural)
        .map((item) => [text(object(item.metadata).name), JSON.stringify(item)]),
    );
    for (const [name, value] of current)
      if (previous.get(name) !== value)
        response.write(
          `${JSON.stringify({ type: previous.has(name) ? "MODIFIED" : "ADDED", object: JSON.parse(value) })}\n`,
        );
    for (const [name, value] of previous)
      if (!current.has(name))
        response.write(`${JSON.stringify({ type: "DELETED", object: JSON.parse(value) })}\n`);
    previous.clear();
    for (const [name, value] of current) previous.set(name, value);
  };
  publish();
  const timer = setInterval(publish, 50);
  response.on("close", () => clearInterval(timer));
}
