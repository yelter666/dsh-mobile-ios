# Spike-0 RUNBOOK · 三日验证手册

> 目标：用不超过 3 个工作日，把 X1（插件能否挂载）与 X2（mux 方法表）从"待外部答复"变成"有证据的结论"。
> 出口：填完第 6 节的结论表；判定走 **插件** 还是 **sidecar**，并解锁 S-1。

---

## 0. 前置

| 项 | 要求 | 检查命令 |
|---|---|---|
| Node | ≥ 20（本机实测 22.22.2） | `node -v` |
| 一台装好 DSH 的 Mac | 能正常建任务 | 打开 DSH，跑一个任务 |
| 端口 | 3081 空闲（被占用会自动顺延，日志里会写） | `lsof -iTCP:3081 -sTCP:LISTEN` |
| 代码 | 把 `gateway/` 整个目录拷到该机器 | `scp -r ...` |

> mock 适配器的样本数据已内置在 `src/adapter/mock-data.mjs`（0.2.14 起），
> 不再需要 `spec/fixtures/`；直接 `--host=mock` 即可跑起来。

---

## 1. 先确认宿主在监听什么（10 分钟）

DSH 是本地应用，先摸清它的端口与接口前缀，别猜：

```bash
# 1) 看宿主进程与端口
lsof -nP -iTCP -sTCP:LISTEN | grep -i -E "dsh|electron|node" | head -20

# 2) 逐个试可能的前缀（把 3000 换成上一步看到的端口）
for p in 3000 3080 5173 8765; do
  echo "--- $p"; curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:$p/api/remote.mux"
done

# 3) 命中后看返回了什么（状态码、Content-Type、前 200 字节）
curl -si "http://127.0.0.1:3000/api/remote.mux" | head -20
```

**记录**：端口、状态码、是否需要鉴权、返回是 JSON 还是"升级为 WS 的 101"。
这一步的结果直接决定 `--mux-url` 填什么。

---

## 2. 跑探测器（30 分钟）

```bash
node spike0/probe.mjs --host=mux --mux-url=http://127.0.0.1:3000
cat spike0/last-report.json
```

判读：

| 现象 | 含义 | 下一步 |
|---|---|---|
| `mount` PASS + `host-info` PASS | 网关侧骨架没问题，宿主信息拿到了 | 进第 3 节 |
| `host-info` FAIL「宿主降级」 | `/api/remote.mux` 不可达或格式未确认 | 回第 1 节换端口/换前缀；或确认是否需要 token |
| `mux-read` FAIL `status=0` | 连不上（DNS/端口/防火墙） | 用 `curl` 复现，确认是网络而非代码 |
| `mux-read` WARN「方法映射需按 X2 补齐」 | **正常**：端点存在，但业务方法还没对齐 | 这就是 X2 的证据，把方法清单抄进第 6 节 |

---

## 3. 插件挂载（半天，最关键）

1. 找到 DSH 的插件目录（常见位置，按实际找）：
   ```bash
   ls -d ~/Library/Application\ Support/*DSH* 2>/dev/null
   find ~ -maxdepth 4 -type d -name "plugins" 2>/dev/null | grep -i -E "dsh|harness" | head
   ```
2. 把 `entries/plugin.mjs` + `src/` 按宿主约定放进去（若宿主要求 `package.json` 的 `main` 指向入口，把 `package.json` 一并放入）。
3. 重启宿主，看三处：
   - 宿主启动日志里是否有 `[dsh-mobile] ready 127.0.0.1:3081`；
   - `lsof -iTCP:3081 -sTCP:LISTEN` 是否有 node 进程；
   - 宿主 UI 的插件/扩展列表里是否出现 `dsh-mobile-gateway`。
4. **卸载验证**：在宿主里关掉该插件，`lsof` 端口应立刻消失（这是 R12 的现场证据）。

判定矩阵：

| 现象 | 结论 | 动作 |
|---|---|---|
| 三处都出现，卸载后端口释放 | **X1 = 允许** | 走插件路线，`entries/plugin.mjs` 即正式入口 |
| 加载了但监听失败（权限/沙箱） | X1 = 半允许 | 记录错误原文；考虑「插件内起 sidecar 子进程」的折中方案 |
| 根本没有插件机制 / 加载即被拒 | **X1 = 不允许** | 立刻切 sidecar：`node entries/sidecar.mjs --host=mux`，成本 +3~5 人日，功能不变 |
| 加载后宿主崩溃 | 严重（R12 未兜住） | 保存 crash log，把 `apply` 里未捕获的位置补上 try/catch 后重测 |

