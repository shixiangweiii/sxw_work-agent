// Atlas GUI Helper —— computer use 的本机驱动（ADR-0013）。
//
// ══════════════════════════════════════════════════════════════════════
// 【定】它只提供**原语**：截图、查某点是什么窗口、比对一块区域变没变、
// 读 AX 控件、投递事件。「该不该做」的判定全部在 TS 侧（tools/computer/src/handler.ts）——
// 判定写在这里的话，验收脚本只能拿假驱动去模仿它，测的就不是真逻辑了。
//
// 它自己只再判一件事：**硬拒绝名单与白名单**（投递事件前）。那是第二道闸门，
// 与 run_shell 的「命令分析 ＋ 沙箱」两道同构 —— 第一道判错是多问一次，
// 第二道判错是真的没有边界，所以第二道不信任第一道。
//
// 【定】它是一个**独立的 .app**（固定 bundle id，ad-hoc 签名），由 LaunchServices
// 启动（`open -n -g -a`），于是「辅助功能」「录屏」两项系统授权记在**它**名下，
// 而不是记在启动 Atlas 的那个终端名下（TCC 的负责进程规则）。给终端开辅助功能，
// 等于让那个终端里启动的一切进程都能操控整台电脑。
//
// 【定】只接受**启动它的那个 Atlas 进程**的连接（LOCAL_PEERPID 校验），
// 那个进程退出它就退出。否则任何同用户进程都能借它的授权截屏、点击 ——
// 一个被授了权的助手，最怕的就是变成别人的跳板。
//
// 公开 API only：不用 SkyLight 等私有框架（后台点击那条路在 Intel 上有已知崩溃，
// 且随系统更新随时失效）。前台模式：会移动真实光标。
// ══════════════════════════════════════════════════════════════════════

import AppKit
import ApplicationServices
import Carbon
import CoreGraphics
import Foundation
@preconcurrency import ScreenCaptureKit

let PROTOCOL_VERSION = "1"

// MARK: - 参数与日志

var socketPath = ""
var clientPid: pid_t = 0
var logPath: String? = nil
do {
  var it = CommandLine.arguments.dropFirst().makeIterator()
  while let a = it.next() {
    switch a {
    case "--socket": socketPath = it.next() ?? ""
    case "--client-pid": clientPid = pid_t(it.next() ?? "") ?? 0
    case "--log": logPath = it.next()
    default: break
    }
  }
}

func log(_ s: String) {
  guard let p = logPath else { return }
  let line = "[\(Date())] \(s)\n"
  if let h = FileHandle(forWritingAtPath: p) {
    h.seekToEndOfFile()
    h.write(line.data(using: .utf8)!)
    try? h.close()
  } else {
    FileManager.default.createFile(atPath: p, contents: line.data(using: .utf8))
  }
}

if socketPath.isEmpty || clientPid <= 0 {
  FileHandle.standardError.write("用法：AtlasGUIHelper --socket <path> --client-pid <pid> [--log <path>]\n".data(using: .utf8)!)
  exit(2)
}

struct HelperError: Error {
  let code: String
  let message: String
}

final class Box<T>: @unchecked Sendable {
  var value: T?
}

// MARK: - 硬拒绝名单（第二道；与 tools/computer/src/config.ts 同一份清单）

let HARD_DENIED_PREFIXES: [String] = [
  "com.apple.Terminal", "com.googlecode.iterm2", "dev.warp.", "net.kovidgoyal.kitty", "io.alacritty",
  "org.alacritty", "com.github.wez.wezterm", "com.mitchellh.ghostty", "co.zeit.hyper",
  "com.jetbrains.", "com.google.android.studio", "com.microsoft.VSCode", "com.visualstudio.code",
  "com.todesktop.", "com.exafunction.windsurf", "dev.zed.", "com.apple.dt.Xcode", "com.sublimetext.",
  "com.anthropic.", "com.workagent.",
  "com.apple.keychainaccess", "com.apple.Passwords", "com.1password.", "com.agilebits.",
  "com.bitwarden.", "com.lastpass.", "com.dashlane.", "com.apple.systempreferences",
  "com.apple.Settings", "com.apple.SecurityAgent", "com.apple.loginwindow",
  "com.apple.LocalAuthentication", "com.apple.coreservices.uiagent",
]

/// 浏览器：唯一可以被显式放开的一类（ADR-0015，CLI 的 --computer-allow-browsers）。
/// 放开时仍然要求它在白名单里（`allow.contains`），这里只是不再把它当硬拒绝。
let BROWSER_PREFIXES: [String] = [
  "com.apple.Safari", "com.google.Chrome", "org.chromium.", "org.mozilla.", "com.microsoft.edgemac",
  "com.brave.", "company.thebrowser.", "com.operasoftware.", "com.vivaldi.",
]

