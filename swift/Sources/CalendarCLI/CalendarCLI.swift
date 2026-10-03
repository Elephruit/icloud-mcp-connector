import ArgumentParser
import EventKit
import Foundation
import PIMConfig

@main
struct CalendarCLI: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "calendar-cli",
        abstract: "Manage macOS Calendar events using EventKit",
        subcommands: [
            AuthStatus.self,
            Authorize.self,
            ListCalendars.self,
            ListEvents.self,
            GetEvent.self,
            SearchEvents.self,
            CreateEvent.self,
            UpdateEvent.self,
            DeleteEvent.self,
            BatchCreateEvent.self,
            ConfigCommand.self,
        ]
    )
}

// MARK: - Auth Status (no prompts)

struct AuthStatus: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "auth-status",
        abstract: "Check calendar authorization status without triggering prompts"
    )

    func run() throws {
        let status: String
        if #available(macOS 14.0, *) {
            switch EKEventStore.authorizationStatus(for: .event) {
            case .fullAccess: status = "authorized"
            case .writeOnly: status = "writeOnly"
            case .denied: status = "denied"
            case .restricted: status = "restricted"
            case .notDetermined: status = "notDetermined"
            @unknown default: status = "unknown"
            }
        } else {
            switch EKEventStore.authorizationStatus(for: .event) {
            case .authorized: status = "authorized"
            case .denied: status = "denied"
            case .restricted: status = "restricted"
            case .notDetermined: status = "notDetermined"
            default: status = "unknown"
            }
        }
        let result: [String: Any] = ["authorization": status]
        let data = try JSONSerialization.data(withJSONObject: result)
        print(String(data: data, encoding: .utf8)!)
    }
}

// MARK: - Shared Utilities

let eventStore = EKEventStore()

/// Check existing permission only. Ordinary commands must never display a TCC prompt.
func requireCalendarAuthorization() throws {
    let status = EKEventStore.authorizationStatus(for: .event)
    if #available(macOS 14.0, *) {
        guard status == .fullAccess else {
            throw CLIError.accessDenied("Calendar full access is required. Run authorize only after approving this Mac's calendar scope.")
        }
    } else {
        guard status == .authorized else {
            throw CLIError.accessDenied("Calendar access is required. Run authorize only after approving this Mac's calendar scope.")
        }
    }
}

struct Authorize: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "authorize",
        abstract: "Explicitly request macOS Calendar access for a configured scope"
    )
    @OptionGroup var pimOptions: PIMOptions

    func run() async throws {
        let config = pimOptions.loadConfig()
        try requireCalendarScope(config.calendars)
        try await requestCalendarAccess()
        outputJSON(["success": true, "authorization": "authorized"])
    }
}

func requestCalendarAccess() async throws {
    if #available(macOS 14.0, *) {
        let granted = try await eventStore.requestFullAccessToEvents()
        guard granted else {
            throw CLIError.accessDenied("Calendar access denied. Grant access in System Settings > Privacy & Security > Calendars")
        }
    } else {
        let granted = try await eventStore.requestAccess(to: .event)
        guard granted else {
            throw CLIError.accessDenied("Calendar access denied. Grant access in System Settings > Privacy & Security > Calendars")
        }
    }
}

enum CLIError: Error, LocalizedError {
    case accessDenied(String)
    case notFound(String)
    case invalidInput(String)

    var errorDescription: String? {
        switch self {
        case .accessDenied(let msg): return msg
        case .notFound(let msg): return msg
        case .invalidInput(let msg): return msg
        }
    }
}

func outputJSON(_ value: Any) {
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]),
       let string = String(data: data, encoding: .utf8) {
        print(string)
    }
}

// MARK: - Date Output Formatting

private let posixLocale = Locale(identifier: "en_US_POSIX")

/// Format a date using the preset from APPLE_PIM_DATE_FORMAT (or an explicit override).
/// Presets: utc (default), local, day-utc, day-local. Unknown values fall back to utc.
func formatDate(_ date: Date, preset: String? = nil) -> String {
    let preset = (preset ?? ProcessInfo.processInfo.environment["APPLE_PIM_DATE_FORMAT"] ?? "utc").lowercased()
    let useLocal = preset == "local" || preset == "day-local"
    let useDay = preset == "day-utc" || preset == "day-local"

    let iso: String
    if useLocal {
        let fmt = DateFormatter()
        fmt.dateFormat = "yyyy-MM-dd'T'HH:mm:ssxxxxx"
        fmt.locale = posixLocale
        iso = fmt.string(from: date)
    } else {
        iso = ISO8601DateFormatter().string(from: date)
    }

    if useDay {
        let dayFmt = DateFormatter()
        dayFmt.dateFormat = "EEEE"
        dayFmt.locale = posixLocale
        dayFmt.timeZone = useLocal ? TimeZone.current : TimeZone(identifier: "UTC")!
        return "\(dayFmt.string(from: date)), \(iso)"
    }

    return iso
}

// MARK: - Date-Only Detection

