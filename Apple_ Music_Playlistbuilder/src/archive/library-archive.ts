import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  EnrichmentBatchRequest,
  EnrichmentWorkflowStatus,
  EnrichmentWorkflowUpdate,
  SemanticEnrichment,
  TrackCandidate,
  TrackQuery,
} from "../contracts.js";

export const DEFAULT_ARCHIVE_PATH = "data/music-library.sqlite";

export interface SnapshotResult {
  snapshotId: number;
  databasePath: string;
  total: number;
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
}

export interface ArchiveStatus {
  databasePath: string;
  currentTracks: number;
  removedTracks: number;
  historyEntries: number;
  lastSnapshot: {
    id: number;
    completedAt: string;
    total: number;
    added: number;
    updated: number;
    unchanged: number;
    removed: number;
  } | null;
}

interface StoredTrack extends Record<string, unknown> {
  persistent_id: string;
  database_id: number | null;
  title: string;
  artist: string;
  album: string;
  genre: string;
  duration_seconds: number;
  cloud_status: string;
  first_seen_at: string;
  last_seen_at: string;
  removed_at: string | null;
  current: number;
}

export interface ArchivedTrack extends TrackCandidate {
  current: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  removedAt: string | null;
}

export interface StoredEnrichment {
  revisionId: number;
  enrichment: SemanticEnrichment;
}

export interface EnrichmentWorkflowState {
  persistentId: string;
  status: EnrichmentWorkflowStatus;
  updatedAt: string | null;
  completedAt: string | null;
  schemaVersion: number | null;
  model: string | null;
  notes: string | null;
  attemptCount: number;
}

function metadataChanged(stored: StoredTrack, track: TrackCandidate): boolean {
  return stored.database_id !== (track.databaseId ?? null)
    || stored.title !== track.title
    || stored.artist !== track.artist
    || stored.album !== track.album
    || stored.genre !== track.genre
    || stored.duration_seconds !== track.durationSeconds
    || stored.cloud_status !== track.cloudStatus;
}

export class LibraryArchive {
  private constructor(
    private readonly database: DatabaseSync,
    public readonly path: string,
  ) {}

  static async open(path = process.env.MUSIC_LIBRARY_DB ?? DEFAULT_ARCHIVE_PATH): Promise<LibraryArchive> {
    await mkdir(dirname(path), { recursive: true });
    const archive = new LibraryArchive(new DatabaseSync(path), path);
    archive.#initialize();
    return archive;
  }

  close(): void {
    this.database.close();
  }

