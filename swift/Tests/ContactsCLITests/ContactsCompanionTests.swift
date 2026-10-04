import Foundation
import PIMConfig
import XCTest
@testable import ContactsCLI

// Every file, ID, record and executor in this suite is synthetic. No app is
// launched and no Contacts authorization/store API is called.
private final class CompanionFixture {
    let paths: ContactsCompanionPaths
    let configDirectory: URL
    let executableBytes = Data("synthetic native executable fixture".utf8)

    init(config: PIMConfiguration = CompanionFixture.scopedConfig()) throws {
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("pim-companion-synthetic-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        paths = ContactsCompanionPaths(home: temporary.resolvingSymlinksInPath())
        configDirectory = paths.home.appendingPathComponent("private-config", isDirectory: true)
        for directory in [paths.root, paths.jobs, configDirectory, paths.executable.deletingLastPathComponent()] {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        }
        try put(executableBytes, at: paths.executable, permissions: 0o700)
        try put(JSONEncoder().encode(config), at: configDirectory.appendingPathComponent("config.json"))
        try settings()
    }

    static func scopedConfig(writes: Bool = true) -> PIMConfiguration {
        PIMConfiguration(contacts: DomainFilterConfig(
            enabled: true, mode: .allowlist,
            items: ["synthetic-container"], accounts: ["synthetic-container"],
            allowWrites: writes, allowDeletes: false
        ))
    }

    func put(_ data: Data, at url: URL, permissions: Int = 0o600) throws {
        guard FileManager.default.createFile(atPath: url.path, contents: data, attributes: [.posixPermissions: permissions]) else {
            throw ContactsCompanionError.jobIO
        }
    }

    func settings(hash: String? = nil, enabled: Bool = true) throws {
        let settings: [String: Any] = [
            "version": 1, "enabled": enabled, "configDirectory": configDirectory.path,
            "executableSHA256": hash ?? ContactsCompanionFiles.sha256(executableBytes),
        ]
        try put(JSONSerialization.data(withJSONObject: settings), at: paths.root.appendingPathComponent("bridge.json"))
    }

    func job(action: String = "get", parameters: [String: Any] = ["id": "synthetic-card"]) throws -> (String, URL) {
        let id = UUID().uuidString.lowercased()
        let url = paths.jobs.appendingPathComponent(id, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let request: [String: Any] = ["version": 1, "requestId": id, "action": action, "parameters": parameters]
        try put(JSONSerialization.data(withJSONObject: request), at: url.appendingPathComponent("request.json"))
        return (id, url)
    }

    func object(_ url: URL) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }

    deinit { try? FileManager.default.removeItem(at: paths.home) }
}

final class ContactsCompanionTests: XCTestCase {
    private let id = "deadbeef-dead-4bee-8bee-abcdef123456"

    private func request(_ action: String, _ parameters: [String: Any], version: Any = 1, extra: Bool = false) throws -> Data {
        var value: [String: Any] = ["version": version, "requestId": id, "action": action, "parameters": parameters]
        if extra { value["configDirectory"] = "/synthetic-untrusted-override" }
        return try JSONSerialization.data(withJSONObject: value)
    }

    func testInvocationRejectsOrdinaryCLIAndAdditionalArguments() throws {
        XCTAssertEqual(try ContactsCompanionInvocation.parse(["--run-job", id]), .job(id))
        XCTAssertEqual(try ContactsCompanionInvocation.parse(["--authorize"]), .authorize)
        for arguments in [[], ["get", "--id", "synthetic"], ["--run-job", id, "--profile", "broader"],
                          ["--authorize", "--run-job", id], ["--run-job", id.uppercased()],
                          ["--run-job", "../synthetic"], ["delete", "--id", "synthetic"]] {
            XCTAssertThrowsError(try ContactsCompanionInvocation.parse(arguments))
        }
        // Normal CLI cannot invoke either private companion mode.
        XCTAssertThrowsError(try ContactsCLI.parseAsRoot(["--run-job", id]))
        XCTAssertThrowsError(try ContactsCLI.parseAsRoot(["--authorize"]))
        XCTAssertEqual(ContactsCompanionDeadline.seconds(for: .job(id)), 40)
        XCTAssertEqual(ContactsCompanionDeadline.seconds(for: .authorize), 120)
    }

