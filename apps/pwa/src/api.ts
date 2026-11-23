/** Tiny GraphQL client against the same origin (or VITE_API_URL). */
const API = (import.meta.env.VITE_API_URL as string | undefined) ?? "";

export async function gql<T>(query: string, variables?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(navigator.onLine ? "Kunde inte nå servern." : "Du är offline.");
  }
  if (res.status === 429) throw new Error(`För många förfrågningar – försök igen om ${res.headers.get("Retry-After") ?? "en stund"} s.`);
  if (!res.ok && !res.headers.get("content-type")?.includes("json")) throw new Error(`Serverfel (${res.status}).`);
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(body.errors[0]!.message);
  return body.data as T;
}

export interface Workplace {
  cfar: string;
  orgnr: string;
  name: string | null;
  organisationName: string | null;
  sni: string | null;
  sniTitle: string | null;
  sniSection: { letter: string; title: string } | null;
  sizeClass: string | null;
  distanceM: number | null;
  adBlock: boolean;
  location: { lat: number; lon: number } | null;
  visitAddress: { street: string | null; postcode: string | null; town: string | null };
}

export interface NearResult {
  workplacesNear: { items: Workplace[]; nextCursor: string | null; totalEstimate: number | null; center: { lat: number; lon: number } | null; attribution: string[] };
}

export const NEAR = `query Near($address: String, $point: PointInput, $radiusM: Int, $sni: [String!], $after: String) {
  workplacesNear(address: $address, point: $point, radiusM: $radiusM, sni: $sni, first: 50, after: $after) {
    items { cfar orgnr name organisationName sni sniTitle sniSection { letter title } sizeClass distanceM adBlock location { lat lon } visitAddress { street postcode town } }
    nextCursor totalEstimate center { lat lon } attribution
  }
}`;

export const AREA = `query Area($point: PointInput) {
  area(point: $point) { deso name kommun workplaceCount stats { label variable period value } attribution }
}`;

export const ORG = `query Org($orgnr: ID!) {
  organisation(orgnr: $orgnr) {
    orgnrFormatted name legalForm status registeredAt businessDescription sniPrimary sniTitle sniSection { letter title } adBlock
    postAddress { street postcode town }
    sources { name publisher attribution }
    annualReports { periodEnd downloadPath }
    workplaces(first: 20) { items { name visitAddress { street town } } }
  }
}`;

export const WATCH = `mutation Watch($email: String!, $kommun: String, $sniPrefix: String) {
  watchArea(email: $email, kommun: $kommun, sniPrefix: $sniPrefix) { accepted message }
}`;

/** Last results survive reloads and offline use; storage may be unavailable. */
export function remember(key: string, value: unknown) {
  try {
    localStorage.setItem(`od:${key}`, JSON.stringify(value));
  } catch {
    /* private mode or quota */
  }
}

export function recall<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(`od:${key}`);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export const GEOCODE = `query Geocode($q: String!) { geocode(address: $q, limit: 6) { addressId label location { lat lon } } }`;
export const SECTIONS = `{ sniSections { letter title } }`;
export interface Suggestion {
  addressId: string;
  label: string;
  location: { lat: number; lon: number } | null;
}
