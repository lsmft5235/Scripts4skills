#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

import { PlaylistRequestSchema, TrackQuerySchema } from "./contracts.js";
import { probeMusicCapabilities } from "./music/capabilities.js";
import { OsascriptMusicClient } from "./music/osascript-client.js";
import { PlaylistService } from "./playlists/service.js";

function toolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function toolError(error: unknown) {
  const value = error instanceof Error ? error : new Error(String(error));
  const code = "code" in value && typeof value.code === "string" ? value.code : "UNEXPECTED_ERROR";
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ code, message: value.message }) }],
  };
}

export function createMcpServer(service = new PlaylistService(new OsascriptMusicClient())): McpServer {
  const server = new McpServer({ name: "apple-music-playlist-builder", version: "0.1.0" });

  server.registerTool("music_capabilities", {
    description: "Inspect the installed macOS Music.app scripting capabilities. This tool is read-only.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  }, async () => toolResult(await probeMusicCapabilities()));

  server.registerTool("search_library", {
    description: "Search the user's synced Music.app library and return ranked candidates. Prefer persistent IDs from this result in later calls.",
    inputSchema: TrackQuerySchema,
    annotations: { readOnlyHint: true },
  }, async (query) => {
    try { return toolResult({ schemaVersion: 1, query, candidates: await service.search(query) }); }
    catch (error) { return toolError(error); }
  });

  server.registerTool("preview_playlist", {
    description: "Resolve a playlist request without changing Music.app. Always call this before create_playlist or update_playlist and show skipped matches to the user.",
    inputSchema: PlaylistRequestSchema,
    annotations: { readOnlyHint: true },
  }, async (request) => {
    try { return toolResult(await service.preview({ ...request, confirm: false })); }
    catch (error) { return toolError(error); }
  });

  server.registerTool("create_playlist", {
    description: "Create and populate a Music.app user playlist. Requires confirm=true after the user reviews preview_playlist.",
    inputSchema: PlaylistRequestSchema,
    annotations: { destructiveHint: true, idempotentHint: false },
  }, async (request) => {
    try { return toolResult(await service.apply({ ...request, mode: "create" })); }
    catch (error) { return toolError(error); }
  });

  server.registerTool("update_playlist", {
    description: "Append resolved tracks to an existing playlist. Synchronize is currently rejected until live rebuild ordering is verified. Requires confirm=true.",
    inputSchema: PlaylistRequestSchema,
    annotations: { destructiveHint: true, idempotentHint: false },
  }, async (request) => {
    try {
      if (request.mode === "create") throw new Error("update_playlist requires mode append or synchronize.");
      return toolResult(await service.apply(request));
    } catch (error) { return toolError(error); }
  });

  return server;
}

async function main(): Promise<void> {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}