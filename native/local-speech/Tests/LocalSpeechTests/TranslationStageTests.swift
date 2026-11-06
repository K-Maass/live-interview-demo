import AVFoundation
import XCTest

@testable import SpeechCore

final class TranslationStageTests: XCTestCase {
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
  private func request(cache: URL) throws -> TranslateUtteranceRequest {
    let value: [String: Any] = ["kind": "translateUtterance", "meetingId": "m", "lane": "me",
      "segmentId": "s", "revision": 4, "audioPath": cache.appendingPathComponent("a.wav").path,
      "source": ["meetingId": "m", "segmentId": "s", "revision": 4, "journalSequence": 9,
        "lane": "me", "startMs": 8000, "endMs": 10800, "language": "de", "text": "Wer entscheidet?",
        "kind": "final", "acceptedIntervals": [["start": 0.5, "end": 1.1], ["start": 2.2, "end": 2.8]]]]
    return try JSONDecoder().decode(TranslateUtteranceRequest.self,
      from: JSONSerialization.data(withJSONObject: value))
  }
  // Without retained audio the app deletes a recognized chunk's WAV. Text translation must still work, and
  // a path outside the cache must still be refused whether or not it exists.
  func testRemovedWavInsideTheCacheStillTranslatesFromTextButOutsidePathsFail() async throws {
    let root = try cache()
    defer { try? FileManager.default.removeItem(at: root) }
    let request = try request(cache: root)
    try FileManager.default.removeItem(at: root.appendingPathComponent("a.wav"))
    let event = try await translateSourceUtterance(request, cache: root) { _, recognized, _ in
      XCTAssertEqual(recognized.text, "Wer entscheidet?")
      return "Who decides?"
    }
    XCTAssertEqual(event.text, "Who decides?")
    XCTAssertNil(try ownedAudioPathAllowingRemoved(root.appendingPathComponent("gone.wav").path, root: root))
    XCTAssertThrowsError(try ownedAudioPathAllowingRemoved("/tmp/elsewhere-\(UUID().uuidString).wav", root: root))
    XCTAssertThrowsError(try ownedAudioPathAllowingRemoved(root.path + "/../escape.wav", root: root))
  }
  func testOnlySavedAcceptedIntervalsReachTranslationBackend() async throws {
    let root = try cache()
    defer { try? FileManager.default.removeItem(at: root) }
    let request = try request(cache: root)
    let event = try await translateSourceUtterance(request, cache: root) { path, recognized, _ in
      XCTAssertEqual(path, root.appendingPathComponent("a.wav").resolvingSymlinksInPath())
      XCTAssertEqual(recognized.text, "Wer entscheidet?")
      XCTAssertEqual(recognized.language, "de")
      XCTAssertEqual(recognized.durationMs, 2800)
      XCTAssertEqual(recognized.intervals, [SpeechInterval(start: 0.5, end: 1.1), SpeechInterval(start: 2.2, end: 2.8)])
      return "Who decides?"
    }
    XCTAssertEqual(event.revision, 4)
    XCTAssertEqual(event.sourceSegmentId, "s")
    XCTAssertEqual(event.lane, .me)
    XCTAssertEqual(event.startMs, 8000)
    XCTAssertEqual(event.endMs, 10800)
    XCTAssertEqual(event.text, "Who decides?")
    XCTAssertNil(event.acceptedIntervals)
  }
  func testTranslationBackendFailureLeavesCanonicalSourceUnchanged() async throws {
    let root = try cache()
    defer { try? FileManager.default.removeItem(at: root) }
    let request = try request(cache: root)
    let before = try JSONEncoder().encode(request.source)
    do {
      _ = try await translateSourceUtterance(request, cache: root) { _, _, _ in throw SpeechFailure.missingAssets }
      XCTFail("Failed translation cannot emit a completed translation event")
    } catch {
      XCTAssertEqual(error as? SpeechFailure, .missingAssets)
    }
    let after = try JSONEncoder().encode(request.source)
    let first = try JSONSerialization.jsonObject(with: before) as! NSDictionary
    let last = try JSONSerialization.jsonObject(with: after) as! NSDictionary
    XCTAssertEqual(first, last)
    XCTAssertEqual(request.source.text, "Wer entscheidet?")
    XCTAssertEqual(request.source.revision, 4)
  }
  // Older sources carry no accepted intervals. Apple translation works from the text, so a retry must not be
  // refused for them; only the audio route needs intervals (see testMissingAndInvalidGermanIntervals...).
  func testSourceWithoutIntervalsCanStillBeTranslatedFromText() async throws {
    let root = try cache()
    defer { try? FileManager.default.removeItem(at: root) }
    let original = try request(cache: root)
    for intervals in [nil, [SpeechInterval]()] {
      let source = SpeechEvent(meetingId: "m", segmentId: "s", revision: 4, journalSequence: 9,
        lane: .me, startMs: 8000, endMs: 10800, language: "de", text: "Wer entscheidet?",
        kind: "final", sourceSegmentId: nil, acceptedIntervals: intervals)
      let request = TranslateUtteranceRequest(kind: "translateUtterance", source: source,
        audioPath: original.audioPath, meetingId: "m", lane: .me, segmentId: "s", revision: 4)
      let event = try await translateSourceUtterance(request, cache: root) { _, recognized, _ in
        XCTAssertEqual(recognized.intervals, [])
        return "Who decides?"
      }
      XCTAssertEqual(event.text, "Who decides?")
      XCTAssertEqual(event.sourceSegmentId, "s")
    }
  }
  func testEveryFailureKeepsItsOwnWireCode() {
    let all: [SpeechFailure] = [.outsideCache, .missingAssets, .invalidMode, .unreliableSpeech,
      .invalidTranslationIntervals, .translationUnavailable]
    XCTAssertEqual(Set(all.map(failureCode)).count, all.count)
    XCTAssertEqual(failureCode(.unreliableSpeech), "unreliableSpeech")
    XCTAssertFalse(all.map(failureCode).contains("localReadiness"))
  }
  func testNonFiniteSavedIntervalsCannotReachTranslationBackend() async throws {
    let root = try cache()
    defer { try? FileManager.default.removeItem(at: root) }
    let original = try request(cache: root)
    let source = SpeechEvent(meetingId: "m", segmentId: "s", revision: 4, journalSequence: 9,
      lane: .me, startMs: 8000, endMs: 10800, language: "de", text: "Wer entscheidet?",
      kind: "final", sourceSegmentId: nil, acceptedIntervals: [SpeechInterval(start: 0, end: .infinity)])
    let request = TranslateUtteranceRequest(kind: "translateUtterance", source: source,
      audioPath: original.audioPath, meetingId: "m", lane: .me, segmentId: "s", revision: 4)
    do {
      _ = try await translateSourceUtterance(request, cache: root) { _, _, _ in
        XCTFail("Invalid intervals must fail before any translation work")
        return "Who decides?"
      }
      XCTFail("Non-finite intervals must be rejected")
    } catch {
      XCTAssertEqual(error as? SpeechFailure, .invalidTranslationIntervals)
    }
  }
  func testOutsideCacheTranslationCannotReadOrReachBackend() async throws {
    let root = try cache()
    defer { try? FileManager.default.removeItem(at: root) }
    let original = try request(cache: root)
    let request = TranslateUtteranceRequest(kind: "translateUtterance", source: original.source,
      audioPath: "/etc/hosts", meetingId: "m", lane: .me, segmentId: "s", revision: 4)
    do {
      _ = try await translateSourceUtterance(request, cache: root) { _, _, _ in
        XCTFail("Foreign audio must fail before translation")
        return "Who decides?"
      }
      XCTFail("Foreign audio path must be rejected")
    } catch {
      XCTAssertEqual(error as? SpeechFailure, .outsideCache)
    }
  }
}
