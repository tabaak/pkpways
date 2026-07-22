'use client'

import L from 'leaflet'
import { useEffect, useRef } from 'react'
import { useMap } from 'react-leaflet'
import { useApp } from '@/app/providers'
import { getCarrier } from '@/lib/carriers'
import {
  liveRailPositionAt,
  type RailGeometryAsset,
} from '@/lib/railGeometry'
import { getTrainIdentity } from '@/lib/trainIdentity'
import type { TrainLive } from '@/lib/types'
import { TRAIN_PATH } from './icons'

export type TrainHitTest = (point: L.Point) => string | null

type CanvasTrainLayerProps = {
  trains: TrainLive[]
  railGeometry: RailGeometryAsset | null
  sampledAt: number
  receivedAt: number
  reducedMotion: boolean
  hitTestRef: React.MutableRefObject<TrainHitTest | null>
}

type RenderedTrain = {
  train: TrainLive
  position: { lat: number; lng: number }
  bearing: number
  point: L.Point | null
}

type ZoomAnimationEvent = L.LeafletEvent & {
  center: L.LatLng
  zoom: number
}

const MARKER_RADIUS = 17
const TOUCH_RADIUS = 22
const ZOOM_ANIMATION_MS = 250

function zoomEase(progress: number): number {
  // Leaflet uses cubic-bezier(0, 0, 0.25, 1) for its 250ms zoom transition.
  // Solve the curve's x value, then return y so marker positions follow tiles.
  let low = 0
  let high = 1
  let t = progress
  for (let i = 0; i < 10; i += 1) {
    t = (low + high) / 2
    const x = 0.75 * t * t + 0.25 * t * t * t
    if (x < progress) low = t
    else high = t
  }
  return 3 * t * t - 2 * t * t * t
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  const r = Math.min(radius, width / 2, height / 2)
  context.beginPath()
  context.moveTo(x + r, y)
  context.arcTo(x + width, y, x + width, y + height, r)
  context.arcTo(x + width, y + height, x, y + height, r)
  context.arcTo(x, y + height, x, y, r)
  context.arcTo(x, y, x + width, y, r)
  context.closePath()
}

function drawTrain(
  context: CanvasRenderingContext2D,
  rendered: RenderedTrain,
  point: L.Point,
  trainIconPath: Path2D,
  dark: boolean
) {
  const carrier = getCarrier(rendered.train.carrierId)
  const bearing = (rendered.bearing * Math.PI) / 180

  context.save()
  context.translate(point.x, point.y)

  context.rotate(bearing)
  context.fillStyle = 'rgba(0, 0, 0, 0.3)'
  context.beginPath()
  context.moveTo(0, -21)
  context.lineTo(-6, -12)
  context.lineTo(6, -12)
  context.closePath()
  context.fill()
  context.fillStyle = carrier.color
  context.beginPath()
  context.moveTo(0, -22)
  context.lineTo(-6, -13)
  context.lineTo(6, -13)
  context.closePath()
  context.fill()
  context.restore()

  // Match the old 26px border-box marker: 13px outer radius, 2px border,
  // 11px carrier-colored interior. Drawing the border as a separate disc
  // avoids Canvas strokes extending beyond the intended size.
  context.beginPath()
  context.fillStyle = 'rgba(0, 0, 0, 0.35)'
  context.arc(point.x, point.y + 2, 12.5, 0, Math.PI * 2)
  context.fill()

  // CSS paints a translucent border over the element's carrier-colored
  // background, so the ring retains a subtle tint from the train color.
  context.beginPath()
  context.fillStyle = carrier.color
  context.arc(point.x, point.y, 13, 0, Math.PI * 2)
  context.fill()

  context.beginPath()
  context.fillStyle = dark
    ? 'rgba(255, 255, 255, 0.78)'
    : 'rgba(255, 255, 255, 0.9)'
  context.arc(point.x, point.y, 13, 0, Math.PI * 2)
  context.fill()

  context.beginPath()
  context.fillStyle = carrier.color
  context.arc(point.x, point.y, 11, 0, Math.PI * 2)
  context.fill()

  context.save()
  context.translate(point.x - 7.5, point.y - 7.5)
  context.scale(15 / 24, 15 / 24)
  context.fillStyle = '#ffffff'
  context.fill(trainIconPath)
  context.restore()

  if (rendered.train.delay > 0) {
    const label = `+${rendered.train.delay}`
    context.font = '700 10px system-ui, sans-serif'
    const width = Math.max(16, context.measureText(label).width + 8)
    const x = point.x + 25 - width
    const y = point.y - 23
    roundedRect(context, x, y + 1, width, 16, 8)
    context.fillStyle = 'rgba(0, 0, 0, 0.32)'
    context.fill()
    roundedRect(context, x, y, width, 16, 8)
    context.fillStyle = '#ffffff'
    context.fill()
    roundedRect(context, x + 1.5, y + 1.5, width - 3, 13, 6.5)
    context.fillStyle = '#ef4444'
    context.fill()
    context.fillStyle = '#ffffff'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText(label, x + width / 2, y + 8)
  }
}

