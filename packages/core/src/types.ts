export interface PostalAddress {
  street?: string | null;
  postcode?: string | null;
  town?: string | null;
}

export interface OrganisationRecord {
  orgnr: string;
  name: string;
  legalForm?: string | null;
  legalFormCode?: string | null;
  status?: "active" | "inactive" | "deregistered" | "unknown";
  registeredAt?: string | null;
  deregisteredAt?: string | null;
  deregistrationReason?: string | null;
  businessDescription?: string | null;
  post?: PostalAddress;
  sniPrimary?: string | null;
  sniCodes?: string[] | null;
  adBlock?: boolean;
  source: SourceId;
  sourceDate: string;
  /** Classification inputs (not stored). */
  jurform?: string | null;
  bvForm?: string | null;
  idType?: string | null;
}

export interface WorkplaceRecord {
  cfar: number;
  orgnr: string;
  name?: string | null;
  sni?: string | null;
  sniDivision?: string | null;
  sizeClass?: string | null;
  status?: string | null;
  visit?: PostalAddress;
  kommun?: string | null;
  lan?: string | null;
  post?: PostalAddress;
  adBlock?: boolean;
  sourceDate: string;
  /** The legal unit's SCB jurform, for classification. */
  jurform?: string | null;
}

export interface AddressRecord {
  addressId: string;
  street: string;
  number?: string | null;
  letter?: string | null;
  postcode?: string | null;
  town?: string | null;
  kommun?: string | null;
  lat: number;
  lon: number;
  deso?: string | null;
  sourceDate: string;
}

export interface AreaRecord {
  deso: string;
  regso?: string | null;
  kommun?: string | null;
  name?: string | null;
  lat?: number | null;
  lon?: number | null;
  bbox?: [number, number, number, number] | null;
  geometryKey?: string | null;
}

export interface AreaStatRecord {
  deso: string;
  tableId: string;
  variable: string;
  label?: string | null;
  period: string;
  value: number | null;
}

export interface AnnualReportRecord {
  documentId: string;
  orgnr: string;
  periodEnd?: string | null;
  registeredAt?: string | null;
  format?: string | null;
  objectKey?: string | null;
  sha256?: string | null;
  sizeBytes?: number | null;
}

export type SourceId = "scb-fr" | "bolagsverket-hvd" | "lantmateriet-adress" | "scb-px" | "scb-deso" | "fixture";
