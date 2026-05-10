/**
 * Entity API — Phase 1.6.3
 *
 * Knowledge graph entity endpoints.
 *
 * GET /api/v1/entities/:id/timeline  — Chronological signal appearances + trend
 * GET /api/v1/entities/:id           — Entity detail with edges and metadata
 *
 * @module routes/entities
 */

import type { FastifyPluginAsync } from 'fastify'
import { db } from '../db/postgres'
import { redis } from '../db/redis'

const CACHE_TTL = 120

export const registerEntityRoutes: FastifyPluginAsync = async (app) => {

  app.addHook('onRoute', (routeOptions) => {
    routeOptions.schema ??= {}
    routeOptions.schema.tags = routeOptions.schema.tags ?? ['entities']
  })

  // ─── Entity detail ───────────────────────────────────────────
  app.get('/:id', {
    schema: {
      summary: 'Entity Detail',
      description: 'Entity with edges, metadata, importance score, and trend',
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const entity = await db('entity_nodes').where('id', id).first()
    if (!entity) {
      return reply.status(404).send({ success: false, error: 'Entity not found' })
    }

    // Get edges (both directions)
    const edges = await db('entity_edges')
      .where('source_entity_id', id)
      .orWhere('target_entity_id', id)
      .select('id', 'source_entity_id', 'target_entity_id', 'predicate', 'weight', 'first_seen', 'last_seen')
      .orderBy('weight', 'desc')
      .limit(50)

    // Enrich edges with entity names
    const entityIds = new Set<string>()
    for (const e of edges) {
      entityIds.add(e.source_entity_id)
      entityIds.add(e.target_entity_id)
    }
    entityIds.delete(id)

    const relatedEntities = entityIds.size > 0
      ? await db('entity_nodes')
          .whereIn('id', [...entityIds])
          .select('id', 'canonical_name', 'type', 'mention_count')
      : []

    const entityMap = new Map(relatedEntities.map((e: any) => [e.id, e]))

    const enrichedEdges = edges.map((e: any) => {
      const otherId = e.source_entity_id === id ? e.target_entity_id : e.source_entity_id
      const other = entityMap.get(otherId)
      return {
        ...e,
        direction: e.source_entity_id === id ? 'outgoing' : 'incoming',
        related_entity: other ? {
          id: other.id,
          name: other.canonical_name,
          type: other.type,
          mention_count: other.mention_count,
        } : null,
      }
    })

    const metadata = typeof entity.metadata === 'string'
      ? JSON.parse(entity.metadata) : entity.metadata ?? {}
    const aliases = Array.isArray(entity.aliases)
      ? entity.aliases : JSON.parse(entity.aliases ?? '[]')

    return reply.send({
      success: true,
      entity: {
        id: entity.id,
        canonical_name: entity.canonical_name,
        type: entity.type,
        aliases,
        mention_count: entity.mention_count,
        first_seen: entity.first_seen,
        last_seen: entity.last_seen,
        importance_score: metadata.importance_score ?? null,
        trend: metadata.trend ?? null,
        recent_7d: metadata.recent_7d ?? null,
        previous_7d: metadata.previous_7d ?? null,
        weighted_degree: metadata.weighted_degree ?? null,
        edge_count: metadata.edge_count ?? null,
      },
      edges: enrichedEdges,
    })
  })

  // ─── Entity timeline ─────────────────────────────────────────
  app.get('/:id/timeline', {
    schema: {
      summary: 'Entity Timeline',
      description: 'Chronological signal appearances, co-occurrence events, and trend data',
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { limit = 50, offset = 0 } = req.query as { limit?: number; offset?: number }

    const cacheKey = `entity:timeline:${id}:${limit}:${offset}`
    const cached = await redis.get(cacheKey).catch(() => null)
    if (cached) return reply.header('X-Cache-Hit', 'true').send(JSON.parse(cached))

    const entity = await db('entity_nodes').where('id', id).first()
    if (!entity) {
      return reply.status(404).send({ success: false, error: 'Entity not found' })
    }

    // Parse signal_ids from entity
    const signalIds: string[] = Array.isArray(entity.signal_ids)
      ? entity.signal_ids
      : JSON.parse(entity.signal_ids ?? '[]')

    if (signalIds.length === 0) {
      return reply.send({
        success: true,
        entity: { id: entity.id, name: entity.canonical_name, type: entity.type },
        timeline: [],
        total: 0,
        trend: null,
      })
    }

    // Get signals with details, paginated
    const signals = await db('signals')
      .whereIn('id', signalIds)
      .select(
        'id', 'title', 'category', 'severity', 'location_name',
        'reliability_score', 'source_count', 'published_at', 'created_at',
      )
      .orderBy('published_at', 'desc')
      .limit(Math.min(limit, 100))
      .offset(offset)

    // Compute co-appearing entities for each signal
    const timelineEntries = []

    for (const signal of signals) {
      // Find other entities that also reference this signal
      const coEntities = await db('entity_nodes')
        .where('id', '!=', id)
        .whereRaw("signal_ids::text LIKE ?", [`%${signal.id}%`])
        .select('id', 'canonical_name', 'type')
        .limit(5)

      timelineEntries.push({
        signal_id: signal.id,
        title: signal.title,
        category: signal.category,
        severity: signal.severity,
        location: signal.location_name,
        reliability: signal.reliability_score,
        source_count: signal.source_count,
        published_at: signal.published_at,
        co_entities: coEntities.map((e: any) => ({
          id: e.id,
          name: e.canonical_name,
          type: e.type,
        })),
      })
    }

    // Trend data from metadata
    const metadata = typeof entity.metadata === 'string'
      ? JSON.parse(entity.metadata) : entity.metadata ?? {}

    const result = {
      success: true,
      entity: {
        id: entity.id,
        name: entity.canonical_name,
        type: entity.type,
        mention_count: entity.mention_count,
        first_seen: entity.first_seen,
        last_seen: entity.last_seen,
      },
      timeline: timelineEntries,
      total: signalIds.length,
      trend: metadata.trend ?? null,
      importance_score: metadata.importance_score ?? null,
    }

    await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(result)).catch(() => {})
    return reply.send(result)
  })
}