private let dateOnlyISO = try! NSRegularExpression(pattern: #"^\d{4}-\d{2}-\d{2}$"#)
private let dateOnlyUS  = try! NSRegularExpression(pattern: #"^\d{2}/\d{2}/\d{4}$"#)

/// Returns true if the string represents a date without an explicit time component.
/// Used to decide whether an end-date should be pushed to end-of-day (23:59:59).
func isDateOnly(_ string: String) -> Bool {
    let trimmed = string.trimmingCharacters(in: .whitespaces)
    let lowercased = trimmed.lowercased()
    if ["today", "tomorrow", "yesterday"].contains(lowercased) { return true }
    let range = NSRange(trimmed.startIndex..., in: trimmed)
    return dateOnlyISO.firstMatch(in: trimmed, range: range) != nil
        || dateOnlyUS.firstMatch(in: trimmed, range: range) != nil
}

/// Adjusts a date to end-of-day (23:59:59) when the original string had no time component.
/// This ensures `--from today --to today` spans the full day instead of a zero-width range.
func adjustToEndOfDay(_ date: Date, originalString: String) -> Date {
    guard isDateOnly(originalString) else { return date }
    var components = Calendar.current.dateComponents([.year, .month, .day], from: date)
    components.hour = 23
    components.minute = 59
    components.second = 59
    return Calendar.current.date(from: components) ?? date
}

func parseDate(_ string: String) -> Date? {
    // Handle relative dates first
    let lowercased = string.lowercased()
    let calendar = Calendar.current
    let now = Date()

    if lowercased == "today" {
        return calendar.startOfDay(for: now)
    } else if lowercased == "tomorrow" {
        return calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now))
    } else if lowercased == "yesterday" {
        return calendar.date(byAdding: .day, value: -1, to: calendar.startOfDay(for: now))
    } else if lowercased.hasPrefix("next ") {
        let component = String(lowercased.dropFirst(5))
        switch component {
        case "week":
            return calendar.date(byAdding: .weekOfYear, value: 1, to: now)
        case "month":
            return calendar.date(byAdding: .month, value: 1, to: now)
        default:
            break
        }
    }

    // Try ISO 8601 first (handles offsets like -07:00, Z, and fractional seconds)
    let isoFormatter = ISO8601DateFormatter()
    isoFormatter.formatOptions = [.withInternetDateTime]
    if let date = isoFormatter.date(from: string) {
        return date
    }
    // Also try with fractional seconds
    isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = isoFormatter.date(from: string) {
        return date
    }

    // DateFormatter patterns for non-ISO formats
    let formats = [
        "yyyy-MM-dd'T'HH:mm:ss",
        "yyyy-MM-dd HH:mm",
        "yyyy-MM-dd h:mm a",
        "yyyy-MM-dd",
        "MM/dd/yyyy HH:mm",
        "MM/dd/yyyy",
    ]
    for format in formats {
        let formatter = DateFormatter()
        formatter.dateFormat = format
        formatter.locale = Locale(identifier: "en_US_POSIX")
        if let date = formatter.date(from: string) {
            return date
        }
    }

    // Try natural language
    let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.date.rawValue)
    if let match = detector?.firstMatch(in: string, range: NSRange(string.startIndex..., in: string)),
       let date = match.date {
        return date
    }

    return nil
}

/// An explicit event timezone is metadata for its already parsed absolute dates.
/// Callers should include an offset in date/time strings to avoid host-timezone ambiguity.
func validatedEventTimeZone(_ identifier: String?) throws -> TimeZone? {
    guard let identifier = identifier else { return nil }
    guard !identifier.isEmpty, let timeZone = TimeZone(identifier: identifier) else {
        throw CLIError.invalidInput("Invalid event timezone identifier")
    }
    return timeZone
}

func calendarToDict(_ calendar: EKCalendar) -> [String: Any] {
    return [
        "id": calendar.calendarIdentifier,
        "title": calendar.title,
        "type": calendarTypeString(calendar.type),
        "color": calendar.cgColor?.components?.map { Int($0 * 255) } ?? [],
        "allowsModifications": calendar.allowsContentModifications,
        "source": calendar.source?.title ?? "Unknown",
        "sourceId": calendar.source?.sourceIdentifier ?? ""
    ]
}

func calendarTypeString(_ type: EKCalendarType) -> String {
    switch type {
    case .local: return "local"
    case .calDAV: return "caldav"
    case .exchange: return "exchange"
    case .subscription: return "subscription"
    case .birthday: return "birthday"
    @unknown default: return "unknown"
    }
}

private let localDateFormatter: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd h:mm a"
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = .current
    return f
}()

func eventToDict(_ event: EKEvent) -> [String: Any] {
    var dict: [String: Any] = [
        "id": event.eventIdentifier ?? "",
        "title": event.title ?? "",
        "startDate": formatDate(event.startDate),
        "endDate": formatDate(event.endDate),
        "localStart": localDateFormatter.string(from: event.startDate),
        "localEnd": localDateFormatter.string(from: event.endDate),
        "isAllDay": event.isAllDay,
        "calendar": event.calendar?.title ?? "",
        "calendarId": event.calendar?.calendarIdentifier ?? ""
    ]

    if let location = event.location, !location.isEmpty {
        dict["location"] = location
    }
    if let notes = event.notes, !notes.isEmpty {
        dict["notes"] = notes
    }
    if let url = event.url {
        dict["url"] = url.absoluteString
    }
    if let timeZone = event.timeZone {
        dict["timezone"] = timeZone.identifier
    }
    if event.hasRecurrenceRules, let rules = event.recurrenceRules {
        dict["recurrence"] = rules.map { ruleToDict($0) }
    }
    if event.hasAlarms, let alarms = event.alarms {
        dict["alarms"] = alarms.map { alarmToDict($0) }
    }
    if event.hasAttendees, let attendees = event.attendees {
        dict["attendees"] = attendees.map { attendeeToDict($0) }
    }

    return dict
}

func ruleToDict(_ rule: EKRecurrenceRule) -> [String: Any] {
    var dict: [String: Any] = [
        "frequency": frequencyString(rule.frequency),
        "interval": rule.interval
    ]
    if let end = rule.recurrenceEnd {
        if let endDate = end.endDate {
            dict["endDate"] = formatDate(endDate)
        } else {
            dict["occurrenceCount"] = end.occurrenceCount
        }
    }
    if let days = rule.daysOfTheWeek, !days.isEmpty {
        dict["daysOfTheWeek"] = days.map { weekdayString($0.dayOfTheWeek) }
    }
    if let days = rule.daysOfTheMonth, !days.isEmpty {
        dict["daysOfTheMonth"] = days.map { $0.intValue }
    }
    return dict
}

func frequencyString(_ freq: EKRecurrenceFrequency) -> String {
    switch freq {
    case .daily: return "daily"
    case .weekly: return "weekly"
    case .monthly: return "monthly"
    case .yearly: return "yearly"
    @unknown default: return "unknown"
    }
}

func alarmToDict(_ alarm: EKAlarm) -> [String: Any] {
    return [
        "relativeOffset": alarm.relativeOffset
    ]
}

func attendeeToDict(_ attendee: EKParticipant) -> [String: Any] {
    return [
        "name": attendee.name ?? "",
        "email": attendee.url.absoluteString.replacingOccurrences(of: "mailto:", with: ""),
        "status": participantStatusString(attendee.participantStatus),
        "role": participantRoleString(attendee.participantRole)
    ]
}

