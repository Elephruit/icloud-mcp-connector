import Foundation
import XCTest
@testable import MailAccessCLI

// Pure argument and receipt checks only. Never invoke main(), query running
// applications, call an Apple Event/TCC API, or read any Mail data.
final class MailAccessCLITests: XCTestCase {
    func testOnlyExactSeparateCommandsAreAccepted() {
        XCTAssertEqual(MailAccessCLI.mode(arguments: ["helper", "status"]), .status)
        XCTAssertEqual(MailAccessCLI.mode(arguments: ["helper", "request-authorization"]), .requestAuthorization)

        for arguments in [
            [], ["helper"], ["helper", "authorize"], ["helper", "STATUS"],
            ["helper", "--request-authorization"], ["helper", "request-authorization", "extra"],
            ["helper", "status", "request-authorization"], ["helper", "status", "--target", "other"],
            ["helper", "request-authorization", "--target", "other"],
        ] {
            XCTAssertNil(MailAccessCLI.mode(arguments: arguments), "Unexpected accepted arguments: \(arguments)")
        }
    }

    func testStatusCanNeverAskForConsent() {
        XCTAssertFalse(MailAccessCLI.Mode.status.askUserIfNeeded)
        XCTAssertTrue(MailAccessCLI.Mode.requestAuthorization.askUserIfNeeded)
    }

    func testStatusReceiptsRemainExplicitlyNonPrompting() {
        for authorization in ["authorized", "notRunning", "notDetermined", "denied", "error", "unsupported"] {
            let authorized = authorization == "authorized"
            let receipt = MailAccessCLI.payload(authorization, running: true, authorized: authorized)
            XCTAssertEqual(receipt["target"] as? String, "com.apple.mail")
            XCTAssertEqual(receipt["authorization"] as? String, authorization)
            XCTAssertEqual(receipt["authorized"] as? Bool, authorized)
            XCTAssertEqual(receipt["prompted"] as? Bool, false)
            XCTAssertEqual(receipt["authorizationRequested"] as? Bool, false)
        }
    }

    func testPermissionRequestDoesNotClaimThatAPromptAppeared() {
        for authorized in [false, true] {
            let receipt = MailAccessCLI.payload(authorized ? "authorized" : "denied", running: true,
                                                authorized: authorized, authorizationRequested: true)
            XCTAssertTrue(receipt["prompted"] is NSNull)
            XCTAssertEqual(receipt["authorizationRequested"] as? Bool, true)
            XCTAssertEqual(receipt["authorized"] as? Bool, authorized)
            XCTAssertEqual(receipt["success"] as? Bool, true)
        }
    }

    func testPreflightFailuresDoNotClaimAPermissionRequest() {
        let notRunning = MailAccessCLI.payload("notRunning", running: false)
        let descriptorFailure = MailAccessCLI.payload("error", running: true, success: false)
        for receipt in [notRunning, descriptorFailure] {
            XCTAssertEqual(receipt["authorized"] as? Bool, false)
            XCTAssertEqual(receipt["prompted"] as? Bool, false)
            XCTAssertEqual(receipt["authorizationRequested"] as? Bool, false)
        }
        XCTAssertEqual(notRunning["running"] as? Bool, false)
        XCTAssertEqual(descriptorFailure["success"] as? Bool, false)
    }

    func testManualCommandSucceedsOnlyWithAnExplicitGrant() {
        for authorized in [false, true] {
            XCTAssertEqual(MailAccessCLI.exitCode(mode: .status, authorized: authorized), 0)
            XCTAssertEqual(MailAccessCLI.exitCode(mode: .requestAuthorization, authorized: authorized), authorized ? 0 : 1)
        }
    }

    func testJSONReceiptsPreserveBooleanAndUnknownPromptTypes() throws {
        let status = MailAccessCLI.payload("authorized", running: true, authorized: true)
        let request = MailAccessCLI.payload("denied", running: true, authorizationRequested: true)
        for receipt in [status, request] {
            let bytes = try JSONSerialization.data(withJSONObject: receipt)
            let decoded = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
            XCTAssertEqual(decoded["target"] as? String, "com.apple.mail")
            XCTAssertEqual(decoded["authorized"] as? Bool, receipt["authorized"] as? Bool)
            XCTAssertEqual(decoded["authorizationRequested"] as? Bool, receipt["authorizationRequested"] as? Bool)
        }
        let requestJSON = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONSerialization.data(withJSONObject: request)) as? [String: Any])
        XCTAssertTrue(requestJSON["prompted"] is NSNull)
    }
}