  snapshot(tracks: TrackCandidate[], observedAt = new Date().toISOString()): SnapshotResult {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const snapshot = this.database.prepare(
        "INSERT INTO snapshots (started_at) VALUES (?) RETURNING id",
      ).get(observedAt) as { id: number };
      const snapshotId = Number(snapshot.id);
      let added = 0;
      let updated = 0;
      let unchanged = 0;

      const findTrack = this.database.prepare("SELECT * FROM tracks WHERE persistent_id = ?");
      const insertTrack = this.database.prepare(`
        INSERT INTO tracks (
          persistent_id, database_id, title, artist, album, genre, duration_seconds,
          cloud_status, first_seen_at, last_seen_at, removed_at, current, last_snapshot_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?)
      `);
      const updateTrack = this.database.prepare(`
        UPDATE tracks SET database_id = ?, title = ?, artist = ?, album = ?, genre = ?,
          duration_seconds = ?, cloud_status = ?, last_seen_at = ?, removed_at = NULL,
          current = 1, last_snapshot_id = ? WHERE persistent_id = ?
      `);
      const insertHistory = this.database.prepare(`
        INSERT INTO track_history (
          persistent_id, snapshot_id, observed_at, change_type, database_id, title,
          artist, album, genre, duration_seconds, cloud_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const track of tracks) {
        const stored = findTrack.get(track.persistentId) as StoredTrack | undefined;
        const values = [
          track.databaseId ?? null, track.title, track.artist, track.album, track.genre,
          track.durationSeconds, track.cloudStatus,
        ] as const;
        if (!stored) {
          insertTrack.run(track.persistentId, ...values, observedAt, observedAt, snapshotId);
          insertHistory.run(track.persistentId, snapshotId, observedAt, "added", ...values);
          added += 1;
        } else {
          const changed = metadataChanged(stored, track);
          updateTrack.run(...values, observedAt, snapshotId, track.persistentId);
          if (changed) {
            insertHistory.run(track.persistentId, snapshotId, observedAt, "updated", ...values);
            updated += 1;
          } else {
            unchanged += 1;
          }
        }
      }

      const missing = this.database.prepare(
        "SELECT * FROM tracks WHERE current = 1 AND last_snapshot_id <> ?",
      ).all(snapshotId) as StoredTrack[];
      const markRemoved = this.database.prepare(
        "UPDATE tracks SET current = 0, removed_at = ? WHERE persistent_id = ?",
      );
      for (const track of missing) {
        markRemoved.run(observedAt, track.persistent_id);
        insertHistory.run(
          track.persistent_id, snapshotId, observedAt, "removed", track.database_id,
          track.title, track.artist, track.album, track.genre, track.duration_seconds, track.cloud_status,
        );
      }

      this.database.prepare(`
        UPDATE snapshots SET completed_at = ?, total_tracks = ?, added = ?, updated = ?,
          unchanged = ?, removed = ? WHERE id = ?
      `).run(observedAt, tracks.length, added, updated, unchanged, missing.length, snapshotId);
      this.database.exec("COMMIT");
      return {
        snapshotId,
        databasePath: this.path,
        total: tracks.length,
        added,
        updated,
        unchanged,
        removed: missing.length,
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  status(): ArchiveStatus {
    const counts = this.database.prepare(`
      SELECT
        SUM(CASE WHEN current = 1 THEN 1 ELSE 0 END) AS current_tracks,
        SUM(CASE WHEN current = 0 THEN 1 ELSE 0 END) AS removed_tracks
      FROM tracks
    `).get() as { current_tracks: number | null; removed_tracks: number | null };
    const history = this.database.prepare("SELECT COUNT(*) AS count FROM track_history").get() as { count: number };
    const latest = this.database.prepare(`
      SELECT id, completed_at, total_tracks, added, updated, unchanged, removed
      FROM snapshots WHERE completed_at IS NOT NULL ORDER BY id DESC LIMIT 1
    `).get() as Record<string, unknown> | undefined;

    return {
      databasePath: this.path,
      currentTracks: Number(counts.current_tracks ?? 0),
      removedTracks: Number(counts.removed_tracks ?? 0),
      historyEntries: Number(history.count),
      lastSnapshot: latest ? {
        id: Number(latest.id),
        completedAt: String(latest.completed_at),
        total: Number(latest.total_tracks),
        added: Number(latest.added),
        updated: Number(latest.updated),
        unchanged: Number(latest.unchanged),
        removed: Number(latest.removed),
      } : null,
    };
  }

  search(query: TrackQuery, includeRemoved = true, limit = 25): ArchivedTrack[] {
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    const fields = [
      ["persistent_id", query.persistentId],
      ["title", query.title],
      ["artist", query.artist],
      ["album", query.album],
      ["genre", query.genre],
    ] as const;
    for (const [column, value] of fields) {
      if (value !== undefined) {
        clauses.push(`${column} LIKE ? ESCAPE '\\'`);
        parameters.push(`%${value.replace(/[\\%_]/g, "\\$&")}%`);
      }
    }
    if (!includeRemoved) clauses.push("current = 1");
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.database.prepare(`
      SELECT * FROM tracks ${where}
      ORDER BY current DESC, title COLLATE NOCASE, artist COLLATE NOCASE LIMIT ?
    `).all(...parameters, limit) as StoredTrack[];
    return rows.map((row) => ({
      persistentId: row.persistent_id,
      ...(row.database_id === null ? {} : { databaseId: row.database_id }),
      title: row.title,
      artist: row.artist,
      album: row.album,
      genre: row.genre,
      durationSeconds: row.duration_seconds,
      cloudStatus: row.cloud_status,
      current: row.current === 1,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      removedAt: row.removed_at,
    }));
  }

  enrichmentContext(query: TrackQuery): Array<{
    track: ArchivedTrack;
    latestEnrichment: StoredEnrichment | null;
    workflow: EnrichmentWorkflowState;
  }> {
    return this.search(query).map((track) => ({
      track,
      latestEnrichment: this.latestEnrichment(track.persistentId),
      workflow: this.enrichmentWorkflow(track.persistentId),
    }));
  }

  enrichmentBatch(request: EnrichmentBatchRequest): Array<{
    track: ArchivedTrack;
    workflow: EnrichmentWorkflowState;
  }> {
    const conditions = [
      "COALESCE(w.status, CASE WHEN e.persistent_id IS NULL THEN 'pending' ELSE 'completed' END) = ?",
    ];
    const parameters: Array<string | number> = [request.status];
    if (!request.includeRemoved) conditions.push("t.current = 1");
    if (request.genre !== undefined) {
      conditions.push("t.genre LIKE ? ESCAPE '\\' COLLATE NOCASE");
      parameters.push(`%${request.genre.replace(/[\\%_]/g, "\\$&")}%`);
    }
    const rows = this.database.prepare(`
      SELECT t.* FROM tracks t
      LEFT JOIN enrichment_workflow w ON w.persistent_id = t.persistent_id
      LEFT JOIN track_enrichments e ON e.persistent_id = t.persistent_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY t.artist COLLATE NOCASE, t.album COLLATE NOCASE, t.title COLLATE NOCASE
      LIMIT ?
    `).all(...parameters, request.limit) as StoredTrack[];
    return rows.map((row) => {
      const track = this.#mapStoredTrack(row);
      return { track, workflow: this.enrichmentWorkflow(track.persistentId) };
    });
  }

  enrichmentWorkflow(persistentId: string): EnrichmentWorkflowState {
    const row = this.database.prepare(`
      SELECT w.*, e.persistent_id AS enriched_id
      FROM tracks t
      LEFT JOIN enrichment_workflow w ON w.persistent_id = t.persistent_id
      LEFT JOIN track_enrichments e ON e.persistent_id = t.persistent_id
      WHERE t.persistent_id = ?
    `).get(persistentId) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`UNKNOWN_PERSISTENT_ID: ${persistentId} is not present in the archive.`);
    return {
      persistentId,
      status: String(row.status ?? (row.enriched_id ? "completed" : "pending")) as EnrichmentWorkflowStatus,
      updatedAt: row.updated_at === null || row.updated_at === undefined ? null : String(row.updated_at),
      completedAt: row.completed_at === null || row.completed_at === undefined ? null : String(row.completed_at),
      schemaVersion: row.schema_version === null || row.schema_version === undefined ? null : Number(row.schema_version),
      model: row.model === null || row.model === undefined ? null : String(row.model),
      notes: row.notes === null || row.notes === undefined ? null : String(row.notes),
      attemptCount: Number(row.attempt_count ?? 0),
    };
  }

  setEnrichmentWorkflow(update: EnrichmentWorkflowUpdate, updatedAt = new Date().toISOString()): EnrichmentWorkflowState {
    this.enrichmentWorkflow(update.persistentId);
    const completedAt = update.status === "completed" ? updatedAt : null;
    this.database.prepare(`
      INSERT INTO enrichment_workflow (
        persistent_id, status, updated_at, completed_at, schema_version, model, notes, attempt_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(persistent_id) DO UPDATE SET
        status = excluded.status,
        updated_at = excluded.updated_at,
        completed_at = excluded.completed_at,
        schema_version = COALESCE(excluded.schema_version, enrichment_workflow.schema_version),
        model = COALESCE(excluded.model, enrichment_workflow.model),
        notes = COALESCE(excluded.notes, enrichment_workflow.notes),
        attempt_count = enrichment_workflow.attempt_count +
          CASE WHEN excluded.status = 'in_progress' THEN 1 ELSE 0 END
    `).run(
      update.persistentId,
      update.status,
      updatedAt,
      completedAt,
      update.schemaVersion ?? null,
      update.model ?? null,
      update.notes ?? null,
      update.status === "in_progress" ? 1 : 0,
    );
    return this.enrichmentWorkflow(update.persistentId);
  }

  importEnrichment(enrichment: SemanticEnrichment): StoredEnrichment {
    const track = this.database.prepare(
      "SELECT persistent_id FROM tracks WHERE persistent_id = ?",
    ).get(enrichment.persistentId);
    if (!track) {
      throw new Error(`UNKNOWN_PERSISTENT_ID: ${enrichment.persistentId} is not present in the archive.`);
    }

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const revision = this.database.prepare(`
        INSERT INTO enrichment_revisions (
          persistent_id, schema_version, created_at, model, summary, dimensions_json,
          moods_json, textures_json, themes_json, confidence, document_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
      `).get(
        enrichment.persistentId,
        enrichment.schemaVersion,
        enrichment.createdAt,
        enrichment.model,
        enrichment.summary,
        JSON.stringify(enrichment.dimensions),
        JSON.stringify(enrichment.moods),
        JSON.stringify(enrichment.textures),
        JSON.stringify(enrichment.themes),
        enrichment.confidence,
        JSON.stringify(enrichment),
      ) as { id: number };
      const revisionId = Number(revision.id);
      const insertSource = this.database.prepare(`
        INSERT INTO enrichment_sources (
          revision_id, url, title, publisher, accessed_at, source_type, claims_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const source of enrichment.sources) {
        insertSource.run(
          revisionId,
          source.url,
          source.title,
          source.publisher ?? null,
          source.accessedAt,
          source.sourceType,
          JSON.stringify(source.claims),
        );
      }
      this.database.prepare(`
        INSERT INTO track_enrichments (persistent_id, latest_revision_id)
        VALUES (?, ?)
        ON CONFLICT(persistent_id) DO UPDATE SET latest_revision_id = excluded.latest_revision_id
      `).run(enrichment.persistentId, revisionId);
      this.database.prepare(`
        INSERT INTO enrichment_workflow (
          persistent_id, status, updated_at, completed_at, schema_version, model, notes, attempt_count
        ) VALUES (?, 'completed', ?, ?, ?, ?, NULL, 0)
        ON CONFLICT(persistent_id) DO UPDATE SET
          status = 'completed', updated_at = excluded.updated_at,
          completed_at = excluded.completed_at, schema_version = excluded.schema_version,
          model = excluded.model
      `).run(
        enrichment.persistentId,
        enrichment.createdAt,
        enrichment.createdAt,
        enrichment.schemaVersion,
        enrichment.model,
      );
      this.database.exec("COMMIT");
      return { revisionId, enrichment };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  latestEnrichment(persistentId: string): StoredEnrichment | null {
    const row = this.database.prepare(`
      SELECT r.id, r.document_json
      FROM track_enrichments e
      JOIN enrichment_revisions r ON r.id = e.latest_revision_id
      WHERE e.persistent_id = ?
    `).get(persistentId) as { id: number; document_json: string } | undefined;
    return row
      ? { revisionId: Number(row.id), enrichment: JSON.parse(row.document_json) as SemanticEnrichment }
      : null;
  }

  enrichmentHistory(persistentId: string): StoredEnrichment[] {
    const rows = this.database.prepare(`
      SELECT id, document_json FROM enrichment_revisions
      WHERE persistent_id = ? ORDER BY id
    `).all(persistentId) as Array<{ id: number; document_json: string }>;
    return rows.map((row) => ({
      revisionId: Number(row.id),
      enrichment: JSON.parse(row.document_json) as SemanticEnrichment,
    }));
  }

  #mapStoredTrack(row: StoredTrack): ArchivedTrack {
    return {
      persistentId: row.persistent_id,
      ...(row.database_id === null ? {} : { databaseId: row.database_id }),
      title: row.title,
      artist: row.artist,
      album: row.album,
      genre: row.genre,
      durationSeconds: row.duration_seconds,
      cloudStatus: row.cloud_status,
      current: row.current === 1,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      removedAt: row.removed_at,
    };
  }

  #initialize(): void {
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, completed_at TEXT,
        total_tracks INTEGER, added INTEGER, updated INTEGER, unchanged INTEGER, removed INTEGER
      );
      CREATE TABLE IF NOT EXISTS tracks (
        persistent_id TEXT PRIMARY KEY, database_id INTEGER, title TEXT NOT NULL,
        artist TEXT NOT NULL, album TEXT NOT NULL, genre TEXT NOT NULL,
        duration_seconds REAL NOT NULL, cloud_status TEXT NOT NULL,
        first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, removed_at TEXT,
        current INTEGER NOT NULL CHECK (current IN (0, 1)),
        last_snapshot_id INTEGER NOT NULL REFERENCES snapshots(id)
      );
      CREATE TABLE IF NOT EXISTS track_history (
        id INTEGER PRIMARY KEY, persistent_id TEXT NOT NULL, snapshot_id INTEGER NOT NULL,
        observed_at TEXT NOT NULL, change_type TEXT NOT NULL,
        database_id INTEGER, title TEXT NOT NULL, artist TEXT NOT NULL, album TEXT NOT NULL,
        genre TEXT NOT NULL, duration_seconds REAL NOT NULL, cloud_status TEXT NOT NULL,
        FOREIGN KEY (snapshot_id) REFERENCES snapshots(id)
      );
      CREATE INDEX IF NOT EXISTS tracks_lookup ON tracks(title, artist, album, genre);
      CREATE INDEX IF NOT EXISTS history_track ON track_history(persistent_id, snapshot_id);
      CREATE TABLE IF NOT EXISTS enrichment_revisions (
        id INTEGER PRIMARY KEY, persistent_id TEXT NOT NULL, schema_version INTEGER NOT NULL,
        created_at TEXT NOT NULL, model TEXT NOT NULL, summary TEXT NOT NULL,
        dimensions_json TEXT NOT NULL, moods_json TEXT NOT NULL, textures_json TEXT NOT NULL,
        themes_json TEXT NOT NULL, confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
        document_json TEXT NOT NULL,
        FOREIGN KEY (persistent_id) REFERENCES tracks(persistent_id)
      );
      CREATE TABLE IF NOT EXISTS enrichment_sources (
        id INTEGER PRIMARY KEY, revision_id INTEGER NOT NULL, url TEXT NOT NULL,
        title TEXT NOT NULL, publisher TEXT, accessed_at TEXT NOT NULL,
        source_type TEXT NOT NULL, claims_json TEXT NOT NULL,
        FOREIGN KEY (revision_id) REFERENCES enrichment_revisions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS track_enrichments (
        persistent_id TEXT PRIMARY KEY, latest_revision_id INTEGER NOT NULL UNIQUE,
        FOREIGN KEY (persistent_id) REFERENCES tracks(persistent_id),
        FOREIGN KEY (latest_revision_id) REFERENCES enrichment_revisions(id)
      );
      CREATE TABLE IF NOT EXISTS enrichment_workflow (
        persistent_id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed', 'review', 'failed')),
        updated_at TEXT NOT NULL, completed_at TEXT, schema_version INTEGER,
        model TEXT, notes TEXT, attempt_count INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (persistent_id) REFERENCES tracks(persistent_id)
      );
      CREATE INDEX IF NOT EXISTS enrichment_track ON enrichment_revisions(persistent_id, id);
      CREATE INDEX IF NOT EXISTS enrichment_source_revision ON enrichment_sources(revision_id);
      CREATE INDEX IF NOT EXISTS enrichment_workflow_status ON enrichment_workflow(status, updated_at);
    `);
  }
}