// main.swift — Spike-0 演示客户端（Foundation 原生协议栈，无第三方依赖）
// 目的：用 Apple 自己的 HTTP/WS 栈跑一遍握手，证明契约不是"只有自家 Node 客户端能对上"。
// 只做只读链路：health → 配对 → 票据 → WS 握手 → 收 3 帧事件。
//
// 编译：swiftc -O main.swift -o /tmp/dsh-demo
// 运行：/tmp/dsh-demo --port 3081

import Foundation

// MARK: - 参数

var port = 3081
var verbose = false
var argv = CommandLine.arguments.dropFirst()
while let a = argv.popFirst() {
    if a == "--port", let v = argv.popFirst(), let n = Int(v) { port = n }
    else if a == "--verbose" { verbose = true }
}
let base = "http://127.0.0.1:\(port)"

// MARK: - 输出与断言

var failures: [String] = []
func ok(_ step: String, _ detail: String = "") {
    print("PASS \(step)\(detail.isEmpty ? "" : " — \(detail)")")
}
func bad(_ step: String, _ detail: String) {
    failures.append("\(step): \(detail)")
    print("FAIL \(step) — \(detail)")
}
func note(_ s: String) { if verbose { print("     \(s)") } }

// MARK: - HTTP（同步封装）

struct HTTPResult { let status: Int; let json: [String: Any]?; let raw: String }

func http(_ method: String, _ path: String, body: [String: Any]? = nil, token: String? = nil) -> HTTPResult? {
    guard let url = URL(string: base + path) else { return nil }
    var req = URLRequest(url: url)
    req.httpMethod = method
    req.timeoutInterval = 6
    if let body {
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
    }
    if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }

    let sem = DispatchSemaphore(value: 0)
    var out: HTTPResult?
    URLSession.shared.dataTask(with: req) { data, resp, err in
        defer { sem.signal() }
        guard let http = resp as? HTTPURLResponse, let data else {
            if let err { note("http error \(err.localizedDescription)") }
            return
        }
        let raw = String(data: data, encoding: .utf8) ?? ""
        out = HTTPResult(status: http.statusCode, json: (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], raw: raw)
    }.resume()
    _ = sem.wait(timeout: .now() + 8)
    return out
}

// MARK: - WS 帧收集（URLSessionWebSocketTask 回调在后台队列）

final class Inbox {
    private let lock = NSLock()
    private var raw: [String] = []
    private var parsed: [[String: Any]] = []
    private var closed = false
    private var failure: String?
    func push(_ s: String) { lock.lock(); raw.append(s); lock.unlock() }
    func fail(_ s: String) { lock.lock(); failure = s; lock.unlock() }
    func close() { lock.lock(); closed = true; lock.unlock() }
    var isClosed: Bool { lock.lock(); let v = closed; lock.unlock(); return v }
    var error: String? { lock.lock(); let v = failure; lock.unlock(); return v }

    /// 逐帧取，不多取：多取会把后续事件"吃掉"，制造假通过
    func next(_ timeout: Double) -> [String: Any]? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            lock.lock()
            if !parsed.isEmpty {
                let v = parsed.removeFirst()
                lock.unlock()
                return v
            }
            let batch = raw
            raw = []
            lock.unlock()

            if !batch.isEmpty {
                var decoded: [[String: Any]] = []
                for s in batch {
                    if let d = s.data(using: .utf8), let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] {
                        decoded.append(j)
                    }
                }
                if !decoded.isEmpty {
                    lock.lock()
                    parsed.append(contentsOf: decoded)
                    lock.unlock()
                    continue
                }
            }
            usleep(15_000)
        }
        return nil
    }
}

func openSocket(ticket: String?, token: String?) -> (URLSessionWebSocketTask, Inbox)? {
    guard let url = URL(string: "ws://127.0.0.1:\(port)/ws/mobile") else { return nil }
    var req = URLRequest(url: url)
    req.timeoutInterval = 8
    if let ticket {
        // ADR-13：ticket 走子协议/鉴权头，不进 URL。
        // 同时给两条路：URLSession 对自定义 Sec-WebSocket-Protocol 的处理不稳定，
        // 服务端两边都认，任一命中即可。
        req.setValue("dsh.v1, ticket.\(ticket)", forHTTPHeaderField: "Sec-WebSocket-Protocol")
        req.setValue("Ticket \(ticket)", forHTTPHeaderField: "Authorization")
    } else if let token {
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }

    let task = URLSession.shared.webSocketTask(with: req)
    let inbox = Inbox()
    task.resume()

    func pump() {
        task.receive { result in
            switch result {
            case .success(let msg):
                switch msg {
                case .string(let s): inbox.push(s)
                case .data(let d): inbox.push(String(data: d, encoding: .utf8) ?? "")
                @unknown default: break
                }
                pump()
            case .failure(let err):
                inbox.fail(err.localizedDescription)
                inbox.close()
            }
        }
    }
    pump()
    return (task, inbox)
}

