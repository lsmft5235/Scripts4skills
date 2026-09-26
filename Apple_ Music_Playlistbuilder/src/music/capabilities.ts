import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";

export const MUSIC_APP_PATH = "/System/Applications/Music.app";
export const MUSIC_SDEF_PATH = `${MUSIC_APP_PATH}/Contents/Resources/com.apple.Music.sdef`;

export interface MusicCapabilities {
  musicInstalled: boolean;
  dictionaryAvailable: boolean;
  dictionaryPath: string | null;
  features: {
    libraryPlaylist: boolean;
    userPlaylist: boolean;
    persistentId: boolean;
    databaseId: boolean;
    cloudStatus: boolean;
    search: boolean;
    duplicate: boolean;
    delete: boolean;
    movePlaylist: boolean;
    reorderTracks: boolean;
  };
  warnings: string[];
}

const EMPTY_FEATURES: MusicCapabilities["features"] = {
  libraryPlaylist: false,
  userPlaylist: false,
  persistentId: false,
  databaseId: false,
  cloudStatus: false,
  search: false,
  duplicate: false,
  delete: false,
  movePlaylist: false,
  reorderTracks: false,
};

function hasDeclaration(xml: string, element: "class" | "property" | "command", name: string): boolean {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`<${element}\\s+name="${escapedName}"(?:\\s|>)`).test(xml);
}

export function inspectMusicDictionary(xml: string): MusicCapabilities["features"] {
  return {
    libraryPlaylist: hasDeclaration(xml, "class", "library playlist"),
    userPlaylist: hasDeclaration(xml, "class", "user playlist"),
    persistentId: hasDeclaration(xml, "property", "persistent ID"),
    databaseId: hasDeclaration(xml, "property", "database ID"),
    cloudStatus: hasDeclaration(xml, "property", "cloud status"),
    search: hasDeclaration(xml, "command", "search"),
    duplicate: hasDeclaration(xml, "command", "duplicate"),
    delete: hasDeclaration(xml, "command", "delete"),
    movePlaylist: hasDeclaration(xml, "command", "move"),
    // Music's move command targets playlists, not tracks. Synchronization must
    // rebuild playlist entries unless a future dictionary adds track ordering.
    reorderTracks: false,
  };
}

async function readDictionary(): Promise<{ path: string; xml: string } | null> {
  try {
    return { path: MUSIC_SDEF_PATH, xml: await readFile(MUSIC_SDEF_PATH, "utf8") };
  } catch {
    return await new Promise((resolve) => {
      execFile("sdef", [MUSIC_APP_PATH], { encoding: "utf8" }, (error, stdout) => {
        resolve(error ? null : { path: "sdef", xml: stdout });
      });
    });
  }
}

export async function probeMusicCapabilities(): Promise<MusicCapabilities> {
  let musicInstalled = true;
  try {
    await access(MUSIC_APP_PATH);
  } catch {
    musicInstalled = false;
  }

  const dictionary = musicInstalled ? await readDictionary() : null;
  const warnings: string[] = [];
  if (!musicInstalled) {
    warnings.push("Music.app was not found at the standard macOS path.");
  } else if (!dictionary) {
    warnings.push("The Music.app scripting dictionary could not be read.");
  }

  const features = dictionary ? inspectMusicDictionary(dictionary.xml) : { ...EMPTY_FEATURES };
  if (!features.reorderTracks) {
    warnings.push("Music.app does not expose direct track reordering; synchronize will require a tested rebuild strategy.");
  }

  return {
    musicInstalled,
    dictionaryAvailable: dictionary !== null,
    dictionaryPath: dictionary?.path ?? null,
    features,
    warnings,
  };
}