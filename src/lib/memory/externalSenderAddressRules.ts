/**
 * Pure, zero-import address-shape rules for external-sender auto-seeding.
 * Split out from externalSenderEligibility.ts (which also does DB-backed
 * correspondence checks) so this deterministic piece is directly
 * unit-testable without a database.
 */

/**
 * Dave's own addresses -- must never be auto-seeded as an "external
 * correspondent" person entity. Kept local rather than importing
 * Mailroom's MAILBOX_OWNER_EMAIL constant: these two modules intentionally
 * don't share a runtime dependency, and this list only needs to answer
 * "is this Dave," not anything about mailbox ownership.
 */
const SELF_ADDRESSES = new Set(["dmerry@suffolk.edu", "dave.l.merry@gmail.com"]);

/**
 * Automated/role-account local-part patterns. Local part must be ENTIRELY
 * consumed by a keyword optionally followed by a separator + anything
 * (`sales-support@`, `no.reply@`) -- a real person's local part that merely
 * starts with one of these words as a substring (e.g. "newsome") will not
 * match, because nothing after the keyword is left unaccounted for unless
 * it starts with a separator.
 */
const AUTOMATED_LOCAL_PART_PATTERN =
  /^(no-?reply|do-?not-?reply|notifications?|notify|alerts?|digests?|bounces?|mailer-?daemon|postmaster|auto-?(?:reply|confirm|submit|generated)|unsubscribe|newsletters?|updates?|marketing|press|webinars?|events?|communications?|publishing|training|support|helpdesk|help|info|admin|sales|careers?|jobs?|hr|humanresources|accounts?|billing|orders?|service|feedback|contact)([._-].*)?$/i;

export function isSelfAddress(normalizedEmail: string): boolean {
  return SELF_ADDRESSES.has(normalizedEmail);
}

export function isLikelyAutomatedSenderAddress(email: string): boolean {
  const at = email.indexOf("@");
  const localPart = at === -1 ? email : email.slice(0, at);
  return AUTOMATED_LOCAL_PART_PATTERN.test(localPart.trim());
}

/**
 * Recipient columns store two different shapes in this dataset: an array
 * of individually-quoted addresses, or a single semicolon-joined string in
 * one array element. Handles both without assuming either.
 */
export function parseRecipientList(raw: string[] | null): string[] {
  if (!raw) return [];
  return raw
    .flatMap((entry) => entry.split(";"))
    .map((entry) => entry.replace(/^"+|"+$/g, "").trim().toLowerCase())
    .filter(Boolean);
}

export type UnresolvedSenderDiagnostic = {
  status: "success" | "warning";
  severity: "info" | "warning";
  humanSummary: string;
  isSuffolkSender: boolean;
  likelyAutomated: boolean;
};

/**
 * Classifies the Inspector General presentation for an unresolved sender
 * (resolveMemoryEntityByEmail returned null). Kept as a pure function so
 * Inspector General's "ordinary policy behavior vs. actual trouble"
 * distinction is directly testable:
 *
 *   - unresolved EXTERNAL sender (automated-looking or not): "success" /
 *     "info" -- expected, not enough evidence yet to auto-seed. Applies
 *     uniformly regardless of how many times the address recurs, so ten
 *     messages from one still-unresolved external sender never read as ten
 *     separate problems.
 *   - unresolved SUFFOLK sender (failed org-chart match): "warning" --
 *     normally every Suffolk employee is in the org chart, so a miss here
 *     more likely reflects a real data gap worth a glance.
 *
 * A resolver EXCEPTION (DB failure, etc.) is deliberately out of scope
 * here -- it propagates to the caller's outer error handling, which
 * already records it at "error" severity.
 */
export function classifyUnresolvedSenderDiagnostic(normalizedFrom: string): UnresolvedSenderDiagnostic {
  const isSuffolkSender = normalizedFrom.endsWith("@suffolk.edu") || normalizedFrom.endsWith("@adm.suffolk.edu");
  const likelyAutomated = !isSuffolkSender && normalizedFrom ? isLikelyAutomatedSenderAddress(normalizedFrom) : false;

  if (isSuffolkSender) {
    return {
      status: "warning",
      severity: "warning",
      humanSummary: "Suffolk sender could not be matched via the org chart — may indicate a data gap.",
      isSuffolkSender,
      likelyAutomated,
    };
  }

  return {
    status: "success",
    severity: "info",
    humanSummary: likelyAutomated
      ? "Sender address looks automated/system-generated; not eligible for a Memory identity (expected)."
      : "External sender not yet recognized; not enough evidence yet to auto-seed a Memory identity (expected policy behavior).",
    isSuffolkSender,
    likelyAutomated,
  };
}
