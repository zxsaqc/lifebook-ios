# LifeBook iOS（数据完全在手机上，不依赖电脑）

## 架构：为什么现在是「单机 App」

早期版本是「手机连电脑上的服务」——数据统一放在电脑 SQLite 里。
**对账号口令、工资这类内容这个取舍是错的**，现已改为：

```
iPhone App
├── 自带的本地服务（127.0.0.1，仅回环，外部访问不到）
├── 前端页面（打包在 App 内，离线可用）
└── 加密数据 → App 沙盒里的本地数据库
```

- **不需要电脑、不需要 WiFi、断网可用**；
- 每条记录整体加密后落盘（PBKDF2 25 万轮派生 + AES-256-GCM），
  落盘内容只有 `{id, 类型, 时间, 密文}`，主口令不落盘、密钥只在内存；
- App 卸载才会清数据，日常升级不影响。

### 为什么 App 内还要起一个本地服务

浏览器只在**安全上下文**下提供加密接口 `crypto.subtle`：`https` 或 `localhost` 算，
`file://` 不算。数据要靠它加密，所以 App 内起了一个只监听回环地址的极简静态服务器，
页面从 `http://127.0.0.1:<随机端口>` 加载。外部设备连不上它。

## 拿到安装包

**已经跑通过，不需要你动手**：

- 仓库：<https://github.com/zxsaqc/lifebook-ios>
- 构建历史：<https://github.com/zxsaqc/lifebook-ios/actions>
- 产物：桌面上的 `LifeBook.ipa`

需要重新出包时（改了 Swift 或前端）：

```bash
python scripts/build_ipa.py     # 同步 → 云编译 → ipa 自动回到桌面
```

网页上手动触发也可以：Actions → Build LifeBook iOS → **Run workflow**。

### 站点根约定（改路径前必读）

URL 空间是「站点根 = `web/static`」+ 三个根级别名，三处必须一致：

| 位置 | 规定 |
| --- | --- |
| 前端 | 页面里写 `/static/styles.css`、`/static/js/app.js` |
| 本地服务 | `LocalWebServer.resolve()` 把 `/static/x` → `web/static/x`；别名 `/` 与 `/index.html` → `static/index.html`、`/manifest.webmanifest`、`/sw.js` |
| 打包 | `$APP/web/static/...`，**不能把 `static/` 这一层抹掉** |

踩过的坑：`cp -R web/static/. → $APP/web/` 会把 `static/` 抹平，页面上所有资源
全部 404 —— 样式表加载不到（界面裸奔成裸 HTML）、`js/app.js` 加载不到
（点「进入」毫无反应），而**构建全程不报错**。现在这几处都有检查：
`scripts/local-tests/check-layout.sh`（本地秒级预演）、CI 的「引用一致性」段、
以及出包后自动跑的 `scripts/verify_ipa.py`（会解析 Swift 的路由表与预期逐条比对）。

## 安装与使用

1. 把 `LifeBook.ipa` 传到手机（AirDrop / 文件 App），用 **TrollStore** 打开安装；
2. 打开 LifeBook → 设置主口令（**务必记住，它不落盘，丢了无法找回**）；
3. 直接开始用，不需要填写任何地址。

顶栏「数据」按钮里可以**导出加密备份**——备份串自带独立口令保护，
可以存到备忘录或发给自己，换手机时粘回来即可恢复。

## 工程结构

```
ios/
├── project.yml                     # xcodegen 描述（CI 用它生成 .xcodeproj）
├── Info.plist                      # 只放行本机回环明文 + 拍照权限说明
├── Sources/
│   ├── LifeBookApp.swift           # 入口
│   ├── RootView.swift              # 直接显示主界面（无需任何配置）
│   ├── LocalWebServer.swift        # 极简本地静态服务器（Network.framework，仅回环）
│   └── WebShellView.swift          # WKWebView 壳：持久化存储、下拉刷新、失败重试
└── Resources/
    ├── Assets.xcassets/            # AppIcon
    └── AppIcon.appiconset/         # 兜底：PNG 直接进 bundle
```

前端（打进 bundle 的 `web/`，源码在仓库 `web/static/`）：

```
js/
├── api.js          # 统一数据入口（默认指向本机实现）
├── localapi.js     # 本机版 API：四个模块全部业务逻辑
├── localstore.js   # IndexedDB 持久化 + 加密 + 内存索引
├── crypto.js       # PBKDF2 + AES-GCM
├── rules.js        # AI 自动识别会员订阅（可解释、会学习）
├── remoteapi.js    # 保留的「连服务器」实现，改 api.js 一行即可切换
└── views/          # 四个模块界面（未改动，仍复用）
```

## 本地数据层测试

不需要 iOS 设备即可回归（用 Node 跑真实的存储与业务代码）：

```bash
node scripts/local-tests/test.mjs      # 55 项：加密、四模块 CRUD、AI 打标、备份恢复
```

## 踩过的坑（已修，留档）

1. **工程格式太新**：xcodegen 默认按最新 Xcode 生成（objectVersion 77），
   云编译机是 Xcode 15.4 打不开 → `project.yml` 显式写 `options.xcodeVersion: "15.0"`。
2. **archive 环节卡签名**：改用 `xcodebuild build` + 手工搭 `Payload/`。
3. **图标丢失**：Asset Catalog 不保证被编译 → CI 里直接把 PNG 拷进 bundle +
   用 PlistBuddy 写 `CFBundleIconFiles`，**最后**才做 ad-hoc 签名。
4. **xcodegen 会覆盖 Info.plist**：`target.info.properties` 是覆盖写入，
   手写在 `ios/Info.plist` 里的键会被冲掉，自定义键必须写进 `properties`。
5. **本地服务是加密的前提**：没有 `localhost` 就没有 `crypto.subtle`，数据就加不了密。

## 还没做（等你用上手再说）

- Face ID / 面容解锁开屏；
- 备份文件直接分享到 iCloud Drive（现在是复制备份串）；
- 桌面小组件、多个设备之间同步。
