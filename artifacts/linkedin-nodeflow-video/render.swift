import AppKit
import AVFoundation
import CoreText
import Foundation

let width = 1080
let height = 1350
let framesPerSecond: Int32 = 30
let durationSeconds = 60.0
let totalFrames = Int(durationSeconds * Double(framesPerSecond))

let artifactDirectory = URL(fileURLWithPath: CommandLine.arguments.count > 1
  ? CommandLine.arguments[1]
  : FileManager.default.currentDirectoryPath)
let outputURL = artifactDirectory.appendingPathComponent("nodeflow-linkedin-demo.mp4")

try? FileManager.default.removeItem(at: outputURL)

func loadImage(_ name: String) -> CGImage {
  let url = artifactDirectory.appendingPathComponent(name)
  guard let image = NSImage(contentsOf: url) else {
    fatalError("Unable to load \(url.path)")
  }
  var rect = NSRect(origin: .zero, size: image.size)
  guard let cgImage = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else {
    fatalError("Unable to decode \(url.path)")
  }
  return cgImage
}

let emptyDashboard = loadImage("dashboard-empty.png")
let populatedDashboard = loadImage("dashboard-populated.png")
let trafficDashboard = loadImage("dashboard-traffic.png")
let latencyDashboard = loadImage("dashboard-latency.png")
let paymentPathDashboard = loadImage("dashboard-payments-path.png")
let waterfallDashboard = loadImage("dashboard-trace-waterfall.png")

let writer = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)
let videoSettings: [String: Any] = [
  AVVideoCodecKey: AVVideoCodecType.h264,
  AVVideoWidthKey: width,
  AVVideoHeightKey: height,
  AVVideoCompressionPropertiesKey: [
    AVVideoAverageBitRateKey: 6_000_000,
    AVVideoMaxKeyFrameIntervalKey: 60,
    AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
  ],
]
let writerInput = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
writerInput.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(
  assetWriterInput: writerInput,
  sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    kCVPixelBufferWidthKey as String: width,
    kCVPixelBufferHeightKey as String: height,
  ])

guard writer.canAdd(writerInput) else { fatalError("Unable to add video input") }
writer.add(writerInput)
guard writer.startWriting() else { fatalError(writer.error?.localizedDescription ?? "Unable to start writer") }
writer.startSession(atSourceTime: .zero)

let backgroundTop = CGColor(red: 8 / 255, green: 12 / 255, blue: 19 / 255, alpha: 1)
let backgroundBottom = CGColor(red: 14 / 255, green: 20 / 255, blue: 31 / 255, alpha: 1)
let white = CGColor(red: 244 / 255, green: 247 / 255, blue: 251 / 255, alpha: 1)
let muted = CGColor(red: 164 / 255, green: 175 / 255, blue: 193 / 255, alpha: 1)
let cyan = CGColor(red: 99 / 255, green: 226 / 255, blue: 208 / 255, alpha: 1)
let purple = CGColor(red: 139 / 255, green: 146 / 255, blue: 255 / 255, alpha: 1)
let card = CGColor(red: 17 / 255, green: 24 / 255, blue: 36 / 255, alpha: 1)
let border = CGColor(red: 47 / 255, green: 61 / 255, blue: 80 / 255, alpha: 1)

func topRect(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> CGRect {
  CGRect(x: x, y: CGFloat(height) - y - h, width: w, height: h)
}

func roundedPath(_ rect: CGRect, radius: CGFloat) -> CGPath {
  CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)
}

func fillRounded(_ context: CGContext, rect: CGRect, radius: CGFloat, color: CGColor) {
  context.addPath(roundedPath(rect, radius: radius))
  context.setFillColor(color)
  context.fillPath()
}

func strokeRounded(_ context: CGContext, rect: CGRect, radius: CGFloat, color: CGColor, width: CGFloat = 1) {
  context.addPath(roundedPath(rect, radius: radius))
  context.setStrokeColor(color)
  context.setLineWidth(width)
  context.strokePath()
}

