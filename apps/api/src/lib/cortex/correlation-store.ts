/**
 * Correlation Cluster Store — Phase 1.6.6
 *
 * Migrates correlation cluster storage from Redis to PostgreSQL
 * for durability. Redis remains as a fast cache, but PostgreSQL
 * is the source of truth.
 *
 * The scraper still writes clusters to Redis (for real-time access),
 * and this module syncs them to PostgreSQL periodically.
 *
 * @module cortex/correlation-store
 */

import { db } from '../../db/postgres'
import { redis } from '../../db/redis'

interface RedisCluster {
  cluster_id: string
  primary_signal_id: string
  signal_ids: string[]
  categories: string[]
  sources: string[]
  severity: string
  correlation_score: number
  created_at: string
}

/**
 * Sync recent correlation clusters from Redis to PostgreSQL.
 * Reads from the Redis sorted set and upserts into correlation_clusters table.
 */
export async function syncClustersToPostgres(): Promise<{
  synced: number
  errors: number
}> {
  console.log('[CORTEX] Syncing correlation clusters Redis → PostgreSQL...')

  // Get recent cluster IDs from Redis
  const clusterIds = await redis.zrevrange('correlation:recent', 0, 500)

  if (clusterIds.length === 0) {
    console.log('[CORTEX] No clusters to sync')
    return { synced: 0, errors: 0 }
  }

  let synced = 0
  let errors = 0

  // Batch fetch cluster data from Redis
  const pipeline = redis.pipeline()
  for (const id of clusterIds) {
    pipeline.get(`correlation:cluster:${id}`)
  }
  const results = await pipeline.exec()

  for (let i = 0; i < clusterIds.length; i++) {
    const raw = results?.[i]?.[1] as string | null
    if (!raw) continue

    try {
      const cluster: RedisCluster = JSON.parse(raw)

      await db('correlation_clusters')
        .insert({
          cluster_id:        cluster.cluster_id,
          primary_signal_id: cluster.primary_signal_id || null,
          signal_ids:        cluster.signal_ids ?? [],
          categories:        cluster.categories ?? [],
          sources:           cluster.sources ?? [],
          severity:          cluster.severity ?? 'medium',
          correlation_score: cluster.correlation_score ?? 0,
          signal_count:      cluster.signal_ids?.length ?? 0,
          created_at:        cluster.created_at || new Date().toISOString(),
          updated_at:        new Date().toISOString(),
        })
        .onConflict('cluster_id')
        .merge({
          signal_ids:        cluster.signal_ids ?? [],
          categories:        cluster.categories ?? [],
          sources:           cluster.sources ?? [],
          severity:          cluster.severity ?? 'medium',
          correlation_score: cluster.correlation_score ?? 0,
          signal_count:      cluster.signal_ids?.length ?? 0,
          updated_at:        new Date().toISOString(),
        })

      synced++
    } catch (err) {
      errors++
      // Don't spam logs for individual failures
      if (errors <= 3) {
        console.error(`[CORTEX] Cluster sync error for ${clusterIds[i]}:`, err)
      }
    }
  }

  console.log(`[CORTEX] Cluster sync: ${synced} synced, ${errors} errors from ${clusterIds.length} total`)
  return { synced, errors }
}

/**
 * Get a correlation cluster by ID, falling back from Redis to PostgreSQL.
 */
export async function getCluster(clusterId: string): Promise<RedisCluster | null> {
  // Try Redis first (fast path)
  const cached = await redis.get(`correlation:cluster:${clusterId}`).catch(() => null)
  if (cached) {
    try { return JSON.parse(cached) } catch { /* fall through */ }
  }

  // Fall back to PostgreSQL
  const row = await db('correlation_clusters')
    .where('cluster_id', clusterId)
    .first()

  if (!row) return null

  return {
    cluster_id:        row.cluster_id,
    primary_signal_id: row.primary_signal_id,
    signal_ids:        row.signal_ids ?? [],
    categories:        row.categories ?? [],
    sources:           row.sources ?? [],
    severity:          row.severity,
    correlation_score: Number(row.correlation_score),
    created_at:        row.created_at?.toISOString?.() ?? row.created_at,
  }
}

/**
 * Get recent clusters from PostgreSQL (for durability queries that
 * shouldn't rely on Redis TTLs).
 */
export async function getRecentClusters(limit: number = 100): Promise<RedisCluster[]> {
  const rows = await db('correlation_clusters')
    .orderBy('created_at', 'desc')
    .limit(limit)

  return rows.map((row: any) => ({
    cluster_id:        row.cluster_id,
    primary_signal_id: row.primary_signal_id,
    signal_ids:        row.signal_ids ?? [],
    categories:        row.categories ?? [],
    sources:           row.sources ?? [],
    severity:          row.severity,
    correlation_score: Number(row.correlation_score),
    created_at:        row.created_at?.toISOString?.() ?? row.created_at,
  }))
}

/**
 * Get cluster stats for cortex health monitoring.
 */
export async function getClusterStats(): Promise<{
  total_clusters: number
  recent_24h: number
  avg_score: number
  avg_signal_count: number
}> {
  const stats = await db('correlation_clusters')
    .select(
      db.raw('COUNT(*) as total'),
      db.raw("COUNT(CASE WHEN created_at >= NOW() - INTERVAL '24 hours' THEN 1 END) as recent_24h"),
      db.raw('AVG(correlation_score) as avg_score'),
      db.raw('AVG(signal_count) as avg_count'),
    )
    .first()

  return {
    total_clusters: Number((stats as any)?.total ?? 0),
    recent_24h: Number((stats as any)?.recent_24h ?? 0),
    avg_score: Math.round(Number((stats as any)?.avg_score ?? 0) * 100) / 100,
    avg_signal_count: Math.round(Number((stats as any)?.avg_count ?? 0) * 10) / 10,
  }
}
