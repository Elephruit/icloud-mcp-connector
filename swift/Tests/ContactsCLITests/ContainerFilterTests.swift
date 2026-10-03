import Contacts
import XCTest
@testable import ContactsCLI
@testable import PIMConfig

/// All records and authorization checks in this suite are synthetic. No
/// CNContactStore method or CLI command is invoked.
final class ContainerFilterTests: XCTestCase {
    private func scopedConfig(writing: Bool = false, deleting: Bool = false) -> PIMConfiguration {
        PIMConfiguration(contacts: DomainFilterConfig(
            enabled: true,
            mode: .allowlist,
            items: ["synthetic-container"],
            accounts: ["synthetic-container"],
            allowWrites: writing,
            allowDeletes: deleting
        ))
    }

    func testDefaultScopeFailsBeforeAuthorization() {
        var checkedAuthorization = false
        XCTAssertThrowsError(try prepareContactsAccess(config: PIMConfiguration()) {
            checkedAuthorization = true
        })
        XCTAssertFalse(checkedAuthorization)
    }

    func testBroadModesFailBeforeAuthorization() {
        for mode in [FilterMode.all, .blocklist] {
            var config = scopedConfig()
            config.contacts.mode = mode
            var checkedAuthorization = false
            XCTAssertThrowsError(try prepareContactsAccess(config: config) {
                checkedAuthorization = true
            })
            XCTAssertFalse(checkedAuthorization)
        }
    }

    func testIncompleteScopeFailsBeforeAuthorization() {
        for contacts in [
            DomainFilterConfig(enabled: true, items: [], accounts: ["synthetic-container"]),
            DomainFilterConfig(enabled: true, items: ["synthetic-container"], accounts: []),
            DomainFilterConfig(enabled: true, items: [" "], accounts: [" "]),
            DomainFilterConfig(enabled: true, items: ["synthetic-container"], accounts: ["different-container"]),
        ] {
            var checkedAuthorization = false
            XCTAssertThrowsError(try prepareContactsAccess(config: PIMConfiguration(contacts: contacts)) {
                checkedAuthorization = true
            })
            XCTAssertFalse(checkedAuthorization)
        }
    }

    func testContainerMustBeInBothAllowlistsExactly() throws {
        var config = scopedConfig()
        config.contacts.items += ["item-only", "case-sensitive"]
        config.contacts.accounts += ["account-only", "CASE-SENSITIVE"]
        XCTAssertEqual(try allowedContactContainerIdentifiers(config: config), ["synthetic-container"])
    }

    func testValidScopeChecksAuthorization() throws {
        var checkedAuthorization = false
        let ids = try prepareContactsAccess(config: scopedConfig()) {
            checkedAuthorization = true
        }
        XCTAssertTrue(checkedAuthorization)
        XCTAssertEqual(ids, ["synthetic-container"])
    }

    func testAuthorizationFailureIsPropagatedBeforeDataAccess() {
        XCTAssertThrowsError(try prepareContactsAccess(config: scopedConfig()) {
            throw CLIError.accessDenied("Synthetic authorization denial")
        }) { error in
            XCTAssertEqual(error.localizedDescription, "Synthetic authorization denial")
        }
    }

    func testDeleteDefaultsDeniedBeforeAuthorization() {
        var checkedAuthorization = false
        XCTAssertThrowsError(try prepareContactsAccess(config: scopedConfig(writing: true), deleting: true) {
            checkedAuthorization = true
        })
        XCTAssertFalse(checkedAuthorization)
    }

    func testDeleteRequiresExplicitOptInAndScope() throws {
        var checkedAuthorization = false
        let ids = try prepareContactsAccess(config: scopedConfig(writing: true, deleting: true), deleting: true) {
            checkedAuthorization = true
        }
        XCTAssertTrue(checkedAuthorization)
        XCTAssertEqual(ids, ["synthetic-container"])
    }

    func testWritesDefaultDeniedBeforeAuthorization() {
        var checkedAuthorization = false
        XCTAssertThrowsError(try prepareContactsAccess(config: scopedConfig(), writing: true) {
            checkedAuthorization = true
        })
        XCTAssertFalse(checkedAuthorization)
    }

    func testWriteOptInChecksAuthorization() throws {
        var checkedAuthorization = false
        _ = try prepareContactsAccess(config: scopedConfig(writing: true), writing: true) {
            checkedAuthorization = true
        }
        XCTAssertTrue(checkedAuthorization)
    }

    func testDeleteOptInDoesNotEnableWrites() {
        var checkedAuthorization = false
        XCTAssertThrowsError(try prepareContactsAccess(config: scopedConfig(deleting: true), deleting: true) {
            checkedAuthorization = true
        })
        XCTAssertFalse(checkedAuthorization)
    }

    func testDeniedUpdateReadsNeitherMembershipNorDetails() {
        var checkedAuthorization = false
        var readMembership = false
        var readDetails = false
        XCTAssertThrowsError(try {
            let allowedIds = try prepareContactsAccess(config: scopedConfig(), writing: true) {
                checkedAuthorization = true
            }
            return try fetchScopedContact(
                id: "synthetic-test-card",
                allowedIds: allowedIds,
                fetchIdentifiers: { _ in
                    readMembership = true
                    return ["synthetic-test-card"]
                },
                fetchDetail: { _ in
                    readDetails = true
                    return nil
                }
            )
        }())
        XCTAssertFalse(checkedAuthorization)
        XCTAssertFalse(readMembership)
        XCTAssertFalse(readDetails)
    }