func prefixHit(_ bundleId: String, _ list: [String]) -> Bool {
  for p in list where p.hasSuffix(".") ? bundleId.hasPrefix(p) : (bundleId == p || bundleId.hasPrefix(p + ".")) {
    return true
  }
  return false
}

func hardDenied(_ bundleId: String, allowBrowsers: Bool = false) -> Bool {
  if bundleId.isEmpty { return false }
  if prefixHit(bundleId, HARD_DENIED_PREFIXES) { return true }
  return !allowBrowsers && prefixHit(bundleId, BROWSER_PREFIXES)
}

// MARK: - 显示器与窗口

struct DisplayGeometry {
  let widthPt: Double
  let heightPt: Double
  let scale: Double
}

func mainDisplay() -> DisplayGeometry {
  let id = CGMainDisplayID()
  let b = CGDisplayBounds(id)
  let mode = CGDisplayCopyDisplayMode(id)
  let pxW = Double(mode?.pixelWidth ?? Int(b.width))
  return DisplayGeometry(widthPt: Double(b.width), heightPt: Double(b.height), scale: b.width > 0 ? pxW / Double(b.width) : 1)
}

func bundleIdOf(pid: pid_t) -> String {
  NSRunningApplication(processIdentifier: pid)?.bundleIdentifier ?? ""
}

/// 屏幕上的窗口，前到后排序（CGWindowList 的返回顺序）。逻辑点、全局坐标。
func windowList() -> [[String: Any]] {
  let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  guard let info = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { return [] }
  var out: [[String: Any]] = []
  for w in info {
    let alpha = (w[kCGWindowAlpha as String] as? Double) ?? 1
    if alpha <= 0.01 { continue }
    guard let bd = w[kCGWindowBounds as String] as? NSDictionary,
          let rect = CGRect(dictionaryRepresentation: bd as CFDictionary) else { continue }
    if rect.width < 1 || rect.height < 1 { continue }
    let pid = (w[kCGWindowOwnerPID as String] as? Int).map { pid_t($0) } ?? 0
    var item: [String: Any] = [
      "windowId": (w[kCGWindowNumber as String] as? Int) ?? 0,
      "pid": Int(pid),
      "bundleId": bundleIdOf(pid: pid),
      "appName": (w[kCGWindowOwnerName as String] as? String) ?? "",
      "x": Double(rect.origin.x),
      "y": Double(rect.origin.y),
      "width": Double(rect.width),
      "height": Double(rect.height),
      "layer": (w[kCGWindowLayer as String] as? Int) ?? 0,
    ]
    if let t = w[kCGWindowName as String] as? String, !t.isEmpty { item["title"] = t }
    out.append(item)
  }
  return out
}

func windowAt(_ x: Double, _ y: Double, in list: [[String: Any]]) -> [String: Any]? {
  for w in list {
    let wx = w["x"] as! Double, wy = w["y"] as! Double
    let ww = w["width"] as! Double, wh = w["height"] as! Double
    if x >= wx && x < wx + ww && y >= wy && y < wy + wh { return w }
  }
  return nil
}

/// 可选值 → JSON（nil 写成 null）。
func orNull(_ v: [String: Any]?) -> Any { v.map { $0 as Any } ?? NSNull() }

func appRef(_ app: NSRunningApplication?) -> [String: Any]? {
  guard let a = app else { return nil }
  return ["bundleId": a.bundleIdentifier ?? "", "name": a.localizedName ?? "", "pid": Int(a.processIdentifier)]
}

/// 此刻的前台应用，**每次现查**。
///
/// 【定】不读 `NSWorkspace.shared.frontmostApplication`：本进程跑在 `dispatchMain()` 上，主 run loop
/// 不转，NSWorkspace 的前台状态停在它第一次被读的那一刻。第三次真桌面运行（run_73db9f5de54f）：
/// 激活计算器、文本编辑之后，每张截图仍报「Claude」，于是所有键盘输入都被当成发给 Agent 宿主而拒绝 ——
/// 判定是对的，喂给判定的事实是旧的。
/// 改问辅助功能（系统级 AXUIElement 的焦点应用，本来就持有这项授权）；读不到再退到
/// 窗口表里最上层的普通窗口（layer 0）的主人。两者都是现查的。
func frontmostApp() -> NSRunningApplication? {
  let sys = AXUIElementCreateSystemWide()
  var value: CFTypeRef?
  if AXUIElementCopyAttributeValue(sys, kAXFocusedApplicationAttribute as CFString, &value) == .success,
     let v = value, CFGetTypeID(v) == AXUIElementGetTypeID() {
    var pid: pid_t = 0
    if AXUIElementGetPid(v as! AXUIElement, &pid) == .success, pid > 0,
       let app = NSRunningApplication(processIdentifier: pid) {
      return app
    }
  }
  for w in windowList() where (w["layer"] as? Int) == 0 {
    if let pid = w["pid"] as? Int, let app = NSRunningApplication(processIdentifier: pid_t(pid)) { return app }
  }
  return nil
}

