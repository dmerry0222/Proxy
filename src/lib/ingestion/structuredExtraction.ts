import "server-only";

import Anthropic from "@anthropic-ai/sdk";

/**
 * Priority 4: schema-constrained model output for artifact extraction,
 * replacing "return JSON only" prompting + regex-fence-extraction +
 * JSON.parse(). All 8 production failures were exactly that bare JSON.parse
 * throwing on truncated/malformed model output.
 *
 * Forcing a single tool call (tool_choice: {type:"tool", name}) makes
 * Anthropic emit an already-parsed object conforming to input_schema --
 * there is no JSON text to mis-parse. `validate` is a second, independent
 * check: tool-use guarantees structural (JSON) validity, not semantic
 * validity (e.g. a confidence outside 0-1), so the input still needs
 * validating before any downstream insert runs. No new schema-validation
 * dependency (zod, etc.) -- a hand-written validator per caller is a few
 * lines and this is the only place in the codebase that needs one.
 *
 * The one bounded retry is defense in depth for the residual cases
 * tool-use doesn't fully close out (a max_tokens cutoff mid-argument, or a
 * value that's syntactically fine but fails validation) -- not the primary
 * defense, which is the schema constraint itself.
 */
export async function callStructuredExtraction<T>(params: {
  model: string;
  maxTokens: number;
  system: string;
  userContent: string;
  toolName: string;
  toolDescription: string;
  inputSchema: Record<string, unknown>;
  validate: (input: unknown) => { ok: true; data: T } | { ok: false; error: string };
}): Promise<T> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const tools: Anthropic.Tool[] = [
    { name: params.toolName, description: params.toolDescription, input_schema: params.inputSchema as Anthropic.Tool["input_schema"] },
  ];

  const attempts = 2;
  let lastError = "Unknown structured extraction error";

  for (let attempt = 0; attempt < attempts; attempt++) {
    const response = await anthropic.messages.create({
      model: params.model,
      max_tokens: params.maxTokens,
      system: params.system,
      tools,
      tool_choice: { type: "tool", name: params.toolName },
      messages: [{ role: "user", content: params.userContent }],
    });

    const toolUse = response.content.find(
      (item): item is Anthropic.ToolUseBlock => item.type === "tool_use"
    );

    if (!toolUse) {
      lastError = `Model did not return a "${params.toolName}" tool_use block (stop_reason: ${response.stop_reason}).`;
      continue;
    }

    const result = params.validate(toolUse.input);
    if (result.ok) return result.data;
    lastError = `Structured output failed validation: ${result.error}`;
  }

  throw new Error(`${lastError} (after ${attempts} attempt(s), no partial data committed)`);
}
