import ArgumentParser
import Contacts
import Foundation
import PIMConfig
import Security

struct ContactsCLI: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "contacts-cli",
        abstract: "Manage macOS Contacts",
        subcommands: [
            AuthStatus.self,
            Authorize.self,
            ListContainers.self,
            ListGroups.self,
            ListContacts.self,
            SearchContacts.self,
            GetContact.self,
            CreateContact.self,
            UpdateContact.self,
            DeleteContact.self,
            ConfigCommand.self,
        ]
    )
}

// MARK: - Auth Status (no prompts)

struct AuthStatus: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "auth-status",
        abstract: "Check contacts authorization status without triggering prompts"
    )

    func run() throws {
        let status: String
        switch CNContactStore.authorizationStatus(for: .contacts) {
        case .authorized: status = "authorized"
        case .denied: status = "denied"
        case .restricted: status = "restricted"
        case .notDetermined: status = "notDetermined"
        @unknown default: status = "unknown"
        }
        let result: [String: Any] = ["authorization": status]
        let data = try JSONSerialization.data(withJSONObject: result)
        print(String(data: data, encoding: .utf8)!)
    }
}

struct Authorize: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "authorize",
        abstract: "Explicitly request Contacts authorization for a configured scope"
    )

    @OptionGroup var pimOptions: PIMOptions

    func run() async throws {
        _ = try allowedContactContainerIdentifiers(config: pimOptions.loadConfig())
        try await requestContactsAccess()
        outputJSON(["success": true, "authorization": "authorized"])
    }
}

// MARK: - Shared Utilities

let contactStore = CNContactStore()

/// Routine commands never request permission. Only `authorize` may prompt.
func requireContactsAccess() throws {
    switch CNContactStore.authorizationStatus(for: .contacts) {
    case .authorized:
        return
    case .notDetermined:
        throw CLIError.accessDenied("Contacts authorization is required. Run contacts-cli authorize explicitly after approving the configured scope.")
    case .denied, .restricted:
        throw CLIError.accessDenied("Contacts access is denied or restricted.")
    @unknown default:
        throw CLIError.accessDenied("Unsupported contacts authorization status")
    }
}

func requestContactsAccess() async throws {
    let status = CNContactStore.authorizationStatus(for: .contacts)

    switch status {
    case .authorized:
        return
    case .notDetermined:
        let granted = try await contactStore.requestAccess(for: .contacts)
        guard granted else {
            throw CLIError.accessDenied("Contacts access denied. Grant access in System Settings > Privacy & Security > Contacts")
        }
    case .denied, .restricted:
        throw CLIError.accessDenied("Contacts access denied. Grant access in System Settings > Privacy & Security > Contacts")
    @unknown default:
        throw CLIError.accessDenied("Unknown contacts authorization status")
    }
}

enum CLIError: Error, LocalizedError {
    case accessDenied(String)
    case notFound(String)
    case invalidInput(String)

    var errorDescription: String? {
        switch self {
        case .accessDenied(let msg): return msg
        case .notFound(let msg): return msg
        case .invalidInput(let msg): return msg
        }
    }
}

// MARK: - PIMConfig Helpers

func checkContactsEnabled(config: PIMConfiguration) throws {
    _ = try allowedContactContainerIdentifiers(config: config)
}

/// Parse a birthday string into DateComponents.
/// Accepts "YYYY-MM-DD" (with year) or "MM-DD" (without year).
func parseBirthday(_ string: String) throws -> DateComponents {
    let parts = string.split(separator: "-").compactMap { Int($0) }
    switch parts.count {
    case 3:
        // YYYY-MM-DD
        return DateComponents(year: parts[0], month: parts[1], day: parts[2])
    case 2:
        // MM-DD (no year)
        return DateComponents(month: parts[0], day: parts[1])
    default:
        throw CLIError.invalidInput("Invalid birthday format '\(string)'. Use YYYY-MM-DD or MM-DD.")
    }
}

/// Map a user-friendly label string to a CNLabel constant.
func labelConstant(_ label: String?) -> String {
    guard let label = label?.lowercased() else { return CNLabelOther }
    switch label {
    case "home": return CNLabelHome
    case "work": return CNLabelWork
    case "school": return CNLabelSchool
    case "other": return CNLabelOther
    case "main": return CNLabelPhoneNumberMain
    case "mobile": return CNLabelPhoneNumberMobile
    case "iphone": return CNLabelPhoneNumberiPhone
    case "home fax": return CNLabelPhoneNumberHomeFax
    case "work fax": return CNLabelPhoneNumberWorkFax
    case "pager": return CNLabelPhoneNumberPager
    case "homepage": return CNLabelURLAddressHomePage
    case "icloud": return CNLabelEmailiCloud
    case "anniversary": return CNLabelDateAnniversary
    default: return label
    }
}

/// Map a user-friendly relation label to a CNLabel constant.
func relationLabelConstant(_ label: String?) -> String {
    guard let label = label?.lowercased() else { return CNLabelOther }
    switch label {
    case "assistant": return CNLabelContactRelationAssistant
    case "manager": return CNLabelContactRelationManager
    case "colleague": return CNLabelContactRelationColleague
    case "teacher": return CNLabelContactRelationTeacher
    case "spouse": return CNLabelContactRelationSpouse
    case "partner": return CNLabelContactRelationPartner
    case "parent": return CNLabelContactRelationParent
    case "mother": return CNLabelContactRelationMother
    case "father": return CNLabelContactRelationFather
    case "child": return CNLabelContactRelationChild
    case "daughter": return CNLabelContactRelationDaughter
    case "son": return CNLabelContactRelationSon
    case "sibling": return CNLabelContactRelationSibling
    case "sister": return CNLabelContactRelationSister
    case "brother": return CNLabelContactRelationBrother
    case "friend": return CNLabelContactRelationFriend
    case "wife": return CNLabelContactRelationWife
    case "husband": return CNLabelContactRelationHusband
    default: return labelConstant(label)
    }
}

/// Parse a JSON string into an array of dictionaries.
func parseJSONArray(_ json: String) throws -> [[String: Any]] {
    guard let data = json.data(using: .utf8) else {
        throw CLIError.invalidInput("Invalid JSON array: \(json)")
    }

    let parsedAny: Any
    do {
        parsedAny = try JSONSerialization.jsonObject(with: data)
    } catch {
        throw CLIError.invalidInput("Invalid JSON array: \(json)")
    }

    guard let parsed = parsedAny as? [[String: Any]] else {
        throw CLIError.invalidInput("Invalid JSON array: \(json)")
    }
    return parsed
}

