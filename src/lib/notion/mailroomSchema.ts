import type { DataSourcePropertySchema } from "./executeSchema";

/**
 * Mailroom -> Notion property contract (Brief Part 2). One Notion page per
 * Outlook conversation. "Flag" is intentionally omitted: it's a legacy
 * action_type only kept in the schema for backward compatibility with old
 * runs (see loadLatestMailroomRun.ts) and current app logic never proposes
 * it, so modeling it here would just be a checkbox with no real state
 * behind it.
 *
 * Review Status / Human Reply Edit / Human Instruction are the
 * human/Notion-owned fields (Brief Part 4): they're seeded with a default
 * on first page creation and never included in later update payloads (see
 * buildCreateOnlyProperties usage in syncMailroom.ts) -- Proxy has no
 * canonical source for them until the submit webhook + reconciliation
 * (Part 4/5) exists, so overwriting them on every re-sync would erase real
 * human input.
 */
export const MAILROOM_PROPERTIES: DataSourcePropertySchema = {
  Conversation: { type: "title", title: {} },
  Sender: { type: "rich_text", rich_text: {} },
  Bucket: {
    type: "select",
    select: {
      options: [
        { name: "Needs You" },
        { name: "FYI" },
        { name: "Professional News" },
        { name: "Low Value" },
        { name: "Calendar" },
        { name: "Workday" },
      ],
    },
  },
  Summary: { type: "rich_text", rich_text: {} },
  // "Needs Action"/"Archive"/"Recommended Action"/"Calendar-related" are
  // retired in favor of the single "Requested Action" select below (Build:
  // Mailroom Action Model). Left in the schema (unwritten going forward,
  // not deleted) so old Notion views referencing them don't break, and so
  // no destructive Notion schema change is needed.
  "Needs Action": { type: "checkbox", checkbox: {} },
  "Recommended Action": { type: "rich_text", rich_text: {} },
  Archive: { type: "checkbox", checkbox: {} },
  "Calendar-related": { type: "checkbox", checkbox: {} },
  "Requested Action": {
    type: "select",
    select: {
      options: [{ name: "Archive" }, { name: "Needs Attention" }, { name: "Draft Reply" }, { name: "Accept Invite" }],
    },
  },
  "Date Received": { type: "date", date: {} },
  /**
   * The explicit execution signal. Editing "Requested Action" alone never
   * executes anything; a Notion Button property sets this to "Requested",
   * and that is the ONLY thing the Power Automate polling flow acts on.
   * Human/Notion-owned (create-only from Proxy's side) so a re-sync can
   * never silently re-arm or clear a pending execution.
   */
  "Execution Status": {
    type: "select",
    select: {
      options: [{ name: "Requested" }, { name: "Executing" }, { name: "Done" }, { name: "Error" }],
    },
  },
  "Suggested Reply": { type: "rich_text", rich_text: {} },
  "Human Reply Edit": { type: "rich_text", rich_text: {} },
  "Human Instruction / Feedback": { type: "rich_text", rich_text: {} },
  "Review Status": {
    type: "select",
    select: { options: [{ name: "Reviewing" }, { name: "Submitted" }, { name: "Executing" }, { name: "Done" }, { name: "Error" }] },
  },
  "Conversation ID": { type: "rich_text", rich_text: {} },
  "Outlook Message ID": { type: "rich_text", rich_text: {} },
};
