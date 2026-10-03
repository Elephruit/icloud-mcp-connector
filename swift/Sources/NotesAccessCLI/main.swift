import Foundation
import CoreServices

// Permission status only: no Apple event sends, application launch, or prompt.
// The Notes adapter deliberately has no authorization-request command.
func emit(_ payload: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
          let output = String(data: data, encoding: .utf8) else {
        print("{\"success\":false}")
        return
    }
    print(output)
}

guard CommandLine.arguments.count == 2, CommandLine.arguments[1] == "status" else {
    emit(["success": false, "error": "Only the non-prompting status command is supported"])
    exit(2)
}

var target = AEAddressDesc()
let bundleID = "com.apple.Notes"
let descriptorStatus = bundleID.utf8CString.withUnsafeBytes { buffer in
    AECreateDesc(DescType(typeApplicationBundleID), buffer.baseAddress, buffer.count - 1, &target)
}
guard descriptorStatus == noErr else {
    emit(["success": false, "target": bundleID, "authorized": false, "prompted": false, "authorization": "error"])
    exit(1)
}
defer { AEDisposeDesc(&target) }

// askUserIfNeeded=false is the important boundary. This check cannot grant TCC
// access and returns procNotFound when Notes is not already running.
let status = AEDeterminePermissionToAutomateTarget(&target, AEEventClass(typeWildCard), AEEventID(typeWildCard), false)
let authorization: String
switch status {
case noErr: authorization = "authorized"
case OSStatus(procNotFound): authorization = "notRunning"
case OSStatus(errAEEventWouldRequireUserConsent): authorization = "notDetermined"
case OSStatus(errAEEventNotPermitted): authorization = "denied"
default: authorization = "error"
}
emit([
    "success": true,
    "target": bundleID,
    "authorized": status == noErr,
    "prompted": false,
    "authorization": authorization,
])
