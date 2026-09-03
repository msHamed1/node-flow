import AppKit
import AVFoundation
import Foundation

let directory = URL(fileURLWithPath: CommandLine.arguments.count > 1
  ? CommandLine.arguments[1]
  : FileManager.default.currentDirectoryPath)
let videoURL = directory.appendingPathComponent("nodeflow-linkedin-demo.mp4")
let asset = AVURLAsset(url: videoURL)
let duration = try await asset.load(.duration)
let tracks = try await asset.loadTracks(withMediaType: .video)

guard let track = tracks.first else { fatalError("No video track found") }
let naturalSize = try await track.load(.naturalSize)
let transform = try await track.load(.preferredTransform)
let transformedSize = naturalSize.applying(transform)
let frameRate = try await track.load(.nominalFrameRate)
let estimatedDataRate = try await track.load(.estimatedDataRate)
let audioTracks = try await asset.loadTracks(withMediaType: .audio)

print("duration=\(CMTimeGetSeconds(duration))")
print("width=\(Int(abs(transformedSize.width)))")
print("height=\(Int(abs(transformedSize.height)))")
print("fps=\(frameRate)")
print("estimatedBitRate=\(Int(estimatedDataRate))")
print("audioTracks=\(audioTracks.count)")

let generator = AVAssetImageGenerator(asset: asset)
generator.appliesPreferredTrackTransform = true
generator.requestedTimeToleranceBefore = .zero
generator.requestedTimeToleranceAfter = .zero

for second in [3, 13, 20, 28, 35, 42, 49, 54, 58] {
  let time = CMTime(seconds: Double(second), preferredTimescale: 600)
  let image = try await generator.image(at: time).image
  let representation = NSBitmapImageRep(cgImage: image)
  guard let data = representation.representation(using: .png, properties: [:]) else {
    fatalError("Unable to encode QA frame")
  }
  let output = directory.appendingPathComponent(String(format: "qa-%02d.png", second))
  try data.write(to: output)
}
