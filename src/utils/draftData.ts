/**
 * Draft-write helper (§3.9 draft leniency): treat empty-string fields as "not
 * filled in yet" by stripping them before validation. The admin's
 * create-empty-then-edit flow initializes every text field to "" — a present
 * empty string would still fail the canonical min-length rules, so draft
 * validation removes them instead. Publish re-validates the stored data against
 * the canonical schemas; fields whose canonical schema allows an empty string
 * carry `.default("")` there, so a stripped field publishes identically to an
 * explicit empty string.
 */
export function stripEmptyStrings(
  value: unknown
): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === "") continue;
    out[k] = v;
  }
  return out;
}
