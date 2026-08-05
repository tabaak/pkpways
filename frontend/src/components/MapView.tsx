'use client'

import 'leaflet/dist/leaflet.css'
import L from 'leaflet'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Circle,
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
import { useApp } from '@/app/providers'
import { getCarrier } from '@/lib/carriers'
import { routeCoords } from '@/lib/geo'
import {
  liveRailPositionAt,
  liveSegmentProgressAt,
  loadRailGeometry,
  splitStitchedRoute,
  type RailGeometryAsset,
} from '@/lib/railGeometry'
import { getTrainIdentity } from '@/lib/trainIdentity'
import type { LatLng, Theme, TrainLive } from '@/lib/types'
import { CanvasTrainLayer, type TrainHitTest } from './CanvasTrainLayer'
import { LocationIcon, TRAIN_PATH } from './icons'

const POLAND_CENTER: [number, number] = [52.1, 19.4]
/* Padded well past Poland's edges so the details panel (and other overlays)
   never trap content against the pan limit — eastern routes sit under the
   right-hand panel unless the map can be dragged further west. */
const POLAND_BOUNDS: [[number, number], [number, number]] = [
  [46.8, 9.6],
  [57.0, 30.0],
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

/** How often marker positions are recomputed, as a function of zoom.
 *  Interpolation is pure oversampling when zoomed out: at z6 a 100 km/h train
 *  advances ~0.05 px in 50 ms, so ticking every frame just burns a style write
 *  per train per tick for motion nobody can see. */
function frameIntervalForZoom(zoom: number): number {
  if (zoom >= 12) return 50
  if (zoom >= 10) return 100
  if (zoom >= 8) return 250
  return 500
}

const frameListeners = new Set<() => void>()
let frameIntervalMs = frameIntervalForZoom(6)
let frameRequest: number | null = null
let previousFrame = 0

function setFrameInterval(ms: number) {
  frameIntervalMs = ms
}

function runAnimationFrame(now: number) {
  if (now - previousFrame >= frameIntervalMs) {
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

function DebugOverlay({
  parseDurationMs,
  reducedMotion,
}: {
  parseDurationMs: number | null
  reducedMotion: boolean
}) {
  const [frameStats, setFrameStats] = useState({ fps: 0, markers: 0 })
  const [longTasks, setLongTasks] = useState<{
    supported: boolean
    count: number
    last: number
    max: number
  }>(() => ({
    supported:
      typeof PerformanceObserver !== 'undefined' &&
      PerformanceObserver.supportedEntryTypes?.includes('longtask'),
    count: 0,
    last: 0,
    max: 0,
  }))

  useEffect(() => {
    let frameCount = 0
    let sampledAt = performance.now()
    let requestId = 0

    const sample = (now: number) => {
      frameCount += 1
      const elapsed = now - sampledAt
      if (elapsed >= 1000) {
        setFrameStats({
          fps: Math.round((frameCount * 1000) / elapsed),
          markers:
            document.querySelectorAll('.train-marker-wrapper').length +
            Number(
              document
                .querySelector('.leaflet-train-canvas')
                ?.getAttribute('data-marker-count') ?? 0
            ),
        })
        frameCount = 0
        sampledAt = now
      }
      requestId = window.requestAnimationFrame(sample)
    }

    requestId = window.requestAnimationFrame(sample)
    return () => window.cancelAnimationFrame(requestId)
  }, [])

  useEffect(() => {
    if (!longTasks.supported) return

    const observer = new PerformanceObserver((list) => {
      const durations = list.getEntries().map((entry) => entry.duration)
      if (durations.length === 0) return
      const last = durations.at(-1) ?? 0
      const batchMax = Math.max(...durations)
      setLongTasks((current) => ({
        supported: true,
        count: current.count + durations.length,
        last,
        max: Math.max(current.max, batchMax),
      }))
    })
    observer.observe({ type: 'longtask', buffered: true })
    return () => observer.disconnect()
  }, [longTasks.supported])

  const tick = reducedMotion ? 'off' : `${frameIntervalMs} ms`
  const parse = parseDurationMs == null ? '—' : `${parseDurationMs.toFixed(1)} ms`
  const longTask = longTasks.supported === false
    ? 'unsupported'
    : longTasks.count === 0
      ? '—'
      : `${longTasks.last.toFixed(0)} / ${longTasks.max.toFixed(0)} ms`

  return (
    <aside
      aria-label="Performance diagnostics"
      className="pointer-events-none fixed top-[5.25rem] left-3 z-[2000] rounded-lg bg-slate-950/90 px-3 py-2 font-mono text-[11px] leading-5 text-slate-100 shadow-lg"
    >
      <div>FPS {frameStats.fps}</div>
      <div>markers {frameStats.markers}</div>
      <div>tick {tick}</div>
      <div>JSON.parse {parse}</div>
      <div>long last/max {longTask}</div>
      {longTasks.supported !== false && <div>long count {longTasks.count}</div>}
    </aside>
  )
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
  sampledAt,
  receivedAt,
}: {
  train: TrainLive
  railGeometry: RailGeometryAsset | null
  loading: boolean
  sampledAt: number
  receivedAt: number
}) {
  // Labels are noisy when zoomed out, so reveal them progressively: endpoints
  // first, then every intermediate stop once the user is zoomed in close.
  const map = useMap()
  const [zoom, setZoom] = useState(() => map.getZoom())
  useMapEvents({ zoomend: () => setZoom(map.getZoom()) })
  const showEndpointLabels = zoom >= 8
  const showAllLabels = zoom >= 11

  // Do not draw misleading station-to-station chords while the static railway
  // geometry is being fetched. The route appears as soon as it is ready.
  if (loading) return null
  const carrier = getCarrier(train.carrierId)
  const coords = routeCoords(train)
  const progress = liveSegmentProgressAt(train, receivedAt - sampledAt)
  const { traveled, remaining } = splitStitchedRoute(
    train,
    railGeometry,
    progress
  )
  const traveledPositions = traveled.map(
    (c) => [c.lat, c.lng] as [number, number]
  )
  const remainingPositions = remaining.map(
    (c) => [c.lat, c.lng] as [number, number]
  )

  return (
    <>
      {/* The train marker is the boundary between the carrier-colored traveled
          route and the lower-emphasis grey route still ahead. */}
      {remainingPositions.length > 1 && (
        <>
          <Polyline
            positions={remainingPositions}
            pathOptions={{ color: '#64748b', weight: 9, opacity: 0.16 }}
          />
          <Polyline
            positions={remainingPositions}
            pathOptions={{ color: '#64748b', weight: 3.5, opacity: 0.72 }}
          />
        </>
      )}
      {traveledPositions.length > 1 && (
        <>
          <Polyline
            positions={traveledPositions}
            pathOptions={{ color: carrier.color, weight: 9, opacity: 0.18 }}
          />
          <Polyline
            positions={traveledPositions}
            pathOptions={{ color: carrier.color, weight: 3.5, opacity: 0.95 }}
          />
        </>
      )}
      {coords.map((c, i) => {
        const isEndpoint = i === 0 || i === coords.length - 1
        const passed = i <= train.fromIndex
        const showLabel = isEndpoint ? showEndpointLabels : showAllLabels
        return (
          <CircleMarker
            key={`${train.stops[i].stationId}:${i}`}
            center={[c.lat, c.lng]}
            radius={isEndpoint ? 5 : 3.5}
            pathOptions={{
              color: '#ffffff',
              weight: 2,
              fillColor: passed ? carrier.color : '#64748b',
              fillOpacity: 1,
            }}
          >
            {showLabel && (
              <Tooltip
                permanent
                interactive={false}
                direction="top"
                offset={[0, isEndpoint ? -6 : -5]}
                className={`station-label${isEndpoint ? ' station-label--endpoint' : ''}`}
              >
                {train.stops[i].name}
              </Tooltip>
            )}
          </CircleMarker>
        )
      })}
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
function MapEffects({
  hitTestRef,
  onMapClick,
}: {
  hitTestRef: React.MutableRefObject<TrainHitTest | null>
  onMapClick: (id: string | null) => void
}) {
  const map = useMap()
  useEffect(() => {
    // A tick after mount avoids a mis-sized map in some layout timings.
    const id = setTimeout(() => map.invalidateSize(), 60)
    return () => clearTimeout(id)
  }, [map])

  useMapEvents({
    click: (event) =>
      onMapClick(hitTestRef.current?.(event.containerPoint) ?? null),
    zoomend: () => setFrameInterval(frameIntervalForZoom(map.getZoom())),
  })
  return null
}

type LocationStatus = 'idle' | 'locating' | 'active' | 'error'

/**
 * Devices answer the first geolocation callback with a coarse Wi-Fi/cell
 * estimate and only converge onto GNSS over the next few seconds, so we keep
 * watching until the fix is this good or the window below runs out.
 */
const GOOD_ACCURACY_M = 15
const CONVERGENCE_WINDOW_MS = 30_000

/** Quiet right-side GPS control and the user's last resolved browser position. */
function LocationControl({
  reducedMotion,
  hidden,
}: {
  reducedMotion: boolean
  hidden: boolean
}) {
  const map = useMap()
  const { t } = useApp()
  const [container, setContainer] = useState<HTMLElement | null>(null)
  const [position, setPosition] = useState<{
    lat: number
    lng: number
    accuracy: number
  } | null>(null)
  const [status, setStatus] = useState<LocationStatus>('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const watchRef = useRef<number | null>(null)
  const windowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const bestAccuracyRef = useRef(Infinity)

  const stopWatching = () => {
    if (watchRef.current !== null) {
      navigator.geolocation.clearWatch(watchRef.current)
      watchRef.current = null
    }
    if (windowTimerRef.current !== null) {
      clearTimeout(windowTimerRef.current)
      windowTimerRef.current = null
    }
  }

  useEffect(() => stopWatching, [])

  useEffect(() => {
    const control = new L.Control({ position: 'bottomright' })
    control.onAdd = () => {
      const element = L.DomUtil.create('div', 'leaflet-control location-control')
      L.DomEvent.disableClickPropagation(element)
      L.DomEvent.disableScrollPropagation(element)
      setContainer(element)
      return element
    }
    control.addTo(map)

    return () => {
      control.remove()
    }
  }, [map])

  const locate = () => {
    if (!navigator.geolocation) {
      setStatus('error')
      setErrorMessage(t('locationUnavailable'))
      return
    }

    // Safari only exposes geolocation over HTTPS — it has no localhost
    // exemption like Chrome/Firefox — and rejects with PERMISSION_DENIED
    // without ever prompting. Report the real reason instead.
    if (!window.isSecureContext) {
      setStatus('error')
      setErrorMessage(t('locationInsecure'))
      return
    }

    // A second click restarts the convergence rather than stacking watches.
    stopWatching()
    bestAccuracyRef.current = Infinity
    setStatus('locating')
    setErrorMessage('')

    windowTimerRef.current = setTimeout(stopWatching, CONVERGENCE_WINDOW_MS)

    watchRef.current = navigator.geolocation.watchPosition(
      ({ coords }) => {
        // Later fixes are not monotonically better; ignore the ones that walk
        // accuracy backwards so the circle only ever tightens.
        if (coords.accuracy > bestAccuracyRef.current) return

        const isFirstFix = bestAccuracyRef.current === Infinity
        bestAccuracyRef.current = coords.accuracy
        setPosition({
          lat: coords.latitude,
          lng: coords.longitude,
          accuracy: coords.accuracy,
        })
        setStatus('active')

        // Only the first fix moves the viewport — re-flying on every refinement
        // would yank the map around while the user is reading it.
        if (isFirstFix) {
          const target: [number, number] = [coords.latitude, coords.longitude]
          const zoom = Math.max(map.getZoom(), 13)
          if (reducedMotion) map.setView(target, zoom)
          else map.flyTo(target, zoom, { duration: 0.9 })
        }

        if (coords.accuracy <= GOOD_ACCURACY_M) stopWatching()
      },
      (error) => {
        // Transient failures mid-convergence must not discard a fix we already
        // have; only report when we never got one.
        if (bestAccuracyRef.current !== Infinity) return
        stopWatching()
        setStatus('error')
        setErrorMessage(
          error.code === error.PERMISSION_DENIED
            ? t('locationDenied')
            : t('locationUnavailable')
        )
      },
      {
        enableHighAccuracy: true,
        timeout: CONVERGENCE_WINDOW_MS,
        maximumAge: 0,
      }
    )
  }

  const label = status === 'locating' ? t('locating') : t('locateMe')

  return (
    <>
      {container &&
        !hidden &&
        createPortal(
          <>
            <button
              type="button"
              className={`location-control__button${status === 'active' ? ' location-control__button--active' : ''}`}
              onClick={locate}
              disabled={status === 'locating'}
              aria-label={label}
              title={label}
            >
              <LocationIcon
                className={`h-[18px] w-[18px]${status === 'locating' ? ' location-control__icon--locating' : ''}`}
              />
            </button>
            {errorMessage && (
              <p className="location-control__error" role="alert">
                {errorMessage}
              </p>
            )}
          </>,
          container
        )}

      {position && (
        <>
          <Circle
            center={[position.lat, position.lng]}
            radius={position.accuracy}
            interactive={false}
            pathOptions={{
              color: '#0284c7',
              fillColor: '#38bdf8',
              fillOpacity: 0.12,
              opacity: 0.35,
              weight: 1,
            }}
          />
          <CircleMarker
            center={[position.lat, position.lng]}
            radius={7}
            pathOptions={{
              color: '#ffffff',
              fillColor: '#0284c7',
              fillOpacity: 1,
              opacity: 1,
              weight: 3,
            }}
          >
            <Tooltip direction="top" offset={[0, -8]} opacity={1}>
              {t('yourLocation')}
            </Tooltip>
          </CircleMarker>
        </>
      )}
    </>
  )
}

export default function MapView({
  trains,
  sampledAt,
  receivedAt,
  parseDurationMs,
  selectedId,
  focusNonce,
  theme,
  onSelect,
}: {
  trains: TrainLive[]
  sampledAt: number
  receivedAt: number
  parseDurationMs: number | null
  selectedId: string | null
  focusNonce: number
  theme: Theme
  onSelect: (id: string | null) => void
}) {
  const tiles = TILES[theme]
  const reducedMotion = useReducedMotion()
  const hitTestRef = useRef<TrainHitTest | null>(null)
  const [debugEnabled] = useState(
    () => new URLSearchParams(window.location.search).get('debug') === '1'
  )
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

      <ZoomControl position="bottomleft" />
      <LocationControl reducedMotion={reducedMotion} hidden={Boolean(selected)} />
      <MapEffects hitTestRef={hitTestRef} onMapClick={onSelect} />
      {debugEnabled && (
        <DebugOverlay
          parseDurationMs={parseDurationMs}
          reducedMotion={reducedMotion}
        />
      )}
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
          sampledAt={sampledAt}
          receivedAt={receivedAt}
        />
      )}

      {/* A selected train is shown alone, so it never needs culling — and must
          stay visible even when the details panel has pushed it off-screen. */}
      {selected ? (
        <TrainMarker
          key={selected.id}
          train={selected}
          railGeometry={railGeometry}
          sampledAt={sampledAt}
          receivedAt={receivedAt}
          reducedMotion={reducedMotion}
          selected
          onSelect={onSelect}
        />
      ) : (
        <CanvasTrainLayer
          trains={trains}
          railGeometry={railGeometry}
          sampledAt={sampledAt}
          receivedAt={receivedAt}
          reducedMotion={reducedMotion}
          hitTestRef={hitTestRef}
        />
      )}
    </MapContainer>
  )
}