// MARK: - 截图（ScreenCaptureKit，只截白名单应用的窗口）

struct StoredShot {
  let image: CGImage
  let allow: [String]
  let width: Int
  let height: Int
  let display: DisplayGeometry
  /// 这张图实际覆盖的屏幕区域（逻辑点）。像素 ↔ 点的换算一律经它，不假设它等于整块显示器。
  let rect: CGRect
}

var shots: [(String, StoredShot)] = []
let MAX_SHOTS = 4

func targetSize(_ d: DisplayGeometry, maxLongEdge: Int) -> (Int, Int) {
  let pxW = d.widthPt * d.scale, pxH = d.heightPt * d.scale
  let longPx = max(pxW, pxH)
  let edge = min(Double(maxLongEdge), longPx)
  let k = edge / longPx
  return (max(2, Int((pxW * k).rounded())), max(2, Int((pxH * k).rounded())))
}

/// 截一张**整块主显示器**的图，只留白名单应用的窗口。返回图与它覆盖的区域（逻辑点）。
///
/// 【定】用「排除其余所有应用」的过滤器，不用「只包含白名单应用」的那个（ADR-0014 附带修复）。
/// 2026-10-03 第一次真桌面运行实测（macOS 26.6）：`SCContentFilter(display:including:)` 截的
/// **不是整块显示器**，而是白名单窗口的外接矩形、再等比放大塞进输出尺寸 —— 计算器在窗口表里是
/// (446,559) 230×408 pt，在图里是 (318,605) 290×515 px（×1.26 加平移）。而 Atlas 按「图 = 整块
/// 显示器」换算坐标，于是每一下都点偏、并且不报错；白名单窗口一个都不在当前桌面时外接矩形为空，
/// 截图直接抛 -3811。两件事是同一个原因。
/// 排除式过滤器（按窗口排除，见函数体里那条）以显示器为内容区：白名单应用不在屏幕上时得到一张空白图（handler 会如实提示），
/// 而不是一个错误。`sourceRect` 也显式写成整块显示器，并把它报回去 —— 换算依据报回来的事实，
/// 不依据「应该是整块显示器」这个假设。
///
/// 【定】`verifyNoLeak`：截完**再列一次窗口**，有排除表之外的白名单外窗口就重截（2026-10-03 代码评审 CU-R04）。
/// 排除表是截图之前那一刻的窗口快照，而 `SCContentFilter(display:excludingWindows:)` 的契约是「整块显示器，
/// 只排除传入的那些窗口」（SDK `SCStream.h`）—— 列完之后、截图之前冒出来的通知或新窗口不在表里，会进图，
/// 而那张图要发往模型端点。截图那一刻在屏幕上的窗口，截完之后一般还在，所以第二次列表能抓到它。
/// 不退回「只包含白名单应用」的过滤器：第一次真桌面运行的几何错位正是在那个过滤器上发生的，
/// 而当时换过滤器与加 `sourceRect` 是同一次改动，分不清是哪一个修好的 —— 几何错了不报错，只会每一下都点偏。
/// 剩余盲区如实写：一个窗口在两次列表之间（几十毫秒）出现又消失，查不到。
/// 只有发给模型的那张图要查（`capture`）；`probe` 比对画面差的那张不出助手，不查。
func captureImage(allow: [String], width: Int, height: Int, verifyNoLeak: Bool = false) throws -> (CGImage, CGRect) {
  if !CGPreflightScreenCaptureAccess() {
    throw HelperError(code: "PERMISSION_REQUIRED", message: "没有「录屏与系统录音」授权")
  }
  let sem = DispatchSemaphore(value: 0)
  let box = Box<Result<(CGImage, CGRect), Error>>()
  Task.detached {
    do {
      // 【定】按**窗口**排除，而且把桌面窗口也列进来（excludingDesktopWindows: false）。
      // 第二次真桌面实测：「排除其余应用」的过滤器配 excludingDesktopWindows(true) 时，桌面图标层
      // 不在可共享列表里、也就不会被排除 —— 用户桌面上的文件夹名与文件名进了发往模型端点的图。
      // 现在的规则只有一条：不属于白名单应用的窗口（含桌面图标、无主窗口）一律排除。
      let notAllowed: (SCWindow) -> Bool = { w in !allow.contains(w.owningApplication?.bundleIdentifier ?? "") }
      var leaked: [SCWindow] = []
      var clean: (CGImage, CGRect)? = nil
      for _ in 0..<3 where clean == nil {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let mainId = CGMainDisplayID()
        guard let display = content.displays.first(where: { $0.displayID == mainId }) ?? content.displays.first else {
          throw HelperError(code: "NO_DISPLAY", message: "找不到主显示器")
        }
        let excluded = content.windows.filter(notAllowed)
        let filter = SCContentFilter(display: display, excludingWindows: excluded)
        let full = CGRect(x: 0, y: 0, width: CGFloat(display.width), height: CGFloat(display.height))
        let config = SCStreamConfiguration()
        config.width = width
        config.height = height
        config.sourceRect = full
        config.showsCursor = false
        config.capturesAudio = false
        let img = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        let frame = CGDisplayBounds(display.displayID)
        let displayFrame = CGRect(x: frame.minX, y: frame.minY, width: full.width, height: full.height)
        if !verifyNoLeak {
          clean = (img, displayFrame)
          break
        }
        let excludedIds = Set(excluded.map { $0.windowID })
        let after = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        leaked = after.windows.filter { w in
          notAllowed(w) && !excludedIds.contains(w.windowID) && w.frame.intersects(displayFrame)
        }
        if leaked.isEmpty {
          clean = (img, displayFrame)
        } else {
          log("截图期间出现了排除表之外的窗口，重截：\(leaked.map { $0.owningApplication?.bundleIdentifier ?? "（无主）" })")
        }
      }
      guard let got = clean else {
        let who = Set(leaked.map { $0.owningApplication?.applicationName ?? "（无主窗口）" }).sorted().joined(separator: "、")
        throw HelperError(code: "CAPTURE_UNSTABLE",
                          message: "截图期间不断有白名单外的新窗口出现（\(who)），为了不把它们截进发给模型的图里，这次不出图。稍等再截")
      }
      box.value = .success(got)
    } catch {
      box.value = .failure(error)
    }
    sem.signal()
  }
  if sem.wait(timeout: .now() + 20) == .timedOut {
    throw HelperError(code: "CAPTURE_TIMEOUT", message: "截图超时")
  }
  return try box.value!.get()
}