    func testProcessRoleRequiresExactAppIdentityAndPath() throws {
        let fixture = try CompanionFixture()
        XCTAssertEqual(ContactsProcessRole.classify(bundleID: nil, bundleURL: fixture.paths.home, paths: fixture.paths), .standalone)
        XCTAssertEqual(ContactsProcessRole.classify(bundleID: contactsCompanionBundleID, bundleURL: fixture.paths.app, paths: fixture.paths), .companion)
        XCTAssertEqual(ContactsProcessRole.classify(bundleID: "com.example.unapproved", bundleURL: fixture.paths.app, paths: fixture.paths), .refusedApp)
        let wrongPath = fixture.paths.home.appendingPathComponent("Wrong.app", isDirectory: true)
        XCTAssertEqual(ContactsProcessRole.classify(bundleID: contactsCompanionBundleID, bundleURL: wrongPath, paths: fixture.paths), .refusedApp)
        let upperCaseApp = fixture.paths.home.appendingPathComponent("Wrong.APP", isDirectory: true)
        XCTAssertEqual(ContactsProcessRole.classify(bundleID: nil, bundleURL: upperCaseApp, paths: fixture.paths), .refusedApp)
        XCTAssertEqual(ContactsProcessRole.classify(bundleID: "com.example.unapproved", bundleURL: fixture.paths.home, paths: fixture.paths), .refusedApp)
    }

    func testStrictRequestShapesAndTypes() throws {
        XCTAssertEqual(try ContactsCompanionRequest.decode(request("get", ["id": "synthetic-card"]), expectedID: id).action, .get)
        XCTAssertEqual(try ContactsCompanionRequest.decode(request("create", ["container": "synthetic-container", "firstName": "Synthetic"]), expectedID: id).action, .create)
        XCTAssertEqual(try ContactsCompanionRequest.decode(request("update", ["id": "synthetic-card", "nickname": ""]), expectedID: id).parameters["nickname"], "")
        for data in [
            try request("delete", ["id": "synthetic-card"]),
            try request("authorize", [:]),
            try request("get", ["id": "synthetic-card", "firstName": "Synthetic"]),
            try request("get", ["id": 1]),
            try request("get", ["id": "synthetic-card"], version: true),
            try request("get", ["id": "synthetic-card"], extra: true),
            try request("create", ["container": "synthetic-container"]),
            try request("create", ["container": "synthetic-container", "firstName": ""]),
            try request("create", ["container": "synthetic-container", "firstName": " \n"]),
            try request("create", ["container": "synthetic-container", "firstName": "Synthetic", "notes": "unsupported"]),
            try request("update", ["id": "synthetic-card"]),
            try request("update", ["id": "synthetic-card", "nickname": "Synthetic", "container": "synthetic-container"]),
            try request("get", ["id": "synthetic-card\n"]),
            try request("get", ["id": " synthetic-card"]),
            try request("update", ["id": "synthetic-card", "nickname": "synthetic\0payload"]),
        ] {
            XCTAssertThrowsError(try ContactsCompanionRequest.decode(data, expectedID: id))
        }
        XCTAssertThrowsError(try ContactsCompanionRequest.decode(request("get", ["id": "synthetic"]), expectedID: UUID().uuidString.lowercased()))
    }

    func testUTF8TextAndUTF16IdentifierBounds() throws {
        let validText = String(repeating: "😀", count: 1024)
        XCTAssertNoThrow(try ContactsCompanionRequest.decode(request("update", ["id": "synthetic", "nickname": validText]), expectedID: id))
        XCTAssertThrowsError(try ContactsCompanionRequest.decode(request("update", ["id": "synthetic", "nickname": validText + "x"]), expectedID: id))
        let validID = String(repeating: "😀", count: 1024)
        XCTAssertNoThrow(try ContactsCompanionRequest.decode(request("get", ["id": validID]), expectedID: id))
        XCTAssertThrowsError(try ContactsCompanionRequest.decode(request("get", ["id": validID + "x"]), expectedID: id))
        XCTAssertThrowsError(try ContactsCompanionRequest.decode(Data(repeating: 32, count: 64 * 1024 + 1), expectedID: id))
    }

