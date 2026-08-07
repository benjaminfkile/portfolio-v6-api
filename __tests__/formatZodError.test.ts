import { z } from "zod";
import { formatZodError } from "../src/utils/zodError";
import { skillsData } from "../src/schemas";

/**
 * `formatZodError` unit tests — §Icons v1.6 (task #532).
 *
 * The section/item validators previously interpolated `parsed.error.message` —
 * the raw serialized issue array (a multi-line JSON blob). `formatZodError`
 * flattens a ZodError to a compact `path: message; …` one-liner so a 400 reads
 * like `sphere_detail: Number must be less than or equal to 4`.
 */
describe("formatZodError (§Icons v1.6)", () => {
  it("renders a nested-path issue as `path: message`", () => {
    const res = skillsData.safeParse({ sphere_detail: 5 });
    expect(res.success).toBe(false);
    if (res.success) return;
    const msg = formatZodError(res.error);
    expect(msg).toContain("sphere_detail: ");
    // Compact + human-readable — NOT the raw JSON issue array.
    expect(msg).not.toContain("[");
    expect(msg).not.toContain('"code"');
  });

  it("labels a root-level issue `(root)`", () => {
    const res = z.string().safeParse(123);
    expect(res.success).toBe(false);
    if (res.success) return;
    expect(formatZodError(res.error)).toMatch(/^\(root\): /);
  });

  it("joins multiple issues with `; `", () => {
    const schema = z.object({ a: z.string(), b: z.number() });
    const res = schema.safeParse({ a: 1, b: "x" });
    expect(res.success).toBe(false);
    if (res.success) return;
    const msg = formatZodError(res.error);
    expect(msg).toContain("a: ");
    expect(msg).toContain("b: ");
    expect(msg).toContain("; ");
  });

  it("joins a deep path with dots", () => {
    const schema = z.object({ outer: z.object({ inner: z.number() }) });
    const res = schema.safeParse({ outer: { inner: "nope" } });
    expect(res.success).toBe(false);
    if (res.success) return;
    expect(formatZodError(res.error)).toMatch(/^outer\.inner: /);
  });
});
