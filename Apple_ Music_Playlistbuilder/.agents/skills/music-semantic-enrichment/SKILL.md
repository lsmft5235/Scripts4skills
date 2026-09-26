---
name: music-semantic-enrichment
description: "Research public web sources with a local LLM and add evidence-backed moods, textures, themes, and emotional dimensions to the private Apple Music archive. Use for vibe checks, emotive qualia, semantic enrichment, track research, and mood annotation."
argument-hint: "Name a track, album, artist, or batch to research and enrich"
---

# Music Semantic Enrichment

Research track character from public resources and import a compact, evidence-backed annotation into the local SQLite archive. Run shell commands from the project root containing `package.json`.

Read [the schema and scoring guide](../../../docs/semantic-enrichment.md) before generating a record. Use [the JSON Schema](../../../docs/semantic-enrichment.schema.json) for constrained output when the local model supports it.

## Resolve Track Identity

1. Build first if `dist/src/cli.js` is absent: `npm install && npm run build`.
2. Call `enrichment-context` with title and artist, or an exact persistent ID.
3. If multiple versions match, show album, duration, genre, and persistent ID and ask the user which version to enrich. Never merge versions or invent an ID.
4. Inspect `latestEnrichment`. Avoid repeating research unless the user requests a refresh or existing confidence is low.

```sh
printf '%s' '{"title":"Die Interimsliebenden","artist":"Einstürzende Neubauten"}' \
  | node "$PWD/dist/src/cli.js" enrichment-context
```

## Research Public Sources

1. Search for the exact track plus artist. Add album/release information to distinguish versions.
2. Prioritize artist or label notes, interviews, reputable reviews, and established music databases. Seek track-specific evidence; album-level evidence is secondary.
3. Open and inspect each cited page. Do not cite a result solely from a search snippet.
4. Respect robots restrictions, site terms, rate limits, paywalls, and access controls. Do not bypass blocking or authentication.
5. Do not collect or store article bodies, lyrics, or substantial quotations. Record short original paraphrases of only the claims used.
6. Distinguish sourced description from inference. Score confidence lower when evidence concerns only the artist, album, or a potentially different version.
7. Prefer two independent sources. One strong source is acceptable with appropriately reduced confidence.

## Synthesize and Import

1. Produce exactly one schema-version-1 JSON object for one persistent ID.
2. Use the documented definitions for all seven dimensions. Every number must be between 0 and 1.
3. Keep the summary original and concise. Use lowercase, nonduplicative descriptor terms.
4. Include the local model name/version and current UTC timestamps.
5. Write the candidate JSON to `/tmp/music-enrichment.json` unless the user explicitly requests another location.
6. Import it with `import-enrichment`. The command validates the schema and rejects unknown persistent IDs.
7. Run `show-enrichment` and report the assigned revision ID, confidence, dimensions, descriptors, and source URLs.

```sh
node "$PWD/dist/src/cli.js" import-enrichment /tmp/music-enrichment.json
printf '%s' '{"persistentId":"PERSISTENT_ID"}' \
  | node "$PWD/dist/src/cli.js" show-enrichment
```

An import creates an immutable revision and makes it the latest view. Never edit the SQLite database directly. Do not claim the dimensions are objective measurements; describe them as evidence-backed interpretations.

## Batch Work

- Request a small pending batch with `enrichment-batch`. Use a genre filter when requested.
- Before researching each track, set its status to `in_progress`, including the local model name. This increments its attempt count and prevents it from appearing in later pending batches.
- Resolve all IDs before research, but import one JSON document per track. A successful import automatically marks that track `completed` with schema version, model, and completion time.
- If evidence is insufficient or identity remains ambiguous, set status to `review` and explain why in `notes`.
- If tools or sources prevent completion, set status to `failed` with a concise reason. Do not leave abandoned tracks `in_progress`.
- Reuse release-level sources only when their claims genuinely apply, and lower confidence for tracks not discussed individually.
- Pause and report blockers rather than fabricating evidence or URLs.

```sh
printf '%s' '{"status":"pending","limit":5,"genre":"industrial"}' \
  | node "$PWD/dist/src/cli.js" enrichment-batch

printf '%s' '{"persistentId":"PERSISTENT_ID","status":"in_progress","model":"MODEL_NAME_VERSION"}' \
  | node "$PWD/dist/src/cli.js" set-enrichment-status
```

Workflow state lives outside snapshot-managed track fields. Refreshing the Music archive never resets completed, review, failed, or in-progress state.

Do not perform local audio analysis or add audio-analysis dependencies. This workflow uses public-source evidence, local-model interpretation, and manual review only.