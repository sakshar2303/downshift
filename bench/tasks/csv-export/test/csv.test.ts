import { describe, expect, it } from "vitest";
import { toCsv } from "../src/csv";

describe("toCsv", () => {
  it("writes a header row followed by each data row", () => {
    expect(
      toCsv([{ name: "Ada", language: "TypeScript" }], ["name", "language"]),
    ).toBe("name,language\r\nAda,TypeScript");
  });

  it("uses the requested column order, not object key order", () => {
    expect(
      toCsv(
        [{ language: "TypeScript", name: "Ada", year: 1843 }],
        ["year", "name", "language"],
      ),
    ).toBe("year,name,language\r\n1843,Ada,TypeScript");
  });

  it("quotes fields containing commas", () => {
    expect(
      toCsv([{ name: "Doe, Jane", role: "engineer" }], ["name", "role"]),
    ).toBe('name,role\r\n"Doe, Jane",engineer');
  });

  it("quotes fields containing quotes and doubles the quotes (RFC 4180)", () => {
    expect(
      toCsv([{ quote: 'She said "hello"' }], ["quote"]),
    ).toBe('quote\r\n"She said ""hello"""');
  });

  it("quotes fields containing newlines and keeps the newline", () => {
    expect(toCsv([{ note: "line one\nline two" }], ["note"])).toBe(
      'note\r\n"line one\nline two"',
    );
  });

  it("writes empty fields for null and undefined", () => {
    expect(
      toCsv([{ a: null, b: undefined, c: "kept" }], ["a", "b", "c"]),
    ).toBe("a,b,c\r\n,,kept");
  });

  it("writes numbers as-is", () => {
    expect(toCsv([{ count: 42, ratio: 3.5, zero: 0 }], ["count", "ratio", "zero"])).toBe(
      "count,ratio,zero\r\n42,3.5,0",
    );
  });

  it("writes Date values as ISO strings", () => {
    const date = new Date("2020-01-02T03:04:05.000Z");
    expect(toCsv([{ at: date }], ["at"])).toBe(
      "at\r\n2020-01-02T03:04:05.000Z",
    );
  });

  it("writes booleans", () => {
    expect(toCsv([{ yes: true, no: false }], ["yes", "no"])).toBe(
      "yes,no\r\ntrue,false",
    );
  });

  it("writes only the header for an empty row list", () => {
    expect(toCsv([], ["a", "b"])).toBe("a,b");
  });

  it("separates rows with CRLF line endings", () => {
    const csv = toCsv(
      [
        { a: "1", b: "2" },
        { a: "3", b: "4" },
      ],
      ["a", "b"],
    );
    expect(csv).toBe("a,b\r\n1,2\r\n3,4");
    expect(csv.split("\r\n")).toHaveLength(3);
    expect(csv.replace(/\r\n/g, "")).not.toContain("\n");
  });
});