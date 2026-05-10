'use client'

import { useState, useEffect } from 'react'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

interface EventThread {
  id: string
  title: string
  summary: string | null
  category: string
  region: string | null
  status: 'developing' | 'escalating' | 'stable' | 'resolved'
  peak_severity: string
  signal_count: number
  severity_trajectory: Array<{ timestamp: string; avg_severity_rank: number; signal_count: number }>
  last_updated: string
  related_entities: string[]
}

const STATUS_COLORS: Record<string, string> = {
  escalating: 'text-red-400 bg-red-400/10 border-red-400/30',
  developing: 'text-amber-400 bg-amber-400/10 border-amber-400/30',
  stable:     'text-blue-400 bg-blue-400/10 border-blue-400/30',
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'text-red-400',
  high:     'text-orange-400',
  medium:   'text-yellow-400',
  low:      'text-green-400',
}

/**
 * Developing Stories panel for the homepage.
 * Shows active event threads — escalating stories first.
 */
export function DevelopingStories() {
  const [threads, setThreads] = useState<EventThread[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    fetchThreads()
    // Refresh every 5 minutes
    const timer = setInterval(fetchThreads, 5 * 60 * 1000)
    return () => clearInterval(timer)
  }, [])

  async function fetchThreads() {
    try {
      const res = await fetch(`${API_URL}/api/v1/threads?limit=8`)
      if (!res.ok) return
      const data = await res.json()
      setThreads(data.threads ?? [])
    } catch {
      // silently fail — homepage shouldn't break if threads API is down
    } finally {
      setLoading(false)
    }
  }

  if (loading) return null
  if (threads.length === 0) return null

  const escalating = threads.filter(t => t.status === 'escalating')
  const developing = threads.filter(t => t.status === 'developing')
  const display = [...escalating, ...developing].slice(0, 6)

  if (display.length === 0) return null

  return (
    <div className="border-b border-[rgba(255,255,255,0.07)] bg-[rgba(0,0,0,0.2)]">
      <div className="px-4 py-3">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-red-400 animate-pulse" />
            <h2 className="text-[13px] font-semibold text-wp-text1 tracking-wide uppercase">
              Developing Stories
            </h2>
          </div>
          <span className="text-[11px] text-wp-text3 font-mono">
            {escalating.length > 0
              ? `${escalating.length} escalating`
              : `${display.length} active`}
          </span>
        </div>

        <div className="space-y-2">
          {display.map(thread => (
            <div
              key={thread.id}
              className="rounded-lg border border-[rgba(255,255,255,0.07)] bg-[rgba(255,255,255,0.02)] p-3 cursor-pointer hover:border-[rgba(255,255,255,0.15)] transition-all"
              onClick={() => setExpanded(expanded === thread.id ? null : thread.id)}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${STATUS_COLORS[thread.status] ?? STATUS_COLORS.developing}`}>
                      {thread.status.toUpperCase()}
                    </span>
                    <span className={`text-[10px] font-mono ${SEVERITY_COLORS[thread.peak_severity] ?? 'text-wp-text3'}`}>
                      {thread.peak_severity}
                    </span>
                    {thread.region && (
                      <span className="text-[10px] text-wp-text3 font-mono truncate">
                        {thread.region}
                      </span>
                    )}
                  </div>
                  <p className="text-[13px] text-wp-text1 line-clamp-2 leading-snug">
                    {thread.title}
                  </p>
                </div>
                <div className="text-right flex-shrink-0">
                  <div className="text-[11px] text-wp-cyan font-mono">
                    {thread.signal_count} signals
                  </div>
                  <TrendIndicator trajectory={thread.severity_trajectory} />
                </div>
              </div>

              {/* Expanded view */}
              {expanded === thread.id && thread.summary && (
                <div className="mt-2 pt-2 border-t border-[rgba(255,255,255,0.07)]">
                  <p className="text-[12px] text-wp-text2 leading-relaxed">
                    {thread.summary}
                  </p>
                  {thread.related_entities.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {thread.related_entities.slice(0, 5).map((entity, i) => (
                        <span key={i} className="text-[10px] text-wp-text3 bg-[rgba(255,255,255,0.05)] px-1.5 py-0.5 rounded">
                          {entity}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="text-[10px] text-wp-text3 mt-2 font-mono">
                    Last update: {new Date(thread.last_updated).toRelativeTimeString?.() ?? timeAgo(thread.last_updated)}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function TrendIndicator({ trajectory }: { trajectory: EventThread['severity_trajectory'] }) {
  if (trajectory.length < 2) return null

  const recent = trajectory[trajectory.length - 1]!
  const prev = trajectory[trajectory.length - 2]!
  const trend = recent.avg_severity_rank > prev.avg_severity_rank
    ? '↑' : recent.avg_severity_rank < prev.avg_severity_rank
    ? '↓' : '→'
  const color = trend === '↑' ? 'text-red-400' : trend === '↓' ? 'text-green-400' : 'text-wp-text3'

  return (
    <span className={`text-[11px] font-mono ${color}`}>
      {trend}
    </span>
  )
}

function timeAgo(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diff = now - then
  const hours = Math.floor(diff / 3600000)
  if (hours < 1) return 'just now'
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
