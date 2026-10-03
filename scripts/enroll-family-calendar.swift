import EventKit
import Foundation

// Manual, one-shot enrollment only. This is not an MCP tool and is never
// launched by the connector. Do not run it without explicit live-test approval.
// EventKit exposes all calendar metadata to perform this identity comparison;
// no event query, event body read, save, or delete occurs here.
@main
struct FamilyCalendarEnrollment {
    static func main() async {
        let args = Array(CommandLine.arguments.dropFirst())
        guard args == ["resolve"] || args == ["resolve", "--request-calendar-access"] else {
            emit(["success": false, "error": "Usage: enroll-family-calendar resolve [--request-calendar-access]; requires approval for Family/iCloud metadata enrollment"])
            exit(2)
        }

        let store = EKEventStore()
        if !authorized() {
            guard args.contains("--request-calendar-access") else {
                emit(["success": false, "error": "Calendar read access is not granted. No prompt or metadata query occurred."])
                exit(1)
            }
            do {
                let granted: Bool
                if #available(macOS 14.0, *) {
                    granted = try await store.requestFullAccessToEvents()
                } else {
                    granted = try await store.requestAccess(to: .event)
                }
                guard granted, authorized() else {
                    emit(["success": false, "error": "Calendar permission was not granted; enrollment stopped."])
                    exit(1)
                }
            } catch {
                emit(["success": false, "error": "Calendar permission request failed; enrollment stopped without metadata output."])
                exit(1)
            }
        }

        // Exact display names are a temporary enrollment selector only. They
        // never grant connector access: the output's stable IDs must be reviewed
        // and placed in the private exact-ID allowlists before any MCP call.
        let matches = store.calendars(for: .event).filter {
            $0.title == "Family" && $0.source?.title == "iCloud"
        }
        guard matches.count == 1,
              let calendar = matches.first,
              let source = calendar.source,
              !calendar.calendarIdentifier.isEmpty,
              !source.sourceIdentifier.isEmpty else {
            emit(["success": false, "error": "Expected one exact Family calendar in a source named iCloud. Zero/ambiguous matches require owner clarification; no candidate identifiers were returned."])
            exit(1)
        }
        emit([
            "success": true,
            "calendar": ["id": calendar.calendarIdentifier, "title": calendar.title],
            "source": ["id": source.sourceIdentifier, "title": source.title],
            "eventsRead": false,
            "writesPerformed": false,
        ])
    }

    static func authorized() -> Bool {
        let status = EKEventStore.authorizationStatus(for: .event)
        if #available(macOS 14.0, *) { return status == .fullAccess }
        return status == .authorized
    }

    static func emit(_ result: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]),
              let text = String(data: data, encoding: .utf8) else { exit(1) }
        print(text)
    }
}
