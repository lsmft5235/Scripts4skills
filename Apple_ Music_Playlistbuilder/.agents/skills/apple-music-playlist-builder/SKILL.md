---
name: apple-music-playlist-builder
description: "Search a macOS Apple Music cloud library and preview, create, or append playlists. Use when the user asks LM Studio Bionic to find library tracks, resolve playlist ideas, or build a playlist in Music.app."
argument-hint: "Describe the playlist, desired tracks, and whether to create or append"
---

# Apple Music Playlist Builder

Use the project's JSON CLI through Bionic's shell tool. Run commands from the project root containing `package.json`.

## Prepare

1. If `dist/src/cli.js` is absent, run `npm install && npm run build`.
2. Run `node "$PWD/dist/src/cli.js" capabilities`.
3. Stop and explain the error if Music.app or its scripting dictionary is unavailable.

## Maintain the Library Archive

- Use `snapshot` to create or refresh the local long-term metadata archive at `data/music-library.sqlite` when the user asks to store, refresh, or preserve their library reference.
- Use `library-status` to report archive freshness and counts.
- Use `search-archive` when the user asks about previously seen or removed tracks, when Music.app is unavailable, or when a durable offline reference is preferred.
- A snapshot keeps missing tracks as historical records with `current: false`; it never deletes archived tracks or copies audio files.

```sh
node "$PWD/dist/src/cli.js" snapshot
node "$PWD/dist/src/cli.js" library-status
printf '%s' '{"title":"Once in a Lifetime","artist":"Talking Heads"}' \
  | node "$PWD/dist/src/cli.js" search-archive
```

## Search and Preview

1. For uncertain tracks, pipe a JSON query into the `search` command. Supply a title or persistent ID, plus any known artist, album, genre, or duration.
2. Never invent or alter persistent IDs. Reuse IDs returned by the tool.
3. Construct a playlist request with `name`, `mode`, `tracks`, and `confirm: false`.
4. Pipe it into the `preview` command.
5. Show the user resolved tracks, scores, skipped tracks, ambiguities, and duplicates. Do not mutate Music.app yet.

Example search:

```sh
printf '%s' '{"title":"Once in a Lifetime","artist":"Talking Heads"}' \
  | node "$PWD/dist/src/cli.js" search
```

Example preview:

```sh
printf '%s' '{"name":"New Wave Mix","mode":"create","confirm":false,"tracks":[{"persistentId":"6FB138F279A48970"}]}' \
  | node "$PWD/dist/src/cli.js" preview
```

## Apply

1. Wait for explicit user approval after showing the preview.
2. Use the same playlist name, mode, order, and track identities from the approved preview.
3. Change only `confirm` to `true`.
4. Run `create` for mode `create`, or `update` for mode `append`.
5. Report added, already-present, missing, and skipped tracks from the JSON result.

Do not attempt mode `synchronize`; it is intentionally disabled pending a safe live test. Do not claim to find catalog-only songs: this version searches only tracks already in the user's synced Music library.

Example confirmed creation:

```sh
printf '%s' '{"name":"New Wave Mix","mode":"create","confirm":true,"tracks":[{"persistentId":"6FB138F279A48970"}]}' \
  | node "$PWD/dist/src/cli.js" create
```

If macOS denies Automation access, ask the user to enable Bionic, its shell, or its Node child process under **System Settings > Privacy & Security > Automation**, according to the process macOS displays, then retry the read-only operation.