    func testValueBindingCannotSelectCLIOptionsOrProfile() throws {
        let decoded = try ContactsCompanionRequest.decode(
            request("create", ["container": "synthetic-container", "firstName": "--profile=untrusted", "nickname": "--notes=untrusted"]),
            expectedID: id
        )
        let command = try CreateContact.parse(decoded.cliArguments)
        XCTAssertEqual(command.firstName, "--profile=untrusted")
        XCTAssertEqual(command.nickname, "--notes=untrusted")
        XCTAssertNil(command.pimOptions.profile)
        XCTAssertNil(command.notes)
        XCTAssertEqual(command.container, "synthetic-container")
    }

    func testRefactoredOperationsStillDenyBeforeStoreAccess() throws {
        let read = try GetContact.parse(["--id=synthetic-card"])
        XCTAssertThrowsError(try read.result(config: PIMConfiguration()))
        let create = try CreateContact.parse(["--container=synthetic-container", "--first-name=Synthetic"])
        let update = try UpdateContact.parse(["--id=synthetic-card", "--nickname=Synthetic"])
        let disabledWrites = CompanionFixture.scopedConfig(writes: false)
        XCTAssertThrowsError(try create.result(config: disabledWrites))
        XCTAssertThrowsError(try update.result(config: disabledWrites))
    }

    func testReadJobProducesCorrelatedCompletionWithoutMutationSentinel() throws {
        let fixture = try CompanionFixture()
        let (id, job) = try fixture.job()
        var checks = 0, executions = 0
        let engine = ContactsCompanionEngine(paths: fixture.paths, authorizationCheck: { checks += 1 }, executor: { request, config in
            executions += 1
            XCTAssertEqual(request.parameters["id"], "synthetic-card")
            XCTAssertEqual(config.contacts.items, ["synthetic-container"])
            return ["success": true, "contact": ["id": "synthetic-card"]]
        })
        try engine.runJob(id)
        XCTAssertEqual(checks, 1)
        XCTAssertEqual(executions, 1)
        let claim = try fixture.object(job.appendingPathComponent("claim.json"))
        XCTAssertEqual(claim["requestId"] as? String, id)
        let responseURL = job.appendingPathComponent("response.json")
        let response = try fixture.object(responseURL)
        XCTAssertEqual(response["success"] as? Bool, true)
        XCTAssertEqual(response["action"] as? String, "get")
        let completed = try fixture.object(job.appendingPathComponent("completion.json"))
        XCTAssertEqual(completed["responseSHA256"] as? String, ContactsCompanionFiles.sha256(try Data(contentsOf: responseURL)))
        XCTAssertEqual(completed["requestId"] as? String, id)
        XCTAssertFalse(FileManager.default.fileExists(atPath: job.appendingPathComponent("mutation-started.json").path))
        XCTAssertThrowsError(try engine.runJob(id))
        XCTAssertEqual(executions, 1)
        XCTAssertTrue(FileManager.default.fileExists(atPath: responseURL.path))
    }

    func testMutationSentinelExistsBeforeExecutorAndSuccessIsBounded() throws {
        let fixture = try CompanionFixture()
        for action in ["create", "update"] {
            let parameters = action == "create"
                ? ["container": "synthetic-container", "firstName": "Synthetic"]
                : ["id": "synthetic-card", "nickname": "Synthetic updated"]
            let (id, job) = try fixture.job(action: action, parameters: parameters)
            let engine = ContactsCompanionEngine(paths: fixture.paths, authorizationCheck: {}, executor: { _, _ in
                let started = try fixture.object(job.appendingPathComponent("mutation-started.json"))
                XCTAssertEqual(started["requestId"] as? String, id)
                XCTAssertEqual(started["action"] as? String, action)
                return ["success": true, "contact": ["id": "synthetic-card"]]
            })
            try engine.runJob(id)
            let response = try fixture.object(job.appendingPathComponent("response.json"))
            XCTAssertEqual(response["success"] as? Bool, true)
            let attributes = try FileManager.default.attributesOfItem(atPath: job.appendingPathComponent("response.json").path)
            XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        }
    }

