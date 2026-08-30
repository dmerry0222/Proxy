/**
 * Pure comparison of an expected Notion data-source property schema against
 * the schema Notion actually reports. Zero-import leaf module so it is
 * directly unit testable (node --experimental-strip-types) and so the
 * "what needs patching" decision is defined once, independently of any
 * Notion API call.
 *
 * The asymmetry here is deliberate and load-bearing: Notion's data source
 * update only adds or modifies the properties named in the payload, and
 * omitting a property never deletes it. So a property present in Notion but
 * absent from the expected schema is reported as LEGACY (retained,
 * untouched) rather than as drift to be corrected -- deleting it would
 * break any existing Notion view that still references it.
 */

export type ExpectedPropertyDef = {
  type: string;
  select?: { options: { name: string }[] };
  multi_select?: { options: { name: string }[] };
  [key: string]: unknown;
};

export type ExpectedSchema = Record<string, ExpectedPropertyDef>;

export type ActualPropertyDef = {
  type: string;
  select?: { options: { name: string }[] };
  multi_select?: { options: { name: string }[] };
  [key: string]: unknown;
};

export type ActualSchema = Record<string, ActualPropertyDef>;

export type SchemaDiff = {
  /** Expected but entirely absent from Notion -- must be created. */
  missingProperties: string[];
  /** Present, right type, but missing one or more expected select options. */
  missingSelectOptions: { property: string; options: string[] }[];
  /**
   * Present but with a different type than expected. Reported, never
   * auto-patched: changing a live property's type in Notion destroys the
   * data already stored in it, so this needs a human decision.
   */
  typeMismatches: { property: string; expected: string; actual: string }[];
  /** In Notion but not in the expected schema -- retained, not written. */
  legacyProperties: string[];
  /** Present, correct type, all expected options already there. */
  compliantProperties: string[];
  /** True when nothing needs to change. */
  inSync: boolean;
};

function optionNames(def: ExpectedPropertyDef | ActualPropertyDef): string[] {
  if (def.type === "select" && def.select) return def.select.options.map((o) => o.name);
  if (def.type === "multi_select" && def.multi_select) return def.multi_select.options.map((o) => o.name);
  return [];
}

export function diffDataSourceSchema(expected: ExpectedSchema, actual: ActualSchema): SchemaDiff {
  const missingProperties: string[] = [];
  const missingSelectOptions: { property: string; options: string[] }[] = [];
  const typeMismatches: { property: string; expected: string; actual: string }[] = [];
  const compliantProperties: string[] = [];

  for (const [name, expectedDef] of Object.entries(expected)) {
    const actualDef = actual[name];

    if (!actualDef) {
      missingProperties.push(name);
      continue;
    }

    if (actualDef.type !== expectedDef.type) {
      typeMismatches.push({ property: name, expected: expectedDef.type, actual: actualDef.type });
      continue;
    }

    const expectedOptions = optionNames(expectedDef);
    if (expectedOptions.length > 0) {
      const present = new Set(optionNames(actualDef));
      const absent = expectedOptions.filter((option) => !present.has(option));
      if (absent.length > 0) {
        missingSelectOptions.push({ property: name, options: absent });
        continue;
      }
    }

    compliantProperties.push(name);
  }

  const legacyProperties = Object.keys(actual).filter((name) => !(name in expected));

  return {
    missingProperties,
    missingSelectOptions,
    typeMismatches,
    legacyProperties,
    compliantProperties,
    inSync: missingProperties.length === 0 && missingSelectOptions.length === 0 && typeMismatches.length === 0,
  };
}

/**
 * The minimal `properties` payload that brings Notion into compliance.
 *
 * Only properties that actually need work are included, which is what makes
 * repeated runs idempotent: once the schema matches, this returns `{}` and
 * the caller can skip the API call entirely rather than issuing a no-op
 * write on every sync.
 *
 * Type mismatches are deliberately excluded -- see SchemaDiff.typeMismatches.
 *
 * For a select property missing options, the payload carries the UNION of
 * the options Notion already has and the ones we expect, with the existing
 * ones first. Notion replaces a select's option list with what you send, so
 * sending only the expected set would silently delete any option a human
 * added in Notion and orphan every page already tagged with it.
 */
export function buildSchemaPatch(expected: ExpectedSchema, actual: ActualSchema, diff: SchemaDiff): ExpectedSchema {
  const patch: ExpectedSchema = {};

  for (const name of diff.missingProperties) {
    patch[name] = expected[name];
  }

  for (const { property } of diff.missingSelectOptions) {
    const expectedDef = expected[property];
    const existing = optionNames(actual[property]);
    const merged = [...existing];
    for (const option of optionNames(expectedDef)) {
      if (!merged.includes(option)) merged.push(option);
    }

    const options = merged.map((name) => ({ name }));
    patch[property] =
      expectedDef.type === "multi_select"
        ? { type: "multi_select", multi_select: { options } }
        : { type: "select", select: { options } };
  }

  return patch;
}
