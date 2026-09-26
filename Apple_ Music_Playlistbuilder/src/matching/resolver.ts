import type {
  RankedCandidate,
  ResolutionResult,
  TrackCandidate,
  TrackQuery,
} from "../contracts.js";

export interface ResolverOptions {
  minimumScore: number;
  minimumTieMargin: number;
}

export const DEFAULT_RESOLVER_OPTIONS: ResolverOptions = {
  minimumScore: 70,
  minimumTieMargin: 8,
};

export function normalizeMetadata(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function fieldScore(expected: string | undefined, actual: string, weight: number): number {
  if (expected === undefined) {
    return 0;
  }

  const normalizedExpected = normalizeMetadata(expected);
  const normalizedActual = normalizeMetadata(actual);
  if (normalizedExpected === normalizedActual) {
    return weight;
  }
  if (normalizedActual.includes(normalizedExpected) || normalizedExpected.includes(normalizedActual)) {
    return weight * 0.55;
  }
  return 0;
}

export function rankCandidate(query: TrackQuery, track: TrackCandidate): RankedCandidate {
  if (query.persistentId !== undefined) {
    const matches = query.persistentId.toLocaleUpperCase("en-US") === track.persistentId.toLocaleUpperCase("en-US");
    return {
      track,
      score: matches ? 100 : 0,
      reasons: matches ? ["persistent_id_exact"] : [],
    };
  }

  const reasons: string[] = [];
  let score = 0;
  const fields = [
    ["title", query.title, track.title, 50],
    ["artist", query.artist, track.artist, 30],
    ["album", query.album, track.album, 10],
    ["genre", query.genre, track.genre, 5],
  ] as const;

  for (const [name, expected, actual, weight] of fields) {
    const points = fieldScore(expected, actual, weight);
    score += points;
    if (points === weight) reasons.push(`${name}_exact`);
    else if (points > 0) reasons.push(`${name}_partial`);
  }

  if (query.durationSeconds !== undefined) {
    const difference = Math.abs(query.durationSeconds - track.durationSeconds);
    if (difference <= 2) {
      score += 5;
      reasons.push("duration_close");
    } else if (difference <= 5) {
      score += 2;
      reasons.push("duration_near");
    }
  }

  return { track, score: Math.round(score * 100) / 100, reasons };
}

export function resolveTracks(
  queries: TrackQuery[],
  candidatesByQuery: TrackCandidate[][],
  options: ResolverOptions = DEFAULT_RESOLVER_OPTIONS,
): ResolutionResult {
  const resolved: ResolutionResult["resolved"] = [];
  const skipped: ResolutionResult["skipped"] = [];
  const selectedIds = new Set<string>();

  for (const [index, query] of queries.entries()) {
    const ranked = (candidatesByQuery[index] ?? [])
      .map((candidate) => rankCandidate(query, candidate))
      .sort((left, right) => right.score - left.score || left.track.persistentId.localeCompare(right.track.persistentId));
    const best = ranked[0];

    if (!best) {
      skipped.push({ query, reason: "no_candidates", candidates: [] });
      continue;
    }
    if (best.score < options.minimumScore) {
      skipped.push({ query, reason: "low_confidence", candidates: ranked.slice(0, 5) });
      continue;
    }
    if (ranked[1] && best.score - ranked[1].score < options.minimumTieMargin) {
      skipped.push({ query, reason: "ambiguous", candidates: ranked.slice(0, 5) });
      continue;
    }

    const normalizedId = best.track.persistentId.toLocaleUpperCase("en-US");
    if (selectedIds.has(normalizedId)) {
      skipped.push({ query, reason: "duplicate", candidates: [best] });
      continue;
    }

    selectedIds.add(normalizedId);
    resolved.push({ query, match: best });
  }

  return { resolved, skipped };
}