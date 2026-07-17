import type { Carrier, CarrierId } from './types'

// Color-coded carriers, per the README design philosophy
// ("PKP IC = blue, Polregio = red, etc."). Colors are chosen to stay
// distinguishable on the map; operators that share a hue are geographically
// separate so on-map confusion is minimal.
export const CARRIERS: Record<CarrierId, Carrier> = {
  IC: { id: 'IC', code: 'IC', name: 'PKP Intercity', color: '#2563eb' },
  EIP: { id: 'EIP', code: 'EIP', name: 'PKP Intercity Premium (Pendolino)', color: '#7c3aed' },
  POL: { id: 'POL', code: 'PR', name: 'Polregio', color: '#e11d48' },
  KM: { id: 'KM', code: 'KM', name: 'Koleje Mazowieckie', color: '#d97706' },
  SKM: { id: 'SKM', code: 'SKM', name: 'Szybka Kolej Miejska', color: '#0891b2' },
  SKMT: { id: 'SKMT', code: 'SKMT', name: 'SKM Trójmiasto', color: '#0d9488' },
  KD: { id: 'KD', code: 'KD', name: 'Koleje Dolnośląskie', color: '#16a34a' },
  KS: { id: 'KS', code: 'KŚ', name: 'Koleje Śląskie', color: '#ea580c' },
  KML: { id: 'KML', code: 'KMŁ', name: 'Koleje Małopolskie', color: '#0ea5e9' },
  KW: { id: 'KW', code: 'KW', name: 'Koleje Wielkopolskie', color: '#db2777' },
  LKA: { id: 'LKA', code: 'ŁKA', name: 'Łódzka Kolej Aglomeracyjna', color: '#65a30d' },
  WKD: { id: 'WKD', code: 'WKD', name: 'Warszawska Kolej Dojazdowa', color: '#4338ca' },
  ARRIVA: { id: 'ARRIVA', code: 'AR', name: 'Arriva RP', color: '#14b8a6' },
  LEO: { id: 'LEO', code: 'LEO', name: 'Leo Express', color: '#1e293b' },
  RJ: { id: 'RJ', code: 'RJ', name: 'RegioJet', color: '#eab308' },
  RP: { id: 'RP', code: 'RP', name: 'Railpolonia', color: '#a21caf' },
  ODEG: { id: 'ODEG', code: 'ODEG', name: 'Ostdeutsche Eisenbahn', color: '#b91c1c' },
  CARGO: { id: 'CARGO', code: 'CARGO', name: 'PKP Cargo', color: '#57534e' },
  SKPL: { id: 'SKPL', code: 'SKPL', name: 'SKPL Cargo', color: '#78716c' },
  PARWOL: { id: 'PARWOL', code: 'PW', name: 'Parowozownia Wolsztyn', color: '#78350f' },
  OTHER: { id: 'OTHER', code: '—', name: 'Inny przewoźnik', color: '#64748b' },
}

export function getCarrier(id: CarrierId): Carrier {
  return CARRIERS[id] ?? CARRIERS.OTHER
}

// Exact map from the API's `carrierCode` (see /schedules `dictionaries.carriers`)
// to our branded id. Keys are UPPER-CASED because we upper-case the incoming
// code before lookup. Several real-world codes alias to the same operator
// (e.g. "SKM_3M" is the legacy code for "SKMT"; "20" is the funding authority
// behind Koleje Małopolskie).
const CODE_TO_CARRIER: Record<string, CarrierId> = {
  IC: 'IC',
  PR: 'POL',
  KM: 'KM',
  SKM: 'SKM',
  SKMT: 'SKMT',
  SKM_3M: 'SKMT',
  KD: 'KD',
  KS: 'KS',
  KMŁ: 'KML',
  '20': 'KML',
  KW: 'KW',
  ŁKA: 'LKA',
  WKD: 'WKD',
  AR: 'ARRIVA',
  LEO: 'LEO',
  'LEO EXPRESS': 'LEO',
  RJ: 'RJ',
  RP: 'RP',
  ODEG: 'ODEG',
  CARGO: 'CARGO',
  SKPL: 'SKPL',
  'PAR-WOL': 'PARWOL',
}

/**
 * Resolve the branded carrier from the raw PKP fields. `carrierCode` is the
 * short operator code from /schedules (e.g. "PR", "KM", "SKM_3M") — matched
 * exactly against the API's `dictionaries.carriers`. `category` is the
 * commercialCategorySymbol (e.g. "EIP", "IC", "R7"). Best-effort — falls back
 * to OTHER so an unknown/new operator still renders (neutral grey).
 */
export function resolveCarrierId(
  carrierCode: string | null | undefined,
  category: string | null | undefined
): CarrierId {
  const cat = (category ?? '').toUpperCase()
  // Premium Pendolino is a distinct brand regardless of the carrier string
  // (PKP Intercity operates it under carrierCode "IC").
  if (cat === 'EIP') return 'EIP'

  const code = (carrierCode ?? '').toUpperCase()
  const mapped = CODE_TO_CARRIER[code]
  if (mapped) return mapped

  // No carrier match — fall back to the service category for the big operators
  // (covers rare rows with a missing/garbled carrierCode).
  if (['IC', 'EIC', 'TLK', 'EN', 'EC'].includes(cat)) return 'IC'

  return 'OTHER'
}
