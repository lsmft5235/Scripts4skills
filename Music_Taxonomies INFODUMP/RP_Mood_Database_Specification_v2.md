# Technical Specification v2: MusicBrainz Resolution and AcousticBrainz Mood Cache

## 1. Purpose and Scope

This system enriches tracks already present in a user's Apple Music library with frozen AcousticBrainz high-level classifier outputs.

The lookup proceeds in two explicit stages:

1. Resolve an Apple Music track to a **MusicBrainz Recording MBID** using artist and track title as required inputs, with album title and duration as optional disambiguators.
2. Use the accepted Recording MBID to retrieve mood classifier values from a local SQLite conversion of the June 2022 AcousticBrainz high-level JSON dump.

Apple Music persistent IDs remain the authoritative identity inside the user's library. Recording MBIDs are external mappings with confidence and provenance; they do not replace Apple IDs.

The baseline mood fields are:

- `mood_happy`
- `mood_sad`
- `mood_aggressive`
- `danceability_highlevel`

These are independent classifier probabilities, not mutually exclusive percentages and not objective descriptions of human emotional experience.

### 1.1 Out of Scope

- Decoding or analyzing local audio files
- FFmpeg, Essentia, librosa, or new audio-model execution
- Apple Music catalog search for tracks absent from the user's library
- Treating an uncertain MusicBrainz match as accepted without review
- Replacing evidence-backed semantic enrichment with AcousticBrainz predictions

---

## 2. Architecture

```text
Apple Music library archive
  tracks(persistent_id, title, artist, album, duration_seconds, ...)
                 |
                 | resolve identity
                 v
MusicBrainz resolver
  API mode OR local dump/index mode
                 |
                 | accepted Recording MBID
                 v
track_recording_matches
  persistent_id -> recording_mbid + status + score + evidence
                 |
                 | join by Recording MBID
                 v
AcousticBrainz SQLite cache
    ab_submissions -> ab_feature_clusters
                 |
                 v
Mood-aware playlist selection over tracks in the user's library
```

The implementation should keep the private Apple Music archive and the large public AcousticBrainz cache in separate SQLite files:

- `data/music-library.sqlite`: private library, MBID mappings, workflow, and semantic annotations
- `data/acousticbrainz-20220623.sqlite`: reproducible cache built from public frozen dumps

For this project, the baseline is a **library-filtered public cache**. Resolve library tracks first, then retain AcousticBrainz submissions and canonical feature clusters only for accepted Recording MBIDs and known historical aliases. The ingestion process may still need to scan every full archive, but the resulting database remains proportional to the user's library rather than to all AcousticBrainz submissions.

A reusable global cache is a separate future deployment profile. It must use a different storage plan and must not be assumed by the baseline implementation.

---

## 3. Source Data

### 3.1 MusicBrainz Identity Source

The resolver supports two interchangeable providers.

#### API Mode

Use the MusicBrainz recording search endpoint:

```text
GET https://musicbrainz.org/ws/2/recording?query=...&fmt=json&limit=10
```

Useful recording search fields include:

- `recording`: track or recording title
- `artist` or `artistname`: credited artist
- `release`: album or release title
- `dur`: duration in milliseconds
- `qdur`: quantized duration
- `rid`: Recording MBID

Requirements:

- Escape Lucene special characters and URL-encode the query.
- Send a meaningful contactable `User-Agent`, such as `AppleMusicPlaylistBuilder/0.1 (contact-url-or-email)`.
- Average no more than one request per second per source IP unless MusicBrainz grants another arrangement.
- Cache every response and resolution decision. Do not poll resolved tracks repeatedly.
- Retry `503` and transient network failures with bounded exponential backoff and jitter.

API mode is simple but slow for an initial library of roughly 26,000 tracks. At one request per second, a full uncached pass requires at least several hours.

#### Local Dump Mode

The proof of concept uses API mode as the normative provider. A local dump provider may be added only after selecting and validating one concrete MusicBrainz source whose fields satisfy the resolver requirements. Possible sources include the full MusicBrainz database dump or a canonical derived dump, but they are not interchangeable and must not be treated as such without a format spike.

Every provider must expose the same normalized candidate evidence shape:

```json
{
  "recordingMbid": "uuid",
  "title": "Track title",
  "artistCredit": "Artist name",
  "durationMs": 240000,
  "releases": ["Album title"],
    "providerRank": 1,
    "providerScore": 100,
    "providerScoreKind": "musicbrainz-lucene"
}
```

