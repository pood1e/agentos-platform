"use strict";

const assert = require("node:assert/strict");
const { afterEach, test } = require("node:test");
const sharedSession = require("./shared-session.cjs");

const previousEmail = process.env.LANGFUSE_INIT_USER_EMAIL;
afterEach(() => {
  if (previousEmail === undefined) delete process.env.LANGFUSE_INIT_USER_EMAIL;
  else process.env.LANGFUSE_INIT_USER_EMAIL = previousEmail;
});

test("anonymous requests use the persisted user's native permissions without cookies", async () => {
  process.env.LANGFUSE_INIT_USER_EMAIL = "Operator@Example.com";
  const profile = { id: "operator", organizations: [{ id: "workspace", role: "OWNER" }] };
  let event;
  const response = await sharedSession({
    sessionStore: { value: "expired-cookie" },
    newSession: { user: { email: "untrusted@example.com", admin: true } },
    options: {
      session: { maxAge: 3600 },
      callbacks: {
        session: async ({ session, token }) => {
          assert.equal(token.email, "operator@example.com");
          assert.ok(Math.abs(token.loginAt - Date.now()) < 1000);
          assert.equal(session.user.email, token.email);
          return { ...session, user: profile };
        },
      },
      events: {
        session: async (value) => {
          event = value;
        },
      },
    },
  });
  assert.equal(response.body.user, profile);
  assert.equal(event.session, response.body);
  assert.deepEqual(response.cookies, []);
  assert.ok(
    response.headers.some(
      ({ key, value }) => key === "Cache-Control" && value.includes("no-store"),
    ),
  );
});

test("missing deployment identity fails instead of accepting request identity", async () => {
  delete process.env.LANGFUSE_INIT_USER_EMAIL;
  await assert.rejects(sharedSession({ options: {} }), /LANGFUSE_INIT_USER_EMAIL/);
});

test("a deleted initialized user fails instead of manufacturing permissions", async () => {
  process.env.LANGFUSE_INIT_USER_EMAIL = "operator@example.com";
  await assert.rejects(
    sharedSession({
      options: {
        session: { maxAge: 3600 },
        callbacks: { session: async () => ({ user: null }) },
        events: {},
      },
    }),
    /initialized Langfuse user/,
  );
});
