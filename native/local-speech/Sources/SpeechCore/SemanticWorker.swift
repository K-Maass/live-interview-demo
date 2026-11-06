import Foundation
import NaturalLanguage

/// Installed on-device English/German sentence embeddings. No model download or remote inference.
private enum SemanticFailure: Error { case invalidRequest }
public enum SemanticWorker {
  public static func handle(_ json: [String: Any]) throws -> [String: Any] {
    guard let entries = json["entries"] as? [[String: Any]], entries.count <= 128 else {
      throw SemanticFailure.invalidRequest
    }
    var results = [[String: Any]]()
    for entry in entries {
      guard let text = entry["text"] as? String, text.count <= 6400 else {
        throw SemanticFailure.invalidRequest
      }
      let detected = NLLanguageRecognizer.dominantLanguage(for: text)
      let language: NLLanguage =
        entry["language"] as? String == "de" || detected == .german ? .german : .english
      guard let embedding = NLEmbedding.sentenceEmbedding(for: language),
        let vector = embedding.vector(for: text)
      else {
        continue
      }
      let norm = sqrt(vector.reduce(0) { $0 + $1 * $1 })
      guard norm > 0, norm.isFinite else { continue }
      var result = entry
      result.removeValue(forKey: "text")
      result["language"] = language.rawValue
      result["vector"] = vector.map { $0 / norm }
      results.append(result)
    }
    return ["kind": "embeddings", "entries": results]
  }
}
