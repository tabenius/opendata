/**
 * Swedish identity numbers. An organisationsnummer has 10 digits, a valid
 * Luhn check digit, and a third digit >= 2. A personnummer's third digit is
 * the first digit of a month (0 or 1), so the structural check alone
 * separates legal entities from people. 12-digit forms are personnummer or
 * samordningsnummer and are never legal-entity numbers here.
 */
export function digitsOnly(value: string): string {
  return value.replace(/[\s-]/g, "");
}

export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** True only for a structurally valid legal-entity organisationsnummer. */
export function isLegalEntityNumber(value: string): boolean {
  const digits = digitsOnly(value);
  return /^\d{10}$/.test(digits) && Number(digits[2]) >= 2 && luhnValid(digits);
}

/** Normalise to 10 digits or throw. Refuses anything that could be a personnummer. */
export function parseOrgnr(value: string): string {
  let digits = digitsOnly(value);
  // "16" + orgnr is the 12-digit form of an organisationsnummer.
  if (/^16\d{10}$/.test(digits)) digits = digits.slice(2);
  if (!isLegalEntityNumber(digits)) throw new RangeError("not a legal-entity organisation number");
  return digits;
}

export function formatOrgnr(orgnr: string): string {
  return `${orgnr.slice(0, 6)}-${orgnr.slice(6)}`;
}
