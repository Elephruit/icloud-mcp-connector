import XCTest
import PIMConfig
@testable import ReminderCLI

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
        try selectAllowedList(
            nameOrId: selector, items: items, config: config ?? scope,
            name: { $0.name }, id: { $0.id }, accountID: { $0.accountID }
        )
    }

    func testScopeDeniedUntilItemsAndAccountsExplicitlyEnabled() {
        XCTAssertThrowsError(try requireReminderScope(DomainFilterConfig()))
        XCTAssertThrowsError(try requireReminderScope(DomainFilterConfig(enabled: true, items: [family.id])))
        XCTAssertThrowsError(try requireReminderScope(DomainFilterConfig(enabled: true, accounts: [family.accountID])))
        XCTAssertThrowsError(try requireReminderScope(DomainFilterConfig(enabled: true, mode: .all, items: [family.id], accounts: [family.accountID])))
        XCTAssertNoThrow(try requireReminderScope(scope))
    }

    func testDeletionRequiresExplicitOptInEvenInsideScope() {
        XCTAssertThrowsError(try requireReminderScope(scope, deletion: true))
        var optedIn = scope
        optedIn.allowDeletes = true
        XCTAssertNoThrow(try requireReminderScope(optedIn, deletion: true))
        optedIn.enabled = false
        XCTAssertThrowsError(try requireReminderScope(optedIn, deletion: true))
    }

    func testWritesRequireExplicitHostOptInWhileReadsRemainAllowed() {
        XCTAssertNoThrow(try requireReminderScope(scope))
        XCTAssertThrowsError(try requireReminderScope(scope, writing: true))
        var optedIn = scope
        optedIn.allowWrites = true
        XCTAssertNoThrow(try requireReminderScope(optedIn, writing: true))
        optedIn.enabled = false
        XCTAssertThrowsError(try requireReminderScope(optedIn, writing: true))
    }

    func testDeletionRequiresBothWriteAndDeleteOptIns() {
        var optedIn = scope
        optedIn.allowDeletes = true
        XCTAssertThrowsError(try requireReminderScope(optedIn, deletion: true, writing: true))
        optedIn.allowWrites = true
        XCTAssertNoThrow(try requireReminderScope(optedIn, deletion: true, writing: true))
        optedIn.allowDeletes = false
        XCTAssertThrowsError(try requireReminderScope(optedIn, deletion: true, writing: true))
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
        XCTAssertThrowsError(try targetListSelector(explicit: nil, defaultID: nil, config: scope))
        XCTAssertThrowsError(try targetListSelector(explicit: nil, defaultID: family.name, config: scope))
        XCTAssertThrowsError(try targetListSelector(explicit: nil, defaultID: other.id, config: scope))
        XCTAssertEqual(try targetListSelector(explicit: nil, defaultID: family.id, config: scope), family.id)
        XCTAssertEqual(try targetListSelector(explicit: "Family", defaultID: nil, config: scope), "Family")
    }

    func testConfiguredDefaultIDCannotFallBackToAnItemWithThatName() {
        let collision = Item(id: "item-collision", name: family.id, accountID: family.accountID)
        var expanded = scope
        expanded.items.append(collision.id)
        XCTAssertThrowsError(try selectAllowedList(
            nameOrId: family.id, exactIDOnly: true, items: [collision], config: expanded,
            name: { $0.name }, id: { $0.id }, accountID: { $0.accountID }
        ))
    }

    func testScopedIDLookupRejectsMissingAndAmbiguousRecords() throws {
        XCTAssertEqual(try selectScopedReminder(id: family.id, items: [family], identifier: { $0.id }), family)
        XCTAssertThrowsError(try selectScopedReminder(id: other.id, items: [family], identifier: { $0.id }))
        XCTAssertThrowsError(try selectScopedReminder(id: family.id, items: [family, family], identifier: { $0.id }))
    }

}
