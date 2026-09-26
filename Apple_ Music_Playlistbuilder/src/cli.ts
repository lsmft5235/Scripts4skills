#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import { LibraryArchive } from "./archive/library-archive.js";
import {
  EnrichmentBatchRequestSchema,
  EnrichmentWorkflowUpdateSchema,
  PlaylistRequestSchema,
  SemanticEnrichmentSchema,
  TrackQuerySchema,
} from "./contracts.js";
import { probeMusicCapabilities } from "./music/capabilities.js";
import { OsascriptMusicClient } from "./music/osascript-client.js";
import { PlaylistService } from "./playlists/service.js";

async function readJsonInput(path: string | undefined): Promise<unknown> {
  const text = path
    ? await readFile(path, "utf8")
    : await new Promise<string>((resolve, reject) => {
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk: string) => { input += chunk; });
      process.stdin.on("end", () => resolve(input));
      process.stdin.on("error", reject);
    });
  return JSON.parse(text);
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<void> {
  const command = process.argv[2];

  if (command === "capabilities") {
    const result = await probeMusicCapabilities();
    writeJson(result);
    if (!result.musicInstalled || !result.dictionaryAvailable) process.exitCode = 1;
    return;
  }

  if (command === "library-status") {
    const archive = await LibraryArchive.open(process.argv[3]);
    try { writeJson(archive.status()); } finally { archive.close(); }
    return;
  }

  if (command === "search-archive") {
    const input = TrackQuerySchema.parse(await readJsonInput(process.argv[3]));
    const archive = await LibraryArchive.open(process.env.MUSIC_LIBRARY_DB);
    try { writeJson({ schemaVersion: 1, query: input, tracks: archive.search(input) }); }
    finally { archive.close(); }
    return;
  }

  if (command === "enrichment-context") {
    const input = TrackQuerySchema.parse(await readJsonInput(process.argv[3]));
    const archive = await LibraryArchive.open(process.env.MUSIC_LIBRARY_DB);
    try { writeJson({ schemaVersion: 1, query: input, matches: archive.enrichmentContext(input) }); }
    finally { archive.close(); }
    return;
  }

  if (command === "enrichment-batch") {
    const input = EnrichmentBatchRequestSchema.parse(await readJsonInput(process.argv[3]));
    const archive = await LibraryArchive.open(process.env.MUSIC_LIBRARY_DB);
    try { writeJson({ schemaVersion: 1, request: input, tracks: archive.enrichmentBatch(input) }); }
    finally { archive.close(); }
    return;
  }

  if (command === "set-enrichment-status") {
    const input = EnrichmentWorkflowUpdateSchema.parse(await readJsonInput(process.argv[3]));
    const archive = await LibraryArchive.open(process.env.MUSIC_LIBRARY_DB);
    try { writeJson(archive.setEnrichmentWorkflow(input)); }
    finally { archive.close(); }
    return;
  }

  if (command === "import-enrichment") {
    const input = SemanticEnrichmentSchema.parse(await readJsonInput(process.argv[3]));
    const archive = await LibraryArchive.open(process.env.MUSIC_LIBRARY_DB);
    try { writeJson(archive.importEnrichment(input)); }
    finally { archive.close(); }
    return;
  }

  if (command === "show-enrichment") {
    const input = TrackQuerySchema.parse(await readJsonInput(process.argv[3]));
    const archive = await LibraryArchive.open(process.env.MUSIC_LIBRARY_DB);
    try {
      const matches = archive.enrichmentContext(input).map(({ track, latestEnrichment, workflow }) => ({
        track,
        latestEnrichment,
        workflow,
        history: archive.enrichmentHistory(track.persistentId),
      }));
      writeJson({ schemaVersion: 1, query: input, matches });
    } finally { archive.close(); }
    return;
  }

  const music = new OsascriptMusicClient();
  if (command === "snapshot" || command === "sync-library") {
    const archive = await LibraryArchive.open(process.argv[3]);
    try { writeJson(archive.snapshot(await music.listLibrary())); }
    finally { archive.close(); }
    return;
  }

  const service = new PlaylistService(music);
  if (command === "search") {
    const query = TrackQuerySchema.parse(await readJsonInput(process.argv[3]));
    writeJson({ schemaVersion: 1, query, candidates: await service.search(query) });
    return;
  }
  if (command === "preview") {
    const request = PlaylistRequestSchema.parse(await readJsonInput(process.argv[3]));
    writeJson(await service.preview(request));
    return;
  }
  if (command === "create" || command === "update") {
    const request = PlaylistRequestSchema.parse(await readJsonInput(process.argv[3]));
    const expectedMode = command === "create" ? "create" : request.mode;
    if (command === "create" && request.mode !== "create") {
      throw new Error("The create command requires mode: create.");
    }
    if (command === "update" && expectedMode === "create") {
      throw new Error("The update command requires mode: append or synchronize.");
    }
    writeJson(await service.apply(request));
    return;
  }

  process.stderr.write("Usage: apple-music-playlist <capabilities|search|preview|create|update|snapshot|sync-library|library-status|search-archive|enrichment-context|enrichment-batch|set-enrichment-status|import-enrichment|show-enrichment> [input]\n");
  process.exitCode = 2;
}

main().catch((error: unknown) => {
  const value = error instanceof Error ? error : new Error(String(error));
  const code = "code" in value && typeof value.code === "string" ? value.code : "UNEXPECTED_ERROR";
  process.stderr.write(`${JSON.stringify({ code, message: value.message })}\n`);
  process.exitCode = 1;
});