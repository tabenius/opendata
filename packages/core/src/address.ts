/**
 * Address normalisation for matching SCB workplace addresses against
 * Lantmäteriet location addresses. The key is street|number+letter|postcode.
 */
export interface ParsedAddress {
  street: string;
  number?: string;
  letter?: string;
}

export function normaliseText(value: string): string {
  return value
    .normalize("NFC")
    .toUpperCase()
    .replace(/[.,;:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "Storgatan 12 B lgh 1102" -> { street: "STORGATAN", number: "12", letter: "B" } */
export function parseStreetAddress(raw: string): ParsedAddress {
  const text = normaliseText(raw)
    .replace(/\bLGH\s*\d+\b/g, "")
    .replace(/\bC\/O\b.*$/, "")
    .trim();
  const match = /^(.*?)\s+(\d+)\s*([A-ZÅÄÖ])?(?:\s*[-–]\s*\d+[A-Z]?)?(?:\s+(?:TR|VÅN|BV|NB)\b.*)?$/.exec(text);
  if (!match) return { street: text };
  return { street: match[1]!.trim(), number: match[2], letter: match[3] };
}

export function normalisePostcode(value: string | null | undefined): string | undefined {
  const digits = (value ?? "").replace(/\D/g, "");
  return digits.length === 5 ? digits : undefined;
}

export function matchKey(parts: { street: string; number?: string; letter?: string; postcode?: string }): string {
  return [normaliseText(parts.street), `${parts.number ?? ""}${parts.letter ?? ""}`, parts.postcode ?? ""].join("|");
}

export function addressLabel(a: { street: string; number?: string | null; letter?: string | null; postcode?: string | null; town?: string | null }): string {
  const number = `${a.number ?? ""}${a.letter ?? ""}`;
  const line1 = [a.street, number].filter(Boolean).join(" ");
  const pc = a.postcode ? `${a.postcode.slice(0, 3)} ${a.postcode.slice(3)}` : "";
  return [line1, [pc, a.town].filter(Boolean).join(" ")].filter(Boolean).join(", ");
}