function hitTest(
  rendered: RenderedTrain[],
  point: L.Point,
  radius: number
): string | null {
  const radiusSquared = radius * radius
  let closest: { id: string; distance: number } | null = null

  for (const item of rendered) {
    if (!item.point) continue
    const dx = item.point.x - point.x
    const dy = item.point.y - point.y
    const distance = dx * dx + dy * dy
    if (distance <= radiusSquared && (!closest || distance < closest.distance)) {
      closest = { id: item.train.id, distance }
    }
  }

  return closest?.id ?? null
}

function tooltipContent(train: TrainLive): HTMLElement {
  const identity = getTrainIdentity(train)
  const carrier = getCarrier(train.carrierId)
  const content = document.createElement('div')
  content.className = 'min-w-28 max-w-56'

  const primary = document.createElement('p')
  primary.className = 'truncate text-sm font-semibold tracking-tight text-slate-900 dark:text-white'
  primary.textContent = identity.primary
  content.appendChild(primary)

  const secondary = document.createElement('p')
  secondary.className = 'mt-0.5 truncate text-[11px] font-medium text-slate-600 dark:text-slate-300'
  secondary.textContent = [identity.secondary, carrier.name].filter(Boolean).join(' · ')
  content.appendChild(secondary)

  return content
}

/**
 * Renders the unselected train fleet into one canvas. The canvas is deliberately
 * managed as one Leaflet pane element, so zooming transforms the whole fleet
 * instead of requiring one DOM transform per train.
 */
