export const MUSIC_JXA_SOURCE = String.raw`
function value(getter, fallback) {
  try {
    const result = getter();
    return result === null || result === undefined ? fallback : result;
  } catch (_) {
    return fallback;
  }
}

function serializeTrack(track) {
  return {
    persistentId: value(() => track.persistentID(), ""),
    databaseId: value(() => track.databaseID(), undefined),
    title: value(() => track.name(), ""),
    artist: value(() => track.artist(), ""),
    album: value(() => track.album(), ""),
    genre: value(() => track.genre(), ""),
    durationSeconds: value(() => track.duration(), 0),
    cloudStatus: String(value(() => track.cloudStatus(), "unknown")),
  };
}

function findLibraryTrack(library, persistentId) {
  const tracks = library.tracks.whose({ persistentID: persistentId })();
  return tracks.length > 0 ? tracks[0] : null;
}

function findUserPlaylist(music, name) {
  const playlists = music.userPlaylists.whose({ name: name })();
  return playlists.length > 0 ? playlists[0] : null;
}

function run(argv) {
  const request = JSON.parse(argv[0]);
  const music = Application("Music");
  const library = music.libraryPlaylists()[0];

  if (request.operation === "search") {
    let tracks;
    if (request.query.persistentId) {
      tracks = library.tracks.whose({ persistentID: request.query.persistentId })();
    } else {
      tracks = music.search(library, { for: request.query.title, only: "all" });
    }
    return JSON.stringify({ tracks: tracks.slice(0, request.limit).map(serializeTrack) });
  }

  if (request.operation === "listLibrary") {
    const tracks = library.tracks;
    const persistentIds = tracks.persistentID();
    const databaseIds = tracks.databaseID();
    const titles = tracks.name();
    const artists = tracks.artist();
    const albums = tracks.album();
    const genres = tracks.genre();
    const durations = tracks.duration();
    const cloudStatuses = tracks.cloudStatus();
    return JSON.stringify({
      tracks: persistentIds.map((persistentId, index) => ({
        persistentId,
        databaseId: databaseIds[index],
        title: titles[index] || "",
        artist: artists[index] || "",
        album: albums[index] || "",
        genre: genres[index] || "",
        durationSeconds: durations[index] || 0,
        cloudStatus: String(cloudStatuses[index] || "unknown"),
      })),
    });
  }

  if (request.operation === "createPlaylist") {
    if (findUserPlaylist(music, request.name)) {
      return JSON.stringify({ ok: false, code: "PLAYLIST_EXISTS", message: "A user playlist with that name already exists." });
    }
    const playlist = music.UserPlaylist({ name: request.name, description: request.description || "" });
    music.userPlaylists.push(playlist);
    const added = [];
    const missing = [];
    for (const persistentId of request.persistentIds) {
      const track = findLibraryTrack(library, persistentId);
      if (!track) {
        missing.push(persistentId);
        continue;
      }
      music.duplicate(track, { to: playlist });
      added.push(persistentId);
    }
    return JSON.stringify({ ok: true, playlist: request.name, added, skippedExisting: [], missing });
  }

  if (request.operation === "appendPlaylist") {
    const playlist = findUserPlaylist(music, request.name);
    if (!playlist) {
      return JSON.stringify({ ok: false, code: "PLAYLIST_NOT_FOUND", message: "The requested user playlist does not exist." });
    }
    const existing = new Set(playlist.tracks().map(track => value(() => track.persistentID(), "").toUpperCase()));
    const added = [];
    const skippedExisting = [];
    const missing = [];
    for (const persistentId of request.persistentIds) {
      if (existing.has(persistentId.toUpperCase())) {
        skippedExisting.push(persistentId);
        continue;
      }
      const track = findLibraryTrack(library, persistentId);
      if (!track) {
        missing.push(persistentId);
        continue;
      }
      music.duplicate(track, { to: playlist });
      added.push(persistentId);
      existing.add(persistentId.toUpperCase());
    }
    return JSON.stringify({ ok: true, playlist: request.name, added, skippedExisting, missing });
  }

  throw new Error("Unsupported Music operation: " + request.operation);
}
`;