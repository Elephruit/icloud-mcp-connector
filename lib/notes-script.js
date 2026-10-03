/**
 * Original fixed AppleScript, using only the installed Notes scripting dictionary.
 * All caller data arrives in run(argv); none is interpolated into source code.
 * Do not run this script to discover personal account/folder IDs without approval.
 */
export const NOTES_APPLESCRIPT = String.raw`use framework "Foundation"
use scripting additions

on exactText(leftText, rightText)
  return ((current application's NSString's stringWithString:(leftText as text))'s isEqualToString:(rightText as text)) as boolean
end exactText

on decodeList(jsonText)
  set jsonData to (current application's NSString's stringWithString:jsonText)'s dataUsingEncoding:(current application's NSUTF8StringEncoding)
  set parsed to current application's NSJSONSerialization's JSONObjectWithData:jsonData options:0 |error|:(missing value)
  if parsed is missing value then error "Invalid scope JSON"
  return parsed as list
end decodeList

on jsonText(value)
  set jsonData to current application's NSJSONSerialization's dataWithJSONObject:value options:0 |error|:(missing value)
  if jsonData is missing value then error "Could not encode Notes response"
  return (current application's NSString's alloc()'s initWithData:jsonData encoding:(current application's NSUTF8StringEncoding)) as text
end jsonText

on plainAppendAllowed(htmlText)
  -- Deliberately reject rich markup/attributes rather than risk flattening it.
  set sourceText to current application's NSString's stringWithString:htmlText
  set tagPattern to current application's NSRegularExpression's regularExpressionWithPattern:"<[^>]*>" options:0 |error|:(missing value)
  set safePattern to current application's NSRegularExpression's regularExpressionWithPattern:"^</?(?:html|head|body|div|p|br)\\s*/?>$" options:(current application's NSRegularExpressionCaseInsensitive) |error|:(missing value)
  set tagMatches to tagPattern's matchesInString:sourceText options:0 range:{location:0, |length|:sourceText's |length|()}
  repeat with tagMatch in tagMatches
    set tagText to sourceText's substringWithRange:(tagMatch's range())
    if (safePattern's numberOfMatchesInString:tagText options:0 range:{location:0, |length|:tagText's |length|()}) is not 1 then return false
  end repeat
  return true
end plainAppendAllowed

on resolveScopedNote(noteID, scopedFolder)
  tell application "/System/Applications/Notes.app"
    -- Some Notes versions expose note.container but fail when it is read.
    -- Prove membership with a fresh ID query inside the resolved allowed folder.
    set candidateNotes to every note of scopedFolder whose id is noteID
    set exactMatches to {}
    repeat with candidateNote in candidateNotes
      if my exactText(id of candidateNote, noteID) then set end of exactMatches to candidateNote
    end repeat
    if (count of exactMatches) is not 1 then error "Note is outside the allowed folder, missing, or ambiguous"
    return item 1 of exactMatches
  end tell
end resolveScopedNote

on resultNote(theNote, accountID, folderID, scopedFolder, includeText)
  tell application "/System/Applications/Notes.app"
    set resolvedNote to my resolveScopedNote(id of theNote, scopedFolder)
    if password protected of resolvedNote then error "Locked Notes are not supported"
    set noteID to id of resolvedNote
    set noteTitle to name of resolvedNote
    set hasAttachments to (count of attachments of resolvedNote) > 0
    if includeText then set notePlainText to plaintext of resolvedNote
  end tell
  set entry to current application's NSMutableDictionary's dictionary()
  entry's setObject:noteID forKey:"id"
  entry's setObject:noteTitle forKey:"title"
  entry's setObject:accountID forKey:"accountId"
  entry's setObject:folderID forKey:"folderId"
  entry's setObject:false forKey:"locked"
  entry's setObject:hasAttachments forKey:"attachmentsOmitted"
  if includeText then
    set clipped to false
    if (count characters of notePlainText) > 32768 then
      set notePlainText to text 1 thru 32768 of notePlainText
      set clipped to true
    end if
    entry's setObject:notePlainText forKey:"text"
    entry's setObject:clipped forKey:"truncated"
  end if
  return entry
end resultNote

on run(argv)
  if (count of argv) is not 10 then error "Invalid Notes arguments"
  set operation to item 1 of argv
  set allowedAccounts to my decodeList(item 2 of argv)
  set allowedFolders to my decodeList(item 3 of argv)
  set requestedAccount to item 4 of argv
  set requestedFolder to item 5 of argv
  set requestedNote to item 6 of argv
  set searchText to item 7 of argv
  set noteTitle to item 8 of argv
  set newHTML to item 9 of argv
  set resultLimit to (item 10 of argv) as integer
  if operation is not in {"search", "get", "create", "append"} then error "Unsupported Notes action"
  if resultLimit < 1 or resultLimit > 50 then error "Invalid Notes result limit"
  set scopeFolders to {}
  set scopeAccountIDs to {}
  set scopeFolderIDs to {}
  set seenFolderIDs to {}
  with timeout of 15 seconds
    tell application "/System/Applications/Notes.app"
      -- Resolve only allowed accounts, then folders within those accounts.
      -- No global notes, default account/folder, or name lookup is used.
      repeat with allowedAccount in allowedAccounts
        set accountID to allowedAccount as text
        if requestedAccount is "" or my exactText(requestedAccount, accountID) then
          set accountMatches to every account whose id is accountID
          if (count of accountMatches) is not 1 then error "Allowed Notes account is missing or ambiguous"
          set scopedAccount to item 1 of accountMatches
          if not my exactText(id of scopedAccount, accountID) then error "Allowed Notes account ID did not match exactly"
          repeat with allowedFolder in allowedFolders
            set folderID to allowedFolder as text
            if requestedFolder is "" or my exactText(requestedFolder, folderID) then
              set folderMatches to every folder of scopedAccount whose id is folderID
              if (count of folderMatches) > 1 then error "Allowed Notes folder is ambiguous"
              if (count of folderMatches) is 1 then
                if not my exactText(id of item 1 of folderMatches, folderID) then error "Allowed Notes folder ID did not match exactly"
                if folderID is in seenFolderIDs then error "Allowed Notes folder is ambiguous"
                set end of seenFolderIDs to folderID
                set end of scopeFolders to item 1 of folderMatches
                set end of scopeAccountIDs to accountID
                set end of scopeFolderIDs to folderID
              end if
            end if
          end repeat
        end if
      end repeat
      if (count of scopeFolders) is 0 then error "No allowed Notes folder could be resolved"
      if requestedAccount is not "" and requestedFolder is not "" and (count of scopeFolders) is not 1 then error "Notes target folder is ambiguous"
      -- For a broad scoped search, every configured folder must resolve.
      if requestedFolder is "" then
        repeat with allowedFolder in allowedFolders
          if (allowedFolder as text) is not in seenFolderIDs then error "Allowed Notes folder is missing"
        end repeat
      end if
      set responsePayload to current application's NSMutableDictionary's dictionary()
      responsePayload's setObject:true forKey:"success"
      if operation is "create" then
        if requestedAccount is "" or requestedFolder is "" then error "Notes writes require explicit account and folder IDs"
        set targetFolder to item 1 of scopeFolders
        set newNote to make new note at targetFolder with properties {name:noteTitle, body:newHTML}
        set entry to my resultNote(newNote, requestedAccount, requestedFolder, targetFolder, false)
        responsePayload's setObject:entry forKey:"note"
        return my jsonText(responsePayload)
      end if
      if operation is "search" then
        set entries to current application's NSMutableArray's array()
        set inspectedCount to 0
        set stoppedEarly to false
        repeat with scopeIndex from 1 to count of scopeFolders
          set targetFolder to item scopeIndex of scopeFolders
          set folderNotes to every note of targetFolder
          repeat with theNote in folderNotes
            set inspectedCount to inspectedCount + 1
            if inspectedCount > 500 then error "Notes search scope exceeds 500 notes; narrow the folder scope"
            set scopedSearchNote to my resolveScopedNote(id of theNote, targetFolder)
            if not password protected of scopedSearchNote then
              set searchableText to (name of scopedSearchNote) & linefeed & (plaintext of scopedSearchNote)
              set containsQuery to (current application's NSString's stringWithString:searchableText)'s localizedCaseInsensitiveContainsString:searchText
              if containsQuery as boolean then
                set entry to my resultNote(scopedSearchNote, item scopeIndex of scopeAccountIDs, item scopeIndex of scopeFolderIDs, targetFolder, false)
                entries's addObject:entry
                if (entries's |count|()) as integer >= resultLimit then
                  set stoppedEarly to true
                  exit repeat
                end if
              end if
            end if
          end repeat
          if stoppedEarly then exit repeat
        end repeat
        responsePayload's setObject:entries forKey:"notes"
        responsePayload's setObject:stoppedEarly forKey:"limitReached"
        return my jsonText(responsePayload)
      end if
      -- ID resolution is inside allowed folders, never application's notes.
      set matches to {}
      set matchAccountIDs to {}
      set matchFolderIDs to {}
      set matchFolders to {}
      repeat with scopeIndex from 1 to count of scopeFolders
        set targetFolder to item scopeIndex of scopeFolders
        set folderMatches to every note of targetFolder whose id is requestedNote
        repeat with theNote in folderMatches
          if my exactText(id of theNote, requestedNote) then
            set end of matches to theNote
            set end of matchAccountIDs to item scopeIndex of scopeAccountIDs
            set end of matchFolderIDs to item scopeIndex of scopeFolderIDs
            set end of matchFolders to targetFolder
          end if
        end repeat
      end repeat
      if (count of matches) is not 1 then error "Note is outside the allowed scope, missing, or ambiguous"
      set matchedFolder to item 1 of matchFolders
      set targetNote to my resolveScopedNote(requestedNote, matchedFolder)
      if password protected of targetNote then error "Locked Notes are not supported"
      if operation is "append" then
        if requestedAccount is "" or requestedFolder is "" then error "Notes writes require explicit account and folder IDs"
        if (count of attachments of targetNote) > 0 then error "Appending to Notes with attachments is not supported"
        set oldHTML to body of targetNote
        if not my plainAppendAllowed(oldHTML) then error "Appending to rich or unsupported Notes is not supported"
        set targetNote to my resolveScopedNote(requestedNote, matchedFolder)
        if password protected of targetNote then error "Locked Notes are not supported"
        if (count of attachments of targetNote) > 0 then error "Appending to Notes with attachments is not supported"
        if not my exactText(body of targetNote, oldHTML) then error "Note changed during append; verify locally before retrying"
        set body of targetNote to oldHTML & newHTML
      end if
      set entry to my resultNote(targetNote, item 1 of matchAccountIDs, item 1 of matchFolderIDs, matchedFolder, operation is "get")
      responsePayload's setObject:entry forKey:"note"
      return my jsonText(responsePayload)
    end tell
  end timeout
end run
`;
