import CryptoKit
import EventKit
import Foundation
import XCTest
@testable import SpeechCore

final class CalendarMetadataTests: XCTestCase {
  func testSnapshotKeepsOccurrenceAndProviderMetadataWithoutRequestingPermission() {
    // Unsaved EventKit objects: no calendar query, account access, or permission request.
    let store = EKEventStore()
    let event = EKEvent(eventStore: store)
    event.calendar = EKCalendar(for: .event, eventStore: store)
    event.title = "Metadata fixture"
    event.startDate = Date(timeIntervalSince1970: 1_791_626_400)
    event.endDate = Date(timeIntervalSince1970: 1_791_630_000)
    event.url = URL(string: "https://teams.microsoft.com/l/meetup-join/fixture")
    let fields = CalendarWorker.snapshot(event)
    XCTAssertEqual(fields["occurrenceStartMs"] as? Int, 1_791_626_400_000)
    XCTAssertNotNil(fields["stableId"])
    XCTAssertEqual(fields["joinUrl"] as? String, "https://teams.microsoft.com/l/meetup-join/fixture")
    XCTAssertEqual(fields["cancelled"] as? Bool, false)
  }

  private func makeEvent(start: Date, end: Date, allDay: Bool) -> EKEvent {
    let store = EKEventStore()
    let event = EKEvent(eventStore: store)
    event.calendar = EKCalendar(for: .event, eventStore: store)
    event.title = "Flags fixture"
    event.isAllDay = allDay
    event.startDate = start
    event.endDate = end
    return event
  }

  private func localDate(_ y: Int, _ m: Int, _ d: Int, _ h: Int = 0, _ min: Int = 0, _ sec: Int = 0) -> Date {
    Calendar.current.date(from: DateComponents(year: y, month: m, day: d, hour: h, minute: min, second: sec))!
  }

  func testAllDayEventReportsLocalDayStringsWithExclusiveEnd() {
    // EventKit ends a one-day all-day event at 23:59:59 of the same day.
    let single = CalendarWorker.snapshot(
      makeEvent(start: localDate(2026, 10, 20), end: localDate(2026, 10, 20, 23, 59, 59), allDay: true))
    XCTAssertEqual(single["isAllDay"] as? Bool, true)
    XCTAssertEqual(single["startDay"] as? String, "2026-10-20")
    XCTAssertEqual(single["endDay"] as? String, "2026-10-21")
    let multi = CalendarWorker.snapshot(
      makeEvent(start: localDate(2026, 12, 30), end: localDate(2027, 1, 1, 23, 59, 59), allDay: true))
    XCTAssertEqual(multi["startDay"] as? String, "2026-12-30")
    XCTAssertEqual(multi["endDay"] as? String, "2027-01-02")
  }

  func testTimedEventHasNoDayStringsAndIsNotRecurring() {
    let timed = CalendarWorker.snapshot(
      makeEvent(start: localDate(2026, 10, 20, 9), end: localDate(2026, 10, 20, 10), allDay: false))
    XCTAssertEqual(timed["isAllDay"] as? Bool, false)
    XCTAssertEqual(timed["recurring"] as? Bool, false)
    XCTAssertNil(timed["startDay"])
    XCTAssertNil(timed["endDay"])
  }

  func testRecurrenceRuleMarksEventRecurring() {
    let event = makeEvent(start: localDate(2026, 10, 20, 9), end: localDate(2026, 10, 20, 10), allDay: false)
    event.addRecurrenceRule(EKRecurrenceRule(recurrenceWith: .weekly, interval: 1, end: nil))
    XCTAssertEqual(CalendarWorker.snapshot(event)["recurring"] as? Bool, true)
  }

