# Third-party notices

Iqri uses open-source software, attributed model weights, and published Quran text and translations. Each component retains its own terms. An application-code licence does not replace a text, model, or dependency licence.

## Recognition software and model

| Component | Version / source | Terms and credit |
|---|---|---|
| Abdou Quran ASR Small | [model and source](https://huggingface.co/Abdou/quran-asr-small), revision `004f898639f3127a74eac1b898a2cb3ef0b5268d` | MIT; Copyright (c) 2026 Abdou. Primary 33M Conformer CTC model. Complete notice in `licenses/Abdou-Quran-ASR-MIT.txt`, distributed at `/licenses/Abdou-Quran-ASR-MIT.txt`. |
| Tilawi Quran ASR | `@tilawi/quran-asr` 0.1.0 — [repository](https://github.com/Tilawi/quran-asr) | MIT; Copyright (c) 2025–2026 Muhammed Durakovic. Full installed-package notice in `licenses/Tilawi-Quran-ASR-MIT.txt` and `/licenses/Tilawi-Quran-ASR-MIT.txt`. |
| Tilawa filterbank extraction | [MIT source](https://github.com/yazinsai/tilawa/tree/2f2617460dc4a6b967e0cc49fa04804bbf22ec69/packages/core/src/recitation), adapted `fbank.ts` and its signal-processing constants in `config.ts` | MIT; Copyright (c) 2026 yazinsai. Complete notice in `licenses/Tilawa-Fbank-MIT.txt`, distributed at `/licenses/Tilawa-Fbank-MIT.txt`. Only this signal-processing code is included; the NPL model and corpus are not included. |
| ONNX Runtime | `onnxruntime-node` and `onnxruntime-web` 1.31.1 — [release source](https://github.com/microsoft/onnxruntime/tree/6af1a932e2286d5c58166085d24c68783033edee) | MIT; Microsoft Corporation. Full version-pinned [licence](https://github.com/microsoft/onnxruntime/blob/6af1a932e2286d5c58166085d24c68783033edee/LICENSE) and [third-party notices](https://github.com/microsoft/onnxruntime/blob/6af1a932e2286d5c58166085d24c68783033edee/ThirdPartyNotices.txt) are retained as `licenses/ONNX-Runtime-LICENSE.txt` and `licenses/ONNX-Runtime-ThirdPartyNotices.txt`, and distributed at the corresponding `/licenses/` URLs alongside the WebAssembly runtime. |
| esbuild | 0.28.2 — [repository](https://github.com/evanw/esbuild) | MIT; Copyright (c) 2020 Evan Wallace. Development build tool. |

Model weights are used without retraining. Iqri adds local/browser adapters and conservative handling of repeated references. Model hashes, sizes, immutable source revision, and source URL are recorded in `src/recognition/config.js`; the downloader writes a verified provenance record in `models/`. Weights are downloaded during setup or by the browser and are not bundled in the source archive.

The current recognizer and reader use the separately sourced Arabic corpus in `dist/data/`, joined by surah and ayah. The earlier development model was [Tilawi FastConformer Quran](https://huggingface.co/muhdur/tilawi-fastconformer-quran), revision `e9448a0e84f3adb64c28b7a8db501dd8e0e59a84`, CC BY 4.0, by Muhammed Durakovic / Tilawi, based on NVIDIA's [CC BY 4.0 model](https://huggingface.co/nvidia/stt_ar_fastconformer_hybrid_large_pcd_v1.0). Its saved benchmark records are historical. If those old development assets are retained locally, keep their original model and Tanzil notices, including the recorded spelling/spacing differences. They are not the current deployment's model.

The primary model's MIT licence permits commercial use with notice retention. This is not a blanket clearance for every content source or deployment arrangement. In particular, the Quran text, translation editions, and live word-meaning service below retain their separate attribution, preservation, redistribution, and API conditions. No NPL-licensed model or phoneme corpus is deployed.

## Quran text and translation data

Arabic reading text is credited to the **Tanzil Project** and distributed through **Risan Bagja Pradana’s quran-json** dataset. Tanzil specifies CC BY 3.0 with verbatim-only copying, source credit, a link to Tanzil, and retention of its notice. The dataset packaging specifies CC BY-SA 4.0. See [Tanzil terms](https://tanzil.net/docs/Text_License) and [quran-json](https://github.com/risan/quran-json). Search normalization is kept separate from displayed source wording.

| Edition | Credit / version in this snapshot | Source |
|---|---|---|
| English — ClearQuran, Allah edition | Translation by Talal Itani, ClearQuran.com | [Publisher terms](https://clearquran.com/download/) |
| English — Rowwad | Rowwad Translation Center, 1.0.20 | [QuranEnc](https://quranenc.com/en/browse/english_rwwad/) |
| English — Noor International | Noor International Center, 1.1.2 | [QuranEnc](https://quranenc.com/en/browse/english_saheeh/) |
| English — Hilali & Khan | Taqi-ud-Din al-Hilali and Muhammad Muhsin Khan, 1.1.2 | [QuranEnc](https://quranenc.com/en/browse/english_hilali_khan/) |
| English — Pickthall | Marmaduke Pickthall, original 1930 translation | [Structured source](https://github.com/risan/quran-json) |
| Spanish | Muhammad Isa García, 1.0.2 | [QuranEnc](https://quranenc.com/en/browse/spanish_garcia/) |
| Chinese | Muhammad Makeen; reviewed by Muhammad Sulaiman and other language experts, 1.0.8 | [QuranEnc](https://quranenc.com/en/browse/chinese_suliman/) |

QuranEnc allows republication under [its conditions](https://quranenc.com/en/home/about): retain wording and transcript information; credit publisher and source; state the version; report issues; incorporate publisher corrections; and avoid inappropriate accompanying advertising. The complete publisher transcript is retained in each edition’s `_meta` record. Footnotes are preserved.

ClearQuran is CC BY-ND 4.0 with additional publisher permission for format conversion and rearrangement that preserves the translation’s words and credit. Pickthall’s original 1930 translation is public domain; the structured dataset remains attributed separately. No Tigrinya text is bundled.

The machine-readable records `dist/data/catalog.json` and `dist/data/provenance.json` contain source URLs, edition-specific terms, retrieval dates, and hashes. `dist/data/LICENSES.txt` and the Arabic corpus’s embedded notice accompany the data. These records must travel with redistributed data files.

## Live English word meanings

English word meanings are provided at runtime by **Quran.com / Quran Foundation**, using the [verse-by-key API](https://api.quran.com/api/v4/verses/by_key/112:1?language=en&words=true&word_fields=text_uthmani,text_imlaei). Source content retains its respective rights. These are provider word glosses, not word-level versions of the bundled translation editions. The API response does not identify an individual compiler, so Iqri does not infer an edition attribution from third-party mirrors.

The [Quran Foundation Developer Terms](https://api-docs.quran.com/legal/developer-terms/), updated October 11, 2026, allow end-user display under their conditions. They distinguish that permission from redistribution of raw content, including prepackaged content bundles, and impose caching and synchronization conditions. Iqri requests individual ayahs for display and keeps at most 50 responses in memory for up to six hours. It does not distribute a word-meaning dataset or create an offline copy. Provider responses are not covered by this app’s code licence or by quran-json’s licence.

Keep the provider attribution visible wherever these word meanings are shown. The runtime source metadata is exported by `src/word-meanings.js` as `WORD_MEANINGS_SOURCE`. Read the current provider terms before introducing disk storage, bulk retrieval, data exports, or a different deployment arrangement.

## MIT permission notice

The following applies to the MIT components credited above; retain their original copyright notices and any additional upstream notices:

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

Development audio fixtures, if present in a development checkout, are identified in `tests/fixtures/SOURCES.txt`. They are local evaluation material and are not part of the deployed application’s content.


## WhimprFlow microphone feedback

Iqri adapts the chronological six-value RMS level display (gain 14, clamped to 0–1) and the distinction between almost-silent capture and recognition failure from [WhimprFlow](https://github.com/Blueturboguy07/WhimprFlow), inspected at commit `bb222a23563d076f50d8d068d3d0e1b8267c1a7a`. Source locations: `crates/whimpr-audio/src/lib.rs`, `src-tauri/src/win.rs`, and `crates/whimpr-core/src/diagnostics.rs`. The adaptation lives in `src/audio-feedback.js`.

Copyright (c) 2026 WhimprFlow contributors. MIT. The complete upstream license is retained in `licenses/WhimprFlow-LICENSE.txt` and distributed at `/licenses/WhimprFlow-LICENSE.txt`. These are microphone UI and diagnostic adaptations. Iqri does not embed WhimprFlow's desktop binary, English Whisper model, or LLM transcript cleanup.
