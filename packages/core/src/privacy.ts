/**
 * The privacy policy, in one place. See doc/PLAN.md §1.
 *
 * Only legal entities are stored or served. A record is publishable when its
 * identity is a legal-entity organisationsnummer AND no source classifies it
 * as a natural person. Unknown classification fails closed.
 */
import { isLegalEntityNumber } from "./orgnr";

/** SCB juridisk form codes that denote people: 10 fysiska personer, 91 oskiftade dödsbon. */
export const NATURAL_PERSON_JURFORM = new Set(["10", "91"]);
/** Bolagsverket organisationsform codes for sole traders (enskild näringsidkare). */
export const NATURAL_PERSON_BV_FORMS = new Set(["E", "EF", "ENK"]);

export type Classification = "legal" | "natural" | "unknown";

export interface ClassificationInput {
  id: string;
  /** SCB jurform (e.g. "49"). */
  jurform?: string | number | null;
  /** Bolagsverket organisationsform code (e.g. "AB", "E"). */
  bvForm?: string | null;
  /** Bolagsverket identitetsbeteckningstyp (e.g. "ORGNR-IDORG", "PERSON-IDORG"). */
  idType?: string | null;
}

export function classify(input: ClassificationInput): Classification {
  if (input.idType && /PERSON|SAMORD/i.test(input.idType)) return "natural";
  if (input.jurform !== undefined && input.jurform !== null && NATURAL_PERSON_JURFORM.has(String(input.jurform))) return "natural";
  if (input.bvForm && NATURAL_PERSON_BV_FORMS.has(input.bvForm.replace(/-ORGFO$/, ""))) return "natural";
  if (!isLegalEntityNumber(input.id)) return /^\d{10,12}$/.test(input.id.replace(/[\s-]/g, "")) ? "natural" : "unknown";
  return "legal";
}

export function isPublishable(input: ClassificationInput): boolean {
  return classify(input) === "legal";
}

export class PrivacyViolation extends Error {
  constructor(message = "record is not a publishable legal entity") {
    super(message);
    this.name = "PrivacyViolation";
  }
}

/** The single write-path guard. Every repository write calls this. */
export function assertPublishable(input: ClassificationInput): void {
  if (!isPublishable(input)) throw new PrivacyViolation();
}
