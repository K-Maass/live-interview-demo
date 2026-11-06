import XCTest

@testable import SpeechCore

final class ModelSetupTests: XCTestCase {
  func testMediumModelIsPlannedOnlyWhenRequested() {
    XCTAssertEqual(setupAssets(withMedium: false).map(\.id), ["recognition"])
    XCTAssertEqual(setupAssets(withMedium: true).map(\.id), ["recognition", "translation"])
  }
  func testFailuresAreClassifiedForRecovery() {
    XCTAssertEqual(
      classifySetupError(NSError(domain: NSPOSIXErrorDomain, code: Int(ENOSPC))), .diskFull)
    XCTAssertEqual(
      classifySetupError(NSError(domain: NSCocoaErrorDomain, code: NSFileWriteOutOfSpaceError)),
      .diskFull)
    XCTAssertEqual(classifySetupError(URLError(.notConnectedToInternet)), .network)
    XCTAssertEqual(classifySetupError(URLError(.timedOut)), .network)
    let wrapped = NSError(
      domain: "Wrapper", code: 1,
      userInfo: [NSUnderlyingErrorKey: NSError(domain: NSPOSIXErrorDomain, code: Int(ENOSPC))])
    XCTAssertEqual(classifySetupError(wrapped), .diskFull)
    XCTAssertEqual(classifySetupError(SpeechFailure.missingAssets), .assetSetup)
  }
  func testDownloadsArePinnedToCommitsNotMain() {
    let commit = try! NSRegularExpression(pattern: "^[0-9a-f]{40}$")
    func pinned(_ value: String) -> Bool {
      commit.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil
    }
    XCTAssertTrue(pinned(modelRevision))
    for asset in setupAssets(withMedium: true) {
      XCTAssertTrue(pinned(asset.tokenizerRevision))
      XCTAssertEqual(Set(asset.tokenizerFiles.keys), ["tokenizer.json", "tokenizer_config.json", "config.json"])
      XCTAssertTrue(asset.tokenizerFiles.values.allSatisfy(pinned))
    }
  }
  func testListingCarriesTheHashUsedForVerification() throws {
    let listing = Data(
      #"[{"type":"file","path":"m/w.bin","size":135,"oid":"pointer","lfs":{"size":1000,"oid":"ABC"}},{"type":"file","path":"m/config.json","size":24,"oid":"def"}]"#
        .utf8)
    XCTAssertEqual(
      try hubTreeFiles(listing),
      [
        HubFile(path: "m/w.bin", size: 1000, sha256: "ABC", gitOid: ""),
        HubFile(path: "m/config.json", size: 24, sha256: nil, gitOid: "def"),
      ])
  }
  func testDownloadedFilesMustMatchTheirListedHashAndBadOnesAreRemoved() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root.appendingPathComponent("m"), withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let hello = Data("hello\n".utf8)
    XCTAssertEqual(gitBlobId(of: hello), "ce013625030ba8dba906f756967f9e9ca394464a")
    try hello.write(to: root.appendingPathComponent("m/config.json"))
    try hello.write(to: root.appendingPathComponent("m/w.bin"))
    let sha = "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03"
    XCTAssertEqual(try sha256Hex(of: root.appendingPathComponent("m/w.bin")), sha)
    let good = [
      HubFile(path: "m/config.json", size: 6, sha256: nil, gitOid: "ce013625030ba8dba906f756967f9e9ca394464a"),
      HubFile(path: "m/w.bin", size: 6, sha256: sha, gitOid: ""),
    ]
    XCTAssertNoThrow(try verifyDownload(snapshot: root, files: good))
    let tampered = [HubFile(path: "m/w.bin", size: 6, sha256: String(repeating: "0", count: 64), gitOid: "")]
    XCTAssertThrowsError(try verifyDownload(snapshot: root, files: tampered)) { error in
      XCTAssertEqual(error as? SetupVerificationFailure, SetupVerificationFailure(paths: ["m/w.bin"]))
    }
    XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("m/w.bin").path))
    let missing = [HubFile(path: "m/absent.bin", size: 1, sha256: sha, gitOid: "")]
    XCTAssertThrowsError(try verifyDownload(snapshot: root, files: missing))
  }
  func testHubListingSumsRealLfsSizesNotPointerFiles() throws {
    let listing = Data(
      #"[{"type":"directory","path":"m/A.mlmodelc","size":0},{"type":"file","path":"m/A.mlmodelc/weights/weight.bin","size":135,"lfs":{"size":1000}},{"type":"file","path":"m/config.json","size":24}]"#
        .utf8)
    XCTAssertEqual(try hubTreeBytes(listing), 1024)
    XCTAssertThrowsError(try hubTreeBytes(Data("[]".utf8)))
    XCTAssertThrowsError(try hubTreeBytes(Data(#"{"error":"nope"}"#.utf8)))
  }
  func testBytesOnDiskCountsPartialFilesAndSkipsMissingRoots() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(
      at: root.appendingPathComponent("nested"), withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    try Data(count: 300).write(to: root.appendingPathComponent("a.bin"))
    try Data(count: 200).write(to: root.appendingPathComponent("nested/b.etag.incomplete"))
    XCTAssertEqual(
      bytesOnDisk([root, root.appendingPathComponent("absent")]), 500)
  }
  func testDiskShortfallKeepsMarginAndIgnoresUnknownSpace() {
    let gib = 1 << 30
    XCTAssertNil(setupDiskShortfall(remaining: 3 * gib, available: 4 * gib + 1))
    XCTAssertEqual(
      setupDiskShortfall(remaining: 3 * gib, available: 2 * gib),
      SetupDiskCheck(neededBytes: 4 * gib, availableBytes: 2 * gib))
    // A resumed download is only asked for what is still missing.
    XCTAssertNil(setupDiskShortfall(remaining: 0, available: gib))
    XCTAssertNil(setupDiskShortfall(remaining: 9 * gib, available: nil))
  }
  func testAvailableSpaceIsReadForAPathThatDoesNotExistYet() throws {
    let missing = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
      .appendingPathComponent("models")
    XCTAssertGreaterThan(try XCTUnwrap(availableBytes(at: missing)), 0)
  }
  func testProgressEventNeverReportsMoreThanTheTotal() {
    let event = setupProgressEvent(
      stage: "downloading", asset: "recognition", completedBytes: 150, totalBytes: 100,
      resumedBytes: 120)
    XCTAssertEqual(event["completedBytes"] as? Int, 100)
    XCTAssertEqual(event["resumedBytes"] as? Int, 100)
    XCTAssertEqual(event["kind"] as? String, "setupProgress")
  }
}