> 注意：`apply` 已经保证不外抛。若仍崩宿主，问题在**宿主调用方式**（例如它把异步初始化当同步用），把调用栈原文记下来，这是给桌面端的 bug 报告。

---

## 4. iPhone 真机局域网可达性（半天，回答 R9/R10）

```bash
ipconfig getifaddr en0                # 记下 Mac 的局域网 IP
node entries/sidecar.mjs --host=mux --lan=true   # 显式开 LAN，默认不开
```

iPhone（同一 Wi-Fi）用 Safari 打开：

```
http://<Mac局域网IP>:3081/mobile/v1/health
```

| 结果 | 含义 |
|---|---|
| 先弹「是否允许访问本地网络」→ 允许后看到 `{"ok":true}` | R9 的默认路径成立；App 里必须写 `NSLocalNetworkUsageDescription` 并给一句人话理由 |
| 弹了但点「不允许」后再也无法访问 | **必须做**：引导页 + 「去设置」深链，否则用户永久卡死 |
| 一直不弹、直接失败 | 检查是否 `--lan=true`；检查 macOS 防火墙 |
| 能访问但 App 里 `ws://` 连不上 | 典型 ATS：只开 `NSAllowsLocalNetworking`，**不要**开 `NSAllowsArbitraryLoads` |

---

## 5. 反向验证：失败也要留证据

在动手写 S-2 之前，先确认"失败时系统是诚实的"：

```bash
# 宿主关掉后，客户端应看到明确错误，而不是白屏
node spike0/probe.mjs --host=mux --mux-url=http://127.0.0.1:9   # 故意填错端口
```

期望：`host-info` FAIL「宿主降级」、`mux-read` FAIL `status=0`，**退出码非 0**。
若这里显示 PASS，说明有地方在假装成功，先修这个，别往下走。

---

## 6. 结论表（填完即为 Spike-0 出口）

| # | 问题 | 证据（命令输出/截图路径） | 结论 | 对排期的影响 |
|---|---|---|---|---|
| X1 | 插件能否挂载 | | 允许 / 不允许 / 半允许 | 不允许则 +3~5 人日 |
| X2 | mux 方法清单 | | 列出可代理方法： | 方法少则砍 FR，用 4021 隐藏 |
| R9 | 本地网络权限 | | 正常 / 需引导 | 需引导则 +1 人日 UI |
| R10 | ATS 是否拦截 | | 拦截 / 不拦截 | 拦截则加 ATS 例外 + 审核说明 |
| R12 | 插件崩溃是否连带 | | 无 / 有（附 crash log） | 有则先修隔离再开工 |
| — | 端口与监听 | | | |

判定：

- **四项全绿** → 直接进 S-1（契约 v1.0-rc + Mock 故障注入），按双轨并行排期。
- **X1 红** → 切 sidecar，S-1 照常，客户端不受影响（这正是 ADR-12 的意义）。
- **X2 严重不足**（可用方法 < 任务列表 + 详情 + 消息 + 停止）→ 先只读 beta，写操作推迟到 v2.1，并同步产品改口径。

---

## 7. 时间盒

| 时段 | 内容 | 产出 |
|---|---|---|
| D1 上午 | 第 1、2 节 | 端口/前缀确认 + `last-report.json` |
| D1 下午 | 第 3 节 | X1 结论（允许/不允许） |
| D2 | 第 4 节 + 第 5 节 | R9/R10 证据 + 失败诚实性确认 |
| D3 | 第 6 节 + 补测 | 结论表签字，S-1 开工 |

超时处理：任何一项超过半天没有结论，先按"最坏情况"（sidecar + 只读 beta）推进，把问题挂到桌面端，不阻塞客户端。

---

## 8. 本项目现状：真机安装与 X1 的最小操作序列

> 前面几节是通用方法。这一节写**当前仓库的实际路径**——已经有 Xcode 工程和一份在模拟器上跑通的客户端，
> 不需要从零搭。只回答「怎么把它装到 iPhone 上，并顺手拿到 X1 的答复」。

