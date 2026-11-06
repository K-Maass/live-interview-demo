import Foundation
import Translation
import WhisperKit

public struct SpeechEvent: Codable, Sendable {
  public let meetingId: String
  public let segmentId: String
  public let revision: Int
  public let journalSequence: Int
  public let lane: CaptureLane
  public let startMs: Int
  public let endMs: Int
  public let language: String
  public let text: String
  public let kind: String
  public let sourceSegmentId: String?
  /// Chunk-relative seconds from already-filtered recognition, retained for local translation retry.
  public let acceptedIntervals: [SpeechInterval]?
}
public struct RecognizedText: Sendable {
  public let text: String
  public let language: String
  public let durationMs: Int
  public let intervals: [SpeechInterval]
  public init(text: String, language: String, durationMs: Int, intervals: [SpeechInterval] = []) {
    self.text = text
    self.language = language
    self.durationMs = durationMs
    self.intervals = intervals
  }
}
/// Filter using decoder confidence, never a phrase blacklist or guessed identity.
public func isReliableSpeech(
  text: String, averageLogProbability: Float, compressionRatio: Float
) -> Bool {
  text.contains { $0.isLetter || $0.isNumber }
    && averageLogProbability.isFinite && averageLogProbability >= -1
    && compressionRatio.isFinite && compressionRatio <= 2.4
}
/// One recognized segment before the confidence filter.
public struct DecodedSegment: Sendable {
  public let text: String
  public let start: Float
  public let end: Float
  public let averageLogProbability: Float
  public let compressionRatio: Float
  public init(
    text: String, start: Float, end: Float, averageLogProbability: Float, compressionRatio: Float
  ) {
    self.text = text
    self.start = start
    self.end = end
    self.averageLogProbability = averageLogProbability
    self.compressionRatio = compressionRatio
  }
}
/// Keeps only reliable segments. A chunk with none (noise, music, a cough) is an ordinary empty result:
/// it is decoded with no events, never a helper failure, so the helper and its loaded model stay alive.
public func reliableRecognition(_ segments: [DecodedSegment], language: String) -> RecognizedText {
  let reliable = segments.filter {
    isReliableSpeech(
      text: $0.text, averageLogProbability: $0.averageLogProbability,
      compressionRatio: $0.compressionRatio)
  }
  guard !reliable.isEmpty else { return RecognizedText(text: "", language: language, durationMs: 0) }
  return RecognizedText(
    text: reliable.map(\.text).joined(separator: " ").trimmingCharacters(
      in: .whitespacesAndNewlines), language: language,
    durationMs: Int((reliable.last?.end ?? 0) * 1000),
    intervals: reliable.map { SpeechInterval(start: $0.start, end: $0.end) })
}
public func decodeUtterance(
  _ request: DecodeRequest, cache: URL, recognize: (URL) async throws -> RecognizedText,
  translate: (RecognizedText) async throws -> String, onSource: ((SpeechEvent) async -> Void)? = nil,
  isolation: isolated (any Actor)? = #isolation
) async throws -> [SpeechEvent] {
  guard request.mode == "transcribe" else { throw SpeechFailure.invalidMode }
  let path = try ownedAudioPath(request.audioPath, root: cache)
  let result = try await recognize(path)
  guard !result.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
  let source = SpeechEvent(
    meetingId: request.meetingId, segmentId: request.segmentId, revision: request.revision,
    journalSequence: request.sequence, lane: request.lane, startMs: request.startMs,
    endMs: request.startMs + result.durationMs, language: result.language, text: result.text,
    kind: "final", sourceSegmentId: nil, acceptedIntervals: result.intervals)
  if let onSource { await onSource(source) }
  if request.sourceOnly || result.language == "en" { return [source] }
  // A translation failure cannot discard already recognized source evidence.
  guard let translated = try? await translate(result) else { return [source] }
  return [
    source,
    SpeechEvent(
      meetingId: request.meetingId, segmentId: request.segmentId + ":en", revision: source.revision,
      journalSequence: request.sequence, lane: request.lane, startMs: source.startMs,
      endMs: source.endMs, language: "en", text: translated, kind: "translation",
      sourceSegmentId: source.segmentId, acceptedIntervals: nil),
  ]
}

