import Foundation
import SpeechCore
import Translation
import WhisperKit

@main struct LocalSpeechCLI {
  static func emit(_ value: Any) {
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
      let text = String(data: data, encoding: .utf8)
    {
      print(text)
      fflush(stdout)
    }
  }
  /// Assets whose download finished, read by the progress ticker while the main flow adds to it.
  final class FinishedAssets: @unchecked Sendable {
    private let lock = NSLock()
    private var ids = Set<String>()
    func insert(_ id: String) { lock.lock(); ids.insert(id); lock.unlock() }
    func remove(_ id: String) { lock.lock(); ids.remove(id); lock.unlock() }
    func contains(_ id: String) -> Bool { lock.lock(); defer { lock.unlock() }; return ids.contains(id) }
  }
  /// First-run model download. Emits `setupProgress` lines (bytes on disk against the hub's listed size, so a
  /// restarted download resumes from its partial files and reports what it already has), then `setupComplete`
  /// or one classified `failure`. Each model is moved into place only after it is complete, so a half-finished
  /// run never leaves a model that looks ready.
  static func setup(models: URL, withMedium: Bool) async {
    let hub = "https://huggingface.co"
    let downloads = models.appendingPathComponent("downloads")
    let hubRoot = downloads.appendingPathComponent("models/argmaxinc/whisperkit-coreml")
    @Sendable func roots(_ asset: SetupAsset) -> [URL] {
      [
        hubRoot.appendingPathComponent(asset.hubFolder),
        hubRoot.appendingPathComponent(".cache/huggingface/download/" + asset.hubFolder),
      ]
    }
    func installed(_ asset: SetupAsset) -> Bool {
      FileManager.default.fileExists(
        atPath: models.appendingPathComponent(asset.destination)
          .appendingPathComponent("AudioEncoder.mlmodelc").path)
    }
    do {
      try FileManager.default.createDirectory(at: models, withIntermediateDirectories: true)
      let pending = setupAssets(withMedium: withMedium).filter { !installed($0) }
      emit(setupProgressEvent(
        stage: "checking", asset: pending.first?.id ?? "tokenizer", completedBytes: 0, totalBytes: 0,
        resumedBytes: 0))
      var sizes: [String: Int] = [:]
      var listings: [String: [HubFile]] = [:]
      for asset in pending {
        // The listing at the pinned commit gives both the sizes for progress and the hashes to verify.
        var request = URLRequest(
          url: URL(
            string: hub + "/api/models/\(modelRepository)/tree/\(modelRevision)/" + asset.hubFolder
              + "?recursive=true")!)
        request.timeoutInterval = 30
        let (data, _) = try await URLSession.shared.data(for: request)
        sizes[asset.id] = try hubTreeBytes(data)
        listings[asset.id] = try hubTreeFiles(data)
      }
      let listed = sizes
      let total = listed.values.reduce(0, +)
      let resumed = min(pending.reduce(0) { $0 + bytesOnDisk(roots($1)) }, total)
      if !pending.isEmpty, let short = setupDiskShortfall(
        remaining: total - resumed, available: availableBytes(at: models))
      {
        emit(["kind": "failure", "code": SetupFailureCode.diskFull.rawValue,
          "neededBytes": short.neededBytes, "availableBytes": short.availableBytes])
        return
      }
      let finished = FinishedAssets()
      @Sendable func completed() -> Int {
        pending.reduce(0) {
          $0 + (finished.contains($1.id) ? listed[$1.id] ?? 0 : min(bytesOnDisk(roots($1)), listed[$1.id] ?? 0))
        }
      }
      for asset in pending {
        for attempt in 1...3 {
          let ticker = Task {
            while !Task.isCancelled {
              emit(setupProgressEvent(
                stage: "downloading", asset: asset.id, completedBytes: completed(), totalBytes: total,
                resumedBytes: resumed, attempt: attempt))
              try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
          }
          defer { ticker.cancel() }
          do {
            let snapshot = try await HubApiWrapper(downloadBase: downloads).snapshot(
              from: HubApiWrapper.Repo(id: modelRepository), revision: modelRevision,
              matching: [asset.hubFolder + "/*"])
            // Bad or truncated files are removed and the attempt retried, never installed.
            try verifyDownload(snapshot: snapshot, files: listings[asset.id] ?? [])
            let downloaded = snapshot.appendingPathComponent(asset.hubFolder)
            let target = models.appendingPathComponent(asset.destination)
            if FileManager.default.fileExists(atPath: target.path) {
              try FileManager.default.removeItem(at: target)
            }
            // Counted as finished first, so the progress ticker never reads the gap where the staging copy is
            // gone and the installed copy is not yet counted.
            finished.insert(asset.id)
            // A rename on the same volume: no second copy of a multi-GB model and no half-copied folder.
            try FileManager.default.moveItem(at: downloaded, to: target)
            break
          } catch {
            ticker.cancel()
            finished.remove(asset.id)
            guard classifySetupError(error) == .network || error is SetupVerificationFailure,
              attempt < 3
            else { throw error }
            emit(setupProgressEvent(
              stage: "retrying", asset: asset.id, completedBytes: completed(), totalBytes: total,
              resumedBytes: resumed, attempt: attempt + 1))
            try? await Task.sleep(nanoseconds: UInt64(attempt) * 3_000_000_000)
          }
        }
      }
      // Tokenizers are a few MB each; files already present are kept, so a retry only fetches what is missing.
      for asset in setupAssets(withMedium: withMedium) {
        emit(setupProgressEvent(
          stage: "tokenizer", asset: asset.id, completedBytes: completed(), totalBytes: total,
          resumedBytes: resumed))
        let tokenizer = models.appendingPathComponent(asset.tokenizerDestination)
        try FileManager.default.createDirectory(at: tokenizer, withIntermediateDirectories: true)
        for (name, blob) in asset.tokenizerFiles.sorted(by: { $0.key < $1.key }) {
          let file = tokenizer.appendingPathComponent(name)
          if (try? gitBlobId(of: file)) == blob { continue }
          var request = URLRequest(
            url: URL(
              string: hub + "/openai/\(asset.tokenizerRepository)/resolve/\(asset.tokenizerRevision)/"
                + name)!)
          request.timeoutInterval = 60
          let (data, response) = try await URLSession.shared.data(for: request)
          guard (response as? HTTPURLResponse)?.statusCode == 200, gitBlobId(of: data) == blob else {
            throw SpeechFailure.missingAssets
          }
          try data.write(to: file, options: .atomic)
        }
      }
      emit(["kind": "setupComplete"])
    } catch {
      emit(["kind": "failure", "code": classifySetupError(error).rawValue])
    }
  }
  /// Ends the helper when the app that started it exits or crashes, also in the middle of a request. A busy
  /// helper (a model warm-up can run for minutes, #58) does not read its input, so it would never see the input
  /// close and would keep running, owned by launchd.
  static func exitWithParent() -> DispatchSourceProcess {
    let parent = getppid()
    let watch = DispatchSource.makeProcessSource(identifier: parent, eventMask: .exit, queue: .global())
    watch.setEventHandler { exit(EXIT_SUCCESS) }
    watch.resume()
    // The parent may have exited before the watch started; launchd never starts this helper itself.
    if parent == 1 || getppid() != parent { exit(EXIT_SUCCESS) }
    return watch
  }
  static func main() async {
    let parentWatch = exitWithParent()
    defer { withExtendedLifetime(parentWatch) {} }
    let args = CommandLine.arguments
    guard args.count >= 3 else {
      emit(["kind": "failure", "code": "configuration"])
      return
    }
    let models = URL(fileURLWithPath: args[1])
    let cache = URL(fileURLWithPath: args[2])
    if args.contains("--setup") {
      // Medium translation is experimental, so its large download happens only when the setting asks for it.
      await setup(models: models, withMedium: args.contains("--with-medium-translation"))
      return
    }
    // Default: Apple on-device translation only. Medium is experimental (#29); --force-medium-translation is
    // for the benchmark, --experimental-medium-translation is the app's off-by-default setting.
    let route: TranslationRoute = args.contains("--force-medium-translation") ? .mediumOnly
      : args.contains("--experimental-medium-translation") ? .appleThenMedium : .apple
    let worker = RecognitionWorker(
      models: models, route: route, prewarm: args.contains("--prewarm-models"))
    while let line = readLine() {
      guard let data = line.data(using: .utf8),
        let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let kind = json["kind"] as? String
      else {
        emit(["kind": "failure", "code": "invalidRequest"])
        continue
      }
      do {
        switch kind {
        case "calendarCapabilities", "calendarRead", "calendarApply":
          emit(try await CalendarWorker.handle(json))
        case "embedText":
          emit(try SemanticWorker.handle(json))
        case "translateText":
          if #available(macOS 26.0, *) {
            let source = Locale.Language(identifier: json["source"] as? String ?? "en")
            let target = Locale.Language(identifier: json["target"] as? String ?? "de")
            guard await LanguageAvailability().status(from: source, to: target) == .installed else {
              throw SpeechFailure.missingAssets
            }
            let translated = try await TranslationSession(installedSource: source, target: target)
              .translate(json["text"] as? String ?? "")
            emit(["kind": "translatedText", "text": translated.targetText])
          } else {
            throw SpeechFailure.missingAssets
          }
        case "translationStatus":
          let target = json["target"] as? String ?? defaultTranslationTarget
          let installed = await appleInstalledSources(target: target)
          emit(["kind": "translationStatus", "target": target, "installedSources": installed,
            "appleAvailable": { if #available(macOS 26.0, *) { return true } else { return false } }(),
            "route": "\(route)"])
        case "warm":
          try await worker.warm()
          emit(["kind": "ready", "recognitionReady": true])
        case "translateUtterance":
          let request = try JSONDecoder().decode(TranslateUtteranceRequest.self, from: data)
          let event = try await worker.translateUtterance(request, cache: cache)
          let encoded = try JSONEncoder().encode(event)
          if let object = try JSONSerialization.jsonObject(with: encoded) as? [String: Any] {
            emit(["kind": "speech", "event": object])
          }
          emit(["kind": "translatedUtterance", "segmentId": request.source.segmentId,
            "revision": request.source.revision])
        case "decode":
          let request = try JSONDecoder().decode(DecodeRequest.self, from: data)
          for event in try await worker.decode(
            request, cache: cache,
            onSource: { @Sendable event in
              if let encoded = try? JSONEncoder().encode(event),
                let object = try? JSONSerialization.jsonObject(with: encoded) as? [String: Any]
              {
                emit(["kind": "speech", "event": object])
              }
            }) where event.kind == "translation"
          {
            let encoded = try JSONEncoder().encode(event)
            if let object = try JSONSerialization.jsonObject(with: encoded) as? [String: Any] {
              emit(["kind": "speech", "event": object])
            }
          }
          emit(["kind": "decoded", "segmentId": request.segmentId])
        case "flush": emit(["kind": "flushed"])
        case "shutdown": return
        default: emit(["kind": "failure", "code": "invalidRequest"])
        }
      } catch {
        var failure: [String: Any] = ["kind": "failure",
          "code": (error as? SpeechFailure).map(failureCode) ?? "decodeFailed",
          "segmentId": json["segmentId"] as? String ?? ""]
        if kind == "translateUtterance", let source = json["source"] as? [String: Any] {
          failure["segmentId"] = source["segmentId"] as? String ?? ""
          if let revision = source["revision"] { failure["revision"] = revision }
        }
        emit(failure)
      }
    }
  }
}
