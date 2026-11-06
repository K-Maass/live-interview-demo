import { expect, test } from "vitest";
import { safePublicQuery } from "../src/research";
test("public research never sends participant identifiers, file paths or credential-like tokens", () => {
  expect(safePublicQuery("FINMA AI governance guidance", ["Lisa"])).toBe(
    "FINMA AI governance guidance",
  );
  expect(
    safePublicQuery("Lisa interview about FINMA", ["Lisa"]),
  ).toBeUndefined();
  expect(safePublicQuery("notes /Users/alex/private", [])).toBeUndefined();
  expect(
    safePublicQuery("person@example.com requirements", []),
  ).toBeUndefined();
});
import { publicResearchQueries } from "../src/research";
test("public subjects match whole words, and acronyms only in capitals", () => {
  expect(publicResearchQueries("DORA applies to our ICT providers.")[0]).toBe(
    "DORA official documentation",
  );
  // A participant called Dora, or a word that contains the acronym, is no regulation.
  expect(publicResearchQueries("Dora from finance joined; the adorable demo ran.")).toEqual([]);
  expect(publicResearchQueries("We discussed IBM Bob and IBM watsonx.")).toEqual([]);
  expect(publicResearchQueries("Does the EU AI Act apply?")[0]).toBe(
    "EU AI Act official documentation",
  );
});
test("automatic public queries contain no free-form meeting facts", () => {
  const queries = publicResearchQueries(
    "Lisa said their private Phoenix project uses FINMA rules.",
  );
  expect(queries.length).toBeGreaterThan(0);
  expect(queries.every((q) => q.startsWith("FINMA "))).toBe(true);
  expect(queries.some((q) => /Lisa|Phoenix|private/.test(q))).toBe(false);
  expect(publicResearchQueries("private project only")).toEqual([]);
  expect(
    publicResearchQueries("", ["Acme public company"]).some((q) =>
      q.startsWith("Acme public company"),
    ),
  ).toBe(true);
});