func pngData(_ img: CGImage) throws -> Data {
  let rep = NSBitmapImageRep(cgImage: img)
  guard let data = rep.representation(using: .png, properties: [:]) else {
    throw HelperError(code: "ENCODE_FAILED", message: "PNG 编码失败")
  }
  return data
}

/// 两张同尺寸截图在某点附近的平均灰度差（0–255）。
func regionDiff(_ a: CGImage, _ b: CGImage, cx: Double, cy: Double, radiusPx: Double) -> Double {
  let w = Double(a.width), h = Double(a.height)
  let x0 = max(0, cx - radiusPx), y0 = max(0, cy - radiusPx)
  let x1 = min(w, cx + radiusPx), y1 = min(h, cy + radiusPx)
  let rw = Int(x1 - x0), rh = Int(y1 - y0)
  if rw <= 0 || rh <= 0 { return 0 }
  func gray(_ img: CGImage) -> [UInt8]? {
    guard let cropped = img.cropping(to: CGRect(x: x0, y: y0, width: Double(rw), height: Double(rh))) else { return nil }
    var buf = [UInt8](repeating: 0, count: rw * rh)
    let ok = buf.withUnsafeMutableBytes { ptr -> Bool in
      guard let ctx = CGContext(data: ptr.baseAddress, width: rw, height: rh, bitsPerComponent: 8, bytesPerRow: rw,
                                space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return false }
      ctx.draw(cropped, in: CGRect(x: 0, y: 0, width: rw, height: rh))
      return true
    }
    return ok ? buf : nil
  }
  guard let ga = gray(a), let gb = gray(b) else { return 255 }
  var sum = 0
  for i in 0..<ga.count { sum += abs(Int(ga[i]) - Int(gb[i])) }
  return Double(sum) / Double(ga.count)
}

// MARK: - 应用解析

func resolveApp(_ query: String) -> [String: Any] {
  var r: [String: Any] = ["query": query, "running": false]
  let running = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
  if query.contains(".") {
    if let a = running.first(where: { $0.bundleIdentifier == query }) {
      r["bundleId"] = query; r["name"] = a.localizedName ?? query; r["running"] = true
    } else if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: query) {
      r["bundleId"] = query; r["name"] = FileManager.default.displayName(atPath: url.path).replacingOccurrences(of: ".app", with: "")
    }
    return r
  }
  let q = query.lowercased()
  if let a = running.first(where: { ($0.localizedName ?? "").lowercased() == q }) {
    r["bundleId"] = a.bundleIdentifier ?? ""; r["name"] = a.localizedName ?? query; r["running"] = true
    return r
  }
  let home = FileManager.default.homeDirectoryForCurrentUser.path
  let dirs = ["/Applications", "/System/Applications", "/System/Applications/Utilities", "/Applications/Utilities", "\(home)/Applications"]
  for d in dirs {
    guard let items = try? FileManager.default.contentsOfDirectory(atPath: d) else { continue }
    for item in items where item.lowercased() == "\(q).app" {
      let path = "\(d)/\(item)"
      if let b = Bundle(path: path), let bid = b.bundleIdentifier {
        r["bundleId"] = bid
        r["name"] = FileManager.default.displayName(atPath: path).replacingOccurrences(of: ".app", with: "")
        r["running"] = running.contains(where: { $0.bundleIdentifier == bid })
        return r
      }
    }
  }
  return r
}

