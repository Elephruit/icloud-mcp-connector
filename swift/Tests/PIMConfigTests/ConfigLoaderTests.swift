import Foundation
import Testing
@testable import PIMConfig

/// Process environment variables are shared across every concurrently running
/// Swift Testing suite in this test process. `.serialized` only orders tests
/// within a single suite, so environment-mutating suites must also share this
/// lock with one another.
enum ProcessEnvironmentTestLock {
    static let lock = NSLock()
}

@Suite("ConfigLoader")
struct ConfigLoaderTests {

    // MARK: - Base config loading

    @Test("Default config when no file exists")
    func testDefaultConfigWhenNoFile() {
        // No disk reads are needed to verify the disabled default structure.
        let config = PIMConfiguration()
        #expect(config.calendars.enabled == false)
        #expect(config.calendars.mode == .allowlist)
        #expect(config.calendars.items.isEmpty)
        #expect(config.calendars.accounts.isEmpty)
        #expect(config.calendars.allowWrites == false)
        #expect(config.calendars.allowDeletes == false)
        #expect(config.reminders.enabled == false)
        #expect(config.reminders.mode == .allowlist)
        #expect(config.contacts.enabled == false)
        #expect(config.mail.enabled == false)
        #expect(config.mail.allowDeletes == false)
        #expect(config.defaultCalendar == nil)
        #expect(config.defaultReminderList == nil)
    }

    // MARK: - JSON round-trip

    @Test("Config encodes and decodes correctly")
    func testConfigRoundTrip() throws {
        let config = PIMConfiguration(
            calendars: DomainFilterConfig(enabled: true, mode: .allowlist, items: ["calendar-A", "calendar-B"], accounts: ["account-A"], allowWrites: true, allowDeletes: true),
            reminders: DomainFilterConfig(enabled: true, mode: .blocklist, items: ["Spam"]),
            contacts: DomainFilterConfig(enabled: false),
            mail: DomainConfig(enabled: true),
            defaultCalendar: "Personal",
            defaultReminderList: "Reminders"
        )

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(config)
        let decoded = try JSONDecoder().decode(PIMConfiguration.self, from: data)

        #expect(decoded == config)
        #expect(decoded.calendars.hasExplicitScope)
        #expect(decoded.calendars.allowWrites)
        #expect(decoded.calendars.allowDeletes)
    }

    @Test("Missing and null root fields decode to disabled domains")
    func missingRootFieldsDeny() throws {
        for json in ["{}", #"{"calendars":null,"mail":null}"#] {
            let config = try JSONDecoder().decode(PIMConfiguration.self, from: Data(json.utf8))
            #expect(config == PIMConfiguration())
        }
    }

