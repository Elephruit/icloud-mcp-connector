import Foundation
import XCTest
@testable import CalendarCLI

/// Pure date/identifier fixtures only. Never instantiate or query an EventKit store.
final class EventTimeZoneTests: XCTestCase {
    func testExplicitIdentifierIsPreserved() throws {
        let timeZone = try XCTUnwrap(validatedEventTimeZone("America/Chicago"))
        XCTAssertEqual(timeZone.identifier, "America/Chicago")
    }

    func testOmittedIdentifierPreservesExistingDefaultBehavior() throws {
        XCTAssertNil(try validatedEventTimeZone(nil))
    }

    func testInvalidOrEmptyIdentifierFails() {
        XCTAssertThrowsError(try validatedEventTimeZone(""))
        XCTAssertThrowsError(try validatedEventTimeZone("Invalid/Synthetic_Zone"))
    }

    func testWinterOffsetDatesPreserveLocalTimesAndDuration() throws {
        let timeZone = try XCTUnwrap(validatedEventTimeZone("America/Chicago"))
        let start = try XCTUnwrap(parseDate("2030-02-04T09:15:00-06:00"))
        let end = try XCTUnwrap(parseDate("2030-02-04T10:45:00-06:00"))
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let startParts = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: start)
        let endParts = calendar.dateComponents([.hour, .minute], from: end)

        XCTAssertEqual(startParts.year, 2030)
        XCTAssertEqual(startParts.month, 2)
        XCTAssertEqual(startParts.day, 4)
        XCTAssertEqual(startParts.hour, 9)
        XCTAssertEqual(startParts.minute, 15)
        XCTAssertEqual(endParts.hour, 10)
        XCTAssertEqual(endParts.minute, 45)
        XCTAssertEqual(end.timeIntervalSince(start), 90 * 60)
        XCTAssertEqual(timeZone.secondsFromGMT(for: start), -6 * 60 * 60)
        XCTAssertEqual(formatDate(start, preset: "utc"), "2030-02-04T15:15:00Z")
        XCTAssertEqual(formatDate(end, preset: "utc"), "2030-02-04T16:45:00Z")
    }

    func testCalendarVerificationSupportsExactIDAndScopedDisplayName() {
        XCTAssertTrue(calendarMatchesRequestedSelector("synthetic-calendar-id", storedID: "synthetic-calendar-id", storedTitle: "Synthetic"))
        XCTAssertTrue(calendarMatchesRequestedSelector("SYNTHETIC", storedID: "synthetic-calendar-id", storedTitle: "Synthetic"))
        XCTAssertFalse(calendarMatchesRequestedSelector("SYNTHETIC-CALENDAR-ID", storedID: "synthetic-calendar-id", storedTitle: "Synthetic"))
        XCTAssertFalse(calendarMatchesRequestedSelector("Other", storedID: "synthetic-calendar-id", storedTitle: "Synthetic"))
    }
}
