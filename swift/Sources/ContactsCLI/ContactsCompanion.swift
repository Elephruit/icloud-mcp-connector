import ArgumentParser
import CoreFoundation
import CryptoKit
import Darwin
import Dispatch
import Foundation
import PIMConfig

// The companion is this native executable staged inside one recognized app.
// No child Contacts process, shell, listener, installer or implicit grant.
let contactsCompanionBundleID = "com.elephruit.icloud-mcp-connector.contacts"

enum ContactsCompanionError: String, Error {
    case invalidInvocation = "COMPANION_INVALID_INVOCATION"
    case unsafePath = "COMPANION_UNSAFE_PATH"
    case invalidSettings = "COMPANION_INVALID_SETTINGS"
    case wrongExecutable = "COMPANION_EXECUTABLE_MISMATCH"
    case invalidConfiguration = "COMPANION_INVALID_CONFIGURATION"
    case invalidRequest = "COMPANION_INVALID_REQUEST"
    case alreadyClaimed = "COMPANION_ALREADY_CLAIMED"
    case scopeDenied = "COMPANION_SCOPE_DENIED"
    case authorizationRequired = "COMPANION_AUTHORIZATION_REQUIRED"
    case busy = "COMPANION_BUSY"
    case operationFailed = "COMPANION_OPERATION_FAILED"
    case invalidResult = "COMPANION_INVALID_RESULT"
    case jobIO = "COMPANION_JOB_IO"
    case authorizationFailed = "COMPANION_AUTHORIZATION_FAILED"
}

struct ContactsCompanionPaths {
    let home: URL
    var root: URL {
        home.appendingPathComponent("Library/Application Support/iCloud MCP Connector/Contacts", isDirectory: true)
    }
    var jobs: URL { root.appendingPathComponent("jobs", isDirectory: true) }
    var app: URL { home.appendingPathComponent("Applications/iCloud MCP Contacts.app", isDirectory: true) }
    var executable: URL { app.appendingPathComponent("Contents/MacOS/contacts-cli") }

    static func currentUser() throws -> ContactsCompanionPaths {
        // HOME and interpreter environment are not an authority for bridge roots.
        guard let account = getpwuid(geteuid()), let path = account.pointee.pw_dir else {
            throw ContactsCompanionError.unsafePath
        }
        let home = URL(fileURLWithPath: String(cString: path), isDirectory: true)
        guard home.path.hasPrefix("/") else { throw ContactsCompanionError.unsafePath }
        return ContactsCompanionPaths(home: home)
    }
}

enum ContactsProcessRole: Equatable {
    case standalone, companion, refusedApp

    static func classify(bundleID: String?, bundleURL: URL, paths: ContactsCompanionPaths) -> ContactsProcessRole {
        if bundleURL.pathExtension.lowercased() == "app" || bundleID != nil {
            guard bundleID == contactsCompanionBundleID,
                  bundleURL.standardizedFileURL == paths.app.standardizedFileURL,
                  bundleURL.resolvingSymlinksInPath() == bundleURL.standardizedFileURL else {
                return .refusedApp
            }
            return .companion
        }
        return .standalone
    }
}

enum ContactsCompanionAction: String {
    case get, create, update
    var isMutation: Bool { self != .get }
}

private func companionVersionIsOne(_ value: Any?) -> Bool {
    guard let value = value as? NSNumber,
          CFGetTypeID(value) != CFBooleanGetTypeID() else { return false }
    return value.doubleValue == 1
}

private func companionBooleanIsTrue(_ value: Any?) -> Bool {
    guard let value = value as? NSNumber,
          CFGetTypeID(value) == CFBooleanGetTypeID() else { return false }
    return value.boolValue
}

func contactsCompanionUUIDIsValid(_ value: String) -> Bool {
    UUID(uuidString: value)?.uuidString.lowercased() == value
}

struct ContactsCompanionRequest {
    let requestID: String
    let action: ContactsCompanionAction
    let parameters: [String: String]