### 8.1 三条前置事实（先看，能省半天）

| 事实 | 后果 |
|---|---|
| 模拟器链路用的是 `codesign -s -`（ad-hoc 签名） | **装不进真机**。真机必须走 Xcode 自动签名，`tools/build-ios-app.sh` 只服务模拟器 |
| 工程 `DEVELOPMENT_TEAM` 是空的 | 首次打开要自己选 Team，否则 ⌘R 报 "Signing for DSHMobile requires a development team" |
| 本机 `xcodebuild` 在 AI 进程树里必报 `sandbox-exec: Operation not permitted` | 只影响命令行/脚本构建；**你在 Xcode 里 ⌘R 不受影响** |

工程位置：`ios/DSHMobile/DSHMobile.xcodeproj`；bundle id `com.dshmobile.app`；部署目标 iOS 18.0；iPhone 锁竖屏。

### 8.2 装到真机（15 分钟）

1. Xcode 打开工程 → 选中 `DSHMobile` target → **Signing & Capabilities** → Team 选你的开发者账号
   （勾上 Automatically manage signing；个人免费账号也能装，签名 7 天有效）
2. bundle id 若被占用就改成唯一值（如 `com.<你的名字>.dshmobile`），只改这一处
3. iPhone 用 USB 连上，或 Xcode → Window → Devices and Simulators 里开 Wireless 连接；顶部设备选 iPhone
4. ⌘R。首次运行后若提示不受信任：iPhone 设置 → 通用 → VPN与设备管理 → 信任该开发者
5. 装好后**先别急着连宿主**，用 `--host=mock` 跑一遍：确认列表、详情、输入区在真机上正常。
   mock 不依赖桌面端，能把「客户端问题」和「宿主问题」分开。

> 真机上钥匙串是好的（Xcode 构建会注入 `application-identifier`），不需要 `DSH_CREDENTIAL_STORE=memory`。

### 8.3 真机连宿主：顺手回答 R9 / R10

```bash
ipconfig getifaddr en0                                  # 记下 Mac 的局域网 IP
cd gateway && node entries/sidecar.mjs --host=mock --lan=true   # 先 mock；换成 --host=mux 再验真宿主
```

1. iPhone 同一 Wi-Fi 下用 **Safari** 打开 `http://<Mac的IP>:3081/mobile/v1/health`
   → 记：**是否弹「本地网络」权限**、允许后是否 `{"ok":true}`、拒绝后是否再也打不开（R9 的三条证据）
2. 打开 App 配对页：地址填 `http://<Mac的IP>:3081`，配对码取 `curl -X POST http://127.0.0.1:3081/mobile/v1/pairing/code -d '{"deviceName":"iPhone"}' -H 'content-type: application/json'`
3. 若 Safari 能开、App 里 WS 连不上 → 就是 ATS（R10）。本项目只开了 `NSAllowsLocalNetworking`，
   **不要**为了让 demo 通过去开 `NSAllowsArbitraryLoads`（审核会问，且不是真修复）
4. 关键一条：在 iPhone 上**点「不允许」**再试一次，看 App 是否给出可恢复的引导。
   这条不通过，正式版会有一批用户永久卡死。

### 8.4 X1 插件挂载（半天，最关键）

按第 3 节的 4 步走，这里只补齐**本仓库要拷哪些东西**：

```bash
cd gateway
# 1) 找宿主插件目录（三选一，看哪个存在）
ls -d ~/Library/Application\ Support/*DSH* 2>/dev/null
find ~ -maxdepth 4 -type d -name plugins 2>/dev/null | grep -iE "dsh|harness" | head

# 2) 把这三样放进插件目录（package.json 的 main 指不到入口时宿主会静默不加载）
#    entries/  src/  package.json
#    插件入口是 entries/plugin.mjs，导出 name / version / apply(ctx, config)

# 3) 重启宿主，三处同时确认
#    a. 宿主日志出现  [dsh-mobile] ready 127.0.0.1:3081
#    b. lsof -iTCP:3081 -sTCP:LISTEN   有 node 进程
#    c. 宿主 UI 的插件/扩展列表里出现  dsh-mobile-gateway

# 4) 卸载验证（R12 的现场证据，别省）
#    宿主里关掉该插件 → lsof 端口应立刻消失
```

