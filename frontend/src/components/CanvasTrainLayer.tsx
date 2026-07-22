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

const VIEWPORT_PADDING = 0.25
const MARKER_RADIUS = 17
const TOUCH_RADIUS = 22

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
  trainIconPath: Path2D
) {
  const carrier = getCarrier(rendered.train.carrierId)
  const bearing = (rendered.bearing * Math.PI) / 180

  context.save()
  context.translate(point.x, point.y)

  // Direction triangle. It deliberately has no shadow: shadows are one of the
  // paint costs that made the old DOM fleet expensive on touch devices.
  context.rotate(bearing)
  context.fillStyle = carrier.color
  context.beginPath()
  context.moveTo(0, -19)
  context.lineTo(-6, -9)
  context.lineTo(6, -9)
  context.closePath()
  context.fill()
  context.restore()

  context.beginPath()
  context.fillStyle = carrier.color
  context.arc(point.x, point.y, 13, 0, Math.PI * 2)
  context.fill()
  context.lineWidth = 2
  context.strokeStyle = 'rgba(255, 255, 255, 0.9)'
  context.stroke()

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
    const x = point.x + 8
    const y = point.y - 14
    roundedRect(context, x, y, width, 16, 8)
    context.fillStyle = '#ef4444'
    context.fill()
    context.lineWidth = 1.5
    context.strokeStyle = '#ffffff'
    context.stroke()
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
 * a direct child of the map container, so it follows container coordinates while
 * Leaflet pans/zooms instead of requiring one DOM transform per train.
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
    map.getContainer().appendChild(canvas)

    const context = canvas.getContext('2d')
    if (!context) return () => canvas.remove()
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
    let disposed = false

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
      if (drawQueued) return
      drawQueued = true
      drawRequestId = window.requestAnimationFrame(() => {
        drawRequestId = null
        drawQueued = false
        if (disposed) return
        draw()
      })
    }

    const draw = () => {
      if (width !== map.getSize().x || height !== map.getSize().y) resize()
      context.clearRect(0, 0, width, height)

      const bounds = map.getBounds().pad(VIEWPORT_PADDING)
      const visible: RenderedTrain[] = []
      for (const item of renderedRef.current) {
        if (!bounds.contains([item.position.lat, item.position.lng])) {
          item.point = null
          continue
        }
        const point = map.latLngToContainerPoint(item.position)
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
        drawTrain(context, item, point, trainIconPath)
      }
      visibleRef.current = visible
      canvas.dataset.markerCount = String(visible.length)
    }

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
      if (window.matchMedia('(pointer: coarse)').matches) return
      const id = performHitTest(event.containerPoint)
      const item = visibleRef.current.find((candidate) => candidate.train.id === id)
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

    resize()
    recomputePositions()
    map.on('move zoom resize', requestDraw)
    map.on('mousemove', showTooltip)
    const hideTooltip = () => tooltip.close()
    map.on('mouseout', hideTooltip)
    if (!reducedMotion) updatePositions()

    drawRef.current = requestDraw
    return () => {
      disposed = true
      hitTestRef.current = null
      map.off('move zoom resize', requestDraw)
      map.off('mousemove', showTooltip)
      map.off('mouseout', hideTooltip)
      tooltip.close()
      if (drawRequestId != null) window.cancelAnimationFrame(drawRequestId)
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