/// Parse JSON addresses into CNLabeledValue<CNPostalAddress> array.
func parseAddresses(_ json: String) throws -> [CNLabeledValue<CNPostalAddress>] {
    let items = try parseJSONArray(json)
    return items.map { item in
        let addr = CNMutablePostalAddress()
        addr.street = item["street"] as? String ?? ""
        addr.city = item["city"] as? String ?? ""
        addr.state = item["state"] as? String ?? ""
        addr.postalCode = item["postalCode"] as? String ?? ""
        addr.country = item["country"] as? String ?? ""
        addr.isoCountryCode = item["isoCountryCode"] as? String ?? ""
        addr.subLocality = item["subLocality"] as? String ?? ""
        addr.subAdministrativeArea = item["subAdministrativeArea"] as? String ?? ""
        return CNLabeledValue(label: labelConstant(item["label"] as? String), value: addr as CNPostalAddress)
    }
}

/// Parse JSON URLs into CNLabeledValue<NSString> array.
func parseURLs(_ json: String) throws -> [CNLabeledValue<NSString>] {
    let items = try parseJSONArray(json)
    return items.map { item in
        let value = item["value"] as? String ?? ""
        return CNLabeledValue(label: labelConstant(item["label"] as? String), value: value as NSString)
    }
}

/// Parse JSON social profiles into CNLabeledValue<CNSocialProfile> array.
func parseSocialProfiles(_ json: String) throws -> [CNLabeledValue<CNSocialProfile>] {
    let items = try parseJSONArray(json)
    return items.map { item in
        let profile = CNSocialProfile(
            urlString: item["url"] as? String ?? "",
            username: item["username"] as? String ?? "",
            userIdentifier: item["userIdentifier"] as? String ?? "",
            service: item["service"] as? String ?? ""
        )
        return CNLabeledValue(label: labelConstant(item["label"] as? String), value: profile)
    }
}

/// Parse JSON instant messages into CNLabeledValue<CNInstantMessageAddress> array.
func parseInstantMessages(_ json: String) throws -> [CNLabeledValue<CNInstantMessageAddress>] {
    let items = try parseJSONArray(json)
    return items.map { item in
        let im = CNInstantMessageAddress(
            username: item["username"] as? String ?? "",
            service: item["service"] as? String ?? ""
        )
        return CNLabeledValue(label: labelConstant(item["label"] as? String), value: im)
    }
}

/// Parse JSON relations into CNLabeledValue<CNContactRelation> array.
func parseRelations(_ json: String) throws -> [CNLabeledValue<CNContactRelation>] {
    let items = try parseJSONArray(json)
    return items.map { item in
        let name = item["name"] as? String ?? ""
        return CNLabeledValue(label: relationLabelConstant(item["label"] as? String), value: CNContactRelation(name: name))
    }
}

/// Parse JSON dates into CNLabeledValue<NSDateComponents> array.
func parseDates(_ json: String) throws -> [CNLabeledValue<NSDateComponents>] {
    let items = try parseJSONArray(json)
    return items.map { item in
        let comps = NSDateComponents()
        if let year = item["year"] as? Int { comps.year = year }
        if let month = item["month"] as? Int { comps.month = month }
        if let day = item["day"] as? Int { comps.day = day }
        return CNLabeledValue(label: labelConstant(item["label"] as? String), value: comps)
    }
}

/// Parse JSON emails into CNLabeledValue<NSString> array.
func parseEmails(_ json: String) throws -> [CNLabeledValue<NSString>] {
    let items = try parseJSONArray(json)
    return items.map { item in
        let value = item["value"] as? String ?? ""
        return CNLabeledValue(label: labelConstant(item["label"] as? String), value: value as NSString)
    }
}

/// Parse JSON phones into CNLabeledValue<CNPhoneNumber> array.
func parsePhones(_ json: String) throws -> [CNLabeledValue<CNPhoneNumber>] {
    let items = try parseJSONArray(json)
    return items.map { item in
        let value = item["value"] as? String ?? ""
        return CNLabeledValue(label: labelConstant(item["label"] as? String), value: CNPhoneNumber(stringValue: value))
    }
}

/// Build a replacement multivalue array that reuses the contact's existing
/// CNLabeledValue instances (and thus their stable identifiers) for entries
/// whose value is unchanged.
///
/// Wholesale replacement with freshly constructed CNLabeledValues forces the
/// store to delete and recreate every entry. On some cards (observed with
/// linked and/or iCloud-synced contacts) rewriting the pre-existing entries
/// fails deterministically with CoreData 134092 ("Unhandled error occurred
/// during faulting") — and a failed save can even partially apply, leaving
/// duplicated or dropped entries. Reusing identifiers keeps the save diff to
/// genuine adds/removes/label edits, matching how Contacts.app edits cards.
func mergeLabeledStrings(
    existing: [CNLabeledValue<NSString>],
    desired: [CNLabeledValue<NSString>]
) -> [CNLabeledValue<NSString>] {
    var pool = existing
    return desired.map { want in
        guard let idx = pool.firstIndex(where: {
            ($0.value as String).caseInsensitiveCompare(want.value as String) == .orderedSame
        }) else {
            return want
        }
        let found = pool.remove(at: idx)
        return found.label == want.label ? found : found.settingLabel(want.label)
    }
}

/// Phone-number variant of `mergeLabeledStrings` (see rationale there).
func mergeLabeledPhones(
    existing: [CNLabeledValue<CNPhoneNumber>],
    desired: [CNLabeledValue<CNPhoneNumber>]
) -> [CNLabeledValue<CNPhoneNumber>] {
    var pool = existing
    return desired.map { want in
        guard let idx = pool.firstIndex(where: { $0.value.stringValue == want.value.stringValue }) else {
            return want
        }
        let found = pool.remove(at: idx)
        return found.label == want.label ? found : found.settingLabel(want.label)
    }
}

func outputJSON(_ value: Any) {
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]),
       let string = String(data: data, encoding: .utf8) {
        print(string)
    }
}

/// Check if an error (or any of its underlying errors) is a CoreData merge conflict (code 134092).
func isMergeConflict(_ error: Error) -> Bool {
    var current: NSError? = error as NSError
    while let err = current {
        if err.code == 134092 {
            return true
        }
        current = err.userInfo[NSUnderlyingErrorKey] as? NSError
    }
    return false
}

