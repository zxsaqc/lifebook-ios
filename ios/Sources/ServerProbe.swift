import Foundation

/// 连通性探测：只打 `/health`，用来在保存地址前给出即时反馈。
enum ServerProbe {
    enum ProbeError: LocalizedError {
        case badAddress
        case httpStatus(Int)

        var errorDescription: String? {
            switch self {
            case .badAddress:
                return "地址格式不对，形如 http://192.168.1.23:8686"
            case .httpStatus(let code):
                return "服务返回了 HTTP \(code)，地址可能不是 LifeBook"
            }
        }
    }

    static func check(_ address: String, completion: @escaping (Result<String, Error>) -> Void) {
        let base = AppSettings.normalize(address)
        guard let url = URL(string: base + "/health") else {
            completion(.failure(ProbeError.badAddress))
            return
        }
        var request = URLRequest(
            url: url,
            cachePolicy: .reloadIgnoringLocalAndRemoteCacheData,
            timeoutInterval: 8
        )
        request.httpMethod = "GET"

        URLSession.shared.dataTask(with: request) { _, response, error in
            if let error = error {
                completion(.failure(error))
                return
            }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard status == 200 else {
                completion(.failure(ProbeError.httpStatus(status)))
                return
            }
            completion(.success(base))
        }.resume()
    }
}
