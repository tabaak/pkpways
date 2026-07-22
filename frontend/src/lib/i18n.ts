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
  showDetails: { pl: 'Pokaż trasę', en: 'Show route' },
  hideDetails: { pl: 'Ukryj trasę', en: 'Hide route' },
  lightMode: { pl: 'Jasny motyw', en: 'Light mode' },
  darkMode: { pl: 'Ciemny motyw', en: 'Dark mode' },
  trainsRunning: { pl: 'w ruchu', en: 'running' },
  noLiveData: {
    pl: 'Brak danych o pociągach na żywo',
    en: 'No live train data yet',
  },
  loadingTrains: {
    pl: 'Ładowanie pociągów na żywo',
    en: 'Loading live trains',
  },
  locateMe: { pl: 'Pokaż moją lokalizację', en: 'Show my location' },
  locating: { pl: 'Ustalanie lokalizacji', en: 'Finding your location' },
  yourLocation: { pl: 'Twoja lokalizacja', en: 'Your location' },
  locationDenied: {
    pl: 'Zezwól przeglądarce na dostęp do lokalizacji.',
    en: 'Allow location access in your browser.',
  },
  locationUnavailable: {
    pl: 'Nie udało się ustalić lokalizacji.',
    en: 'Unable to find your location.',
  },
  aboutLabel: { pl: 'O danych', en: 'About the data' },
  disclaimerTitle: {
    pl: 'Skąd pochodzą pozycje pociągów',
    en: 'Where the train positions come from',
  },
  disclaimerBody: {
    pl: 'Pozycje pociągów na mapie nie pochodzą z GPS. Są teoretycznym oszacowaniem wyliczonym z rozkładu jazdy i raportowanych opóźnień — pokazujemy, gdzie pociąg powinien się znajdować w danej chwili.',
    en: 'Train positions on this map do not come from onboard GPS. They are a theoretical estimate calculated from the timetable and reported delays — we show where a train should be at a given moment.',
  },
  disclaimerNote: {
    pl: 'Rzeczywiste położenie pociągu może się różnić. Nie korzystaj z tych danych do planowania przesiadek ani w sytuacjach krytycznych.',
    en: 'The real position may differ. Do not rely on this data for catching connections or in critical situations.',
  },
  gotIt: { pl: 'Rozumiem', en: 'Got it' },
  searchLabel: { pl: 'Szukaj pociągu', en: 'Search train' },
  searchPlaceholder: {
    pl: 'Szukaj numeru pociągu…',
    en: 'Search train number…',
  },
  clearSearch: { pl: 'Wyczyść', en: 'Clear' },
  noResults: { pl: 'Nie znaleziono pociągu', en: 'No matching train' },
  noResultsHint: {
    pl: 'Sprawdź numer lub kategorię, np. „IC 3512” lub „S2”.',
    en: 'Check the number or category, e.g. “IC 3512” or “S2”.',
  },
} as const

export type I18nKey = keyof typeof DICT

export function makeT(lang: Lang) {
  return (key: I18nKey): string => DICT[key][lang]
}