    static func decode(_ data: Data, expectedID: String) throws -> ContactsCompanionRequest {
        guard data.count <= 64 * 1024, contactsCompanionUUIDIsValid(expectedID),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(value.keys) == ["version", "requestId", "action", "parameters"],
              companionVersionIsOne(value["version"]),
              let requestID = value["requestId"] as? String, requestID == expectedID,
              let actionName = value["action"] as? String,
              let action = ContactsCompanionAction(rawValue: actionName),
              let parameters = value["parameters"] as? [String: String] else {
            throw ContactsCompanionError.invalidRequest
        }
        let textKeys = Set(["firstName", "lastName", "nickname", "organization"])
        guard Set(parameters.keys).isSubset(of: textKeys.union(["id", "container"])) else {
            throw ContactsCompanionError.invalidRequest
        }
        for (key, text) in parameters {
            guard !text.contains("\0") else { throw ContactsCompanionError.invalidRequest }
            if key == "id" || key == "container" {
                guard !text.isEmpty, text.trimmingCharacters(in: .whitespacesAndNewlines) == text,
                      text.utf16.count <= 2048,
                      !text.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else {
                    throw ContactsCompanionError.invalidRequest
                }
            } else if text.utf8.count > 4096 {
                throw ContactsCompanionError.invalidRequest
            }
        }
        switch action {
        case .get:
            guard Set(parameters.keys) == ["id"] else { throw ContactsCompanionError.invalidRequest }
        case .create:
            guard parameters["container"] != nil, parameters["id"] == nil,
                  !(parameters["firstName"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                  !(parameters["lastName"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw ContactsCompanionError.invalidRequest
            }
        case .update:
            guard parameters["id"] != nil, parameters["container"] == nil,
                  !Set(parameters.keys).intersection(textKeys).isEmpty else {
                throw ContactsCompanionError.invalidRequest
            }
        }
        return ContactsCompanionRequest(requestID: requestID, action: action, parameters: parameters)
    }

    // Equals binds strings beginning with "--" as values, never extra options.
    var cliArguments: [String] {
        let names = ["id": "id", "container": "container", "firstName": "first-name",
                     "lastName": "last-name", "nickname": "nickname", "organization": "organization"]
        return parameters.keys.sorted().map { "--\(names[$0]!)=\(parameters[$0]!)" }
    }
}

struct ContactsCompanionSettings {
    let configurationDirectory: URL
    let executableSHA256: String

    static func decode(_ data: Data) throws -> ContactsCompanionSettings {
        guard data.count <= 64 * 1024,
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(value.keys) == ["version", "enabled", "configDirectory", "executableSHA256"],
              companionVersionIsOne(value["version"]), companionBooleanIsTrue(value["enabled"]),
              let directory = value["configDirectory"] as? String, directory.hasPrefix("/"),
              !directory.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains),
              let hash = value["executableSHA256"] as? String,
              hash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
            throw ContactsCompanionError.invalidSettings
        }
        let url = URL(fileURLWithPath: directory, isDirectory: true)
        guard url.standardizedFileURL.path == directory,
              url.resolvingSymlinksInPath().path == directory else {
            throw ContactsCompanionError.unsafePath
        }
        return ContactsCompanionSettings(configurationDirectory: url, executableSHA256: hash)
    }
}

enum ContactsCompanionFiles {
    static func directory(_ url: URL) throws {
        guard url.resolvingSymlinksInPath() == url.standardizedFileURL else {
            throw ContactsCompanionError.unsafePath
        }
        var info = stat()
        guard lstat(url.path, &info) == 0,
              (info.st_mode & mode_t(S_IFMT)) == mode_t(S_IFDIR),
              info.st_uid == geteuid(), (info.st_mode & 0o777) == 0o700 else {
            throw ContactsCompanionError.unsafePath
        }
    }

