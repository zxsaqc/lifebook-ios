import SwiftUI

/// 首次启动：告诉 App 电脑上的 LifeBook 跑在哪个地址。
struct SetupView: View {
    @EnvironmentObject private var settings: AppSettings

    @State private var input = ""
    @State private var isChecking = false
    @State private var message: String?
    @State private var isSuccess = false

    var body: some View {
        NavigationView {
            Form {
                Section(header: Text("电脑上的 LifeBook 地址")) {
                    TextField("http://192.168.1.23:8686", text: $input)
                        .keyboardType(.URL)
                        .autocapitalization(.none)
                        .disableAutocorrection(true)
                    Text("电脑上双击桌面图标「LifeBook 手机模式」，那个黑窗口里会打印手机访问地址；手机与电脑需连同一个 WiFi。")
                        .font(.footnote)
                        .foregroundColor(.secondary)
                }

                Section {
                    Button(action: save) {
                        HStack {
                            Text("测试连接并使用")
                            Spacer()
                            if isChecking { ProgressView() }
                        }
                    }
                    .disabled(input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isChecking)

                    if let message = message {
                        Text(message)
                            .font(.footnote)
                            .foregroundColor(isSuccess ? .green : .red)
                    }
                }

                Section(header: Text("说明")) {
                    Text("LifeBook 的数据只存在你自己的电脑上，手机只是访问它的窗口：电脑关机或退出服务时，App 会提示连不上，这是正常的。")
                        .font(.footnote)
                        .foregroundColor(.secondary)
                }
            }
            .navigationTitle("连接 LifeBook")
        }
        .navigationViewStyle(StackNavigationViewStyle())
        .onAppear { input = settings.serverAddress }
    }

    private func save() {
        isChecking = true
        message = nil
        ServerProbe.check(input) { result in
            DispatchQueue.main.async {
                isChecking = false
                switch result {
                case .success(let address):
                    isSuccess = true
                    message = "连上了：\(address)"
                    settings.save(input)
                case .failure(let error):
                    isSuccess = false
                    message = error.localizedDescription
                }
            }
        }
    }
}