  func testVersionIsTheHashOfTheOriginalFieldsOnly() throws {
    let event = makeEvent(start: localDate(2026, 10, 20), end: localDate(2026, 10, 20, 23, 59, 59), allDay: true)
    event.addRecurrenceRule(EKRecurrenceRule(recurrenceWith: .daily, interval: 1, end: nil))
    var fields = CalendarWorker.snapshot(event)
    let version = try XCTUnwrap(fields["version"] as? String)
    for key in [
      "version", "isAllDay", "recurring", "startDay", "endDay", "invitation", "organiserIsCurrentUser",
      "hasAttendees", "calendarWritable",
    ] { fields.removeValue(forKey: key) }
    XCTAssertEqual(
      Set(fields.keys),
      ["id", "stableId", "calendarId", "accountId", "occurrenceStartMs", "cancelled", "joinUrl", "organiser",
       "attendees", "title", "startMs", "endMs", "timeZone", "modifiedMs"])
    let data = try JSONSerialization.data(withJSONObject: fields, options: .sortedKeys)
    let expected = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    XCTAssertEqual(version, expected)
  }

  func testOrganiserFieldsMarkOnlyAnotherOrganiserAsAnInvitation() {
    XCTAssertEqual(CalendarWorker.organiserFields(organiserIsCurrentUser: false) as NSDictionary,
                   ["organiserIsCurrentUser": false, "invitation": true])
    XCTAssertEqual(CalendarWorker.organiserFields(organiserIsCurrentUser: true) as NSDictionary,
                   ["organiserIsCurrentUser": true, "invitation": false])
    // No organiser (a private event): not an invitation, and nothing is claimed about the organiser.
    XCTAssertEqual(CalendarWorker.organiserFields(organiserIsCurrentUser: nil) as NSDictionary, ["invitation": false])
  }

  func testSnapshotReportsOrganiserAndWritabilityOutsideTheVersion() {
    let event = makeEvent(start: localDate(2026, 10, 20, 9), end: localDate(2026, 10, 20, 10), allDay: false)
    let before = CalendarWorker.snapshot(event)
    XCTAssertEqual(before["invitation"] as? Bool, false)
    XCTAssertNil(before["organiserIsCurrentUser"])
    XCTAssertEqual(before["hasAttendees"] as? Bool, false)
    XCTAssertNotNil(before["calendarWritable"] as? Bool)
  }

  func testMoveRefusalsForRepeatingAllDayAndReadOnly() {
    let timed = CalendarWorker.snapshot(
      makeEvent(start: localDate(2026, 10, 20, 9), end: localDate(2026, 10, 20, 10), allDay: false))
    var writable = timed
    writable["calendarWritable"] = true
    XCTAssertNil(CalendarWorker.moveRefusal(writable))
    var locked = writable
    locked["calendarWritable"] = false
    XCTAssertEqual(CalendarWorker.moveRefusal(locked), "calendarReadOnly")
    let repeating = makeEvent(start: localDate(2026, 10, 20, 9), end: localDate(2026, 10, 20, 10), allDay: false)
    repeating.addRecurrenceRule(EKRecurrenceRule(recurrenceWith: .weekly, interval: 1, end: nil))
    XCTAssertEqual(CalendarWorker.moveRefusal(CalendarWorker.snapshot(repeating)), "recurringUnsupported")
    let allDay = CalendarWorker.snapshot(
      makeEvent(start: localDate(2026, 10, 20), end: localDate(2026, 10, 20, 23, 59, 59), allDay: true))
    XCTAssertEqual(CalendarWorker.moveRefusal(allDay), "allDayUnsupported")
  }

  func testMoveTargetIsTheOneItemAtTheReviewedStart() {
    let rows: [[String: Any]] = [
      ["id": "n1", "stableId": "item-1", "startMs": 1000, "occurrenceStartMs": 1000],
      ["id": "n2", "stableId": "item-2", "startMs": 1000, "occurrenceStartMs": 1000],
      ["id": "n3", "stableId": "series", "startMs": 1000, "occurrenceStartMs": 1000],
      ["id": "n4", "stableId": "series", "startMs": 9000, "occurrenceStartMs": 9000],
    ]
    XCTAssertEqual(try CalendarWorker.moveTargetIndex(rows, stableId: "item-2", eventId: nil, originalStartMs: 1000).get(), 1)
    XCTAssertEqual(try CalendarWorker.moveTargetIndex(rows, stableId: nil, eventId: "n1", originalStartMs: 1000).get(), 0)
    func code(_ r: Result<Int, CalendarWorker.MoveFailure>) -> String? {
      if case .failure(let f) = r { return f.code } else { return nil }
    }
    XCTAssertEqual(code(CalendarWorker.moveTargetIndex(rows, stableId: "missing", eventId: nil, originalStartMs: 1000)), "eventUnavailable")
    XCTAssertEqual(code(CalendarWorker.moveTargetIndex(rows, stableId: "item-1", eventId: nil, originalStartMs: 2000)), "eventChanged")
    XCTAssertEqual(code(CalendarWorker.moveTargetIndex(rows, stableId: "series", eventId: nil, originalStartMs: 1000)), "recurringUnsupported")
    XCTAssertEqual(code(CalendarWorker.moveTargetIndex(rows, stableId: nil, eventId: nil, originalStartMs: 1000)), "eventUnavailable")
  }