// MARK: - AX

func axString(_ el: AXUIElement, _ name: String) -> String? {
  var v: CFTypeRef?
  guard AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success, let val = v else { return nil }
  if let s = val as? String { return s.isEmpty ? nil : String(s.prefix(200)) }
  if let n = val as? NSNumber { return n.stringValue }
  return nil
}

func elementAt(_ x: Double, _ y: Double) -> [String: Any]? {
  guard AXIsProcessTrusted() else { return nil }
  let sys = AXUIElementCreateSystemWide()
  var el: AXUIElement?
  guard AXUIElementCopyElementAtPosition(sys, Float(x), Float(y), &el) == .success, let e = el else { return nil }
  var out: [String: Any] = [:]
  if let v = axString(e, kAXRoleAttribute) { out["role"] = v }
  if let v = axString(e, kAXTitleAttribute) { out["title"] = v }
  if let v = axString(e, kAXDescriptionAttribute) { out["description"] = v }
  if let v = axString(e, kAXValueAttribute) { out["value"] = v }
  return out
}

// MARK: - 事件投递

let eventSource = CGEventSource(stateID: .hidSystemState)

func postMouse(_ type: CGEventType, _ p: CGPoint, _ button: CGMouseButton, _ clickState: Int64) {
  guard let e = CGEvent(mouseEventSource: eventSource, mouseType: type, mouseCursorPosition: p, mouseButton: button) else { return }
  e.setIntegerValueField(.mouseEventClickState, value: clickState)
  e.post(tap: .cghidEventTap)
}

let KEYCODES: [String: Int] = [
  "a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D, "e": kVK_ANSI_E, "f": kVK_ANSI_F,
  "g": kVK_ANSI_G, "h": kVK_ANSI_H, "i": kVK_ANSI_I, "j": kVK_ANSI_J, "k": kVK_ANSI_K, "l": kVK_ANSI_L,
  "m": kVK_ANSI_M, "n": kVK_ANSI_N, "o": kVK_ANSI_O, "p": kVK_ANSI_P, "q": kVK_ANSI_Q, "r": kVK_ANSI_R,
  "s": kVK_ANSI_S, "t": kVK_ANSI_T, "u": kVK_ANSI_U, "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X,
  "y": kVK_ANSI_Y, "z": kVK_ANSI_Z,
  "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3, "4": kVK_ANSI_4,
  "5": kVK_ANSI_5, "6": kVK_ANSI_6, "7": kVK_ANSI_7, "8": kVK_ANSI_8, "9": kVK_ANSI_9,
  "return": kVK_Return, "tab": kVK_Tab, "space": kVK_Space, "escape": kVK_Escape,
  "delete": kVK_Delete, "forwarddelete": kVK_ForwardDelete,
  "up": kVK_UpArrow, "down": kVK_DownArrow, "left": kVK_LeftArrow, "right": kVK_RightArrow,
  "home": kVK_Home, "end": kVK_End, "pageup": kVK_PageUp, "pagedown": kVK_PageDown,
  "minus": kVK_ANSI_Minus, "equal": kVK_ANSI_Equal, "leftbracket": kVK_ANSI_LeftBracket,
  "rightbracket": kVK_ANSI_RightBracket, "semicolon": kVK_ANSI_Semicolon, "quote": kVK_ANSI_Quote,
  "comma": kVK_ANSI_Comma, "period": kVK_ANSI_Period, "slash": kVK_ANSI_Slash,
  "backslash": kVK_ANSI_Backslash, "grave": kVK_ANSI_Grave,
  "f1": kVK_F1, "f2": kVK_F2, "f3": kVK_F3, "f4": kVK_F4, "f5": kVK_F5, "f6": kVK_F6,
  "f7": kVK_F7, "f8": kVK_F8, "f9": kVK_F9, "f10": kVK_F10, "f11": kVK_F11, "f12": kVK_F12,
]

func pidAllowed(_ pid: pid_t, _ allow: [String], allowBrowsers: Bool) -> Bool {
  let bid = bundleIdOf(pid: pid)
  return !bid.isEmpty && allow.contains(bid) && !hardDenied(bid, allowBrowsers: allowBrowsers)
}

