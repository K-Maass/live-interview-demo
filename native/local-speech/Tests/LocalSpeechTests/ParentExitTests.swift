import Darwin
import Foundation
import XCTest

/// The app can quit or crash while the helper is busy (a model warm-up can run for minutes, #58), so the helper
/// must not depend on reading end-of-input to notice that the app is gone.
final class ParentExitTests: XCTestCase {
  func testHelperExitsWhenItsParentExitsEvenWhileItsInputStaysOpen() throws {
    let package = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
    let worker = package.appendingPathComponent(".build/debug/local-speech")
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let fifo = root.appendingPathComponent("input")
    XCTAssertEqual(mkfifo(fifo.path, 0o600), 0)
    // Held open for the whole test, so the helper's input never ends and it waits like a busy helper would.
    let writer = open(fifo.path, O_RDWR)
    XCTAssertGreaterThanOrEqual(writer, 0)
    defer { close(writer) }
    let parent = Process()
    parent.executableURL = URL(fileURLWithPath: "/bin/sh")
    parent.arguments = ["-c", "\"$0\" \"$1\" \"$2\" < \"$3\" > /dev/null 2>&1 & echo $!",
      worker.path, root.appendingPathComponent("missing-models").path, root.path, fifo.path]
    let output = Pipe()
    parent.standardOutput = output
    try parent.run()
    parent.waitUntilExit()
    let text = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    let pid = try XCTUnwrap(pid_t(text.trimmingCharacters(in: .whitespacesAndNewlines)))
    defer { kill(pid, SIGKILL) }
    let deadline = Date().addingTimeInterval(5)
    while kill(pid, 0) == 0, Date() < deadline { usleep(50_000) }
    XCTAssertNotEqual(kill(pid, 0), 0, "helper outlived its parent")
  }
}
