import Foundation

/// 服务器地址等轻量配置。只存本机，不上传任何地方。
final class AppSettings: ObservableObject {
    private enum Keys {
        static let serverAddress = "lifebook.serverAddress"
    }

    @Published var serverAddress: String {
        didSet {
            UserDefaults.standard.set(serverAddress, forKey: Keys.serverAddress)
            normalizedAddress = Self.normalize(serverAddress)
        }
    }

    /// 规范化后的地址：补全 scheme、去掉尾部斜杠，供 WebView 直接使用。
    @Published private(set) var normalizedAddress: String

    var isConfigured: Bool { !normalizedAddress.isEmpty }

    init() {
        let saved = UserDefaults.standard.string(forKey: Keys.serverAddress) ?? ""
        serverAddress = saved
        normalizedAddress = Self.normalize(saved)
    }

    /// 容错处理：允许只填 `192.168.1.23:8686` 这种形式。
    static func normalize(_ raw: String) -> String {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return "" }
        let lower = text.lowercased()
        if !lower.hasPrefix("http://") && !lower.hasPrefix("https://") {
            text = "http://" + text
        }
        while text.hasSuffix("/") { text.removeLast() }
        return text
    }

    func save(_ value: String) {
        serverAddress = value
    }

    func forget() {
        UserDefaults.standard.removeObject(forKey: Keys.serverAddress)
        serverAddress = ""
        normalizedAddress = ""
    }
}
