import assert from "node:assert/strict";
import test from "node:test";

import { inspectMusicDictionary } from "../src/music/capabilities.js";

test("detects supported Music.app scripting declarations", () => {
  const xml = `
    <suite>
      <command name="search" code="hookSrch" />
      <command name="duplicate" code="coreclon" />
      <command name="delete" code="coredelo" />
      <command name="move" code="coremove" />
      <class name="library playlist" code="cLiP" />
      <class name="user playlist" code="cUsP" />
      <property name="persistent ID" code="pPIS" />
      <property name="database ID" code="pDID" />
      <property name="cloud status" code="pClS" />
    </suite>`;

  assert.deepEqual(inspectMusicDictionary(xml), {
    libraryPlaylist: true,
    userPlaylist: true,
    persistentId: true,
    databaseId: true,
    cloudStatus: true,
    search: true,
    duplicate: true,
    delete: true,
    movePlaylist: true,
    reorderTracks: false,
  });
});

test("reports absent declarations as unsupported", () => {
  assert.deepEqual(inspectMusicDictionary("<suite />"), {
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
  });
});