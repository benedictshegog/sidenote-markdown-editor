import { describe, expect, it } from "vitest";

import { normaliseMarkdown } from "./normalise";

describe("normaliseMarkdown", () => {
  it("drops an encoded space at the end of a line", () => {
    expect(normaliseMarkdown("Next week?&#x20;\n\nKind regards,\n")).toBe(
      "Next week?\n\nKind regards,\n",
    );
  });

  it("drops the plain spaces before it, so no hard break appears", () => {
    expect(normaliseMarkdown("one  &#x20;\ntwo\n")).toBe("one\ntwo\n");
  });

  it("drops an encoded tab at the end of a line", () => {
    expect(normaliseMarkdown("one&#x9;\n")).toBe("one\n");
  });

  it("keeps an encoded space that is not at the end of a line", () => {
    expect(normaliseMarkdown("&#x20;indented\n")).toBe("&#x20;indented\n");
  });

  it("keeps a backslash hard break", () => {
    expect(normaliseMarkdown("Kind regards,\\\nBenedict\n")).toBe(
      "Kind regards,\\\nBenedict\n",
    );
  });

  it("leaves code fences alone", () => {
    const md = "```\nx&#x20;\n```\n";
    expect(normaliseMarkdown(md)).toBe(md);
  });
});