    func testScopeAndGrantFailuresPrecedeMutationAndExecutor() throws {
        for failure in ["scope", "writes", "target", "grant"] {
            let fixture = try CompanionFixture(config: failure == "scope" ? PIMConfiguration() : CompanionFixture.scopedConfig(writes: failure != "writes"))
            let (id, job) = try fixture.job(action: "create", parameters: [
                "container": failure == "target" ? "unapproved-container" : "synthetic-container", "firstName": "Synthetic",
            ])
            var checks = 0, executions = 0
            let engine = ContactsCompanionEngine(paths: fixture.paths, authorizationCheck: {
                checks += 1
                if failure == "grant" { throw ContactsCompanionError.authorizationRequired }
            }, executor: { _, _ in executions += 1; return ["success": true] })
            try engine.runJob(id)
            XCTAssertEqual(executions, 0)
            XCTAssertEqual(checks, failure == "grant" ? 1 : 0)
            let response = try fixture.object(job.appendingPathComponent("response.json"))
            XCTAssertEqual(response["success"] as? Bool, false)
            XCTAssertEqual(response["mutationMayHaveOccurred"] as? Bool, false)
            XCTAssertEqual(response["error"] as? String, failure == "grant" ? "COMPANION_AUTHORIZATION_REQUIRED" : "COMPANION_SCOPE_DENIED")
            XCTAssertFalse(FileManager.default.fileExists(atPath: job.appendingPathComponent("mutation-started.json").path))
        }
    }

    func testPostMutationFailuresAreUncertainAndNeverLeakErrors() throws {
        let fixture = try CompanionFixture()
        let (id, job) = try fixture.job(action: "update", parameters: ["id": "synthetic-card", "nickname": "Synthetic"])
        let engine = ContactsCompanionEngine(paths: fixture.paths, authorizationCheck: {}, executor: { _, _ in
            throw NSError(domain: "synthetic-private-marker", code: 1)
        })
        try engine.runJob(id)
        let data = try Data(contentsOf: job.appendingPathComponent("response.json"))
        let response = try fixture.object(job.appendingPathComponent("response.json"))
        XCTAssertEqual(response["mutationMayHaveOccurred"] as? Bool, true)
        XCTAssertEqual(response["error"] as? String, "COMPANION_OPERATION_FAILED")
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("synthetic-private-marker"))
    }

    func testOversizedSavedResultProducesUncertainFailure() throws {
        let fixture = try CompanionFixture()
        let (id, job) = try fixture.job(action: "create", parameters: ["container": "synthetic-container", "firstName": "Synthetic"])
        let engine = ContactsCompanionEngine(paths: fixture.paths, authorizationCheck: {}, executor: { _, _ in
            ["success": true, "synthetic": String(repeating: "x", count: 1024 * 1024)]
        })
        try engine.runJob(id)
        let response = try fixture.object(job.appendingPathComponent("response.json"))
        XCTAssertEqual(response["success"] as? Bool, false)
        XCTAssertEqual(response["mutationMayHaveOccurred"] as? Bool, true)
        XCTAssertEqual(response["error"] as? String, "COMPANION_INVALID_RESULT")
    }

    func testMissingCompletionPreservesJournalAndPreventsReexecution() throws {
        let fixture = try CompanionFixture()
        let (id, job) = try fixture.job(action: "update", parameters: ["id": "synthetic-card", "nickname": "Synthetic"])
        try fixture.put(Data("synthetic reserved output".utf8), at: job.appendingPathComponent("response.json"))
        var executions = 0
        let engine = ContactsCompanionEngine(paths: fixture.paths, authorizationCheck: {}, executor: { _, _ in
            executions += 1
            return ["success": true]
        })
        XCTAssertThrowsError(try engine.runJob(id))
        XCTAssertTrue(FileManager.default.fileExists(atPath: job.appendingPathComponent("mutation-started.json").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: job.appendingPathComponent("completion.json").path))
        XCTAssertThrowsError(try engine.runJob(id))
        XCTAssertEqual(executions, 1)
    }

