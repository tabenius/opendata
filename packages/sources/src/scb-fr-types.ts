/** Shapes observed from apiafr.scb.se/v1. Everything optional except identities. */
export interface ScbAddress {
  coAdress?: string | null;
  gatuAdress?: string | null;
  postNr?: string | number | null;
  postOrt?: string | null;
}

export interface WorkplaceRow {
  cfarNr: number;
  peOrgNr: string;
  ben?: string | null;
  primarNaringsgren?: { andelProcent?: number; avdelningsKod?: string; naringsgren?: string; rangordning?: number } | null;
  postAdress?: ScbAddress | null;
  belagenhetsadress?: { bGatuAdress?: string | null; bPostNr?: string | number | null; bPostOrt?: string | null; kommun?: string | null; lan?: string | null } | null;
  aeStat?: number | string | null;
  anstKl?: number | string | null;
  reklamSparrTyp?: number | string | null;
  telefonSparrTyp?: number | string | null;
  epostSparrTyp?: number | string | null;
}

export interface LegalUnitRow {
  peOrgNr: string;
  jurform?: string | number | null;
  namn?: string | { namn?: string } | null;
  foretagsnamn?: string | null;
  jeStat?: number | string | null;
  postAdress?: ScbAddress | null;
  primarNaringsgren?: unknown;
  ng1?: string | null;
  reklamSparrTyp?: number | string | null;
}