判定（与第 3 节矩阵一致，一行版）：

| 现象 | 结论 | 下一步 |
|---|---|---|
| 三处都出现 + 卸载即释放 | **X1 = 允许** | `entries/plugin.mjs` 即正式入口，进 S-1 |
| 加载了但监听失败 | 半允许 | 抄错误原文；退「插件内起子进程」 |
| 没有插件机制 / 加载即被拒 | **X1 = 不允许** | 立刻切 sidecar，+3~5 人日，功能不变 |
| 加载后宿主崩溃 | R12 未兜住 | 存 crash log，把 `apply` 的调用栈原文给桌面端 |

### 8.5 模拟器机型说明（已可跑真机型）

**2026-11-15 更新：通用运行时已装好，这一节的历史结论作废。**

现状：`simctl list runtimes` 有两个运行时——

| 运行时标识 | 说明 | 能建的机型 |
|---|---|---|
| `SimRuntime.iOS-27-2`（24B8117） | 通用运行时，16.65 GB | iPhone 17 / 18 Pro / 18 Pro Max / 17e / Air / iPad 全系 |
| `SimRuntime.iOS-27-2-iPhone19-4` | 设备绑定镜像（早期的唯一一份） | 仅 `iPhone-Duo` |

历史：早先只有第二份，`supportedDeviceTypes` 只有 `iPhone-Duo`，
`simctl create` 建任何 iPhone 都返回 `403 Incompatible device`——那是**设备绑定**，不是配置错。
当时的所有截图都出自 466pt 的 Duo，对常见屏宽零证据，才临时加了 `DSH_PREVIEW_WIDTH` 限宽近似。

现在怎么跑真机型：

```bash
DSH_SIM_NAME="iPhone 17" tools/simulate-e2e.sh          # 402×874pt
DSH_SIM_NAME="iPhone SE (3rd generation)" tools/simulate-e2e.sh   # 375×667pt，最窄
DSH_SIM_NAME="iPhone 18 Pro Max" tools/simulate-e2e.sh  # 440×956pt，最宽
```

脚本按机型名解析设备（`tools/lib/sim.sh`），截图名带机型后缀 `list-iphone17.png`。
屏宽以 App 的实测日志为准（`DSH_LOG_SCREEN=1` → `build/logs/launch-*.log` 里的
`DSH_SCREEN pt=... scale=... nativeScale=...`），**不要**拿截图像素除 3：
iPhone 13 mini 的 nativeScale 是 2.88，1080×2340px 对应的其实是 375×812pt。

`DSH_PREVIEW_WIDTH` 保留，但只用于同机型上的宽度对照或复现极窄（如 320pt），
常规机型验证一律用真设备。

### 8.6 机型矩阵实测（2026-11-15 夜间，通用运行时装好后）

全部走「真配对 + 真帧 + 真截图」，屏宽取 App 自报的 UIKit bounds，
不是按像素猜的。

| 机型 | 逻辑尺寸 | scale / nativeScale | 安全区 | 结果 |
|---|---|---|---|---|
| iPhone SE (3rd generation) | 375×667 | 2.00 / 2.00 | 20 / 0 | 通过（列表、详情、AX5 大字号） |
| iPhone 13 mini | 375×812 | 3.00 / **2.88** | 50 / 34 | 通过 |
| iPhone 17 | 402×874 | 3.00 / 3.00 | 62 / 34 | 通过（默认机型） |
| iPhone 18 Pro | 402×874 | 3.00 / 3.00 | 62 / 34 | 通过（与 17 同尺寸） |
| iPhone 18 Pro Max | 440×956 | 3.00 / 3.00 | 62 / 34 | 通过 |
| iPad mini (A20 Pro) | 756×1158 | 2.00 / 2.00 | 32 / 20 | 窗口模式（见下） |
| iPhone Duo（旧证据） | 466×678 | 3.00 / 3.00 | — | 矩形折叠屏，宽度不代表任何 iPhone |

两条被实测推翻/纠正的说法：

1. **「截图像素 ÷ 3 = 点宽」错。** 13 mini 的 1080×2340px 对应 375×812pt
   （nativeScale 2.88），按 3 除会得到 360×780pt。屏宽一律读 `DSH_SCREEN` 日志。
