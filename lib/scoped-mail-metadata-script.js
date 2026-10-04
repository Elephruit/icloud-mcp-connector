/** Fixed iCloud-only account metadata AppleScript; separate approved enrollment only. */
export const MAIL_ACCOUNT_METADATA_APPLESCRIPT = String.raw`use framework "Foundation"
use scripting additions

on emitJSON(payload)
  set jsonData to current application's NSJSONSerialization's dataWithJSONObject:payload options:0 |error|:(missing value)
  if jsonData is missing value then error "Metadata serialization failed" number -1700
  set jsonText to current application's NSString's alloc()'s initWithData:jsonData encoding:(current application's NSUTF8StringEncoding)
  return jsonText as text
end emitJSON

on run argv
  if (count of argv) is not 0 then error "Account metadata enrollment accepts no selectors or code" number -1700
  set stageLabel to "running"
  try
    if not (application "/System/Applications/Mail.app" is running) then error "Mail must already be running" number -600
    set stageLabel to "icloudPredicate"
    tell application "/System/Applications/Mail.app"
      set cloudAccountRefs to get every account whose account type is iCloud
    end tell
    if (count of cloudAccountRefs) is greater than 32 then error "Metadata account bound exceeded" number -1700
    set accountsPayload to current application's NSMutableArray's array()
    set seenAccountIDs to current application's NSMutableSet's |set|()
    repeat with cloudAccountRef in cloudAccountRefs
      set stageLabel to "accountType"
      tell application "/System/Applications/Mail.app"
        if (get account type of cloudAccountRef) is not iCloud then error "Unexpected provider metadata" number -1700
      end tell
      set stageLabel to "accountID"
      tell application "/System/Applications/Mail.app"
        set accountNativeID to (get id of cloudAccountRef) as text
      end tell
      if (count of accountNativeID) is 0 or (count of accountNativeID) is greater than 2048 then error "Invalid account metadata" number -1700
      if (seenAccountIDs's containsObject:accountNativeID) as boolean then error "Ambiguous account metadata" number -1700
      seenAccountIDs's addObject:accountNativeID
      set stageLabel to "accountName"
      tell application "/System/Applications/Mail.app"
        set accountDisplayName to (get name of cloudAccountRef) as text
      end tell
      if (count of accountDisplayName) is 0 or (count of accountDisplayName) is greater than 2048 then error "Invalid account metadata" number -1700
      set accountPayload to current application's NSMutableDictionary's dictionary()
      accountPayload's setObject:accountNativeID forKey:"id"
      accountPayload's setObject:accountDisplayName forKey:"name"
      accountPayload's setObject:"iCloud" forKey:"provider"
      accountsPayload's addObject:accountPayload
    end repeat
    set stageLabel to "serialization"
    set responsePayload to current application's NSMutableDictionary's dictionary()
    responsePayload's setObject:true forKey:"success"
    responsePayload's setObject:"com.apple.mail" forKey:"target"
    responsePayload's setObject:"metadata-account" forKey:"mode"
    responsePayload's setObject:accountsPayload forKey:"accounts"
    return my emitJSON(responsePayload)
  on error ignoredErrorText number failureNumber
    -- Only fixed stage and numeric error escape; no partial IDs/names/errors.
    set failurePayload to current application's NSMutableDictionary's dictionary()
    failurePayload's setObject:false forKey:"success"
    failurePayload's setObject:stageLabel forKey:"stage"
    failurePayload's setObject:failureNumber forKey:"errorNumber"
    return my emitJSON(failurePayload)
  end try
end run
`;