/// 返回 nil = 已投递；否则是拒绝原因（保证什么都没投递）。
func perform(_ a: [String: Any], allow: [String], allowBrowsers: Bool) throws -> (String, String)? {
  guard AXIsProcessTrusted() else { return ("PERMISSION_REQUIRED", "没有「辅助功能」授权，事件不会被系统接收") }
  let kind = a["kind"] as? String ?? ""
  func pointTarget(_ x: Double, _ y: Double) -> (String, String)? {
    guard let w = windowAt(x, y, in: windowList()) else { return ("TARGET_NOT_ALLOWED", "该处没有窗口") }
    let bid = w["bundleId"] as? String ?? ""
    if hardDenied(bid, allowBrowsers: allowBrowsers) { return ("TARGET_DENIED", "该处是硬拒绝名单上的应用（\(bid)）") }
    if !allow.contains(bid) { return ("TARGET_NOT_ALLOWED", "该处的应用不在白名单（\(bid)）") }
    return nil
  }
  switch kind {
  case "click":
    let x = a["x"] as? Double ?? -1, y = a["y"] as? Double ?? -1
    if let r = pointTarget(x, y) { return r }
    let right = (a["button"] as? String) == "right"
    let count = (a["count"] as? Int) ?? 1
    let p = CGPoint(x: x, y: y)
    postMouse(.mouseMoved, p, .left, 0)
    usleep(40_000)
    for i in 1...max(1, min(2, count)) {
      postMouse(right ? .rightMouseDown : .leftMouseDown, p, right ? .right : .left, Int64(i))
      usleep(25_000)
      postMouse(right ? .rightMouseUp : .leftMouseUp, p, right ? .right : .left, Int64(i))
      usleep(60_000)
    }
    return nil
  case "drag":
    let fx = a["fromX"] as? Double ?? -1, fy = a["fromY"] as? Double ?? -1
    let tx = a["toX"] as? Double ?? -1, ty = a["toY"] as? Double ?? -1
    if let r = pointTarget(fx, fy) { return r }
    if let r = pointTarget(tx, ty) { return r }
    postMouse(.mouseMoved, CGPoint(x: fx, y: fy), .left, 0)
    usleep(40_000)
    postMouse(.leftMouseDown, CGPoint(x: fx, y: fy), .left, 1)
    for i in 1...12 {
      let k = Double(i) / 12
      postMouse(.leftMouseDragged, CGPoint(x: fx + (tx - fx) * k, y: fy + (ty - fy) * k), .left, 1)
      usleep(18_000)
    }
    postMouse(.leftMouseUp, CGPoint(x: tx, y: ty), .left, 1)
    return nil
  case "scroll":
    let x = a["x"] as? Double ?? -1, y = a["y"] as? Double ?? -1
    if let r = pointTarget(x, y) { return r }
    postMouse(.mouseMoved, CGPoint(x: x, y: y), .left, 0)
    usleep(40_000)
    let dy = Int32((a["dy"] as? Int) ?? 0), dx = Int32((a["dx"] as? Int) ?? 0)
    if let e = CGEvent(scrollWheelEvent2Source: eventSource, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) {
      e.post(tap: .cghidEventTap)
    }
    return nil
  case "type":
    let pid = pid_t((a["pid"] as? Int) ?? 0)
    guard pidAllowed(pid, allow, allowBrowsers: allowBrowsers) else { return ("TARGET_NOT_ALLOWED", "输入目标不在白名单或属于硬拒绝名单") }
    if IsSecureEventInputEnabled() { return ("SECURE_INPUT", "安全输入已开启") }
    let units = Array(((a["text"] as? String) ?? "").utf16)
    var i = 0
    while i < units.count {
      let n = min(16, units.count - i)
      var chunk = Array(units[i..<(i + n)])
      for down in [true, false] {
        guard let e = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: down) else { continue }
        e.keyboardSetUnicodeString(stringLength: n, unicodeString: &chunk)
        e.postToPid(pid)
      }
      usleep(8_000)
      i += n
    }
    return nil
  case "key":
    let pid = pid_t((a["pid"] as? Int) ?? 0)
    guard pidAllowed(pid, allow, allowBrowsers: allowBrowsers) else { return ("TARGET_NOT_ALLOWED", "按键目标不在白名单或属于硬拒绝名单") }
    if IsSecureEventInputEnabled() { return ("SECURE_INPUT", "安全输入已开启") }
    guard let code = KEYCODES[(a["key"] as? String) ?? ""] else { return ("UNKNOWN_KEY", "不认识的按键") }
    var flags: CGEventFlags = []
    for m in (a["modifiers"] as? [String]) ?? [] {
      switch m {
      case "cmd": flags.insert(.maskCommand)
      case "shift": flags.insert(.maskShift)
      case "option": flags.insert(.maskAlternate)
      case "control": flags.insert(.maskControl)
      case "fn": flags.insert(.maskSecondaryFn)
      default: return ("UNKNOWN_KEY", "不认识的修饰键 \(m)")
      }
    }
    for down in [true, false] {
      guard let e = CGEvent(keyboardEventSource: eventSource, virtualKey: CGKeyCode(code), keyDown: down) else { continue }
      e.flags = flags
      e.postToPid(pid)
      usleep(20_000)
    }
    return nil
  case "activate":
    let bid = (a["bundleId"] as? String) ?? ""
    if hardDenied(bid, allowBrowsers: allowBrowsers) || !allow.contains(bid) { return ("TARGET_NOT_ALLOWED", "应用不在白名单或属于硬拒绝名单") }
    guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bid) else {
      return ("APP_NOT_FOUND", "本机找不到 \(bid)")
    }
    let cfg = NSWorkspace.OpenConfiguration()
    cfg.activates = true
    let sem = DispatchSemaphore(value: 0)
    let box = Box<Error>()
    NSWorkspace.shared.openApplication(at: url, configuration: cfg) { _, err in
      box.value = err
      sem.signal()
    }
    // 【定】等待超时 ≠ 没有错误（2026-10-03 代码评审 CU-R09）。回调没回来时 `box.value` 是 nil，
    // 此前被当成「成功」，TS 侧记 APPLIED 并告诉模型「已切到前台」。而启动请求已经发出、应用可能
    // 稍后才到前台 —— 「切没切过去」不知道，只能抛（TS 侧据此记 UNKNOWN），不能返回「没投递」的拒绝。
    if sem.wait(timeout: .now() + 10) == .timedOut {
      throw HelperError(code: "ACTIVATE_TIMEOUT", message: "等 \(bid) 启动 / 切到前台超过 10 秒，没有得到结果；它可能稍后才出现")
    }
    if let e = box.value { throw HelperError(code: "ACTIVATE_FAILED", message: e.localizedDescription) }
    usleep(300_000)
    return nil
  default:
    return ("UNKNOWN_ACTION", "不认识的动作 \(kind)")
  }
}

