# Technical Specification: Localized Mood & Metadata Database for RP Playlist Generation

## 1. System Architecture Overview
The database acts as a high-performance local cache that translates text metadata (Track Title, Artist Name) provided by a user's library into precise, multi-dimensional emotional vectors (`mood_happy`, `mood_sad`, `mood_aggressive`, `danceability`). 

The architecture consists of a localized **SQLite 3 database** populated by combining two distinct, frozen public archives from the **June 2022 MetaBrainz AcousticBrainz dataset**.

```
    [ User Library Tracking ]              [ Local SQLite Database Cache ]
+-------------------------------+       +------------------------------------+
| Extracted Track/Artist Strings|       |         Table: track_metadata      |
+---------------+---------------+       | - mbid (TEXT, PK)                  |
                |                       | - title (TEXT)                     |
       (MusicBrainz Search)             | - artist (TEXT)                    |
                |                       +-----------------+------------------+
                v                                         | (JOIN via mbid)
+---------------+---------------+                         v
|   Resulting Recording MBID    |=======> +-----------------+------------------+
+-------------------------------+         |        Table: acoustic_features    |
                                          | - mbid (TEXT, FK, PK)              |
                                          | - mood_happy (REAL)                |
                                          | - mood_sad (REAL)                  |
                                          | - mood_aggressive (REAL)           |
                                          | - danceability (REAL)              |
                                          | - bpm (REAL)                       |
                                          +------------------------------------+
```

---

## 2. Source Data Ingestion Mapping

### 2.1 Table 1: `track_metadata`
* **Source Dump:** [AcousticBrainz Low-Level Features CSV Directory](https://data.metabrainz.org/pub/musicbrainz/acousticbrainz/dumps/acousticbrainz-lowlevel-features-20220623/)
* **Target File:** `acousticbrainz-lowlevel-features-20220623-metadata.csv` (or your parsed layout from the raw metadata segments).
* **Ingestion Filter:** Read the raw rows, discarding entries missing core artist or title identifiers. Strip out tracking artifacts or brackets from string fields before insertion.

### 2.2 Table 2: `acoustic_features`
* **Source Dump:** [AcousticBrainz High-Level JSON Directory](https://data.metabrainz.org/pub/musicbrainz/acousticbrainz/dumps/acousticbrainz-highlevel-json-20220623/)
* **Format:** Unpacked from `.tar.zst` chunks.
* **JSON Mapping Scheme:**

| Database Target Column | Source JSON Key Pathway | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `mbid` | Filename string / Root object context | `TEXT` (36 chars) | Unique Recording UUID |
| `mood_happy` | `$.highlevel.mood_happy.all.happy` | `REAL` (Float) | Confidence rating [0.0 - 1.0] |
| `mood_sad` | `$.highlevel.mood_sad.all.sad` | `REAL` (Float) | Confidence rating [0.0 - 1.0] |
| `mood_aggressive` | `$.highlevel.mood_aggressive.all.aggressive` | `REAL` (Float) | Confidence rating [0.0 - 1.0] |
| `danceability` | `$.highlevel.danceability.all.danceable` | `REAL` (Float) | Structural rhythm rating [0.0 - 1.0] |
| `bpm` | `$.lowlevel.rhythm.bpm` (or highlevel proxy) | `REAL` (Float) | Beats Per Minute speed value |

---

## 3. Database Schema Blueprint (DDL)

Executing the following schema in SQLite builds an optimized footprint of roughly **2.5 GB to 3.0 GB on disk** for ~6 million tracks.

```sql
-- Enable foreign key support inside the SQLite session context
PRAGMA foreign_keys = ON;

-- 1. Metadata Storage Table
CREATE TABLE IF NOT EXISTS track_metadata (
    mbid TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    album TEXT
) WITHOUT ROWID; 
-- Note: WITHOUT ROWID optimizes space and retrieval speed when using a string PK.

-- 2. Emotional Feature & Vibe Analysis Table
CREATE TABLE IF NOT EXISTS acoustic_features (
    mbid TEXT PRIMARY KEY,
    mood_happy REAL DEFAULT 0.0,
    mood_sad REAL DEFAULT 0.0,
    mood_aggressive REAL DEFAULT 0.0,
    danceability REAL DEFAULT 0.0,
    bpm REAL DEFAULT 0.0,
    FOREIGN KEY (mbid) REFERENCES track_metadata (mbid) ON DELETE CASCADE
) WITHOUT ROWID;

-- 3. High Performance Core Database Indexes
-- Prevents slow tablescans during complex text searches and relational joins.
CREATE INDEX IF NOT EXISTS idx_metadata_lookup ON track_metadata (artist, title);
CREATE INDEX IF NOT EXISTS idx_features_vibe ON acoustic_features (mood_sad, mood_aggressive, mood_happy);
```

---

## 4. Performant Vibe Extraction Queries

Once populated, your RP bot can pass abstract scene settings to the database by translating emotional goals directly to float ranges inside standard SQL blocks.

### Scene A: Cyberpunk Combat / Aggressive Chase Scene
* **Criteria:** High energy, aggressive stance, zero sorrow, high rhythm stability.
```sql
SELECT m.title, m.artist, a.bpm, a.mood_aggressive
FROM track_metadata m
JOIN acoustic_features a ON m.mbid = a.mbid
WHERE a.mood_aggressive > 0.80 
  AND a.mood_sad < 0.20
  AND a.bpm >= 120.0
ORDER BY RANDOM()
LIMIT 5;
```

### Scene B: Somber, Introspective Rain / Dystopian Melancholy
* **Criteria:** Deep melancholic score, highly text-ambient, low-tempo.
```sql
SELECT m.title, m.artist, a.mood_sad, a.danceability
FROM track_metadata m
JOIN acoustic_features a ON m.mbid = a.mbid
WHERE a.mood_sad > 0.85 
  AND a.danceability < 0.40
ORDER BY a.mood_sad DESC
LIMIT 5;
```

---

## 5. Ingestion Pipeline & Execution Logic
To ingest data securely without choking server RAM, adhere to the following file processing pattern:

1. **Transaction Chunking:** Execute bulk CSV and JSON file parsing inside explicit SQLite transactions (`BEGIN TRANSACTION;` ... `COMMIT;`) in chunks of exactly **50,000 rows**. This ensures processing speeds approach 100k records per second instead of individual disk writes.
2. **Streaming Unpack:** Utilize modern system pipelines (such as Python's `zstandard` or terminal pipes) to decompress the highlevel raw `.tar.zst` files in-memory as a stream. **Do not extract the archives onto your physical disk drive first**, as creating 6 million individual small files wastes critical space via sector slack space overhead.
3. **Database Maintenance:** Once the initialization phase finishes processing all download chunks, execute the database performance command:
   ```sql
   PRAGMA optimize;
   VACUUM;
   ```