func participantStatusString(_ status: EKParticipantStatus) -> String {
    switch status {
    case .unknown: return "unknown"
    case .pending: return "pending"
    case .accepted: return "accepted"
    case .declined: return "declined"
    case .tentative: return "tentative"
    case .delegated: return "delegated"
    case .completed: return "completed"
    case .inProcess: return "inProcess"
    @unknown default: return "unknown"
    }
}

func participantRoleString(_ role: EKParticipantRole) -> String {
    switch role {
    case .unknown: return "unknown"
    case .required: return "required"
    case .optional: return "optional"
    case .chair: return "chair"
    case .nonParticipant: return "nonParticipant"
    @unknown default: return "unknown"
    }
}

// MARK: - Write Verification

func calendarMatchesRequestedSelector(_ requested: String, storedID: String, storedTitle: String) -> Bool {
    storedID == requested || storedTitle.lowercased() == requested.lowercased()
}

/// Build a verification dict comparing requested inputs against stored event values.
/// Gives calling agents an immediate signal if date parsing produced wrong times.
func buildVerification(event: EKEvent, requestedStart: String, requestedEnd: String?, requestedCalendar: String?) -> [String: Any] {
    let storedStart = formatDate(event.startDate)
    let storedEnd = formatDate(event.endDate)

    // Re-parse the requested strings to compare as Date values (tolerating 1s for rounding)
    let startMatch: Bool
    if let requestedDate = parseDate(requestedStart) {
        startMatch = abs(event.startDate.timeIntervalSince(requestedDate)) < 1.0
    } else {
        startMatch = false
    }

    let endMatch: Bool
    if let reqEnd = requestedEnd, let requestedDate = parseDate(reqEnd) {
        endMatch = abs(event.endDate.timeIntervalSince(requestedDate)) < 1.0
    } else {
        // No explicit end requested (duration or default used), skip end verification
        endMatch = true
    }

    let calendarMatch: Bool
    if let reqCal = requestedCalendar {
        calendarMatch = calendarMatchesRequestedSelector(
            reqCal, storedID: event.calendar?.calendarIdentifier ?? "", storedTitle: event.calendar?.title ?? ""
        )
    } else {
        calendarMatch = true
    }

    var dict: [String: Any] = [
        "requestedStart": requestedStart,
        "storedStart": storedStart,
        "startMatch": startMatch,
        "storedEnd": storedEnd,
        "endMatch": endMatch,
        "allFieldsMatch": startMatch && endMatch && calendarMatch
    ]

    // Only include optional fields when they were explicitly requested
    if let reqEnd = requestedEnd {
        dict["requestedEnd"] = reqEnd
    }
    if let reqCal = requestedCalendar {
        dict["requestedCalendar"] = reqCal
        dict["storedCalendar"] = event.calendar?.title ?? ""
        dict["storedCalendarId"] = event.calendar?.calendarIdentifier ?? ""
        dict["calendarMatch"] = calendarMatch
    }

    return dict
}

// MARK: - Attendee Write Support (Private API)

struct AttendeeJSON: Codable {
    let email: String
    let name: String?
    let role: String?
}

func addAttendeesToEvent(_ event: EKEvent, json: String) throws {
    guard let data = json.data(using: .utf8) else {
        throw CLIError.invalidInput("Invalid attendees JSON encoding")
    }
    let attendeeInputs = try JSONDecoder().decode([AttendeeJSON].self, from: data)
    try setAttendeesOnEvent(event, attendees: attendeeInputs)
}

func addAttendeesToEvent(_ event: EKEvent, attendees attendeeInputs: [AttendeeJSON]) throws {
    try setAttendeesOnEvent(event, attendees: attendeeInputs)
}

/// Safely set a value via KVC, checking that the setter exists first.
/// Returns true if the setter was found and called, false otherwise.
/// This avoids uncatchable NSException crashes from setValue:forUndefinedKey:.
@discardableResult
private func safeSetValue(_ object: NSObject, _ value: Any?, forKey key: String) -> Bool {
    let setter = NSSelectorFromString("set\(key.prefix(1).uppercased())\(key.dropFirst()):")
    guard object.responds(to: setter) else { return false }
    object.setValue(value, forKey: key)
    return true
}

private func setAttendeesOnEvent(_ event: EKEvent, attendees attendeeInputs: [AttendeeJSON]) throws {
    guard let ekAttendeeClass = NSClassFromString("EKAttendee") as? NSObject.Type else {
        throw CLIError.invalidInput(
            "EKAttendee class not available on this macOS version. " +
            "Attendee write support requires the private EKAttendee class."
        )
    }

    // Verify required KVC keys are available on this macOS version
    let probe = ekAttendeeClass.init()
    guard probe.responds(to: NSSelectorFromString("setEmailAddress:")) else {
        throw CLIError.invalidInput(
            "EKAttendee on this macOS version does not support setEmailAddress:. " +
            "Attendee write support is not available."
        )
    }

    var attendeeObjects: [NSObject] = []

    for input in attendeeInputs {
        let attendee = ekAttendeeClass.init()

        // UUID is required — EventKit's _addNewAttendeesToRecentsIfNeeded
        // uses it as a dictionary key and crashes with nil if missing.
        // Fail loudly if UUID can't be set rather than risking a later NSException.
        guard safeSetValue(attendee, UUID().uuidString, forKey: "UUID") else {
            throw CLIError.invalidInput(
                "EKAttendee on this macOS version does not support setUUID:. " +
                "Cannot safely create attendees without UUID support."
            )
        }
        safeSetValue(attendee, input.email, forKey: "emailAddress")

        if let name = input.name, !name.isEmpty {
            let parts = name.split(separator: " ", maxSplits: 1)
            if let first = parts.first {
                safeSetValue(attendee, String(first), forKey: "firstName")
            }
            if parts.count > 1 {
                safeSetValue(attendee, String(parts[1]), forKey: "lastName")
            }
        }

        let role: Int
        switch input.role?.lowercased() {
        case "optional":
            role = EKParticipantRole.optional.rawValue
        case "chair":
            role = EKParticipantRole.chair.rawValue
        case "nonparticipant":
            role = EKParticipantRole.nonParticipant.rawValue
        default:
            role = EKParticipantRole.required.rawValue
        }
        safeSetValue(attendee, role, forKey: "participantRole")

        attendeeObjects.append(attendee)
    }

    // Set attendees on the event via KVC (replaces any existing attendees).
    // Guard against NSException if EKEvent doesn't expose this key.
    guard event.responds(to: NSSelectorFromString("setAttendees:")) else {
        throw CLIError.invalidInput(
            "EKEvent on this macOS version does not support setAttendees:. " +
            "Attendee write support is not available."
        )
    }
    event.setValue(attendeeObjects, forKey: "attendees")
}

