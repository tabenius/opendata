import type { SourceId } from "./types";

export interface SourceInfo {
  id: SourceId;
  name: string;
  publisher: string;
  licence: string;
  attribution: string;
  url: string;
}

/** Attribution travels with every API and MCP result (CC BY requires it). */
export const SOURCES: Record<SourceId, SourceInfo> = {
  "scb-fr": {
    id: "scb-fr",
    name: "Företagsregistret (allmänna företagsregistret)",
    publisher: "SCB",
    licence: "Avgiftsfri enligt förordning (1984:692) om det allmänna företagsregistret; SCB:s användarvillkor",
    attribution: "Källa: SCB, allmänna företagsregistret – egen bearbetning",
    url: "https://www.scb.se/vara-tjanster/bestall-data-och-statistik/foretagsregistret/",
  },
  "bolagsverket-hvd": {
    id: "bolagsverket-hvd",
    name: "Värdefulla datamängder",
    publisher: "Bolagsverket",
    licence: "Värdefull datamängd (EU 2023/138), avgiftsfri",
    attribution: "Källa: Bolagsverket, värdefulla datamängder",
    url: "https://bolagsverket.se/apierochoppnadata/hamtaforetagsinformation/vardefulladatamangder.5294.html",
  },
  "lantmateriet-adress": {
    id: "lantmateriet-adress",
    name: "Belägenhetsadresser",
    publisher: "Lantmäteriet",
    licence: "CC BY 4.0 (värdefulla datamängder) med användningsvillkor",
    attribution: "Källa: Lantmäteriet, Belägenhetsadress",
    url: "https://www.lantmateriet.se/",
  },
  "scb-px": {
    id: "scb-px",
    name: "Statistikdatabasen (PxWebApi v2)",
    publisher: "SCB",
    licence: "CC0",
    attribution: "Källa: SCB, Statistikdatabasen",
    url: "https://www.scb.se/vara-tjanster/oppna-data/api-for-statistikdatabasen/",
  },
  "scb-deso": {
    id: "scb-deso",
    name: "DeSO – demografiska statistikområden",
    publisher: "SCB",
    licence: "CC0",
    attribution: "Källa: SCB, DeSO",
    url: "https://www.scb.se/hitta-statistik/regional-statistik-och-kartor/regionala-indelningar/deso---demografiska-statistikomraden/",
  },
  fixture: {
    id: "fixture",
    name: "Test fixture",
    publisher: "opendata",
    licence: "CC0",
    attribution: "Fiktiva testdata",
    url: "https://github.com/tabenius/opendata",
  },
};
