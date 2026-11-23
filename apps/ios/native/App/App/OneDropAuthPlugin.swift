import AuthenticationServices
import Capacitor
import CryptoKit
import Security

@objc(OneDropAuthPlugin)
final class OneDropAuthPlugin: CAPPlugin, CAPBridgedPlugin, ASWebAuthenticationPresentationContextProviding {
    let identifier = "OneDropAuthPlugin"
    let jsName = "OneDropAuth"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "listAccounts", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "switchAccount", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeAccount", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resetAuthorization", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prepareSignIn", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "commitSignIn", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "discardSignIn", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signIn", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getAccessToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signOut", returnType: CAPPluginReturnPromise)
    ]

    private let keychainService = Bundle.main.object(forInfoDictionaryKey: "OneDropAuthKeychainService") as? String ?? "com.sycamore.onedrop.microsoft-auth"
    private let keychainAccount = "primary"
    private let expirySkew: TimeInterval = 60
    private var authenticationSession: ASWebAuthenticationSession?
    private var generation = 0
    private var signingIn = false
    private var authorizationAttempt: String?
    private var candidate: (id: String, generation: Int, activeKey: String?, expected: String?, token: StoredToken)?
    private var refreshTasks: [String: (Int, Task<StoredToken, Error>)] = [:]

    @objc func status(_ call: CAPPluginCall) {
        perform(call) {
            let generation = self.generation
            guard let token = try self.readToken() else {
                return self.signedOutResult()
            }

            do {
                let usable = try await self.usableToken(token)
                return self.signedInResult(usable)
            } catch AuthError.signInRequired {
                guard generation == self.generation else { throw AuthError.sessionChanged }
                var accounts = try self.readAccounts()
                accounts.required[self.accountKey(token)] = true
                try self.storeAccounts(accounts)
                return self.signedInResult(token)
            } catch {
                guard generation == self.generation else { throw AuthError.sessionChanged }
                return self.signedInResult(token)
            }
        }
    }

    @objc func prepareSignIn(_ call: CAPPluginCall) { authorize(call, deferred: true) }
    @objc func signIn(_ call: CAPPluginCall) { authorize(call, deferred: false) }

    private func authorize(_ call: CAPPluginCall, deferred: Bool) {
        perform(call) {
            guard !self.signingIn, self.candidate == nil else { throw AuthError.sessionChanged }
            guard let id = deferred ? call.getString("attemptId") : UUID().uuidString, !id.isEmpty else { throw AuthError.sessionChanged }
            let generation = self.generation
            let activeKey = try self.readAccounts().activeKey
            self.signingIn = true
            self.authorizationAttempt = id
            defer { if self.authorizationAttempt == id { self.signingIn = false } }
            do {
                let token = try await self.acquireToken(configuration: self.configuration(from: call), attempt: id)
                guard self.authorizationAttempt == id, generation == self.generation,
                      try self.readAccounts().activeKey == activeKey else { throw AuthError.sessionChanged }
                self.candidate = (id, generation, activeKey, call.getString("reauthenticateKey"), token)
                if deferred { return ["candidateId": id] }
                return try self.commitCandidate(id)
            } catch {
                if self.authorizationAttempt == id {
                    self.candidate = nil
                    self.authorizationAttempt = nil
                    self.signingIn = false
                }
                throw error
            }
        }
    }
    @MainActor private func commitCandidate(_ id: String) throws -> [String: Any] {
        guard let candidate, candidate.id == id, authorizationAttempt == id,
              candidate.generation == generation else { throw AuthError.sessionChanged }
        var accounts = try readAccounts()
        guard accounts.activeKey == candidate.activeKey else { throw AuthError.sessionChanged }
        let key = accountKey(candidate.token)
        guard !key.isEmpty, candidate.expected == nil || candidate.expected == key else { throw AuthError.microsoft("Sign in with the selected Microsoft account.") }
        guard accounts.tokens[key] != nil || accounts.tokens.count < 3 else { throw AuthError.microsoft("You can keep up to three accounts.") }
        accounts.tokens[key] = candidate.token
        accounts.activeKey = key
        accounts.lastUsed[key] = Date().timeIntervalSince1970 * 1000
        accounts.required[key] = false
        try storeAccounts(accounts)
        generation += 1
        self.candidate = nil
        authorizationAttempt = nil
        signingIn = false
        return signedInResult(candidate.token)
    }
    @objc func commitSignIn(_ call: CAPPluginCall) {
        perform(call) { try self.commitCandidate(call.getString("candidateId") ?? "") }
    }
    @objc func resetAuthorization(_ call: CAPPluginCall) {
        perform(call) {
            self.candidate = nil
            self.authorizationAttempt = nil
            self.signingIn = false
            self.authenticationSession?.cancel()
            return [:]
        }
    }
    @objc func discardSignIn(_ call: CAPPluginCall) {
        perform(call) {
            if self.authorizationAttempt == call.getString("attemptId") {
                self.candidate = nil
                self.authorizationAttempt = nil
                self.signingIn = false
                self.authenticationSession?.cancel()
            }
            return [:]
        }
    }

    @objc func getAccessToken(_ call: CAPPluginCall) {
        perform(call) {
            guard let stored = try self.readToken() else {
                throw AuthError.signInRequired
            }
            let token = try await self.usableToken(stored)
            return ["accessToken": token.accessToken, "accountKey": self.accountKey(token)]
        }
    }

    @objc func signOut(_ call: CAPPluginCall) {
        perform(call) {
            if let key = try self.readAccounts().activeKey { try self.forgetAccount(key) }
            return try self.readToken().map { self.signedInResult($0) } ?? self.signedOutResult()
        }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        if let window = bridge?.viewController?.view.window {
            return window
        }
        return ASPresentationAnchor()
    }

    private func perform(_ call: CAPPluginCall, operation: @escaping @MainActor () async throws -> [String: Any]) {
        Task { @MainActor in
            do {
                let result = try await operation()
                call.resolve(result)
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    private func configuration(from call: CAPPluginCall) throws -> AuthConfiguration {
        guard let clientId = call.getString("clientId")?.trimmingCharacters(in: .whitespacesAndNewlines),
              !clientId.isEmpty else {
            throw AuthError.invalidConfiguration("Microsoft Entra Client ID is not configured.")
        }
        let authority = (call.getString("authority") ?? "https://login.microsoftonline.com/common")
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return AuthConfiguration(clientId: clientId, authority: authority)
    }

    @MainActor private func acquireToken(configuration: AuthConfiguration, attempt: String) async throws -> StoredToken {
        let verifier = randomBase64Url(byteCount: 32)
        let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64UrlEncoded
        let state = randomBase64Url(byteCount: 24)
        var components = URLComponents(string: "\(configuration.authority)/oauth2/v2.0/authorize")
        components?.queryItems = [
            URLQueryItem(name: "client_id", value: configuration.clientId),
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "redirect_uri", value: redirectUri),
            URLQueryItem(name: "response_mode", value: "query"),
            URLQueryItem(name: "scope", value: scopes),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "prompt", value: "select_account")
        ]
        guard let authorizationUrl = components?.url else {
            throw AuthError.invalidConfiguration("Microsoft authorization URL could not be created.")
        }

        let callback = try await authenticate(url: authorizationUrl, attempt: attempt)
        guard authorizationAttempt == attempt else { throw AuthError.sessionChanged }
        guard let callbackComponents = URLComponents(url: callback, resolvingAgainstBaseURL: false) else {
            throw AuthError.invalidCallback
        }
        let parameters = Dictionary(uniqueKeysWithValues: (callbackComponents.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        if let description = parameters["error_description"], !description.isEmpty {
            throw AuthError.microsoft(description)
        }
        guard parameters["state"] == state, let code = parameters["code"], !code.isEmpty else {
            throw AuthError.invalidCallback
        }

        let response = try await requestToken(
            configuration: configuration,
            parameters: [
                "client_id": configuration.clientId,
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": redirectUri,
                "code_verifier": verifier,
                "scope": scopes
            ]
        )
        return response.stored(previousRefreshToken: nil, previousIdToken: nil)
    }

    @MainActor private func authenticate(url: URL, attempt: String) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            do {
                guard self.authorizationAttempt == attempt else { continuation.resume(throwing: AuthError.sessionChanged); return }
                let session = ASWebAuthenticationSession(
                    url: url,
                    callbackURLScheme: self.callbackScheme
                ) { callback, error in
                    if self.authorizationAttempt == attempt { self.authenticationSession = nil }
                    if let callback {
                        continuation.resume(returning: callback)
                    } else if let error {
                        continuation.resume(throwing: error)
                    } else {
                        continuation.resume(throwing: AuthError.invalidCallback)
                    }
                }
                session.presentationContextProvider = self
                session.prefersEphemeralWebBrowserSession = false
                self.authenticationSession = session
                if !session.start() {
                    self.authenticationSession = nil
                    continuation.resume(throwing: AuthError.couldNotStartSession)
                }
            }
        }
    }

    @MainActor private func usableToken(_ token: StoredToken) async throws -> StoredToken {
        let generation = self.generation
        if token.expiresAt > Date().addingTimeInterval(expirySkew) {
            return token
        }
        let key = accountKey(token)
        if try readAccounts().required[key] == true { throw AuthError.signInRequired }
        if let (ownerGeneration, task) = refreshTasks[key], ownerGeneration == generation { return try await task.value }
        let task = Task { @MainActor in try await self.refreshStoredToken(token, generation: generation) }
        refreshTasks[key] = (generation, task)
        defer { if refreshTasks[key]?.0 == generation { refreshTasks.removeValue(forKey: key) } }
        return try await task.value
    }

    @MainActor private func refreshStoredToken(_ token: StoredToken, generation: Int) async throws -> StoredToken {
        guard let refreshToken = token.refreshToken else {
            throw AuthError.signInRequired
        }

        do {
            let configuration = AuthConfiguration(clientId: token.clientId, authority: token.authority)
            let response = try await requestToken(
                configuration: configuration,
                parameters: [
                    "client_id": token.clientId,
                    "grant_type": "refresh_token",
                    "refresh_token": refreshToken,
                    "scope": scopes
                ]
            )
            let refreshed = response.stored(
                previousRefreshToken: refreshToken,
                previousIdToken: token.idToken,
                configuration: configuration
            )
            guard generation == self.generation else { throw AuthError.sessionChanged }
            guard accountKey(refreshed) == accountKey(token) else { throw AuthError.sessionChanged }
            try storeToken(refreshed)
            return refreshed
        } catch let error as TokenEndpointError where error.requiresSignIn {
            throw AuthError.signInRequired
        }
    }

    private func requestToken(configuration: AuthConfiguration, parameters: [String: String]) async throws -> TokenResponse {
        guard let url = URL(string: "\(configuration.authority)/oauth2/v2.0/token") else {
            throw AuthError.invalidConfiguration("Microsoft token URL could not be created.")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = parameters
            .map { key, value in
                "\(formEncode(key))=\(formEncode(value))"
            }
            .sorted()
            .joined(separator: "&")
            .data(using: .utf8)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw AuthError.invalidTokenResponse
        }
        if !(200...299).contains(http.statusCode) {
            let endpointError = (try? JSONDecoder().decode(TokenEndpointError.self, from: data))
                ?? TokenEndpointError(error: "unknown_error", errorDescription: "Microsoft returned an invalid token response.")
            throw endpointError
        }
        do {
            var token = try JSONDecoder().decode(TokenResponse.self, from: data)
            token.clientId = configuration.clientId
            token.authority = configuration.authority
            return token
        } catch {
            throw AuthError.invalidTokenResponse
        }
    }

    @objc func listAccounts(_ call: CAPPluginCall) {
        perform(call) {
            let accounts = try self.readAccounts()
            let rows: [[String: Any]] = accounts.tokens.map { key, token in
                let claims = self.idTokenClaims(token.idToken)
                return ["key": key, "displayName": claims["name"] as? String ?? "", "username": claims["preferred_username"] as? String ?? "", "lastUsedAt": accounts.lastUsed[key] ?? 0, "signInRequired": accounts.required[key] ?? false]
            }
            var result: [String: Any] = ["accounts": rows]
            if let key = accounts.activeKey { result["activeKey"] = key }
            return result
        }
    }
    @objc func switchAccount(_ call: CAPPluginCall) {
        perform(call) {
            var accounts = try self.readAccounts()
            guard let key = call.getString("accountKey"), let token = accounts.tokens[key] else { throw AuthError.signInRequired }
            self.generation += 1
            self.candidate = nil
            self.authorizationAttempt = nil
            self.signingIn = false
            self.authenticationSession?.cancel()
            accounts.activeKey = key
            accounts.lastUsed[key] = Date().timeIntervalSince1970 * 1000
            try self.storeAccounts(accounts)
            return self.signedInResult(token)
        }
    }
    @objc func removeAccount(_ call: CAPPluginCall) {
        perform(call) {
            guard let key = call.getString("accountKey") else { throw AuthError.signInRequired }
            guard try self.readAccounts().activeKey != key else { throw AuthError.sessionChanged }
            try self.forgetAccount(key)
            return [:]
        }
    }
    @MainActor private func forgetAccount(_ key: String) throws {
        candidate = nil
        authorizationAttempt = nil
        signingIn = false
        authenticationSession?.cancel()
        var accounts = try readAccounts()
        let wasActive = accounts.activeKey == key
        accounts.tokens.removeValue(forKey: key)
        accounts.lastUsed.removeValue(forKey: key)
        accounts.required.removeValue(forKey: key)
        if wasActive { accounts.activeKey = accounts.tokens.keys.max { (accounts.lastUsed[$0] ?? 0) < (accounts.lastUsed[$1] ?? 0) } }
        try storeAccounts(accounts)
        if wasActive {
            generation += 1
            signingIn = false
            authenticationSession?.cancel()
        }
    }
    private func readToken() throws -> StoredToken? {
        let accounts = try readAccounts()
        return accounts.activeKey.flatMap { accounts.tokens[$0] }
    }
    private func storeToken(_ token: StoredToken) throws {
        var accounts = try readAccounts()
        let key = accountKey(token)
        guard accounts.tokens[key] != nil else { throw AuthError.sessionChanged }
        accounts.tokens[key] = token
        accounts.required[key] = false
        try storeAccounts(accounts)
    }
    private func readAccounts() throws -> AccountStore {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return AccountStore() }
        guard status == errSecSuccess, let data = result as? Data else {
            throw AuthError.keychain(status)
        }
        if let accounts = try? JSONDecoder().decode(AccountStore.self, from: data) { return accounts }
        let legacy = try JSONDecoder().decode(StoredToken.self, from: data)
        let key = accountKey(legacy)
        guard !key.isEmpty else { throw AuthError.invalidTokenResponse }
        return AccountStore(activeKey: key, tokens: [key: legacy], lastUsed: [key: Date().timeIntervalSince1970 * 1000])
    }

    private func storeAccounts(_ accounts: AccountStore) throws {
        let data = try JSONEncoder().encode(accounts)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        let updated = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updated == errSecItemNotFound {
            var addition = query
            addition.merge(attributes) { _, new in new }
            let status = SecItemAdd(addition as CFDictionary, nil)
            guard status == errSecSuccess else { throw AuthError.keychain(status) }
        } else if updated != errSecSuccess {
            throw AuthError.keychain(updated)
        }
    }

    private func signedOutResult() -> [String: Any] {
        ["state": "signed-out", "redirectUri": redirectUri]
    }

    private func accountKey(_ token: StoredToken) -> String {
        let claims = idTokenClaims(token.idToken)
        guard let issuer = claims["iss"] as? String, !issuer.isEmpty,
              let subject = claims["sub"] as? String, !subject.isEmpty,
              let data = try? JSONSerialization.data(withJSONObject: [issuer, subject], options: [.withoutEscapingSlashes]),
              let value = String(data: data, encoding: .utf8) else { return "" }
        return value
    }

    private func signedInResult(_ token: StoredToken) -> [String: Any] {
        let claims = idTokenClaims(token.idToken)
        return [
            "accountKey": accountKey(token),
            "state": "signed-in",
            "redirectUri": redirectUri,
            "expiresAt": ISO8601DateFormatter().string(from: token.expiresAt),
            "account": [
                "displayName": claims["name"] as? String ?? "",
                "username": claims["preferred_username"] as? String ?? ""
            ]
        ]
    }

    private func idTokenClaims(_ idToken: String?) -> [String: Any] {
        guard let payload = idToken?.split(separator: ".").dropFirst().first,
              let data = Data(base64UrlEncoded: String(payload)),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return [:]
        }
        return object
    }

    // Both guest apps use the redirect registered for this Entra client.
    private let callbackScheme = "msauth.com.sycamore.onedrop"

    private var redirectUri: String { "\(callbackScheme)://auth" }
    private var scopes: String {
        "openid profile offline_access https://graph.microsoft.com/Files.ReadWrite"
    }

    private func randomBase64Url(byteCount: Int) -> String {
        var bytes = [UInt8](repeating: 0, count: byteCount)
        let status = SecRandomCopyBytes(kSecRandomDefault, byteCount, &bytes)
        precondition(status == errSecSuccess)
        return Data(bytes).base64UrlEncoded
    }

    private func formEncode(_ value: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }
}

