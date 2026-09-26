export const MUSIC_MUTATION_APPLESCRIPT = String.raw`
on joinValues(valuesList, delimiterText)
  set previousDelimiters to AppleScript's text item delimiters
  set AppleScript's text item delimiters to delimiterText
  set joinedText to valuesList as text
  set AppleScript's text item delimiters to previousDelimiters
  return joinedText
end joinValues

on run argv
  set operationName to item 1 of argv
  set playlistName to item 2 of argv
  set playlistDescription to item 3 of argv
  set persistentIds to items 4 thru -1 of argv
  set addedIds to {}
  set existingIds to {}
  set missingIds to {}

  tell application "Music"
    if operationName is "create" then
      if exists user playlist playlistName then error "PLAYLIST_EXISTS: A user playlist with that name already exists."
      set targetPlaylist to make new user playlist with properties {name:playlistName}
      if playlistDescription is not "" then set description of targetPlaylist to playlistDescription
    else if operationName is "append" then
      if not (exists user playlist playlistName) then error "PLAYLIST_NOT_FOUND: The requested user playlist does not exist."
      set targetPlaylist to user playlist playlistName
    else
      error "Unsupported playlist operation: " & operationName
    end if

    repeat with persistentId in persistentIds
      set persistentIdText to persistentId as text
      if operationName is "append" and (exists some track of targetPlaylist whose persistent ID is persistentIdText) then
        set end of existingIds to persistentIdText
      else
        set libraryTracks to every track of library playlist 1 whose persistent ID is persistentIdText
        if (count libraryTracks) is 0 then
          set end of missingIds to persistentIdText
        else
          duplicate item 1 of libraryTracks to targetPlaylist
          set end of addedIds to persistentIdText
        end if
      end if
    end repeat
  end tell

  return my joinValues(addedIds, ",") & "|" & my joinValues(existingIds, ",") & "|" & my joinValues(missingIds, ",")
end run
`;