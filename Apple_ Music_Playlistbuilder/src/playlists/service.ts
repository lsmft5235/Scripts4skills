import type { PlaylistRequest, ResolutionResult, TrackQuery } from "../contracts.js";
import { rankCandidate, resolveTracks } from "../matching/resolver.js";
import type { MusicLibraryGateway, MusicPlaylistGateway, PlaylistMutationResult } from "../music/osascript-client.js";

export interface PlaylistPreview {
  schemaVersion: 1;
  name: string;
  description?: string;
  mode: PlaylistRequest["mode"];
  resolution: ResolutionResult;
  summary: {
    requested: number;
    resolved: number;
    skipped: number;
  };
}

export class PlaylistService {
  constructor(private readonly music: MusicLibraryGateway) {}

  async search(query: TrackQuery) {
    const candidates = await this.music.search(query);
    return candidates
      .map((candidate) => rankCandidate(query, candidate))
      .sort((left, right) => right.score - left.score || left.track.persistentId.localeCompare(right.track.persistentId));
  }

  async preview(request: PlaylistRequest): Promise<PlaylistPreview> {
    const candidatesByQuery = [];
    for (const query of request.tracks) {
      candidatesByQuery.push(await this.music.search(query));
    }
    const resolution = resolveTracks(request.tracks, candidatesByQuery);

    return {
      schemaVersion: 1,
      name: request.name,
      ...(request.description === undefined ? {} : { description: request.description }),
      mode: request.mode,
      resolution,
      summary: {
        requested: request.tracks.length,
        resolved: resolution.resolved.length,
        skipped: resolution.skipped.length,
      },
    };
  }

  async apply(request: PlaylistRequest): Promise<{ preview: PlaylistPreview; mutation: PlaylistMutationResult }> {
    if (!request.confirm) {
      throw new PlaylistServiceError("CONFIRMATION_REQUIRED", "Playlist mutations require confirm: true.");
    }
    if (request.mode === "synchronize") {
      throw new PlaylistServiceError(
        "SYNCHRONIZE_UNSUPPORTED",
        "Track synchronization is disabled until Music.app deletion and rebuild ordering pass a live temporary-playlist test.",
      );
    }

    const preview = await this.preview(request);
    const persistentIds = preview.resolution.resolved.map((item) => item.match.track.persistentId);
    if (persistentIds.length === 0) {
      throw new PlaylistServiceError("NO_RESOLVED_TRACKS", "No tracks met the matching threshold; Music.app was not changed.");
    }

    const gateway = this.music as Partial<MusicPlaylistGateway>;
    if (typeof gateway.createPlaylist !== "function" || typeof gateway.appendPlaylist !== "function") {
      throw new PlaylistServiceError("MUTATION_UNAVAILABLE", "The configured Music gateway is read-only.");
    }
    const mutation = request.mode === "create"
      ? await gateway.createPlaylist(request.name, request.description, persistentIds)
      : await gateway.appendPlaylist(request.name, persistentIds);
    return { preview, mutation };
  }
}

export class PlaylistServiceError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "PlaylistServiceError";
  }
}