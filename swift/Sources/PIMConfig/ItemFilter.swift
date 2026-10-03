import Foundation

/// Authorizes exact stable resource and account identifiers.
/// Display names are for presentation only; fuzzy or case-folded name matching
/// must never authorize access to a calendar, reminder list, or contact container.
public struct ItemFilter {

    public static func isAllowed(
        name: String,
        id: String? = nil,
        accountID: String? = nil,
        config: DomainFilterConfig
    ) -> Bool {
        guard config.hasExplicitScope, let id, let accountID else { return false }
        return config.items.contains(id) && config.accounts.contains(accountID)
    }

    /// An omitted identifier extractor fails closed, preserving source
    /// compatibility without preserving the legacy broad access behavior.
    public static func filter<T>(
        items: [T],
        config: DomainFilterConfig,
        name: (T) -> String,
        id: ((T) -> String?)? = nil,
        accountID: ((T) -> String?)? = nil
    ) -> [T] {
        guard config.hasExplicitScope else { return [] }
        return items.filter { item in
            isAllowed(name: name(item), id: id?(item), accountID: accountID?(item), config: config)
        }
    }
}