// MARK: - 请求分派

func handle(_ req: [String: Any]) throws -> Any {
  let op = req["op"] as? String ?? ""
  let p = req["params"] as? [String: Any] ?? [:]
  switch op {
  case "ping":
    return ["version": PROTOCOL_VERSION, "pid": Int(getpid())]
  case "permissions":
    return ["screenRecording": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted()]
  case "requestPermissions":
    _ = CGRequestScreenCaptureAccess()
    let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(opts)
    return ["screenRecording": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted()]
  case "resolveApps":
    return ((p["queries"] as? [String]) ?? []).map { resolveApp($0) }
  case "capture":
    let allow = (p["allowBundleIds"] as? [String]) ?? []
    let edge = (p["maxLongEdgePx"] as? Int) ?? 1792
    let d = mainDisplay()
    let (w, h) = targetSize(d, maxLongEdge: edge)
    let wins = windowList()
    let (img, rect) = try captureImage(allow: allow, width: w, height: h, verifyNoLeak: true)
    let id = "shot_\(UUID().uuidString.prefix(8))"
    shots.append((id, StoredShot(image: img, allow: allow, width: img.width, height: img.height, display: d, rect: rect)))
    if shots.count > MAX_SHOTS { shots.removeFirst(shots.count - MAX_SHOTS) }
    let png = try pngData(img)
    // 由**现查的**窗口表推出（runningApplications 与前台状态同病：停在第一次被读的那一刻）。
    var capturedPids: [Int] = []
    for w in wins where allow.contains(w["bundleId"] as? String ?? "") {
      if let pid = w["pid"] as? Int, !capturedPids.contains(pid) { capturedPids.append(pid) }
    }
    let captured = capturedPids.compactMap { appRef(NSRunningApplication(processIdentifier: pid_t($0))) }
    return [
      "screenshotId": id,
      "png": png.base64EncodedString(),
      "width": img.width,
      "height": img.height,
      "display": ["widthPt": d.widthPt, "heightPt": d.heightPt, "scale": d.scale],
      "contentRect": ["x": Double(rect.minX), "y": Double(rect.minY), "width": Double(rect.width), "height": Double(rect.height)],
      "windows": wins,
      "frontmost": orNull(appRef(frontmostApp())),
      "capturedApps": captured,
    ]
  case "probe":
    var out: [String: Any] = [
      "frontmost": orNull(appRef(frontmostApp())),
      "secureInput": IsSecureEventInputEnabled(),
      "windowAtPoint": NSNull(),
      "regionDiff": NSNull(),
    ]
    if let x = p["x"] as? Double, let y = p["y"] as? Double {
      if let w = windowAt(x, y, in: windowList()) { out["windowAtPoint"] = w }
      if let sid = p["screenshotId"] as? String, let stored = shots.first(where: { $0.0 == sid })?.1 {
        let (fresh, _) = try captureImage(allow: stored.allow, width: stored.width, height: stored.height)
        // 点 → 像素经截图实际覆盖的区域换算（见 captureImage 的【定】）。
        let sx = Double(stored.width) / Double(stored.rect.width)
        let sy = Double(stored.height) / Double(stored.rect.height)
        let radius = (p["radiusPt"] as? Double) ?? 24
        out["regionDiff"] = regionDiff(stored.image, fresh, cx: (x - Double(stored.rect.minX)) * sx,
                                       cy: (y - Double(stored.rect.minY)) * sy, radiusPx: radius * sx)
      }
    }
    return out
  case "describe":
    let x = (p["x"] as? Double) ?? -1, y = (p["y"] as? Double) ?? -1
    return [
      "window": orNull(windowAt(x, y, in: windowList())),
      "element": orNull(elementAt(x, y)),
    ]
  case "perform":
    let action = (p["action"] as? [String: Any]) ?? [:]
    let allow = (p["allowBundleIds"] as? [String]) ?? []
    let allowBrowsers = (p["allowBrowsers"] as? Bool) ?? false
    if let (code, message) = try perform(action, allow: allow, allowBrowsers: allowBrowsers) {
      return ["ok": false, "code": code, "message": message]
    }
    return ["ok": true]
  case "quit":
    DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) { exit(0) }
    return ["bye": true]
  default:
    throw HelperError(code: "UNKNOWN_OP", message: "不认识的请求 \(op)")
  }
}

