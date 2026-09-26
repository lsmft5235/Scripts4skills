import assert from "node:assert/strict";
import test from "node:test";

import type { TrackCandidate } from "../src/contracts.js";
import { rankCandidate, resolveTracks } from "../src/matching/resolver.js";

const track: TrackCandidate = {
  persistentId: "ABC123",
  databaseId: 42,
  title: "Once in a Lifetime",
  artist: "Talking Heads",
  album: "Remain in Light",
  genre: "New Wave",
  durationSeconds: 260,
  cloudStatus: "matched",
};

test("persistent ID is authoritative", () => {
  assert.equal(rankCandidate({ persistentId: "abc123" }, track).score, 100);
  assert.equal(rankCandidate({ persistentId: "wrong" }, track).score, 0);
});

test("scores flexible metadata including genre and duration", () => {
  const ranked = rankCandidate({
    title: "Once in a Lifetime",
    artist: "Talking Heads",
    album: "Remain in Light",
    genre: "New Wave",
    durationSeconds: 261,
  }, track);

  assert.equal(ranked.score, 100);
  assert.deepEqual(ranked.reasons, [
    "title_exact",
    "artist_exact",
    "album_exact",
    "genre_exact",
    "duration_close",
  ]);
});

test("skips ambiguous and duplicate matches", () => {
  const alternate = { ...track, persistentId: "DEF456", album: "Best Of" };
  const result = resolveTracks(
    [
      { title: track.title, artist: track.artist },
      { persistentId: track.persistentId },
      { title: track.title, artist: track.artist, album: track.album },
    ],
    [[track, alternate], [track], [track]],
  );

  assert.equal(result.resolved.length, 1);
  assert.equal(result.resolved[0]?.match.track.persistentId, "ABC123");
  assert.deepEqual(result.skipped.map((item) => item.reason), ["ambiguous", "duplicate"]);
});

test("skips weak matches", () => {
  const result = resolveTracks([{ title: "A Different Song" }], [[track]]);
  assert.equal(result.resolved.length, 0);
  assert.equal(result.skipped[0]?.reason, "low_confidence");
});