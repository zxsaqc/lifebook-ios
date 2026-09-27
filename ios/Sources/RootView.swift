import SwiftUI

struct RootView: View {
    @EnvironmentObject private var settings: AppSettings

    var body: some View {
        Group {
            if settings.isConfigured {
                WebShellView()
            } else {
                SetupView()
            }
        }
    }
}
