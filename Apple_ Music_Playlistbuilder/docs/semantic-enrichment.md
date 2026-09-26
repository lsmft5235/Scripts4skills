# Semantic Enrichment Schema

Semantic enrichment records describe a track's perceived emotional and sonic character using evidence from public web resources. They are interpretations with confidence scores, not objective audio facts.

Local audio analysis is intentionally excluded. Do not infer that these records contain measured audio features, and do not introduce FFmpeg, Essentia, librosa, or audio-model output into this schema.

Each import creates an immutable revision. The archive points to the newest revision while retaining prior research and its sources.

For constrained generation or external validation, use the machine-readable [JSON Schema](semantic-enrichment.schema.json). The CLI applies the equivalent Zod contract before every import.

## Persistent Workflow State

Enrichment progress is stored separately from Music library metadata and is never overwritten by `snapshot` or `sync-library`.

| Status | Meaning |
| --- | --- |
| `pending` | No work has begun. Tracks without a workflow row or enrichment revision derive this status automatically. |
| `in_progress` | A worker has started research. Each transition into this state increments `attemptCount`. |
| `completed` | A valid enrichment was imported. Import sets this automatically. |
| `review` | Research exists or was attempted, but human review is needed. |
| `failed` | The attempt could not complete; use `notes` for the reason. |

Workflow state also retains `updatedAt`, `completedAt`, `schemaVersion`, `model`, `notes`, and `attemptCount`. A future schema revision can therefore identify completed records that need refreshing without losing their prior completion history.

Select a batch of pending current tracks, optionally filtered by genre:

```sh
printf '%s' '{"status":"pending","limit":10,"genre":"industrial"}' \
  | node dist/src/cli.js enrichment-batch
```

Mark a track before beginning research:

```sh
printf '%s' '{"persistentId":"615B9C8F8E3766A4","status":"in_progress","model":"local-model/version"}' \
  | node dist/src/cli.js set-enrichment-status
```

Successful `import-enrichment` marks the track `completed`. For an unsuccessful attempt, explicitly set `review` or `failed` with a short note.

## Identity and Provenance

| Field | Type | Meaning |
| --- | --- | --- |
| `schemaVersion` | `1` | Contract version. |
| `persistentId` | string | Exact Music.app persistent ID returned by `enrichment-context`. |
| `createdAt` | ISO 8601 UTC datetime | Time the research record was assembled. |
| `model` | string | Local model and version that synthesized the record. |
| `summary` | string, 1-1200 characters | Original concise synthesis of the track's affect and sonic character. |
| `confidence` | number, 0-1 | Overall confidence after considering source quality, agreement, and track specificity. |

## Dimensions

All dimensions range from `0` to `1`. Use `0.5` when evidence genuinely supports a middle value; do not use it merely because evidence is absent. Low evidence belongs in `confidence`.

| Dimension | `0` | `1` |
| --- | --- | --- |
| `valence` | sorrowful, hostile, bleak | joyful, affirming, euphoric |
| `energy` | still, restrained, sparse | forceful, fast, intense |
| `tension` | settled, open, relaxed | anxious, abrasive, suspenseful |
| `warmth` | cold, clinical, distant | intimate, organic, comforting |
| `danceability` | arrhythmic or contemplative | steady, bodily, groove-forward |
| `darkness` | bright, playful, weightless | ominous, severe, morbid |
| `experimentalism` | conventional form and timbre | unusual structure, process, or sound design |

## Descriptors

- `moods`: 1-12 short affective terms, such as `menacing`, `euphoric`, or `melancholic`.
- `textures`: 0-12 sonic-material terms, such as `metallic`, `granular`, or `lush`.
- `themes`: 0-12 concise conceptual themes. Include only themes supported by sources specific to the track or release.
- Prefer lowercase descriptors and stable vocabulary. Avoid near-duplicates in one record.

## Sources

Every record requires at least one source and supports at most 20. Each source contains:

| Field | Requirement |
| --- | --- |
| `url` | Public HTTP or HTTPS page URL. |
| `title` | Page or document title. |
| `publisher` | Optional site, publication, artist, or label name. |
| `accessedAt` | ISO 8601 UTC datetime. |
| `sourceType` | `review`, `interview`, `artist`, `label`, `database`, or `other`. |
| `claims` | 1-8 original paraphrases, each at most 500 characters, describing evidence used in the synthesis. |

Do not store article bodies, lyrics, paywalled text, or substantial quotations. Respect site terms, robots restrictions, access controls, and rate limits. Do not bypass authentication or anti-bot measures. A search-result snippet alone is weak evidence and should not be represented as a fully reviewed source.

## Confidence Guidance

- `0.85-1.00`: several independent, track-specific, reputable sources agree.
- `0.65-0.84`: good track- or release-specific evidence with limited disagreement.
- `0.40-0.64`: primarily release/artist context or sparse track-specific evidence.
- Below `0.40`: do not import unless the user explicitly wants speculative annotations.

Reduce confidence when sources discuss only the album or artist, versions may differ, sources repeat one another, or emotional dimensions require substantial inference.

## Example

```json
{
  "schemaVersion": 1,
  "persistentId": "615B9C8F8E3766A4",
  "createdAt": "2026-09-25T12:00:00.000Z",
  "model": "local-model-name/version",
  "summary": "A severe, propulsive industrial piece whose repeated rhythmic figures create mounting urgency while abrasive timbres keep the atmosphere cold and confrontational.",
  "dimensions": {
    "valence": 0.22,
    "energy": 0.84,
    "tension": 0.81,
    "warmth": 0.18,
    "danceability": 0.67,
    "darkness": 0.76,
    "experimentalism": 0.72
  },
  "moods": ["urgent", "severe", "obsessive"],
  "textures": ["metallic", "abrasive", "mechanical"],
  "themes": ["unstable intimacy", "repetition"],
  "confidence": 0.7,
  "sources": [
    {
      "url": "https://example.org/public-review",
      "title": "Public review title",
      "publisher": "Example Publication",
      "accessedAt": "2026-09-25T11:45:00.000Z",
      "sourceType": "review",
      "claims": [
        "The reviewer characterizes the track as rhythmically insistent and sonically abrasive."
      ]
    }
  ]
}
```

## CLI Workflow

Resolve identity and inspect prior research:

```sh
printf '%s' '{"title":"Die Interimsliebenden","artist":"Einstürzende Neubauten"}' \
  | node dist/src/cli.js enrichment-context
```

After choosing one exact persistent ID, save one JSON record outside the repository and import it:

```sh
node dist/src/cli.js import-enrichment /tmp/music-enrichment.json
```

Display the latest record and all immutable revisions:

```sh
printf '%s' '{"persistentId":"615B9C8F8E3766A4"}' \
  | node dist/src/cli.js show-enrichment
```
