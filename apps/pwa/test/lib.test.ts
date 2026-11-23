import { describe, expect, it } from "vitest";
import { sniDivisionsOf, SNI_SECTIONS } from "@opendata/core";
import { divisionsOf, queryToState, safeDownload, stateToQuery, toCsv, formatDistance } from "../src/lib";

describe("URL state", () => {
  it("round-trips and drops junk", () => {
    const s = { address: "Kaffegatan 1", point: { lat: 57.70712, lon: 11.96681 }, radiusM: 1000, section: "I", selected: "30000010" };
    expect(queryToState(stateToQuery(s))).toEqual(s);
    expect(queryToState("?q=x&r=7&sni=zz&v=<script>")).toEqual({ address: "x", point: undefined, radiusM: 500, section: undefined, selected: undefined });
    expect(queryToState("?lat=999&lon=1")).toBeNull();
    expect(stateToQuery({ radiusM: 500 })).toBe("");
  });
});

describe("SNI sections", () => {
  it("matches the server's table", () => {
    for (const { letter } of SNI_SECTIONS) expect(divisionsOf(letter)).toEqual(sniDivisionsOf(letter));
    expect(divisionsOf(undefined)).toBeUndefined();
  });
});

describe("CSV", () => {
  it("quotes, neutralises formulas and adds a BOM", () => {
    const csv = toCsv(["a", "b"], [["=HYPERLINK(\"x\")", "Smith, \"J\""], [-5, null]]);
    expect(csv).toBe('﻿a,b\r\n"\'=HYPERLINK(""x"")","Smith, ""J"""\r\n-5,\r\n');
  });
});

describe("links", () => {
  it("only links same-origin /files paths", () => {
    expect(safeDownload("/files/annual-reports/5560360793/r.zip")).toBe("/files/annual-reports/5560360793/r.zip");
    for (const bad of ["javascript:alert(1)", "https://evil.example/x", "//evil.example/x", "/files/../admin", "/files/a b", null]) expect(safeDownload(bad)).toBeNull();
  });
  it("formats distances", () => {
    expect(formatDistance(120)).toBe("120 m");
    expect(formatDistance(2500)).toBe("2,5 km");
  });
});
