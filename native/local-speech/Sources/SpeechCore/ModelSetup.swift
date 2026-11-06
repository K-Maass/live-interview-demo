import CryptoKit
import Foundation

/// The model repository on the Hugging Face hub and the commit the setup downloads from. A commit, not
/// `main`: a later push to the repository cannot change what a new install gets, and every file is
/// checked against this commit's listing before it is installed.
public let modelRepository = "argmaxinc/whisperkit-coreml"
public let modelRevision = "0f63a7800b00dd0226abd051b906c246e1907482"

/// One model the first-run setup can fetch. Recognition is always needed; the medium translation model only
/// when the experimental setting asks for it.
public struct SetupAsset: Sendable, Equatable {
  public let id: String
  public let variant: String
  /// Folder inside the public `argmaxinc/whisperkit-coreml` repository.
  public let hubFolder: String
  public let destination: String
  public let tokenizerRepository: String
  public let tokenizerDestination: String
  /// Commit of `openai/<tokenizerRepository>` the tokenizer files come from.
  public let tokenizerRevision: String
  /// Git blob ids of the tokenizer files at that commit, so each file is verified before it is kept.
  public let tokenizerFiles: [String: String]
}
public func setupAssets(withMedium: Bool) -> [SetupAsset] {
  let recognition = SetupAsset(
    id: "recognition", variant: "large-v3_turbo", hubFolder: "openai_whisper-large-v3_turbo",
    destination: "recognition", tokenizerRepository: "whisper-large-v3-turbo", // gitleaks:allow — public model repository, revision, or checksum
    tokenizerDestination: "tokenizer", tokenizerRevision: "41f01f3fe87f28c78e2fbf8b568835947dd65ed9", // gitleaks:allow — public model repository, revision, or checksum
    tokenizerFiles: [
      "tokenizer.json": "17456db595adc78a973f97d69d8cb50bc87c0b1c", // gitleaks:allow — public model repository, revision, or checksum
      "tokenizer_config.json": "06ffdc8308eae6bb7bd1fdd81e94b0a881a539ab", // gitleaks:allow — public model repository, revision, or checksum
      "config.json": "ad2f44ff1ed66e12765b2392dc041469db91a462",
    ])
  let translation = SetupAsset(
    id: "translation", variant: "medium", hubFolder: "openai_whisper-medium",
    destination: "translation", tokenizerRepository: "whisper-medium",
    tokenizerDestination: "translation-tokenizer",
    tokenizerRevision: "abdf7c39ab9d0397620ccaea8974cc764cd0953e", // gitleaks:allow — public model repository, revision, or checksum
    tokenizerFiles: [
      "tokenizer.json": "1e95340ff836fad1b5932e800fb7b8c5e6d78a74", // gitleaks:allow — public model repository, revision, or checksum
      "tokenizer_config.json": "d13b786c04765fb1a06492b53587752cd67665ea", // gitleaks:allow — public model repository, revision, or checksum
      "config.json": "eda91ab1edc34a7c54512ed7a53e643b202387af",
    ])
  return withMedium ? [recognition, translation] : [recognition]
}

/// Failure codes the app turns into recovery instructions. Anything unclassified stays `assetSetup`.
public enum SetupFailureCode: String, Sendable {
  case diskFull, network, assetSetup
}
public func classifySetupError(_ error: Error) -> SetupFailureCode {
  let ns = error as NSError
  switch (ns.domain, ns.code) {
  case (NSPOSIXErrorDomain, Int(ENOSPC)), (NSPOSIXErrorDomain, Int(EDQUOT)),
    (NSCocoaErrorDomain, NSFileWriteOutOfSpaceError):
    return .diskFull
  case (NSURLErrorDomain, _):
    return .network
  case (NSPOSIXErrorDomain, Int(ENETDOWN)), (NSPOSIXErrorDomain, Int(ENETUNREACH)),
    (NSPOSIXErrorDomain, Int(ETIMEDOUT)), (NSPOSIXErrorDomain, Int(ECONNRESET)):
    return .network
  default:
    break
  }
  if let underlying = ns.userInfo[NSUnderlyingErrorKey] as? Error, (underlying as NSError) != ns {
    return classifySetupError(underlying)
  }
  return .assetSetup
}

/// One file of a hub folder listing at a fixed commit.
public struct HubFile: Equatable, Sendable {
  public let path: String
  public let size: Int
  /// SHA-256 of the content, listed for LFS files.
  public let sha256: String?
  /// Git blob id (SHA-1 of "blob <size>\0" + content), listed for every file.
  public let gitOid: String
}
/// Files of a hub folder listing (`/api/models/<repo>/tree/<revision>/<folder>?recursive=true`). LFS files
/// report their real size and SHA-256 under `lfs`; their top-level size and oid describe the pointer file.
public func hubTreeFiles(_ data: Data) throws -> [HubFile] {
  guard let entries = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
    throw SpeechFailure.missingAssets
  }
  return entries.compactMap { entry in
    guard entry["type"] as? String == "file", let path = entry["path"] as? String else { return nil }
    let lfs = entry["lfs"] as? [String: Any]
    return HubFile(
      path: path, size: lfs?["size"] as? Int ?? entry["size"] as? Int ?? 0,
      sha256: lfs?["oid"] as? String, gitOid: lfs == nil ? entry["oid"] as? String ?? "" : "")
  }
}
/// Total payload of a hub folder listing.
public func hubTreeBytes(_ data: Data) throws -> Int {
  let total = try hubTreeFiles(data).reduce(0) { $0 + $1.size }
  guard total > 0 else { throw SpeechFailure.missingAssets }
  return total
}