/// Escape a string for embedding inside a double-quoted AppleScript literal.
/// Newlines and carriage returns are stripped: the generated script is
/// newline-joined, so an embedded line break inside a label or value would
/// otherwise terminate the string literal and inject a new statement.
func appleScriptEscaped(_ s: String) -> String {
    s.replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
        .replacingOccurrences(of: "\r", with: " ")
        .replacingOccurrences(of: "\n", with: " ")
}

/// Whether this process holds com.apple.developer.contacts.notes.
///
/// Since macOS 13, Contacts notes are gated behind that entitlement. Requesting
/// CNContactNoteKey without it does NOT merely yield empty notes: any
/// CNSaveRequest built from a contact fetched that way fails with CoreData
/// 134092 ("Unhandled error occurred during faulting") whenever the card
/// actually has a note, because the store tries to fault the unauthorized note
/// property while writing — and the failed save can partially apply. So the
/// note key must only be requested when the entitlement is present.
let hasNotesEntitlement: Bool = {
    guard let task = SecTaskCreateFromSelf(nil) else { return false }
    let value = SecTaskCopyValueForEntitlement(
        task, "com.apple.developer.contacts.notes" as CFString, nil
    )
    return (value as? Bool) == true
}()

let keysToFetch: [CNKeyDescriptor] = {
    var keys: [CNKeyDescriptor] = [
    CNContactIdentifierKey as CNKeyDescriptor,
    CNContactGivenNameKey as CNKeyDescriptor,
    CNContactFamilyNameKey as CNKeyDescriptor,
    CNContactMiddleNameKey as CNKeyDescriptor,
    CNContactNamePrefixKey as CNKeyDescriptor,
    CNContactNameSuffixKey as CNKeyDescriptor,
    CNContactNicknameKey as CNKeyDescriptor,
    CNContactOrganizationNameKey as CNKeyDescriptor,
    CNContactJobTitleKey as CNKeyDescriptor,
    CNContactDepartmentNameKey as CNKeyDescriptor,
    CNContactEmailAddressesKey as CNKeyDescriptor,
    CNContactPhoneNumbersKey as CNKeyDescriptor,
    CNContactPostalAddressesKey as CNKeyDescriptor,
    CNContactUrlAddressesKey as CNKeyDescriptor,
    CNContactBirthdayKey as CNKeyDescriptor,
    CNContactImageDataAvailableKey as CNKeyDescriptor,
    CNContactThumbnailImageDataKey as CNKeyDescriptor,
    CNContactImageDataKey as CNKeyDescriptor,
    CNContactTypeKey as CNKeyDescriptor,
    CNContactRelationsKey as CNKeyDescriptor,
    CNContactSocialProfilesKey as CNKeyDescriptor,
    CNContactInstantMessageAddressesKey as CNKeyDescriptor,
    CNContactPhoneticGivenNameKey as CNKeyDescriptor,
    CNContactPhoneticMiddleNameKey as CNKeyDescriptor,
    CNContactPhoneticFamilyNameKey as CNKeyDescriptor,
    CNContactPhoneticOrganizationNameKey as CNKeyDescriptor,
    CNContactPreviousFamilyNameKey as CNKeyDescriptor,
    CNContactNonGregorianBirthdayKey as CNKeyDescriptor,
    CNContactDatesKey as CNKeyDescriptor,
    CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
    ]
    if hasNotesEntitlement {
        keys.append(CNContactNoteKey as CNKeyDescriptor)
    }
    return keys
}()

func containerToDict(_ container: CNContainer) -> [String: Any] {
    let typeName: String
    switch container.type {
    case .local: typeName = "local"
    case .exchange: typeName = "exchange"
    case .cardDAV: typeName = "cardDAV"
    case .unassigned: typeName = "unassigned"
    @unknown default: typeName = "unknown"
    }
    return [
        "id": container.identifier,
        "name": container.name,
        "type": typeName
    ]
}

func groupToDict(_ group: CNGroup) -> [String: Any] {
    return [
        "id": group.identifier,
        "name": group.name
    ]
}

