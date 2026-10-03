import Contacts
import CoreServices
import EventKit
import Foundation

// Manual acceptance helper; not an MCP tool. Never invoked by the plugin.
// Grant actions and dedicated-list creation require action-time user approval.
@main
struct NativeTestScopes {
    static func emit(_ value: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
              let text = String(data: data, encoding: .utf8) else { exit(1) }
        print(text)
    }
    static func fail(_ message: String) -> Never { emit(["success": false, "error": message]); exit(1) }
    static func main() async {
        let args = Array(CommandLine.arguments.dropFirst())
        guard let command = args.first else { fail("Explicit enrollment mode is required.") }
        switch command {
        case "contacts-metadata":
            guard args == [command] || args == [command, "--request-access"] else { fail("Unsupported contacts arguments.") }
            let store = CNContactStore()
            if CNContactStore.authorizationStatus(for: .contacts) != .authorized {
                guard args.contains("--request-access") else { fail("Contacts grant missing; no prompt or metadata query occurred.") }
                do { guard try await store.requestAccess(for: .contacts) else { fail("Contacts permission was not granted.") } }
                catch {
                    let failure = error as NSError
                    emit(["success": false, "error": "Contacts permission request failed.",
                          "nativeErrorCode": failure.code, "nativeErrorDomain": failure.domain])
                    exit(1)
                }
            }
            guard CNContactStore.authorizationStatus(for: .contacts) == .authorized else { fail("Full Contacts access is unavailable; enrollment stopped.") }
            do {
                let containers = try store.containers(matching: nil)
                let metadata = containers.map { ["id": $0.identifier, "name": $0.name, "type": $0.type == .cardDAV ? "cardDAV" : ($0.type == .local ? "local" : "exchange")] }
                let matches = containers.filter { $0.name == "iCloud" && $0.type == .cardDAV }
                // CNContainer has no provider provenance. The owner must confirm
                // even a unique display-name match; metadata alone isn't proof.
                emit(["success": true, "containers": metadata, "uniqueNamedICloud": matches.count == 1,
                      "candidateID": matches.count == 1 ? matches[0].identifier : "", "contactsRead": false])
            } catch { fail("Contact container metadata enrollment failed.") }
        case "create-reminder-test-list":
            guard args.count == 2,
                  args[1].range(of: "^Apple PIM Connector Tests [A-Za-z0-9-]{6,40}$", options: .regularExpression) != nil else { fail("An explicit unique synthetic test-list title is required.") }
            let auth = EKEventStore.authorizationStatus(for: .reminder)
            if #available(macOS 14.0, *) { guard auth == .fullAccess else { fail("Existing Reminders full access is required; no prompt occurred.") } }
            else { guard auth == .authorized else { fail("Existing Reminders access is required; no prompt occurred.") } }
            let store = EKEventStore()
            let lists = store.calendars(for: .reminder)
            var sources: [String: EKSource] = [:]
            for list in lists where list.source?.title == "iCloud" && list.source?.sourceType == .calDAV {
                if let source = list.source { sources[source.sourceIdentifier] = source }
            }
            guard sources.count == 1, let source = sources.values.first else { fail("No unique iCloud Reminders source; no list was created.") }
            guard !lists.contains(where: { $0.title == args[1] }) else { fail("Test-list title already exists; refusing to adopt it.") }
            let list = EKCalendar(for: .reminder, eventStore: store)
            list.title = args[1]
            list.source = source
            do {
                try store.saveCalendar(list, commit: true)
                guard let persisted = store.calendars(for: .reminder).first(where: { $0.calendarIdentifier == list.calendarIdentifier }),
                      persisted.title == args[1], persisted.source?.sourceIdentifier == source.sourceIdentifier else { fail("List save outcome requires private verification; do not retry automatically.") }
                emit(["success": true, "listId": persisted.calendarIdentifier, "sourceId": source.sourceIdentifier,
                      "title": persisted.title, "source": source.title, "existingRemindersRead": false, "createdList": true])
            } catch { fail("List creation outcome may be unknown; do not retry automatically.") }
        case "request-notes-automation":
            guard args == [command] else { fail("Unsupported Notes permission arguments.") }
            var target = AEAddressDesc()
            let bundle = "com.apple.Notes"
            let created = bundle.utf8CString.withUnsafeBytes { AECreateDesc(DescType(typeApplicationBundleID), $0.baseAddress, $0.count - 1, &target) }
            guard created == noErr else { fail("Notes permission target could not be constructed.") }
            defer { AEDisposeDesc(&target) }
            let prior = AEDeterminePermissionToAutomateTarget(&target, AEEventClass(typeWildCard), AEEventID(typeWildCard), false)
            guard prior != OSStatus(procNotFound) else { fail("Notes must be explicitly launched after approval before requesting Automation.") }
            let status = prior == noErr ? prior : AEDeterminePermissionToAutomateTarget(&target, AEEventClass(typeWildCard), AEEventID(typeWildCard), true)
            guard status == noErr else { fail("Notes Automation permission was not granted.") }
            emit(["success": true, "authorized": true, "target": bundle, "requestNeeded": prior != noErr,
                  "notesRead": false, "notesWritten": false])
        default: fail("Unsupported enrollment mode.")
        }
    }
}