// MARK: - Config Helpers

/// Validate the scope before any authorization or EventKit data access.
func requireCalendarScope(_ config: DomainFilterConfig, deletion: Bool = false, writing: Bool = false) throws {
    guard config.hasExplicitScope else {
        throw CLIError.accessDenied("Calendar access requires enabled allowlist configuration with exact item and account IDs.")
    }
    guard !deletion || config.allowDeletes else {
        throw CLIError.accessDenied("Calendar deletion is disabled. Set allow_deletes explicitly for the approved scope to enable it.")
    }
    guard !writing || config.allowWrites else {
        throw CLIError.accessDenied("Calendar writes are disabled. Set allow_writes explicitly for the approved scope to enable them.")
    }
}

/// Pure selection seam: a name can identify one scoped item only; IDs win exactly.
func selectAllowedCalendar<T>(
    nameOrId: String,
    exactIDOnly: Bool = false,
    items: [T],
    config: DomainFilterConfig,
    name: (T) -> String,
    id: (T) -> String,
    accountID: (T) -> String
) throws -> T {
    try requireCalendarScope(config)
    let allowed = items.filter {
        ItemFilter.isAllowed(name: name($0), id: id($0), accountID: accountID($0), config: config)
    }
    if let exact = allowed.first(where: { id($0) == nameOrId }) { return exact }
    guard !exactIDOnly else {
        throw CLIError.notFound("The configured default ID is unavailable within the allowed scope.")
    }
    let matches = allowed.filter { name($0).caseInsensitiveCompare(nameOrId) == .orderedSame }
    guard !matches.isEmpty else {
        throw CLIError.notFound("No allowed calendar matches the requested name or ID.")
    }
    guard matches.count == 1 else {
        throw CLIError.invalidInput("Calendar name is ambiguous within the allowed scope. Use an exact item ID.")
    }
    return matches[0]
}

/// Get only explicitly allowed items from explicitly allowed EventKit sources.
func allowedCalendars(config: PIMConfiguration) throws -> [EKCalendar] {
    try requireCalendarScope(config.calendars)
    let all = eventStore.calendars(for: .event)
    let allowed = ItemFilter.filter(
        items: all, config: config.calendars, name: { $0.title },
        id: { $0.calendarIdentifier }, accountID: { $0.source?.sourceIdentifier ?? "" }
    )
    guard !allowed.isEmpty else {
        throw CLIError.accessDenied("No configured calendar is available in an allowed account.")
    }
    return allowed
}

/// Missing item/source identities are denied rather than treated as accessible.
func validateEventAccess(_ event: EKEvent, config: PIMConfiguration) throws {
    guard let cal = event.calendar,
          ItemFilter.isAllowed(
            name: cal.title, id: cal.calendarIdentifier,
            accountID: cal.source?.sourceIdentifier, config: config.calendars
          ) else {
        throw CLIError.accessDenied("The requested item is outside the configured calendar and account scope.")
    }
}

func findAllowedCalendar(nameOrId: String, exactIDOnly: Bool = false, config: PIMConfiguration) throws -> EKCalendar {
    try requireCalendarScope(config.calendars)
    return try selectAllowedCalendar(
        nameOrId: nameOrId, exactIDOnly: exactIDOnly, items: eventStore.calendars(for: .event), config: config.calendars,
        name: { $0.title }, id: { $0.calendarIdentifier }, accountID: { $0.source?.sourceIdentifier ?? "" }
    )
}

/// A configured default must be a stable allowed ID. Never use the system default.
func targetCalendarSelector(explicit: String?, defaultID: String?, config: DomainFilterConfig) throws -> String {
    try requireCalendarScope(config)
    if let explicit = explicit, !explicit.isEmpty { return explicit }
    guard let defaultID = defaultID, config.items.contains(defaultID) else {
        throw CLIError.invalidInput("Specify an allowed calendar or configure its exact ID as the default.")
    }
    return defaultID
}

func resolveTargetCalendar(explicit: String?, config: PIMConfiguration) throws -> EKCalendar {
    let selector = try targetCalendarSelector(explicit: explicit, defaultID: config.defaultCalendar, config: config.calendars)
    return try findAllowedCalendar(nameOrId: selector, exactIDOnly: explicit == nil || explicit?.isEmpty == true, config: config)
}

/// Exact ID selection operates on records already returned by a scoped predicate.
func selectScopedEvent<T>(id: String, items: [T], identifier: (T) -> String) throws -> T {
    let matches = items.filter { identifier($0) == id }
    guard !matches.isEmpty else {
        throw CLIError.notFound("No accessible event matches the ID within the lookup date window. Specify --from and --to if needed.")
    }
    guard matches.count == 1 else {
        throw CLIError.invalidInput("Event ID matches multiple occurrences. Narrow --from and --to to one occurrence.")
    }
    return matches[0]
}

/// EventKit date predicates must be bounded. Defaults cover 366 days either side.
func eventLookupWindow(from: String?, to: String?, now: Date = Date()) throws -> (start: Date, end: Date) {
    let calendar = Calendar.current
    let start: Date
    let end: Date
    if let from = from {
        guard let parsed = parseDate(from) else { throw CLIError.invalidInput("Invalid lookup start date") }
        start = parsed
    } else {
        start = calendar.date(byAdding: .day, value: -366, to: now)!
    }
    if let to = to {
        guard let parsed = parseDate(to) else { throw CLIError.invalidInput("Invalid lookup end date") }
        end = adjustToEndOfDay(parsed, originalString: to)
    } else {
        end = calendar.date(byAdding: .day, value: 366, to: now)!
    }
    guard end > start, let maximumEnd = calendar.date(byAdding: .year, value: 4, to: start), end <= maximumEnd else {
        throw CLIError.invalidInput("Lookup date window must be increasing and span no more than four years.")
    }
    return (start, end)
}