func contactToDict(_ contact: CNContact, brief: Bool = false) -> [String: Any] {
    var dict: [String: Any] = [
        "id": contact.identifier,
        "givenName": contact.givenName,
        "familyName": contact.familyName,
        "fullName": CNContactFormatter.string(from: contact, style: .fullName) ?? "\(contact.givenName) \(contact.familyName)".trimmingCharacters(in: .whitespaces)
    ]

    if brief {
        // Include all emails and phones as flat arrays for brief listing
        if !contact.emailAddresses.isEmpty {
            dict["emails"] = contact.emailAddresses.map { $0.value as String }
        }
        if !contact.phoneNumbers.isEmpty {
            dict["phones"] = contact.phoneNumbers.map { $0.value.stringValue }
        }
        if !contact.organizationName.isEmpty {
            dict["organization"] = contact.organizationName
        }
        if let birthday = contact.birthday {
            var birthdayDict: [String: Any] = [:]
            if let year = birthday.year { birthdayDict["year"] = year }
            if let month = birthday.month { birthdayDict["month"] = month }
            if let day = birthday.day { birthdayDict["day"] = day }
            dict["birthday"] = birthdayDict
        }
        return dict
    }

    // Full details
    if !contact.middleName.isEmpty { dict["middleName"] = contact.middleName }
    if !contact.namePrefix.isEmpty { dict["namePrefix"] = contact.namePrefix }
    if !contact.nameSuffix.isEmpty { dict["nameSuffix"] = contact.nameSuffix }
    if !contact.nickname.isEmpty { dict["nickname"] = contact.nickname }
    if !contact.previousFamilyName.isEmpty { dict["previousFamilyName"] = contact.previousFamilyName }
    if !contact.phoneticGivenName.isEmpty { dict["phoneticGivenName"] = contact.phoneticGivenName }
    if !contact.phoneticMiddleName.isEmpty { dict["phoneticMiddleName"] = contact.phoneticMiddleName }
    if !contact.phoneticFamilyName.isEmpty { dict["phoneticFamilyName"] = contact.phoneticFamilyName }
    if !contact.phoneticOrganizationName.isEmpty { dict["phoneticOrganizationName"] = contact.phoneticOrganizationName }
    if !contact.organizationName.isEmpty { dict["organization"] = contact.organizationName }
    if !contact.jobTitle.isEmpty { dict["jobTitle"] = contact.jobTitle }
    if !contact.departmentName.isEmpty { dict["department"] = contact.departmentName }

    if !contact.emailAddresses.isEmpty {
        dict["emails"] = contact.emailAddresses.map { labeled in
            [
                "label": CNLabeledValue<NSString>.localizedString(forLabel: labeled.label ?? ""),
                "value": labeled.value as String
            ]
        }
    }

    if !contact.phoneNumbers.isEmpty {
        dict["phones"] = contact.phoneNumbers.map { labeled in
            [
                "label": CNLabeledValue<CNPhoneNumber>.localizedString(forLabel: labeled.label ?? ""),
                "value": labeled.value.stringValue
            ]
        }
    }

    if !contact.postalAddresses.isEmpty {
        dict["addresses"] = contact.postalAddresses.map { labeled in
            let addr = labeled.value
            return [
                "label": CNLabeledValue<CNPostalAddress>.localizedString(forLabel: labeled.label ?? ""),
                "street": addr.street,
                "city": addr.city,
                "state": addr.state,
                "postalCode": addr.postalCode,
                "country": addr.country
            ]
        }
    }

    if !contact.urlAddresses.isEmpty {
        dict["urls"] = contact.urlAddresses.map { labeled in
            [
                "label": CNLabeledValue<NSString>.localizedString(forLabel: labeled.label ?? ""),
                "value": labeled.value as String
            ]
        }
    }

    if !contact.instantMessageAddresses.isEmpty {
        dict["instantMessages"] = contact.instantMessageAddresses.map { labeled in
            [
                "label": CNLabeledValue<CNInstantMessageAddress>.localizedString(forLabel: labeled.label ?? ""),
                "service": labeled.value.service,
                "username": labeled.value.username
            ]
        }
    }

    if let birthday = contact.birthday {
        var birthdayDict: [String: Any] = [:]
        if let year = birthday.year { birthdayDict["year"] = year }
        if let month = birthday.month { birthdayDict["month"] = month }
        if let day = birthday.day { birthdayDict["day"] = day }
        dict["birthday"] = birthdayDict
    }

    if let nonGregorianBirthday = contact.nonGregorianBirthday {
        var bdayDict: [String: Any] = [:]
        if let year = nonGregorianBirthday.year { bdayDict["year"] = year }
        if let month = nonGregorianBirthday.month { bdayDict["month"] = month }
        if let day = nonGregorianBirthday.day { bdayDict["day"] = day }
        if let cal = nonGregorianBirthday.calendar {
            bdayDict["calendar"] = "\(cal.identifier)"
        }
        dict["nonGregorianBirthday"] = bdayDict
    }

    if !contact.dates.isEmpty {
        dict["dates"] = contact.dates.map { labeled in
            var dateDict: [String: Any] = [
                "label": CNLabeledValue<NSDateComponents>.localizedString(forLabel: labeled.label ?? "")
            ]
            let comps = labeled.value as DateComponents
            if let year = comps.year { dateDict["year"] = year }
            if let month = comps.month { dateDict["month"] = month }
            if let day = comps.day { dateDict["day"] = day }
            return dateDict
        }
    }

    // Notes may not be available due to macOS privacy restrictions
    if contact.isKeyAvailable(CNContactNoteKey), !contact.note.isEmpty {
        dict["notes"] = contact.note
    }

    // Check if image keys are available before accessing
    let hasImageKey = contact.isKeyAvailable(CNContactImageDataAvailableKey)
    dict["hasImage"] = hasImageKey ? contact.imageDataAvailable : false
    dict["contactType"] = contact.contactType == .person ? "person" : "organization"

    // Include image data as base64 if available (prefer thumbnail for smaller payload)
    if hasImageKey && contact.imageDataAvailable {
        if contact.isKeyAvailable(CNContactThumbnailImageDataKey),
           let thumbnailData = contact.thumbnailImageData {
            dict["imageBase64"] = thumbnailData.base64EncodedString()
            dict["imageType"] = "thumbnail"
        } else if contact.isKeyAvailable(CNContactImageDataKey),
                  let imageData = contact.imageData {
            dict["imageBase64"] = imageData.base64EncodedString()
            dict["imageType"] = "full"
        }
    }

    if !contact.contactRelations.isEmpty {
        dict["relations"] = contact.contactRelations.map { labeled in
            [
                "label": CNLabeledValue<CNContactRelation>.localizedString(forLabel: labeled.label ?? ""),
                "name": labeled.value.name
            ]
        }
    }

    if !contact.socialProfiles.isEmpty {
        dict["socialProfiles"] = contact.socialProfiles.map { labeled in
            [
                "service": labeled.value.service,
                "username": labeled.value.username,
                "url": labeled.value.urlString
            ]
        }
    }

    return dict
}

// MARK: - Explicit Container Scope

/// Contacts exposes account scope through containers. Stable container IDs must
/// be present in both the item and account allowlists; display names never grant
/// access. This helper performs no Contacts calls and is safe before TCC checks.
func allowedContactContainerIdentifiers(config: PIMConfiguration) throws -> Set<String> {
    guard config.contacts.hasExplicitScope else {
        throw CLIError.accessDenied("Contacts requires enabled=true, mode=allowlist, and explicit nonempty item and account IDs.")
    }
    let allowed = Set(config.contacts.items).intersection(config.contacts.accounts)
    guard !allowed.isEmpty else {
        throw CLIError.accessDenied("Contacts item and account allowlists must identify the same allowed container.")
    }
    return allowed
}

/// Validate scope, write opt-in, and deletion policy before authorization or reading
/// personal data. The injectable check allows synthetic ordering tests.
func prepareContactsAccess(
    config: PIMConfiguration,
    writing: Bool = false,
    deleting: Bool = false,
    authorizationCheck: () throws -> Void = requireContactsAccess
) throws -> Set<String> {
    let allowed = try allowedContactContainerIdentifiers(config: config)
    guard !(writing || deleting) || config.contacts.allowWrites else {
        throw CLIError.accessDenied("Contacts writes are disabled. Set allow_writes explicitly for the approved scope to enable them.")
    }
    guard !deleting || config.contacts.allowDeletes else {
        throw CLIError.accessDenied("Contact deletion is disabled by configuration (allow_deletes=false).")
    }
    try authorizationCheck()
    return allowed
}

func validateContactDestination(id: String?, allowedIds: Set<String>) throws -> String {
    guard let id, !id.isEmpty else {
        throw CLIError.invalidInput("Pass --container with an explicit allowed container ID.")
    }
    guard allowedIds.contains(id) else {
        throw CLIError.accessDenied("Target container is not in your allowed item and account IDs.")
    }
    return id
}