    @Test("Legacy domain sections without accounts cannot authorize")
    func legacyConfigDeny() throws {
        let data = Data(#"{"calendars":{"enabled":true,"mode":"allowlist","items":["Family"]},"reminders":{"enabled":true,"mode":"all","items":[]},"mail":{}}"#.utf8)
        let config = try JSONDecoder().decode(PIMConfiguration.self, from: data)
        #expect(!config.calendars.hasExplicitScope)
        #expect(!config.reminders.hasExplicitScope)
        #expect(!config.contacts.enabled)
        #expect(!config.mail.enabled)
        #expect(!config.calendars.allowDeletes)
    }

    @Test("Partial domain decoding uses empty disabled defaults")
    func partialDomainDefaults() throws {
        let omitted = try JSONDecoder().decode(DomainFilterConfig.self, from: Data("{}".utf8))
        #expect(omitted == DomainFilterConfig())
        let enabledOnly = try JSONDecoder().decode(DomainFilterConfig.self, from: Data(#"{"enabled":true}"#.utf8))
        #expect(enabledOnly.mode == .allowlist)
        #expect(!enabledOnly.hasExplicitScope)
        #expect(!enabledOnly.allowWrites)
        #expect(!enabledOnly.allowDeletes)
    }

    @Test("Calendar write permission uses only a literal snake_case boolean")
    func calendarWriteKey() throws {
        let config = DomainFilterConfig(enabled: true, items: ["calendar-A"], accounts: ["account-A"], allowWrites: true)
        let data = try JSONEncoder().encode(config)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        #expect(json["allow_writes"] as? Bool == true)
        #expect(json["allowWrites"] == nil)
        let decoded = try JSONDecoder().decode(DomainFilterConfig.self, from: data)
        #expect(decoded.allowWrites)
        #expect(!decoded.allowDeletes)
        for json in ["{}", #"{"allow_writes":null}"#, #"{"allow_writes":false}"#, #"{"allowWrites":true}"#] {
            let denied = try JSONDecoder().decode(DomainFilterConfig.self, from: Data(json.utf8))
            #expect(!denied.allowWrites)
        }
        for json in [#"{"allow_writes":"true"}"#, #"{"allow_writes":1}"#, #"{"allow_writes":[]}"#] {
            #expect(throws: DecodingError.self) {
                _ = try JSONDecoder().decode(DomainFilterConfig.self, from: Data(json.utf8))
            }
        }
    }

    @Test("Delete permission has an explicit snake_case key")
    func deletionKey() throws {
        let config = DomainFilterConfig(enabled: true, items: ["calendar-A"], accounts: ["account-A"], allowDeletes: true)
        let data = try JSONEncoder().encode(config)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        #expect(json["allow_deletes"] as? Bool == true)
        #expect(json["accounts"] as? [String] == ["account-A"])
        #expect(json["allowDeletes"] == nil)
        let legacyKey = try JSONDecoder().decode(DomainFilterConfig.self, from: Data(#"{"allowDeletes":true}"#.utf8))
        #expect(!legacyKey.allowDeletes)
    }

    @Test("Invalid domain types and unknown modes throw decoding errors")
    func malformedDomainThrows() {
        for json in [#"{"enabled":"true"}"#, #"{"mode":"unknown"}"#, #"{"accounts":"account-A"}"#, #"{"allow_deletes":"true"}"#] {
            #expect(throws: DecodingError.self) {
                _ = try JSONDecoder().decode(DomainFilterConfig.self, from: Data(json.utf8))
            }
        }
    }

    @Test("SMTP tls_mode and IMAP block round-trip with snake_case keys")
    func testSMTPAndIMAPRoundTrip() throws {
        let config = PIMConfiguration(
            smtp: SMTPDefaults(
                host: "smtp.example.com", port: 587,
                username: "me@example.com", secretKey: "smtp.example.password",
                tlsMode: "starttls"
            ),
            imap: IMAPDefaults(
                host: "imap.mail.me.com", port: 993,
                username: "me@example.com", secretKey: "imap.example.password",
                sentFolder: "Sent Messages", appendSent: true
            )
        )

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(config)
        let decoded = try JSONDecoder().decode(PIMConfiguration.self, from: data)
        #expect(decoded == config)

        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        let smtp = json["smtp"] as! [String: Any]
        #expect(smtp["tls_mode"] as? String == "starttls")
        #expect(smtp["secret_key"] as? String == "smtp.example.password")
        let imap = json["imap"] as! [String: Any]
        #expect(imap["sent_folder"] as? String == "Sent Messages")
        #expect(imap["append_sent"] as? Bool == true)
        #expect(imap["secret_key"] as? String == "imap.example.password")
    }

    @Test("Config uses snake_case JSON keys")
    func testSnakeCaseKeys() throws {
        let config = PIMConfiguration(
            defaultCalendar: "Work",
            defaultReminderList: "Tasks"
        )

        let data = try JSONEncoder().encode(config)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        #expect(json["default_calendar"] as? String == "Work")
        #expect(json["default_reminder_list"] as? String == "Tasks")
        // Verify camelCase keys are NOT present
        #expect(json["defaultCalendar"] == nil)
        #expect(json["defaultReminderList"] == nil)
    }

    // MARK: - Profile merging

    @Test("Profile override replaces entire domain section")
    func testProfileMergeReplacesEntireDomain() {
        let base = PIMConfiguration(
            calendars: DomainFilterConfig(enabled: true, mode: .allowlist, items: ["A", "B", "C"], accounts: ["account-base"], allowWrites: true, allowDeletes: true),
            reminders: DomainFilterConfig(enabled: true, mode: .allowlist, items: ["X", "Y"], accounts: ["account-base"]),
            defaultCalendar: "A",
            defaultReminderList: "X"
        )

        let profile = PIMProfileOverride(
            calendars: DomainFilterConfig(enabled: true, mode: .allowlist, items: ["B"], accounts: ["account-profile"]),
            defaultCalendar: "B"
        )

        let merged = ConfigLoader.merge(base: base, profile: profile)

        // Calendars fully replaced by profile
        #expect(merged.calendars.items == ["B"])
        #expect(merged.calendars.accounts == ["account-profile"])
        #expect(!merged.calendars.allowWrites)
        #expect(!merged.calendars.allowDeletes)
        #expect(merged.defaultCalendar == "B")

        // Reminders inherited from base (not in profile)
        #expect(merged.reminders.items == ["X", "Y"])
        #expect(merged.reminders.hasExplicitScope)
        #expect(merged.defaultReminderList == "X")
    }

    @Test("Nil profile returns base unchanged")
    func testNilProfileReturnsBase() {
        let base = PIMConfiguration(
            calendars: DomainFilterConfig(enabled: true, mode: .allowlist, items: ["calendar-A"], accounts: ["account-A"]),
            defaultCalendar: "Personal"
        )

        let merged = ConfigLoader.merge(base: base, profile: nil)
        #expect(merged == base)
    }

    @Test("Profile with no overrides returns base unchanged")
    func testEmptyProfileReturnsBase() {
        let base = PIMConfiguration(
            calendars: DomainFilterConfig(enabled: true, mode: .allowlist, items: ["calendar-A"], accounts: ["account-A"]),
            defaultCalendar: "Personal"
        )

        let profile = PIMProfileOverride()
        let merged = ConfigLoader.merge(base: base, profile: profile)
        #expect(merged == base)
    }

    @Test("A profile cannot inherit authority from a broad legacy base section")
    func profileCannotInheritBroadAccess() {
        for mode in [FilterMode.all, .blocklist] {
            let base = PIMConfiguration(calendars: DomainFilterConfig(enabled: true, mode: mode, items: ["calendar-A"], accounts: ["account-A"]))
            let merged = ConfigLoader.merge(base: base, profile: PIMProfileOverride())
            #expect(!merged.calendars.hasExplicitScope)
            #expect(!ItemFilter.isAllowed(name: "Family", id: "calendar-A", accountID: "account-A", config: merged.calendars))
        }
    }

    @Test("Partial profile sections replace complete base scopes without inherited accounts")
    func profilePartialScopeFailsClosed() throws {
        let base = PIMConfiguration(calendars: DomainFilterConfig(enabled: true, items: ["calendar-A"], accounts: ["account-A"], allowDeletes: true))
        let profile = try JSONDecoder().decode(PIMProfileOverride.self, from: Data(#"{"calendars":{"enabled":true,"items":["calendar-A"]}}"#.utf8))
        let merged = ConfigLoader.merge(base: base, profile: profile)
        #expect(merged.calendars.accounts.isEmpty)
        #expect(!merged.calendars.hasExplicitScope)
        #expect(!merged.calendars.allowDeletes)
    }

    @Test("Profile can disable a domain")
    func testProfileDisablesDomain() {
        let base = PIMConfiguration(
            mail: DomainConfig(enabled: true)
        )

        let profile = PIMProfileOverride(
            mail: DomainConfig(enabled: false)
        )

        let merged = ConfigLoader.merge(base: base, profile: profile)
        #expect(merged.mail.enabled == false)
    }

    // MARK: - Profile JSON round-trip

    @Test("Profile encodes and decodes correctly")
    func testProfileRoundTrip() throws {
        let profile = PIMProfileOverride(
            calendars: DomainFilterConfig(enabled: true, mode: .allowlist, items: ["Family"]),
            defaultCalendar: "Family"
        )

        let data = try JSONEncoder().encode(profile)
        let decoded = try JSONDecoder().decode(PIMProfileOverride.self, from: data)
        #expect(decoded == profile)
    }

    // MARK: - Profile name validation

    @Test("Valid profile names are accepted")
    func testValidProfileNames() throws {
        try ConfigLoader.validateProfileName("default")
        try ConfigLoader.validateProfileName("agent-1")
        try ConfigLoader.validateProfileName("my_profile")
    }

    @Test("Path traversal in profile name is rejected")
    func testPathTraversalRejected() {
        #expect(throws: ConfigError.self) {
            try ConfigLoader.validateProfileName("../../etc/passwd")
        }
        #expect(throws: ConfigError.self) {
            try ConfigLoader.validateProfileName("foo/bar")
        }
        #expect(throws: ConfigError.self) {
            try ConfigLoader.validateProfileName("foo\\bar")
        }
    }

    @Test("Hidden file profile names are rejected")
    func testHiddenFileNamesRejected() {
        #expect(throws: ConfigError.self) {
            try ConfigLoader.validateProfileName(".hidden")
        }
    }

    @Test("Control characters and unsupported profile filename characters are rejected")
    func testUnsupportedProfileNamesRejected() {
        for name in ["profile\n", "with space", "profile.json", "synthetic@profile", "é"] {
            #expect(throws: ConfigError.self) { try ConfigLoader.validateProfileName(name) }
        }
    }

    @Test("Empty profile name is rejected")
    func testEmptyProfileNameRejected() {
        #expect(throws: ConfigError.self) {
            try ConfigLoader.validateProfileName("")
        }
    }

