import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LibraryArchive } from "../src/archive/library-archive.js";
import type { SemanticEnrichment, TrackCandidate } from "../src/contracts.js";

const tracks: TrackCandidate[] = [
  {
    persistentId: "ONE",
    databaseId: 1,
    title: "First Song",
    artist: "The Artist",
    album: "The Album",
    genre: "Rock",
    durationSeconds: 180,
    cloudStatus: "matched",
  },
  {
    persistentId: "TWO",
    databaseId: 2,
    title: "Second Song",
    artist: "Another Artist",
    album: "Other Album",
    genre: "Jazz",
    durationSeconds: 240,
    cloudStatus: "uploaded",
  },
];

test("maintains current tracks and append-only change history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "music-archive-"));
  const path = join(directory, "library.sqlite");
  const archive = await LibraryArchive.open(path);
  try {
    const first = archive.snapshot(tracks, "2026-01-01T00:00:00.000Z");
    assert.deepEqual({ added: first.added, updated: first.updated, removed: first.removed }, { added: 2, updated: 0, removed: 0 });

    const second = archive.snapshot(
      [{ ...tracks[0]!, genre: "Alternative" }],
      "2026-01-02T00:00:00.000Z",
    );
    assert.deepEqual(
      { added: second.added, updated: second.updated, unchanged: second.unchanged, removed: second.removed },
      { added: 0, updated: 1, unchanged: 0, removed: 1 },
    );

    const removed = archive.search({ title: "Second" });
    assert.equal(removed.length, 1);
    assert.equal(removed[0]?.current, false);
    assert.equal(removed[0]?.firstSeenAt, "2026-01-01T00:00:00.000Z");
    assert.equal(removed[0]?.removedAt, "2026-01-02T00:00:00.000Z");
    assert.equal(archive.search({ title: "Second" }, false).length, 0);
    assert.deepEqual(
      { current: archive.status().currentTracks, removed: archive.status().removedTracks, history: archive.status().historyEntries },
      { current: 1, removed: 1, history: 4 },
    );
  } finally {
    archive.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps immutable semantic enrichment revisions and a latest pointer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "music-enrichment-"));
  const archive = await LibraryArchive.open(join(directory, "library.sqlite"));
  const base: SemanticEnrichment = {
    schemaVersion: 1,
    persistentId: "ONE",
    createdAt: "2026-01-03T00:00:00.000Z",
    model: "local-test-model",
    summary: "A tense, mechanical track with a controlled pulse.",
    dimensions: {
      valence: 0.2,
      energy: 0.8,
      tension: 0.9,
      warmth: 0.1,
      danceability: 0.6,
      darkness: 0.8,
      experimentalism: 0.7,
    },
    moods: ["tense", "urgent"],
    textures: ["metallic"],
    themes: ["alienation"],
    confidence: 0.75,
    sources: [{
      url: "https://example.com/review",
      title: "A review",
      publisher: "Example",
      accessedAt: "2026-01-03T00:00:00.000Z",
      sourceType: "review",
      claims: ["The review describes a mechanical rhythmic character."],
    }],
  };
  try {
    archive.snapshot([tracks[0]!], "2026-01-01T00:00:00.000Z");
    const first = archive.importEnrichment(base);
    const second = archive.importEnrichment({
      ...base,
      createdAt: "2026-01-04T00:00:00.000Z",
      confidence: 0.85,
    });

    assert.equal(first.revisionId, 1);
    assert.equal(second.revisionId, 2);
    assert.equal(archive.latestEnrichment("ONE")?.enrichment.confidence, 0.85);
    assert.equal(archive.enrichmentWorkflow("ONE").status, "completed");
    assert.equal(archive.enrichmentWorkflow("ONE").model, "local-test-model");
    assert.deepEqual(archive.enrichmentHistory("ONE").map((item) => item.revisionId), [1, 2]);
    assert.equal(archive.enrichmentContext({ persistentId: "ONE" })[0]?.latestEnrichment?.revisionId, 2);
  } finally {
    archive.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("persists enrichment workflow state across library snapshots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "music-workflow-"));
  const archive = await LibraryArchive.open(join(directory, "library.sqlite"));
  try {
    archive.snapshot(tracks, "2026-01-01T00:00:00.000Z");
    assert.deepEqual(
      archive.enrichmentBatch({ status: "pending", limit: 10, includeRemoved: false }).map((item) => item.track.persistentId),
      ["TWO", "ONE"],
    );

    const started = archive.setEnrichmentWorkflow({
      persistentId: "ONE",
      status: "in_progress",
      model: "local-model",
      notes: "Research started.",
    }, "2026-01-02T00:00:00.000Z");
    assert.equal(started.attemptCount, 1);
    assert.equal(archive.enrichmentBatch({ status: "in_progress", limit: 10, includeRemoved: false })[0]?.track.persistentId, "ONE");

    archive.snapshot(tracks, "2026-01-03T00:00:00.000Z");
    const afterSnapshot = archive.enrichmentWorkflow("ONE");
    assert.equal(afterSnapshot.status, "in_progress");
    assert.equal(afterSnapshot.notes, "Research started.");

    const review = archive.setEnrichmentWorkflow({ persistentId: "ONE", status: "review" }, "2026-01-04T00:00:00.000Z");
    assert.equal(review.status, "review");
    assert.equal(review.attemptCount, 1);
  } finally {
    archive.close();
    await rm(directory, { recursive: true, force: true });
  }
});