    func testHashSettingsAndPrivateConfigFailBeforeAuthorization() throws {
        for failure in ["hash", "disabled", "config"] {
            let fixture = try CompanionFixture()
            if failure == "hash" { try fixture.settings(hash: String(repeating: "0", count: 64)) }
            if failure == "disabled" { try fixture.settings(enabled: false) }
            if failure == "config" { try fixture.put(Data("{".utf8), at: fixture.configDirectory.appendingPathComponent("config.json")) }
            let (id, job) = try fixture.job()
            var checked = false
            let engine = ContactsCompanionEngine(paths: fixture.paths, authorizationCheck: { checked = true }, executor: { _, _ in XCTFail("Executor reached"); return [:] })
            try engine.runJob(id)
            XCTAssertFalse(checked)
            XCTAssertEqual(try fixture.object(job.appendingPathComponent("response.json"))["success"] as? Bool, false)
        }
    }

    func testFilesystemRejectsSymlinksHardlinksAndPublicModes() throws {
        let fixture = try CompanionFixture()
        let source = fixture.paths.home.appendingPathComponent("synthetic-file")
        try fixture.put(Data("synthetic".utf8), at: source)
        let linked = fixture.paths.home.appendingPathComponent("linked-file")
        try FileManager.default.createSymbolicLink(at: linked, withDestinationURL: source)
        XCTAssertThrowsError(try ContactsCompanionFiles.read(linked, maximum: 100))
        try FileManager.default.removeItem(at: linked)
        try FileManager.default.linkItem(at: source, to: linked)
        XCTAssertThrowsError(try ContactsCompanionFiles.read(source, maximum: 100))
        try FileManager.default.removeItem(at: linked)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: source.path)
        XCTAssertThrowsError(try ContactsCompanionFiles.read(source, maximum: 100))
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: fixture.paths.jobs.path)
        XCTAssertThrowsError(try ContactsCompanionFiles.directory(fixture.paths.jobs))
    }

    func testExplicitAuthorizeUsesOnlyInjectedGrantAndNoExecutor() async throws {
        let fixture = try CompanionFixture()
        let engine = ContactsCompanionEngine(paths: fixture.paths, authorizationCheck: { XCTFail("Job grant check reached") }, executor: { _, _ in XCTFail("Contact executor reached"); return [:] })
        var requests = 0
        try await engine.authorize { requests += 1 }
        XCTAssertEqual(requests, 1)
        let result = try fixture.object(fixture.paths.root.appendingPathComponent("authorization.json"))
        XCTAssertEqual(result["authorization"] as? String, "authorized")
        XCTAssertEqual(result["success"] as? Bool, true)
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: fixture.paths.jobs.path).isEmpty)
    }

    func testDeniedAuthorizeRecordsFailureAndUnsafeRootRecordsNothing() async throws {
        for unsafe in [false, true] {
            let fixture = try CompanionFixture(config: PIMConfiguration())
            if unsafe { try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: fixture.paths.root.path) }
            let engine = ContactsCompanionEngine(paths: fixture.paths, authorizationCheck: { XCTFail("Grant status reached") }, executor: { _, _ in XCTFail("Executor reached"); return [:] })
            do {
                try await engine.authorize { XCTFail("Grant request reached") }
                XCTFail("Denied setup reported successful exit")
            } catch {}
            let output = fixture.paths.root.appendingPathComponent("authorization.json")
            if unsafe {
                XCTAssertFalse(FileManager.default.fileExists(atPath: output.path))
            } else {
                let response = try fixture.object(output)
                XCTAssertEqual(response["success"] as? Bool, false)
                XCTAssertEqual(response["error"] as? String, "COMPANION_SCOPE_DENIED")
            }
        }
    }
}
