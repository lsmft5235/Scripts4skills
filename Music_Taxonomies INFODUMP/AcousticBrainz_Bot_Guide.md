# RP Bot Music Dataset Guide: AcousticBrainz Architecture

This document outlines the architecture, data sources, and workflows required to build a mood-based playlist generator for Roleplay (RP) bots using the **AcousticBrainz** dataset dumps.

---

## 1. Core Data Architecture: The Relational Model
To match an RP scene's aesthetic vibe with a user's music library, the bot uses a **two-tier relational database system** connected via a common key: the **MusicBrainz Recording ID (MBID)**.

```
       [ Metadata Table ]                     [ Acoustic Table ]
+-------------------------------+     +--------------------------------+
| MBID (Primary Key)            | <== | MBID (Foreign Key)             |
| Track Title                   |     | mood_happy (probability)       |
| Artist Name                   |     | mood_sad (probability)         |
| Album Name                    |     | mood_aggressive (probability)  |
| Release Year                  |     | danceability                   |
+-------------------------------+     +--------------------------------+
```

### Why this Separation Exists
1. **Metadata Mutability:** Song data (titles, artist names) can receive spelling corrections, remasters, or re-releases. Keeping strings separate ensures structural updates don't invalidate physical acoustic fingerprints.
2. **Compute Efficiency:** The high-level audio descriptors were calculated by passing raw audio waveforms through machine-learning extractors. The software strictly parsed digital patterns and indexed them to a static cryptographic UUID (the MBID) without needing text data.

---

## 2. Audio Feature Vector Strategy (Spotify vs. AcousticBrainz)
If parsing real-time streaming libraries (e.g., Spotify OAuth), you can map text descriptors directly to native floating-point numbers:

* **Valence (0.0 - 1.0):** Positivity rating. High = triumphant, happy. Low = melancholic, angry.
* **Energy (0.0 - 1.0):** Intensity and speed. High = chaotic combat, high tension. Low = ambient, intimacy.
* **Instrumentalness (0.0 - 1.0):** High instrumental values are critical for RP context to ensure lyrics do not distract from the written text chat.

### Matrix: RP Scene to Audio Attributes
| RP Scene Vibe | Target Valence | Target Energy | Instrumentalness |
| :--- | :--- | :--- | :--- |
| **High-Fantasy Tavern** | High (0.7 - 0.9) | Medium (0.5 - 0.7) | High (Acoustic strings) |
| **Grimdark Combat** | Low (0.1 - 0.3) | High (0.8 - 1.0) | High (Industrial/Orchestral) |
| **Cyberpunk Neon Club** | Medium (0.4 - 0.6) | High (0.8 - 1.0) | Low (Synthesizers/Beats) |
| **Melancholic Solitude** | Low (0.0 - 0.3) | Low (0.0 - 0.3) | Mixed (Piano/Ambient) |

---

## 3. Data Ingestion: Download Sources
Because the AcousticBrainz live crowdsourcing servers are archived, you must utilize the frozen master datasets (finalized June/July 2022).

* **The Vibe/Mood Engine (High-Level JSON):** [MetaBrainz AcousticBrainz High-Level JSON Directory](https://data.metabrainz.org/pub/musicbrainz/acousticbrainz/dumps/acousticbrainz-highlevel-json-20220623/)  
  * *Notes:* Download `acousticbrainz-highlevel-json-20220623/`. Files are grouped in `.tar.zst` format. These contain pre-computed behavioral models (`mood_happy`, `mood_sad`, `mood_aggressive`).
* **The Text Mapping (Metadata CSVs):** [MetaBrainz AcousticBrainz Low-Level Features CSV Directory](https://data.metabrainz.org/pub/musicbrainz/acousticbrainz/dumps/acousticbrainz-lowlevel-features-20220623/)  
  * *Notes:* Look for archives containing `metadata` or `rhythm` tags to bypass individual JSON requests. This maps `recording_mbid` strings directly to searchable plaintext attributes.

---

## 4. Operational Bot Workflow
To prevent scaling delays when a user connects their personal music library, run a non-blocking look-up sequence:

```
[User Library Loaded] 
         │
         ▼
[Extract Song String]  ──► (e.g., "The Synth-Wave Collective - Neon Dreams")
         │
         ▼
[MusicBrainz Search API] ──► Retrieves corresponding 36-character MBID
         │
         ▼
[Local SQLite Index]  ──► Match MBID ──► Fetch Vibe Vector ──► Filter Playlist
```

### Prototype Vibe Query (SQL)
```sql
SELECT m.title, m.artist, a.mood_happy, a.mood_aggressive 
FROM metadata m
JOIN acoustic_features a ON m.mbid = a.mbid
WHERE a.mood_sad > 0.75 AND a.danceability < 0.3
LIMIT 10;
```