func drawLine(
  _ context: CGContext,
  _ text: String,
  top: CGFloat,
  size: CGFloat,
  color: CGColor,
  fontName: String = "Helvetica Neue",
  center: Bool = true,
  x: CGFloat = 0,
  alpha: CGFloat = 1
) {
  context.saveGState()
  defer { context.restoreGState() }
  context.textMatrix = .identity
  let font = CTFontCreateWithName(fontName as CFString, size, nil)
  let attributes: [NSAttributedString.Key: Any] = [
    NSAttributedString.Key(kCTFontAttributeName as String): font,
    NSAttributedString.Key(kCTForegroundColorAttributeName as String): color.copy(alpha: alpha) ?? color,
  ]
  let attributed = NSAttributedString(string: text, attributes: attributes)
  let line = CTLineCreateWithAttributedString(attributed)
  var ascent: CGFloat = 0
  var descent: CGFloat = 0
  let lineWidth = CGFloat(CTLineGetTypographicBounds(line, &ascent, &descent, nil))
  let drawX = center ? (CGFloat(width) - lineWidth) / 2 : x
  context.textPosition = CGPoint(x: drawX, y: CGFloat(height) - top - ascent)
  CTLineDraw(line, context)
}

func drawMultiline(
  _ context: CGContext,
  _ text: String,
  top: CGFloat,
  size: CGFloat,
  lineHeight: CGFloat,
  color: CGColor,
  fontName: String = "Helvetica Neue",
  alpha: CGFloat = 1
) {
  for (index, line) in text.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
    drawLine(
      context,
      String(line),
      top: top + CGFloat(index) * lineHeight,
      size: size,
      color: color,
      fontName: fontName,
      alpha: alpha)
  }
}

func drawBackground(_ context: CGContext) {
  let space = CGColorSpaceCreateDeviceRGB()
  let gradient = CGGradient(
    colorsSpace: space,
    colors: [backgroundBottom, backgroundTop] as CFArray,
    locations: [0, 1])!
  context.drawLinearGradient(
    gradient,
    start: CGPoint(x: 0, y: 0),
    end: CGPoint(x: CGFloat(width), y: CGFloat(height)),
    options: [])

  context.setFillColor(CGColor(red: 37 / 255, green: 52 / 255, blue: 73 / 255, alpha: 0.18))
  for x in stride(from: 0, through: width, by: 54) {
    for y in stride(from: 0, through: height, by: 54) {
      context.fillEllipse(in: CGRect(x: x, y: y, width: 2, height: 2))
    }
  }
}

func drawBrand(_ context: CGContext, alpha: CGFloat) {
  let mark = topRect(72, 58, 54, 54)
  fillRounded(context, rect: mark, radius: 14, color: cyan.copy(alpha: alpha) ?? cyan)
  drawLine(context, "⌘", top: 66, size: 33, color: backgroundTop, fontName: "Helvetica Neue Bold", center: false, x: 84, alpha: alpha)
  drawLine(context, "NodeFlow", top: 66, size: 30, color: white, fontName: "Helvetica Neue Bold", center: false, x: 146, alpha: alpha)

  let local = topRect(308, 68, 80, 30)
  fillRounded(context, rect: local, radius: 8, color: CGColor(red: 22 / 255, green: 40 / 255, blue: 45 / 255, alpha: alpha))
  strokeRounded(context, rect: local, radius: 8, color: cyan.copy(alpha: alpha * 0.55) ?? cyan)
  drawLine(context, "LOCAL", top: 73, size: 14, color: cyan, fontName: "Menlo Bold", center: false, x: 321, alpha: alpha)
}

func fade(_ time: Double, start: Double, end: Double, edge: Double = 0.55) -> CGFloat {
  let fadeIn = min(1, max(0, (time - start) / edge))
  let fadeOut = min(1, max(0, (end - time) / edge))
  return CGFloat(min(fadeIn, fadeOut))
}

func progress(_ time: Double, start: Double, end: Double) -> CGFloat {
  CGFloat(min(1, max(0, (time - start) / (end - start))))
}

