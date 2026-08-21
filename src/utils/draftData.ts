/**
 * Draft-write helper (§3.9 draft leniency): treat empty-string fields as "not
 * filled in yet" by stripping them before validation. The admin's
 * create-empty-then-edit flow initializes every text field to "", a present
 * empty string would still fail the canonical min-length rules, so draft
 * validation removes them instead. Publish re-validates the stored data against
 * the canonical schemas; fields whose canonical schema allows an empty string
 * carry `.default("")` there, so a stripped field publishes identically to an
 * explicit empty string.
 *
 * Recurses into nested objects and arrays so an empty-string field one level
 * down (e.g. the hero section's nested `background.object_position`) is
 * stripped the same way a top-level one is. Array element positions are
 * preserved, an empty string inside an array stays as `""` because the
 * scalar-vs-container distinction is made against the container it belongs
 * to, not the element itself.
 */
export function stripEmptyStrings(
  value: unknown
): unknown {
  if (Array.isArray(value)) {
    return value.map(stripEmptyStrings);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === "") continue;
    out[k] = stripEmptyStrings(v);
  }
  return out;
}
