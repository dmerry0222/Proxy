import "server-only";

import { supabaseServer } from "@/lib/supabase/server";

import type {
  MemoryEntityResolution,
  MemoryEntityType,
} from "@/lib/memory/types";
import {
  evaluateExternalCorrespondent,
  isLikelyAutomatedSenderAddress,
  isSelfAddress,
  type ExternalCorrespondentEvaluation,
} from "@/lib/memory/externalSenderEligibility";

type RelatedEntity = {
  id: string;
  entity_type: MemoryEntityType;
  canonical_name: string;
  status: string;
};

type OrgChartRow = {
  employee_upn: string | null;
  employeeid: string | null;
  employeename: string | null;
  employeeemail: string | null;
  employeejobtitle: string | null;
  employeedepartment: string | null;
};

function normalizeEmail(
  value: string | null | undefined
) {
  return (
    value
      ?.trim()
      .toLowerCase() ??
    ""
  );
}

async function findExistingMemoryEntityByEmail(
  normalizedEmail: string
): Promise<MemoryEntityResolution | null> {
  const {
    data,
    error,
  } = await supabaseServer
    .from(
      "memory_entity_identifiers"
    )
    .select(`
      identifier_value,
      entity_id,
      memory_entities (
        id,
        entity_type,
        canonical_name,
        status
      )
    `)
    .eq(
      "identifier_type",
      "email"
    )
    .eq(
      "normalized_value",
      normalizedEmail
    )
    .maybeSingle();

  if (error) {
    throw new Error(
      `Failed to resolve Memory entity: ${error.message}`
    );
  }

  if (!data) {
    return null;
  }

  const related =
    data.memory_entities as
      | RelatedEntity
      | RelatedEntity[]
      | null;

  const entity =
    Array.isArray(
      related
    )
      ? related[0]
      : related;

  if (!entity) {
    return null;
  }

  if (
    entity.status ===
    "merged"
  ) {
    return null;
  }

  return {
    entityId:
      entity.id,

    entityType:
      entity.entity_type,

    canonicalName:
      entity.canonical_name,

    matchType:
      "identifier",

    matchedValue:
      normalizedEmail,

    seededFrom:
      null,
  };
}

async function findOrgChartPerson(
  normalizedEmail: string
): Promise<OrgChartRow | null> {
  /*
   * Match against either the employee's canonical email
   * or their Suffolk UPN.
   *
   * We fetch candidates and enforce uniqueness ourselves
   * so ambiguous data never auto-creates an entity.
   */
  const {
    data,
    error,
  } = await supabaseServer
    .from("org_chart")
    .select(`
      employee_upn,
      employeeid,
      employeename,
      employeeemail,
      employeejobtitle,
      employeedepartment
    `)
    .or(
      `employeeemail.ilike.${normalizedEmail},employee_upn.ilike.${normalizedEmail}`
    )
    .limit(2);

  if (error) {
    throw new Error(
      `Failed to check org chart for Memory entity: ${error.message}`
    );
  }

  const matches =
    (data ??
      []) as OrgChartRow[];

  if (
    matches.length !==
    1
  ) {
    return null;
  }

  return matches[0];
}

async function createMemoryPersonFromOrgChart(
  orgPerson: OrgChartRow,
  matchedEmail: string
): Promise<MemoryEntityResolution | null> {
  const canonicalName =
    orgPerson.employeename
      ?.trim();

  if (!canonicalName) {
    return null;
  }

  /*
   * Create the Person entity.
   */
  const {
    data:
      newEntity,
    error:
      entityError,
  } = await supabaseServer
    .from(
      "memory_entities"
    )
    .insert({
      entity_type:
        "person",

      canonical_name:
        canonicalName,

      status:
        "active",

      visibility:
        "normal",

      metadata: {
        seeded_from:
          "org_chart",

        employee_job_title:
          orgPerson
            .employeejobtitle,

        employee_department:
          orgPerson
            .employeedepartment,
      },
    })
    .select(`
      id,
      entity_type,
      canonical_name,
      status
    `)
    .single();

  if (
    entityError ||
    !newEntity
  ) {
    throw new Error(
      `Failed to create Memory person from org chart: ${
        entityError
          ?.message ??
        "Unknown error"
      }`
    );
  }

  /*
   * Add deterministic identifiers.
   *
   * Only non-empty unique values are inserted.
   */
  const identifiers:
    Array<{
      identifier_type:
        string;
      identifier_value:
        string;
      normalized_value:
        string;
      metadata:
        Record<
          string,
          unknown
        >;
    }> =
    [];

  const seenIdentifiers =
    new Set<string>();

  function addIdentifier(
    type: string,
    value:
      | string
      | null
      | undefined
  ) {
    const normalized =
      value
        ?.trim()
        .toLowerCase();

    if (
      !normalized ||
      seenIdentifiers.has(
        `${type}:${normalized}`
      )
    ) {
      return;
    }

    seenIdentifiers.add(
      `${type}:${normalized}`
    );

    identifiers.push({
      identifier_type:
        type,

      identifier_value:
        value!.trim(),

      normalized_value:
        normalized,

      metadata: {
        seeded_from:
          "org_chart",
      },
    });
  }

  addIdentifier(
    "email",
    orgPerson.employeeemail
  );

  addIdentifier(
    "email",
    orgPerson.employee_upn
  );

  addIdentifier(
    "employee_id",
    orgPerson.employeeid
  );

  /*
   * Ensure the email that triggered the match is also
   * represented as an email identifier.
   */
  addIdentifier(
    "email",
    matchedEmail
  );

  if (
    identifiers.length >
    0
  ) {
    const {
      error:
        identifierError,
    } = await supabaseServer
      .from(
        "memory_entity_identifiers"
      )
      .insert(
        identifiers.map(
          (
            identifier
          ) => ({
            entity_id:
              newEntity.id,

            identifier_type:
              identifier
                .identifier_type,

            identifier_value:
              identifier
                .identifier_value,

            normalized_value:
              identifier
                .normalized_value,

            metadata:
              identifier
                .metadata,
          })
        )
      );

    if (
      identifierError
    ) {
      /*
       * If identifier creation fails, don't leave behind
       * a half-created auto-seeded entity.
       */
      await supabaseServer
        .from(
          "memory_entities"
        )
        .delete()
        .eq(
          "id",
          newEntity.id
        );

      throw new Error(
        `Failed to create Memory identifiers from org chart: ${identifierError.message}`
      );
    }
  }

  return {
    entityId:
      newEntity.id,

    entityType:
      newEntity
        .entity_type as MemoryEntityType,

    canonicalName:
      newEntity.canonical_name,

    matchType:
      "identifier",

    matchedValue:
      matchedEmail,

    seededFrom:
      "org_chart",
  };
}

