import XCTest

@testable import SpeechCore

final class TranslationTests: XCTestCase {
  private func fixtureRequest(root: URL, sourceOnly: Bool? = nil, revision: Int? = nil) throws -> DecodeRequest {
    var json: [String: Any] = ["kind": "decode", "meetingId": "m", "segmentId": "s",
      "lane": "remote", "audioPath": root.appendingPathComponent("a.wav").path,
      "startMs": 5000, "sequence": 7, "mode": "transcribe"]
    if let sourceOnly { json["sourceOnly"] = sourceOnly }
    if let revision { json["revision"] = revision }
    return try JSONDecoder().decode(DecodeRequest.self,
      from: JSONSerialization.data(withJSONObject: json))
  }
  func testSourceOnlyNeverCallsTranslationAndPublishesAcceptedIntervals() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    try Data([0]).write(to: root.appendingPathComponent("a.wav"))
    let intervals = [SpeechInterval(start: 0.4, end: 1.2), SpeechInterval(start: 2.0, end: 2.7)]
    let request = try fixtureRequest(root: root, sourceOnly: true)
    var translated = false
    var published: [String] = []
    let events = try await decodeUtterance(request, cache: root,
      recognize: { _ in RecognizedText(text: "Wer entscheidet?", language: "de", durationMs: 2700, intervals: intervals) },
      translate: { _ in
        translated = true
        XCTFail("Source-only recognition must not enter a potentially blocked translator")
        throw SpeechFailure.missingAssets
      }, onSource: { event in published.append(event.text) })
    XCTAssertFalse(translated)
    XCTAssertEqual(published, ["Wer entscheidet?"])
    XCTAssertEqual(events.count, 1)
    let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(events[0])) as! [String: Any]
    XCTAssertEqual((json["acceptedIntervals"] as? [[String: Double]])?.count, 2)
    XCTAssertEqual((json["acceptedIntervals"] as? [[String: Double]])?[0]["start"] ?? -1, 0.4, accuracy: 0.00001)
    XCTAssertNil(json["audioPath"], "Source evidence cannot contain an audio path")
  }
  func testDecodeRequestDefaultsToInlineTranslationWhenSourceOnlyIsAbsent() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    try Data([0]).write(to: root.appendingPathComponent("a.wav"))
    let events = try await decodeUtterance(try fixtureRequest(root: root), cache: root,
      recognize: { _ in RecognizedText(text: "Wer entscheidet?", language: "de", durationMs: 1000) },
      translate: { _ in "Who decides?" })
    XCTAssertEqual(events.map(\.kind), ["final", "translation"])
    XCTAssertEqual(events.map(\.revision), [1, 1])
  }
  func testRequestedRevisionIsPreservedBySourceAndInlineTranslation() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    try Data([0]).write(to: root.appendingPathComponent("a.wav"))
    let events = try await decodeUtterance(try fixtureRequest(root: root, revision: 3), cache: root,
      recognize: { _ in RecognizedText(text: "Wer entscheidet?", language: "de", durationMs: 1000) },
      translate: { _ in "Who decides?" })
    XCTAssertEqual(events.map(\.revision), [3, 3])
  }
  func testSourceIsPublishedBeforeFailedTranslation() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let path = root.appendingPathComponent("a.wav")
    try Data([0]).write(to: path)
    let request = try JSONDecoder().decode(
      DecodeRequest.self,
      from: Data(
        "{\"kind\":\"decode\",\"meetingId\":\"m\",\"segmentId\":\"s\",\"lane\":\"me\",\"audioPath\":\"\(path.path)\",\"startMs\":0,\"sequence\":1,\"mode\":\"transcribe\"}"
          .utf8))
    var published = false
    let events = try await decodeUtterance(
      request, cache: root,
      recognize: { _ in RecognizedText(text: "Wer entscheidet?", language: "de", durationMs: 10) },
      translate: { _ in
        XCTAssertTrue(published)
        throw SpeechFailure.missingAssets
      }, onSource: { _ in published = true })
    XCTAssertTrue(published)
    XCTAssertEqual(events.count, 1)
    XCTAssertEqual(events[0].text, "Wer entscheidet?")
  }
}
