import assert from "node:assert/strict";
import test from "node:test";

import type { TrackCandidate } from "../src/contracts.js";
import type { MusicLibraryGateway } from "../src/music/osascript-client.js";
import { PlaylistService } from "../src/playlists/service.js";

const candidate: TrackCandidate = {
  persistentId: "ABC123",
  title: "Once in a Lifetime",
  artist: "Talking Heads",
  album: "Remain in Light",
  genre: "New Wave",
  durationSeconds: 260,
  cloudStatus: "matched",
};

test("previews a playlist without mutating the gateway", async () => {
  const calls: string[] = [];
  const gateway: MusicLibraryGateway = {
    async search(query) {
      calls.push(query.title ?? query.persistentId ?? "");
      return [candidate];
    },
  };

  const preview = await new PlaylistService(gateway).preview({
    schemaVersion: 1,
    name: "Test Playlist",
    mode: "create",
    tracks: [{ title: "Once in a Lifetime", artist: "Talking Heads" }],
    confirm: false,
  });

  assert.deepEqual(calls, ["Once in a Lifetime"]);
  assert.equal(preview.summary.resolved, 1);
  assert.equal(preview.resolution.resolved[0]?.match.track.persistentId, "ABC123");
});

test("requires confirmation before mutations", async () => {
  const gateway: MusicLibraryGateway = { async search() { return [candidate]; } };
  await assert.rejects(
    new PlaylistService(gateway).apply({
      schemaVersion: 1,
      name: "Test Playlist",
      mode: "create",
      tracks: [{ persistentId: "ABC123" }],
      confirm: false,
    }),
    { code: "CONFIRMATION_REQUIRED" },
  );
});

test("creates a playlist from revalidated resolved IDs", async () => {
  const mutations: string[][] = [];
  const gateway = {
    async search() { return [candidate]; },
    async createPlaylist(name: string, _description: string | undefined, persistentIds: string[]) {
      mutations.push(persistentIds);
      return { ok: true as const, playlist: name, added: persistentIds, skippedExisting: [], missing: [] };
    },
    async appendPlaylist(name: string, persistentIds: string[]) {
      return { ok: true as const, playlist: name, added: persistentIds, skippedExisting: [], missing: [] };
    },
  };

  const result = await new PlaylistService(gateway).apply({
    schemaVersion: 1,
    name: "Test Playlist",
    mode: "create",
    tracks: [{ persistentId: "ABC123" }],
    confirm: true,
  });

  assert.deepEqual(mutations, [["ABC123"]]);
  assert.deepEqual(result.mutation.added, ["ABC123"]);
});

test("keeps synchronize disabled until the live rebuild strategy is verified", async () => {
  const gateway: MusicLibraryGateway = { async search() { return [candidate]; } };
  await assert.rejects(
    new PlaylistService(gateway).apply({
      schemaVersion: 1,
      name: "Test Playlist",
      mode: "synchronize",
      tracks: [{ persistentId: "ABC123" }],
      confirm: true,
    }),
    { code: "SYNCHRONIZE_UNSUPPORTED" },
  );
});
