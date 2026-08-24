import "server-only";

import { Resend } from "resend";

const resend = new Resend(
  process.env.RESEND_API_KEY
);

export async function sendExecutionEmail(
  runId: string,
  payload: unknown
) {
  const to =
    process.env.PROXY_EXECUTION_EMAIL;

  if (!to) {
    throw new Error(
      "Missing PROXY_EXECUTION_EMAIL"
    );
  }

  const { data, error } =
    await resend.emails.send({
      from:
        "Proxy <onboarding@resend.dev>",

      to,

      subject:
        `PROXY_MAILROOM_EXECUTE::${runId}`,

      text:
        JSON.stringify(
          payload,
          null,
          2
        ),
    });

  if (error) {
    throw new Error(
      `Could not send execution email: ${error.message}`
    );
  }

  return data;
}