2. **手工打包必须自己写 `UIDeviceFamily`。** Xcode 构建会把
   `TARGETED_DEVICE_FAMILY`（当前 `"1,2"`）注入 Info.plist，`tools/build-ios-app.sh`
   原先没注入，iPad 上被当 iPhone App 跑成「小窗 + 壁纸」的兼容模式——
   看到的那张图不是 iPad 布局。现已从工程文件读同一份值写入。

iPad：**要做**（2026-11-16 决定），已实现按宽度自适应的双栏。四条实测坑：

1. **`UIApplicationSupportsMultipleScenes` 必须是 `true`**。iPadOS 26 的窗口化建立
   在多场景之上，写 false 只能拿到一个固定窄窗——看起来像「没适配」。
2. **`NavigationSplitView` 在 iOS 27 上侧栏是浮层**：详情栏仍按整窗宽度排版，
   标题与分段控件左半截被侧栏压住（实测「跑一遍集成测试」只露「成测试」），
   显式 `columnVisibility: .all` 也没用。改成手写 `HStack` 两栏（左 360pt 固定 + 1pt 分隔线）
   才对齐。判断依据是**容器宽度**（≥700pt 分栏），不是机型。
3. **窗口尺寸会被记住**。早先以「iPhone 兼容模式」跑过之后，同一 App 一直复用那个窄窗；
   `simctl erase` 抹掉设备后首次启动即全屏。报「iPad 窗口很小」先排除这条。
4. iPad 保留全方向（横屏才用得开双栏）；iPhone 仍锁竖屏
   （8.7 起改为「按设备形态收紧」：Duo 展开后放开，见下节）。

### 8.7 iPhone Duo 适配（2026-11-16）

产品口径：**Duo 横屏展开 → 与 iPad 同构的左右双栏；展开竖屏 → 竖宽屏单栏。**
它不再是「宽得不讲道理的矩形折叠屏」，而是一块短边 669pt 的大屏。

**两块屏（`simctl io enumerate` 实测）：**

| display | 尺寸 | pt | 说明 |
|---|---|---|---|
| 1（LCD，primary） | 1398×2034 @3x | **466×678** | 合盖外屏；App 默认落在这里 |
| 3（LCD-1） | 2007×2853 @3x | **669×951** | 展开内屏；模拟器里不点亮、姿态不可切 |

**方向策略（`DSHMobileKit/OrientationPolicy.swift`，13 条断言盯着）：**

- 判据 = `isPad || 屏幕短边 ≥ 600`（pt，由 `nativeBounds` 短边 ÷ nativeScale 算出）；
- 短边必须取 **nativeBounds**（物理像素，不随方向变）：取窗口 bounds 会自锁——
  横着时宽度大 → 允许横；转回竖屏宽度小 → 又禁止，永远转不回去；
- 466（Duo 合盖）与 440（18 Pro Max）都在竖屏侧，669 / 756 在放开侧，阈值 600 两边各留 130 余量。

**双层结构，为什么：** 方向支持是全 App 一份的 Info.plist，而需求是
「普通 iPhone 只竖屏、Duo 展开可以横」——同一份安装包两种答案，只能分层：

1. Info.plist：iPhone 声明 portrait + landscapeLeft/Right（**上限**；delegate 只能是它的子集，
   plist 不放开运行时就没得放）；
2. `OrientationGate`（`@UIApplicationDelegateAdaptor`）：运行时按设备形态收紧。

**布局（`LayoutPolicy.swift`，阈值与栏宽已从 App 层搬进 Kit）：**

- 951pt（展开横屏）≥ 700 → 双栏，与 iPad 走同一条代码路径；
- 669pt（展开竖屏）< 700 → 单栏。硬分会让右栏只剩 309pt，标题和分段控件都会挤坏；
- 竖宽屏限宽：单栏正文最大 620pt（`stackMaxContentWidth`）居中——列表用**行 insets**
  （滚动区必须保持全宽，手指落两侧也能滚），详情整页限宽。窄 iPhone（≤440）永远够不到
  620，对这些机型等于无操作。
- 实测坑：List 的 footer 对 `listRowInsets` 不敏感（统计行仍贴默认 16pt，比卡片右缘
  多出一截），要用手动 `.padding(.horizontal, …)` 对齐。

