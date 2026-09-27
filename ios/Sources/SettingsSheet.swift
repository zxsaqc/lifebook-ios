import SwiftUI

struct SettingsSheet: View {
    @EnvironmentObject private var settings: AppSettings

    @State private var input = ""
    @State private var isChecking = false
    @State private var message: String?
    @State private var isSuccess = false

    let onDone: (_ addressChanged: Bool) -> Void

    var body: some View {
        NavigationView {
            Form {
                Section(header: Text("服务器地址")) {
                    TextField("http://192.168.1.23:8686", text: $input)
                        .keyboardType(.URL)
                        .autocapitalization(.none)
                        .disableAutocorrection(true)
                    Button(action: test) {
                        HStack {
                            Text("测试连接")
                            Spacer()
                            if isChecking { ProgressView() }
                        }
                    }
                    .disabled(isChecking)
                    if let message = message {
                        Text(message)
                            .font(.footnote)
                            .foregroundColor(isSuccess ? .green : .red)
                    }
                }

                Section {
                    Button("保存并重新载入") {
                        settings.save(input)
                        onDone(true)
                    }
                    Button("断开，重新配置") {
                        settings.forget()
                        onDone(false)
                    }
                    .foregroundColor(.red)
                }

                Section(header: Text("关于")) {
                    HStack {
                        Text("版本")
                        Spacer()
                        Text(Self.versionText).foregroundColor(.secondary)
                    }
                    Text("数据全部保存在你自己的电脑上，手机只是访问窗口。电脑关机时 App 会提示连不上，属正常现象。")
                        .font(.footnote)
                        .foregroundColor(.secondary)
                }
            }
            .navigationTitle("设置")
            .navigationBarItems(leading: Button("关闭") { onDone(false) })
        }
        .navigationViewStyle(StackNavigationViewStyle())
        .onAppear { input = settings.serverAddress }
    }

    private func test() {
        isChecking = true
        message = nil
        ServerProbe.check(input) { result in
            DispatchQueue.main.async {
                isChecking = false
                switch result {
                case .success(let address):
                    isSuccess = true
                    message = "连上了：\(address)"
                case .failure(let error):
                    isSuccess = false
                    message = error.localizedDescription
                }
            }
        }
    }

    private static var versionText: String {
        let short = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1"
        return "\(short) (\(build))"
    }
}
