import AVFoundation
import Foundation
import XCTest

final class TranslationProtocolTests: XCTestCase {
  private func withCache(_ body: (URL) throws -> Void) throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let format = AVAudioFormat(standardFormatWithSampleRate: 16000, channels: 1)!
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 48000)!
    buffer.frameLength = 48000
    for i in 0..<48000 { buffer.floatChannelData![0][i] = 0 }
    do {
      let file = try AVAudioFile(forWriting: root.appendingPathComponent("a.wav"), settings: format.settings)
      try file.write(from: buffer)
    }
    try body(root)
  }
  private func source(language: String = "de", intervals: [[String: Double]]? = [
    ["start": 0.4, "end": 1.2], ["start": 2.0, "end": 2.7]
  ]) -> [String: Any] {
    var value: [String: Any] = ["meetingId": "m", "segmentId": "s", "revision": 3,
      "journalSequence": 17, "lane": "remote", "startMs": 5000, "endMs": 7700,
      "language": language, "text": language == "en" ? "Who decides?" : "Wer entscheidet?", "kind": "final"]
    if let intervals { value["acceptedIntervals"] = intervals }
    return value
  }
  private func replies(_ request: [String: Any], cache: URL, medium: Bool = false) throws -> [[String: Any]] {
    let package = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
    let worker = package.appendingPathComponent(".build/debug/local-speech")
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/sandbox-exec")
    process.arguments = ["-p", "(version 1) (allow default) (deny network*)", worker.path,
      cache.appendingPathComponent("missing-models").path, cache.path]
      + (medium ? ["--force-medium-translation"] : [])
    process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]
    let input = Pipe(), output = Pipe()
    process.standardInput = input
    process.standardOutput = output
    process.standardError = FileHandle.nullDevice
    try process.run()
    var data = try JSONSerialization.data(withJSONObject: request)
    data.append(Data("\n{\"kind\":\"shutdown\"}\n".utf8))
    try input.fileHandleForWriting.write(contentsOf: data)
    try input.fileHandleForWriting.close()
    let result = output.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    XCTAssertEqual(process.terminationStatus, 0)
    return try String(decoding: result, as: UTF8.self).split(separator: "\n").map {
      try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any]
    }
  }
  func testEnglishTranslationReplyPreservesCanonicalRevisionWithoutRecognitionAssets() throws {
    try withCache { cache in
      let request: [String: Any] = ["kind": "translateUtterance", "source": source(language: "en", intervals: nil),
        "audioPath": cache.appendingPathComponent("a.wav").path]
      let result = try replies(request, cache: cache)
      XCTAssertEqual(result.count, 2)
      guard result.count == 2 else { return }
      XCTAssertEqual(result[0]["kind"] as? String, "speech")
      let event = result[0]["event"] as? [String: Any]
      XCTAssertEqual(event?["kind"] as? String, "translation")
      XCTAssertEqual(event?["segmentId"] as? String, "s:en")
      XCTAssertEqual(event?["sourceSegmentId"] as? String, "s")
      XCTAssertEqual(event?["revision"] as? Int, 3)
      XCTAssertEqual(event?["meetingId"] as? String, "m")
      XCTAssertEqual(event?["lane"] as? String, "remote")
      XCTAssertEqual(event?["startMs"] as? Int, 5000)
      XCTAssertEqual(event?["endMs"] as? Int, 7700)
      XCTAssertEqual(event?["language"] as? String, "en")
      XCTAssertEqual(event?["text"] as? String, "Who decides?")
      XCTAssertNil(event?["audioPath"])
      XCTAssertEqual(result[1]["kind"] as? String, "translatedUtterance")
      XCTAssertEqual(result[1]["segmentId"] as? String, "s")
      XCTAssertEqual(result[1]["revision"] as? Int, 3)
    }
  }
  func testMissingAndInvalidGermanIntervalsAreRejectedWithSourceCorrelation() throws {
    let bad: [[[String: Double]]?] = [nil, [], [["start": -0.1, "end": 1]],
      [["start": 1, "end": 1]], [["start": 2, "end": 1]],
      [["start": 0, "end": 1.2], ["start": 1, "end": 2]],
      [["start": 2, "end": 2.5], ["start": 0, "end": 1]],
      [["start": 0, "end": 3.1]]]
    try withCache { cache in
      for intervals in bad {
        // Only the audio (medium) route reads intervals; Apple translation works from the text.
        let result = try replies(["kind": "translateUtterance", "source": source(intervals: intervals),
          "audioPath": cache.appendingPathComponent("a.wav").path], cache: cache, medium: true)
        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result.first?["kind"] as? String, "failure")
        XCTAssertEqual(result.first?["code"] as? String, "invalidTranslationIntervals")
        XCTAssertEqual(result.first?["segmentId"] as? String, "s")
        XCTAssertEqual(result.first?["revision"] as? Int, 3)
      }
    }
  }
  func testTranslationFailureEmitsNoSourceReplacementOrFalseCompletion() throws {
    try withCache { cache in
      let result = try replies(["kind": "translateUtterance", "source": source(),
        "audioPath": cache.appendingPathComponent("a.wav").path], cache: cache, medium: true)
      XCTAssertEqual(result.count, 1)
      XCTAssertEqual(result.first?["kind"] as? String, "failure")
      XCTAssertEqual(result.first?["code"] as? String, "missingAssets")
      XCTAssertEqual(result.first?["segmentId"] as? String, "s")
      XCTAssertEqual(result.first?["revision"] as? Int, 3)
    }
  }
  func testOptionalTopLevelCorrelationMustMatchCanonicalSource() throws {
    let mismatches: [String: Any] = ["meetingId": "other", "lane": "me", "segmentId": "other", "revision": 2]
    try withCache { cache in
      for (key, value) in mismatches {
        var request: [String: Any] = ["kind": "translateUtterance", "source": source(language: "en", intervals: nil),
          "audioPath": cache.appendingPathComponent("a.wav").path]
        request[key] = value
        let result = try replies(request, cache: cache)
        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result.first?["kind"] as? String, "failure")
        XCTAssertEqual(result.first?["code"] as? String, "invalidMode")
      }
    }
  }
  func testPresentNullCorrelationIsNotTreatedAsAbsent() throws {
    try withCache { cache in
      for key in ["meetingId", "lane", "segmentId", "revision"] {
        var request: [String: Any] = ["kind": "translateUtterance", "source": source(language: "en", intervals: nil),
          "audioPath": cache.appendingPathComponent("a.wav").path]
        request[key] = NSNull()
        let result = try replies(request, cache: cache)
        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result.first?["kind"] as? String, "failure")
        XCTAssertEqual(result.first?["segmentId"] as? String, "s")
        XCTAssertEqual(result.first?["revision"] as? Int, 3)
      }
    }
  }
}
