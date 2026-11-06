import CoreGraphics
import CryptoKit
import EventKit
import Foundation

public enum CalendarWorker {
  static func milliseconds(_ date: Date) -> Int { Int(date.timeIntervalSince1970 * 1000) }
  /// A calendar colour as "#rrggbb" in sRGB, or nil when it has none or cannot be converted.
  static func hexColor(_ color: CGColor?) -> String? {
    guard let color, let srgb = CGColorSpace(name: CGColorSpace.sRGB),
      let converted = color.converted(to: srgb, intent: .defaultIntent, options: nil),
      let c = converted.components, c.count >= 3
    else { return nil }
    let byte = { (v: CGFloat) in Int((min(max(v, 0), 1) * 255).rounded()) }
    return String(format: "#%02x%02x%02x", byte(c[0]), byte(c[1]), byte(c[2]))
  }
  static func snapshot(_ event: EKEvent) -> [String: Any] {
    let fields: [String: Any] = [
      "id": event.eventIdentifier ?? "", "stableId": event.calendarItemIdentifier,
      "calendarId": event.calendar.calendarIdentifier,
      "accountId": event.calendar.source?.sourceIdentifier ?? "",
      "occurrenceStartMs": milliseconds(event.occurrenceDate ?? event.startDate),
      "cancelled": event.status == .canceled,
      "joinUrl": event.url?.absoluteString ?? "",
      "organiser": event.organizer?.url.absoluteString.replacingOccurrences(of: "mailto:", with: "") ?? "",
      "attendees": (event.attendees ?? []).map { participant in
        ["name": participant.name ?? "Attendee",
         "email": participant.url.absoluteString.replacingOccurrences(of: "mailto:", with: "")]
      },
      "title": event.title ?? "", "startMs": milliseconds(event.startDate),
      "endMs": milliseconds(event.endDate),
      "timeZone": event.timeZone?.identifier ?? TimeZone.current.identifier,
      "modifiedMs": event.lastModifiedDate.map(milliseconds) ?? 0,
    ]
    var result = fields
    if let data = try? JSONSerialization.data(withJSONObject: fields, options: .sortedKeys) {
      result["version"] = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
    // Added after the hash on purpose: calendarApply compares this version with the one the
    // app saw when the change was reviewed, so the original field set must hash unchanged.
    result["isAllDay"] = event.isAllDay
    result["recurring"] = event.hasRecurrenceRules || event.isDetached
    // Also outside the hash: who organises the event, and whether its calendar accepts changes.
    for (key, value) in organiserFields(organiserIsCurrentUser: event.organizer?.isCurrentUser) {
      result[key] = value
    }
    result["hasAttendees"] = !(event.attendees ?? []).isEmpty
    result["calendarWritable"] = event.calendar?.allowsContentModifications ?? false
    if event.isAllDay {
      let start = event.startDate ?? Date()
      let end = event.endDate ?? start
      result["startDay"] = dayString(start)
      result["endDay"] = exclusiveEndDay(start: start, end: end)
    }
    return result
  }
  /// `invitation` is true only when EventKit names an organiser who is not this account's owner.
  /// EventKit decides `isCurrentUser` by the account's addresses; if one of them is missing from the
  /// person's Contacts card an own event can read as an invitation, which only adds a warning.
  static func organiserFields(organiserIsCurrentUser: Bool?) -> [String: Any] {
    guard let mine = organiserIsCurrentUser else { return ["invitation": false] }
    return ["organiserIsCurrentUser": mine, "invitation": !mine]
  }
  /// Why a move of this event (as `snapshot` reports it) is refused, or nil when it may be moved.
  static func moveRefusal(_ fields: [String: Any]) -> String? {
    if fields["recurring"] as? Bool == true { return "recurringUnsupported" }
    if fields["isAllDay"] as? Bool == true { return "allDayUnsupported" }
    if fields["calendarWritable"] as? Bool != true { return "calendarReadOnly" }
    return nil
  }
  /// The index of the one event a move names: same calendar item (or native id when no item id
  /// is given), at the start the change was reviewed against. Several matches are a series.
  static func moveTargetIndex(
    _ snapshots: [[String: Any]], stableId: String?, eventId: String?, originalStartMs: Int
  ) -> Result<Int, MoveFailure> {
    let matches = snapshots.indices.filter { i in
      let row = snapshots[i]
      if row["cancelled"] as? Bool == true { return false }
      if let stableId, !stableId.isEmpty { return row["stableId"] as? String == stableId }
      if let eventId, !eventId.isEmpty { return row["id"] as? String == eventId }
      return false
    }
    guard !matches.isEmpty else { return .failure(MoveFailure("eventUnavailable")) }
    guard matches.count == 1 else { return .failure(MoveFailure("recurringUnsupported")) }
    let row = snapshots[matches[0]]
    guard row["occurrenceStartMs"] as? Int == originalStartMs || row["startMs"] as? Int == originalStartMs
    else { return .failure(MoveFailure("eventChanged")) }
    return .success(matches[0])
  }
  /// The one existing event a reviewed change (a move or any other edit) may touch: found as
  /// `moveTargetIndex` finds it, refused as `moveRefusal` refuses it, and still at the version the
  /// person reviewed.
  static func editTargetIndex(
    _ snapshots: [[String: Any]], stableId: String?, eventId: String?, originalStartMs: Int,
    expectedVersion: String?
  ) -> Result<Int, MoveFailure> {
    switch moveTargetIndex(snapshots, stableId: stableId, eventId: eventId, originalStartMs: originalStartMs) {
    case .failure(let failure): return .failure(failure)
    case .success(let index):
      if let refusal = moveRefusal(snapshots[index]) { return .failure(MoveFailure(refusal)) }
      guard snapshots[index]["version"] as? String == expectedVersion else {
        return .failure(MoveFailure("eventChanged"))
      }
      return .success(index)
    }
  }
  /// Reads the calendar a day either side of the reviewed start and resolves the edit target.
  static func findEditTarget(_ request: [String: Any], store: EKEventStore, calendar: EKCalendar)
    -> Result<EKEvent, MoveFailure>
  {
    guard let original = (request["originalStartMs"] as? NSNumber)?.intValue else {
      return .failure(MoveFailure("invalidDate"))
    }
    let around = Date(timeIntervalSince1970: Double(original) / 1000)
    let found = store.events(
      matching: store.predicateForEvents(
        withStart: around.addingTimeInterval(-86_400), end: around.addingTimeInterval(86_400), calendars: [calendar]))
    return editTargetIndex(
      found.map(snapshot), stableId: request["stableId"] as? String, eventId: request["eventId"] as? String,
      originalStartMs: original, expectedVersion: request["expectedVersion"] as? String
    ).map { found[$0] }
  }
  public struct MoveFailure: Error, Equatable {
    public let code: String
    init(_ code: String) { self.code = code }
  }
  /// EventKit save errors that mean "this event cannot be changed here".
  static func saveFailureCode(_ error: Error) -> String {
    let error = error as NSError
    guard error.domain == EKErrorDomain else { return "calendarApplyFailed" }
    switch EKError.Code(rawValue: error.code) {
    case .eventNotMutable, .calendarReadOnly, .calendarIsImmutable, .invitesCannotBeMoved:
      return "eventNotModifiable"
    default: return "calendarApplyFailed"
    }
  }
  /// Moves one existing event in place: only its start and end change, span `.thisEvent`, no new event.
  static func applyMove(_ request: [String: Any], store: EKEventStore, calendar: EKCalendar) -> [String: Any] {
    func refuse(_ code: String) -> [String: Any] { ["kind": "calendarResult", "applied": false, "code": code] }
    guard let startMs = request["startMs"] as? Double, let endMs = request["endMs"] as? Double, endMs > startMs
    else { return refuse("invalidDate") }
    let event: EKEvent
    switch findEditTarget(request, store: store, calendar: calendar) {
    case .failure(let failure): return refuse(failure.code)
    case .success(let found): event = found
    }
    event.startDate = Date(timeIntervalSince1970: startMs / 1000)
    event.endDate = Date(timeIntervalSince1970: endMs / 1000)
    do {
      try store.save(event, span: .thisEvent, commit: true)
    } catch {
      store.reset()
      return refuse(saveFailureCode(error))
    }
    return ["kind": "calendarResult", "applied": true, "event": snapshot(event)]
  }
  /// Local-calendar `yyyy-MM-dd`.
  static func dayString(_ date: Date, calendar: Calendar = .current) -> String {
    // Gregorian digits regardless of the user's calendar or locale; the local time zone decides the day.
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    var gregorian = Calendar(identifier: .gregorian)
    gregorian.timeZone = calendar.timeZone
    formatter.calendar = gregorian
    formatter.timeZone = calendar.timeZone
    formatter.dateFormat = "yyyy-MM-dd"
    return formatter.string(from: date)
  }
  /// EventKit ends all-day events at 23:59:59 of the last day; return the exclusive end day.
  static func exclusiveEndDay(start: Date, end: Date, calendar: Calendar = .current) -> String {
    let lastMoment = max(end.addingTimeInterval(-1), start)
    let lastDay = calendar.startOfDay(for: lastMoment)
    let next = calendar.date(byAdding: .day, value: 1, to: lastDay) ?? lastDay.addingTimeInterval(86_400)
    return dayString(next, calendar: calendar)
  }
  /// What macOS says about calendar access, as plain words the app can tell apart: `notDetermined` can still be asked
  /// for; `denied`, `restricted` and `writeOnly` can only be changed in System Settings → Privacy & Security → Calendars.
  static func authorizationName(_ status: EKAuthorizationStatus) -> String {
    switch status {
    case .notDetermined: return "notDetermined"
    case .restricted: return "restricted"
    case .denied: return "denied"
    case .fullAccess: return "fullAccess"
    case .writeOnly: return "writeOnly"
    @unknown default: return "unknown"
    }
  }
  public static func handle(_ request: [String: Any]) async throws -> [String: Any] {
    var request = request
    if request["kind"] as? String == "calendarApply" {
      guard
        let capability = ProcessInfo.processInfo.environment["LIVE_INTERVIEW_CALENDAR_CAPABILITY"],
        let payload = request["payloadJson"] as? String,
        let signature = request["signature"] as? String, let data = payload.data(using: .utf8)
      else { throw SpeechFailure.invalidMode }
      let expected = HMAC<SHA256>.authenticationCode(
        for: data, using: SymmetricKey(data: Data(capability.utf8))
      ).map { String(format: "%02x", $0) }.joined()
      guard expected == signature,
        let signed = try JSONSerialization.jsonObject(with: data) as? [String: Any]
      else { throw SpeechFailure.invalidMode }
      request = signed
    }
    let store = EKEventStore()
    let kind = request["kind"] as? String ?? ""
    let status = EKEventStore.authorizationStatus(for: .event)
    var allowed = status == .fullAccess
    if kind == "calendarRead" && request["requestPermission"] as? Bool == true && !allowed {
      allowed = try await store.requestFullAccessToEvents()
    }
    let calendars = allowed ? store.calendars(for: .event) : []
    let capabilities = calendars.map { calendar in
      var row: [String: Any] = [
        "id": calendar.calendarIdentifier, "name": calendar.title, "account": calendar.source.title,
        "accountId": calendar.source.sourceIdentifier,
        "read": true, "add": calendar.allowsContentModifications,
        "edit": calendar.allowsContentModifications,
      ]
      // The colour Calendar shows for it, so Settings can draw the same dot. Omitted when it cannot be read.
      if let color = hexColor(calendar.cgColor) { row["color"] = color }
      return row
    }
    if kind == "calendarCapabilities" {
      return [
        "kind": "calendarResult", "capabilities": capabilities,
        "permission": allowed ? "granted" : "setupRequired",
        "authorization": authorizationName(status),
        "ics": ["read": false, "addDraft": true, "edit": false], "outlookUI": "notVerified",
      ]
    }
    guard allowed else {
      return [
        "kind": "calendarResult", "code": "calendarPermissionRequired", "events": [],
        "capabilities": capabilities,
      ]
    }
    if kind == "calendarRead" {
      let start = Date(
        timeIntervalSince1970: (request["startMs"] as? Double ?? Date().timeIntervalSince1970 * 1000)
          / 1000)
      let end = Date(
        timeIntervalSince1970: (request["endMs"] as? Double ?? start.addingTimeInterval(604800)
          .timeIntervalSince1970 * 1000) / 1000)
      guard end > start && end.timeIntervalSince(start) <= 2_678_400 else {
        throw SpeechFailure.invalidMode
      }
      let selected = calendars.filter { calendar in
        guard let id = request["calendarId"] as? String else { return true }
        return calendar.calendarIdentifier == id
      }
      let events = store.events(
        matching: store.predicateForEvents(withStart: start, end: end, calendars: selected))
      return [
        "kind": "calendarResult", "events": events.map(snapshot), "capabilities": capabilities,
      ]
    }
    if kind == "calendarApply", request["move"] as? Bool == true {
      guard let calendarId = request["calendarId"] as? String,
        let calendar = calendars.first(where: { $0.calendarIdentifier == calendarId })
      else { return ["kind": "calendarResult", "applied": false, "code": "eventUnavailable"] }
      guard calendar.allowsContentModifications else {
        return ["kind": "calendarResult", "applied": false, "code": "calendarReadOnly"]
      }
      return applyMove(request, store: store, calendar: calendar)
    }
    guard kind == "calendarApply", let calendarId = request["calendarId"] as? String,
      let calendar = calendars.first(where: { $0.calendarIdentifier == calendarId }),
      calendar.allowsContentModifications, let startMs = request["startMs"] as? Double,
      let endMs = request["endMs"] as? Double, endMs > startMs,
      let title = request["title"] as? String, !title.isEmpty
    else { throw SpeechFailure.invalidMode }
    let event: EKEvent
    if let id = request["eventId"] as? String, !id.isEmpty {
      // The same refusals as a move: never a repeating series (EventKit's lookup by identifier
      // would return its first occurrence), an all-day event or a read-only calendar.
      switch findEditTarget(request, store: store, calendar: calendar) {
      case .failure(let failure):
        return ["kind": "calendarResult", "applied": false, "code": failure.code]
      case .success(let existing): event = existing
      }
    } else {
      event = EKEvent(eventStore: store)
      event.calendar = calendar
    }
    event.title = title
    event.startDate = Date(timeIntervalSince1970: startMs / 1000)
    event.endDate = Date(timeIntervalSince1970: endMs / 1000)
    event.timeZone = TimeZone(
      identifier: request["timeZone"] as? String ?? TimeZone.current.identifier)
    try store.save(event, span: .thisEvent, commit: true)
    guard let id = event.eventIdentifier, let saved = store.event(withIdentifier: id) else {
      throw SpeechFailure.invalidMode
    }
    return ["kind": "calendarResult", "applied": true, "event": snapshot(saved)]
  }
}