func findAllowedEvent(id: String, config: PIMConfiguration, from: String? = nil, to: String? = nil) throws -> EKEvent {
    let calendars = try allowedCalendars(config: config)
    let window = try eventLookupWindow(from: from, to: to)
    let predicate = eventStore.predicateForEvents(withStart: window.start, end: window.end, calendars: calendars)
    let scoped = eventStore.events(matching: predicate)
        .filter { (try? validateEventAccess($0, config: config)) != nil }
    return try selectScopedEvent(id: id, items: scoped, identifier: { $0.eventIdentifier ?? "" })
}

// MARK: - Recurrence Helpers

struct RecurrenceJSON: Codable {
    let frequency: String?
    let interval: Int?
    let endDate: String?
    let occurrenceCount: Int?
    let daysOfTheWeek: [String]?
    let daysOfTheMonth: [Int]?
}

func weekdayString(_ weekday: EKWeekday) -> String {
    switch weekday {
    case .sunday: return "sunday"
    case .monday: return "monday"
    case .tuesday: return "tuesday"
    case .wednesday: return "wednesday"
    case .thursday: return "thursday"
    case .friday: return "friday"
    case .saturday: return "saturday"
    @unknown default: return "unknown"
    }
}

func dayStringToEKDay(_ day: String) -> EKRecurrenceDayOfWeek? {
    switch day.lowercased() {
    case "sunday", "sun": return EKRecurrenceDayOfWeek(.sunday)
    case "monday", "mon": return EKRecurrenceDayOfWeek(.monday)
    case "tuesday", "tue": return EKRecurrenceDayOfWeek(.tuesday)
    case "wednesday", "wed": return EKRecurrenceDayOfWeek(.wednesday)
    case "thursday", "thu": return EKRecurrenceDayOfWeek(.thursday)
    case "friday", "fri": return EKRecurrenceDayOfWeek(.friday)
    case "saturday", "sat": return EKRecurrenceDayOfWeek(.saturday)
    default: return nil
    }
}

func parseRecurrenceRule(_ json: String) -> EKRecurrenceRule? {
    guard let data = json.data(using: .utf8),
          let recurrence = try? JSONDecoder().decode(RecurrenceJSON.self, from: data) else {
        return nil
    }

    // A nil or "none" frequency means remove recurrence — return nil
    guard let freqStr = recurrence.frequency?.lowercased(), freqStr != "none" else {
        return nil
    }

    // Parse frequency
    let frequency: EKRecurrenceFrequency
    switch freqStr {
    case "daily": frequency = .daily
    case "weekly": frequency = .weekly
    case "monthly": frequency = .monthly
    case "yearly": frequency = .yearly
    default: return nil
    }

    // Parse interval (default: 1)
    let interval = recurrence.interval ?? 1

    // Parse end condition
    var recurrenceEnd: EKRecurrenceEnd? = nil
    if let endDateStr = recurrence.endDate, let endDate = parseDate(endDateStr) {
        recurrenceEnd = EKRecurrenceEnd(end: endDate)
    } else if let count = recurrence.occurrenceCount {
        recurrenceEnd = EKRecurrenceEnd(occurrenceCount: count)
    }

    // Parse days of the week
    var daysOfTheWeek: [EKRecurrenceDayOfWeek]? = nil
    if let days = recurrence.daysOfTheWeek {
        daysOfTheWeek = days.compactMap { dayStringToEKDay($0) }
        if daysOfTheWeek?.isEmpty == true {
            daysOfTheWeek = nil
        }
    }

    // Parse days of the month
    var daysOfTheMonth: [NSNumber]? = nil
    if let days = recurrence.daysOfTheMonth {
        daysOfTheMonth = days.map { NSNumber(value: $0) }
        if daysOfTheMonth?.isEmpty == true {
            daysOfTheMonth = nil
        }
    }

    return EKRecurrenceRule(
        recurrenceWith: frequency,
        interval: interval,
        daysOfTheWeek: daysOfTheWeek,
        daysOfTheMonth: daysOfTheMonth,
        monthsOfTheYear: nil,
        weeksOfTheYear: nil,
        daysOfTheYear: nil,
        setPositions: nil,
        end: recurrenceEnd
    )
}

// MARK: - Commands

struct ListCalendars: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "list",
        abstract: "List all calendars"
    )

    @OptionGroup var pimOptions: PIMOptions

    func run() async throws {
        let config = pimOptions.loadConfig()
        try requireCalendarScope(config.calendars)
        try requireCalendarAuthorization()
        let calendars = try allowedCalendars(config: config)
        let result = calendars.map { calendarToDict($0) }

        outputJSON([
            "success": true,
            "calendars": result
        ])
    }
}

struct ListEvents: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "events",
        abstract: "List events within a date range"
    )

    @OptionGroup var pimOptions: PIMOptions

    @Option(name: .long, help: "Calendar name or ID to filter by")
    var calendar: String?

    @Option(name: .long, help: "Start date (default: today)")
    var from: String = "today"

    @Option(name: .long, help: "End date (default: 7 days from now)")
    var to: String?

    @Option(name: .long, help: "Maximum number of events to return")
    var limit: Int = 100

    func run() async throws {
        let config = pimOptions.loadConfig()
        try requireCalendarScope(config.calendars)
        try requireCalendarAuthorization()

        guard let startDate = parseDate(from) else {
            throw CLIError.invalidInput("Invalid start date: \(from)")
        }

        let endDate: Date
        if let toStr = to {
            guard let parsed = parseDate(toStr) else {
                throw CLIError.invalidInput("Invalid end date: \(toStr)")
            }
            endDate = adjustToEndOfDay(parsed, originalString: toStr)
        } else {
            endDate = Calendar.current.date(byAdding: .day, value: 7, to: startDate) ?? startDate
        }

        // Resolve calendars: explicit filter > all allowed calendars
        var calendars: [EKCalendar]
        if let calendarFilter = calendar {
            let cal = try findAllowedCalendar(nameOrId: calendarFilter, config: config)
            calendars = [cal]
        } else {
            // Restrict to allowed calendars only
            calendars = try allowedCalendars(config: config)
        }

        let predicate = eventStore.predicateForEvents(withStart: startDate, end: endDate, calendars: calendars)
        let events = eventStore.events(matching: predicate)
            .filter { (try? validateEventAccess($0, config: config)) != nil }
            .prefix(limit)
            .map { eventToDict($0) }

        outputJSON([
            "success": true,
            "events": Array(events),
            "count": events.count,
            "dateRange": [
                "from": formatDate(startDate),
                "to": formatDate(endDate)
            ]
        ])
    }
}

