import AuthenticationServices
import Capacitor
import CryptoKit
import Security

@objc(OneDropAuthPlugin)
final class OneDropAuthPlugin: CAPPlugin, CAPBridgedPlugin, ASWebAuthenticationPresentationContextProviding {
    let identifier = "OneDropAuthPlugin"
    let jsName = "OneDropAuth"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signIn", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getAccessToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signOut", returnType: CAPPluginReturnPromise)
    ]

    private let keychainService = "com.sycamore.onedrop.microsoft-auth"
    private let keychainAccount = "primary"
    private let expirySkew: TimeInterval = 60
    private var authenticationSession: ASWebAuthenticationSession?

    @objc func status(_ call: CAPPluginCall) {
        perform(call) {
            guard let token = try self.readToken() else {
                return self.signedOutResult()
            }

            do {
                let usable = try await self.usableToken(token)
                return self.signedInResult(usable)
            } catch AuthError.signInRequired {
                try self.removeToken()
                return self.signedOutResult()
            }
        }
    }

    @objc func signIn(_ call: CAPPluginCall) {
        perform(call) {
            let configuration = try self.configuration(from: call)
            let token = try await self.acquireToken(configuration: configuration)
            try self.storeToken(token)
            return self.signedInResult(token)
        }
    }

    @objc func getAccessToken(_ call: CAPPluginCall) {
        perform(call) {
            guard let stored = try self.readToken() else {
                throw AuthError.signInRequired
            }
            let token = try await self.usableToken(stored)
            return ["accessToken": token.accessToken]
        }
    }

    @objc func signOut(_ call: CAPPluginCall) {
        perform(call) {
            try self.removeToken()
            return self.signedOutResult()
        }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        if let window = bridge?.viewController?.view.window {
            return window
        }
        return ASPresentationAnchor()
    }

    private func perform(_ call: CAPPluginCall, operation: @escaping () async throws -> [String: Any]) {
        Task {
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

    private func acquireToken(configuration: AuthConfiguration) async throws -> StoredToken {
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

        let callback = try await authenticate(url: authorizationUrl)
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

    private func authenticate(url: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.main.async {
                let session = ASWebAuthenticationSession(
                    url: url,
                    callbackURLScheme: self.callbackScheme
                ) { callback, error in
                    self.authenticationSession = nil
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

    private func usableToken(_ token: StoredToken) async throws -> StoredToken {
        if token.expiresAt > Date().addingTimeInterval(expirySkew) {
            return token
        }
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

    private func readToken() throws -> StoredToken? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw AuthError.keychain(status)
        }
        return try JSONDecoder().decode(StoredToken.self, from: data)
    }

    private func storeToken(_ token: StoredToken) throws {
        let data = try JSONEncoder().encode(token)
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

    private func removeToken() throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount
        ]
        let status = SecItemDelete(query as CFDictionary)
        if status != errSecSuccess && status != errSecItemNotFound {
            throw AuthError.keychain(status)
        }
    }

    private func signedOutResult() -> [String: Any] {
        ["state": "signed-out", "redirectUri": redirectUri]
    }

    private func signedInResult(_ token: StoredToken) -> [String: Any] {
        let claims = idTokenClaims(token.idToken)
        return [
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

    private var callbackScheme: String {
        "msauth.\(Bundle.main.bundleIdentifier ?? "com.sycamore.onedrop")"
    }

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

    var errorDescription: String? {
        switch self {
        case .couldNotStartSession: "Microsoft sign-in could not be opened."
        case .invalidCallback: "Microsoft sign-in returned an invalid response."
        case let .invalidConfiguration(message): message
        case .invalidTokenResponse: "Microsoft returned an invalid token response."
        case let .keychain(status): "The secure session store failed (\(status))."
        case let .microsoft(message): message
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