  func testAnyEditOfAnExistingEventGetsTheMoveRefusals() {
    func row(_ extra: [String: Any]) -> [String: Any] {
      var r: [String: Any] = [
        "id": "n", "stableId": "item", "startMs": 1000, "occurrenceStartMs": 1000, "version": "v1",
        "recurring": false, "isAllDay": false, "calendarWritable": true,
      ]
      for (k, v) in extra { r[k] = v }
      return r
    }
    func code(_ rows: [[String: Any]], version: String? = "v1") -> String? {
      let r = CalendarWorker.editTargetIndex(
        rows, stableId: "item", eventId: "n", originalStartMs: 1000, expectedVersion: version)
      if case .failure(let f) = r { return f.code } else { return nil }
    }
    XCTAssertNil(code([row([:])]))
    XCTAssertEqual(code([row(["recurring": true])]), "recurringUnsupported")
    XCTAssertEqual(code([row([:]), row(["startMs": 9000, "occurrenceStartMs": 9000])]), "recurringUnsupported")
    XCTAssertEqual(code([row(["isAllDay": true])]), "allDayUnsupported")
    XCTAssertEqual(code([row(["calendarWritable": false])]), "calendarReadOnly")
    XCTAssertEqual(code([row([:])], version: "v0"), "eventChanged")
    XCTAssertEqual(code([]), "eventUnavailable")
  }

  func testEventKitSaveErrorsForUnchangeableEventsMapToOneCode() {
    for code in [EKError.Code.eventNotMutable, .calendarReadOnly, .calendarIsImmutable, .invitesCannotBeMoved] {
      XCTAssertEqual(CalendarWorker.saveFailureCode(NSError(domain: EKErrorDomain, code: code.rawValue)), "eventNotModifiable")
    }
    XCTAssertEqual(CalendarWorker.saveFailureCode(NSError(domain: EKErrorDomain, code: EKError.Code.internalFailure.rawValue)), "calendarApplyFailed")
    XCTAssertEqual(CalendarWorker.saveFailureCode(NSError(domain: NSCocoaErrorDomain, code: 1)), "calendarApplyFailed")
  }

  func testAuthorizationNamesSeparateAskableFromSettingsOnlyStates() {
    XCTAssertEqual(CalendarWorker.authorizationName(.notDetermined), "notDetermined")
    XCTAssertEqual(CalendarWorker.authorizationName(.denied), "denied")
    XCTAssertEqual(CalendarWorker.authorizationName(.restricted), "restricted")
    XCTAssertEqual(CalendarWorker.authorizationName(.writeOnly), "writeOnly")
    XCTAssertEqual(CalendarWorker.authorizationName(.fullAccess), "fullAccess")
  }

  func testCalendarColourIsSRGBHexOrNothing() {
    let srgb = CGColorSpace(name: CGColorSpace.sRGB)!
    let blue = CGColor(colorSpace: srgb, components: [0x1b / 255.0, 0xad / 255.0, 0xf8 / 255.0, 1])
    XCTAssertEqual(CalendarWorker.hexColor(blue), "#1badf8")
    XCTAssertEqual(CalendarWorker.hexColor(CGColor(gray: 1, alpha: 1)), "#ffffff")
    XCTAssertNil(CalendarWorker.hexColor(nil))
  }
}
