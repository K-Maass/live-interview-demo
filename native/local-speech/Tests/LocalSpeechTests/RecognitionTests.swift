import AVFoundation
import XCTest

@testable import SpeechCore

final class RecognitionTests: XCTestCase {
  func testLocalSpeechDetectorRejectsGaussianNoise() throws {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(
      UUID().uuidString + ".wav")
    defer { try? FileManager.default.removeItem(at: url) }
    let format = AVAudioFormat(standardFormatWithSampleRate: 16000, channels: 1)!
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 128000)!
    buffer.frameLength = 128000
    var seed: UInt64 = 71
    func uniform() -> Double {
      seed = seed &* 6_364_136_223_846_793_005 &+ 1
      return Double((seed >> 32) + 1) / Double(UInt32.max)
    }
    for i in 0..<128000 {
      buffer.floatChannelData![0][i] = Float(
        sqrt(-2 * log(uniform())) * cos(2 * Double.pi * uniform()) * 650 / 32768)
    }
    do {
      let file = try AVAudioFile(forWriting: url, settings: format.settings)
      try file.write(from: buffer)
    }
    XCTAssertTrue(try speechIntervals(in: url).isEmpty)
    buffer.frameLength = 12800
    do {
      let file = try AVAudioFile(forWriting: url, settings: format.settings)
      try file.write(from: buffer)
    }
    XCTAssertTrue(try speechIntervals(in: url).isEmpty, "Short chunks must not stall decoding")
  }
  func testSilenceConfidenceAndPunctuationDoNotBecomeEvidence() {
    XCTAssertFalse(
      isReliableSpeech(
        text: ".", averageLogProbability: -0.2, compressionRatio: 1))
    XCTAssertFalse(
      isReliableSpeech(
        text: "Uncertain text", averageLogProbability: -2,
        compressionRatio: 1))
    XCTAssertTrue(
      isReliableSpeech(
        text: "Wer entscheidet?", averageLogProbability: -0.2,
        compressionRatio: 1))
    XCTAssertTrue(
      isReliableSpeech(
        text: "Thank you for watching", averageLogProbability: -0.2,
        compressionRatio: 1))
  }
  // Noise that Whisper hallucinates on must read as "no speech", not a helper failure: a failure reply made
  // the app kill the helper and reload the model for every noisy chunk.
  func testUnreliableSegmentsAreAnEmptyResultNotAFailure() async throws {
    let noise = reliableRecognition(
      [
        DecodedSegment(text: ".", start: 0, end: 1, averageLogProbability: -0.2, compressionRatio: 1),
        DecodedSegment(
          text: "Thanks", start: 1, end: 2, averageLogProbability: -3, compressionRatio: 1),
      ], language: "en")
    XCTAssertEqual(noise.text, "")
    XCTAssertTrue(noise.intervals.isEmpty)
    let mixed = reliableRecognition(
      [
        DecodedSegment(text: ".", start: 0, end: 1, averageLogProbability: -0.2, compressionRatio: 1),
        DecodedSegment(
          text: " Wer entscheidet?", start: 1, end: 2.5, averageLogProbability: -0.2,
          compressionRatio: 1),
      ], language: "de")
    XCTAssertEqual(mixed.text, "Wer entscheidet?")
    XCTAssertEqual(mixed.durationMs, 2500)
    XCTAssertEqual(mixed.intervals.count, 1)

    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let path = root.appendingPathComponent("audio.wav")
    try Data([0]).write(to: path)
    let request = try JSONDecoder().decode(
      DecodeRequest.self,
      from: Data(
        "{\"kind\":\"decode\",\"meetingId\":\"m\",\"segmentId\":\"s\",\"lane\":\"me\",\"audioPath\":\"\(path.path)\",\"startMs\":0,\"sequence\":1,\"mode\":\"transcribe\"}"
          .utf8))
    let events = try await decodeUtterance(
      request, cache: root, recognize: { _ in noise }, translate: { _ in "unused" })
    XCTAssertTrue(events.isEmpty)
  }
  func testDecodePreservesLaneAndLinksTranslation() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let path = root.appendingPathComponent("audio.wav")
    try Data([0]).write(to: path)
    let request = try JSONDecoder().decode(
      DecodeRequest.self,
      from: Data(
        "{\"kind\":\"decode\",\"meetingId\":\"m\",\"segmentId\":\"s\",\"lane\":\"remote\",\"audioPath\":\"\(path.path)\",\"startMs\":10,\"sequence\":2,\"mode\":\"transcribe\"}"
          .utf8))
    let events = try await decodeUtterance(
      request, cache: root,
      recognize: { _ in RecognizedText(text: "Wer entscheidet?", language: "de", durationMs: 1000)
      }, translate: { _ in "Who decides?" })
    XCTAssertEqual(events.count, 2)
    XCTAssertEqual(events[0].lane, .remote)
    XCTAssertEqual(events[0].text, "Wer entscheidet?")
    XCTAssertEqual(events[1].lane, .remote)
    XCTAssertEqual(events[1].sourceSegmentId, "s")
    XCTAssertEqual(events[1].text, "Who decides?")
  }
}
