import XCTest
import PIMConfig
@testable import CalendarCLI

/// Synthetic identities only: these tests never query EventKit or request authorization.
final class ScopedAccessTests: XCTestCase {
    struct Item: Equatable {
        let id: String
        let name: String
        let accountID: String
    }

    let family = Item(id: "item-family", name: "Family", accountID: "source-icloud")
    let other = Item(id: "item-other", name: "Other", accountID: "source-other")
    var scope: DomainFilterConfig {
        DomainFilterConfig(enabled: true, items: ["item-family"], accounts: ["source-icloud"])
    }

    func select(_ selector: String, items: [Item], config: DomainFilterConfig? = nil) throws -> Item {
        try selectAllowedCalendar(
            nameOrId: selector, items: items, config: config ?? scope,
            name: { $0.name }, id: { $0.id }, accountID: { $0.accountID }
        )
    }

    func testScopeDeniedUntilItemsAndAccountsExplicitlyEnabled() {
        XCTAssertThrowsError(try requireCalendarScope(DomainFilterConfig()))
        XCTAssertThrowsError(try requireCalendarScope(DomainFilterConfig(enabled: true, items: [family.id])))
        XCTAssertThrowsError(try requireCalendarScope(DomainFilterConfig(enabled: true, accounts: [family.accountID])))
        XCTAssertThrowsError(try requireCalendarScope(DomainFilterConfig(enabled: true, mode: .all, items: [family.id], accounts: [family.accountID])))
        XCTAssertNoThrow(try requireCalendarScope(scope))
    }

    func testDeletionRequiresExplicitOptInEvenInsideScope() {
        XCTAssertThrowsError(try requireCalendarScope(scope, deletion: true))
        var optedIn = scope
        optedIn.allowDeletes = true
        XCTAssertNoThrow(try requireCalendarScope(optedIn, deletion: true))
        optedIn.enabled = false
        XCTAssertThrowsError(try requireCalendarScope(optedIn, deletion: true))
    }

    func testWritesRequireSeparateExplicitOptInAndDeletionStillNeedsItsOwnGate() {
        XCTAssertNoThrow(try requireCalendarScope(scope))
        XCTAssertThrowsError(try requireCalendarScope(scope, writing: true))
        var optedIn = scope
        optedIn.allowWrites = true
        XCTAssertNoThrow(try requireCalendarScope(optedIn, writing: true))
        XCTAssertThrowsError(try requireCalendarScope(optedIn, deletion: true, writing: true))
        optedIn.allowDeletes = true
        XCTAssertNoThrow(try requireCalendarScope(optedIn, deletion: true, writing: true))
        optedIn.allowWrites = false
        XCTAssertThrowsError(try requireCalendarScope(optedIn, deletion: true, writing: true))
        optedIn.enabled = false
        XCTAssertThrowsError(try requireCalendarScope(optedIn, writing: true))
    }

    func testStableIdentityAndSourceMustBothMatch() throws {
        XCTAssertEqual(try select(family.id, items: [other, family]), family)
        XCTAssertThrowsError(try select(other.id, items: [other, family]))
        let wrongSource = Item(id: family.id, name: family.name, accountID: other.accountID)
        XCTAssertThrowsError(try select(family.id, items: [wrongSource]))
        XCTAssertThrowsError(try select(family.id.uppercased(), items: [family]))
    }

    func testDisplayNameOnlyResolvesWithinAllowedScope() throws {
        let outside = Item(id: other.id, name: family.name, accountID: other.accountID)
        XCTAssertEqual(try select("family", items: [outside, family]), family)
        XCTAssertThrowsError(try select(other.name, items: [other, family]))
    }

    func testAmbiguousScopedNamesFailAndExactIDResolves() throws {
        let duplicate = Item(id: "item-family-two", name: "Family", accountID: family.accountID)
        var expanded = scope
        expanded.items.append(duplicate.id)
        XCTAssertThrowsError(try select("Family", items: [family, duplicate], config: expanded))
        XCTAssertEqual(try select(duplicate.id, items: [family, duplicate], config: expanded), duplicate)
    }

    func testCreationRequiresExplicitTargetOrAllowedDefaultID() throws {
        XCTAssertThrowsError(try targetCalendarSelector(explicit: nil, defaultID: nil, config: scope))
        XCTAssertThrowsError(try targetCalendarSelector(explicit: nil, defaultID: family.name, config: scope))
        XCTAssertThrowsError(try targetCalendarSelector(explicit: nil, defaultID: other.id, config: scope))
        XCTAssertEqual(try targetCalendarSelector(explicit: nil, defaultID: family.id, config: scope), family.id)
        XCTAssertEqual(try targetCalendarSelector(explicit: "Family", defaultID: nil, config: scope), "Family")
    }

    func testConfiguredDefaultIDCannotFallBackToAnItemWithThatName() {
        let collision = Item(id: "item-collision", name: family.id, accountID: family.accountID)
        var expanded = scope
        expanded.items.append(collision.id)
        XCTAssertThrowsError(try selectAllowedCalendar(
            nameOrId: family.id, exactIDOnly: true, items: [collision], config: expanded,
            name: { $0.name }, id: { $0.id }, accountID: { $0.accountID }
        ))
    }

    func testScopedIDLookupRejectsMissingAndAmbiguousRecords() throws {
        XCTAssertEqual(try selectScopedEvent(id: family.id, items: [family], identifier: { $0.id }), family)
        XCTAssertThrowsError(try selectScopedEvent(id: other.id, items: [family], identifier: { $0.id }))
        XCTAssertThrowsError(try selectScopedEvent(id: family.id, items: [family, family], identifier: { $0.id }))
    }

    func testCalendarIDLookupDefaultsToBoundedWindow() throws {
        let now = Date(timeIntervalSince1970: 1_760_000_000)
        let window = try eventLookupWindow(from: nil, to: nil, now: now)
        XCTAssertEqual(Calendar.current.dateComponents([.day], from: window.start, to: now).day, 366)
        XCTAssertEqual(Calendar.current.dateComponents([.day], from: now, to: window.end).day, 366)
    }

    func testCalendarIDLookupRejectsUnboundedInvalidAndReversedWindows() {
        XCTAssertThrowsError(try eventLookupWindow(from: "2020-01-01", to: "2026-01-01"))
        XCTAssertThrowsError(try eventLookupWindow(from: "2026-01-02", to: "2026-01-01"))
        XCTAssertThrowsError(try eventLookupWindow(from: "invalid", to: "2026-01-01"))
    }

    func testCalendarIDLookupAcceptsSingleDateOccurrenceWindow() throws {
        let window = try eventLookupWindow(from: "2026-01-01", to: "2026-01-01")
        XCTAssertGreaterThan(window.end, window.start)
        XCTAssertLessThanOrEqual(window.end.timeIntervalSince(window.start), 24 * 60 * 60)
    }

}
