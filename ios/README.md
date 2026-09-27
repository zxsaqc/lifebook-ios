# LifeBook iOS 工程（未签名 ipa → TrollStore 安装）

## 为什么要"绕这一圈"

| 环节 | 这台 Windows 能做吗 | 说明 |
|---|---|---|
| 写 Swift 源码 | ✅ | 纯文本，本目录里的东西就是 |
| 编译成 iOS 可执行文件 | ❌ | 必须 Xcode，而 Xcode 只存在于 macOS |
| Apple 签名 | 不需要 | 你有 TrollStore（巨魔），走 CoreTrust 绕过，**未签名 ipa 可直接装** |
| 上架 App Store | — | 暂时不需要，跳过 |

所以拼图只缺"一次 macOS 上的编译"，用 **GitHub Actions 的 macOS 云编译机**补上：免费、不用你有 Mac、不用开发者账号。

## 已经跑通了：不需要你动手

仓库已经建好并成功编译过一次：

- 仓库：<https://github.com/zxsaqc/lifebook-ios>（Public，里面只有 App 源码；数据在 `data/` 且被 .gitignore 排除，不会上传）
- 构建历史：<https://github.com/zxsaqc/lifebook-ios/actions>
- 产物：**桌面上的 `LifeBook.ipa`**（约 85KB，ARM64，iOS 14+）

### 拿最新版 ipa（两种方式，任选）

**方式一：一条命令（推荐）**

```
python scripts/build_ipa.py
```

它会自动同步源码 → 推送 → 等云编译跑完 → 把 `LifeBook.ipa` 下载到桌面。全程不用碰网页。

**方式二：网页上点**

1. 打开 <https://github.com/zxsaqc/lifebook-ios/actions>
2. 点最新的那次运行 → 页面底部 **Artifacts** → `LifeBook-unsigned-ipa`（是个 zip，解压得到 `LifeBook.ipa`）
3. 想不改代码也重新出包：Actions → Build LifeBook iOS → **Run workflow**

## 安装到 iPhone（巨魔）

1. 把 `LifeBook.ipa` 弄到手机上：AirDrop 最省事，也可以存进「文件」App；
2. 用 **TrollStore** 打开这个 ipa 安装；
3. 打开 LifeBook → 填电脑地址（形如 `http://192.168.1.23:8686`）→ 点「测试连接并使用」。

电脑地址从哪来：电脑上双击桌面图标 **「LifeBook 手机模式」**，黑窗口里会打印 `手机访问地址 → http://xxx.xxx.xxx.xxx:8686`，选跟电脑同一 WiFi 的那个。

## 以后改代码

改完 `ios/Sources/*.swift`，跑 `python scripts/build_ipa.py` 即可，新 ipa 会覆盖桌面上的旧文件，手机上覆盖安装。

## 构建失败了怎么办

把 Actions 里红色的那一步日志发出来（或在仓库目录执行 `gh run view <run-id> --log-failed`），我直接改——CI 日志会把编译错误和出错文件名都列出来。

### 踩过的坑（已修，留档）

1. **工程格式太新**：xcodegen 默认按最新 Xcode 生成（objectVersion 77），云编译机是 Xcode 15.4 打不开 → 在 `project.yml` 里显式写 `options.xcodeVersion: "15.0"`。
2. **archive 环节卡签名**：改用 `xcodebuild build` + 手工打 `Payload`，绕开签名校验。
3. **图标丢失**：某些组合下 Asset Catalog 不会编译成 `Assets.car` → 额外把 PNG 拷进 bundle，并在 `Info.plist` 用 `CFBundleIconFiles` 兜底。

## 工程结构

```
ios/
├── project.yml                     # xcodegen 描述，CI 用它生成 .xcodeproj
├── Info.plist                      # ATS 放行局域网 http + 图标兜底
├── Sources/
│   ├── LifeBookApp.swift           # 入口
│   ├── AppSettings.swift           # 服务器地址持久化（UserDefaults）
│   ├── ServerProbe.swift           # /health 连通性探测
│   ├── RootView.swift              # 未配置 → 引导页；已配置 → WebView
│   ├── SetupView.swift             # 首次连接引导
│   ├── SettingsSheet.swift         # 改地址 / 断开 / 版本
│   └── WebShellView.swift          # WKWebView 壳：下拉刷新、Cookie 持久化、失败提示
├── Resources/Assets.xcassets/      # AppIcon 全尺寸 + 启动背景色
└── Resources/AppIcon.appiconset/   # 兜底：PNG 直接进 bundle
```

## 当前版本的能力边界

- 手机 App 是**访问窗口**：数据仍在你电脑的 SQLite 里，电脑关机或退出服务时 App 会提示连不上——这是设计如此，不是 bug；
- 依赖局域网 WiFi，不在家/办公室就连不上（后续可做内网穿透或公网部署）；
- 尚未做：Face ID 解锁、离线缓存、原生小组件——等你用上手再按需求加。