export function CanvasTrainLayer({
  trains,
  railGeometry,
  sampledAt,
  receivedAt,
  reducedMotion,
  hitTestRef,
}: CanvasTrainLayerProps) {
  const map = useMap()
  const { t } = useApp()
  const sourceRef = useRef({ trains, railGeometry, sampledAt, receivedAt })
  const renderedRef = useRef<RenderedTrain[]>([])
  const visibleRef = useRef<RenderedTrain[]>([])
  const drawRef = useRef<(() => void) | null>(null)
  const animationFrameRef = useRef<number | null>(null)

  useEffect(() => {
    const source = { trains, railGeometry, sampledAt, receivedAt }
    sourceRef.current = source
    renderedRef.current = source.trains.map((train) => {
      const next = liveRailPositionAt(
        train,
        source.railGeometry,
        reducedMotion ? source.receivedAt - source.sampledAt : Date.now() - source.sampledAt
      )
      return { train, position: next.position, bearing: next.bearing, point: null }
    })
    drawRef.current?.()
  }, [trains, railGeometry, sampledAt, receivedAt, reducedMotion])

  useEffect(() => {
    const canvas = document.createElement('canvas')
    canvas.className = 'leaflet-train-canvas'
    canvas.setAttribute('role', 'img')
    canvas.setAttribute('aria-label', `${t('liveTrains')}: ${trains.length}`)
    const pane = map.getPane('trainCanvasPane') ?? map.createPane('trainCanvasPane')
    pane.style.zIndex = '550'
    pane.style.pointerEvents = 'none'
    pane.appendChild(canvas)

    const context = canvas.getContext('2d')
    if (!context) return () => canvas.remove()
    const mapContainer = map.getContainer()
    const trainIconPath = new Path2D(TRAIN_PATH)
    const tooltip = L.tooltip({
      direction: 'top',
      offset: [0, -16],
      opacity: 1,
      className: 'train-tooltip',
    })

    let width = 0
    let height = 0
    let devicePixelRatio = 1
    let drawQueued = false
    let drawRequestId: number | null = null
    let zoomRequestId: number | null = null
    let disposed = false
    let zooming = false

    const resize = () => {
      const size = map.getSize()
      devicePixelRatio = Math.min(window.devicePixelRatio || 1, 2)
      width = size.x
      height = size.y
      canvas.width = Math.round(width * devicePixelRatio)
      canvas.height = Math.round(height * devicePixelRatio)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
    }

    const requestDraw = () => {
      if (drawQueued || zooming) return
      drawQueued = true
      drawRequestId = window.requestAnimationFrame(() => {
        drawRequestId = null
        drawQueued = false
        if (disposed) return
        draw()
      })
    }

    const paint = (project: (item: RenderedTrain) => L.Point) => {
      if (width !== map.getSize().x || height !== map.getSize().y) resize()
      L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]).round())
      context.clearRect(0, 0, width, height)

      const visible: RenderedTrain[] = []
      const dark = document.documentElement.classList.contains('dark')
      for (const item of renderedRef.current) {
        const point = project(item)
        if (
          point.x < -MARKER_RADIUS ||
          point.y < -MARKER_RADIUS ||
          point.x > width + MARKER_RADIUS ||
          point.y > height + MARKER_RADIUS
        ) {
          item.point = null
          continue
        }
        item.point = point
        visible.push(item)
        drawTrain(context, item, point, trainIconPath, dark)
      }
      visibleRef.current = visible
      canvas.dataset.markerCount = String(visible.length)
    }

    const draw = () => paint((item) => map.latLngToContainerPoint(item.position))

    const recomputePositions = () => {
      const source = sourceRef.current
      const elapsed = reducedMotion
        ? source.receivedAt - source.sampledAt
        : Date.now() - source.sampledAt
      renderedRef.current = source.trains.map((train) => {
        const next = liveRailPositionAt(train, source.railGeometry, elapsed)
        return { train, position: next.position, bearing: next.bearing, point: null }
      })
      requestDraw()
    }

    const performHitTest: TrainHitTest = (point) =>
      hitTest(visibleRef.current, point, window.matchMedia('(pointer: coarse)').matches ? TOUCH_RADIUS : MARKER_RADIUS)
    hitTestRef.current = performHitTest

    const showTooltip = (event: L.LeafletMouseEvent) => {
      const id = performHitTest(event.containerPoint)
      const item = visibleRef.current.find((candidate) => candidate.train.id === id)
      mapContainer.classList.toggle('train-marker-hover', Boolean(item))
      if (window.matchMedia('(pointer: coarse)').matches) return
      if (!item) {
        tooltip.close()
        return
      }
      tooltip.setLatLng(item.position).setContent(tooltipContent(item.train)).openOn(map)
    }

    const updatePositions = () => {
      recomputePositions()
      if (!reducedMotion) {
        animationFrameRef.current = window.setTimeout(
          updatePositions,
          frameIntervalForZoom(map.getZoom())
        )
      }
    }

    const beginZoom = () => {
      zooming = true
      if (drawRequestId != null) window.cancelAnimationFrame(drawRequestId)
      drawRequestId = null
      drawQueued = false
    }

    const animateZoom = (event: ZoomAnimationEvent) => {
      if (zoomRequestId != null) window.cancelAnimationFrame(zoomRequestId)
      const viewHalf = map.getSize().multiplyBy(0.5)
      const targetCenter = map.project(event.center, event.zoom)
      const transitions = new Map<
        string,
        { start: L.Point; target: L.Point }
      >()
      for (const item of renderedRef.current) {
        transitions.set(item.train.id, {
          start: item.point ?? map.latLngToContainerPoint(item.position),
          target: map.project(item.position, event.zoom).subtract(targetCenter).add(viewHalf),
        })
      }

      const startedAt = performance.now()
      const animate = (now: number) => {
        if (disposed) return
        const progress = Math.min(1, (now - startedAt) / ZOOM_ANIMATION_MS)
        const eased = zoomEase(progress)
        paint((item) => {
          const transition = transitions.get(item.train.id)
          if (!transition) return map.latLngToContainerPoint(item.position)
          return L.point(
            transition.start.x + (transition.target.x - transition.start.x) * eased,
            transition.start.y + (transition.target.y - transition.start.y) * eased
          )
        })
        zoomRequestId =
          progress < 1 ? window.requestAnimationFrame(animate) : null
      }
      zoomRequestId = window.requestAnimationFrame(animate)
    }

    const redrawContinuousZoom = () => {
      // Pinch and fly animations update Leaflet's center/zoom every frame.
      // Redrawing here keeps symbols fixed-size at those live coordinates.
      if (zoomRequestId == null) draw()
    }

    const finishZoom = () => {
      if (zoomRequestId != null) window.cancelAnimationFrame(zoomRequestId)
      zoomRequestId = null
      zooming = false
      requestDraw()
    }

    resize()
    recomputePositions()
    map.on('move resize', requestDraw)
    map.on('zoomstart', beginZoom)
    map.on('zoom', redrawContinuousZoom)
    map.on('zoomanim', animateZoom)
    map.on('zoomend', finishZoom)
    map.on('mousemove', showTooltip)
    const hideTooltip = () => {
      mapContainer.classList.remove('train-marker-hover')
      tooltip.close()
    }
    map.on('mouseout', hideTooltip)
    if (!reducedMotion) updatePositions()

    drawRef.current = requestDraw
    return () => {
      disposed = true
      hitTestRef.current = null
      map.off('move resize', requestDraw)
      map.off('zoomstart', beginZoom)
      map.off('zoom', redrawContinuousZoom)
      map.off('zoomanim', animateZoom)
      map.off('zoomend', finishZoom)
      map.off('mousemove', showTooltip)
      map.off('mouseout', hideTooltip)
      mapContainer.classList.remove('train-marker-hover')
      tooltip.close()
      if (drawRequestId != null) window.cancelAnimationFrame(drawRequestId)
      if (zoomRequestId != null) window.cancelAnimationFrame(zoomRequestId)
      if (animationFrameRef.current != null) window.clearTimeout(animationFrameRef.current)
      canvas.remove()
      drawRef.current = null
    }
  }, [hitTestRef, map, reducedMotion, t, trains.length])

  return null
}

function frameIntervalForZoom(zoom: number): number {
  if (zoom >= 12) return 50
  if (zoom >= 10) return 100
  if (zoom >= 8) return 250
  return 500
}
