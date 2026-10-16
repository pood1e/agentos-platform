import { type DescMessage, type JsonValue, type Message, toJson } from "@bufbuild/protobuf";
import { createValidator } from "@bufbuild/protovalidate";
import { fromJsonSchema } from "@modelcontextprotocol/server";
import { object } from "../read-model/decode/messages.js";

interface SchemaBundle {
  $ref: string;
  $defs: Record<string, object>;
}

export const inputSchema = (bundle: SchemaBundle) =>
  fromJsonSchema<JsonValue>({
    ...bundle.$defs[bundle.$ref.slice("#/$defs/".length)],
    $defs: bundle.$defs,
  });

export function result(schema: DescMessage, message: Message) {
  const output = toJson(schema, message);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(output) }],
    structuredContent: object(output),
  };
}

export const validator = createValidator();
