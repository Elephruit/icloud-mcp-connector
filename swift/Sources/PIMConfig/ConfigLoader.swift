import Foundation

/// Errors from loading or validating PIM configuration.
public enum ConfigError: Error, CustomStringConvertible {
    case invalidProfileName(String, reason: String)
    case malformedConfig(path: String, underlying: Error)
    case profileNotFound(name: String, path: String)
    case baseConfigNotFound(path: String)

    public var description: String {
        switch self {
        case .invalidProfileName(let name, let reason):
            return "Invalid profile name '\(name)': \(reason)"
        case .malformedConfig(let path, let underlying):
            return "Malformed config at \(path): \(underlying.localizedDescription)"
        case .profileNotFound(let name, let path):
            return "Profile '\(name)' not found at \(path)"
        case .baseConfigNotFound(let path):
            return "Base config not found at \(path); a profile cannot grant access without a valid base config"
        }
    }
}

/// Loads PIM configuration from disk with optional profile override.
///
/// Resolution order for profile selection:
/// 1. Explicit `profile` parameter (from `--profile` CLI flag)
/// 2. `APPLE_PIM_PROFILE` environment variable
/// 3. No profile — base config only
///
/// File locations (default, overridable via `APPLE_PIM_CONFIG_DIR`):
/// - Base config: `~/.config/apple-pim/config.json`
/// - Profiles: `~/.config/apple-pim/profiles/{name}.json`
public struct ConfigLoader {

    /// Root directory for all PIM config files.
    /// Override with the `APPLE_PIM_CONFIG_DIR` environment variable.
    public static var configDir: URL {
        if let dir = ProcessInfo.processInfo.environment["APPLE_PIM_CONFIG_DIR"], !dir.isEmpty {
            return URL(fileURLWithPath: dir)
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config/apple-pim")
    }

    /// Path to the default (base) configuration file.
    public static var defaultConfigPath: URL {
        configDir.appendingPathComponent("config.json")
    }

    /// Directory containing named profiles.
    public static var profilesDir: URL {
        configDir.appendingPathComponent("profiles")
    }

    /// Load the resolved configuration.
    ///
    /// - Parameter profile: Optional profile name. If nil, checks `APPLE_PIM_PROFILE` env var.
    /// - Returns: The merged configuration (base + profile override).
    public static func load(profile: String? = nil) -> PIMConfiguration {
        do {
            return try loadValidated(profile: profile)
        } catch {
            FileHandle.standardError.write(
                Data("[apple-pim] Error: \(error). Refusing to fall back to base config.\n".utf8)
            )
            Foundation.exit(1)
        }
    }

    /// Throwing seam for validating explicit profiles without terminating a
    /// caller. The CLI entry point above exits on every profile failure.
    public static func loadValidated(profile: String? = nil) throws -> PIMConfiguration {
        let base: PIMConfiguration? = try readJSON(from: defaultConfigPath)
        let profileName = profile ?? ProcessInfo.processInfo.environment["APPLE_PIM_PROFILE"]
        guard let profileName else { return base ?? PIMConfiguration() }

        try validateProfileName(profileName)
        let path = profilePath(for: profileName)
        guard let override: PIMProfileOverride = try readJSON(from: path) else {
            throw ConfigError.profileNotFound(name: profileName, path: path.path)
        }
        guard let base else { throw ConfigError.baseConfigNotFound(path: defaultConfigPath.path) }
        return merge(base: base, profile: override)
    }

    /// Missing or malformed base configuration returns disabled, empty scopes.
    public static func loadBaseConfig() -> PIMConfiguration {
        do {
            return try readJSON(from: defaultConfigPath) ?? PIMConfiguration()
        } catch {
            FileHandle.standardError.write(
                Data("[apple-pim] Warning: \(error). Denying access with disabled defaults.\n".utf8)
            )
            return PIMConfiguration()
        }
    }

    /// Load a named profile override. Returns nil if file is missing or invalid.
    public static func loadProfile(named name: String) -> PIMProfileOverride? {
        do {
            try validateProfileName(name)
            return try readJSON(from: profilePath(for: name))
        } catch {
            FileHandle.standardError.write(Data("[apple-pim] Warning: \(error). Profile was not loaded.\n".utf8))
            return nil
        }
    }

    /// Validate that a profile name is safe for use as a filename.
    /// Rejects names containing path separators or traversal sequences.
    public static func validateProfileName(_ name: String) throws {
        guard !name.isEmpty else {
            throw ConfigError.invalidProfileName(name, reason: "name cannot be empty")
        }
        guard !name.contains("/"), !name.contains("\\"), !name.contains("..") else {
            throw ConfigError.invalidProfileName(name, reason: "name cannot contain '/', '\\', or '..'")
        }
        // Reject hidden files and other problematic names
        guard !name.hasPrefix(".") else {
            throw ConfigError.invalidProfileName(name, reason: "name cannot start with '.'")
        }
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")
        guard name.unicodeScalars.allSatisfy({ allowed.contains($0) }) else {
            throw ConfigError.invalidProfileName(name, reason: "name must contain only ASCII letters, digits, '_' or '-'")
        }
    }

    /// Path for a named profile. Validates the name to prevent path traversal.
    public static func profilePath(for name: String) -> URL {
        // Use lastPathComponent to strip any accidental path separators as a defense-in-depth
        let safeName = (name as NSString).lastPathComponent
        return profilesDir.appendingPathComponent("\(safeName).json")
    }

    /// Merge a base config with an optional profile override.
    /// Non-nil profile fields replace the corresponding base fields entirely.
    public static func merge(base: PIMConfiguration, profile: PIMProfileOverride?) -> PIMConfiguration {
        guard let profile else { return base }

        var merged = base
        if let calendars = profile.calendars { merged.calendars = calendars }
        if let reminders = profile.reminders { merged.reminders = reminders }
        if let contacts = profile.contacts { merged.contacts = contacts }
        if let mail = profile.mail { merged.mail = mail }
        if let defaultCalendar = profile.defaultCalendar { merged.defaultCalendar = defaultCalendar }
        if let defaultReminderList = profile.defaultReminderList { merged.defaultReminderList = defaultReminderList }
        if let smtp = profile.smtp { merged.smtp = smtp }
        return merged
    }

    // MARK: - Private

    private static func readJSON<T: Decodable>(from url: URL) throws -> T? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }

        do {
            let data = try Data(contentsOf: url)
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw ConfigError.malformedConfig(path: url.path, underlying: error)
        }
    }
}