/**
 * Creates a low-risk Person entity for an external (non-Suffolk) sender
 * who has deterministic evidence of being an actual correspondent, not a
 * broadcast/newsletter/system address. See externalSenderEligibility.ts
 * for the exact evidence rule. Deliberately mirrors
 * createMemoryPersonFromOrgChart's shape (same entity_type/status/
 * visibility, same "delete on partial failure" safety), differing only in
 * canonical_name sourcing (no org chart to trust here -- falls back to the
 * bare email when no stable display name was observed) and metadata
 * provenance.
 */
async function createMemoryPersonFromExternalCorrespondence(
  normalizedEmail: string,
  evaluation: ExternalCorrespondentEvaluation
): Promise<MemoryEntityResolution | null> {
  const canonicalName = evaluation.evidence.representativeDisplayName?.trim() || normalizedEmail;

  const { data: newEntity, error: entityError } = await supabaseServer
    .from("memory_entities")
    .insert({
      entity_type: "person",
      canonical_name: canonicalName,
      status: "active",
      visibility: "normal",
      metadata: {
        seeded_from: "external_correspondence",
        seed_reason: evaluation.reason,
        seed_evidence: evaluation.evidence,
      },
    })
    .select(`id, entity_type, canonical_name, status`)
    .single();

  if (entityError || !newEntity) {
    throw new Error(
      `Failed to create Memory person from external correspondence: ${entityError?.message ?? "Unknown error"}`
    );
  }

  const { error: identifierError } = await supabaseServer.from("memory_entity_identifiers").insert({
    entity_id: newEntity.id,
    identifier_type: "email",
    identifier_value: normalizedEmail,
    normalized_value: normalizedEmail,
    metadata: { seeded_from: "external_correspondence" },
  });

  if (identifierError) {
    // Don't leave behind a half-seeded orphan entity.
    await supabaseServer.from("memory_entities").delete().eq("id", newEntity.id);
    throw new Error(`Failed to create Memory identifier from external correspondence: ${identifierError.message}`);
  }

  return {
    entityId: newEntity.id,
    entityType: newEntity.entity_type as MemoryEntityType,
    canonicalName: newEntity.canonical_name,
    matchType: "identifier",
    matchedValue: normalizedEmail,
    seededFrom: "external_correspondence",
  };
}

export async function resolveMemoryEntityByEmail(
  email:
    | string
    | null
    | undefined
): Promise<MemoryEntityResolution | null> {
  const normalizedEmail =
    normalizeEmail(
      email
    );

  if (!normalizedEmail) {
    return null;
  }

  /*
   * 1. Prefer an existing Memory identity.
   */
  const existing =
    await findExistingMemoryEntityByEmail(
      normalizedEmail
    );

  if (existing) {
    return existing;
  }

  /*
   * 2. Suffolk org-chart bootstrap.
   */
  const isSuffolkEmail =
    normalizedEmail.endsWith(
      "@suffolk.edu"
    ) ||
    normalizedEmail.endsWith(
      "@adm.suffolk.edu"
    );

  if (isSuffolkEmail) {
    /*
     * Require exactly one deterministic org-chart match.
     */
    const orgPerson =
      await findOrgChartPerson(
        normalizedEmail
      );

    if (!orgPerson) {
      return null;
    }

    /*
     * Race-condition guard: another request may have created this
     * identity between our first lookup and the org-chart lookup.
     */
    const existingAfterOrgChartLookup =
      await findExistingMemoryEntityByEmail(
        normalizedEmail
      );

    if (existingAfterOrgChartLookup) {
      return existingAfterOrgChartLookup;
    }

    return createMemoryPersonFromOrgChart(
      orgPerson,
      normalizedEmail
    );
  }

  /*
   * 3. External-sender bootstrap.
   *
   * Conservative on purpose: never Dave's own address, never an
   * automated/role-account-shaped local part, and never without
   * deterministic evidence of actual two-way correspondence (a reply
   * Dave sent, or calendar co-presence) -- see
   * externalSenderEligibility.ts. A one-way broadcast/newsletter sender,
   * however frequent, does not qualify.
   */
  if (isSelfAddress(normalizedEmail) || isLikelyAutomatedSenderAddress(normalizedEmail)) {
    return null;
  }

  const evaluation = await evaluateExternalCorrespondent(normalizedEmail);

  if (!evaluation.eligible) {
    return null;
  }

  /*
   * Race-condition guard, same reasoning as the Suffolk path.
   */
  const existingAfterExternalLookup =
    await findExistingMemoryEntityByEmail(
      normalizedEmail
    );

  if (existingAfterExternalLookup) {
    return existingAfterExternalLookup;
  }

  return createMemoryPersonFromExternalCorrespondence(normalizedEmail, evaluation);
}