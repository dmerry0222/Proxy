import "server-only";

import type { WorkBlockChecklistItem } from "@/lib/execute/types";

export type CalendarOutboxPayload = {
  schemaVersion: 1;
  operation: "create" | "update" | "cancel";
  workBlockId: string;
  title: string;
  start: string;
  end: string;
  categories: ["Proxy Work Block"];
  body: string;
};

export function buildWorkBlockCalendarPayload(input: {
  workBlockId: string;
  title: string;
  start: string;
  end: string;
  checklist: WorkBlockChecklistItem[];
}): CalendarOutboxPayload {
  const checklist = input.checklist.length
    ? `\n\nPlan:\n${input.checklist.map((item) => `- ${item.label}`).join("\n")}`
    : "";

  return {
    schemaVersion: 1,
    operation: "create",
    workBlockId: input.workBlockId,
    title: input.title,
    start: input.start,
    end: input.end,
    categories: ["Proxy Work Block"],
    body: `Protected by Proxy.\nProxy work block: ${input.workBlockId}${checklist}`,
  };
}

