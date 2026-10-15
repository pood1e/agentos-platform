import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const base = process.env.OLLAMA_URL;
const model = process.env.OLLAMA_MODEL;
const digest = process.env.OLLAMA_MODEL_DIGEST;
const deadline = Date.now() + 600_000;
let tags;
while (Date.now() < deadline) {
  try {
    const response = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5_000) });
    if (response.ok) {
      tags = await response.json();
      break;
    }
  } catch {}
  await delay(1_500);
}
assert.ok(tags, "Embedding service did not become ready");
if (!tags.models.some((entry) => entry.name === model)) {
  const response = await fetch(`${base}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: false }),
    signal: AbortSignal.timeout(600_000),
  });
  assert.ok(response.ok, "Embedding model could not be pulled");
  await response.json();
}
const verified = await fetch(`${base}/api/tags`).then((response) => response.json());
assert.equal(
  verified.models.find((entry) => entry.name === model)?.digest,
  digest,
  "Embedding model digest differs from the deployment pin",
);
const response = await fetch(`${base}/api/embed`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model,
    input: ["知识检索", "Knowledge retrieval"],
    dimensions: 768,
    truncate: false,
  }),
  signal: AbortSignal.timeout(120_000),
});
assert.ok(response.ok, "Embedding request failed");
const { embeddings } = await response.json();
assert.equal(embeddings.length, 2);
assert.ok(embeddings.every((entry) => entry.length === 768));
console.log("Embedding model verified: pinned digest, Chinese and English, 768 dimensions.");