**取证边界（诚实记录）：** 本机 Simulator 无 GUI（Xcode.app 里没有 Simulator.app），
`osascript` 被 SIGTERM，`simctl io screenConfig geometry` 报
`No mode found`（屏幕几何物理固定）——**模拟器无法触发展开/旋转**。
因此：外屏 466 单栏与 669 限宽（iPad 限宽模拟）有真截图；951 双栏由
iPad mini 756 同构验证（同一 `isSplit` 分支、栏宽固定 360，591pt 详情栏比 756 的
395pt 更宽松）+ 断言 `isSplit(951) == true` 兜底。真机展开验证待有 GUI 的 Xcode。

**模拟器重建坑：** 通用运行时 `iOS-27-2` **建不了** Duo（403 Incompatible device——
方向反过来了：通用运行时管普通机型，Duo 只认设备绑定的 `iOS-27-2-iPhone19-4`）。
旧 Duo 设备在运行时替换后会卡「Data Migration Failed」黑屏，删掉重建即可，
`DSH_SIM_NAME="iPhone Duo"` 按名字解析不受 UDID 变化影响。

## 9. 借鉴 dsh-plugin-mobile-gateway 0.12.1（2026-11-16）

宿主考古确认 desktop profile 曾装第三方移动网关（github Clarklevis1995，v0.12.1），
机制可借鉴处已吸收进自研网关后**按用户指令卸载**（备份：`~/.dsh/backup/
dsh-plugin-mobile-gateway-0.12.1.tgz`；node_modules 已删；运行中的实例需重启
DSH Desktop 才会释放 3081——bundle 移除要进程重启，live reload 只管 patch 配置）。

五项借鉴与验收（`gateway/test/borrowed.mjs`，全量 npm test 142 断言 / 0 失败）：

| 机制 | 来源做法 | 我们的落地 | 偏离 |
|---|---|---|---|
| 隧道自动重拉 | 意外退出 10s 重拉 / 二进制失败 30s | 仅「running 后意外退出」重拉（desired=on 才拉）；显式 stop 取消；重拉成功地址漂移照常广播 | 启动失败（超时/缺二进制）不无限重试——能力缺失属环境问题，空转只刷日志 |
| 诊断脱敏 | logTail 里 JWT/token 替换为 [redacted] | `redactSecrets()`：JWT（eyJ…）、dt_ 设备令牌、Bearer/Ticket 值 | — |
| 设备注册表持久化 | gateway-state 原子写（tmp+rename、0600/0700）、损坏 fail-fast | `PairingService({file})`：redeem/revoke 落盘、只存哈希、启动恢复、过期即弃 | **有意偏离 fail-fast**：损坏→备份 `.corrupt-<ts>` 后空表启动（R12：状态文件不能带崩宿主内的插件） |
| pair/revoke 仅本机 | 管理面 loopback-only | revoke 路由加 LOOPBACK 检查（配对码生成此前已收紧）；单元+端到端（经 LAN IP）双路径验证 | — |
| bundle 安装元数据 | package.json dsh.bundle.patch + cordis.patch.yml secure-by-default | `gateway/cordis.patch.yml` + package.json dsh 字段，apply 配置新增 pairingFile / autoRestart（插件形态默认开） | — |

X1 结论不变：**允许**。自研 bundle 走同一安装路径（`dsh plugin --profile desktop add`
或宿主会话 `plugin_manager install_bundle`），装前需先重启 DSH Desktop 让 3081 释放。

## 10. X2 闭环：宿主 mux 方法表考古与 cordis 适配器（2026-11-16）

### 10.1 考古结论（全部来自 app.asar 反编译核对）

**「mux」的真身**：宿主 Gateway（cordis 服务名 `typertGateway`，
@deepseek-ai/dsh-api-gateway）把 Typert RPC 挂在 webServer 的 WebSocket `/api`
上，`RemoteStreamMuxServer` 负责远端流多路复用。RUNBOOK 早前推测的
`/api/remote.mux` HTTP 端点**不存在**（asar 内 16 处 mux 命中全是
dsh-tmux-context，与远程 API 无关）——mux-read 的 WARN 至此有了明确答案。

**RPC 动作全集**（按 namespace 分组，来源：各控制器 `Remote("...")` 装饰器与
`super(ctx, 服务名, { namespace })` 注册）：

