import AVFoundation
import Foundation
import WhisperKit

/// Every accepted interval must contribute reliable text before any complete translation is returned.
public func translateAcceptedIntervals(
  _ intervals: [SpeechInterval], language: String,
  transcribe: (DecodingOptions) async throws -> [TranscriptionSegment],
  isolation: isolated (any Actor)? = #isolation
) async throws -> String {
  guard !intervals.isEmpty else { throw SpeechFailure.invalidTranslationIntervals }
  var previousEnd: Float = 0
  for interval in intervals {
    guard interval.start.isFinite, interval.end.isFinite,
      interval.start >= previousEnd, interval.end > interval.start
    else { throw SpeechFailure.invalidTranslationIntervals }
    previousEnd = interval.end
  }
  var translated: [String] = []
  for interval in intervals {
    let segments = try await transcribe(DecodingOptions(
      task: .translate, language: language, temperatureFallbackCount: 1, sampleLength: 128,
      skipSpecialTokens: true, clipTimestamps: [interval.start, interval.end], windowClipTime: 0))
    guard !segments.isEmpty, segments.allSatisfy({
      isReliableSpeech(text: $0.text, averageLogProbability: $0.avgLogprob, compressionRatio: $0.compressionRatio)
    }) else { throw SpeechFailure.unreliableSpeech }
    let text = segments.map(\.text).joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { throw SpeechFailure.unreliableSpeech }
    translated.append(text)
  }
  return translated.joined(separator: " ")
}

public let defaultTranslationTarget = "en"

/// Which backend translates. Apple on-device translation (macOS 26+) is the supported route. Whisper medium is
/// experimental: it drops clauses, inverts meaning and mistranslates terms (#29), so it only runs when asked.
public enum TranslationRoute: Sendable, Equatable {
  case apple
  case appleThenMedium
  case mediumOnly
}
public enum AppleTranslationStatus: Sendable, Equatable {
  case installed, supported, unsupported, unavailable
}
public enum TranslationChoice: Sendable, Equatable { case apple, medium, unavailable }

/// Never returns `.medium` unless the route allows it, so an uncertain translation stays pending instead of
/// showing unreliable English. Whisper's translate task can only produce English.
public func chooseTranslation(
  route: TranslationRoute, apple: AppleTranslationStatus, target: String
) -> TranslationChoice {
  let mediumPossible = target == "en"
  switch route {
  case .apple: return apple == .installed ? .apple : .unavailable
  case .appleThenMedium:
    if apple == .installed { return .apple }
    return mediumPossible ? .medium : .unavailable
  case .mediumOnly: return mediumPossible ? .medium : .unavailable
  }
}

/// An explicit retry translates immutable source evidence; it never recognizes audio again.
public func translateSourceUtterance(
  _ request: TranslateUtteranceRequest, cache: URL,
  translate: (URL, RecognizedText, String) async throws -> String,
  isolation: isolated (any Actor)? = #isolation
) async throws -> SpeechEvent {
  let source = request.source
  guard request.kind == "translateUtterance", source.kind == "final",
    source.sourceSegmentId == nil, !source.meetingId.isEmpty, !source.segmentId.isEmpty,
    source.revision > 0, source.startMs >= 0, source.endMs > source.startMs,
    !source.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
    request.meetingId == nil || request.meetingId == source.meetingId,
    request.lane == nil || request.lane == source.lane,
    request.segmentId == nil || request.segmentId == source.segmentId,
    request.revision == nil || request.revision == source.revision
  else { throw SpeechFailure.invalidMode }
  // Without retained audio the app deletes a chunk's WAV once recognition is final. Apple translation
  // works from the recognized text, so a removed WAV inside the cache is not an error; only the audio
  // route then fails and leaves the source pending.
  let owned = try ownedAudioPathAllowingRemoved(request.audioPath, root: cache)
  let path = owned ?? URL(fileURLWithPath: request.audioPath)
  let target = request.target ?? defaultTranslationTarget
  guard !target.isEmpty else { throw SpeechFailure.invalidMode }
  let translated: String
  if source.language == target {
    translated = source.text
  } else {
    // Apple translation works from the text, so a source without accepted intervals (older records) can still be
    // retried; only the experimental audio route needs them, and it refuses an empty list itself.
    let intervals = source.acceptedIntervals ?? []
    let sourceDuration = Float(source.endMs - source.startMs) / 1000
    var duration = sourceDuration + 0.001
    if let owned {
      let audio = try AVAudioFile(forReading: owned)
      duration = Float(Double(audio.length) / audio.processingFormat.sampleRate)
    }
    guard duration.isFinite, duration > 0 else { throw SpeechFailure.invalidTranslationIntervals }
    var previousEnd: Float = 0
    for interval in intervals {
      guard interval.start.isFinite, interval.end.isFinite,
        interval.start >= previousEnd, interval.end > interval.start,
        interval.end <= duration, interval.end <= sourceDuration + 0.001
      else { throw SpeechFailure.invalidTranslationIntervals }
      previousEnd = interval.end
    }
    translated = try await translate(path, RecognizedText(
      text: source.text, language: source.language,
      durationMs: source.endMs - source.startMs, intervals: intervals), target)
  }
  guard !translated.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
    throw SpeechFailure.missingAssets
  }
  return SpeechEvent(
    meetingId: source.meetingId, segmentId: source.segmentId + ":" + target, revision: source.revision,
    journalSequence: source.journalSequence, lane: source.lane, startMs: source.startMs,
    endMs: source.endMs, language: target, text: translated, kind: "translation",
    sourceSegmentId: source.segmentId, acceptedIntervals: nil)
}