    static func read(_ url: URL, maximum: Int, privateFile: Bool = true) throws -> Data {
        guard url.resolvingSymlinksInPath() == url.standardizedFileURL else {
            throw ContactsCompanionError.unsafePath
        }
        let fd = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard fd >= 0 else { throw ContactsCompanionError.unsafePath }
        defer { Darwin.close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0,
              (info.st_mode & mode_t(S_IFMT)) == mode_t(S_IFREG),
              info.st_uid == geteuid(), info.st_nlink == 1,
              info.st_size >= 0, info.st_size <= maximum,
              privateFile ? (info.st_mode & 0o777) == 0o600 : (info.st_mode & 0o022) == 0 else {
            throw ContactsCompanionError.unsafePath
        }
        var result = Data()
        var buffer = [UInt8](repeating: 0, count: 8192)
        while true {
            let count = Darwin.read(fd, &buffer, buffer.count)
            if count == 0 { break }
            if count < 0 {
                if errno == EINTR { continue }
                throw ContactsCompanionError.jobIO
            }
            guard result.count + count <= maximum else { throw ContactsCompanionError.unsafePath }
            result.append(contentsOf: buffer.prefix(count))
        }
        guard result.count == info.st_size else { throw ContactsCompanionError.unsafePath }
        return result
    }

    static func serialized(_ value: [String: Any], maximum: Int) throws -> Data {
        guard JSONSerialization.isValidJSONObject(value) else { throw ContactsCompanionError.invalidResult }
        let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        guard data.count <= maximum else { throw ContactsCompanionError.invalidResult }
        return data
    }

    static func syncDirectory(_ url: URL) throws {
        let fd = Darwin.open(url.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard fd >= 0 else { throw ContactsCompanionError.jobIO }
        defer { Darwin.close(fd) }
        guard fsync(fd) == 0 else { throw ContactsCompanionError.jobIO }
    }

    static func exclusive(_ data: Data, at url: URL) throws {
        let fd = Darwin.open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode_t(0o600))
        guard fd >= 0 else {
            throw errno == EEXIST ? ContactsCompanionError.alreadyClaimed : ContactsCompanionError.jobIO
        }
        defer { Darwin.close(fd) }
        var written = 0
        try data.withUnsafeBytes { bytes in
            while written < bytes.count {
                let count = Darwin.write(fd, bytes.baseAddress!.advanced(by: written), bytes.count - written)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw ContactsCompanionError.jobIO }
                written += count
            }
        }
        guard fsync(fd) == 0 else { throw ContactsCompanionError.jobIO }
        try syncDirectory(url.deletingLastPathComponent())
    }

    static func atomic(_ data: Data, at url: URL, replacing: Bool = false) throws {
        let temporary = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).writing")
        try exclusive(data, at: temporary)
        if replacing && FileManager.default.fileExists(atPath: url.path) {
            _ = try read(url, maximum: 64 * 1024)
        }
        guard renameatx_np(AT_FDCWD, temporary.path, AT_FDCWD, url.path,
                          replacing ? 0 : UInt32(RENAME_EXCL)) == 0 else {
            throw ContactsCompanionError.jobIO
        }
        try syncDirectory(url.deletingLastPathComponent())
    }

    static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func mutationLock(root: URL) throws -> Int32 {
        let url = root.appendingPathComponent("mutation.lock")
        let fd = Darwin.open(url.path, O_RDWR | O_CREAT | O_NOFOLLOW | O_NONBLOCK, mode_t(0o600))
        guard fd >= 0 else { throw ContactsCompanionError.unsafePath }
        var info = stat()
        guard fstat(fd, &info) == 0, (info.st_mode & mode_t(S_IFMT)) == mode_t(S_IFREG),
              info.st_uid == geteuid(), info.st_nlink == 1, (info.st_mode & 0o777) == 0o600 else {
            Darwin.close(fd)
            throw ContactsCompanionError.unsafePath
        }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            Darwin.close(fd)
            throw ContactsCompanionError.busy
        }
        return fd
    }
}

enum ContactsCompanionOperations {
    static func execute(_ request: ContactsCompanionRequest, config: PIMConfiguration) throws -> [String: Any] {
        switch request.action {
        case .get: return try GetContact.parse(request.cliArguments).result(config: config)
        case .create: return try CreateContact.parse(request.cliArguments).result(config: config)
        case .update: return try UpdateContact.parse(request.cliArguments).result(config: config)
        }
    }
}

