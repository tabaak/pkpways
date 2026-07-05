import type { Lang } from './types'

// Bilingual copy (PL/EN) per the README "Full PL/EN language toggle" feature.
const DICT = {
  appName: { pl: 'PkpWays', en: 'PkpWays' },
  tagline: {
    pl: 'Mapa kolei w Polsce na żywo',
    en: 'Live Polish railway map',
  },
  liveTrains: { pl: 'Pociągi na żywo', en: 'Live trains' },
  onTime: { pl: 'Punktualnie', en: 'On time' },
  delayed: { pl: 'Opóźnienie', en: 'Delayed' },
  min: { pl: 'min', en: 'min' },
  route: { pl: 'Trasa', en: 'Route' },
  stops: { pl: 'Stacje', en: 'Stops' },
  carrier: { pl: 'Przewoźnik', en: 'Carrier' },
  arrival: { pl: 'Przyjazd', en: 'Arrival' },
  departure: { pl: 'Odjazd', en: 'Departure' },
  currentlyBetween: { pl: 'Obecnie między', en: 'Currently between' },
  and: { pl: 'a', en: 'and' },
  nextStop: { pl: 'Następny przystanek', en: 'Next stop' },
  origin: { pl: 'Stacja początkowa', en: 'Origin' },
  destination: { pl: 'Stacja docelowa', en: 'Destination' },
  selectHint: {
    pl: 'Kliknij pociąg na mapie, aby zobaczyć szczegóły',
    en: 'Click a train on the map to see details',
  },
  close: { pl: 'Zamknij', en: 'Close' },
  lightMode: { pl: 'Jasny motyw', en: 'Light mode' },
  darkMode: { pl: 'Ciemny motyw', en: 'Dark mode' },
  trainsRunning: { pl: 'w ruchu', en: 'running' },
  noLiveData: {
    pl: 'Brak danych o pociągach na żywo',
    en: 'No live train data yet',
  },
} as const

export type I18nKey = keyof typeof DICT

export function makeT(lang: Lang) {
  return (key: I18nKey): string => DICT[key][lang]
}
