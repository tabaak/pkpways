import type { Station } from './types'

// Real Polish railway stations with approximate coordinates. Enough coverage
// to draw believable cross-country routes for the mock trains.
export const STATIONS: Record<string, Station> = {
  waw: { id: 'waw', name: 'Warszawa Centralna', lat: 52.2288, lng: 21.0030 },
  krk: { id: 'krk', name: 'Kraków Główny', lat: 50.0679, lng: 19.9450 },
  gda: { id: 'gda', name: 'Gdańsk Główny', lat: 54.3559, lng: 18.6447 },
  gdy: { id: 'gdy', name: 'Gdynia Główna', lat: 54.5175, lng: 18.5400 },
  wro: { id: 'wro', name: 'Wrocław Główny', lat: 51.0989, lng: 17.0369 },
  poz: { id: 'poz', name: 'Poznań Główny', lat: 52.4020, lng: 16.9124 },
  lod: { id: 'lod', name: 'Łódź Fabryczna', lat: 51.7508, lng: 19.4620 },
  kat: { id: 'kat', name: 'Katowice', lat: 50.2578, lng: 19.0166 },
  szc: { id: 'szc', name: 'Szczecin Główny', lat: 53.4256, lng: 14.5528 },
  lub: { id: 'lub', name: 'Lublin', lat: 51.2337, lng: 22.5686 },
  bia: { id: 'bia', name: 'Białystok', lat: 53.1340, lng: 23.1360 },
  byd: { id: 'byd', name: 'Bydgoszcz Główna', lat: 53.1348, lng: 18.0084 },
  rze: { id: 'rze', name: 'Rzeszów Główny', lat: 50.0410, lng: 21.9990 },
  ols: { id: 'ols', name: 'Olsztyn Główny', lat: 53.7784, lng: 20.4870 },
  tor: { id: 'tor', name: 'Toruń Główny', lat: 53.0110, lng: 18.5960 },
  czt: { id: 'czt', name: 'Częstochowa', lat: 50.8118, lng: 19.1203 },
  kie: { id: 'kie', name: 'Kielce', lat: 50.8830, lng: 20.6300 },
  opo: { id: 'opo', name: 'Opole Główne', lat: 50.6675, lng: 17.9200 },
  rad: { id: 'rad', name: 'Radom', lat: 51.4030, lng: 21.1470 },
  zak: { id: 'zak', name: 'Zakopane', lat: 49.2990, lng: 19.9500 },
}

export function getStation(id: string): Station {
  const s = STATIONS[id]
  if (!s) throw new Error(`Unknown station: ${id}`)
  return s
}
