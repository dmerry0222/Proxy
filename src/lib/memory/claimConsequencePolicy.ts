/**
 * Pure, zero-import consequence assessment for `fact` and `decision`
 * Memory claims.
 *
 * WHY: claim_type turned out to be too coarse a proxy for stakes. A
 * read-only audit of the pending review queue found `fact` and `decision`
 * each spanning the full range -- "Sarah doesn't have my.suffolk.edu
 * access" sits in the same bucket as "the GrayDI vendor contract must be
 * signed by September 1." Reviewing all of them trains Dave to skim;
 * auto-saving all of them would lose the ones that matter. So stakes are
 * assessed from CONTENT, not type.
 *
 * Deliberately deterministic and explainable: every outcome names the
 * signal group that produced it, so a surprising classification can be
 * traced to a specific pattern rather than a model's mood. High-stakes
 * signals are checked FIRST and win outright -- "approved Sarah's access
 * to the budget system" matches both groups and must review.
 *
 * SCOPE: this module is consulted ONLY for `fact` and `decision`. The
 * conservative types (relationship, role, responsibility,
 * governing_context) never reach it -- see claimReviewPolicy.ts. That
 * separation is intentional: relationship claims can carry personal and
 * family information, which no keyword list should be trusted to triage.
 */

export type ClaimConsequenceLevel = "high" | "low" | "ambiguous";

export type ClaimConsequenceResult = {
  level: ClaimConsequenceLevel;
  /** The signal group that decided this, for auditability. */
  signal: string | null;
  reason: string;
};

/**
 * High-consequence signal groups. Being wrong about any of these has a
 * real-world cost -- money moves, an obligation is created, a deadline is
 * missed, or an institutional commitment is misremembered. False positives
 * here cost one extra review item; false negatives cost a silently wrong
 * belief about something that mattered.
 */
const HIGH_CONSEQUENCE_SIGNALS: { name: string; pattern: RegExp }[] = [
  {
    name: "money",
    pattern:
      /\$\s?\d|\b(budget|funding|funded|salary|compensation|stipend|invoice|reimburse\w*|expenditure|allocation|tuition|payment|payroll|grant award|cost share)\b/i,
  },
  {
    name: "contract_or_vendor",
    pattern:
      /\b(contract|vendor|supplier|procurement|purchase order|statement of work|\bsow\b|\brfp\b|\bmou\b|licens\w+ agreement|subscription renewal|renewal|terms of service)\b/i,
  },
  {
    name: "deadline",
    pattern:
      /\b(deadline|due by|due date|no later than|must be (?:submitted|signed|completed|returned)|expires?|expiration|cutoff|by (?:the )?end of (?:the )?(?:day|week|month|quarter|year)|\beod\b|\bcob\b)\b/i,
  },
  {
    name: "commitment_or_approval",
    pattern:
      /\b(approved|approval|sign(?:ed)?[- ]off|authoriz\w+|committed to|commitment|greenlit|agreed to (?:fund|pay|provide|deliver|cover)|guaranteed)\b/i,
  },
  {
    name: "policy_change",
    pattern:
      /\b(policy|new procedure|procedure change|effective immediately|mandate[ds]?|now requires?|no longer permitted|guideline change|bylaw)\b/i,
  },
  {
    /*
     * Compensation paid in TIME rather than money. The audit found
     * "Staff who cover Saturday orientation will receive a full vacation
     * day instead of..." reaching review only via the ambiguous default --
     * correct outcome, wrong reason. Cash compensation was already covered
     * (claimReviewPolicy's sensitive-keyword gate catches salary/bonus/
     * payroll before this module is consulted); time-off-in-kind was the
     * gap.
     *
     * Deliberately requires a GRANTING verb within a short window of the
     * time-off noun, so an ordinary "on vacation from August 1-14" or
     * "took a vacation day Friday" stays low/ambiguous. Only the bare
     * policy-of-art terms (comp time, time off in lieu, floating holiday)
     * match on their own, because those phrases are not used casually.
     */
    name: "compensation_or_time_off",
    pattern:
      /\b(?:comp(?:ensatory)? time|time off in lieu|floating holiday)\b|\b(?:receiv\w+|award\w*|grant\w*|earn\w*|accru\w*|given|compensated with|in lieu of|in exchange for)\b[^.]{0,40}\b(?:vacation day|personal day|paid time off|\bpto\b|day off)\b/i,
  },
  {
    name: "employment_or_hr",
    pattern:
      /\b(hir\w+|new position|promotion|promoted|reassign\w*|headcount|\bfte\b|job description|performance review|reports? to|direct report|search committee)\b/i,
  },
  {
    name: "program_viability",
    pattern:
      /\b(enrollment|accreditation|discontinu\w+|sunset\w*|program viability|viability|curriculum change|degree program|cohort size|program closure|teach[- ]out|low enrollment)\b/i,
  },
  {
    name: "legal_or_compliance",
    pattern: /\b(complian\w+|regulat\w+|\bferpa\b|title ix|\bada\b|audit|liabilit\w+|breach|subpoena|counsel)\b/i,
  },
  {
    name: "ownership_transfer",
    pattern:
      /\b(taking over|took over|now (?:owns|leads|manages)|transferr\w+ to|will lead|handing off|accountable for|assum\w+ responsibility)\b/i,
  },
  {
    name: "explicit_decision",
    pattern:
      /\b(decided to|decision was made|final decision|we will proceed|moving forward with|has been finalized|officially (?:approved|adopted|selected))\b/i,
  },
];

