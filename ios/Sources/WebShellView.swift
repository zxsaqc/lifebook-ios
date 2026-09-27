import SwiftUI
import UIKit
import WebKit

/// 主界面：加载 App 自带的本地服务。
///
/// 数据全部存在这台手机上（加密后落在 App 沙盒里），**不需要电脑、不需要网络**。
struct WebShellView: View {

    /// 本机服务端口，0 表示还在准备中
    @State private var port: UInt16 = 0
    @State private var bootError: String?
    @State private var isLoading = true
    @State private var loadError: String?
    @State private var reloadToken = 0

    private var startURL: String {
        "http://127.0.0.1:\(port)/index.html"
    }

    var body: some View {
        NavigationView {
            ZStack {
                if port > 0 {
                    WebViewContainer(
                        urlString: startURL,
                        isLoading: $isLoading,
                        errorMessage: $loadError,
                        reloadToken: $reloadToken
                    )
                    .edgesIgnoringSafeArea(.bottom)
                }

                if port > 0 && isLoading {
                    VStack {
                        ProgressView().padding(.top, 96)
                        Spacer()
                    }
                }

                if port == 0 {
                    VStack(spacing: 14) {
                        if let message = bootError {
                            Image(systemName: "exclamationmark.triangle")
                                .font(.system(size: 40))
                                .foregroundColor(.secondary)
                            Text(message)
                                .multilineTextAlignment(.center)
                                .padding(.horizontal, 32)
                            Button(action: boot) {
                                Text("重试")
                                    .fontWeight(.semibold)
                                    .foregroundColor(.white)
                                    .frame(maxWidth: 200)
                                    .padding(.vertical, 12)
                                    .background(Color.accentColor)
                                    .cornerRadius(10)
                            }
                        } else {
                            ProgressView()
                            Text("正在准备本机数据…")
                                .font(.footnote)
                                .foregroundColor(.secondary)
                        }
                    }
                }

                if let message = loadError {
                    ErrorOverlay(message: message, onRetry: { reloadToken += 1 })
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button(action: { reloadToken += 1 }) {
                        Image(systemName: "arrow.clockwise")
                    }
                }
            }
        }
        .navigationViewStyle(StackNavigationViewStyle())
        .onAppear(perform: boot)
        // 从后台切回来时，若之前加载失败就自动重试一次
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.willEnterForegroundNotification)) { _ in
            if loadError != nil { reloadToken += 1 }
        }
    }

    private func boot() {
        guard port == 0 else { return }
        bootError = nil
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let p = try LocalWebServer.shared.start()
                DispatchQueue.main.async { port = p }
            } catch {
                DispatchQueue.main.async {
                    bootError = "本机服务启动失败：\(error.localizedDescription)"
                }
            }
        }
    }
}

private struct ErrorOverlay: View {
    let message: String
    let onRetry: () -> Void

    var body: some View {
        ZStack {
            // 固定浅色底：不用 Color(UIColor)，保证 iOS 14 上也能编译
            Color(.sRGB, red: 0.97, green: 0.97, blue: 0.98, opacity: 1)
                .edgesIgnoringSafeArea(.all)
            VStack(spacing: 16) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 44))
                    .foregroundColor(.secondary)
                Text(message)
                    .font(.body)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 24)
                Button(action: onRetry) {
                    Text("重新加载")
                        .fontWeight(.semibold)
                        .foregroundColor(.white)
                        .frame(maxWidth: 240)
                        .padding(.vertical, 12)
                        .background(Color.accentColor)
                        .cornerRadius(10)
                }
                Text("你的数据保存在这台手机里，重新加载不会丢失。")
                    .font(.footnote)
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
            }
        }
    }
}

/// WKWebView 的 SwiftUI 包装：持久化存储、支持下拉刷新、失败时给人话提示。
struct WebViewContainer: UIViewRepresentable {
    let urlString: String
    @Binding var isLoading: Bool
    @Binding var errorMessage: String?
    @Binding var reloadToken: Int

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // 持久化存储：本地数据库（IndexedDB）落在 App 沙盒里，升级/重启都不丢
        configuration.websiteDataStore = WKWebsiteDataStore.default()
        configuration.allowsInlineMediaPlayback = true

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.isOpaque = false
        webView.backgroundColor = UIColor.systemBackground
        webView.scrollView.bounces = true
        webView.scrollView.refreshControl = context.coordinator.refreshControl
        // 避免键盘弹出时页面被顶飞
        webView.scrollView.contentInsetAdjustmentBehavior = .automatic

        context.coordinator.webView = webView
        load(into: webView)
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        guard context.coordinator.lastToken != reloadToken else { return }
        context.coordinator.lastToken = reloadToken
        errorMessage = nil
        load(into: uiView)
    }

    private func load(into webView: WKWebView) {
        guard let url = URL(string: urlString) else { return }
        isLoading = true
        let request = URLRequest(
            url: url,
            cachePolicy: .reloadIgnoringLocalCacheData,
            timeoutInterval: 30
        )
        webView.load(request)
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var parent: WebViewContainer
        weak var webView: WKWebView?
        var lastToken: Int
        let refreshControl = UIRefreshControl()

        init(_ parent: WebViewContainer) {
            self.parent = parent
            self.lastToken = parent.reloadToken
            super.init()
            refreshControl.addTarget(self, action: #selector(handleRefresh(_:)), for: .valueChanged)
        }

        @objc private func handleRefresh(_ sender: UIRefreshControl) {
            parent.errorMessage = nil
            webView?.reload()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                sender.endRefreshing()
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            parent.isLoading = false
            parent.errorMessage = nil
            refreshControl.endRefreshing()
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            handle(error)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            handle(error)
        }

        private func handle(_ error: Error) {
            parent.isLoading = false
            refreshControl.endRefreshing()
            let nsError = error as NSError
            if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
            parent.errorMessage = "页面加载失败：\(nsError.localizedDescription)"
        }
    }
}
