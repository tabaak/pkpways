import type { Carrier, CarrierId } from './types'

// Color-coded carriers, per the README design philosophy
// ("PKP IC = blue, Polregio = red, etc.").
export const CARRIERS: Record<CarrierId, Carrier> = {
  IC: { id: 'IC', code: 'IC', name: 'PKP Intercity', color: '#2563eb' },
  EIP: { id: 'EIP', code: 'EIP', name: 'PKP Intercity Premium (Pendolino)', color: '#7c3aed' },
  POL: { id: 'POL', code: 'POL', name: 'Polregio', color: '#e11d48' },
  KM: { id: 'KM', code: 'KM', name: 'Koleje Mazowieckie', color: '#d97706' },
  SKM: { id: 'SKM', code: 'SKM', name: 'SKM Trójmiasto', color: '#0891b2' },
  KD: { id: 'KD', code: 'KD', name: 'Koleje Dolnośląskie', color: '#16a34a' },
  KS: { id: 'KS', code: 'KŚ', name: 'Koleje Śląskie', color: '#ea580c' },
}

export function getCarrier(id: CarrierId): Carrier {
  return CARRIERS[id]
}
