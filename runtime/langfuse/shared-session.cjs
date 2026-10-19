"use strict";

module.exports = async function sharedSession({ options }) {
  const email = process.env.LANGFUSE_INIT_USER_EMAIL;
  if (!email) throw new Error("LANGFUSE_INIT_USER_EMAIL is required");

  const now = Date.now();
  const token = { email: email.toLowerCase(), loginAt: now };
  const session = await options.callbacks.session({
    session: {
      user: { email: token.email },
      expires: new Date(now + options.session.maxAge * 1000).toISOString(),
    },
    token,
  });
  if (!session?.user) throw new Error("The initialized Langfuse user is unavailable");

  await options.events.session?.({ session, token });
  return {
    body: session,
    headers: [
      { key: "Content-Type", value: "application/json" },
      { key: "Cache-Control", value: "private, no-cache, no-store" },
      { key: "Pragma", value: "no-cache" },
      { key: "Expires", value: "0" },
    ],
    cookies: [],
  };
};