func drawBrowserCard(
  _ context: CGContext,
  image: CGImage,
  top: CGFloat,
  alpha: CGFloat,
  zoom: CGFloat = 1
) {
  let outer = topRect(60, top, 960, 586)
  context.saveGState()
  context.setAlpha(alpha)
  context.setShadow(offset: CGSize(width: 0, height: -18), blur: 38, color: CGColor(gray: 0, alpha: 0.45))
  fillRounded(context, rect: outer, radius: 24, color: card)
  context.restoreGState()

  context.saveGState()
  context.setAlpha(alpha)
  strokeRounded(context, rect: outer, radius: 24, color: border, width: 2)
  let bar = topRect(60, top, 960, 46)
  context.addPath(roundedPath(bar, radius: 24))
  context.setFillColor(CGColor(red: 20 / 255, green: 29 / 255, blue: 42 / 255, alpha: 1))
  context.fillPath()
  for (index, color) in [
    CGColor(red: 1, green: 0.38, blue: 0.38, alpha: 1),
    CGColor(red: 1, green: 0.74, blue: 0.3, alpha: 1),
    cyan,
  ].enumerated() {
    context.setFillColor(color)
    context.fillEllipse(in: topRect(82 + CGFloat(index) * 25, top + 17, 11, 11))
  }
  let address = topRect(184, top + 10, 740, 26)
  fillRounded(context, rect: address, radius: 8, color: backgroundTop)
  drawLine(context, "127.0.0.1:7331", top: top + 15, size: 12, color: muted, fontName: "Menlo", center: false, x: 204, alpha: alpha)

  let viewport = topRect(60, top + 46, 960, 540)
  context.addPath(roundedPath(viewport, radius: 0))
  context.clip()
  let extraX = viewport.width * (zoom - 1) / 2
  let extraY = viewport.height * (zoom - 1) / 2
  context.draw(image, in: viewport.insetBy(dx: -extraX, dy: -extraY))
  context.restoreGState()
}

func drawPill(_ context: CGContext, text: String, x: CGFloat, top: CGFloat, width: CGFloat, color: CGColor, alpha: CGFloat) {
  let rect = topRect(x, top, width, 42)
  fillRounded(context, rect: rect, radius: 21, color: color.copy(alpha: alpha * 0.13) ?? color)
  strokeRounded(context, rect: rect, radius: 21, color: color.copy(alpha: alpha * 0.45) ?? color)
  drawLine(context, text, top: top + 10, size: 17, color: color, fontName: "Helvetica Neue Medium", center: false, x: x + 18, alpha: alpha)
}

func drawNetwork(_ context: CGContext, time: Double, alpha: CGFloat) {
  let center = CGPoint(x: 540, y: 610)
  let nodes = [
    CGPoint(x: 300, y: 455), CGPoint(x: 540, y: 390), CGPoint(x: 785, y: 480),
    CGPoint(x: 350, y: 730), CGPoint(x: 585, y: 665), CGPoint(x: 790, y: 765),
  ]
  context.saveGState()
  context.setAlpha(alpha)
  context.setLineWidth(3)
  for (index, node) in nodes.enumerated() {
    let pulse = CGFloat(0.35 + 0.25 * sin(time * 2.2 + Double(index)))
    context.setStrokeColor(cyan.copy(alpha: pulse) ?? cyan)
    context.move(to: CGPoint(x: center.x, y: CGFloat(height) - center.y))
    context.addLine(to: CGPoint(x: node.x, y: CGFloat(height) - node.y))
    context.strokePath()
    context.setFillColor((index % 2 == 0 ? cyan : purple).copy(alpha: 0.9)!)
    context.fillEllipse(in: topRect(node.x - 13, node.y - 13, 26, 26))
  }
  fillRounded(context, rect: topRect(center.x - 88, center.y - 45, 176, 90), radius: 24, color: card)
  strokeRounded(context, rect: topRect(center.x - 88, center.y - 45, 176, 90), radius: 24, color: cyan, width: 3)
  drawLine(context, "Node.js", top: center.y - 12, size: 28, color: white, fontName: "Helvetica Neue Bold", alpha: alpha)
  context.restoreGState()
}