func filteredContainers(allowedIds: Set<String>) throws -> [CNContainer] {
    guard !allowedIds.isEmpty else { return [] }
    return try contactStore.containers(
        matching: CNContainer.predicateForContainers(withIdentifiers: allowedIds.sorted())
    ).filter { allowedIds.contains($0.identifier) }
}

func filteredGroups(allowedIds: Set<String>) throws -> [CNGroup] {
    var groups: [CNGroup] = []
    for id in allowedIds.sorted() {
        groups.append(contentsOf: try contactStore.groups(
            matching: CNGroup.predicateForGroupsInContainer(withIdentifier: id)
        ))
    }
    return groups
}

/// Every fetch is anchored to a configured container and returns raw source
/// cards. Unified cards can merge data from accounts outside the allowlist.
func fetchRawContacts(inContainer id: String) throws -> [CNContact] {
    var contacts: [CNContact] = []
    let request = CNContactFetchRequest(keysToFetch: keysToFetch)
    request.predicate = CNContact.predicateForContactsInContainer(withIdentifier: id)
    request.unifyResults = false
    request.mutableObjects = false
    try contactStore.enumerateContacts(with: request) { contact, _ in
        contacts.append(contact)
    }
    return contacts
}

func fetchContactsFromAllowedContainers(
    allowedIds: Set<String>,
    fetchContainer: (String) throws -> [CNContact] = fetchRawContacts
) throws -> [CNContact] {
    try allowedIds.sorted().flatMap { try fetchContainer($0) }
}

struct AuthorizedRawContact {
    let contact: CNContact
    let containerId: String
}

/// Membership checks load identifiers only, without names or contact details.
func fetchRawContactIdentifiers(inContainer id: String) throws -> Set<String> {
    let request = CNContactFetchRequest(keysToFetch: [CNContactIdentifierKey as CNKeyDescriptor])
    request.predicate = CNContact.predicateForContactsInContainer(withIdentifier: id)
    request.unifyResults = false
    request.mutableObjects = false
    var identifiers = Set<String>()
    try contactStore.enumerateContacts(with: request) { contact, _ in
        identifiers.insert(contact.identifier)
    }
    return identifiers
}

/// Called only after exact raw-ID membership is established in an allowed
/// container. `unifyResults=false` avoids merging linked cards from other
/// accounts. Contacts does not support compound container-and-ID predicates.
func fetchRawContactByIdentifier(id: String) throws -> CNContact? {
    let request = CNContactFetchRequest(keysToFetch: keysToFetch)
    request.predicate = CNContact.predicateForContacts(withIdentifiers: [id])
    request.unifyResults = false
    request.mutableObjects = false
    var found: CNContact?
    try contactStore.enumerateContacts(with: request) { contact, stop in
        if contact.identifier == id {
            found = contact
            stop.pointee = true
        }
    }
    return found
}

/// Unknown or unified identifiers never trigger a detailed lookup. A caller
/// must use an exact raw identifier returned from this adapter's scoped
/// list/search/create. Other cards in the container contribute identifiers only.
func fetchScopedContact(
    id: String,
    allowedIds: Set<String>,
    fetchIdentifiers: (String) throws -> Set<String> = fetchRawContactIdentifiers,
    fetchDetail: (String) throws -> CNContact? = fetchRawContactByIdentifier
) throws -> AuthorizedRawContact {
    for containerId in allowedIds.sorted() {
        if try fetchIdentifiers(containerId).contains(id) {
            guard let found = try fetchDetail(id), found.identifier == id else {
                throw CLIError.notFound("Contact not found in the configured scope. Use a raw ID from list, search, or create.")
            }
            return AuthorizedRawContact(contact: found, containerId: containerId)
        }
    }
    throw CLIError.notFound("Contact not found in the configured scope. Use a raw ID from list, search, or create.")
}

func contactMatchesQuery(_ contact: CNContact, query: String) -> Bool {
    let queryLower = query.lowercased()
    let name = [contact.givenName, contact.middleName, contact.familyName,
                contact.nickname, contact.organizationName].joined(separator: " ").lowercased()
    if name.contains(queryLower) { return true }
    if contact.emailAddresses.contains(where: { ($0.value as String).lowercased().contains(queryLower) }) {
        return true
    }
    let queryDigits = query.filter { $0.isNumber }
    guard !queryDigits.isEmpty else { return false }
    return contact.phoneNumbers.contains { phone in
        let digits = phone.value.stringValue.filter { $0.isNumber }
        return !digits.isEmpty && (digits.contains(queryDigits) || queryDigits.contains(digits))
    }
}

// MARK: - Commands

struct ListContainers: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "containers",
        abstract: "List all contact account containers"
    )

    @OptionGroup var pimOptions: PIMOptions

    func run() async throws {
        let config = pimOptions.loadConfig()
        let allowedIds = try prepareContactsAccess(config: config)
        let result = try filteredContainers(allowedIds: allowedIds).map { containerToDict($0) }
        outputJSON(["success": true, "containers": result, "count": result.count])
    }
}

struct ListGroups: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "groups",
        abstract: "List all contact groups"
    )

    @OptionGroup var pimOptions: PIMOptions

    func run() async throws {
        let config = pimOptions.loadConfig()
        let allowedIds = try prepareContactsAccess(config: config)
        let result = try filteredGroups(allowedIds: allowedIds).map { groupToDict($0) }
        outputJSON(["success": true, "groups": result])
    }
}

struct ListContacts: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "list",
        abstract: "List contacts"
    )

    @OptionGroup var pimOptions: PIMOptions

    @Option(name: .long, help: "Group name or ID to filter by")
    var group: String?

    @Option(name: .long, help: "Maximum number of contacts")
    var limit: Int = 100

    func run() async throws {
        let config = pimOptions.loadConfig()
        let allowedIds = try prepareContactsAccess(config: config)
        guard limit > 0 else { throw CLIError.invalidInput("Limit must be positive.") }
        var contacts = try fetchContactsFromAllowedContainers(allowedIds: allowedIds)
        if let groupFilter = group {
            let matches = try filteredGroups(allowedIds: allowedIds).filter {
                $0.identifier == groupFilter || $0.name.lowercased() == groupFilter.lowercased()
            }
            guard matches.count == 1, let matchedGroup = matches.first else {
                throw CLIError.notFound("Group must identify one group in the configured scope. Use a group ID if names are ambiguous.")
            }
            // Read only membership IDs, then intersect with scoped raw cards.
            let request = CNContactFetchRequest(keysToFetch: [CNContactIdentifierKey as CNKeyDescriptor])
            request.predicate = CNContact.predicateForContactsInGroup(withIdentifier: matchedGroup.identifier)
            request.unifyResults = false
            var memberIds = Set<String>()
            try contactStore.enumerateContacts(with: request) { contact, _ in
                memberIds.insert(contact.identifier)
            }
            contacts = contacts.filter { memberIds.contains($0.identifier) }
        }
        let result = contacts.prefix(limit).map { contactToDict($0, brief: true) }
        outputJSON(["success": true, "contacts": Array(result), "count": result.count])
    }
}

