'use client'

import 'leaflet/dist/leaflet.css'
import L from 'leaflet'
import { useEffect, useMemo } from 'react'
import {
  CircleMarker,
  MapContainer,
  Marker,
  Polyline,
  TileLayer,
  useMap,
  useMapEvents,
  ZoomControl,
} from 'react-leaflet'
import { getCarrier } from '@/lib/carriers'
import { routeCoords } from '@/lib/geo'
import type { Theme, TrainLive } from '@/lib/types'
import { TRAIN_PATH } from './icons'

const POLAND_CENTER: [number, number] = [52.1, 19.4]
const POLAND_BOUNDS: [[number, number], [number, number]] = [
  [48.6, 13.6],
  [55.2, 24.6],
]

const TILES: Record<Theme, { url: string; attribution: string }> = {
  light: {
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  },
  dark: {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  },
}

const TRAIN_SVG = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="${TRAIN_PATH}"/></svg>`

function buildTrainIcon(
  color: string,
  bearing: number,
  delay: number,
  selected: boolean
): L.DivIcon {
  const html = `
    <div class="train-marker ${selected ? 'train-marker--selected' : ''}" style="--c:${color}">
      <div class="train-marker__dir" style="transform: rotate(${bearing}deg)"></div>
      <div class="train-marker__body">${TRAIN_SVG}</div>
      ${delay > 0 ? `<span class="train-marker__delay">+${delay}</span>` : ''}
    </div>`
  return L.divIcon({
    html,
    className: 'train-marker-wrapper',
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    popupAnchor: [0, -18],
  })
}

/** One live train marker. Memoizes its icon so position ticks don't rebuild
 *  the DOM (which would interrupt hover/pulse animations). */
function TrainMarker({
  train,
  selected,
  onSelect,
}: {
  train: TrainLive
  selected: boolean
  onSelect: (id: string) => void
}) {
  const carrier = getCarrier(train.carrierId)
  // Round the heading so the icon only rebuilds on a meaningful turn.
  const roundedBearing = Math.round(train.bearing / 5) * 5

  const icon = useMemo(
    () => buildTrainIcon(carrier.color, roundedBearing, train.delay, selected),
    [carrier.color, roundedBearing, train.delay, selected]
  )

  return (
    <Marker
      position={[train.position.lat, train.position.lng]}
      icon={icon}
      zIndexOffset={selected ? 1000 : 0}
      eventHandlers={{ click: () => onSelect(train.id) }}
    />
  )
}

/** The route polyline + station dots for the selected train. */
function SelectedRoute({ train }: { train: TrainLive }) {
  const carrier = getCarrier(train.carrierId)
  const coords = routeCoords(train)
  const positions = coords.map((c) => [c.lat, c.lng] as [number, number])

  return (
    <>
      {/* Soft casing under the line */}
      <Polyline
        positions={positions}
        pathOptions={{ color: carrier.color, weight: 9, opacity: 0.18 }}
      />
      <Polyline
        positions={positions}
        pathOptions={{ color: carrier.color, weight: 3.5, opacity: 0.95 }}
      />
      {coords.map((c, i) => (
        <CircleMarker
          key={train.stops[i].stationId}
          center={[c.lat, c.lng]}
          radius={i === 0 || i === coords.length - 1 ? 5 : 3.5}
          pathOptions={{
            color: '#ffffff',
            weight: 2,
            fillColor: carrier.color,
            fillOpacity: 1,
          }}
        />
      ))}
    </>
  )
}

/** Reacts to theme change / mount to keep Leaflet sized correctly. */
function MapEffects({ onBackgroundClick }: { onBackgroundClick: () => void }) {
  const map = useMap()
  useEffect(() => {
    // A tick after mount avoids a mis-sized map in some layout timings.
    const id = setTimeout(() => map.invalidateSize(), 60)
    return () => clearTimeout(id)
  }, [map])

  useMapEvents({
    click: () => onBackgroundClick(),
  })
  return null
}

export default function MapView({
  trains,
  selectedId,
  theme,
  onSelect,
}: {
  trains: TrainLive[]
  selectedId: string | null
  theme: Theme
  onSelect: (id: string | null) => void
}) {
  const tiles = TILES[theme]
  const selected = trains.find((t) => t.id === selectedId) ?? null

  return (
    <MapContainer
      center={POLAND_CENTER}
      zoom={6}
      minZoom={5}
      maxZoom={12}
      zoomControl={false}
      maxBounds={POLAND_BOUNDS}
      maxBoundsViscosity={0.9}
      className="h-full w-full"
    >
      {/* Keyed by theme so tiles swap cleanly on toggle. */}
      <TileLayer
        key={theme}
        url={tiles.url}
        attribution={tiles.attribution}
        subdomains="abcd"
        maxZoom={20}
      />

      <ZoomControl position="bottomright" />
      <MapEffects onBackgroundClick={() => onSelect(null)} />

      {selected && <SelectedRoute train={selected} />}

      {trains.map((train) => (
        <TrainMarker
          key={train.id}
          train={train}
          selected={train.id === selectedId}
          onSelect={onSelect}
        />
      ))}
    </MapContainer>
  )
}
