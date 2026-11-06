import Foundation

public enum CaptureLane: String, Codable, Sendable { case me, remote }
public struct DecodeRequest: Codable, Sendable {
  public let kind: String
  public let meetingId: String
  public let segmentId: String
  public let lane: CaptureLane
  public let audioPath: String
  public let startMs: Int
  public let sequence: Int
  public let mode: String
  public let languageHint: String?
  public let sourceOnly: Bool
  public let revision: Int
  private enum CodingKeys: String, CodingKey {
    case kind, meetingId, segmentId, lane, audioPath, startMs, sequence, mode, languageHint, sourceOnly, revision
  }
  public init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    kind = try values.decode(String.self, forKey: .kind)
    meetingId = try values.decode(String.self, forKey: .meetingId)
    segmentId = try values.decode(String.self, forKey: .segmentId)
    lane = try values.decode(CaptureLane.self, forKey: .lane)
    audioPath = try values.decode(String.self, forKey: .audioPath)
    startMs = try values.decode(Int.self, forKey: .startMs)
    sequence = try values.decode(Int.self, forKey: .sequence)
    mode = try values.decode(String.self, forKey: .mode)
    languageHint = try values.decodeIfPresent(String.self, forKey: .languageHint)
    sourceOnly = try values.decodeIfPresent(Bool.self, forKey: .sourceOnly) ?? false
    revision = try values.decodeIfPresent(Int.self, forKey: .revision) ?? 1
    guard revision > 0 else {
      throw DecodingError.dataCorruptedError(forKey: .revision, in: values,
        debugDescription: "Source revision must be positive")
    }
  }
}
public struct TranslateUtteranceRequest: Codable, Sendable {
  public let kind: String
  public let source: SpeechEvent
  public let audioPath: String
  public let meetingId: String?
  public let lane: CaptureLane?
  public let segmentId: String?
  public let revision: Int?
  /// Language to translate into; nil means English until the app has a per-user target language.
  public var target: String? = nil
  private enum CodingKeys: String, CodingKey {
    case kind, source, audioPath, meetingId, lane, segmentId, revision, target
  }
}
extension TranslateUtteranceRequest {
  public init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    kind = try values.decode(String.self, forKey: .kind)
    source = try values.decode(SpeechEvent.self, forKey: .source)
    audioPath = try values.decode(String.self, forKey: .audioPath)
    meetingId = values.contains(.meetingId) ? try values.decode(String.self, forKey: .meetingId) : nil
    lane = values.contains(.lane) ? try values.decode(CaptureLane.self, forKey: .lane) : nil
    segmentId = values.contains(.segmentId) ? try values.decode(String.self, forKey: .segmentId) : nil
    revision = values.contains(.revision) ? try values.decode(Int.self, forKey: .revision) : nil
    target = try values.decodeIfPresent(String.self, forKey: .target)
  }
}
public enum SpeechFailure: Error, Equatable {
  case outsideCache, missingAssets, invalidMode, unreliableSpeech, invalidTranslationIntervals
  /// No supported translation route can handle this language pair on this Mac; the source stays pending.
  case translationUnavailable
}
/// The wire code of a failure reply. Each failure keeps its own code so logs and diagnostics can tell a missing
/// model from refused audio; the app treats every failure reply alike (the chunk or translation stays pending).
public func failureCode(_ failure: SpeechFailure) -> String {
  switch failure {
  case .outsideCache: return "outsideCache"
  case .missingAssets: return "missingAssets"
  case .invalidMode: return "invalidMode"
  case .unreliableSpeech: return "unreliableSpeech"
  case .invalidTranslationIntervals: return "invalidTranslationIntervals"
  case .translationUnavailable: return "translationUnavailable"
  }
}
public func ownedAudioPath(_ path: String, root: URL) throws -> URL {
  let canonicalRoot = root.resolvingSymlinksInPath().standardizedFileURL
  let audio = URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL
  guard audio.path.hasPrefix(canonicalRoot.path + "/"),
    FileManager.default.fileExists(atPath: audio.path)
  else { throw SpeechFailure.outsideCache }
  return audio
}
/// Like `ownedAudioPath`, but a file that was inside the cache and has since been removed returns nil
/// instead of failing. A path outside the cache still fails, whether or not it exists.
public func ownedAudioPathAllowingRemoved(_ path: String, root: URL) throws -> URL? {
  if let owned = try? ownedAudioPath(path, root: root) { return owned }
  let requested = URL(fileURLWithPath: path).standardizedFileURL
  let canonicalRoot = root.resolvingSymlinksInPath().standardizedFileURL
  let parent = requested.deletingLastPathComponent().resolvingSymlinksInPath().standardizedFileURL
  guard (parent.path + "/").hasPrefix(canonicalRoot.path + "/"),
    !FileManager.default.fileExists(atPath: requested.path)
  else { throw SpeechFailure.outsideCache }
  return nil
}
