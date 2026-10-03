import Foundation

/// Root configuration for the Apple PIM plugin.
/// Loaded from `~/.config/apple-pim/config.json`.
public struct PIMConfiguration: Codable, Equatable, Sendable {
    public var calendars: DomainFilterConfig
    public var reminders: DomainFilterConfig
    public var contacts: DomainFilterConfig
    public var mail: DomainConfig
    public var defaultCalendar: String?
    public var defaultReminderList: String?
    public var smtp: SMTPDefaults?
    public var imap: IMAPDefaults?

    public init(
        calendars: DomainFilterConfig = DomainFilterConfig(),
        reminders: DomainFilterConfig = DomainFilterConfig(),
        contacts: DomainFilterConfig = DomainFilterConfig(),
        mail: DomainConfig = DomainConfig(),
        defaultCalendar: String? = nil,
        defaultReminderList: String? = nil,
        smtp: SMTPDefaults? = nil,
        imap: IMAPDefaults? = nil
    ) {
        self.calendars = calendars
        self.reminders = reminders
        self.contacts = contacts
        self.mail = mail
        self.defaultCalendar = defaultCalendar
        self.defaultReminderList = defaultReminderList
        self.smtp = smtp
        self.imap = imap
    }

    enum CodingKeys: String, CodingKey {
        case calendars, reminders, contacts, mail, smtp, imap
        case defaultCalendar = "default_calendar"
        case defaultReminderList = "default_reminder_list"
    }

    /// Omitted domains always decode to disabled, empty scopes. Legacy files
    /// cannot accidentally retain the old all-access defaults.
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        calendars = try values.decodeIfPresent(DomainFilterConfig.self, forKey: .calendars) ?? DomainFilterConfig()
        reminders = try values.decodeIfPresent(DomainFilterConfig.self, forKey: .reminders) ?? DomainFilterConfig()
        contacts = try values.decodeIfPresent(DomainFilterConfig.self, forKey: .contacts) ?? DomainFilterConfig()
        mail = try values.decodeIfPresent(DomainConfig.self, forKey: .mail) ?? DomainConfig()
        defaultCalendar = try values.decodeIfPresent(String.self, forKey: .defaultCalendar)
        defaultReminderList = try values.decodeIfPresent(String.self, forKey: .defaultReminderList)
        smtp = try values.decodeIfPresent(SMTPDefaults.self, forKey: .smtp)
        imap = try values.decodeIfPresent(IMAPDefaults.self, forKey: .imap)
    }
}

/// Non-secret SMTP connection defaults.
/// The password lives in `SecretsStore` under the key at `secretKey` (default `smtp.icloud.password`).
public struct SMTPDefaults: Codable, Equatable, Sendable {
    public var host: String?
    public var port: Int?
    public var username: String?
    public var secretKey: String?
    /// TLS transport mode: `"implicit"` (port 465, default) or `"starttls"` (port 587).
    public var tlsMode: String?

    public init(
        host: String? = nil,
        port: Int? = nil,
        username: String? = nil,
        secretKey: String? = nil,
        tlsMode: String? = nil
    ) {
        self.host = host
        self.port = port
        self.username = username
        self.secretKey = secretKey
        self.tlsMode = tlsMode
    }

    enum CodingKeys: String, CodingKey {
        case host, port, username
        case secretKey = "secret_key"
        case tlsMode = "tls_mode"
    }
}

/// Non-secret IMAP connection defaults, used to APPEND SMTP-sent messages to the
/// Sent folder (see issue #63). The password lives in `SecretsStore` under
/// `secretKey`; if omitted, callers fall back to the SMTP password (iCloud uses
/// the same app-specific password for both).
public struct IMAPDefaults: Codable, Equatable, Sendable {
    public var host: String?
    public var port: Int?
    public var username: String?
    public var secretKey: String?
    /// Mailbox to APPEND into. iCloud: `"Sent Messages"`, Gmail: `"[Gmail]/Sent Mail"`,
    /// generic: `"Sent"`.
    public var sentFolder: String?
    /// When set, overrides the host-based default for whether APPEND runs.
    public var appendSent: Bool?

    public init(
        host: String? = nil,
        port: Int? = nil,
        username: String? = nil,
        secretKey: String? = nil,
        sentFolder: String? = nil,
        appendSent: Bool? = nil
    ) {
        self.host = host
        self.port = port
        self.username = username
        self.secretKey = secretKey
        self.sentFolder = sentFolder
        self.appendSent = appendSent
    }

    enum CodingKeys: String, CodingKey {
        case host, port, username
        case secretKey = "secret_key"
        case sentFolder = "sent_folder"
        case appendSent = "append_sent"
    }
}

/// Explicit resource and account scope for calendars, reminders, and contacts.
/// `items` and `accounts` contain exact stable identifiers, never display names.
public struct DomainFilterConfig: Codable, Equatable, Sendable {
    public var enabled: Bool
    public var mode: FilterMode
    public var items: [String]
    public var accounts: [String]
    /// Every native domain mutation requires this host-owned opt-in plus scope.
    public var allowWrites: Bool
    public var allowDeletes: Bool

    public init(
        enabled: Bool = false,
        mode: FilterMode = .allowlist,
        items: [String] = [],
        accounts: [String] = [],
        allowWrites: Bool = false,
        allowDeletes: Bool = false
    ) {
        self.enabled = enabled
        self.mode = mode
        self.items = items
        self.accounts = accounts
        self.allowWrites = allowWrites
        self.allowDeletes = allowDeletes
    }

    /// Check before requesting macOS permissions or accessing domain data.
    /// Broad legacy modes and incomplete scopes deliberately fail closed.
    public var hasExplicitScope: Bool {
        enabled && mode == .allowlist &&
        !items.isEmpty && !accounts.isEmpty &&
        items.allSatisfy(Self.isNonemptyIdentifier) &&
        accounts.allSatisfy(Self.isNonemptyIdentifier)
    }

    private static func isNonemptyIdentifier(_ value: String) -> Bool {
        !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    enum CodingKeys: String, CodingKey {
        case enabled, mode, items, accounts
        case allowWrites = "allow_writes"
        case allowDeletes = "allow_deletes"
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try values.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
        mode = try values.decodeIfPresent(FilterMode.self, forKey: .mode) ?? .allowlist
        items = try values.decodeIfPresent([String].self, forKey: .items) ?? []
        accounts = try values.decodeIfPresent([String].self, forKey: .accounts) ?? []
        allowWrites = try values.decodeIfPresent(Bool.self, forKey: .allowWrites) ?? false
        allowDeletes = try values.decodeIfPresent(Bool.self, forKey: .allowDeletes) ?? false
    }
}

/// Mail remains disabled by default and outside the scoped connector prototype.
public struct DomainConfig: Codable, Equatable, Sendable {
    public var enabled: Bool
    public var allowDeletes: Bool

    public init(enabled: Bool = false, allowDeletes: Bool = false) {
        self.enabled = enabled
        self.allowDeletes = allowDeletes
    }

    enum CodingKeys: String, CodingKey {
        case enabled
        case allowDeletes = "allow_deletes"
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try values.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
        allowDeletes = try values.decodeIfPresent(Bool.self, forKey: .allowDeletes) ?? false
    }
}

/// Filter mode for a domain's item list.
public enum FilterMode: String, Codable, Equatable, Sendable {
    case all
    case allowlist
    case blocklist
}
