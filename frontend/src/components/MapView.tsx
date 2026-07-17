'use client'

import 'leaflet/dist/leaflet.css'
import L from 'leaflet'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CircleMarker,
  MapContainer,
  Marker,
  Polyline,
  TileLayer,
  Tooltip,
  useMap,
  useMapEvents,
  ZoomControl,
} from 'react-leaflet'
import { getCarrier } from '@/lib/carriers'
import { routeCoords } from '@/lib/geo'
import { liveRailPositionAt, loadRailGeometry, stitchedRoute, type RailGeometryAsset } from '@/lib/railGeometry'
import { getTrainIdentity } from '@/lib/trainIdentity'
import type { LatLng, Theme, TrainLive } from '@/lib/types'
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

const FRAME_INTERVAL_MS = 50
const frameListeners = new Set<() => void>()
let frameRequest: number | null = null
let previousFrame = 0

function runAnimationFrame(now: number) {
  if (now - previousFrame >= FRAME_INTERVAL_MS) {
    previousFrame = now
    frameListeners.forEach((listener) => listener())
  }
  frameRequest = frameListeners.size > 0 ? window.requestAnimationFrame(runAnimationFrame) : null
}

function subscribeToAnimationFrame(listener: () => void): () => void {
  frameListeners.add(listener)
  if (frameRequest == null) frameRequest = window.requestAnimationFrame(runAnimationFrame)
  return () => {
    frameListeners.delete(listener)
    if (frameListeners.size === 0 && frameRequest != null) {
      window.cancelAnimationFrame(frameRequest)
      frameRequest = null
    }
  }
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return reduced
}

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
  railGeometry,
  sampledAt,
  receivedAt,
  reducedMotion,
  selected,
  onSelect,
}: {
  train: TrainLive
  railGeometry: RailGeometryAsset | null
  sampledAt: number
  receivedAt: number
  reducedMotion: boolean
  selected: boolean
  onSelect: (id: string) => void
}) {
  const carrier = getCarrier(train.carrierId)
  const identity = getTrainIdentity(train)
  const accessibleLabel = [identity.primary, identity.secondary, carrier.name]
    .filter(Boolean)
    .join(', ')
  const markerRef = useRef<L.Marker>(null)
  const rendered = useMemo(
    () => liveRailPositionAt(train, railGeometry, receivedAt - sampledAt),
    [railGeometry, receivedAt, sampledAt, train]
  )

  useEffect(() => {
    markerRef.current?.getElement()?.setAttribute('aria-label', accessibleLabel)
  }, [accessibleLabel])

  useEffect(() => {
    const marker = markerRef.current
    if (!marker) return

    let lastBearing = Number.NaN
    const updatePosition = () => {
      const next = liveRailPositionAt(train, railGeometry, Date.now() - sampledAt)
      marker.setLatLng([next.position.lat, next.position.lng])
      const rounded = Math.round(next.bearing / 2) * 2
      if (rounded !== lastBearing) {
        const pointer = marker.getElement()?.querySelector<HTMLElement>('.train-marker__dir')
        if (pointer) pointer.style.transform = `rotate(${rounded}deg)`
        lastBearing = rounded
      }
    }

    updatePosition()
    if (reducedMotion) return
    return subscribeToAnimationFrame(updatePosition)
  }, [railGeometry, reducedMotion, sampledAt, train])
  // Round the heading so the icon only rebuilds on a meaningful turn.
  const roundedBearing = Math.round(rendered.bearing / 5) * 5

  const icon = useMemo(
    () => buildTrainIcon(carrier.color, roundedBearing, train.delay, selected),
    [carrier.color, roundedBearing, train.delay, selected]
  )

  return (
    <Marker
      ref={markerRef}
      position={[rendered.position.lat, rendered.position.lng]}
      icon={icon}
      alt={accessibleLabel}
      zIndexOffset={selected ? 1000 : 0}
      eventHandlers={{ click: () => onSelect(train.id) }}
    >
      <Tooltip
        direction="top"
        offset={[0, -16]}
        opacity={1}
        className="train-tooltip"
      >
        <div className="min-w-28 max-w-56">
          <p className="truncate text-sm font-semibold tracking-tight text-slate-900 dark:text-white">
            {identity.primary}
          </p>
          <p className="mt-0.5 truncate text-[11px] font-medium text-slate-600 dark:text-slate-300">
            {[identity.secondary, carrier.name].filter(Boolean).join(' · ')}
          </p>
        </div>
      </Tooltip>
    </Marker>
  )
}

/** The route polyline + station dots for the selected train. */
function SelectedRoute({
  train,
  railGeometry,
  loading,
}: {
  train: TrainLive
  railGeometry: RailGeometryAsset | null
  loading: boolean
}) {
  // Do not draw misleading station-to-station chords while the static railway
  // geometry is being fetched. The route appears as soon as it is ready.
  if (loading) return null
  const carrier = getCarrier(train.carrierId)
  const coords = routeCoords(train)
  const routed = stitchedRoute(train, railGeometry)
  const positions = routed.map((c) => [c.lat, c.lng] as [number, number])

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

/** Pans/zooms the map to a train when it's picked from search. Keyed off a
 *  nonce so re-selecting the same train still re-centers. */
function MapFocus({
  target,
  nonce,
  reducedMotion,
}: {
  target: LatLng | null
  nonce: number
  reducedMotion: boolean
}) {
  const map = useMap()
  const lastNonce = useRef(0)

  useEffect(() => {
    if (nonce === 0 || nonce === lastNonce.current || !target) return
    lastNonce.current = nonce
    const zoom = Math.max(map.getZoom(), 9)
    if (reducedMotion) map.setView([target.lat, target.lng], zoom)
    else map.flyTo([target.lat, target.lng], zoom, { duration: 0.9 })
  }, [nonce, target, reducedMotion, map])

  return null
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
  sampledAt,
  receivedAt,
  selectedId,
  focusNonce,
  theme,
  onSelect,
}: {
  trains: TrainLive[]
  sampledAt: number
  receivedAt: number
  selectedId: string | null
  focusNonce: number
  theme: Theme
  onSelect: (id: string | null) => void
}) {
  const tiles = TILES[theme]
  const reducedMotion = useReducedMotion()
  const selected = trains.find((t) => t.id === selectedId) ?? null
  const [railGeometry, setRailGeometry] = useState<RailGeometryAsset | null>(null)
  const [railGeometryLoading, setRailGeometryLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    let attempts = 0
    const fetchGeometry = () => {
      loadRailGeometry().then((asset) => {
        if (cancelled) return
        if (asset || attempts >= 3) {
          setRailGeometry(asset)
          setRailGeometryLoading(false)
          return
        }
        attempts += 1
        window.setTimeout(fetchGeometry, 1500)
      })
    }
    fetchGeometry()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <MapContainer
      center={POLAND_CENTER}
      zoom={6}
      minZoom={5}
      maxZoom={14}
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
      <MapFocus
        target={selected ? selected.position : null}
        nonce={focusNonce}
        reducedMotion={reducedMotion}
      />

      {selected && (
        <SelectedRoute
          train={selected}
          railGeometry={railGeometry}
          loading={railGeometryLoading}
        />
      )}

      {(selected ? [selected] : trains).map((train) => (
        <TrainMarker
          key={train.id}
          train={train}
          railGeometry={railGeometry}
          sampledAt={sampledAt}
          receivedAt={receivedAt}
          reducedMotion={reducedMotion}
          selected={train.id === selectedId}
          onSelect={onSelect}
        />
      ))}
    </MapContainer>
  )
}
