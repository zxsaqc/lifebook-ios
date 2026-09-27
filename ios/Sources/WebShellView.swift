import SwiftUI
import UIKit
import WebKit

struct WebShellView: View {
    @EnvironmentObject private var settings: AppSettings

    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var reloadToken = 0
    @State private var showSettings = false

    var body: some View {
        NavigationView {
            ZStack {
                WebViewContainer(
                    address: settings.normalizedAddress,
                    isLoading: $isLoading,
                    errorMessage: $errorMessage,
                    reloadToken: $reloadToken
                )
                .edgesIgnoringSafeArea(.bottom)

                VStack {
                    if isLoading {
                        ProgressView()
                            .padding(.top, 96)
                    }
                    Spacer()
                }

                if let message = errorMessage {
                    ErrorOverlay(
                        message: message,
                        address: settings.normalizedAddress,
                        onRetry: { reloadToken += 1 },
                        onChangeAddress: { showSettings = true }
                    )
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: { reloadToken += 1 }) {
                        Image(systemName: "house")
                    }
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button(action: { showSettings = true }) {
                        Image(systemName: "gear")
                    }
                }
            }
        }
        .navigationViewStyle(StackNavigationViewStyle())
        .sheet(isPresented: $showSettings) {
            SettingsSheet(onDone: { changed in
                showSettings = false
                if changed { reloadToken += 1 }
            })
            .environmentObject(settings)
        }
        // 从后台切回来时自动重试一次，省得手动刷新
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.willEnterForegroundNotification)) { _ in
            if errorMessage != nil { reloadToken += 1 }
        }
    }
}

private struct ErrorOverlay: View {
    let message: String
    let address: String
    let onRetry: () -> Void
    let onChangeAddress: () -> Void

    var body: some View {
        ZStack {
            // 固定浅色底：不用 Color(UIColor)，保证 iOS 14 上也能编译
            Color(.sRGB, red: 0.97, green: 0.97, blue: 0.98, opacity: 1)
                .edgesIgnoringSafeArea(.all)
            VStack(spacing: 16) {
                Image(systemName: "wifi.slash")
                    .font(.system(size: 44))
                    .foregroundColor(.secondary)
                Text(message)
                    .font(.body)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 24)
                Text(address)
                    .font(.system(.footnote, design: .monospaced))
                    .foregroundColor(.secondary)
                VStack(spacing: 10) {
                    Button(action: onRetry) {
                        Text("重新连接")
                            .fontWeight(.semibold)
                            .foregroundColor(.white)
                            .frame(maxWidth: 240)
                            .padding(.vertical, 12)
                            .background(Color.accentColor)
                            .cornerRadius(10)
                    }
                    Button("换个地址", action: onChangeAddress)
                        .font(.footnote)
                        .foregroundColor(.secondary)
                }
                Text("确认电脑已开机、桌面「LifeBook 手机模式」窗口还开着、手机与电脑连同一个 WiFi。")
                    .font(.footnote)
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
                    .padding(.top, 8)
            }
        }
    }
}

/// WKWebView 的 SwiftUI 包装：持久化 Cookie、支持下拉刷新、失败时给出人话提示。
struct WebViewContainer: UIViewRepresentable {
    let address: String
    @Binding var isLoading: Bool
    @Binding var errorMessage: String?
    @Binding var reloadToken: Int

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = WKWebsiteDataStore.default()

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.isOpaque = false
        webView.backgroundColor = UIColor.systemBackground
        webView.scrollView.bounces = true
        webView.scrollView.refreshControl = context.coordinator.refreshControl

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
        guard let url = URL(string: address) else { return }
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

        func webView(
            _ webView: WKWebView,
            didReceive challenge: URLAuthenticationChallenge,
            completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
        ) {
            completionHandler(.performDefaultHandling, nil)
        }

        private func handle(_ error: Error) {
            parent.isLoading = false
            refreshControl.endRefreshing()
            let nsError = error as NSError
            // 页面自己发起的跳转被取消不算失败
            if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
            parent.errorMessage = Self.describe(nsError)
        }

        private static func describe(_ error: NSError) -> String {
            guard error.domain == NSURLErrorDomain else { return error.localizedDescription }
            switch error.code {
            case NSURLErrorCannotConnectToHost, NSURLErrorCannotFindHost:
                return "连不上电脑上的 LifeBook。"
            case NSURLErrorTimedOut:
                return "连接超时，地址可能填错了。"
            case NSURLErrorNotConnectedToInternet:
                return "手机当前没有网络，先连上 WiFi。"
            default:
                return error.localizedDescription
            }
        }
    }
}
