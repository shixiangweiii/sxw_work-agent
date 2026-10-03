// Spike 1 合成截图渲染器。一次性、可丢弃，阶段 1 不得 import 本目录任何代码。
//
// 为什么用 AppKit 而不是在 Node 里手绘像素：探针要回答的是「模型能不能在 macOS 截图上
// 找准、读清」，字形必须是系统真实的字体渲染（SF Pro、次像素定位、Retina 缩放）。
// 手绘点阵字测出来的可读性没有外推价值。
//
// 用法：render <batch.json>
//   batch.json = { "images": [ ImageSpec, ... ] }
//   ImageSpec  = { out, width, height, viewport: {x,y,w,h}, background, elements: [Element] }
//
// 全部坐标都在「逻辑点」里表达（与 macOS 的 pt 同义）；viewport 选出要渲染的那一块，
// 输出像素尺寸 = width × height。整屏 = viewport (0,0,1792,1120)；
// 「放大」= 一个更小的 viewport 配同样的输出像素，等价于原分辨率裁片。
//
// Element.kind：
//   rect     { x,y,w,h, fill?, stroke?, strokeWidth?, radius? }
//   ellipse  { x,y,w,h, fill?, stroke?, strokeWidth? }
//   triangle { x,y,w,h, fill }      尖朝上
//   diamond  { x,y,w,h, fill }
//   text     { x,y,text,size, weight?, color?, mono?, w?,h? }   有 w/h 时在该框内居中
//
// 每张图渲染后在 stdout 打一行 JSON：{ out, width, height, overflow: [...] }，
// overflow 列出「文字比它的框宽」的元素 —— 夹具里的按钮装不下标签，命中判定就不可信。

import AppKit
import Foundation

struct Batch: Decodable { let images: [ImageSpec] }

struct Viewport: Decodable { let x: Double; let y: Double; let w: Double; let h: Double }

struct ImageSpec: Decodable {
  let out: String
  let width: Int
  let height: Int
  let viewport: Viewport
  let background: String
  let elements: [Element]
}

struct Element: Decodable {
  let kind: String
  let x: Double
  let y: Double
  let w: Double?
  let h: Double?
  let fill: String?
  let stroke: String?
  let strokeWidth: Double?
  let radius: Double?
  let text: String?
  let size: Double?
  let weight: String?
  let color: String?
  let mono: Bool?
  let id: String?
}

func parseColor(_ hex: String?) -> NSColor? {
  guard var s = hex else { return nil }
  if s.hasPrefix("#") { s.removeFirst() }
  guard s.count == 6 || s.count == 8, let v = UInt64(s, radix: 16) else { return nil }
  let hasAlpha = s.count == 8
  let r = Double((v >> (hasAlpha ? 24 : 16)) & 0xFF) / 255
  let g = Double((v >> (hasAlpha ? 16 : 8)) & 0xFF) / 255
  let b = Double((v >> (hasAlpha ? 8 : 0)) & 0xFF) / 255
  let a = hasAlpha ? Double(v & 0xFF) / 255 : 1
  return NSColor(srgbRed: r, green: g, blue: b, alpha: a)
}

func fontWeight(_ w: String?) -> NSFont.Weight {
  switch w {
  case "medium": return .medium
  case "semibold": return .semibold
  case "bold": return .bold
  default: return .regular
  }
}