struct GetEvent: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "get",
        abstract: "Get a single event by ID"
    )

    @OptionGroup var pimOptions: PIMOptions

    @Option(name: .long, help: "Start of scoped ID lookup window (default: 366 days ago)")
    var from: String?

    @Option(name: .long, help: "End of scoped ID lookup window (default: 366 days ahead; maximum span four years)")
    var to: String?

    @Option(name: .long, help: "Event ID")
    var id: String

    func run() async throws {
        let config = pimOptions.loadConfig()
        try requireCalendarScope(config.calendars)
        try requireCalendarAuthorization()

        let event = try findAllowedEvent(id: id, config: config, from: from, to: to)

        outputJSON([
            "success": true,
            "event": eventToDict(event)
        ])
    }
}

struct SearchEvents: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "search",
        abstract: "Search events by title"
    )

    @OptionGroup var pimOptions: PIMOptions

    @Argument(help: "Search query")
    var query: String

    @Option(name: .long, help: "Calendar name or ID to search in")
    var calendar: String?

    @Option(name: .long, help: "Start date for search range (default: 30 days ago)")
    var from: String?

    @Option(name: .long, help: "End date for search range (default: 1 year from now)")
    var to: String?

    @Option(name: .long, help: "Maximum results")
    var limit: Int = 50

    func run() async throws {
        let config = pimOptions.loadConfig()
        try requireCalendarScope(config.calendars)
        try requireCalendarAuthorization()

        let startDate = from.flatMap { parseDate($0) } ?? Calendar.current.date(byAdding: .day, value: -30, to: Date())!
        let endDate: Date
        if let toStr = to, let parsed = parseDate(toStr) {
            endDate = adjustToEndOfDay(parsed, originalString: toStr)
        } else {
            endDate = Calendar.current.date(byAdding: .year, value: 1, to: Date())!
        }

        // Resolve calendars: explicit filter > all allowed calendars
        var calendars: [EKCalendar]
        if let calendarFilter = calendar {
            let cal = try findAllowedCalendar(nameOrId: calendarFilter, config: config)
            calendars = [cal]
        } else {
            calendars = try allowedCalendars(config: config)
        }

        let predicate = eventStore.predicateForEvents(withStart: startDate, end: endDate, calendars: calendars)
        let events = eventStore.events(matching: predicate)
            .filter { (try? validateEventAccess($0, config: config)) != nil }
            .filter { event in
                let title = event.title?.lowercased() ?? ""
                let notes = event.notes?.lowercased() ?? ""
                let location = event.location?.lowercased() ?? ""
                let queryLower = query.lowercased()
                return title.contains(queryLower) || notes.contains(queryLower) || location.contains(queryLower)
            }
            .prefix(limit)
            .map { eventToDict($0) }

        outputJSON([
            "success": true,
            "query": query,
            "events": Array(events),
            "count": events.count
        ])
    }
}

struct CreateEvent: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "create",
        abstract: "Create a new calendar event"
    )

    @OptionGroup var pimOptions: PIMOptions

    @Option(name: .long, help: "Event title")
    var title: String

    @Option(name: .long, help: "Start date/time")
    var start: String

    @Option(name: .long, help: "End date/time (default: 1 hour after start)")
    var end: String?

    @Option(name: .long, help: "Duration in minutes (alternative to --end)")
    var duration: Int?

    @Option(name: .long, help: "Event timezone identifier (e.g. America/Chicago); include UTC offsets in --start/--end")
    var timezone: String?

    @Option(name: .long, help: "Calendar name or ID (default: default calendar)")
    var calendar: String?

    @Option(name: .long, help: "Event location")
    var location: String?

    @Option(name: .long, help: "Event notes")
    var notes: String?

    @Option(name: .long, help: "URL associated with the event")
    var url: String?

    @Flag(name: .long, help: "All-day event")
    var allDay: Bool = false

    @Option(name: .long, help: "Alarm minutes before event (can specify multiple)")
    var alarm: [Int] = []

    @Option(name: .long, help: "Recurrence rule as JSON (e.g., '{\"frequency\":\"weekly\",\"interval\":1}')")
    var recurrence: String?

    @Option(name: .long, help: "Attendees as JSON array (e.g., '[{\"email\":\"a@b.com\",\"name\":\"Name\"}]')")
    var attendees: String?

    func run() async throws {
        let config = pimOptions.loadConfig()
        try requireCalendarScope(config.calendars, writing: true)
        let eventTimeZone = try validatedEventTimeZone(timezone)
        try requireCalendarAuthorization()

        guard let startDate = parseDate(start) else {
            throw CLIError.invalidInput("Invalid start date: \(start)")
        }

        let endDate: Date
        if let endStr = end {
            guard let parsed = parseDate(endStr) else {
                throw CLIError.invalidInput("Invalid end date: \(endStr)")
            }
            endDate = parsed
        } else if let durationMinutes = duration {
            endDate = Calendar.current.date(byAdding: .minute, value: durationMinutes, to: startDate) ?? startDate
        } else {
            endDate = Calendar.current.date(byAdding: .hour, value: 1, to: startDate) ?? startDate
        }

        let event = EKEvent(eventStore: eventStore)
        event.title = title
        event.startDate = startDate
        event.endDate = endDate
        event.isAllDay = allDay
        event.calendar = try resolveTargetCalendar(explicit: calendar, config: config)
        if let eventTimeZone = eventTimeZone {
            event.timeZone = eventTimeZone
        }

        if let loc = location {
            event.location = loc
        }
        if let n = notes {
            event.notes = n
        }
        if let urlStr = url, let eventUrl = URL(string: urlStr) {
            event.url = eventUrl
        }

        // An empty explicit array suppresses calendar/system default alerts.
        event.alarms = alarm.map { EKAlarm(relativeOffset: TimeInterval(-$0 * 60)) }

        // Add recurrence rule if specified
        if let recurrenceJSON = recurrence, let rule = parseRecurrenceRule(recurrenceJSON) {
            event.addRecurrenceRule(rule)
        }

        // Add attendees if specified
        if let attendeesJSON = attendees {
            try addAttendeesToEvent(event, json: attendeesJSON)
        }

        try eventStore.save(event, span: .thisEvent)

        outputJSON([
            "success": true,
            "message": "Event created successfully",
            "event": eventToDict(event),
            "verification": buildVerification(
                event: event,
                requestedStart: start,
                requestedEnd: end,
                requestedCalendar: calendar
            )
        ])
    }
}