func drawTerminal(_ context: CGContext, alpha: CGFloat) {
  let outer = topRect(90, 470, 900, 310)
  context.saveGState()
  context.setAlpha(alpha)
  fillRounded(context, rect: outer, radius: 24, color: CGColor(red: 5 / 255, green: 8 / 255, blue: 13 / 255, alpha: 1))
  strokeRounded(context, rect: outer, radius: 24, color: border, width: 2)
  drawLine(context, "$", top: 548, size: 31, color: cyan, fontName: "Menlo Bold", center: false, x: 138, alpha: alpha)
  drawLine(context, "npx node-flow dev -- npm run start:dev", top: 548, size: 27, color: white, fontName: "Menlo", center: false, x: 182, alpha: alpha)
  drawLine(context, "NodeFlow started", top: 640, size: 23, color: cyan, fontName: "Menlo", center: false, x: 138, alpha: alpha)
  drawLine(context, "Runtime map: http://127.0.0.1:7331", top: 690, size: 21, color: muted, fontName: "Menlo", center: false, x: 138, alpha: alpha)
  context.restoreGState()
}

func drawSnapshotCards(_ context: CGContext, time: Double, start: Double, alpha: CGFloat) {
  let p = progress(time, start: start, end: start + 5)
  let cards = [
    ("BEFORE", "15 components", cyan),
    ("AFTER", "16 components", purple),
  ]
  for (index, item) in cards.enumerated() {
    let x = CGFloat(110 + index * 460)
    let offset = (1 - min(1, max(0, p * 2 - CGFloat(index) * 0.35))) * 70
    let rect = topRect(x, 510 + offset, 400, 210)
    fillRounded(context, rect: rect, radius: 24, color: item.2.copy(alpha: alpha * 0.1) ?? item.2)
    strokeRounded(context, rect: rect, radius: 24, color: item.2.copy(alpha: alpha * 0.7) ?? item.2, width: 2)
    drawLine(context, item.0, top: 555 + offset, size: 18, color: item.2, fontName: "Menlo Bold", center: false, x: x + 38, alpha: alpha)
    drawLine(context, item.1, top: 610 + offset, size: 31, color: white, fontName: "Helvetica Neue Bold", center: false, x: x + 38, alpha: alpha)
  }
  drawLine(context, "→", top: 585, size: 56, color: muted, fontName: "Helvetica Neue", alpha: alpha)
  let command = topRect(144, 780, 792, 74)
  fillRounded(context, rect: command, radius: 16, color: card)
  strokeRounded(context, rect: command, radius: 16, color: border)
  drawLine(context, "node-flow compare before.json after.json", top: 803, size: 22, color: cyan, fontName: "Menlo", alpha: alpha)
}