struct SearchContacts: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "search",
        abstract: "Search contacts by name, email, or phone"
    )

    @OptionGroup var pimOptions: PIMOptions

    @Argument(help: "Search query")
    var query: String

    @Option(name: .long, help: "Maximum results")
    var limit: Int = 50

    func run() async throws {
        let config = pimOptions.loadConfig()
        let allowedIds = try prepareContactsAccess(config: config)
        guard limit > 0 else { throw CLIError.invalidInput("Limit must be positive.") }
        let contacts = try fetchContactsFromAllowedContainers(allowedIds: allowedIds)
            .filter { contactMatchesQuery($0, query: query) }
        let result = contacts.prefix(limit).map { contactToDict($0, brief: true) }
        outputJSON(["success": true, "query": query, "contacts": Array(result), "count": result.count])
    }
}

struct GetContact: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "get",
        abstract: "Get full details for a contact"
    )

    @OptionGroup var pimOptions: PIMOptions

    @Option(name: .long, help: "Contact ID")
    var id: String

    func run() async throws {
        outputJSON(try result(config: pimOptions.loadConfig()))
    }

    // A native companion reuses this operation in its own app identity without
    // loading an ambient profile or terminating before writing job completion.
    func result(config: PIMConfiguration) throws -> [String: Any] {
        let allowedIds = try prepareContactsAccess(config: config)
        let found = try fetchScopedContact(id: id, allowedIds: allowedIds)
        var result = contactToDict(found.contact, brief: false)
        result["sourceContainerId"] = found.containerId
        return ["success": true, "contact": result]
    }
}

struct CreateContact: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "create",
        abstract: "Create a new contact"
    )

    @OptionGroup var pimOptions: PIMOptions

    @Option(name: .long, help: "Explicit target container/account stable ID (required)")
    var container: String?

    // Name fields
    @Option(name: .long, help: "First name")
    var firstName: String?

    @Option(name: .long, help: "Last name")
    var lastName: String?

    @Option(name: .long, help: "Full name (alternative to first/last)")
    var name: String?

    @Option(name: .long, help: "Middle name")
    var middleName: String?

    @Option(name: .long, help: "Name prefix (e.g. Dr., Mr.)")
    var namePrefix: String?

    @Option(name: .long, help: "Name suffix (e.g. Jr., III)")
    var nameSuffix: String?

    @Option(name: .long, help: "Nickname")
    var nickname: String?

    @Option(name: .long, help: "Previous family name (maiden name)")
    var previousFamilyName: String?

    // Phonetic names
    @Option(name: .long, help: "Phonetic first name")
    var phoneticGivenName: String?

    @Option(name: .long, help: "Phonetic middle name")
    var phoneticMiddleName: String?

    @Option(name: .long, help: "Phonetic last name")
    var phoneticFamilyName: String?

    @Option(name: .long, help: "Phonetic organization name")
    var phoneticOrganizationName: String?

    // Organization
    @Option(name: .long, help: "Organization/company name")
    var organization: String?

    @Option(name: .long, help: "Job title")
    var jobTitle: String?

    @Option(name: .long, help: "Department name")
    var department: String?

    // Contact type
    @Option(name: .long, help: "Contact type: person or organization")
    var contactType: String?

    // Simple communication (backward compatible)
    @Option(name: .long, help: "Email address (simple, uses 'work' label)")
    var email: String?

    @Option(name: .long, help: "Phone number (simple, uses 'main' label)")
    var phone: String?

    // Rich labeled arrays (JSON)
    @Option(name: .long, help: "Emails as JSON array: [{\"label\":\"work\",\"value\":\"user@example.com\"}]")
    var emails: String?

    @Option(name: .long, help: "Phones as JSON array: [{\"label\":\"mobile\",\"value\":\"555-0100\"}]")
    var phones: String?

    @Option(name: .long, help: "Addresses as JSON array: [{\"label\":\"home\",\"street\":\"...\",\"city\":\"...\",\"state\":\"...\",\"postalCode\":\"...\",\"country\":\"...\"}]")
    var addresses: String?

    @Option(name: .long, help: "URLs as JSON array: [{\"label\":\"homepage\",\"value\":\"https://...\"}]")
    var urls: String?

    @Option(name: .long, help: "Social profiles as JSON array: [{\"service\":\"Twitter\",\"username\":\"...\",\"url\":\"...\"}]")
    var socialProfiles: String?

    @Option(name: .long, help: "Instant messages as JSON array: [{\"service\":\"Skype\",\"username\":\"...\"}]")
    var instantMessages: String?

    @Option(name: .long, help: "Relations as JSON array: [{\"label\":\"spouse\",\"name\":\"...\"}]")
    var relations: String?

    // Dates
    @Option(name: .long, help: "Birthday (YYYY-MM-DD or MM-DD)")
    var birthday: String?

    @Option(name: .long, help: "Dates as JSON array: [{\"label\":\"anniversary\",\"month\":6,\"day\":15,\"year\":2020}]")
    var dates: String?

    // Notes
    @Option(name: .long, help: "Notes")
    var notes: String?

    func run() async throws {
        outputJSON(try result(config: pimOptions.loadConfig()))
    }

    func result(config: PIMConfiguration) throws -> [String: Any] {
        let configuredIds = try allowedContactContainerIdentifiers(config: config)
        let targetContainerId = try validateContactDestination(id: container, allowedIds: configuredIds)
        let allowedIds = try prepareContactsAccess(config: config, writing: true)
        guard try filteredContainers(allowedIds: allowedIds).contains(where: { $0.identifier == targetContainerId }) else {
            throw CLIError.notFound("Configured target container is unavailable.")
        }

        let contact = CNMutableContact()

        // Name
        if let fullName = name {
            let parts = fullName.split(separator: " ")
            if parts.count == 1 {
                contact.givenName = String(parts[0])
            } else if parts.count >= 2 {
                contact.givenName = String(parts[0])
                contact.familyName = parts.dropFirst().joined(separator: " ")
            }
        } else {
            if let first = firstName { contact.givenName = first }
            if let last = lastName { contact.familyName = last }
        }

        if let v = middleName { contact.middleName = v }
        if let v = namePrefix { contact.namePrefix = v }
        if let v = nameSuffix { contact.nameSuffix = v }
        if let v = nickname { contact.nickname = v }
        if let v = previousFamilyName { contact.previousFamilyName = v }

        // Phonetic
        if let v = phoneticGivenName { contact.phoneticGivenName = v }
        if let v = phoneticMiddleName { contact.phoneticMiddleName = v }
        if let v = phoneticFamilyName { contact.phoneticFamilyName = v }
        if let v = phoneticOrganizationName { contact.phoneticOrganizationName = v }

        // Organization
        if let org = organization { contact.organizationName = org }
        if let title = jobTitle { contact.jobTitle = title }
        if let dept = department { contact.departmentName = dept }

        // Contact type
        if let ct = contactType?.lowercased() {
            contact.contactType = ct == "organization" ? .organization : .person
        }

        // Emails (JSON array takes priority over simple --email)
        if let emailsJSON = emails {
            contact.emailAddresses = try parseEmails(emailsJSON)
        } else if let emailAddr = email {
            contact.emailAddresses = [CNLabeledValue(label: CNLabelWork, value: emailAddr as NSString)]
        }

        // Phones (JSON array takes priority over simple --phone)
        if let phonesJSON = phones {
            contact.phoneNumbers = try parsePhones(phonesJSON)
        } else if let phoneNum = phone {
            contact.phoneNumbers = [CNLabeledValue(label: CNLabelPhoneNumberMain, value: CNPhoneNumber(stringValue: phoneNum))]
        }

        // Structured arrays
        if let json = addresses { contact.postalAddresses = try parseAddresses(json) }
        if let json = urls { contact.urlAddresses = try parseURLs(json) }
        if let json = socialProfiles { contact.socialProfiles = try parseSocialProfiles(json) }
        if let json = instantMessages { contact.instantMessageAddresses = try parseInstantMessages(json) }
        if let json = relations { contact.contactRelations = try parseRelations(json) }
        if let json = dates { contact.dates = try parseDates(json) }

        // Birthday
        if let birthdayStr = birthday {
            contact.birthday = try parseBirthday(birthdayStr)
        }

        // Notes
        if let note = notes { contact.note = note }

        let saveRequest = CNSaveRequest()
        saveRequest.add(contact, toContainerWithIdentifier: targetContainerId)
        try contactStore.execute(saveRequest)

        return [
            "success": true,
            "message": "Contact created successfully",
            "contact": contactToDict(contact, brief: false)
        ]
    }
}