struct ContactsCompanionEngine {
    let paths: ContactsCompanionPaths
    var authorizationCheck: () throws -> Void = requireContactsAccess
    var executor: (ContactsCompanionRequest, PIMConfiguration) throws -> [String: Any] = ContactsCompanionOperations.execute

    func configuration() throws -> PIMConfiguration {
        try ContactsCompanionFiles.directory(paths.root)
        let settings = try ContactsCompanionSettings.decode(
            ContactsCompanionFiles.read(paths.root.appendingPathComponent("bridge.json"), maximum: 64 * 1024)
        )
        let executable = try ContactsCompanionFiles.read(paths.executable, maximum: 128 * 1024 * 1024, privateFile: false)
        guard ContactsCompanionFiles.sha256(executable) == settings.executableSHA256 else {
            throw ContactsCompanionError.wrongExecutable
        }
        try ContactsCompanionFiles.directory(settings.configurationDirectory)
        do {
            let data = try ContactsCompanionFiles.read(settings.configurationDirectory.appendingPathComponent("config.json"), maximum: 64 * 1024)
            return try JSONDecoder().decode(PIMConfiguration.self, from: data)
        } catch {
            throw ContactsCompanionError.invalidConfiguration
        }
    }

    func runJob(_ id: String) throws {
        guard contactsCompanionUUIDIsValid(id) else { throw ContactsCompanionError.invalidInvocation }
        try ContactsCompanionFiles.directory(paths.root)
        try ContactsCompanionFiles.directory(paths.jobs)
        let job = paths.jobs.appendingPathComponent(id, isDirectory: true)
        try ContactsCompanionFiles.directory(job)
        let request = try ContactsCompanionRequest.decode(
            ContactsCompanionFiles.read(job.appendingPathComponent("request.json"), maximum: 64 * 1024), expectedID: id
        )
        let correlation: [String: Any] = ["version": 1, "requestId": id]
        try ContactsCompanionFiles.exclusive(
            ContactsCompanionFiles.serialized(correlation, maximum: 1024), at: job.appendingPathComponent("claim.json")
        )
        var mutationStarted = false
        var lock: Int32?
        defer { if let lock { Darwin.close(lock) } }
        let response: [String: Any]
        do {
            let config = try configuration()
            let ids: Set<String>
            do {
                ids = try allowedContactContainerIdentifiers(config: config)
                if request.action.isMutation && !config.contacts.allowWrites { throw ContactsCompanionError.scopeDenied }
                if request.action == .create {
                    _ = try validateContactDestination(id: request.parameters["container"], allowedIds: ids)
                }
            } catch { throw ContactsCompanionError.scopeDenied }
            do { try authorizationCheck() }
            catch { throw ContactsCompanionError.authorizationRequired }
            if request.action.isMutation {
                lock = try ContactsCompanionFiles.mutationLock(root: paths.root)
                let started: [String: Any] = ["version": 1, "requestId": id, "action": request.action.rawValue]
                try ContactsCompanionFiles.exclusive(
                    ContactsCompanionFiles.serialized(started, maximum: 1024),
                    at: job.appendingPathComponent("mutation-started.json")
                )
                mutationStarted = true
            }
            let result: [String: Any]
            do { result = try executor(request, config) }
            catch { throw ContactsCompanionError.operationFailed }
            guard companionBooleanIsTrue(result["success"]) else { throw ContactsCompanionError.invalidResult }
            let successful: [String: Any] = ["version": 1, "requestId": id, "action": request.action.rawValue,
                                             "success": true, "result": result]
            // Serialize inside this catch scope: even response failure after a
            // saved mutation must produce an explicit uncertain-outcome result.
            _ = try ContactsCompanionFiles.serialized(successful, maximum: 1024 * 1024)
            response = successful
        } catch {
            response = ["version": 1, "requestId": id, "action": request.action.rawValue,
                        "success": false,
                        "error": (error as? ContactsCompanionError ?? .operationFailed).rawValue,
                        "mutationMayHaveOccurred": mutationStarted]
        }
        let bytes = try ContactsCompanionFiles.serialized(response, maximum: 1024 * 1024)
        try ContactsCompanionFiles.atomic(bytes, at: job.appendingPathComponent("response.json"))
        let completed: [String: Any] = ["version": 1, "requestId": id, "action": request.action.rawValue,
                                       "responseSHA256": ContactsCompanionFiles.sha256(bytes)]
        try ContactsCompanionFiles.atomic(
            ContactsCompanionFiles.serialized(completed, maximum: 1024), at: job.appendingPathComponent("completion.json")
        )
    }

