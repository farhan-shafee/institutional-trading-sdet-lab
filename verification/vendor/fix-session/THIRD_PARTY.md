# Runtime attribution and source identities

This covers software added by the local FIX runtime, not every operating-system
package or build-plugin dependency. Historical application dependencies and
financial sources are unchanged.

The build reads the compiled Go peer's module metadata, checks every linked
module path/version/sum against the selected module, and copies its original
LICENSE/COPYING and available NOTICE, AUTHORS, CONTRIBUTORS and PATENTS files.
The Go toolchain LICENSE is included separately. Missing linked-module licenses
or unreviewed module replacements fail build. Runtime
`/opt/runtime/licenses/go-dependencies.json` records actual versions, sums, byte
lengths and SHA-256 hashes. Acceptance rereads those exact bytes.

All seven Java JARs retain embedded upstream licenses/notices. Their complete
original bytes and lengths are checked against `dependencies.lock.json` during
acceptance. The complete Temurin tree, including legal material, is copied from
the pinned JRE image. The copied GNU C++ runtime also carries Debian's copyright
file under `/usr/share/doc/libstdc++6/copyright`.

Source identities observed November 7, 2026:

| Upstream source                   | SHA-256                                                            |
| --------------------------------- | ------------------------------------------------------------------ |
| QuickFIX/Go v0.9.12 module ZIP    | `54e5ea727ddd5217d3cc342f808fdb2f09f5dd56316a3ab6d75c37bb65e4c90a` |
| Its original LICENSE              | `cc71f1162f710e93f9d9bd4c0a65396ac09e108706706c7899b1304045d99523` |
| QuickFIX/J core 3.0.2 sources JAR | `4ad70989c631f4e05db5b05e5d9f50d84ce2fb90c2c10624161aa578453a37cf` |

The Java archive is the official Maven Central artifact
`org/quickfixj/quickfixj-core/3.0.2/quickfixj-core-3.0.2-sources.jar`; Go uses its
checksum-verified module distribution. Production engine source is unchanged.
Calendar controls use a checked test-only Go copy and public or test-reflected
Java schedule behavior, without patching the runtime engines.

The earlier selected advisory query covered 39 package/toolchain identities and
found zero known matches at that observation. The guard, calendar, attribution
and Python gate add no dependencies. This is not a full base-image OS scan,
continuous monitoring or assurance about unknown issues.
