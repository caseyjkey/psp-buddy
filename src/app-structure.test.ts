import { expect, test } from "bun:test";

const source = await Bun.file(new URL("./app.tsx", import.meta.url)).text();

test("high-frequency aquarium state never drives a plain provider-row map", () => {
  expect(source).toContain("<Index each={reportingProviders()}>");
  expect(source).not.toContain("const live = creatures().filter");
  expect(source).not.toContain("return rows.map((p)");
});

test("provider strip names exhausted longer quota windows", () => {
  expect(source).toContain("exhaustedQuotaLabel(");
  expect(source).toContain("weeklyRemaining");
  expect(source).toContain("monthlyRemaining");
});