func collect(_ inbox: Inbox, count: Int, timeout: Double, where match: (([String: Any]) -> Bool)? = nil) -> [[String: Any]] {
    var out: [[String: Any]] = []
    let deadline = Date().addingTimeInterval(timeout)
    while out.count < count && Date() < deadline {
        guard let f = inbox.next(max(0.05, deadline.timeIntervalSinceNow)) else { break }
        if match == nil || match!(f) { out.append(f) }
    }
    return out
}

// MARK: - 主流程

print("DSH-mobile Spike-0 客户端 · \(base)")

// 1. health
guard let health = http("GET", "/mobile/v1/health"), health.status == 200 else {
    bad("health", "网关未响应（先启动 entries/sidecar.mjs）")
    exit(1)
}
ok("health", "version=\(health.json?["version"] ?? "?")")

// 2. 配对（本机回环才能生成码）
guard let codeRes = http("POST", "/mobile/v1/pairing/code", body: ["deviceName": "Swift Spike-0"]),
      codeRes.status == 201,
      let code = codeRes.json?["code"] as? String else {
    bad("pairing.code", "生成配对码失败")
    exit(1)
}
ok("pairing.code", "code=\(code)")

let installId = "ins_swift_\(UUID().uuidString.prefix(8).lowercased())"
let redeemRes = http("POST", "/mobile/v1/pairing/redeem", body: [
    "code": code, "installId": installId, "deviceName": "Swift Spike-0", "platform": "ios", "appVersion": "spike0",
])
guard let redeem = redeemRes, redeem.status == 200, let token = redeem.json?["deviceToken"] as? String else {
    bad("pairing.redeem", "兑换失败 \(redeemRes?.raw ?? "")")
    exit(1)
}
let caps = (redeem.json?["caps"] as? [String]) ?? []
ok("pairing.redeem", "deviceId=\(redeem.json?["deviceId"] ?? "?") caps=\(caps.count)")

// 3. 票据（能力探测：宿主没声明 ws.ticket 时降级用 Bearer）
var ticket: String?
if caps.contains("ws.ticket") {
    ticket = (http("POST", "/mobile/v1/ws-ticket", token: token)?.json?["ticket"] as? String)
}
if ticket == nil { note("未拿到票据，降级用 Authorization 头") }

// 4. WS 握手
guard let (task, inbox) = openSocket(ticket: ticket, token: token) else {
    bad("ws.connect", "无法构造 WebSocket 任务")
    exit(1)
}
usleep(120_000)

guard let deviceId = redeem.json?["deviceId"] as? String else { exit(1) }
let hello: [String: Any] = ["t": "hello", "protocolVersion": "1.0", "caps": ["tasks.read"], "deviceId": deviceId, "installId": installId, "lastSeq": 0]
task.send(.string(String(data: try! JSONSerialization.data(withJSONObject: hello), encoding: .utf8)!)) { err in
    if let err { inbox.fail("send hello: \(err.localizedDescription)") }
}

let first = collect(inbox, count: 1, timeout: 5)
guard let ready = first.first else {
    bad("ws.hello", "未收到 ready（\(inbox.error ?? "超时")）")
    exit(1)
}
if ready["t"] as? String == "reject" {
    bad("ws.hello", "被拒 code=\(ready["code"] ?? "?") \(ready["message"] ?? "")")
    exit(1)
}
if ready["t"] as? String != "ready" {
    bad("ws.hello", "首帧不是 ready：\(ready)")
    exit(1)
}
ok("ws.hello", "host=\(ready["hostName"] ?? "?") v\(ready["hostVersion"] ?? "?") gen=\(ready["gen"] ?? "?") resumeFrom=\(ready["resumeFrom"] ?? "?")")

// 5. 收事件（握手时网关按游标回放；空则视为失败，不允许"没数据也算过"）
let events = collect(inbox, count: 3, timeout: 3) { ($0["t"] as? String) == "ev" }
if events.isEmpty {
    bad("ws.events", "连接成功但未收到任何事件（检查游标/环形缓冲）")
} else {
    let seqs = events.compactMap { $0["seq"] as? Int }
    let kinds = Set(events.compactMap { $0["kind"] as? String })
    ok("ws.events", "收到 \(events.count) 帧 seq=\(seqs) kinds=\(kinds.sorted().joined(separator: ","))")
}

// 6. 控制调用
let reqId = "swift_\(Int(Date().timeIntervalSince1970))"
task.send(.string("{\"t\":\"req\",\"id\":\"\(reqId)\",\"method\":\"ping\"}")) { _ in }
let pong = collect(inbox, count: 1, timeout: 3) { ($0["t"] as? String) == "res" && ($0["id"] as? String) == reqId }
if pong.isEmpty { bad("ws.req.ping", "未收到 res") } else { ok("ws.req.ping") }

task.cancel(with: .goingAway, reason: nil)

print("")
if failures.isEmpty {
    print("结论：客户端侧只读链路全部通过（\(failures.count) 失败）")
    exit(0)
} else {
    print("结论：\(failures.count) 项失败")
    for f in failures { print("  - \(f)") }
    exit(1)
}