func drawFrame(_ context: CGContext, time: Double) {
  drawBackground(context)

  if time < 5 {
    let a = fade(time, start: 0, end: 5)
    drawBrand(context, alpha: a)
    drawMultiline(context, "Your Node.js architecture\nchanges every day.", top: 190, size: 64, lineHeight: 76, color: white, fontName: "Helvetica Neue Bold", alpha: a)
    drawNetwork(context, time: time, alpha: a)
    drawLine(context, "Your diagrams usually don't.", top: 1045, size: 34, color: muted, fontName: "Helvetica Neue Medium", alpha: a)
  } else if time < 10 {
    let a = fade(time, start: 5, end: 10)
    drawBrand(context, alpha: a)
    drawMultiline(context, "What if your application\ndrew the architecture itself?", top: 255, size: 58, lineHeight: 72, color: white, fontName: "Helvetica Neue Bold", alpha: a)
    drawLine(context, "Derived from real executed traffic.", top: 500, size: 31, color: cyan, fontName: "Helvetica Neue Medium", alpha: a)
    drawPill(context, text: "Routes", x: 128, top: 660, width: 170, color: cyan, alpha: a)
    drawPill(context, text: "Controllers", x: 319, top: 660, width: 210, color: purple, alpha: a)
    drawPill(context, text: "Services", x: 550, top: 660, width: 175, color: cyan, alpha: a)
    drawPill(context, text: "Infrastructure", x: 746, top: 660, width: 225, color: purple, alpha: a)
  } else if time < 16 {
    let a = fade(time, start: 10, end: 16)
    drawBrand(context, alpha: a)
    drawLine(context, "One command. One local dashboard.", top: 225, size: 48, color: white, fontName: "Helvetica Neue Bold", alpha: a)
    drawTerminal(context, alpha: a)
    drawLine(context, "No separate tracing backend required for local exploration.", top: 930, size: 27, color: muted, alpha: a)
  } else if time < 24 {
    let a = fade(time, start: 16, end: 24)
    let p = progress(time, start: 16, end: 24)
    drawBrand(context, alpha: a)
    drawLine(context, "Exercise the application.", top: 155, size: 48, color: white, fontName: "Helvetica Neue Bold", alpha: a)
    drawLine(context, "The runtime map appears as code executes.", top: 225, size: 28, color: cyan, alpha: a)
    drawBrowserCard(context, image: emptyDashboard, top: 315, alpha: a * max(0, 1 - p * 2.2), zoom: 1.01)
    drawBrowserCard(context, image: populatedDashboard, top: 315, alpha: a * min(1, max(0, p * 2.2 - 0.55)), zoom: 1.01 + p * 0.012)
    drawLine(context, "15 components  •  12 dependencies  •  3 runtime paths", top: 990, size: 25, color: muted, fontName: "Menlo", alpha: a)
  } else if time < 32 {
    let a = fade(time, start: 24, end: 32)
    let p = progress(time, start: 24, end: 32)
    drawBrand(context, alpha: a)
    drawLine(context, "See the architecture that actually ran.", top: 155, size: 46, color: white, fontName: "Helvetica Neue Bold", alpha: a)
    drawLine(context, "Routes → Controllers → Services → Infrastructure", top: 225, size: 27, color: cyan, fontName: "Helvetica Neue Medium", alpha: a)
    drawBrowserCard(context, image: populatedDashboard, top: 315, alpha: a, zoom: 1.01 + p * 0.02)
    drawPill(context, text: "MongoDB", x: 135, top: 970, width: 176, color: purple, alpha: a)
    drawPill(context, text: "PostgreSQL", x: 332, top: 970, width: 195, color: cyan, alpha: a)
    drawPill(context, text: "Redis", x: 548, top: 970, width: 145, color: purple, alpha: a)
    drawPill(context, text: "RabbitMQ", x: 714, top: 970, width: 190, color: cyan, alpha: a)
  } else if time < 39 {
    let a = fade(time, start: 32, end: 39)
    let p = progress(time, start: 32, end: 39)
    drawBrand(context, alpha: a)
    drawLine(context, "Follow one executed runtime path.", top: 155, size: 48, color: white, fontName: "Helvetica Neue Bold", alpha: a)
    drawLine(context, "Understand ownership from entrypoint to infrastructure.", top: 225, size: 28, color: cyan, alpha: a)
    drawBrowserCard(context, image: paymentPathDashboard, top: 315, alpha: a, zoom: 1.01 + p * 0.015)
    drawLine(context, "POST /payments → PaymentsController → PaymentsService", top: 970, size: 23, color: white, fontName: "Menlo", alpha: a)
    drawLine(context, "→ RabbitMQ + MongoDB", top: 1010, size: 23, color: muted, fontName: "Menlo", alpha: a)
  } else if time < 46 {
    let a = fade(time, start: 39, end: 46)
    let p = progress(time, start: 39, end: 46)
    drawBrand(context, alpha: a)
    drawMultiline(context, "Change perspective.\nKeep the same graph.", top: 125, size: 47, lineHeight: 58, color: white, fontName: "Helvetica Neue Bold", alpha: a)
    drawLine(context, "Architecture  •  Traffic  •  Latency  •  Errors", top: 250, size: 28, color: cyan, alpha: a)
    if p < 0.5 {
      drawBrowserCard(context, image: trafficDashboard, top: 335, alpha: a, zoom: 1.015)
      drawPill(context, text: "TRAFFIC", x: 433, top: 980, width: 214, color: cyan, alpha: a)
    } else {
      drawBrowserCard(context, image: latencyDashboard, top: 335, alpha: a, zoom: 1.015)
      drawPill(context, text: "LATENCY", x: 433, top: 980, width: 214, color: purple, alpha: a)
    }
  } else if time < 52 {
    let a = fade(time, start: 46, end: 52)
    drawBrand(context, alpha: a)
    drawLine(context, "Inspect an individual request.", top: 145, size: 49, color: white, fontName: "Helvetica Neue Bold", alpha: a)
    drawLine(context, "See the real waterfall and where time was spent.", top: 215, size: 28, color: cyan, alpha: a)
    drawBrowserCard(context, image: waterfallDashboard, top: 305, alpha: a, zoom: 1.02)
    drawLine(context, "HTTP → Controller → Service → External API → PostgreSQL", top: 965, size: 22, color: muted, fontName: "Menlo", alpha: a)
  } else if time < 57 {
    let a = fade(time, start: 52, end: 57)
    drawBrand(context, alpha: a)
    drawLine(context, "Capture before. Compare after.", top: 180, size: 54, color: white, fontName: "Helvetica Neue Bold", alpha: a)
    drawLine(context, "Spot new dependencies and meaningful latency changes.", top: 255, size: 28, color: cyan, alpha: a)
    drawSnapshotCards(context, time: time, start: 52, alpha: a)
  } else {
    let a = fade(time, start: 57, end: 60, edge: 0.35)
    drawBrand(context, alpha: a)
    drawLine(context, "NodeFlow", top: 300, size: 94, color: white, fontName: "Helvetica Neue Bold", alpha: a)
    drawMultiline(context, "See your Node.js architecture\nexecute in real time.", top: 435, size: 48, lineHeight: 61, color: cyan, fontName: "Helvetica Neue Medium", alpha: a)
    drawLine(context, "Local-first  •  Node.js 20+  •  NestJS  •  Open source", top: 640, size: 25, color: muted, alpha: a)
    let link = topRect(150, 755, 780, 90)
    fillRounded(context, rect: link, radius: 24, color: card)
    strokeRounded(context, rect: link, radius: 24, color: cyan.copy(alpha: a * 0.55) ?? cyan, width: 2)
    drawLine(context, "github.com/msHamed1/node-flow", top: 786, size: 28, color: white, fontName: "Menlo", alpha: a)
    drawLine(context, "Build from runtime truth.", top: 970, size: 33, color: purple, fontName: "Helvetica Neue Medium", alpha: a)
  }
}