private struct AuthConfiguration {
    let clientId: String
    let authority: String
}

private struct StoredToken: Codable {
    let accessToken: String
    let refreshToken: String?
    let idToken: String?
    let expiresAt: Date
    let clientId: String
    let authority: String
}

private struct TokenResponse: Decodable {
    let accessToken: String
    let refreshToken: String?
    let idToken: String?
    let expiresIn: Double
    var clientId = ""
    var authority = ""

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
        case idToken = "id_token"
        case expiresIn = "expires_in"
    }

    func stored(
        previousRefreshToken: String?,
        previousIdToken: String?,
        configuration: AuthConfiguration? = nil
    ) -> StoredToken {
        StoredToken(
            accessToken: accessToken,
            refreshToken: refreshToken ?? previousRefreshToken,
            idToken: idToken ?? previousIdToken,
            expiresAt: Date().addingTimeInterval(expiresIn),
            clientId: configuration?.clientId ?? clientId,
            authority: configuration?.authority ?? authority
        )
    }
}

private struct TokenEndpointError: Error, Decodable {
    let error: String
    let errorDescription: String

    enum CodingKeys: String, CodingKey {
        case error
        case errorDescription = "error_description"
    }

    var requiresSignIn: Bool {
        error == "invalid_grant" || error == "interaction_required"
    }

    var localizedDescription: String { errorDescription }
}

private enum AuthError: LocalizedError {
    case couldNotStartSession
    case invalidCallback
    case invalidConfiguration(String)
    case invalidTokenResponse
    case keychain(OSStatus)
    case microsoft(String)
    case signInRequired
    case sessionChanged

    var errorDescription: String? {
        switch self {
        case .couldNotStartSession: "Microsoft sign-in could not be opened."
        case .invalidCallback: "Microsoft sign-in returned an invalid response."
        case let .invalidConfiguration(message): message
        case .invalidTokenResponse: "Microsoft returned an invalid token response."
        case let .keychain(status): "The secure session store failed (\(status))."
        case let .microsoft(message): message
        case .sessionChanged: "The Microsoft account changed. Try again."
        case .signInRequired: "Your Microsoft session ended. Sign in again to continue."
        }
    }
}

private extension Data {
    var base64UrlEncoded: String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    init?(base64UrlEncoded value: String) {
        var base64 = value
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        self.init(base64Encoded: base64)
    }
}

private struct AccountStore: Codable {
    var activeKey: String? = nil
    var tokens: [String: StoredToken] = [:]
    var lastUsed: [String: Double] = [:]
    var required: [String: Bool] = [:]
}
