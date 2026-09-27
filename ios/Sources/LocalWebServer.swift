import Foundation
import Network

/// App 自带的极简 HTTP 静态服务器：只服务打包进来的 web 资源，只监听回环地址。
///
/// 为什么必须这么做（而不是直接加载本地文件）：
/// - 浏览器只在**安全上下文**下提供加密接口（`crypto.subtle`）。`file://` 不算，
///   `http://localhost` / `http://127.0.0.1` 算。数据要靠它加密，所以必须有这个本地服务；
/// - 页面来源固定在 127.0.0.1，浏览器的本地数据库（IndexedDB）才有稳定归属，
///   升级 App 不会丢数据。
///
/// 只监听 loopback，外部设备无法访问；不做 keep-alive，静态资源场景足够。
final class LocalWebServer {

    static let shared = LocalWebServer()

    private let queue = DispatchQueue(label: "com.lifebook.webserver", qos: .userInitiated)
    private var listener: NWListener?
    private var webRoot: URL?
    private var boundPort: UInt16 = 0
    private let lock = NSLock()

    private init() {}

    /// 启动服务并返回端口。重复调用会直接返回已绑定的端口。
    func start() throws -> UInt16 {
        lock.lock()
        defer { lock.unlock() }
        if boundPort > 0 { return boundPort }

        guard let root = Bundle.main.url(forResource: "web", withExtension: nil) else {
            throw NSError(
                domain: "LifeBook",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "App 内置页面缺失，请重新安装"]
            )
        }
        webRoot = root

        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        params.acceptLocalOnly = true          // 只接受本机连接
        params.requiredInterfaceType = .loopback

        let listener = try NWListener(using: params, on: .any)
        self.listener = listener

        let semaphore = DispatchSemaphore(value: 0)
        var startError: Error?

        listener.stateUpdateHandler = { state in
            switch state {
            case .ready:
                semaphore.signal()
            case .failed(let error):
                startError = error
                semaphore.signal()
            default:
                break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }
        listener.start(queue: queue)

        // 端口是系统分配的，必须等 ready 才能拿到
        if semaphore.wait(timeout: .now() + 5) == .timedOut {
            listener.cancel()
            self.listener = nil
            throw NSError(
                domain: "LifeBook",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "本机服务启动超时"]
            )
        }
        if let error = startError {
            listener.cancel()
            self.listener = nil
            throw error
        }
        guard let port = listener.port?.rawValue else {
            throw NSError(
                domain: "LifeBook",
                code: 3,
                userInfo: [NSLocalizedDescriptionKey: "无法获取本机服务端口"]
            )
        }
        boundPort = port
        return port
    }

    func stop() {
        lock.lock()
        defer { lock.unlock() }
        listener?.cancel()
        listener = nil
        boundPort = 0
    }

    // MARK: - 连接处理

    private func accept(_ connection: NWConnection) {
        connection.start(queue: queue)
        readRequest(connection, buffer: Data())
    }

    private func readRequest(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) {
            [weak self] data, _, isComplete, error in
            guard let self = self else { connection.cancel(); return }
            var accumulated = buffer
            if let data = data { accumulated.append(data) }

            if let headerEnd = accumulated.range(of: Data("\r\n\r\n".utf8)) {
                let head = String(decoding: accumulated[..<headerEnd.lowerBound], as: UTF8.self)
                self.respond(connection, requestHead: head)
                return
            }
            if isComplete || error != nil || accumulated.count > 512 * 1024 {
                connection.cancel()
                return
            }
            self.readRequest(connection, buffer: accumulated)
        }
    }

    private func respond(_ connection: NWConnection, requestHead: String) {
        let lines = requestHead.components(separatedBy: "\r\n")
        let requestLine = lines.first ?? ""
        let parts = requestLine.split(separator: " ").map(String.init)
        let method = parts.count > 0 ? parts[0] : "GET"
        var path = parts.count > 1 ? parts[1] : "/"

        if let q = path.firstIndex(of: "?") { path = String(path[..<q]) }
        path = path.removingPercentEncoding ?? path

        guard method == "GET" || method == "HEAD" else {
            send(connection, status: "405 Method Not Allowed",
                 body: Data("Method Not Allowed".utf8), type: "text/plain; charset=utf-8")
            return
        }
        if path.contains("..") {
            send(connection, status: "400 Bad Request",
                 body: Data("Bad Request".utf8), type: "text/plain; charset=utf-8")
            return
        }
        if path == "/" || path.isEmpty { path = "/index.html" }

        guard let root = webRoot else {
            send(connection, status: "500 Internal Server Error",
                 body: Data("No web root".utf8), type: "text/plain; charset=utf-8")
            return
        }

        let fileURL = root.appendingPathComponent(String(path.dropFirst()))
        guard let data = try? Data(contentsOf: fileURL) else {
            send(connection, status: "404 Not Found",
                 body: Data("Not Found".utf8), type: "text/plain; charset=utf-8")
            return
        }
        // no-store：保证 App 升级后立刻用上新脚本，不会命中旧缓存
        send(connection, status: "200 OK", body: data,
             type: Self.mimeType(for: path), cacheControl: "no-store")
    }

    private func send(
        _ connection: NWConnection,
        status: String,
        body: Data,
        type: String,
        cacheControl: String = "no-store"
    ) {
        var header = "HTTP/1.1 \(status)\r\n"
        header += "Content-Type: \(type)\r\n"
        header += "Content-Length: \(body.count)\r\n"
        header += "Cache-Control: \(cacheControl)\r\n"
        header += "X-Content-Type-Options: nosniff\r\n"
        header += "Connection: close\r\n\r\n"

        var payload = Data(header.utf8)
        payload.append(body)

        connection.send(content: payload, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    private static func mimeType(for path: String) -> String {
        let ext = (path as NSString).pathExtension.lowercased()
        switch ext {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "webmanifest": return "application/manifest+json; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "ico": return "image/x-icon"
        case "woff2": return "font/woff2"
        case "txt": return "text/plain; charset=utf-8"
        default: return "application/octet-stream"
        }
    }
}
