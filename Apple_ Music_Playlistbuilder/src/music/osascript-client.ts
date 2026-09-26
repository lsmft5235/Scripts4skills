import { execFile } from "node:child_process";

import { TrackCandidateSchema, type TrackCandidate, type TrackQuery } from "../contracts.js";
import { MUSIC_MUTATION_APPLESCRIPT } from "./applescript-source.js";
import { MUSIC_JXA_SOURCE } from "./jxa-source.js";

export interface MusicLibraryGateway {
  search(query: TrackQuery, limit?: number): Promise<TrackCandidate[]>;
  listLibrary?(): Promise<TrackCandidate[]>;
}

export interface PlaylistMutationResult {
  ok: true;
  playlist: string;
  added: string[];
  skippedExisting: string[];
  missing: string[];
}

export interface MusicPlaylistGateway extends MusicLibraryGateway {
  createPlaylist(name: string, description: string | undefined, persistentIds: string[]): Promise<PlaylistMutationResult>;
  appendPlaylist(name: string, persistentIds: string[]): Promise<PlaylistMutationResult>;
}

export interface OsascriptClientOptions {
  timeoutMs?: number;
  maxBufferBytes?: number;
}

interface SearchResponse {
  tracks: unknown[];
}

export class MusicAutomationError extends Error {
  constructor(
    public readonly code: "MUSIC_TIMEOUT" | "MUSIC_PERMISSION_DENIED" | "MUSIC_SCRIPT_ERROR" | "INVALID_MUSIC_RESPONSE",
    message: string,
  ) {
    super(message);
    this.name = "MusicAutomationError";
  }
}

export class OsascriptMusicClient implements MusicPlaylistGateway {
  readonly #timeoutMs: number;
  readonly #maxBufferBytes: number;

  constructor(options: OsascriptClientOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#maxBufferBytes = options.maxBufferBytes ?? 2 * 1024 * 1024;
  }

  async search(query: TrackQuery, limit = 25): Promise<TrackCandidate[]> {
    const response = await this.#execute<SearchResponse>({ operation: "search", query, limit });
    if (!Array.isArray(response.tracks)) {
      throw new MusicAutomationError("INVALID_MUSIC_RESPONSE", "Music.app returned an invalid search response.");
    }
    return response.tracks.map((track) => TrackCandidateSchema.parse(track));
  }

  async listLibrary(): Promise<TrackCandidate[]> {
    const response = await this.#execute<SearchResponse>(
      { operation: "listLibrary" },
      { timeoutMs: Math.max(this.#timeoutMs, 120_000), maxBufferBytes: Math.max(this.#maxBufferBytes, 64 * 1024 * 1024) },
    );
    if (!Array.isArray(response.tracks)) {
      throw new MusicAutomationError("INVALID_MUSIC_RESPONSE", "Music.app returned an invalid library response.");
    }
    return response.tracks.map((track) => TrackCandidateSchema.parse(track));
  }

  async createPlaylist(name: string, description: string | undefined, persistentIds: string[]): Promise<PlaylistMutationResult> {
    return this.#mutate("create", name, description, persistentIds);
  }

  async appendPlaylist(name: string, persistentIds: string[]): Promise<PlaylistMutationResult> {
    return this.#mutate("append", name, undefined, persistentIds);
  }

  async #mutate(
    operation: "create" | "append",
    name: string,
    description: string | undefined,
    persistentIds: string[],
  ): Promise<PlaylistMutationResult> {
    const output = await this.#runOsascript(
      ["-e", MUSIC_MUTATION_APPLESCRIPT, operation, name, description ?? "", ...persistentIds],
      Math.max(this.#timeoutMs, 120_000),
      this.#maxBufferBytes,
    );
    const [added = "", skippedExisting = "", missing = ""] = output.trim().split("|");
    const splitIds = (value: string): string[] => value === "" ? [] : value.split(",");
    return {
      ok: true,
      playlist: name,
      added: splitIds(added),
      skippedExisting: splitIds(skippedExisting),
      missing: splitIds(missing),
    };
  }

  async #execute<T>(
    request: unknown,
    overrides: { timeoutMs?: number; maxBufferBytes?: number } = {},
  ): Promise<T> {
    const input = JSON.stringify(request);
    const timeoutMs = overrides.timeoutMs ?? this.#timeoutMs;
    const maxBufferBytes = overrides.maxBufferBytes ?? this.#maxBufferBytes;
    const output = await this.#runOsascript(
      ["-l", "JavaScript", "-e", MUSIC_JXA_SOURCE, input],
      timeoutMs,
      maxBufferBytes,
    );

    try {
      return JSON.parse(output) as T;
    } catch {
      throw new MusicAutomationError("INVALID_MUSIC_RESPONSE", "Music.app returned output that was not valid JSON.");
    }
  }

  async #runOsascript(argumentsList: string[], timeoutMs: number, maxBufferBytes: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      execFile(
        "osascript",
        argumentsList,
        { encoding: "utf8", timeout: timeoutMs, maxBuffer: maxBufferBytes },
        (error, stdout, stderr) => {
          if (!error) {
            resolve(stdout);
            return;
          }
          if (error.killed) {
            reject(new MusicAutomationError("MUSIC_TIMEOUT", `Music.app did not respond within ${timeoutMs} ms.`));
            return;
          }
          const detail = stderr.trim() || error.message;
          const permissionDenied = /not authorized|not permitted|-1743/i.test(detail);
          reject(new MusicAutomationError(
            permissionDenied ? "MUSIC_PERMISSION_DENIED" : "MUSIC_SCRIPT_ERROR",
            permissionDenied
              ? "Automation access to Music.app was denied. Enable it in System Settings > Privacy & Security > Automation."
              : detail,
          ));
        },
      );
    });
  }
}