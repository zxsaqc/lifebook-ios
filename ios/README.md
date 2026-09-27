# LifeBook iOS 工程（未签名 ipa → TrollStore 安装）

## 为什么要"绕这一圈"

| 环节 | 这台 Windows 能做吗 | 说明 |
|---|---|---|
| 写 Swift 源码 | ✅ | 纯文本，本目录里的东西就是 |
| 编译成 iOS 可执行文件 | ❌ | 必须 Xcode，而 Xcode 只存在于 macOS |
| Apple 签名 | 不需要 | 你有 TrollStore（巨魔），走 CoreTrust 绕过，**未签名 ipa 可直接装** |
| 上架 App Store | — | 暂时不需要，跳过 |

所以拼图只缺"一次 macOS 上的编译"，用 **GitHub Actions 的 macOS 云编译机**补上：免费、不用你有 Mac、不用开发者账号。

## 三步拿到 ipa（照做即可，全程网页操作）

### 第 1 步：建一个 GitHub 仓库

1. 打开 <https://github.com/new>（没有账号就注册一个，免费）；
2. Repository name 填 `lifebook-ios`；
3. 选 **Public**（公共仓库才能免费使用 macOS 编译机；仓库里只有 App 源码，**数据库和你的数据在 `data/` 里，已被 .gitignore 排除，不会上传**）；
4. 直接点 **Create repository**。

### 第 2 步：把源码传上去

1. 桌面上有 `LifeBook-iOS工程.zip`，先解压，得到 `ios` 和 `.github` 两个文件夹；
2. 在刚建的仓库页面点 **Add file → Upload files**；
3. 把这两个文件夹**拖进**上传框（拖文件夹，不是拖 zip），等文件列出来；
4. 点绿色的 **Commit changes**。

> 上传完会自动触发一次构建，不用手动点。

### 第 3 步：下载 ipa 并安装

1. 仓库顶部点 **Actions**，会看到一个正在跑的任务；
2. 等它变绿（一般 3～8 分钟），点进去；
3. 页面最下面 **Artifacts** 区域 → `LifeBook-unsigned-ipa` → 下载（是个 zip，解压得到 `LifeBook.ipa`）；
4. 把这个 ipa 弄到手机上：AirDrop 最省事，或存进「文件」App；
5. 在 iPhone 上用 **TrollStore** 打开这个 ipa 安装；
6. 打开 LifeBook → 填电脑地址（形如 `http://192.168.1.23:8686`）→ 点「测试连接并使用」。

电脑地址从哪来：电脑上双击桌面图标 **「LifeBook 手机模式」**，那个黑窗口里会打印 `手机访问地址 → http://xxx.xxx.xxx.xxx:8686`，选跟电脑同一 WiFi 的那个。

## 以后改代码

改 `ios/Sources/*.swift` 后重新上传，`push` 会自动触发构建，Actions 里再下载新版 ipa 覆盖安装即可。

也可以手动触发：Actions → Build LifeBook iOS → **Run workflow**。

## 构建失败了怎么办

把 Actions 里红色的那一步日志（点开复制）发给我，我直接改——CI 日志会把编译错误和出错文件名都列出来。

## 工程结构

```
ios/
├── project.yml                     # xcodegen 描述，CI 用它生成 .xcodeproj
├── Info.plist                      # xcodegen 自动生成（含 ATS 放行局域网 http）
├── Sources/
│   ├── LifeBookApp.swift           # 入口
│   ├── AppSettings.swift           # 服务器地址持久化（UserDefaults）
│   ├── ServerProbe.swift           # /health 连通性探测
│   ├── RootView.swift              # 未配置 → 引导页；已配置 → WebView
│   ├── SetupView.swift             # 首次连接引导
│   ├── SettingsSheet.swift         # 改地址 / 断开 / 版本
│   └── WebShellView.swift          # WKWebView 壳：下拉刷新、Cookie 持久化、失败提示
└── Resources/Assets.xcassets/      # AppIcon 全尺寸 + 启动背景色
```

## 当前版本的能力边界

- 手机 App 是**访问窗口**：数据仍在你电脑的 SQLite 里，电脑关机或退出服务时 App 会提示连不上——这是设计如此，不是 bug；
- 依赖局域网 WiFi，不在家/办公室就连不上（后续可做内网穿透或公网部署）；
- 尚未做：Face ID 解锁、离线缓存、原生小组件——等你用上手再按需求加。
