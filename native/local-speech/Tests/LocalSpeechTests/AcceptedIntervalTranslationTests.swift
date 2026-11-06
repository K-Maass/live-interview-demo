import AVFoundation
import WhisperKit
import XCTest

@testable import SpeechCore

final class AcceptedIntervalTranslationTests: XCTestCase {
  private let accepted = [SpeechInterval(start: 0, end: 2.98),
    SpeechInterval(start: 3.3799999, end: 7.12)]
  private let launch = "The department decides whether we go live."
  private let evidence = "Compliance specifies which evidence we must keep."
  private func segment(_ text: String, probability: Float = -0.2) -> TranscriptionSegment {
    TranscriptionSegment(text: text, avgLogprob: probability, compressionRatio: 1)
  }
  func testEveryExactAcceptedPairIsTranslatedWithoutJoiningTheGap() async throws {
    var calls: [[Float]] = []
    let translated = try await translateAcceptedIntervals(accepted, language: "de") { options in
      calls.append(options.clipTimestamps)
      XCTAssertEqual(options.task, .translate)
      XCTAssertEqual(options.language, "de")
      if options.clipTimestamps == [3.3799999, 7.12] { return [self.segment(self.evidence)] }
      // A batched call can return only its first clip; the adapter must prevent that success.
      return [self.segment(self.launch)]
    }
    XCTAssertEqual(calls, [[0, 2.98], [3.3799999, 7.12]])
    XCTAssertEqual(translated, "The department decides whether we go live. Compliance specifies which evidence we must keep.")
  }
  func testMissingSecondClipCannotReturnTheSuccessfulFirstClip() async throws {
    do {
      _ = try await translateAcceptedIntervals(accepted, language: "de") { options in
        options.clipTimestamps == [3.3799999, 7.12] ? [] : [self.segment(self.launch)]
      }
      XCTFail("A missing accepted interval cannot produce a complete translation")
    } catch {
      XCTAssertEqual(error as? SpeechFailure, .unreliableSpeech)
    }
  }
  func testShortAcceptedClipIsNotSkippedByWhisperEndPadding() async throws {
    let text = try await translateAcceptedIntervals([SpeechInterval(start: 0.2, end: 0.7)], language: "de") { options in
      // Pinned WhisperKit enters a clip only while start < end - windowClipTime.
      let clip = options.clipTimestamps
      return clip[0] < clip[1] - options.windowClipTime ? [self.segment("Who decides?")] : []
    }
    XCTAssertEqual(text, "Who decides?")
  }
  func testAnyUnreliablePartOfAClipFailsWholeTranslation() async throws {
    do {
      _ = try await translateAcceptedIntervals(accepted, language: "de") { options in
        if options.clipTimestamps == [0, 2.98] { return [self.segment(self.launch)] }
        return [self.segment(self.evidence), self.segment("Missing obligation", probability: -2)]
      }
      XCTFail("Discarding an unreliable piece must not silently create partial English evidence")
    } catch {
      XCTAssertEqual(error as? SpeechFailure, .unreliableSpeech)
    }
  }
  func testSecondClipFailureProducesNoFinalEventAndLeavesSourceEvidence() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let format = AVAudioFormat(standardFormatWithSampleRate: 16000, channels: 1)!
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 128000)!
    buffer.frameLength = 128000
    for i in 0..<128000 { buffer.floatChannelData![0][i] = 0 }
    let path = root.appendingPathComponent("a.wav")
    do {
      let file = try AVAudioFile(forWriting: path, settings: format.settings)
      try file.write(from: buffer)
    }
    let source = SpeechEvent(meetingId: "m", segmentId: "s", revision: 3, journalSequence: 9,
      lane: .remote, startMs: 5000, endMs: 12120, language: "de",
      text: "Die Fachabteilung entscheidet, ob wir live gehen. Compliance legt fest, welche Nachweise wir aufbewahren müssen.",
      kind: "final", sourceSegmentId: nil, acceptedIntervals: accepted)
    let request = TranslateUtteranceRequest(kind: "translateUtterance", source: source,
      audioPath: path.path, meetingId: "m", lane: .remote, segmentId: "s", revision: 3)
    var final: SpeechEvent?
    do {
      final = try await translateSourceUtterance(request, cache: root) { _, recognized, _ in
        try await translateAcceptedIntervals(recognized.intervals, language: recognized.language) { options in
          if options.clipTimestamps == [3.3799999, 7.12] { throw SpeechFailure.missingAssets }
          return [self.segment(self.launch)]
        }
      }
      XCTFail("Second-clip failure cannot publish a completed translation")
    } catch {
      XCTAssertEqual(error as? SpeechFailure, .missingAssets)
    }
    XCTAssertNil(final)
    XCTAssertEqual(source.text, "Die Fachabteilung entscheidet, ob wir live gehen. Compliance legt fest, welche Nachweise wir aufbewahren müssen.")
    XCTAssertEqual(source.revision, 3)
    XCTAssertEqual(source.acceptedIntervals, accepted)
  }
}