    @Test("profilePath strips path components as defense-in-depth")
    func testProfilePathStripsPathComponents() {
        // Even without validation, profilePath uses lastPathComponent
        let path = ConfigLoader.profilePath(for: "../../evil")
        #expect(path.lastPathComponent == "evil.json")
        #expect(!path.path.contains("../../"))
    }

    @Test("Profile with only some fields omits others in JSON")
    func testProfilePartialEncoding() throws {
        let profile = PIMProfileOverride(
            calendars: DomainFilterConfig(enabled: true, mode: .allowlist, items: ["Family"])
        )

        let data = try JSONEncoder().encode(profile)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        // calendars should be present
        #expect(json["calendars"] != nil)
        // reminders should NOT be present (nil in profile)
        #expect(json["reminders"] == nil)
    }
}

// MARK: - Environment-mutating tests (serialized to avoid data races)

@Suite("ConfigLoader - env isolation", .serialized)
struct ConfigLoaderEnvTests {
    /// Every loader test uses synthetic files, independent of private user config.
    private func withConfigDirectory(_ body: (URL) throws -> Void) throws {
        ProcessEnvironmentTestLock.lock.lock()
        defer { ProcessEnvironmentTestLock.lock.unlock() }
        let previousConfig = ProcessInfo.processInfo.environment["APPLE_PIM_CONFIG_DIR"]
        let previousProfile = ProcessInfo.processInfo.environment["APPLE_PIM_PROFILE"]
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("pim-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmpDir) }
        setenv("APPLE_PIM_CONFIG_DIR", tmpDir.path, 1)
        unsetenv("APPLE_PIM_PROFILE")
        defer {
            if let previousConfig { setenv("APPLE_PIM_CONFIG_DIR", previousConfig, 1) }
            else { unsetenv("APPLE_PIM_CONFIG_DIR") }
            if let previousProfile { setenv("APPLE_PIM_PROFILE", previousProfile, 1) }
            else { unsetenv("APPLE_PIM_PROFILE") }
        }
        try body(tmpDir)
    }

    @Test("APPLE_PIM_CONFIG_DIR overrides default config directory")
    func testConfigDirEnvOverride() throws {
        try withConfigDirectory { tmpDir in
            let config = PIMConfiguration(calendars: DomainFilterConfig(enabled: true, items: ["calendar-A"], accounts: ["account-A"]))
            try JSONEncoder().encode(config).write(to: tmpDir.appendingPathComponent("config.json"))
            #expect(ConfigLoader.configDir.path == tmpDir.path)
            #expect(ConfigLoader.defaultConfigPath.path == tmpDir.appendingPathComponent("config.json").path)
            #expect(ConfigLoader.profilesDir.path == tmpDir.appendingPathComponent("profiles").path)
            #expect(ConfigLoader.loadBaseConfig() == config)
        }
    }

    @Test("Missing base configuration denies every domain")
    func missingBaseFailsClosed() throws {
        try withConfigDirectory { _ in
            #expect(ConfigLoader.loadBaseConfig() == PIMConfiguration())
            let loaded = try ConfigLoader.loadValidated()
            #expect(loaded == PIMConfiguration())
        }
    }

    @Test("Malformed base configuration denies every domain")
    func malformedBaseFailsClosed() throws {
        try withConfigDirectory { tmpDir in
            for json in ["not json", #"{"calendars":{"enabled":"true"}}"#] {
                try Data(json.utf8).write(to: tmpDir.appendingPathComponent("config.json"))
                #expect(ConfigLoader.loadBaseConfig() == PIMConfiguration())
                #expect(throws: ConfigError.self) { _ = try ConfigLoader.loadValidated() }
            }
        }
    }

    @Test("Valid profile cannot grant access when the base is missing or malformed")
    func profileCannotRepairInvalidBase() throws {
        try withConfigDirectory { tmpDir in
            let profiles = tmpDir.appendingPathComponent("profiles")
            try FileManager.default.createDirectory(at: profiles, withIntermediateDirectories: true)
            let profile = PIMProfileOverride(calendars: DomainFilterConfig(enabled: true, items: ["calendar-A"], accounts: ["account-A"]))
            try JSONEncoder().encode(profile).write(to: profiles.appendingPathComponent("synthetic.json"))
            #expect(throws: ConfigError.self) { _ = try ConfigLoader.loadValidated(profile: "synthetic") }
            try Data("not json".utf8).write(to: tmpDir.appendingPathComponent("config.json"))
            #expect(throws: ConfigError.self) { _ = try ConfigLoader.loadValidated(profile: "synthetic") }
        }
    }

    @Test("Explicit missing profile throws instead of inheriting base")
    func missingProfileFailsClosed() throws {
        try withConfigDirectory { tmpDir in
            let config = PIMConfiguration(calendars: DomainFilterConfig(enabled: true, items: ["calendar-A"], accounts: ["account-A"]))
            try JSONEncoder().encode(config).write(to: tmpDir.appendingPathComponent("config.json"))
            #expect(ConfigLoader.loadProfile(named: "nonexistent") == nil)
            #expect(throws: ConfigError.self) { _ = try ConfigLoader.loadValidated(profile: "nonexistent") }
            #expect(throws: ConfigError.self) { _ = try ConfigLoader.loadValidated(profile: "") }
            setenv("APPLE_PIM_PROFILE", "nonexistent", 1)
            #expect(throws: ConfigError.self) { _ = try ConfigLoader.loadValidated() }
        }
    }

    @Test("Explicit malformed profile throws instead of inheriting base")
    func malformedProfileFailsClosed() throws {
        try withConfigDirectory { tmpDir in
            let config = PIMConfiguration(calendars: DomainFilterConfig(enabled: true, items: ["calendar-A"], accounts: ["account-A"]))
            try JSONEncoder().encode(config).write(to: tmpDir.appendingPathComponent("config.json"))
            let profiles = tmpDir.appendingPathComponent("profiles")
            try FileManager.default.createDirectory(at: profiles, withIntermediateDirectories: true)
            try Data(#"{"calendars":{"enabled":"true"}}"#.utf8).write(to: profiles.appendingPathComponent("bad.json"))
            #expect(ConfigLoader.loadProfile(named: "bad") == nil)
            #expect(throws: ConfigError.self) { _ = try ConfigLoader.loadValidated(profile: "bad") }
        }
    }

    @Test("Explicit flag selects a complete replacement scope before environment profile")
    func explicitProfileOverridesEnvironment() throws {
        try withConfigDirectory { tmpDir in
            let base = PIMConfiguration(calendars: DomainFilterConfig(enabled: true, items: ["calendar-base"], accounts: ["account-base"], allowDeletes: true))
            try JSONEncoder().encode(base).write(to: tmpDir.appendingPathComponent("config.json"))
            let profiles = tmpDir.appendingPathComponent("profiles")
            try FileManager.default.createDirectory(at: profiles, withIntermediateDirectories: true)
            let profile = PIMProfileOverride(calendars: DomainFilterConfig(enabled: true, items: ["calendar-profile"], accounts: ["account-profile"]))
            try JSONEncoder().encode(profile).write(to: profiles.appendingPathComponent("synthetic.json"))
            setenv("APPLE_PIM_PROFILE", "missing-env-profile", 1)
            let loaded = try ConfigLoader.loadValidated(profile: "synthetic")
            #expect(loaded.calendars.items == ["calendar-profile"])
            #expect(loaded.calendars.accounts == ["account-profile"])
            #expect(!loaded.calendars.allowDeletes)
            #expect(loaded.calendars.hasExplicitScope)
        }
    }
}
