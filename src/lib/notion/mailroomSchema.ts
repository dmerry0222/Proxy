import type { DataSourcePropertySchema } from "./executeSchema";

/**
 * Mailroom -> Notion property contract (Brief Part 2). One Notion page per
 * Outlook conversation. "Flag" is intentionally omitted: it's a legacy
 * action_type only kept in the schema for backward compatibility with old
 * runs (see loadLatestMailroomRun.ts) and current app logic never proposes
 * it, so modeling it here would just be a checkbox with no real state
 * behind it.
 *
 * Three ownership models are in play here:
 *
 *  - PROXY-OWNED (Conversation, Sender, Summary, Date Received, ...):
 *    rewritten from canonical state on every sync.
 *  - HUMAN-OWNED (Human Reply Edit, Human Instruction, Submitted,
 *    Execution Status): seeded once on page creation and never included in
 *    a later update payload (see buildCreateOnlyProperties in
 *    syncMailroom.ts), so a re-sync cannot erase real human input or
 *    re-arm a pending execution.
 *  - GUARDED (Bucket, Requested Action): Proxy proposes them and keeps
 *    them current, but stops writing whichever one a human has changed
 *    until that change is submitted and reconciled. See
 *    guardedProperties.ts for why the middle state is necessary.
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
  /**
   * The human's "I'm done reviewing this row" signal, set by a per-row
   * Notion button. Human/Notion-owned: seeded to false exactly once on page
   * creation and never written by ordinary outgoing sync, so a re-sync can
   * never un-submit a row Dave has already cleared from his review view.
   *
   * Note this is a REVIEW signal, not an EXECUTION signal -- "Execution
   * Status" remains the only thing that arms Power Automate. Submitting a
   * row tells Proxy to reconcile the reviewed values; it does not perform
   * any Outlook mutation.
   */
  Submitted: { type: "checkbox", checkbox: {} },
  "Conversation ID": { type: "rich_text", rich_text: {} },
  "Outlook Message ID": { type: "rich_text", rich_text: {} },
};

/**
 * Properties retired by the Mailroom Action Model build, superseded by the
 * single "Requested Action" select.
 *
 * Deliberately ABSENT from MAILROOM_PROPERTIES rather than listed there.
 * Notion's data source update only touches the properties named in the
 * payload and never deletes the ones you omit, so leaving them out means
 * they survive untouched in Notion -- existing views that still reference
 * them keep working -- while the schema diff correctly reports them as
 * legacy rather than as part of the contract. Nothing writes them: they
 * appear in no buildProperties payload in syncMailroom.ts.
 *
 * Listed here (and not merely deleted from the file) so the migration
 * report can name them and explain why they are still present, instead of
 * a reader having to infer it from their absence.
 */
export const RETIRED_MAILROOM_PROPERTIES: { name: string; supersededBy: string }[] = [
  { name: "Needs Action", supersededBy: "Requested Action = Needs Attention" },
  { name: "Archive", supersededBy: "Requested Action = Archive" },
  { name: "Recommended Action", supersededBy: "Requested Action (plus mailroom_feedback for the original recommendation)" },
  { name: "Calendar-related", supersededBy: "Bucket = Calendar" },
  {
    name: "Review Status",
    supersededBy: "Submitted (review) and Execution Status (execution)",
  },
];