struct UpdateContact: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "update",
        abstract: "Update an existing contact"
    )

    @OptionGroup var pimOptions: PIMOptions

    @Option(name: .long, help: "Contact ID to update")
    var id: String

    // Name fields
    @Option(name: .long, help: "New first name")
    var firstName: String?

    @Option(name: .long, help: "New last name")
    var lastName: String?

    @Option(name: .long, help: "New middle name")
    var middleName: String?

    @Option(name: .long, help: "New name prefix (e.g. Dr., Mr.)")
    var namePrefix: String?

    @Option(name: .long, help: "New name suffix (e.g. Jr., III)")
    var nameSuffix: String?

    @Option(name: .long, help: "New nickname")
    var nickname: String?

    @Option(name: .long, help: "New previous family name (maiden name)")
    var previousFamilyName: String?

    // Phonetic names
    @Option(name: .long, help: "New phonetic first name")
    var phoneticGivenName: String?

    @Option(name: .long, help: "New phonetic middle name")
    var phoneticMiddleName: String?

    @Option(name: .long, help: "New phonetic last name")
    var phoneticFamilyName: String?

    @Option(name: .long, help: "New phonetic organization name")
    var phoneticOrganizationName: String?

    // Organization
    @Option(name: .long, help: "New organization")
    var organization: String?

    @Option(name: .long, help: "New job title")
    var jobTitle: String?

    @Option(name: .long, help: "New department name")
    var department: String?

    // Contact type
    @Option(name: .long, help: "Contact type: person or organization")
    var contactType: String?

    // Simple communication (backward compatible - replaces primary)
    @Option(name: .long, help: "New email (replaces primary)")
    var email: String?

    @Option(name: .long, help: "New phone (replaces primary)")
    var phone: String?

    // Rich labeled arrays (JSON - replaces ALL entries)
    @Option(name: .long, help: "Replace all emails: [{\"label\":\"work\",\"value\":\"user@example.com\"}]")
    var emails: String?

    @Option(name: .long, help: "Replace all phones: [{\"label\":\"mobile\",\"value\":\"555-0100\"}]")
    var phones: String?

    @Option(name: .long, help: "Replace all addresses: [{\"label\":\"home\",\"street\":\"...\",\"city\":\"...\",\"state\":\"...\",\"postalCode\":\"...\",\"country\":\"...\"}]")
    var addresses: String?

    @Option(name: .long, help: "Replace all URLs: [{\"label\":\"homepage\",\"value\":\"https://...\"}]")
    var urls: String?

    @Option(name: .long, help: "Replace all social profiles: [{\"service\":\"Twitter\",\"username\":\"...\",\"url\":\"...\"}]")
    var socialProfiles: String?

    @Option(name: .long, help: "Replace all instant messages: [{\"service\":\"Skype\",\"username\":\"...\"}]")
    var instantMessages: String?

    @Option(name: .long, help: "Replace all relations: [{\"label\":\"spouse\",\"name\":\"...\"}]")
    var relations: String?

    // Dates
    @Option(name: .long, help: "New birthday (YYYY-MM-DD or MM-DD)")
    var birthday: String?

    @Option(name: .long, help: "Replace all dates: [{\"label\":\"anniversary\",\"month\":6,\"day\":15,\"year\":2020}]")
    var dates: String?

    // Notes
    @Option(name: .long, help: "New notes")
    var notes: String?

    func run() async throws {
        outputJSON(try result(config: pimOptions.loadConfig()))
    }

    func result(config: PIMConfiguration) throws -> [String: Any] {
        let allowedIds = try prepareContactsAccess(config: config, writing: true)
        let existing = try fetchScopedContact(id: id, allowedIds: allowedIds)
        let contact = existing.contact.mutableCopy() as! CNMutableContact
        try applyContactMutations(to: contact)
        let request = CNSaveRequest()
        request.update(contact)
        // A failed save is returned to the caller. Retrying or silently routing
        // through Contacts.app can partly apply changes and request Automation.
        try contactStore.execute(request)
        return [
            "success": true,
            "message": "Contact updated successfully",
            "contact": contactToDict(contact, brief: false)
        ]
    }

    private func applyContactMutations(
        to contact: CNMutableContact,
        skipCommunications: Bool = false
    ) throws {
        // Name fields
        if let first = firstName { contact.givenName = first }
        if let last = lastName { contact.familyName = last }
        if let v = middleName { contact.middleName = v }
        if let v = namePrefix { contact.namePrefix = v }
        if let v = nameSuffix { contact.nameSuffix = v }
        if let v = nickname { contact.nickname = v }
        if let v = previousFamilyName { contact.previousFamilyName = v }

        // Phonetic
        if let v = phoneticGivenName { contact.phoneticGivenName = v }
        if let v = phoneticMiddleName { contact.phoneticMiddleName = v }
        if let v = phoneticFamilyName { contact.phoneticFamilyName = v }
        if let v = phoneticOrganizationName { contact.phoneticOrganizationName = v }

        // Organization
        if let org = organization { contact.organizationName = org }
        if let title = jobTitle { contact.jobTitle = title }
        if let dept = department { contact.departmentName = dept }

        // Contact type
        if let ct = contactType?.lowercased() {
            contact.contactType = ct == "organization" ? .organization : .person
        }

        if skipCommunications {
            try applyNonCommunicationMutations(to: contact)
            return
        }
        try applyCommunicationMutations(to: contact)
        try applyNonCommunicationMutations(to: contact)
    }

    private func applyCommunicationMutations(to contact: CNMutableContact) throws {
        // Emails (JSON array replaces all; simple --email replaces primary).
        // Existing CNLabeledValue instances are reused for unchanged values so
        // their identifiers survive — see mergeLabeledStrings for why.
        if let emailsJSON = emails {
            contact.emailAddresses = mergeLabeledStrings(
                existing: contact.emailAddresses,
                desired: try parseEmails(emailsJSON)
            )
        } else if let emailAddr = email {
            if contact.emailAddresses.isEmpty {
                contact.emailAddresses = [CNLabeledValue(label: CNLabelWork, value: emailAddr as NSString)]
            } else {
                contact.emailAddresses[0] = contact.emailAddresses[0].settingValue(emailAddr as NSString)
            }
        }

        // Phones (JSON array replaces all; simple --phone replaces primary)
        if let phonesJSON = phones {
            contact.phoneNumbers = mergeLabeledPhones(
                existing: contact.phoneNumbers,
                desired: try parsePhones(phonesJSON)
            )
        } else if let phoneNum = phone {
            if contact.phoneNumbers.isEmpty {
                contact.phoneNumbers = [CNLabeledValue(label: CNLabelPhoneNumberMain, value: CNPhoneNumber(stringValue: phoneNum))]
            } else {
                contact.phoneNumbers[0] = contact.phoneNumbers[0].settingValue(CNPhoneNumber(stringValue: phoneNum))
            }
        }

    }

    private func applyNonCommunicationMutations(to contact: CNMutableContact) throws {
        // Structured arrays (replace all when provided)
        if let json = addresses { contact.postalAddresses = try parseAddresses(json) }
        if let json = urls { contact.urlAddresses = try parseURLs(json) }
        if let json = socialProfiles { contact.socialProfiles = try parseSocialProfiles(json) }
        if let json = instantMessages { contact.instantMessageAddresses = try parseInstantMessages(json) }
        if let json = relations { contact.contactRelations = try parseRelations(json) }
        if let json = dates { contact.dates = try parseDates(json) }

        // Birthday
        if let birthdayStr = birthday {
            contact.birthday = try parseBirthday(birthdayStr)
        }

        // Notes (guarded: macOS may restrict note access via TCC)
        if let note = notes {
            if contact.isKeyAvailable(CNContactNoteKey) {
                contact.note = note
            } else {
                fputs("Warning: Cannot set notes — this binary lacks the com.apple.developer.contacts.notes entitlement, which macOS requires for Contacts note access.\n", stderr)
            }
        }
    }
}

