import AVFoundation
import CoreMedia
import Foundation
import SoundAnalysis

public struct SpeechInterval: Codable, Equatable, Sendable {
  public let start: Float
  public let end: Float
  public init(start: Float, end: Float) {
    self.start = start
    self.end = end
  }
}
private final class PresenceObserver: NSObject, SNResultsObserving {
  var intervals: [SpeechInterval] = []
  var failure: Error?
  var resultCount = 0
  let completion = DispatchSemaphore(value: 0)
  func request(_ request: SNRequest, didProduce result: SNResult) {
    guard let result = result as? SNClassificationResult else { return }
    resultCount += 1
    let score =
      result.classifications.filter { ["speech", "whispering"].contains($0.identifier) }
      .map(\.confidence).max() ?? 0
    guard score >= 0.25 else { return }
    let start = Float(CMTimeGetSeconds(result.timeRange.start))
    let end = Float(CMTimeGetSeconds(CMTimeRangeGetEnd(result.timeRange)))
    guard start.isFinite, end.isFinite, end > start else { return }
    intervals.append(SpeechInterval(start: max(0, start - 0.15), end: end + 0.15))
  }
  func request(_ request: SNRequest, didFailWithError error: Error) {
    failure = error
    completion.signal()
  }
  func requestDidComplete(_ request: SNRequest) { completion.signal() }
}
/// Apple supplies this classifier locally. The speech worker's network sandbox also covers it.
public func speechIntervals(in audio: URL) throws -> [SpeechInterval] {
  let file = try AVAudioFile(forReading: audio, commonFormat: .pcmFormatFloat32, interleaved: false)
  let duration = Float(Double(file.length) / file.processingFormat.sampleRate)
  guard duration.isFinite, duration > 0 else { throw SpeechFailure.missingAssets }
  let request = try SNClassifySoundRequest(classifierIdentifier: .version1)
  request.windowDuration = CMTime(seconds: 1, preferredTimescale: 16000)
  request.overlapFactor = 0.5
  let observer = PresenceObserver()
  // Short replies need a complete classifier window, but padding is never transcribed.
  let capacity = max(
    file.length,
    AVAudioFramePosition(
      ceil(max(1.5, CMTimeGetSeconds(request.windowDuration)) * file.processingFormat.sampleRate)))
  guard capacity > 0, capacity < Int64(UInt32.max),
    let buffer = AVAudioPCMBuffer(
      pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(capacity))
  else { throw SpeechFailure.missingAssets }
  try file.read(into: buffer)
  let actual = Int(buffer.frameLength)
  if let channels = buffer.floatChannelData {
    for channel in 0..<Int(buffer.format.channelCount) {
      for frame in actual..<Int(capacity) { channels[channel][frame] = 0 }
    }
  }
  buffer.frameLength = AVAudioFrameCount(capacity)
  let analyzer = SNAudioStreamAnalyzer(format: file.processingFormat)
  try analyzer.add(request, withObserver: observer)
  analyzer.analyze(buffer, atAudioFramePosition: 0)
  analyzer.completeAnalysis()
  guard observer.completion.wait(timeout: .now() + 10) == .success else {
    throw SpeechFailure.missingAssets
  }
  if let failure = observer.failure { throw failure }
  guard observer.resultCount > 0 else { throw SpeechFailure.missingAssets }
  var merged: [SpeechInterval] = []
  for raw in observer.intervals.sorted(by: { $0.start < $1.start }) {
    let interval = SpeechInterval(start: raw.start, end: min(raw.end, duration))
    guard interval.end > interval.start else { continue }
    if let last = merged.last, interval.start <= last.end {
      merged[merged.count - 1] = SpeechInterval(start: last.start, end: max(last.end, interval.end))
    } else {
      merged.append(interval)
    }
  }
  return merged
}
