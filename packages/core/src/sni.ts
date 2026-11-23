/**
 * SNI 2007 sections (avdelningar), keyed by the two-digit division
 * (huvudgrupp) ranges. Static: the section structure is part of the
 * standard and needs no download. Finer titles come from the `sni` table.
 */
const SECTIONS: [letter: string, from: number, to: number, title: string][] = [
  ["A", 1, 3, "Jordbruk, skogsbruk och fiske"],
  ["B", 5, 9, "Utvinning av mineral"],
  ["C", 10, 33, "Tillverkning"],
  ["D", 35, 35, "Försörjning av el, gas, värme och kyla"],
  ["E", 36, 39, "Vattenförsörjning; avloppsrening, avfallshantering och sanering"],
  ["F", 41, 43, "Byggverksamhet"],
  ["G", 45, 47, "Handel; reparation av motorfordon och motorcyklar"],
  ["H", 49, 53, "Transport och magasinering"],
  ["I", 55, 56, "Hotell- och restaurangverksamhet"],
  ["J", 58, 63, "Informations- och kommunikationsverksamhet"],
  ["K", 64, 66, "Finans- och försäkringsverksamhet"],
  ["L", 68, 68, "Fastighetsverksamhet"],
  ["M", 69, 75, "Verksamhet inom juridik, ekonomi, vetenskap och teknik"],
  ["N", 77, 82, "Uthyrning, fastighetsservice, resetjänster och andra stödtjänster"],
  ["O", 84, 84, "Offentlig förvaltning och försvar; obligatorisk socialförsäkring"],
  ["P", 85, 85, "Utbildning"],
  ["Q", 86, 88, "Vård och omsorg; sociala tjänster"],
  ["R", 90, 93, "Kultur, nöje och fritid"],
  ["S", 94, 96, "Annan serviceverksamhet"],
  ["T", 97, 98, "Förvärvsarbete i hushåll; hushållens produktion av diverse varor och tjänster för eget bruk"],
  ["U", 99, 99, "Verksamhet vid internationella organisationer, utländska ambassader o.d."],
];

export interface SniSection {
  letter: string;
  title: string;
}

export function sniSection(code: string | null | undefined): SniSection | null {
  if (!code || !/^\d{2}/.test(code)) return null;
  const division = Number(code.slice(0, 2));
  const hit = SECTIONS.find(([, from, to]) => division >= from && division <= to);
  return hit ? { letter: hit[0], title: hit[3] } : null;
}

export const SNI_SECTIONS: readonly SniSection[] = SECTIONS.map(([letter, , , title]) => ({ letter, title }));

/** Two-digit division prefixes belonging to a section letter, for filtering. */
export function sniDivisionsOf(letter: string): string[] {
  const hit = SECTIONS.find(([l]) => l === letter.toUpperCase());
  if (!hit) throw new RangeError(`unknown SNI section ${letter}`);
  const out: string[] = [];
  for (let d = hit[1]; d <= hit[2]; d++) out.push(String(d).padStart(2, "0"));
  return out;
}
