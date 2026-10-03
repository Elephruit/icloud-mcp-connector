import Testing
@testable import PIMConfig

@Suite("ItemFilter exact scopes")
struct ItemFilterTests {
    private var scope: DomainFilterConfig {
        DomainFilterConfig(enabled: true, items: ["calendar-A"], accounts: ["account-A"])
    }

    @Test("An exact stable resource and account pair is allowed")
    func exactIdentifiers() {
        #expect(scope.hasExplicitScope)
        #expect(ItemFilter.isAllowed(name: "Family", id: "calendar-A", accountID: "account-A", config: scope))
        #expect(ItemFilter.isAllowed(name: "Renamed display label", id: "calendar-A", accountID: "account-A", config: scope))
    }

    @Test("Display names, emoji, and case folding cannot authorize")
    func displayNamesAreNotAuthority() {
        #expect(!ItemFilter.isAllowed(name: "calendar-A", id: "other", accountID: "account-A", config: scope))
        #expect(!ItemFilter.isAllowed(name: "✈️ calendar-A", id: "other", accountID: "account-A", config: scope))
        #expect(!ItemFilter.isAllowed(name: "Family", id: "CALENDAR-A", accountID: "account-A", config: scope))
        #expect(!ItemFilter.isAllowed(name: "Family", id: "calendar-A", accountID: "ACCOUNT-A", config: scope))
    }

    @Test("Resource scope never crosses an account boundary")
    func accountBoundary() {
        #expect(!ItemFilter.isAllowed(name: "Family", id: "calendar-A", accountID: "account-B", config: scope))
        #expect(!ItemFilter.isAllowed(name: "Family", id: "calendar-B", accountID: "account-A", config: scope))
        #expect(!ItemFilter.isAllowed(name: "Family", id: "calendar-A", config: scope))
        #expect(!ItemFilter.isAllowed(name: "Family", accountID: "account-A", config: scope))
        #expect(!ItemFilter.isAllowed(name: "Family", config: scope))
    }

    @Test("Defaults and disabled domains deny even with exact identifiers")
    func disabledDomains() {
        #expect(!DomainFilterConfig().hasExplicitScope)
        #expect(!ItemFilter.isAllowed(name: "Family", id: "calendar-A", accountID: "account-A", config: DomainFilterConfig()))
        var disabled = scope
        disabled.enabled = false
        #expect(!disabled.hasExplicitScope)
        #expect(!ItemFilter.isAllowed(name: "Family", id: "calendar-A", accountID: "account-A", config: disabled))
    }

    @Test("Legacy all and blocklist modes deny access")
    func broadModesFailClosed() {
        for mode in [FilterMode.all, .blocklist] {
            let config = DomainFilterConfig(enabled: true, mode: mode, items: ["calendar-A"], accounts: ["account-A"])
            #expect(!config.hasExplicitScope)
            #expect(!ItemFilter.isAllowed(name: "Family", id: "calendar-A", accountID: "account-A", config: config))
        }
    }

    @Test("Incomplete and empty-identifier scopes deny access")
    func incompleteScopesFailClosed() {
        let configurations = [
            DomainFilterConfig(enabled: true, items: [], accounts: ["account-A"]),
            DomainFilterConfig(enabled: true, items: ["calendar-A"], accounts: []),
            DomainFilterConfig(enabled: true, items: ["calendar-A", ""], accounts: ["account-A"]),
            DomainFilterConfig(enabled: true, items: ["calendar-A"], accounts: ["account-A", " \n"]),
        ]
        for config in configurations {
            #expect(!config.hasExplicitScope)
            #expect(!ItemFilter.isAllowed(name: "Family", id: "calendar-A", accountID: "account-A", config: config))
        }
    }

    @Test("Array filtering uses exact identifiers and account scope")
    func filterArray() {
        struct Item {
            let name: String
            let id: String
            let account: String
        }
        let items = [
            Item(name: "Family", id: "calendar-A", account: "account-A"),
            Item(name: "Family", id: "calendar-B", account: "account-A"),
            Item(name: "Family", id: "calendar-A", account: "account-B"),
        ]
        let filtered = ItemFilter.filter(
            items: items, config: scope, name: { $0.name }, id: { $0.id }, accountID: { $0.account }
        )
        #expect(filtered.count == 1)
        #expect(filtered.first?.id == "calendar-A")
        #expect(filtered.first?.account == "account-A")
        #expect(ItemFilter.filter(items: items, config: scope, name: { $0.name }, id: { $0.id }).isEmpty)
        #expect(ItemFilter.filter(items: items, config: scope, name: { $0.name }).isEmpty)
        #expect(ItemFilter.filter(items: items, config: DomainFilterConfig(enabled: true, mode: .all), name: { $0.name }).isEmpty)
    }

    @Test("Deletes require a separate explicit flag")
    func deletionDefaults() {
        #expect(!scope.allowDeletes)
        var optedIn = scope
        optedIn.allowDeletes = true
        #expect(optedIn.hasExplicitScope)
        #expect(optedIn.allowDeletes)
        #expect(!DomainConfig().allowDeletes)
    }
}
