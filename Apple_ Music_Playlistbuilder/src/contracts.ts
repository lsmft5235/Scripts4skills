import { z } from "zod";

export const TrackQuerySchema = z.object({
  title: z.string().trim().min(1).optional(),
  artist: z.string().trim().min(1).optional(),
  album: z.string().trim().min(1).optional(),
  genre: z.string().trim().min(1).optional(),
  durationSeconds: z.number().positive().optional(),
  persistentId: z.string().trim().min(1).optional(),
}).refine((query) => query.title !== undefined || query.persistentId !== undefined, {
  message: "A track query requires title or persistentId.",
});

export const TrackCandidateSchema = z.object({
  persistentId: z.string().min(1),
  databaseId: z.number().int().optional(),
  title: z.string(),
  artist: z.string(),
  album: z.string(),
  genre: z.string(),
  durationSeconds: z.number().nonnegative(),
  cloudStatus: z.string(),
});

export const PlaylistModeSchema = z.enum(["create", "append", "synchronize"]);

export const PlaylistRequestSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  name: z.string().trim().min(1),
  description: z.string().optional(),
  mode: PlaylistModeSchema.default("create"),
  tracks: z.array(TrackQuerySchema).min(1),
  confirm: z.boolean().default(false),
});

const QualiaScoreSchema = z.number().min(0).max(1);

export const EnrichmentSourceSchema = z.object({
  url: z.url(),
  title: z.string().trim().min(1).max(300),
  publisher: z.string().trim().min(1).max(200).optional(),
  accessedAt: z.iso.datetime(),
  sourceType: z.enum(["review", "interview", "artist", "label", "database", "other"]),
  claims: z.array(z.string().trim().min(1).max(500)).min(1).max(8),
});

export const SemanticEnrichmentSchema = z.object({
  schemaVersion: z.literal(1),
  persistentId: z.string().trim().min(1),
  createdAt: z.iso.datetime(),
  model: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(1200),
  dimensions: z.object({
    valence: QualiaScoreSchema,
    energy: QualiaScoreSchema,
    tension: QualiaScoreSchema,
    warmth: QualiaScoreSchema,
    danceability: QualiaScoreSchema,
    darkness: QualiaScoreSchema,
    experimentalism: QualiaScoreSchema,
  }),
  moods: z.array(z.string().trim().min(1).max(80)).min(1).max(12),
  textures: z.array(z.string().trim().min(1).max(80)).max(12),
  themes: z.array(z.string().trim().min(1).max(120)).max(12),
  confidence: QualiaScoreSchema,
  sources: z.array(EnrichmentSourceSchema).min(1).max(20),
});

export const EnrichmentWorkflowStatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
  "review",
  "failed",
]);

export const EnrichmentBatchRequestSchema = z.object({
  status: EnrichmentWorkflowStatusSchema.default("pending"),
  limit: z.number().int().min(1).max(100).default(10),
  genre: z.string().trim().min(1).optional(),
  includeRemoved: z.boolean().default(false),
});

export const EnrichmentWorkflowUpdateSchema = z.object({
  persistentId: z.string().trim().min(1),
  status: EnrichmentWorkflowStatusSchema,
  notes: z.string().trim().max(1000).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  schemaVersion: z.number().int().positive().optional(),
});

export type TrackQuery = z.infer<typeof TrackQuerySchema>;
export type TrackCandidate = z.infer<typeof TrackCandidateSchema>;
export type PlaylistRequest = z.infer<typeof PlaylistRequestSchema>;
export type SemanticEnrichment = z.infer<typeof SemanticEnrichmentSchema>;
export type EnrichmentWorkflowStatus = z.infer<typeof EnrichmentWorkflowStatusSchema>;
export type EnrichmentBatchRequest = z.infer<typeof EnrichmentBatchRequestSchema>;
export type EnrichmentWorkflowUpdate = z.infer<typeof EnrichmentWorkflowUpdateSchema>;

export interface RankedCandidate {
  track: TrackCandidate;
  score: number;
  reasons: string[];
}

export interface ResolvedTrack {
  query: TrackQuery;
  match: RankedCandidate;
}

export interface SkippedTrack {
  query: TrackQuery;
  reason: "no_candidates" | "low_confidence" | "ambiguous" | "duplicate";
  candidates: RankedCandidate[];
}

export interface ResolutionResult {
  resolved: ResolvedTrack[];
  skipped: SkippedTrack[];
}