/// Overrides the upstream tokenizer's download-on-error fallback. Runtime never uses it.
final class OfflineWhisper: WhisperKit {
  override func loadModels(prewarmMode: Bool = false) async throws {
    let start = Date()
    try await super.loadModels(prewarmMode: prewarmMode)
    fputs(
      "localSpeechTiming modelLoad prewarm=\(prewarmMode) ms=\(Int(Date().timeIntervalSince(start)*1000))\n",
      stderr)
  }
  override func loadTokenizerIfNeeded() async throws {
    guard tokenizer == nil else { return }
    guard let root = tokenizerFolder, let logits = textDecoder.logitsSize else {
      throw SpeechFailure.missingAssets
    }
    textDecoder.isModelMultilingual = logits != 51864
    let start = Date()
    let local = try await AutoTokenizerWrapper.from(
      modelFolder: root, hubApi: HubApiWrapper(downloadBase: root))
    tokenizer = LocalTokenizer(local)
    fputs("localSpeechTiming tokenizer ms=\(Int(Date().timeIntervalSince(start)*1000))\n", stderr)
  }
}
/// Apple on-device translation needs macOS 26; the app itself still runs on macOS 14.2 without it.
public func appleTranslationStatus(source: String, target: String) async -> AppleTranslationStatus {
  guard #available(macOS 26.0, *) else { return .unavailable }
  let status = await LanguageAvailability().status(
    from: Locale.Language(identifier: source), to: Locale.Language(identifier: target))
  switch status {
  case .installed: return .installed
  case .supported: return .supported
  default: return .unsupported
  }
}
/// Source languages whose translation into `target` is installed, so readiness never assumes particular
/// languages. Regional variants collapse to their language code because recognition reports plain codes.
public func appleInstalledSources(target: String) async -> [String] {
  guard #available(macOS 26.0, *) else { return [] }
  var codes = Set<String>()
  for language in await LanguageAvailability().supportedLanguages {
    codes.insert(language.languageCode?.identifier ?? language.minimalIdentifier)
  }
  var installed: [String] = []
  for code in codes.sorted() where code != target {
    if await appleTranslationStatus(source: code, target: target) == .installed { installed.append(code) }
  }
  return installed
}
public actor RecognitionWorker {
  private var recognition: WhisperKit?
  private var translation: WhisperKit?
  private let models: URL
  private let route: TranslationRoute
  private let prewarm: Bool
  public init(models: URL, route: TranslationRoute = .apple, prewarm: Bool = false) {
    self.models = models
    self.route = route
    self.prewarm = prewarm
  }
  public func warm() async throws {
    if recognition != nil { return }
    let folder = models.appendingPathComponent("recognition")
    let tokenizer = models.appendingPathComponent("tokenizer")
    guard
      FileManager.default.fileExists(
        atPath: folder.appendingPathComponent("AudioEncoder.mlmodelc").path),
      FileManager.default.fileExists(
        atPath: tokenizer.appendingPathComponent("tokenizer.json").path)
    else { throw SpeechFailure.missingAssets }
    recognition = try await OfflineWhisper(
      WhisperKitConfig(
        modelFolder: folder.path, tokenizerFolder: tokenizer, verbose: false, prewarm: prewarm,
        load: true, download: false))
  }
  public func decode(
    _ request: DecodeRequest, cache: URL, onSource: (@Sendable (SpeechEvent) async -> Void)? = nil
  ) async throws -> [SpeechEvent] {
    try await warm()
    let path = try ownedAudioPath(request.audioPath, root: cache)
    return try await decodeUtterance(
      request, cache: cache,
      recognize: { path in
        guard let engine = self.recognition else { throw SpeechFailure.missingAssets }
        let intervals = try speechIntervals(in: path)
        guard !intervals.isEmpty else {
          return RecognizedText(text: "", language: "unknown", durationMs: 0)
        }
        let results = try await engine.transcribe(
          audioPath: path.path,
          decodeOptions: DecodingOptions(
            task: .transcribe, language: request.languageHint,
            temperatureFallbackCount: 1, sampleLength: 128,
            detectLanguage: request.languageHint == nil, skipSpecialTokens: true,
            clipTimestamps: intervals.flatMap { [$0.start, $0.end] }))
        return reliableRecognition(
          results.flatMap(\.segments).map {
            DecodedSegment(
              text: $0.text, start: $0.start, end: $0.end,
              averageLogProbability: $0.avgLogprob, compressionRatio: $0.compressionRatio)
          }, language: results.first?.language ?? "unknown")
      },
      translate: { text in
        try await self.translateRecognizedText(path: path, text: text)
      }, onSource: onSource)
  }
  /// Used by a separate serial helper. Translation never warms the recognition model.
  public func translateUtterance(_ request: TranslateUtteranceRequest, cache: URL) async throws -> SpeechEvent {
    try await translateSourceUtterance(request, cache: cache) { path, text, target in
      try await self.translateRecognizedText(path: path, text: text, target: target)
    }
  }
  /// Routes by the detected source language and the requested target. When no permitted route can translate
  /// the pair this throws, so the caller keeps the source and marks translation pending.
  private func translateRecognizedText(
    path: URL, text: RecognizedText, target: String = defaultTranslationTarget
  ) async throws -> String {
    let apple = route == .mediumOnly
      ? AppleTranslationStatus.unavailable
      : await appleTranslationStatus(source: text.language, target: target)
    switch chooseTranslation(route: route, apple: apple, target: target) {
    case .apple:
      guard #available(macOS 26.0, *) else { throw SpeechFailure.translationUnavailable }
      let session = TranslationSession(
        installedSource: Locale.Language(identifier: text.language),
        target: Locale.Language(identifier: target))
      return try await session.translate(text.text).targetText
    case .medium:
      return try await translateAudio(path: path, language: text.language, intervals: text.intervals)
    case .unavailable:
      throw SpeechFailure.translationUnavailable
    }
  }
  private func translateAudio(path: URL, language: String, intervals: [SpeechInterval]) async throws
    -> String
  {
    guard !intervals.isEmpty else { throw SpeechFailure.invalidTranslationIntervals }
    if translation == nil {
      let folder = models.appendingPathComponent("translation")
      guard
        FileManager.default.fileExists(
          atPath: folder.appendingPathComponent("AudioEncoder.mlmodelc").path)
      else { throw SpeechFailure.missingAssets }
      translation = try await OfflineWhisper(
        WhisperKitConfig(
          modelFolder: folder.path,
          tokenizerFolder: models.appendingPathComponent("translation-tokenizer"), verbose: false,
          prewarm: prewarm, load: true, download: false))
    }
    guard let engine = translation else { throw SpeechFailure.missingAssets }
    return try await translateAcceptedIntervals(intervals, language: language) { options in
      try await engine.transcribe(audioPath: path.path, decodeOptions: options).flatMap(\.segments)
    }
  }
}