struct DeleteContact: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "delete",
        abstract: "Delete a contact"
    )

    @OptionGroup var pimOptions: PIMOptions

    @Option(name: .long, help: "Contact ID to delete")
    var id: String

    func run() async throws {
        let config = pimOptions.loadConfig()
        let allowedIds = try prepareContactsAccess(config: config, writing: true, deleting: true)
        let existing = try fetchScopedContact(id: id, allowedIds: allowedIds)
        let contactInfo = contactToDict(existing.contact, brief: true)
        let contact = existing.contact.mutableCopy() as! CNMutableContact
        let request = CNSaveRequest()
        request.delete(contact)
        try contactStore.execute(request)
        outputJSON([
            "success": true,
            "message": "Contact deleted successfully",
            "deletedContact": contactInfo
        ])
    }
}

// MARK: - Config Command

struct ConfigCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "config",
        abstract: "Manage PIM configuration",
        subcommands: [ConfigShow.self]
    )
}

struct ConfigShow: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "show",
        abstract: "Display the resolved configuration (base + profile)"
    )

    @OptionGroup var pimOptions: PIMOptions

    func run() throws {
        let config = pimOptions.loadConfig()
        let ctx = pimOptions.outputContext
        let activeProfile = pimOptions.profile ?? ProcessInfo.processInfo.environment["APPLE_PIM_PROFILE"]

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(config)

        pimOutput(
            [
                "success": true,
                "configPath": ConfigLoader.defaultConfigPath.path,
                "profilesDir": ConfigLoader.profilesDir.path,
                "activeProfile": activeProfile as Any,
                "config": (try? JSONSerialization.jsonObject(with: data)) ?? [:]
            ],
            text: ConfigFormatter.formatConfigShow(
                config: config,
                configPath: ConfigLoader.defaultConfigPath.path,
                profilesDir: ConfigLoader.profilesDir.path,
                activeProfile: activeProfile
            ),
            context: ctx
        )
    }
}