// MARK: - Socket 服务

func writeAll(_ fd: Int32, _ data: Data) -> Bool {
  var offset = 0
  return data.withUnsafeBytes { raw -> Bool in
    guard let base = raw.baseAddress else { return true }
    while offset < data.count {
      let n = write(fd, base.advanced(by: offset), data.count - offset)
      if n <= 0 { return false }
      offset += n
    }
    return true
  }
}

func respond(_ fd: Int32, _ obj: [String: Any]) -> Bool {
  guard var data = try? JSONSerialization.data(withJSONObject: obj) else { return false }
  data.append(0x0a)
  return writeAll(fd, data)
}

func serveConnection(_ fd: Int32) {
  var pending = Data()
  var buf = [UInt8](repeating: 0, count: 65536)
  while true {
    let n = read(fd, &buf, buf.count)
    if n <= 0 { break }
    pending.append(contentsOf: buf[0..<n])
    while let nl = pending.firstIndex(of: 0x0a) {
      let line = pending.subdata(in: pending.startIndex..<nl)
      pending.removeSubrange(pending.startIndex...nl)
      guard let req = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { continue }
      let id = req["id"] ?? NSNull()
      var resp: [String: Any]
      do {
        resp = ["id": id, "ok": true, "result": try handle(req)]
      } catch let e as HelperError {
        resp = ["id": id, "ok": false, "code": e.code, "message": e.message]
      } catch {
        resp = ["id": id, "ok": false, "code": "INTERNAL", "message": String(describing: error)]
      }
      if !respond(fd, resp) { close(fd); return }
    }
  }
  close(fd)
}

func serve() {
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  guard fd >= 0 else { log("socket() 失败"); exit(1) }
  var addr = sockaddr_un()
  addr.sun_family = sa_family_t(AF_UNIX)
  let pathBytes = Array(socketPath.utf8)
  guard pathBytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { log("socket 路径过长"); exit(1) }
  withUnsafeMutableBytes(of: &addr.sun_path) { raw in
    raw.copyBytes(from: pathBytes)
    raw[pathBytes.count] = 0
  }
  unlink(socketPath)
  let len = socklen_t(MemoryLayout<sockaddr_un>.size)
  let bound = withUnsafePointer(to: &addr) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, len) }
  }
  guard bound == 0 else { log("bind() 失败 errno=\(errno)"); exit(1) }
  chmod(socketPath, 0o600)
  guard listen(fd, 4) == 0 else { log("listen() 失败"); exit(1) }
  log("listening on \(socketPath) for client pid \(clientPid)")
  while true {
    let c = accept(fd, nil, nil)
    if c < 0 { continue }
    // 【定】只认启动我的那个 Atlas 进程（见文件头）。
    var peer: pid_t = 0
    var plen = socklen_t(MemoryLayout<pid_t>.size)
    let ok = getsockopt(c, SOL_LOCAL, LOCAL_PEERPID, &peer, &plen) == 0
    if !ok || peer != clientPid {
      log("拒绝来自 pid \(peer) 的连接")
      close(c)
      continue
    }
    serveConnection(c)
  }
}

// 看门狗：Atlas 进程不在了就退出，不留一个带着系统授权的孤儿。
let watchdog = DispatchSource.makeTimerSource(queue: DispatchQueue.global())
watchdog.schedule(deadline: .now() + 2, repeating: 2)
watchdog.setEventHandler {
  if kill(clientPid, 0) != 0 && errno == ESRCH {
    log("client pid \(clientPid) 已退出，助手随之退出")
    unlink(socketPath)
    exit(0)
  }
}
watchdog.resume()

Thread { serve() }.start()
dispatchMain()