for frameIndex in 0..<totalFrames {
  autoreleasepool {
    while !writerInput.isReadyForMoreMediaData {
      Thread.sleep(forTimeInterval: 0.002)
    }

    guard let pool = adaptor.pixelBufferPool else { fatalError("Pixel buffer pool unavailable") }
    var optionalBuffer: CVPixelBuffer?
    guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &optionalBuffer) == kCVReturnSuccess,
          let pixelBuffer = optionalBuffer
    else { fatalError("Unable to allocate pixel buffer") }

    CVPixelBufferLockBaseAddress(pixelBuffer, [])
    defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }
    guard let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer) else {
      fatalError("Pixel buffer has no base address")
    }
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let bitmapInfo = CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue
    guard let context = CGContext(
      data: baseAddress,
      width: width,
      height: height,
      bitsPerComponent: 8,
      bytesPerRow: CVPixelBufferGetBytesPerRow(pixelBuffer),
      space: colorSpace,
      bitmapInfo: bitmapInfo)
    else { fatalError("Unable to create frame context") }

    let time = Double(frameIndex) / Double(framesPerSecond)
    drawFrame(context, time: time)
    let presentationTime = CMTime(value: CMTimeValue(frameIndex), timescale: framesPerSecond)
    if !adaptor.append(pixelBuffer, withPresentationTime: presentationTime) {
      fatalError(writer.error?.localizedDescription ?? "Unable to append frame")
    }
  }
}

writerInput.markAsFinished()
let completion = DispatchSemaphore(value: 0)
writer.finishWriting { completion.signal() }
completion.wait()

guard writer.status == .completed else {
  fatalError(writer.error?.localizedDescription ?? "Video export failed")
}

print(outputURL.path)