/**
 * Low-consequence signal groups: routine operational texture. Being wrong
 * about one of these is cheap and self-correcting -- the next email says
 * otherwise and Memory updates. These are exactly the observations that
 * were flooding the review queue.
 */
const LOW_CONSEQUENCE_SIGNALS: { name: string; pattern: RegExp }[] = [
  {
    name: "access_or_support",
    pattern:
      /\b(access to|does not have access|login|log in|password|permissions?|it support|help ?desk|support ticket|troubleshoot\w*|canvas|portal|account setup|reset|browser|\bvpn\b|software install)\b/i,
  },
  {
    name: "routine_scheduling",
    pattern:
      /\b(scheduled|rescheduled|meeting (?:on|at|for)|calendar invite|will meet|availabilit\w+|time slot|check[- ]in|stand[- ]?up|recurring meeting|moved (?:the )?meeting)\b/i,
  },
  {
    /*
     * `agree[sd] with` only -- NOT `agree to`. "Agreed to fund the panel"
     * is a commitment and is already caught by the high-consequence
     * commitment_or_approval group, which runs first; keeping the low
     * pattern anchored to "with" means an endorsement ("agrees with the
     * proposed language change") reads as opinion while an undertaking
     * does not, without relying on group ordering to save us.
     */
    name: "opinion_or_support",
    pattern:
      /\b(supports?|is supportive|agree[sd]? with|likes the idea|is interested in|expressed interest|suggested|recommends?|prefers?|thinks that|feels that|mentioned that|is open to|is excited)\b/i,
  },
  {
    name: "status_observation",
    pattern:
      /\b(is working on|is reviewing|has started|in progress|is drafting|attended|joined|presented|shared (?:a|the|an)|sent (?:a|the|an)|followed up|is waiting to hear)\b/i,
  },
];

/**
 * Assesses stakes for a `fact` or `decision` statement.
 *
 * Returns "ambiguous" when nothing matches -- the caller treats that as
 * review-required. That default is load-bearing: an unrecognized statement
 * shape is precisely the case where guessing is unwarranted.
 */
export function assessClaimConsequence(statement: string): ClaimConsequenceResult {
  for (const signal of HIGH_CONSEQUENCE_SIGNALS) {
    if (signal.pattern.test(statement)) {
      return {
        level: "high",
        signal: signal.name,
        reason: `Matched high-consequence signal "${signal.name}".`,
      };
    }
  }

  for (const signal of LOW_CONSEQUENCE_SIGNALS) {
    if (signal.pattern.test(statement)) {
      return {
        level: "low",
        signal: signal.name,
        reason: `Matched low-consequence signal "${signal.name}" with no high-consequence signal present.`,
      };
    }
  }

  return {
    level: "ambiguous",
    signal: null,
    reason: "No recognized consequence signal; defaulting to review.",
  };
}
