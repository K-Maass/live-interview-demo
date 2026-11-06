import XCTest

@testable import SpeechCore

final class ProtocolTests: XCTestCase {
  func testFixedCaptureLaneAndRequest() throws {
    let request = try JSONDecoder().decode(
      DecodeRequest.self,
      from: Data(
        #"{"kind":"decode","meetingId":"m","segmentId":"s","lane":"remote","audioPath":"/tmp/owned/a.wav","startMs":0,"sequence":21,"mode":"transcribe"}"#
          .utf8))
    XCTAssertEqual(request.lane, .remote)
    XCTAssertThrowsError(
      try JSONDecoder().decode(
        DecodeRequest.self,
        from: Data(
          #"{"kind":"decode","meetingId":"m","segmentId":"s","lane":"Lisa","audioPath":"a","startMs":0,"sequence":1,"mode":"transcribe"}"#
            .utf8)))
  }
  func testPathBoundaryResolvesSymlinks() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let inside = root.appendingPathComponent("a.wav")
    try Data([0]).write(to: inside)
    XCTAssertEqual(try ownedAudioPath(inside.path, root: root), inside.resolvingSymlinksInPath())
    XCTAssertThrowsError(try ownedAudioPath("/etc/hosts", root: root))
    try FileManager.default.createSymbolicLink(
      atPath: root.appendingPathComponent("escape").path, withDestinationPath: "/etc/hosts")
    XCTAssertThrowsError(try ownedAudioPath(root.appendingPathComponent("escape").path, root: root))
  }
}
