# Apple Music Playlist Builder

These instructions apply to GitHub Copilot using the MCP server. LM Studio Bionic should use the Agent Skills under `.agents/skills/`, which call the JSON CLI instead. The current MCP server exposes playlist operations only; archive and semantic-enrichment workflows are CLI/skill features.

- Use `music_capabilities` before the first Music operation in a session.
- Use `search_library` when track identity is uncertain. Never invent a persistent ID.
- Build requests from title plus optional artist, album, genre, and duration. Prefer a returned persistent ID after selection.
- Always call `preview_playlist` and present resolved, skipped, ambiguous, and duplicate tracks before requesting approval.
- Call `create_playlist` or `update_playlist` only after explicit user approval and set `confirm` to `true`.
- Treat Music.app as user data. Never rename, delete, or synchronize a playlist unless the requested operation explicitly supports it.
- Catalog-only search is not implemented yet. Report missing library tracks instead of claiming they were added.
- Do not add or perform local audio analysis. Semantic enrichment uses public-source evidence and manual review through the dedicated CLI skill.