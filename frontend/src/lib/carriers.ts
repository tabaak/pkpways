import type { Carrier, CarrierId } from './types'

// Color-coded carriers, per the README design philosophy
// ("PKP IC = blue, Polregio = red, etc.").
export const CARRIERS: Record<CarrierId, Carrier> = {
  IC: { id: 'IC', code: 'IC', name: 'PKP Intercity', color: '#2563eb' },
  EIP: { id: 'EIP', code: 'EIP', name: 'PKP Intercity Premium (Pendolino)', color: '#7c3aed' },
  POL: { id: 'POL', code: 'POL', name: 'Polregio', color: '#e11d48' },
  KM: { id: 'KM', code: 'KM', name: 'Koleje Mazowieckie', color: '#d97706' },
  SKM: { id: 'SKM', code: 'SKM', name: 'Szybka Kolej Miejska', color: '#0891b2' },
  KD: { id: 'KD', code: 'KD', name: 'Koleje Dolnośląskie', color: '#16a34a' },
  KS: { id: 'KS', code: 'KŚ', name: 'Koleje Śląskie', color: '#ea580c' },
  OTHER: { id: 'OTHER', code: '—', name: 'Inny przewoźnik', color: '#64748b' },
}

export function getCarrier(id: CarrierId): Carrier {
  return CARRIERS[id] ?? CARRIERS.OTHER
}

/**
 * Resolve the branded carrier from the raw PKP fields. `carrierCode` comes from
 * /schedules (e.g. "PKP INTERCITY", "POLREGIO", "KM"); `category` is the
 * commercialCategorySymbol (e.g. "EIP", "IC", "TLK", "R"). Best-effort — falls
 * back to OTHER so an unknown operator still renders (neutral grey).
 */
export function resolveCarrierId(
  carrierCode: string | null | undefined,
  category: string | null | undefined
): CarrierId {
  const cat = (category ?? '').toUpperCase()
  // Premium Pendolino is a distinct brand regardless of the carrier string.
  if (cat === 'EIP') return 'EIP'

  const code = (carrierCode ?? '').toUpperCase()
  if (code.includes('POLREGIO') || code === 'POL') return 'POL'
  if (code.includes('MAZOWIECKIE') || code === 'KM') return 'KM'
  if (code.includes('DOLNOŚLĄSKIE') || code.includes('DOLNOSLASKIE') || code === 'KD') return 'KD'
  if (code.includes('ŚLĄSKIE') || code.includes('SLASKIE') || code === 'KŚ' || code === 'KS') return 'KS'
  if (code.includes('SKM')) return 'SKM'
  if (code.includes('INTERCITY') || code === 'IC') return 'IC'

  // No carrier match — fall back to the service category for the big operators.
  if (['IC', 'EIC', 'TLK', 'EN', 'EC'].includes(cat)) return 'IC'

  return 'OTHER'
}
