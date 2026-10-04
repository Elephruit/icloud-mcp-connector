import Foundation
#if os(macOS)
import AppKit
import CoreServices
#endif

// Status never prompts. The separate manual request-authorization command may
// request Automation consent; it is deliberately unavailable to the MCP adapter.
// Neither command sends data Apple events, launches Mail, reads its records,
// requests Full Disk Access, or accesses databases or filesystem mail indexes.
@main
struct MailAccessCLI {
    static let targetBundleID = "com.apple.mail"

    enum Mode: String {
        case status
        case requestAuthorization = "request-authorization"

        var askUserIfNeeded: Bool { self == .requestAuthorization }
    }

    static func mode(arguments: [String]) -> Mode? {
        guard arguments.count == 2 else { return nil }
        return Mode(rawValue: arguments[1])
    }

    static func emit(_ value: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
              let output = String(data: data, encoding: .utf8) else {
            print("{\"success\":false,\"authorized\":false,\"prompted\":false}")
            return
        }
        print(output)
    }

    static func payload(_ authorization: String, running: Bool, authorized: Bool = false,
                        success: Bool = true, authorizationRequested: Bool = false) -> [String: Any] {
        return [
            "success": success,
            "target": targetBundleID,
            "running": running,
            "authorized": authorized,
            // The API does not reveal whether the system actually displayed a
            // prompt. Preserve false for status; report unknown for a request.
            "prompted": authorizationRequested ? NSNull() : false,
            "authorizationRequested": authorizationRequested,
            "authorization": authorization,
        ]
    }

    static func exitCode(mode: Mode, authorized: Bool) -> Int32 {
        mode.askUserIfNeeded && !authorized ? 1 : 0
    }

    static func main() {
        guard let mode = mode(arguments: CommandLine.arguments) else {
            emit([
                "success": false, "target": targetBundleID, "authorized": false,
                "prompted": false, "authorizationRequested": false,
                "error": "Only status or the separate manual request-authorization command is supported",
            ])
            exit(2)
        }
        #if os(macOS)
        // Process metadata only: never instantiate or launch a scripting
        // application to discover whether Mail is running.
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: targetBundleID)
            .contains { !$0.isTerminated }
        guard running else {
            emit(payload("notRunning", running: false))
            exit(exitCode(mode: mode, authorized: false))
        }

        var target = AEAddressDesc()
        let descriptorStatus = targetBundleID.utf8CString.withUnsafeBytes { buffer in
            AECreateDesc(DescType(typeApplicationBundleID), buffer.baseAddress, buffer.count - 1, &target)
        }
        guard descriptorStatus == noErr else {
            emit(payload("error", running: true, success: false))
            exit(1)
        }
        defer { AEDisposeDesc(&target) }

        // Only the exact, manually invoked request-authorization mode may ask
        // for consent. The MCP adapter invokes status, which always passes false.
        // This permission API does not send a Mail data command.
        let permission = AEDeterminePermissionToAutomateTarget(
            &target, AEEventClass(typeWildCard), AEEventID(typeWildCard), mode.askUserIfNeeded
        )
        let authorization: String
        switch permission {
        case noErr: authorization = "authorized"
        case OSStatus(procNotFound): authorization = "notRunning"
        case OSStatus(errAEEventWouldRequireUserConsent): authorization = "notDetermined"
        case OSStatus(errAEEventNotPermitted): authorization = "denied"
        default: authorization = "error"
        }
        let authorized = permission == noErr
        emit(payload(authorization, running: permission != OSStatus(procNotFound), authorized: authorized,
                     authorizationRequested: mode.askUserIfNeeded))
        exit(exitCode(mode: mode, authorized: authorized))
        #else
        emit(payload("unsupported", running: false, success: false))
        exit(1)
        #endif
    }
}