`providerScore` is nullable and provider-specific. A MusicBrainz Lucene score, an FTS5 rank, and any future provider score are not numerically comparable. They may order candidates within one provider response but must not contribute directly to cross-provider acceptance.

A local index must support title, artist credit, release title, and duration. FTS5 is appropriate for candidate retrieval, but final acceptance must use the deterministic metadata scorer in Section 5. Before implementation, document the selected dump's exact files or tables, update cadence, license, and transformation into the common candidate shape.

Dump mode is preferred for bulk resolution because it avoids API rate limits. API mode remains useful for a proof of concept, incremental tracks, or fallback verification.

### 3.2 AcousticBrainz Mood Source

Use the frozen high-level JSON dump:

[AcousticBrainz High-Level JSON Directory](https://data.metabrainz.org/pub/musicbrainz/acousticbrainz/dumps/acousticbrainz-highlevel-json-20220623/)

Verified characteristics:

- 30 `.tar.zst` archives
- Approximately 29.46 million submissions, not 29.46 million unique recordings
- Archive members use paths resembling `highlevel/m/b/i/d/recording-mbid-N.json`
- `N` is a duplicate-submission ordinal; ordinal `0` always exists
- One Recording MBID can have multiple submissions
- SHA-256 manifests are published with the dump

For pipeline development, first use the 100,000-item sample:

[AcousticBrainz Sample JSON Directory](https://data.metabrainz.org/pub/musicbrainz/acousticbrainz/dumps/acousticbrainz-sample-json-20220623/)

The high-level JSON contains mood classifier output and submission metadata. It does not provide the authoritative current MusicBrainz metadata index used to resolve the user's tracks. Historical Recording MBIDs in the 2022 dump may since have been merged or redirected by MusicBrainz.

### 3.3 Optional Rhythm Source

BPM is not a high-level mood classifier. If BPM is required, import it separately from the AcousticBrainz rhythm feature archive:

[AcousticBrainz Low-Level Feature Directory](https://data.metabrainz.org/pub/musicbrainz/acousticbrainz/dumps/acousticbrainz-lowlevel-features-20220623/)

The rhythm feature dataset includes `bpm`, low-level `danceability`, onset rate, and related values. Keep low-level danceability separate from the high-level classifier:

- `danceability_highlevel`
- `danceability_lowlevel`

The baseline proof of concept may omit BPM and the low-level feature archives entirely.

---

## 4. Database Schema

### 4.1 Private Library: MusicBrainz Resolution Tables

These tables belong in `music-library.sqlite` next to the existing `tracks` table.

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS track_recording_matches (
    persistent_id TEXT PRIMARY KEY,
    current_recording_mbid TEXT,
    acousticbrainz_recording_mbid TEXT,
    status TEXT NOT NULL CHECK (
        status IN ('pending', 'matched', 'ambiguous', 'missing', 'review', 'rejected')
    ),
    match_score REAL,
    score_margin REAL,
    provider TEXT CHECK (provider IN ('api', 'dump', 'manual')),
    resolver_version TEXT NOT NULL,
    query_title TEXT NOT NULL,
    query_artist TEXT NOT NULL,
    query_album TEXT,
    query_duration_ms INTEGER,
    matched_at TEXT,
    reviewed_at TEXT,
    notes TEXT,
    CHECK (
        status <> 'matched'
        OR current_recording_mbid IS NOT NULL
    ),
    FOREIGN KEY (persistent_id) REFERENCES tracks(persistent_id)
);

CREATE INDEX IF NOT EXISTS idx_track_recording_mbid
    ON track_recording_matches(current_recording_mbid);

CREATE INDEX IF NOT EXISTS idx_track_acousticbrainz_mbid
    ON track_recording_matches(acousticbrainz_recording_mbid);

CREATE INDEX IF NOT EXISTS idx_track_recording_status
    ON track_recording_matches(status, matched_at);

CREATE TABLE IF NOT EXISTS recording_resolution_runs (
    id INTEGER PRIMARY KEY,
    persistent_id TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('api', 'dump', 'manual')),
    resolver_version TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
    error TEXT,
    FOREIGN KEY (persistent_id) REFERENCES tracks(persistent_id)
);

CREATE TABLE IF NOT EXISTS recording_match_candidates (
    resolution_run_id INTEGER NOT NULL,
    recording_mbid TEXT NOT NULL,
    rank INTEGER NOT NULL,
    provider_score REAL,
    provider_score_kind TEXT,
    local_score REAL NOT NULL,
    title TEXT NOT NULL,
    artist_credit TEXT NOT NULL,
    duration_ms INTEGER,
    releases_json TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    PRIMARY KEY (resolution_run_id, recording_mbid),
    FOREIGN KEY (resolution_run_id) REFERENCES recording_resolution_runs(id)
);

CREATE TABLE IF NOT EXISTS recording_mbid_aliases (
    current_recording_mbid TEXT NOT NULL,
    source_recording_mbid TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('musicbrainz-redirect', 'manual')),
    observed_at TEXT NOT NULL,
    PRIMARY KEY (current_recording_mbid, source_recording_mbid)
) WITHOUT ROWID;
```

Do not add MBID directly to `tracks` as an unqualified fact. The separate mapping tables preserve uncertainty, candidate history, resolver versions, historical redirects, and manual decisions across library snapshots.

`current_recording_mbid` is the accepted current MusicBrainz identity. `acousticbrainz_recording_mbid` is nullable and is populated only when the frozen cache contains the current MBID or a known historical redirected value. It may be the same value as the current MBID or a historical alias. Never assume current and frozen-dataset MBIDs are identical, and never downgrade a valid MusicBrainz identity match merely because AcousticBrainz has no mood data.

Normalize every MBID to lowercase canonical UUID form at all boundaries. Reject malformed identifiers before insertion.

### 4.2 AcousticBrainz Ingestion Manifest

```sql
CREATE TABLE IF NOT EXISTS ab_ingestion_runs (
    id INTEGER PRIMARY KEY,
    dataset_name TEXT NOT NULL,
    dataset_date TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
    selection_policy TEXT NOT NULL,
    parser_version TEXT NOT NULL,
    rows_seen INTEGER NOT NULL DEFAULT 0,
    rows_imported INTEGER NOT NULL DEFAULT 0,
    rows_rejected INTEGER NOT NULL DEFAULT 0,
    error TEXT
);

CREATE TABLE IF NOT EXISTS ab_ingestion_archives (
    run_id INTEGER NOT NULL,
    archive_name TEXT NOT NULL,
    expected_sha256 TEXT NOT NULL,
    observed_sha256 TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    members_seen INTEGER NOT NULL DEFAULT 0,
    last_member_path TEXT,
    error TEXT,
    PRIMARY KEY (run_id, archive_name),
    FOREIGN KEY (run_id) REFERENCES ab_ingestion_runs(id)
);
```

### 4.3 Raw AcousticBrainz Submissions

Retain one row per `(recording_mbid, submission_ordinal)`. This prevents silent loss of duplicate submissions and permits future changes to the canonical selection policy.

```sql
CREATE TABLE IF NOT EXISTS ab_submissions (
    recording_mbid TEXT NOT NULL,
    submission_ordinal INTEGER NOT NULL,
    mood_happy REAL CHECK (mood_happy BETWEEN 0.0 AND 1.0),
    mood_sad REAL CHECK (mood_sad BETWEEN 0.0 AND 1.0),
    mood_aggressive REAL CHECK (mood_aggressive BETWEEN 0.0 AND 1.0),
    danceability_highlevel REAL CHECK (danceability_highlevel BETWEEN 0.0 AND 1.0),
    audio_length_seconds REAL,
    mood_happy_model_signature TEXT,
    mood_sad_model_signature TEXT,
    mood_aggressive_model_signature TEXT,
    danceability_model_signature TEXT,
    complete_model_signature TEXT NOT NULL,
    essentia_version TEXT,
    gaia_version TEXT,
    source_archive TEXT NOT NULL,
    source_member TEXT NOT NULL,
    ingestion_run_id INTEGER NOT NULL,
    PRIMARY KEY (recording_mbid, submission_ordinal),
    FOREIGN KEY (ingestion_run_id) REFERENCES ab_ingestion_runs(id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_ab_submission_model
    ON ab_submissions(complete_model_signature, recording_mbid);
```

Missing classifier output must be stored as `NULL`, never `0.0`. Zero means the classifier explicitly assigned zero probability.

The complete model signature is a deterministic hash of the normalized version objects for all retained classifiers and the relevant `metadata.version.highlevel` fields. Individual classifier signatures remain queryable because submissions can contain mixed classifier versions.

For an idempotent rerun of the same frozen dataset, use `INSERT ... ON CONFLICT DO NOTHING` only after verifying that the existing row has the same source archive, member path, checksum context, parsed values, and model signatures. Any mismatch is an ingestion error; do not silently replace it. Importing a different dataset date requires a separate database or adding dataset identity to every primary key.

### 4.4 Canonical AcousticBrainz Features

```sql
CREATE TABLE IF NOT EXISTS ab_feature_clusters (
    recording_mbid TEXT NOT NULL,
    duration_cluster_id INTEGER NOT NULL,
    duration_median_seconds REAL NOT NULL,
    duration_min_seconds REAL NOT NULL,
    duration_max_seconds REAL NOT NULL,
    mood_happy REAL CHECK (mood_happy BETWEEN 0.0 AND 1.0),
    mood_sad REAL CHECK (mood_sad BETWEEN 0.0 AND 1.0),
    mood_aggressive REAL CHECK (mood_aggressive BETWEEN 0.0 AND 1.0),
    danceability_highlevel REAL CHECK (danceability_highlevel BETWEEN 0.0 AND 1.0),
    selected_model_signature TEXT NOT NULL,
    aggregation_policy TEXT NOT NULL,
    compatible_submission_count INTEGER NOT NULL,
    total_submission_count INTEGER NOT NULL,
    mood_happy_spread REAL,
    mood_sad_spread REAL,
    mood_aggressive_spread REAL,
    danceability_spread REAL,
    dataset_date TEXT NOT NULL,
    ingestion_run_id INTEGER NOT NULL,
    PRIMARY KEY (recording_mbid, duration_cluster_id),
    FOREIGN KEY (ingestion_run_id) REFERENCES ab_ingestion_runs(id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_ab_aggressive
    ON ab_feature_clusters(mood_aggressive DESC, mood_sad ASC);

CREATE INDEX IF NOT EXISTS idx_ab_sad
    ON ab_feature_clusters(mood_sad DESC, danceability_highlevel ASC);

CREATE INDEX IF NOT EXISTS idx_ab_happy
    ON ab_feature_clusters(mood_happy DESC, danceability_highlevel DESC);

CREATE INDEX IF NOT EXISTS idx_ab_recording_duration
    ON ab_feature_clusters(recording_mbid, duration_median_seconds);
```

Indexes should follow measured application query patterns. Verify each intended query with `EXPLAIN QUERY PLAN`; do not assume one multicolumn index accelerates every combination of mood ranges.

---

## 5. MusicBrainz Resolution

### 5.1 Query Inputs

Required:

- Artist
- Track title

Optional but strongly recommended:

- Album title
- Duration in milliseconds

Additional future evidence may include track number, release year, ISRC, or an existing MusicBrainz tag. Apple Music persistent ID is local identity only and is not sent as MusicBrainz metadata.

### 5.2 Normalization

Normalization supports candidate retrieval but must not erase version identity.

Safe normalization:

- Unicode normalization and case folding
- Normalize whitespace
- Treat `&` and `and` as comparable
- Normalize typographic apostrophes and punctuation for comparison

Preserve and compare semantic version tokens such as:

- `live`
- `remix` and named remixers
- `edit`
- `radio edit`
- `demo`
- `instrumental`
- `remaster`
- featured artists

Do not strip bracketed or parenthetical text before matching. Those fields often distinguish recordings.

### 5.3 Candidate Retrieval

API example, after Lucene escaping and URL encoding:

```text
recording:"TRACK TITLE" AND artist:"ARTIST"
```

Album title should be used as additional evidence, not an absolute requirement, because one recording can appear on many releases. Duration should be compared against the recording and release-track durations returned by MusicBrainz.

### 5.4 Deterministic Candidate Scoring

The following initial weights are provisional and must be calibrated against a labeled sample:

| Evidence | Maximum |
| --- | ---: |
| Exact normalized track title, including version tokens | 40 |
| Exact normalized artist credit | 30 |
| Album appears among candidate releases | 15 |
| Duration within 2 seconds | 10 |
| Duration within calibrated tolerance | 15 |

Penalties:

| Conflict | Penalty |
| --- | ---: |
| Remix/live/edit/version token mismatch | -40 |
| Duration differs by more than 10 seconds | -20 |
| Artist-credit mismatch | -30 |

Initial acceptance policy:

- `matched`: score at least the calibrated acceptance threshold and at least the calibrated margin above the next candidate
- `ambiguous`: at least two plausible candidates or margin below 10
- `missing`: no plausible candidate
- `review`: candidate exists but version evidence conflicts
- `rejected`: manually rejected mapping

Never accept a result merely because the API returned one candidate. Provider-native scores may break ties during retrieval but do not add points to the local score.

### 5.5 Mapping Lifecycle

- Resolve during an explicit batch, not during playlist generation.
- Persist the query metadata, resolver version, ranked candidates, and decision.
- Library snapshots must not erase accepted or manually reviewed mappings.
- Re-resolve only when requested, when material track metadata changes, or when the resolver version changes.
- Manual acceptance or rejection must be durable and distinguishable from automatic matching.
- Resolve MusicBrainz redirects and merges when possible. Preserve the current MBID and every historical source MBID needed to query the frozen AcousticBrainz dataset.

---

## 6. AcousticBrainz Ingestion

### 6.1 JSON Mapping

| Target | JSON path |
| --- | --- |
| `recording_mbid` | Parse from archive member filename; verify against `metadata.tags.musicbrainz_recordingid[0]` when present |
| `submission_ordinal` | Parse the `N` suffix in `recording-mbid-N.json` |
| `mood_happy` | `$.highlevel.mood_happy.all.happy` |
| `mood_sad` | `$.highlevel.mood_sad.all.sad` |
| `mood_aggressive` | `$.highlevel.mood_aggressive.all.aggressive` |
| `danceability_highlevel` | `$.highlevel.danceability.all.danceable` |
| `audio_length_seconds` | `$.metadata.audio_properties.length` |
| Model and extractor versions | `$.metadata.version.highlevel` and each retained classifier's `version` object |

The classifier object's `probability` field is the probability of its winning class. It is not always the positive-class probability. Store the named positive-class value from `all`, as shown above.

### 6.2 Streaming Rules

1. Download one archive at a time or stream from a reliable local download.
2. Verify its published SHA-256 checksum before ingestion.
3. Stream `.tar.zst` members; do not extract millions of individual JSON files.
4. Parse the MBID and submission ordinal from each member path first. In the baseline library-filtered profile, skip JSON decoding when neither the member MBID nor its current/redirect alias is in the target MBID set.
5. Parse retained members one at a time with bounded memory.
6. Use prepared statements and configurable transaction batches. Start at 10,000 rows and benchmark; do not require exactly 50,000.
7. Record malformed members and continue when safe.
8. Checkpoint each archive and member path so ingestion can resume.
9. Commit only validated values; use `NULL` for absent classifier fields.

### 6.3 Multiple-Submission Policy

The baseline policy is:

1. Retain every valid raw submission.
2. Group submissions by Recording MBID and high-level model signature.
3. Within each MBID, partition submissions into calibrated audio-duration clusters before aggregating. Different edits, masters, or mistagged audio must not be blended solely because they share an MBID.
4. Within each duration cluster, group by complete model signature.
5. Select the compatible model-signature group using a documented, empirically validated policy. Submission count may be evidence, but must not automatically outrank model recency or compatibility.
6. Compute the median positive-class probability for each available classifier within the selected compatible group.
7. Store duration bounds, compatible and total submission counts, plus a robust spread measurement such as median absolute deviation.
8. If model groups conflict materially, duration clusters overlap ambiguously, or spread exceeds a calibrated threshold, expose the cluster as low quality or require review.

Do not average predictions across incompatible model versions without retaining that fact.

Duration-cluster tolerance and conflict thresholds are proof-of-concept outputs, not fixed constants in this specification.

### 6.4 Finalization

After ingestion and canonical aggregation:

```sql
PRAGMA optimize;
```

Run `VACUUM` only when enough free space and maintenance time are available. It rewrites the full database and is not required after every run.

---

## 7. Querying the User's Library

Mood-aware selection must start from tracks in the user's Apple Music archive, not from all AcousticBrainz recordings.

Example using attached databases:

```sql
ATTACH DATABASE 'data/acousticbrainz-20220623.sqlite' AS ab;

SELECT
    t.persistent_id,
    t.title,
    t.artist,
    t.album,
    f.mood_aggressive,
    f.mood_sad,
    f.danceability_highlevel
FROM tracks AS t
JOIN track_recording_matches AS m
    ON m.persistent_id = t.persistent_id
   AND m.status = 'matched'
JOIN ab.ab_feature_clusters AS f
        ON f.recording_mbid = m.acousticbrainz_recording_mbid
WHERE t.current = 1
    AND ABS(f.duration_median_seconds - t.duration_seconds) <= :duration_tolerance_seconds
  AND f.mood_aggressive >= 0.80
  AND f.mood_sad <= 0.20
ORDER BY f.mood_aggressive DESC
LIMIT 25;
```

Do not use `ORDER BY RANDOM()` over the full AcousticBrainz table. If randomized selection is desired, first produce a small ranked candidate set from the user's library, then shuffle it in application code with an optional deterministic seed.

### 7.1 Missing Coverage

Tracks can lack mood data because:

- MusicBrainz resolution is missing or ambiguous
- The accepted Recording MBID has no AcousticBrainz submission
- The release is newer than the frozen June 2022 dataset
- The classifier fields are missing or rejected

Missing AcousticBrainz coverage is not an error and must not become zero-valued mood data. Such tracks can remain eligible for the separate public-source semantic-enrichment workflow.

An AcousticBrainz match must not automatically mark evidence-backed semantic enrichment as completed; the two sources describe different kinds of information.

---

## 8. Provenance, Licensing, and Reproducibility

Before redistribution or commercial use, verify the current licenses and attribution requirements for each downloaded dataset and any bundled model output. Do not infer license terms from the extractor software license.

Store at minimum:

- Dataset name and date
- Source URLs
- Published and observed SHA-256 checksums
- Parser version
- Aggregation policy and version
- Essentia, Gaia, extractor, and model signatures
- Ingestion timestamps and rejected-row counts

Display AcousticBrainz-derived values as machine classifier predictions from a frozen 2022 snapshot, not as human ratings or current ground truth.

---

## 9. Proof-of-Concept Plan

Do not begin with the complete 30-archive ingestion.

### Phase A: Format and Parser Validation

1. Download the published 100,000-item high-level sample archive and checksum file.
2. Stream the archive into a disposable SQLite database.
3. Verify actual member naming, duplicate ordinals, JSON paths, model signatures, missing fields, and storage size.
4. Confirm that rerunning ingestion is idempotent.

### Phase B: MusicBrainz Resolution Study

1. Select a stratified sample of at least 500 current Apple Music tracks, including remixes, compilations, live tracks, non-ASCII metadata, and duplicate titles.
2. Resolve through API mode with compliant rate limiting, or a local MusicBrainz index.
3. Manually label accepted and rejected mappings.
4. Measure automatic-match precision, ambiguity, missing rate, and duration/album contribution.
5. Calibrate scoring thresholds. Target at least 98% precision for automatic acceptance; prefer unresolved results over incorrect MBIDs.

The sample validates parser behavior only. It is not expected to contain any particular library track and must not be used to estimate target-track coverage.

### Phase C: End-to-End Coverage

1. Resolve the 14-track `Industrial 60-Minute Test` playlist.
2. Resolve current and historical redirected MBIDs for accepted mappings.
3. Obtain target-track AcousticBrainz records from the full dump scan, or from the AcousticBrainz read API only if the endpoint is verified operational at implementation time. Do not assume the random sample contains them.
4. Join accepted source MBIDs to duration-compatible AcousticBrainz clusters.
5. Report identity-match coverage and AcousticBrainz mood coverage separately.
6. Verify that version-specific remixes do not inherit features from an incorrect original recording or duration cluster.

### Phase D: Full Ingestion Decision

Proceed to all 30 high-level archives only after measuring:

- Download and temporary storage requirements
- Final SQLite size and index overhead
- Ingestion throughput on the target Mac
- Duplicate submission distribution
- Missing-field rates
- Model-version distribution
- Query latency over the user's library

---

## 10. Acceptance Criteria

The baseline is sufficient for implementation when all of the following are true:

- API and dump providers return a common candidate format.
- Mapping decisions and candidates are durable and auditable.
- Automatic MBID matching meets the calibrated precision target.
- Current and historical redirected MBIDs are retained and tested.
- Ambiguous remix/live/version cases route to review.
- Sample AcousticBrainz ingestion is checksum-verified, resumable, and idempotent.
- Duplicate submissions are retained; duration clustering and canonicalization are deterministic and empirically calibrated.
- Missing predictions remain `NULL`.
- Model and dataset provenance are stored.
- Mood queries operate only over current tracks in the user's library.
- Coverage and quality are reported separately from semantic enrichment.
- The selected MusicBrainz local-dump source, if implemented, has an explicit validated schema rather than a generic dump assumption.
- Dataset licensing and attribution requirements have been verified and documented for the intended use and distribution model.
- No local audio analysis is introduced.

Until the proof-of-concept phases pass, storage-size and throughput figures are estimates, not requirements.