    func authorize(requestAccess: () async throws -> Void = requestContactsAccess) async throws {
        // A configuration failure must not turn an unsafe root into an output
        // destination; acknowledgement is only written inside this private root.
        try ContactsCompanionFiles.directory(paths.root)
        let response: [String: Any]
        do {
            let config = try configuration()
            do { _ = try allowedContactContainerIdentifiers(config: config) }
            catch { throw ContactsCompanionError.scopeDenied }
            // This is the only companion path that may prompt; MCP cannot
            // submit it as a job action. Runtime jobs check an existing grant.
            try await requestAccess()
            response = ["version": 1, "success": true, "authorization": "authorized"]
        } catch {
            response = ["version": 1, "success": false, "authorization": "unavailable",
                        "error": (error as? ContactsCompanionError ?? .authorizationFailed).rawValue]
        }
        try ContactsCompanionFiles.atomic(
            ContactsCompanionFiles.serialized(response, maximum: 4096),
            at: paths.root.appendingPathComponent("authorization.json"), replacing: true
        )
        if !companionBooleanIsTrue(response["success"]) {
            throw ContactsCompanionError.authorizationFailed
        }
    }
}

enum ContactsCompanionInvocation: Equatable {
    case job(String), authorize

    static func parse(_ arguments: [String]) throws -> ContactsCompanionInvocation {
        if arguments == ["--authorize"] { return .authorize }
        if arguments.count == 2, arguments[0] == "--run-job", contactsCompanionUUIDIsValid(arguments[1]) {
            return .job(arguments[1])
        }
        throw ContactsCompanionError.invalidInvocation
    }
}

enum ContactsCompanionDeadline {
    static func seconds(for invocation: ContactsCompanionInvocation) -> Int {
        switch invocation {
        case .job: return 40
        case .authorize: return 120
        }
    }

    // Runtime only. Tests check the deadline policy and inject job executors;
    // they never arm this timer or call a real authorization/store API.
    static func arm(for invocation: ContactsCompanionInvocation) -> DispatchSourceTimer {
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        timer.schedule(deadline: .now() + .seconds(seconds(for: invocation)))
        timer.setEventHandler {
            // A synchronous Contacts operation may still have saved a mutation.
            // Its fsynced journal is retained; missing completion means unknown.
            _exit(124)
        }
        timer.resume()
        return timer
    }
}

@main
struct ContactsEntryPoint {
    static func main() async {
        do {
            let paths = try ContactsCompanionPaths.currentUser()
            switch ContactsProcessRole.classify(bundleID: Bundle.main.bundleIdentifier, bundleURL: Bundle.main.bundleURL, paths: paths) {
            case .standalone:
                await ContactsCLI.main()
            case .refusedApp:
                throw ContactsCompanionError.invalidInvocation
            case .companion:
                guard Bundle.main.executableURL?.standardizedFileURL == paths.executable.standardizedFileURL,
                      Bundle.main.object(forInfoDictionaryKey: "CFBundleExecutable") as? String == "contacts-cli" else {
                    throw ContactsCompanionError.invalidInvocation
                }
                let invocation = try ContactsCompanionInvocation.parse(Array(CommandLine.arguments.dropFirst()))
                let timer = ContactsCompanionDeadline.arm(for: invocation)
                defer { timer.cancel() }
                let engine = ContactsCompanionEngine(paths: paths)
                switch invocation {
                case .job(let id): try engine.runJob(id)
                case .authorize: try await engine.authorize()
                }
            }
        } catch {
            let code = (error as? ContactsCompanionError ?? .jobIO).rawValue
            FileHandle.standardError.write(Data((code + "\n").utf8))
            exit(1)
        }
    }
}