struct UpdateEvent: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "update",
        abstract: "Update an existing event"
    )

    @OptionGroup var pimOptions: PIMOptions

    @Option(name: .long, help: "Start of scoped ID lookup window (default: 366 days ago)")
    var from: String?

    @Option(name: .long, help: "End of scoped ID lookup window (default: 366 days ahead; maximum span four years)")
    var to: String?

    @Option(name: .long, help: "Event ID to update")
    var id: String

    @Option(name: .long, help: "New title")
    var title: String?

    @Option(name: .long, help: "New start date/time")
    var start: String?

    @Option(name: .long, help: "New end date/time")
    var end: String?

    @Option(name: .long, help: "New location")
    var location: String?

    @Option(name: .long, help: "New notes")
    var notes: String?

    @Option(name: .long, help: "New URL")
    var url: String?

    @Option(name: .long, help: "Recurrence rule as JSON (e.g., '{\"frequency\":\"weekly\",\"interval\":1}')")
    var recurrence: String?

    @Option(name: .long, help: "Attendees as JSON array (replaces all existing attendees)")
    var attendees: String?

    @Flag(name: .long, help: "Apply changes to all future events in a recurring series")
    var futureEvents: Bool = false

    func run() async throws {
        let config = pimOptions.loadConfig()
        try requireCalendarScope(config.calendars, writing: true)
        try requireCalendarAuthorization()

        let event = try findAllowedEvent(id: id, config: config, from: from, to: to)

        if let newTitle = title {
            event.title = newTitle
        }
        if let newStart = start {
            guard let date = parseDate(newStart) else {
                throw CLIError.invalidInput("Invalid start date: \(newStart)")
            }
            event.startDate = date
        }
        if let newEnd = end {
            guard let date = parseDate(newEnd) else {
                throw CLIError.invalidInput("Invalid end date: \(newEnd)")
            }
            event.endDate = date
        }
        if let newLocation = location {
            event.location = newLocation
        }
        if let newNotes = notes {
            event.notes = newNotes
        }
        if let urlStr = url, let eventUrl = URL(string: urlStr) {
            event.url = eventUrl
        }

        // Update recurrence rule if specified
        if let recurrenceJSON = recurrence {
            // Remove existing recurrence rules
            if let existingRules = event.recurrenceRules {
                for rule in existingRules {
                    event.removeRecurrenceRule(rule)
                }
            }
            // Add new recurrence rule
            if let rule = parseRecurrenceRule(recurrenceJSON) {
                event.addRecurrenceRule(rule)
            }
        }

        // Update attendees if specified
        if let attendeesJSON = attendees {
            try addAttendeesToEvent(event, json: attendeesJSON)
        }

        // Only use futureEvents span when explicitly requested by user
        let span: EKSpan = futureEvents ? .futureEvents : .thisEvent
        try eventStore.save(event, span: span)

        var result: [String: Any] = [
            "success": true,
            "message": "Event updated successfully",
            "event": eventToDict(event)
        ]

        // Include verification when start or end was updated
        if start != nil || end != nil {
            result["verification"] = buildVerification(
                event: event,
                requestedStart: start ?? ISO8601DateFormatter().string(from: event.startDate),
                requestedEnd: end,
                requestedCalendar: nil
            )
        }

        outputJSON(result)
    }
}

struct DeleteEvent: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "delete",
        abstract: "Delete an event"
    )

    @OptionGroup var pimOptions: PIMOptions

    @Option(name: .long, help: "Start of scoped ID lookup window (default: 366 days ago)")
    var from: String?

    @Option(name: .long, help: "End of scoped ID lookup window (default: 366 days ahead; maximum span four years)")
    var to: String?

    @Option(name: .long, help: "Event ID to delete")
    var id: String

    @Flag(name: .long, help: "Delete this and all future events in a recurring series")
    var futureEvents: Bool = false

    func run() async throws {
        let config = pimOptions.loadConfig()
        try requireCalendarScope(config.calendars, deletion: true, writing: true)
        try requireCalendarAuthorization()

        let event = try findAllowedEvent(id: id, config: config, from: from, to: to)

        let eventInfo = eventToDict(event)
        let span: EKSpan = futureEvents ? .futureEvents : .thisEvent
        try eventStore.remove(event, span: span)

        outputJSON([
            "success": true,
            "message": futureEvents ? "Event and future occurrences deleted successfully" : "Event deleted successfully",
            "deletedEvent": eventInfo
        ])
    }
}

// MARK: - Batch Operations

struct BatchEventInput: Codable {
    let title: String
    let start: String
    let end: String?
    let duration: Int?
    let calendar: String?
    let location: String?
    let notes: String?
    let url: String?
    let allDay: Bool?
    let alarm: [Int]?
    let recurrence: RecurrenceJSON?
    let attendees: [AttendeeJSON]?
}

func decodeBatchEvents(_ json: String) throws -> [BatchEventInput] {
    guard let data = json.data(using: .utf8),
          let events = try? JSONDecoder().decode([BatchEventInput].self, from: data) else {
        throw CLIError.invalidInput("Invalid JSON format for events array")
    }

    if events.isEmpty {
        throw CLIError.invalidInput("Events array cannot be empty")
    }

    return events
}