/// Hex digest of a file, streamed so a multi-GB weight file is never held in memory.
private func streamedDigest<H: HashFunction>(_ hash: inout H, of url: URL) throws {
  let handle = try FileHandle(forReadingFrom: url)
  defer { try? handle.close() }
  while let chunk = try handle.read(upToCount: 4 << 20), !chunk.isEmpty { hash.update(data: chunk) }
}
private func hex<D: Digest>(_ digest: D) -> String { digest.map { String(format: "%02x", $0) }.joined() }
public func sha256Hex(of url: URL) throws -> String {
  var hash = SHA256()
  try streamedDigest(&hash, of: url)
  return hex(hash.finalize())
}
/// The git blob id of a file's content, which the hub lists for files that are not stored in LFS.
public func gitBlobId(of data: Data) -> String {
  var hash = Insecure.SHA1()
  hash.update(data: Data("blob \(data.count)\u{0}".utf8))
  hash.update(data: data)
  return hex(hash.finalize())
}
public func gitBlobId(of url: URL) throws -> String {
  let size = try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int ?? 0
  var hash = Insecure.SHA1()
  hash.update(data: Data("blob \(size)\u{0}".utf8))
  try streamedDigest(&hash, of: url)
  return hex(hash.finalize())
}
/// Whether a downloaded file is exactly the listed one: size first, then SHA-256 for LFS files or the
/// git blob id for the others. A listing entry with neither hash never verifies.
public func fileMatches(_ url: URL, _ expected: HubFile) throws -> Bool {
  let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? nil
  guard size == expected.size else { return false }
  if let sha256 = expected.sha256 { return try sha256Hex(of: url) == sha256.lowercased() }
  guard !expected.gitOid.isEmpty else { return false }
  return try gitBlobId(of: url) == expected.gitOid.lowercased()
}
/// Raised when downloaded model files differ from the pinned listing. The bad files are removed first, so
/// a retry downloads them again.
public struct SetupVerificationFailure: Error, Equatable {
  public let paths: [String]
}
/// Checks every listed file under `snapshot` (the repository root of the download) and removes the ones
/// that are missing or differ. Throws `SetupVerificationFailure` naming them.
public func verifyDownload(snapshot: URL, files: [HubFile]) throws {
  var bad: [String] = []
  for file in files {
    let url = snapshot.appendingPathComponent(file.path)
    if !(try fileMatches(url, file)) {
      bad.append(file.path)
      try? FileManager.default.removeItem(at: url)
    }
  }
  if !bad.isEmpty { throw SetupVerificationFailure(paths: bad) }
}

/// Bytes currently present under the given roots, including `.incomplete` partial files, so a restarted
/// download reports what it already has instead of starting from zero.
public func bytesOnDisk(_ roots: [URL]) -> Int {
  var total = 0
  for root in roots {
    guard
      let walker = FileManager.default.enumerator(
        at: root, includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey])
    else { continue }
    for case let file as URL in walker {
      let values = try? file.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
      if values?.isRegularFile == true { total += values?.fileSize ?? 0 }
    }
  }
  return total
}

public func availableBytes(at url: URL) -> Int? {
  var probe = url
  while !FileManager.default.fileExists(atPath: probe.path), probe.pathComponents.count > 1 {
    probe.deleteLastPathComponent()
  }
  guard
    let values = try? probe.resourceValues(forKeys: [
      .volumeAvailableCapacityKey, .volumeAvailableCapacityForImportantUsageKey,
    ])
  else { return nil }
  let plain = values.volumeAvailableCapacity
  // The "important usage" figure counts space the OS can purge, but it reads 0 on external and disk-image
  // volumes (measured in #30), so it only widens the plain figure and never replaces it with 0.
  let important = values.volumeAvailableCapacityForImportantUsage.map { Int($0) }
  switch (plain, important) {
  case let (plain?, important?) where important > 0: return max(plain, important)
  case let (plain?, _): return plain
  case let (nil, important?) where important > 0: return important
  default: return nil
  }
}

/// Free space kept beyond the download itself, for the CoreML compile on first load and the OS.
public let setupDiskMargin = 1 << 30

public struct SetupDiskCheck: Equatable, Sendable {
  public let neededBytes: Int
  public let availableBytes: Int
}
/// Nil when the download fits. `remaining` is what is still to fetch, so a resumed download is not asked for
/// space it already occupies. Unknown free space never blocks: the write error is classified instead.
public func setupDiskShortfall(remaining: Int, available: Int?) -> SetupDiskCheck? {
  guard let available else { return nil }
  let needed = max(remaining, 0) + setupDiskMargin
  return available >= needed ? nil : SetupDiskCheck(neededBytes: needed, availableBytes: available)
}

public func setupProgressEvent(
  stage: String, asset: String, completedBytes: Int, totalBytes: Int, resumedBytes: Int,
  attempt: Int = 1
) -> [String: Any] {
  [
    "kind": "setupProgress", "stage": stage, "asset": asset,
    "completedBytes": min(completedBytes, totalBytes), "totalBytes": totalBytes,
    "resumedBytes": min(resumedBytes, totalBytes), "attempt": attempt,
  ]
}