| namespace | 动作 | 服务名（cordis） |
|---|---|---|
| session | list / search / create / selectModel / modelCatalog / state / observeState / wait / follow / events / page / prompt / cancel / control / title / rename / fork / projections / canOpenWorkspacePath / openWorkspacePath / attachment … | `sessionController` |
| job | list / follow / kill / registered / settled | `jobController` |
| workspace | create / delete / follow / changes / pinSession / archiveSession / insertSessionBefore … | `workspaceController` |
| terminal | create / list / attach / watch / environment / shells / close / retain … | `terminalController` |
| settings | describe / update / mutate / replace / openSettingsDocument | `settingsController` |
| remoteAccess | follow（每 Peer 访问快照） | `remoteAccess` |
| fileReferences / skills / credentials | … | `sessionFileReferences` / `sessionSkillCatalog` / `credentialsController` |

**进程内路径（我们采用的）**：插件与控制器同处宿主进程、同一 cordis 上下文树；
loader 给插件的是根上下文的子上下文，`ctx.get("sessionController")` 向上解析即达。
principalOf 语义：进程内非 Remote 调用视同 owner，不受 remoteAccess 策略限制。

### 10.2 映射表（gateway/src/adapter/cordis-host.mjs，插件形态 `host: mux`）

| 我们的方法 | 宿主动作 | 形状要点 | 如实边界 |
|---|---|---|---|
| listTasks | session/list | summary：sessionId / updatedAt / agentAvailable / running / blank / cwd / projections | 冷会话（无 live agent）过滤——移动端看活动任务，历史走 session/page 再接 |
| getTask | session/list（summary 组装） | iOS 端 detail 除 task 外全可选解码 | budget/pendingTodos 如实缺省 |
| createTask | session/create + session/prompt | prompt:{sessionId, requestId, content:[{type:'text',text}], mode:'queue'} | cwd 可指定 |
| appendMessage | session/prompt | 运行中 steer；session/agent-busy 回落 queue；not-found 不回落 | — |
| cancelTask | session/cancel | {sessionId} → {accepted:true}；仅对附着的 live 会话有效 | 冷会话 → 宿主 not-found → 4011 |
| answerTodo | （未映射） | 宿主审批面走 session/control，请求形状 v2 考古 | **4021**，绝不假装成功 |
| listArtifacts | （未映射） | workspace/* 是文件系统面，语义不同 | **4021** |
| subscribe | （未接线） | 推送面 = Gateway WS `/api` + session/events、observeState 生成器 | v1 无事件流，log 声明 |
| needsYou | （无法判定） | 宿主 summary 不暴露审批态 | **恒 false**，不编造 |

**错误翻译**：宿主 RemoteError（isDSHRemoteError + code）→ 我们的协议码：
session/not-found→4011，session/agent-busy→4007，gateway/bad-request→4400，
gateway/internal→4500；协议自身的 GatewayError 原样透传。

**status 映射**：running→`running`；live 空闲（agent 附着但没在跑）→`idle`（手机端
「空闲 · 可续」）。**不要**映射成 `interrupted`：宿主 summary 只有
`{sessionId, updatedAt, agentAvailable, running, blank, cwd, projections}`，
不区分「上一回合说完了」和「被杀了」，替它断言中断会让每个空闲会话都顶着告警徽标
（2026-11-17 真机反馈）。真正的中断由客户端侧证据产生：WS 换 gen 且任务原本在跑。
needsYou 态待 session/control 接入后补。

### 10.3 证据与验收

- `diag` 暴露服务可见性快照（present/missing 清单）——真宿主里跑一次就是
  X2 的运行时证据（caps 同步进 host.info）。
- `test/mux-table.mjs`：32 断言（映射 + steer/queue 回落 + 错误翻译 +
  4021 如实降级 + 服务缺失指名），全量 npm test **174 断言 / 0 失败**。
- 插件烟测：`apply(ctx, {host:'mux'})` → adapter kind=cordis → health ok →
  dispose 清理钩子在位。
- **待真宿主实跑**：desktop profile 里把 cordis.patch.yml 的 `host: mux`
  打开即可用真实会话验证——需要你在宿主里建几个会话后对照 diag 输出。