func render(_ spec: ImageSpec) throws -> [String] {
  let space = CGColorSpace(name: CGColorSpace.sRGB)!
  guard let cg = CGContext(
    data: nil, width: spec.width, height: spec.height, bitsPerComponent: 8, bytesPerRow: 0,
    space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
  else { throw NSError(domain: "render", code: 1) }

  // 左上角为原点（与截图、与模型输出的坐标同向），再把逻辑点映射到像素。
  cg.translateBy(x: 0, y: CGFloat(spec.height))
  cg.scaleBy(x: 1, y: -1)
  let sx = Double(spec.width) / spec.viewport.w
  let sy = Double(spec.height) / spec.viewport.h
  cg.scaleBy(x: CGFloat(sx), y: CGFloat(sy))
  cg.translateBy(x: CGFloat(-spec.viewport.x), y: CGFloat(-spec.viewport.y))

  let gctx = NSGraphicsContext(cgContext: cg, flipped: true)
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = gctx

  (parseColor(spec.background) ?? .white).setFill()
  NSRect(x: spec.viewport.x, y: spec.viewport.y, width: spec.viewport.w, height: spec.viewport.h).fill()

  var overflow: [String] = []
  for el in spec.elements {
    let w = el.w ?? 0
    let h = el.h ?? 0
    let rect = NSRect(x: el.x, y: el.y, width: w, height: h)
    switch el.kind {
    case "rect":
      let r = el.radius ?? 0
      let path = NSBezierPath(roundedRect: rect, xRadius: r, yRadius: r)
      if let f = parseColor(el.fill) { f.setFill(); path.fill() }
      if let s = parseColor(el.stroke) { s.setStroke(); path.lineWidth = el.strokeWidth ?? 1; path.stroke() }
    case "ellipse":
      let path = NSBezierPath(ovalIn: rect)
      if let f = parseColor(el.fill) { f.setFill(); path.fill() }
      if let s = parseColor(el.stroke) { s.setStroke(); path.lineWidth = el.strokeWidth ?? 1; path.stroke() }
    case "triangle":
      let path = NSBezierPath()
      path.move(to: NSPoint(x: el.x, y: el.y + h))
      path.line(to: NSPoint(x: el.x + w / 2, y: el.y))
      path.line(to: NSPoint(x: el.x + w, y: el.y + h))
      path.close()
      (parseColor(el.fill) ?? .black).setFill()
      path.fill()
    case "diamond":
      let path = NSBezierPath()
      path.move(to: NSPoint(x: el.x + w / 2, y: el.y))
      path.line(to: NSPoint(x: el.x + w, y: el.y + h / 2))
      path.line(to: NSPoint(x: el.x + w / 2, y: el.y + h))
      path.line(to: NSPoint(x: el.x, y: el.y + h / 2))
      path.close()
      (parseColor(el.fill) ?? .black).setFill()
      path.fill()
    case "text":
      let size = el.size ?? 13
      let weight = fontWeight(el.weight)
      let font = (el.mono ?? false)
        ? NSFont.monospacedSystemFont(ofSize: size, weight: weight)
        : NSFont.systemFont(ofSize: size, weight: weight)
      let attrs: [NSAttributedString.Key: Any] = [
        .font: font,
        .foregroundColor: parseColor(el.color) ?? .black,
      ]
      let s = NSAttributedString(string: el.text ?? "", attributes: attrs)
      let sz = s.size()
      var origin = NSPoint(x: el.x, y: el.y)
      if let bw = el.w, let bh = el.h {
        if sz.width > bw { overflow.append(el.id ?? (el.text ?? "?")) }
        origin = NSPoint(x: el.x + (bw - sz.width) / 2, y: el.y + (bh - sz.height) / 2)
      }
      s.draw(at: origin)
    default:
      throw NSError(domain: "render", code: 2, userInfo: [NSLocalizedDescriptionKey: "未知 kind：\(el.kind)"])
    }
  }

  NSGraphicsContext.restoreGraphicsState()

  guard let image = cg.makeImage() else { throw NSError(domain: "render", code: 3) }
  let rep = NSBitmapImageRep(cgImage: image)
  guard let png = rep.representation(using: .png, properties: [:]) else {
    throw NSError(domain: "render", code: 4)
  }
  try png.write(to: URL(fileURLWithPath: spec.out))
  return overflow
}

let args = CommandLine.arguments
guard args.count == 2 else {
  FileHandle.standardError.write("用法：render <batch.json>\n".data(using: .utf8)!)
  exit(2)
}
do {
  let data = try Data(contentsOf: URL(fileURLWithPath: args[1]))
  let batch = try JSONDecoder().decode(Batch.self, from: data)
  for spec in batch.images {
    let overflow = try render(spec)
    let line: [String: Any] = [
      "out": spec.out, "width": spec.width, "height": spec.height, "overflow": overflow,
    ]
    let json = try JSONSerialization.data(withJSONObject: line)
    print(String(data: json, encoding: .utf8)!)
  }
} catch {
  FileHandle.standardError.write("渲染失败：\(error)\n".data(using: .utf8)!)
  exit(1)
}
