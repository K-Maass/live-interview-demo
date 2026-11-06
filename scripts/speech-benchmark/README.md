# Local speech benchmark

This preview uses 20 pinned English and German clips from [Google FLEURS](https://huggingface.co/datasets/google/fleurs), CC BY 4.0. The harness fetches them on demand and verifies their hashes. The reports measure read-speech recognition, translation meaning checks, latency and memory on the machine that runs it.

Run `npm run speech:test` to verify the manifest and scorer without downloading models. To run inference, first build the native helper with `npm run build:mac`. Prepare the required models in a separate directory, then run `npm run speech:benchmark -- --models /path/to/preview-models`. The Apple translation route requires macOS 26 and an installed German-to-English language pair. Use the experimental medium route explicitly with `--route medium`. The benchmark uses its own model path by default. A benchmark result does not establish performance in a live Teams call.
