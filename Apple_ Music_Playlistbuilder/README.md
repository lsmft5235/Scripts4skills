# Apple Music Playlist Builder

A local macOS tool that lets an AI agent search your synced Music library, preview track matching, and create or append to playlists in Music.app. It provides both a JSON CLI and an MCP stdio server.

## Requirements

- macOS with Music.app and a synced library
- Node.js 22 or newer
- Automation permission for the terminal or VS Code to control Music.app

## Setup

```sh
npm install
npm run build
npm test
npm run capabilities
```

On the first live Music operation, macOS may request Automation access. If denied, enable the calling application, shell, or Node process under **System Settings > Privacy & Security > Automation**.

## CLI

Commands that require JSON accept it from standard input or from a file path supplied as the final positional argument. Results are JSON on standard output; diagnostics are written to standard error.

```sh
printf '%s' '{"title":"Once in a Lifetime","artist":"Talking Heads"}' \
  | node dist/src/cli.js search

printf '%s' '{"name":"New Wave Mix","tracks":[{"title":"Once in a Lifetime","artist":"Talking Heads","genre":"New Wave"}]}' \
  | node dist/src/cli.js preview
```

Create and update require `"confirm":true`. Preview the identical request first and inspect skipped matches. Create rejects an existing playlist name. Append ignores tracks already present by persistent ID.

```sh
printf '%s' '{"name":"New Wave Mix","mode":"create","confirm":true,"tracks":[{"persistentId":"6FB138F279A48970"}]}' \
  | node dist/src/cli.js create
```

Available commands:

| Area | Commands |
| --- | --- |
| Music.app | `capabilities`, `search`, `preview`, `create`, `update` |
| Archive | `snapshot`, `sync-library`, `library-status`, `search-archive` |
| Enrichment | `enrichment-context`, `enrichment-batch`, `set-enrichment-status`, `import-enrichment`, `show-enrichment` |

### Matching Confidence

Metadata matching is deterministic. Persistent ID is authoritative. Otherwise, exact title is worth 50 points, artist 30, album 10, genre 5, and duration within two seconds 5. Partial text matches receive reduced weight. A candidate is selected only at 70 points or above and must lead the next candidate by at least 8 points. Weak and tied matches are reported as skipped rather than guessed.

## Long-Term Library Archive

The optional archive stores Music metadata in a local SQLite database. It does not copy audio or DRM-protected media. The default location is `data/music-library.sqlite`, which is excluded from Git.

Create the first snapshot or refresh an existing archive:

```sh
node dist/src/cli.js snapshot
```

`sync-library` is an alias for `snapshot`. Each refresh:

- Adds newly seen tracks.
- Updates changed metadata.
- Marks missing tracks as removed without deleting their records.
- Preserves append-only `added`, `updated`, and `removed` history entries.
- Records snapshot totals and timestamps.

Inspect archive status or search it without querying Music.app:

```sh
node dist/src/cli.js library-status

printf '%s' '{"title":"Once in a Lifetime","artist":"Talking Heads"}' \
  | node dist/src/cli.js search-archive
```

Archive search includes both current and removed tracks and reports `current`, `firstSeenAt`, `lastSeenAt`, and `removedAt`.

### Database Location

`MUSIC_LIBRARY_DB` changes the SQLite path for archive search and all enrichment commands. It also applies to `snapshot` and `library-status` when no positional database path is supplied. The default is `data/music-library.sqlite`.

```sh
MUSIC_LIBRARY_DB="$HOME/Private/music-library.sqlite" node dist/src/cli.js library-status
node dist/src/cli.js snapshot "$HOME/Private/music-library.sqlite"
```

The database contains personal library metadata, history, source URLs, and semantic annotations. Treat it as private user data. The default database and SQLite sidecar files are excluded by `.gitignore`; do not commit them. Back up the database to a private location. If only library metadata is needed after corruption, remove the database and run `snapshot` to rebuild it; enrichment history cannot be reconstructed from Music.app, so retain a private backup. Run `snapshot` periodically or after significant library changes; the tool does not run a background scheduler.

## Semantic Enrichment

The archive can retain revisioned, evidence-backed interpretations of track mood and sonic character. See [docs/semantic-enrichment.md](docs/semantic-enrichment.md) for the JSON schema, dimension definitions, source requirements, confidence guidance, and CLI examples.

The dedicated Bionic skill at `.agents/skills/music-semantic-enrichment/SKILL.md` guides a local model through identity resolution, responsible public-web research, synthesis, validated import, and revision review. Research records store concise paraphrased claims and source URLs, not copied articles or lyrics.

Audio analysis is explicitly out of scope. The project does not inspect audio files or use FFmpeg, Essentia, librosa, or audio-feature models. Semantic enrichment relies on public-source evidence, local-model interpretation, and manual review.

Commands:

```sh
node dist/src/cli.js enrichment-context query.json
node dist/src/cli.js enrichment-batch batch-request.json
node dist/src/cli.js set-enrichment-status status-update.json
node dist/src/cli.js import-enrichment enrichment.json
node dist/src/cli.js show-enrichment query.json
```

Batch workflow state supports `pending`, `in_progress`, `completed`, `review`, and `failed`. It is stored separately from Music metadata, so library snapshots never overwrite it. A successful enrichment import marks its track completed automatically.

## MCP

Build the project before starting the server:

```sh
npm run build
npm run mcp
```

The included `.vscode/mcp.json` registers the stdio server when this repository is opened as the VS Code workspace. It exposes:

- `music_capabilities`
- `search_library`
- `preview_playlist`
- `create_playlist`
- `update_playlist`

## LM Studio Bionic

Bionic's documented integration path is an Agent Skill using its coding shell tools, rather than a user-configured MCP server.

1. In Bionic, create a Project and enable **Allow coding**.
2. Choose this `Apple_ Music_Playlistbuilder` directory as the working folder.
3. Build the CLI once with `npm install && npm run build`.
4. Open **Settings > Skills** and add `.agents/skills/apple-music-playlist-builder/SKILL.md`, or type `@` in chat and select the skill if Bionic discovers project skills automatically.
5. Ask Bionic to search or build a playlist. It will preview matches and must wait for approval before running a mutation.

Example prompt:

> Use the Apple Music Playlist Builder skill to find Talking Heads songs in my library. Preview a playlist named Talking Heads Mix, show uncertain or skipped matches, and wait for my approval before creating it.

To maintain the long-term copy, ask:

> Use the Apple Music Playlist Builder skill to refresh my local library archive, then report what was added, updated, or removed.

The first Music operation may trigger a macOS Automation prompt. Allow Bionic, its shell, or its Node child process to control Music.app, depending on which process macOS displays.

## Current Limits

- Search covers tracks already present in the synced Music library, including cloud-only library tracks.
- Apple Music catalog search and MusicKit authorization are not implemented; only tracks already present in the synced library are eligible.
- Exact synchronize is deliberately disabled. Music.app does not expose direct track reordering, so delete-and-rebuild behavior must pass an opt-in temporary-playlist test first.
- Create has been exercised successfully against Music.app. Append has unit coverage but has not been live-tested against the real library.
- `npm test` is isolated and never mutates the real Music library. There is currently no automated live-test flag; live mutation verification is manual and requires explicit approval.