func resolveBatchEventDates(_ eventInput: BatchEventInput) throws -> (startDate: Date, endDate: Date) {
    guard let startDate = parseDate(eventInput.start) else {
        throw CLIError.invalidInput("Invalid start date: \(eventInput.start)")
    }

    let endDate: Date
    if let endStr = eventInput.end {
        guard let parsed = parseDate(endStr) else {
            throw CLIError.invalidInput("Invalid end date: \(endStr)")
        }
        endDate = parsed
    } else if let durationMinutes = eventInput.duration {
        endDate = Calendar.current.date(byAdding: .minute, value: durationMinutes, to: startDate) ?? startDate
    } else {
        endDate = Calendar.current.date(byAdding: .hour, value: 1, to: startDate) ?? startDate
    }

    return (startDate, endDate)
}

struct BatchCreateEvent: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "batch-create",
        abstract: "Create multiple calendar events in a single transaction"
    )

    @OptionGroup var pimOptions: PIMOptions

    @Option(name: .long, help: "JSON array of events to create")
    var json: String

    func run() async throws {
        let config = pimOptions.loadConfig()
        try requireCalendarScope(config.calendars, writing: true)
        try requireCalendarAuthorization()
        let events = try decodeBatchEvents(json)

        var createdEvents: [[String: Any]] = []
        var errors: [[String: Any]] = []

        for (index, eventInput) in events.enumerated() {
            do {
                let dates = try resolveBatchEventDates(eventInput)
                let startDate = dates.startDate
                let endDate = dates.endDate

                let event = EKEvent(eventStore: eventStore)
                event.title = eventInput.title
                event.startDate = startDate
                event.endDate = endDate
                event.isAllDay = eventInput.allDay ?? false
                event.calendar = try resolveTargetCalendar(explicit: eventInput.calendar, config: config)

                if let loc = eventInput.location {
                    event.location = loc
                }
                if let n = eventInput.notes {
                    event.notes = n
                }
                if let urlStr = eventInput.url, let eventUrl = URL(string: urlStr) {
                    event.url = eventUrl
                }

                if let alarms = eventInput.alarm {
                    for minutes in alarms {
                        let alarm = EKAlarm(relativeOffset: TimeInterval(-minutes * 60))
                        event.addAlarm(alarm)
                    }
                }

                // Add recurrence rule if specified
                if let recurrenceInput = eventInput.recurrence {
                    let recurrenceJSON = try JSONEncoder().encode(recurrenceInput)
                    if let recurrenceStr = String(data: recurrenceJSON, encoding: .utf8),
                       let rule = parseRecurrenceRule(recurrenceStr) {
                        event.addRecurrenceRule(rule)
                    }
                }

                // Add attendees if specified
                if let attendeeInputs = eventInput.attendees {
                    try addAttendeesToEvent(event, attendees: attendeeInputs)
                }

                // Save with commit: false to batch changes
                try eventStore.save(event, span: .thisEvent, commit: false)
                createdEvents.append(eventToDict(event))
            } catch {
                errors.append([
                    "index": index,
                    "title": eventInput.title,
                    "error": error.localizedDescription
                ])
            }
        }

        // Commit all changes at once
        if !createdEvents.isEmpty {
            try eventStore.commit()
        }

        outputJSON([
            "success": errors.isEmpty,
            "message": "Batch create completed",
            "created": createdEvents,
            "createdCount": createdEvents.count,
            "errors": errors,
            "errorCount": errors.count
        ])
    }
}

// MARK: - Config Commands

struct ConfigCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "config",
        abstract: "Manage PIM configuration",
        subcommands: [ConfigShow.self, ConfigInit.self]
    )
}

struct ConfigShow: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "show",
        abstract: "Display the resolved configuration (base + profile)"
    )

    @OptionGroup var pimOptions: PIMOptions

    func run() throws {
        let config = pimOptions.loadConfig()
        let ctx = pimOptions.outputContext
        let activeProfile = pimOptions.profile ?? ProcessInfo.processInfo.environment["APPLE_PIM_PROFILE"]

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(config)

        pimOutput(
            [
                "success": true,
                "configPath": ConfigLoader.defaultConfigPath.path,
                "profilesDir": ConfigLoader.profilesDir.path,
                "activeProfile": activeProfile as Any,
                "config": (try? JSONSerialization.jsonObject(with: data)) ?? [:]
            ],
            text: ConfigFormatter.formatConfigShow(
                config: config,
                configPath: ConfigLoader.defaultConfigPath.path,
                profilesDir: ConfigLoader.profilesDir.path,
                activeProfile: activeProfile
            ),
            context: ctx
        )
    }
}

struct ConfigInit: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "init",
        abstract: "Show only calendars already allowed by explicit configuration"
    )

    @OptionGroup var pimOptions: PIMOptions

    func run() async throws {
        let config = pimOptions.loadConfig()
        try requireCalendarScope(config.calendars)
        try requireCalendarAuthorization()
        let ctx = pimOptions.outputContext

        let allowed = try allowedCalendars(config: config)
        let calendars = allowed.map { calendarToDict($0) }
        let defaultCal = allowed.first { $0.calendarIdentifier == config.defaultCalendar }?.calendarIdentifier ?? ""
        // Each domain has separate scope and authorization. This command reads calendars only.
        let lists: [[String: Any]] = []
        let defaultRem = ""

        pimOutput(
            [
                "success": true,
                "configPath": ConfigLoader.defaultConfigPath.path,
                "profilesDir": ConfigLoader.profilesDir.path,
                "availableCalendars": calendars,
                "availableReminderLists": lists,
                "defaultCalendar": defaultCal,
                "defaultReminderList": defaultRem
            ],
            text: ConfigFormatter.formatConfigInit(
                configPath: ConfigLoader.defaultConfigPath.path,
                profilesDir: ConfigLoader.profilesDir.path,
                calendars: calendars,
                reminderLists: lists,
                defaultCalendar: defaultCal,
                defaultReminderList: defaultRem
            ),
            context: ctx
        )
    }
}

func listToDict(_ calendar: EKCalendar) -> [String: Any] {
    return [
        "id": calendar.calendarIdentifier,
        "title": calendar.title,
        "color": calendar.cgColor?.components?.map { Int($0 * 255) } ?? [],
        "allowsModifications": calendar.allowsContentModifications,
        "source": calendar.source?.title ?? "Unknown",
        "sourceId": calendar.source?.sourceIdentifier ?? ""
    ]
}
