import { NextResponse } from 'next/server'
import { getLiveTrainSnapshot } from '@/lib/server/datastore'

// Live data — never statically cached; each request reflects the latest poll.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const { trains, sampledAt } = await getLiveTrainSnapshot()
    return NextResponse.json(
      { trains, count: trains.length, at: new Date(sampledAt).toISOString() },
      { headers: { 'Cache-Control': 'no-store' } }
    )
  } catch (err) {
    console.error('GET /api/trains failed:', err)
    return NextResponse.json(
      { error: 'Failed to load live trains' },
      { status: 500 }
    )
  }
}