    func testCreateRequiresExactExplicitDestination() throws {
        let ids = Set(["synthetic-container"])
        XCTAssertThrowsError(try validateContactDestination(id: nil, allowedIds: ids))
        XCTAssertThrowsError(try validateContactDestination(id: "Synthetic Display Name", allowedIds: ids))
        XCTAssertThrowsError(try validateContactDestination(id: "SYNTHETIC-CONTAINER", allowedIds: ids))
        XCTAssertEqual(try validateContactDestination(id: "synthetic-container", allowedIds: ids), "synthetic-container")
    }

    func testListFetchesOnlyConfiguredContainers() throws {
        let first = CNMutableContact()
        first.givenName = "Synthetic First"
        let second = CNMutableContact()
        second.givenName = "Synthetic Second"
        var visited: [String] = []
        let contacts = try fetchContactsFromAllowedContainers(allowedIds: ["allowed-b", "allowed-a"]) { id in
            visited.append(id)
            return id == "allowed-a" ? [first] : [second]
        }
        XCTAssertEqual(visited, ["allowed-a", "allowed-b"])
        XCTAssertEqual(contacts.map { $0.identifier }, [first.identifier, second.identifier])
    }

    func testRawIdLookupChecksIdentifierMembershipBeforeDetails() throws {
        let contact = CNMutableContact()
        contact.givenName = "Synthetic Test Card"
        var visited: [String] = []
        let found = try fetchScopedContact(
            id: contact.identifier,
            allowedIds: ["synthetic-container"],
            fetchIdentifiers: { containerId in
                visited.append("membership:" + containerId)
                return ["another-existing-card-id", contact.identifier]
            },
            fetchDetail: { contactId in
                visited.append("detail:" + contactId)
                return contact
            }
        )
        XCTAssertEqual(visited, ["membership:synthetic-container", "detail:" + contact.identifier])
        XCTAssertEqual(found.contact.identifier, contact.identifier)
        XCTAssertEqual(found.containerId, "synthetic-container")
    }

    func testUnknownOrUnifiedIdDoesNotReadDetails() {
        var visited: [String] = []
        XCTAssertThrowsError(try fetchScopedContact(
            id: "synthetic-unified-id",
            allowedIds: ["synthetic-container"],
            fetchIdentifiers: { containerId in
                visited.append("membership:" + containerId)
                return ["synthetic-raw-card-id"]
            },
            fetchDetail: { contactId in
                visited.append("unexpected-detail:" + contactId)
                return nil
            }
        ))
        XCTAssertEqual(visited, ["membership:synthetic-container"])
    }

    func testRawIdLookupLoadsDetailsOnlyForRequestedCard() throws {
        let contact = CNMutableContact()
        var detailedIds: [String] = []
        _ = try fetchScopedContact(
            id: contact.identifier,
            allowedIds: ["allowed-a", "allowed-b"],
            fetchIdentifiers: { containerId in
                containerId == "allowed-a" ? ["other-a-card"] : ["other-b-card", contact.identifier]
            },
            fetchDetail: { contactId in
                detailedIds.append(contactId)
                return contact
            }
        )
        XCTAssertEqual(detailedIds, [contact.identifier])
    }

    func testRawIdLookupRejectsUnexpectedDetailIdentifier() {
        let different = CNMutableContact()
        XCTAssertThrowsError(try fetchScopedContact(
            id: "synthetic-requested-raw-id",
            allowedIds: ["synthetic-container"],
            fetchIdentifiers: { _ in ["synthetic-requested-raw-id"] },
            fetchDetail: { _ in different }
        ))
    }

    func testRawIdLookupRejectsDisappearedContact() {
        XCTAssertThrowsError(try fetchScopedContact(
            id: "synthetic-raw-id",
            allowedIds: ["synthetic-container"],
            fetchIdentifiers: { _ in ["synthetic-raw-id"] },
            fetchDetail: { _ in nil }
        ))
    }

    func testEmptyAllowedContainersNeverFetch() throws {
        var fetched = false
        let contacts = try fetchContactsFromAllowedContainers(allowedIds: []) { _ in
            fetched = true
            return []
        }
        XCTAssertTrue(contacts.isEmpty)
        XCTAssertFalse(fetched)
    }

    func testSearchMatchesSyntheticNameEmailAndPhone() {
        let contact = CNMutableContact()
        contact.givenName = "Synthetic"
        contact.familyName = "Person"
        contact.emailAddresses = [CNLabeledValue(label: CNLabelHome, value: "person@example.com" as NSString)]
        contact.phoneNumbers = [CNLabeledValue(label: CNLabelHome, value: CNPhoneNumber(stringValue: "+1 202 555 0100"))]
        XCTAssertTrue(contactMatchesQuery(contact, query: "SYNTHETIC"))
        XCTAssertTrue(contactMatchesQuery(contact, query: "person@example.com"))
        XCTAssertTrue(contactMatchesQuery(contact, query: "555-0100"))
        XCTAssertFalse(contactMatchesQuery(contact, query: "missing"))
    }

    func testEmptyPhoneDoesNotMatchDigitQuery() {
        let contact = CNMutableContact()
        contact.phoneNumbers = [CNLabeledValue(label: CNLabelHome, value: CNPhoneNumber(stringValue: ""))]
        XCTAssertFalse(contactMatchesQuery(contact, query: "5550100"))
    }
}
