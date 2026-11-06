import AVFoundation
import XCTest

@testable import SpeechCore

final class TranslationRouteTests: XCTestCase {
  func testAppleIsTheOnlyDefaultRouteSoUnavailableAppleLeavesTranslationPending() {
    for status in [AppleTranslationStatus.supported, .unsupported, .unavailable] {
      XCTAssertEqual(chooseTranslation(route: .apple, apple: status, target: "en"), .unavailable)
    }
    XCTAssertEqual(chooseTranslation(route: .apple, apple: .installed, target: "en"), .apple)
  }
  func testExperimentalMediumOnlyFillsInWhenAppleCannotTranslateAndOnlyIntoEnglish() {
    XCTAssertEqual(chooseTranslation(route: .appleThenMedium, apple: .installed, target: "en"), .apple)
    XCTAssertEqual(chooseTranslation(route: .appleThenMedium, apple: .unavailable, target: "en"), .medium)
    XCTAssertEqual(chooseTranslation(route: .appleThenMedium, apple: .supported, target: "en"), .medium)
    XCTAssertEqual(chooseTranslation(route: .appleThenMedium, apple: .unavailable, target: "fr"), .unavailable)
    XCTAssertEqual(chooseTranslation(route: .appleThenMedium, apple: .installed, target: "fr"), .apple)
  }
  func testBenchmarkRouteNeverUsesApple() {
    XCTAssertEqual(chooseTranslation(route: .mediumOnly, apple: .installed, target: "en"), .medium)
    XCTAssertEqual(chooseTranslation(route: .mediumOnly, apple: .installed, target: "fr"), .unavailable)
  }

  private func cache() throws -> URL {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let format = AVAudioFormat(standardFormatWithSampleRate: 16000, channels: 1)!
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 48000)!
    buffer.frameLength = 48000
    for i in 0..<48000 { buffer.floatChannelData![0][i] = 0 }
    let file = try AVAudioFile(forWriting: root.appendingPathComponent("a.wav"), settings: format.settings)
    try file.write(from: buffer)
    return root
  }
  private func request(cache: URL, language: String, target: String?) throws -> TranslateUtteranceRequest {
    var value: [String: Any] = ["kind": "translateUtterance", "meetingId": "m", "lane": "remote",
      "segmentId": "s", "revision": 1, "audioPath": cache.appendingPathComponent("a.wav").path,
      "source": ["meetingId": "m", "segmentId": "s", "revision": 1, "journalSequence": 1,
        "lane": "remote", "startMs": 0, "endMs": 2800, "language": language, "text": "Guten Morgen.",
        "kind": "final", "acceptedIntervals": [["start": 0.5, "end": 1.1]]]]
    if let target { value["target"] = target }
    return try JSONDecoder().decode(TranslateUtteranceRequest.self,
      from: JSONSerialization.data(withJSONObject: value))
  }
  func testTargetDefaultsToEnglishAndNamesTheTranslationEvent() async throws {
    let root = try cache()
    defer { try? FileManager.default.removeItem(at: root) }
    var seenTarget = ""
    let event = try await translateSourceUtterance(try request(cache: root, language: "de", target: nil), cache: root) {
      _, _, target in
      seenTarget = target
      return "Good morning."
    }
    XCTAssertEqual(seenTarget, "en")
    XCTAssertEqual(event.language, "en")
    XCTAssertEqual(event.segmentId, "s:en")
  }
  func testRequestedTargetIsPassedToTheBackendAndRecordedOnTheEvent() async throws {
    let root = try cache()
    defer { try? FileManager.default.removeItem(at: root) }
    var seenTarget = ""
    let event = try await translateSourceUtterance(try request(cache: root, language: "de", target: "fr"), cache: root) {
      _, recognized, target in
      seenTarget = target
      XCTAssertEqual(recognized.language, "de")
      return "Bonjour."
    }
    XCTAssertEqual(seenTarget, "fr")
    XCTAssertEqual(event.language, "fr")
    XCTAssertEqual(event.segmentId, "s:fr")
  }
  func testSourceAlreadyInTheTargetLanguageIsNotSentToABackend() async throws {
    let root = try cache()
    defer { try? FileManager.default.removeItem(at: root) }
    let event = try await translateSourceUtterance(try request(cache: root, language: "de", target: "de"), cache: root) {
      _, _, _ in
      XCTFail("A same-language pair needs no translation backend")
      return ""
    }
    XCTAssertEqual(event.text, "Guten Morgen.")
    XCTAssertEqual(event.language, "de")
  }
}
