#!/usr/bin/env bash
# Add the Flutter + Android toolchain to a worker AMI. Runs AS ROOT ON THE BUILDER
# INSTANCE, then you snapshot it with CreateImage — same contract as
# provision-worker-ami.sh, which this composes with rather than replaces.
#
# Two ways to use it, both supported:
#   1. Boot a builder FROM an existing aidlc worker AMI and run only this script.
#      Fastest, and what the Flutter AMI in this account was built with: the runner,
#      Node, the agent CLIs and the CloudWatch agent are already in that image and
#      do not need to be rebuilt to add a toolchain.
#   2. Run provision-worker-ami.sh first, then this, on a bare Fedora builder.
#
# WHY THIS IS A SEPARATE SCRIPT AND NOT A SECTION OF THE BASE ONE. Flutter plus the
# Android SDK plus a JDK is ~9 GiB installed — more than everything the base image
# contains. Folding it in would put an Android toolchain on every C++ and Node
# worker in the fleet, lengthen every AMI rebuild, and make the base image's size
# depend on a toolchain most stages never touch. A variant image is the cheaper
# shape, and /etc/aidlc-runner.d (see the launcher in provision-worker-ami.sh) is
# the seam that makes one possible without the base script knowing this exists.
#
# WHY EC2 AND NOT AN AGENTCORE ENVIRONMENT. Not a preference — the AgentCore path
# cannot host this toolchain at all:
#   * AgentCore tool artifacts are linux/ARM64. Google publishes the Android
#     build-tools and platform-tools binaries (aapt2, d8, adb) for linux-x86_64
#     ONLY, and Flutter's Linux SDK archive is x64 only. There is no aarch64 Linux
#     Android toolchain to import.
#   * The managed image ceiling is 2048 MiB and the protected base already occupies
#     ~1173 MiB of it. The Flutter SDK alone exceeds the whole budget.
# So this is an EC2 environment: x86_64, a real root volume, and a stage timeout
# long enough for a cold Gradle build. It is bindable per stage only — an EC2
# environment cannot be a space default (see lib/environmentKind.ts).
#
# Usage: provision-worker-flutter.sh
set -euxo pipefail

# cloud-init runs user-data with no HOME and the Flutter, Dart and Gradle caches
# all dereference it. It must also be the SAME home the runner uses, because the
# point of warming those caches during the bake is that a stage finds them:
# aidlc-runner.service sets Environment=HOME=/root.
export HOME=/root

FLUTTER_ROOT=/opt/flutter
ANDROID_SDK_ROOT=/opt/android-sdk
DROPIN=/etc/aidlc-runner.d/flutter.sh
LAUNCHER=/opt/aidlc-runner/bin/aidlc-runner

# ── Pins ────────────────────────────────────────────────────────────────────
# Every version here is exact and every download is checksum-verified against a
# publisher-published digest, for the reason the vcpkg pin in the base script
# spells out: two AMIs built a day apart must not carry different toolchains.
#
# Flutter's own release manifest carries the sha256 for each archive, so the check
# is against the publisher rather than a digest pasted in here — but the VERSION is
# still pinned, and a version that is not in the manifest is a build failure.
FLUTTER_VERSION=${FLUTTER_VERSION:-3.47.4}
FLUTTER_SHA256=${FLUTTER_SHA256:-5b45f0ceda99b9bebdc873e7e69f6450aeb4c30f454b505e2e62fc9255a907d3}
FLUTTER_MANIFEST=https://storage.googleapis.com/flutter_infra_release/releases/releases_linux.json

# cmdline-tools 23.0. The build number IS the version as far as the URL is
# concerned; the sha1 is the one Google publishes in repository2-3.xml (sha1, not
# sha256 — that is what the manifest carries, so that is what we can verify).
ANDROID_CMDLINE_BUILD=${ANDROID_CMDLINE_BUILD:-16111833}
ANDROID_CMDLINE_SHA1=${ANDROID_CMDLINE_SHA1:-e025545c62a8e64c7559119566a569fb1dec5f60}

# sdkmanager verifies its own downloads against the same repository manifest, so
# these are pins for reproducibility rather than a second integrity check.
ANDROID_PLATFORM=${ANDROID_PLATFORM:-android-36}
ANDROID_BUILD_TOOLS=${ANDROID_BUILD_TOOLS:-36.0.0}
# The NDK is ~2.5 GiB. It used to be off by default, but Rust FFI
# (flutter_rust_bridge) cross-compiles the Rust crate to Android with the NDK's
# clang/linker, so a one-stop Flutter image MUST carry it — an FFI plugin that
# cannot find the NDK fails at `cargo ndk` with no cross-compiler. Pinned to the
# side-by-side version sdkmanager currently offers; bump from `android sdk list`.
ANDROID_NDK_VERSION=${ANDROID_NDK_VERSION:-28.2.13676358}

# ── Rust FFI toolchain (flutter_rust_bridge) ──────────────────────────────────
# rustup + a PINNED stable, installed to a SYSTEM location (/opt/rust) rather than
# ~/.cargo, so the runner and every process it spawns share one toolchain regardless
# of $HOME — same reasoning as the vcpkg/flutter placement. The installer itself is
# pinned by sha256 (rustup verifies the toolchain it then downloads against its own
# signed manifest, so the channel pin is what fixes the compiler version).
#
# Bump the toolchain from https://static.rust-lang.org/dist/channel-rust-stable.toml
# and the installer sha from
# https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init.sha256
RUST_VERSION=${RUST_VERSION:-1.98.1}
RUSTUP_INIT_SHA256=${RUSTUP_INIT_SHA256:-dda7234360b7f578ca8b0ddcb80145646fa61a67c1720a5abc7051b35c9fcb71}
RUST_ROOT=/opt/rust
RUSTUP_HOME=${RUST_ROOT}/rustup
CARGO_HOME=${RUST_ROOT}/cargo
# The four Android target triples flutter_rust_bridge builds for — 64/32-bit ARM
# for devices, 64/32-bit x86 for emulators. cargo-ndk maps ABI names to these.
RUST_ANDROID_TARGETS="aarch64-linux-android armv7-linux-androideabi x86_64-linux-android i686-linux-android"
# cargo-ndk drives the per-ABI cross-build against the NDK; frb_codegen generates
# the Dart<->Rust bindings. Both pinned (cargo install --version), from crates.io.
CARGO_NDK_VERSION=${CARGO_NDK_VERSION:-4.1.2}
FRB_CODEGEN_VERSION=${FRB_CODEGEN_VERSION:-2.13.0}
RUST_DROPIN=/etc/aidlc-runner.d/rust.sh
ANDROID_NDK_HOME=${ANDROID_SDK_ROOT}/ndk/${ANDROID_NDK_VERSION}

# JDK 21 from Adoptium, NOT from dnf. Fedora 45 ships only java-25-openjdk and an
# early-access 27; Gradle and AGP support neither — Gradle refuses to run on a JDK
# newer than the release it was built against, so the template app's build dies at
# `Unsupported class file major version` before any Flutter code is reached. The
# distro's JDK track and Android's supported JDK track are simply different things,
# and 21 is the LTS both Gradle 8.x/9.x and AGP 8.x accept.
#
# Pinned to an exact build with the publisher's own sha256, same rule as everything
# else here. Bump both together, from
# https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&image_type=jdk&os=linux
JDK_VERSION=${JDK_VERSION:-21.0.12.1_1}
JDK_RELEASE=${JDK_RELEASE:-jdk-21.0.12.1+1}
JDK_SHA256=${JDK_SHA256:-ce79869e1307ed8ee1e2baa86a412b1eb5b75d10a01006d788a6f968bcfaee94}
JDK_ROOT=/opt/java/temurin-21

# Whether to prove the toolchain by building an APK. On by default: a bake that
# cannot build the template app has produced a broken image, and finding that out
# here costs ten minutes while finding it out from a stage costs an intent.
FLUTTER_VERIFY_BUILD=${FLUTTER_VERIFY_BUILD:-1}

# ── System packages ─────────────────────────────────────────────────────────
# unzip for cmdline-tools, which ships a zip; the rest are what the Android build
# tools and Flutter's own tooling dereference. `which` is not decoration —
# flutter_tools shells out to it when it locates the JDK.
dnf -y install --setopt=install_weak_deps=False \
  unzip zip which git curl xz procps-ng \
  zlib-ng-compat ncurses-libs \
  gcc file
# gcc: the Rust build needs a C linker/compiler for build scripts and the host
# target; file: the FFI verification checks the produced .so is an aarch64 ELF.

# ── JDK ─────────────────────────────────────────────────────────────────────
JDK_TARBALL="OpenJDK21U-jdk_x64_linux_hotspot_${JDK_VERSION}.tar.gz"
JDK_URL="https://github.com/adoptium/temurin21-binaries/releases/download/${JDK_RELEASE//+/%2B}/${JDK_TARBALL}"
curl -fsSLo "/tmp/${JDK_TARBALL}" "${JDK_URL}"
echo "${JDK_SHA256}  /tmp/${JDK_TARBALL}" | sha256sum -c -
rm -rf "${JDK_ROOT}"
install -d "${JDK_ROOT}"
tar -xzf "/tmp/${JDK_TARBALL}" -C "${JDK_ROOT}" --strip-components=1
rm -f "/tmp/${JDK_TARBALL}"

# JAVA_HOME is the tarball's own root, deliberately NOT registered with
# alternatives: /usr/bin/java stays whatever the distro put there, so nothing else
# in the image changes Java version because an Android toolchain was added.
JAVA_HOME=${JDK_ROOT}
test -x "${JAVA_HOME}/bin/javac"
"${JAVA_HOME}/bin/java" -version

# ── Android SDK ─────────────────────────────────────────────────────────────
# cmdline-tools must live at ${ANDROID_SDK_ROOT}/cmdline-tools/latest — sdkmanager
# derives the SDK root by walking UP two directories from its own location, so the
# zip's own `cmdline-tools/bin` layout one level shallower makes it install packages
# into the wrong tree and then not find them.
install -d "${ANDROID_SDK_ROOT}"
CMDLINE_ZIP="commandlinetools-linux-${ANDROID_CMDLINE_BUILD}_latest.zip"
curl -fsSLo "/tmp/${CMDLINE_ZIP}" \
  "https://dl.google.com/android/repository/${CMDLINE_ZIP}"
echo "${ANDROID_CMDLINE_SHA1}  /tmp/${CMDLINE_ZIP}" | sha1sum -c -
rm -rf "${ANDROID_SDK_ROOT}/cmdline-tools"
install -d "${ANDROID_SDK_ROOT}/cmdline-tools/unpack"
unzip -q "/tmp/${CMDLINE_ZIP}" -d "${ANDROID_SDK_ROOT}/cmdline-tools/unpack"
mv "${ANDROID_SDK_ROOT}/cmdline-tools/unpack/cmdline-tools" \
   "${ANDROID_SDK_ROOT}/cmdline-tools/latest"
rmdir "${ANDROID_SDK_ROOT}/cmdline-tools/unpack"
rm -f "/tmp/${CMDLINE_ZIP}"

SDKMANAGER="${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin/sdkmanager"
export JAVA_HOME ANDROID_SDK_ROOT
export ANDROID_HOME="${ANDROID_SDK_ROOT}"
export PATH="${JAVA_HOME}/bin:${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin:${ANDROID_SDK_ROOT}/platform-tools:${PATH}"

ANDROID_PACKAGES=(
  "platform-tools"
  "platforms;${ANDROID_PLATFORM}"
  "build-tools;${ANDROID_BUILD_TOOLS}"
)
[ -n "${ANDROID_NDK_VERSION}" ] && ANDROID_PACKAGES+=("ndk;${ANDROID_NDK_VERSION}")

# NO SEPARATE LICENCE STEP, and this is a change from every Android CI recipe you
# will find. cmdline-tools 23 deprecates sdkmanager and delegates it to the new
# `android` CLI, which answers `--licenses` with "The --licenses option is no longer
# needed" and writes nothing. The old `yes | sdkmanager --licenses` therefore
# LOOKED like it worked, created no ${ANDROID_SDK_ROOT}/licenses directory, and the
# bake failed on the assertion after it. Installing a package is what writes
# licenses/android-sdk-license now, so the licence evidence is asserted AFTER the
# install rather than produced before it.
#
# sdkmanager and not `android sdk install`: the semicolon coordinates below are what
# AGP and `flutter doctor` speak, and the wrapper translates them. When the wrapper
# is finally removed, this becomes `android sdk install platform-tools
# build-tools@${ANDROID_BUILD_TOOLS} platform@${ANDROID_PLATFORM#android-}`.
"${SDKMANAGER}" --install "${ANDROID_PACKAGES[@]}"

# Licence acceptance, as recorded by the install itself.
test -d "${ANDROID_SDK_ROOT}/licenses"
test -s "${ANDROID_SDK_ROOT}/licenses/android-sdk-license"
test -x "${ANDROID_SDK_ROOT}/platform-tools/adb"
test -x "${ANDROID_SDK_ROOT}/build-tools/${ANDROID_BUILD_TOOLS}/aapt2"
# aapt2 is a native x86_64 binary that links against the system's C++ runtime and
# zlib. Run it now: a missing shared library here is a clear failure, whereas from
# a Gradle stage it surfaces as an opaque resource-linking error.
"${ANDROID_SDK_ROOT}/build-tools/${ANDROID_BUILD_TOOLS}/aapt2" version

# ── Flutter SDK ─────────────────────────────────────────────────────────────
# Resolve the pinned version in the publisher's manifest and check the digest we
# were given against the one Google publishes for that exact archive. A mismatch
# means the pin and the digest disagree, which is a build failure, not a warning.
curl -fsSLo /tmp/flutter-releases.json "${FLUTTER_MANIFEST}"
FLUTTER_ARCHIVE=$(python3 - "${FLUTTER_VERSION}" "${FLUTTER_SHA256}" <<'PY'
import json, sys
version, expected = sys.argv[1], sys.argv[2]
data = json.load(open('/tmp/flutter-releases.json'))
for release in data['releases']:
    if release['version'] == version and release['channel'] == 'stable':
        published = release.get('sha256')
        if published != expected:
            sys.exit(
                f"FATAL: flutter {version} sha256 in the manifest is {published},\n"
                f"       not the pinned {expected}. Refusing to install it."
            )
        print(data['base_url'] + '/' + release['archive'])
        break
else:
    sys.exit(
        f"FATAL: flutter {version} is not a stable release in the manifest.\n"
        f"       Pick a real version from {data['base_url']} or override\n"
        f"       FLUTTER_VERSION. Refusing to bake an unpinned SDK."
    )
PY
)
curl -fsSLo /tmp/flutter.tar.xz "${FLUTTER_ARCHIVE}"
echo "${FLUTTER_SHA256}  /tmp/flutter.tar.xz" | sha256sum -c -
rm -rf "${FLUTTER_ROOT}"
install -d "${FLUTTER_ROOT}"
tar -xJf /tmp/flutter.tar.xz -C "${FLUTTER_ROOT}" --strip-components=1
rm -f /tmp/flutter.tar.xz /tmp/flutter-releases.json
export PATH="${FLUTTER_ROOT}/bin:${PATH}"

# git safe.directory for the SDK tree. flutter_tools runs `git` inside its own
# checkout on nearly every invocation to learn its version, and git refuses a repo
# it does not consider owned by the caller. It is root-owned and the runner is root,
# so this is belt-and-braces for an operator poking at it over SSM as another user —
# but a `flutter` that cannot read its own version fails closed, so it is cheap.
git config --global --add safe.directory "${FLUTTER_ROOT}"

# Analytics off before anything else runs, so no bake and no stage ever phones home.
flutter --version
flutter config --no-analytics
dart --disable-analytics || true

# Point Flutter at the SDK and JDK explicitly. This is persisted config under
# ${HOME}, NOT environment, and it is the belt to the drop-in's braces: a stage that
# runs `flutter build` with a clean environment still finds both.
flutter config --android-sdk "${ANDROID_SDK_ROOT}"
flutter config --jdk-dir "${JAVA_HOME}"

# Android artefacts (gradle plugin bits, the engine's Android binaries) pulled now
# rather than during a stage's first build.
flutter precache --android --no-ios --universal
yes | flutter doctor --android-licenses > /tmp/flutter-licenses.log 2>&1 || true

# ── Rust FFI toolchain ────────────────────────────────────────────────────────
# The NDK must be on disk before Rust can target Android — the base Android section
# above installs ndk;${ANDROID_NDK_VERSION} because ANDROID_NDK_VERSION now defaults
# to a real version. Assert it landed rather than discover a missing cross-compiler
# at the first FFI build.
test -d "${ANDROID_NDK_HOME}" || { echo "FATAL: NDK not installed at ${ANDROID_NDK_HOME}" >&2; exit 1; }

# rustup into /opt/rust, non-interactive, exact stable, no host target cruft beyond
# what we add explicitly. RUSTUP_HOME/CARGO_HOME are exported for THIS script so the
# `rustup`/`cargo` below resolve; the drop-in exports them for the runner.
export RUSTUP_HOME CARGO_HOME
install -d "${RUST_ROOT}"
curl -fsSLo /tmp/rustup-init "https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init"
echo "${RUSTUP_INIT_SHA256}  /tmp/rustup-init" | sha256sum -c -
chmod +x /tmp/rustup-init
/tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain "${RUST_VERSION}"
rm -f /tmp/rustup-init
export PATH="${CARGO_HOME}/bin:${PATH}"
rustc --version | grep -qF "${RUST_VERSION}"

# The Android target std libs. Without these `cargo ndk` fails with "can't find
# crate for `std`" for the ABI — the cross-compiler exists (NDK) but the prebuilt
# std does not until rustup adds the target.
# shellcheck disable=SC2086
rustup target add ${RUST_ANDROID_TARGETS}

# cargo-ndk (per-ABI build driver) and frb_codegen (binding generator), both pinned.
# --locked so the pinned crate's own Cargo.lock decides its deps, not whatever is
# newest at bake time — the same reproducibility rule as every other pin here.
cargo install cargo-ndk --version "${CARGO_NDK_VERSION}" --locked
cargo install flutter_rust_bridge_codegen --version "${FRB_CODEGEN_VERSION}" --locked
cargo ndk --version | grep -qF "${CARGO_NDK_VERSION}"

# ── Runner environment ──────────────────────────────────────────────────────
# The drop-in the launcher sources. PATH alone is not enough: gradle reads
# JAVA_HOME, the Android plugin reads ANDROID_SDK_ROOT, and pub reads PUB_CACHE —
# and a stage that runs `./gradlew` directly, which agents do, gets none of it from
# a symlink.
install -d /etc/aidlc-runner.d
cat > "${DROPIN}" <<DROPIN_EOF
# Managed by scripts/provision-worker-flutter.sh. Sourced by the runner launcher.
export JAVA_HOME=${JAVA_HOME}
export ANDROID_SDK_ROOT=${ANDROID_SDK_ROOT}
export ANDROID_HOME=${ANDROID_SDK_ROOT}
export FLUTTER_ROOT=${FLUTTER_ROOT}
export PUB_CACHE=\${PUB_CACHE:-/root/.pub-cache}
export GRADLE_USER_HOME=\${GRADLE_USER_HOME:-/root/.gradle}
export PATH="${FLUTTER_ROOT}/bin:${JAVA_HOME}/bin:${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin:${ANDROID_SDK_ROOT}/platform-tools:\${PATH}"
DROPIN_EOF
chmod 0644 "${DROPIN}"

# The Rust drop-in, separate from flutter.sh so each toolchain's env is legible on
# its own. cargo-ndk reads ANDROID_NDK_HOME to find the cross-compiler; cargo/rustc
# resolve from CARGO_HOME/bin. Same drop-in contract: sourced by the launcher, so
# the runner and every `cargo`/`flutter build` it spawns inherit these.
cat > "${RUST_DROPIN}" <<RUST_EOF
# Managed by scripts/provision-worker-flutter.sh. Sourced by the runner launcher.
export RUSTUP_HOME=${RUSTUP_HOME}
export CARGO_HOME=${CARGO_HOME}
export ANDROID_NDK_HOME=${ANDROID_NDK_HOME}
export ANDROID_NDK_ROOT=${ANDROID_NDK_HOME}
export PATH="${CARGO_HOME}/bin:\${PATH}"
RUST_EOF
chmod 0644 "${RUST_DROPIN}"

# An AMI built path 1 already carries a launcher generated BEFORE the drop-in hook
# existed, so teach that copy to source the directory. Guarded on the marker, so
# re-running this script does not stack a second copy, and a launcher that already
# has the hook (path 2, or a rebuilt base image) is left alone.
if [ -f "${LAUNCHER}" ] && ! grep -q '/etc/aidlc-runner.d' "${LAUNCHER}"; then
  python3 - "${LAUNCHER}" <<'PY'
import sys
path = sys.argv[1]
src = open(path).read()
anchor = 'export VCPKG_ROOT=/opt/vcpkg\n'
if anchor not in src:
    sys.exit(f"FATAL: {path} has no VCPKG_ROOT line to anchor the drop-in hook to.")
hook = anchor + '''
# Added by provision-worker-flutter.sh: toolchain drop-ins. `|| continue`, not
# `&& source`, because an unmatched glob under `set -e` would kill the launcher.
if [ -d /etc/aidlc-runner.d ]; then
  for dropin in /etc/aidlc-runner.d/*.sh; do
    [ -r "$dropin" ] || continue
    . "$dropin"
  done
fi
'''
open(path, 'w').write(src.replace(anchor, hook, 1))
PY
  bash -n "${LAUNCHER}"
fi
grep -q '/etc/aidlc-runner.d' "${LAUNCHER}"

# Interactive SSM shells, for an operator debugging a stuck build host by hand.
cat > /etc/profile.d/aidlc-flutter.sh <<PROFILE
export JAVA_HOME=${JAVA_HOME}
export ANDROID_SDK_ROOT=${ANDROID_SDK_ROOT}
export ANDROID_HOME=${ANDROID_SDK_ROOT}
export FLUTTER_ROOT=${FLUTTER_ROOT}
export PATH="${FLUTTER_ROOT}/bin:${JAVA_HOME}/bin:${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin:${ANDROID_SDK_ROOT}/platform-tools:\${PATH}"
PROFILE
chmod 0644 /etc/profile.d/aidlc-flutter.sh

# /usr/local/bin is already on the launcher's PATH, so these resolve even for a
# process that reached neither the drop-in nor profile.d.
ln -sf "${FLUTTER_ROOT}/bin/flutter" /usr/local/bin/flutter
ln -sf "${FLUTTER_ROOT}/bin/dart" /usr/local/bin/dart
ln -sf "${ANDROID_SDK_ROOT}/platform-tools/adb" /usr/local/bin/adb
ln -sf "${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin/sdkmanager" /usr/local/bin/sdkmanager
ln -sf "${CARGO_HOME}/bin/cargo" /usr/local/bin/cargo
ln -sf "${CARGO_HOME}/bin/rustc" /usr/local/bin/rustc
ln -sf "${CARGO_HOME}/bin/rustup" /usr/local/bin/rustup
ln -sf "${CARGO_HOME}/bin/cargo-ndk" /usr/local/bin/cargo-ndk
ln -sf "${CARGO_HOME}/bin/flutter_rust_bridge_codegen" /usr/local/bin/flutter_rust_bridge_codegen

# ── Verification ────────────────────────────────────────────────────────────
# flutter doctor is advisory — it reports no connected device and no Chrome on a
# headless build host, which is correct and not a failure — so the Android section
# is what gets asserted, not the exit code.
flutter doctor -v > /tmp/flutter-doctor.log 2>&1 || true
grep -qE '\[.\] Android toolchain' /tmp/flutter-doctor.log
if grep -qE 'Android (licence|license) status unknown|cmdline-tools component is missing' /tmp/flutter-doctor.log; then
  echo "FATAL: flutter doctor still reports the Android toolchain as incomplete:" >&2
  sed -n '/Android toolchain/,/^$/p' /tmp/flutter-doctor.log >&2
  exit 1
fi

# The real check: build the template app's debug APK. This resolves pub packages,
# downloads the Gradle distribution the Flutter template asks for, runs AGP, aapt2,
# d8 and the engine's own build hooks — every part a stage will use. The caches it
# fills (/root/.gradle, /root/.pub-cache) are kept ON PURPOSE: a cold Gradle build
# on a fresh instance is several minutes of a stage's clock, and under
# per-stage-ephemeral every instance is fresh.
if [ "${FLUTTER_VERIFY_BUILD}" = "1" ]; then
  # UNDERSCORES, not hyphens: the directory name becomes the pubspec package name
  # and `flutter create` rejects anything that is not a valid Dart identifier, so a
  # hyphenated path fails the bake before a single line is compiled.
  PROBE=/tmp/aidlc_flutter_probe
  rm -rf "${PROBE}"
  flutter create --platforms=android "${PROBE}"
  (cd "${PROBE}" && flutter build apk --debug)
  test -f "${PROBE}/build/app/outputs/flutter-apk/app-debug.apk"
  # The project goes; the caches it warmed stay.
  rm -rf "${PROBE}"

  # Rust FFI: prove the Rust->Android cross-build actually works, end to end, rather
  # than trust that the target and the NDK are merely present. A minimal cdylib
  # crate built with `cargo ndk` for arm64-v8a must produce a real ELF .so for
  # aarch64 — the exact artifact a flutter_rust_bridge plugin ships in its jniLibs.
  # This is what would otherwise fail for the first FFI intent, so it fails the bake.
  RUST_PROBE=/tmp/aidlc_rust_ffi_probe
  rm -rf "${RUST_PROBE}"
  cargo new --lib "${RUST_PROBE}" >/dev/null
  cat >> "${RUST_PROBE}/Cargo.toml" <<'TOML'

[lib]
crate-type = ["cdylib"]
TOML
  # #[unsafe(no_mangle)], not #[no_mangle]: `cargo new` defaults to edition 2024,
  # which makes the bare attribute a hard error ("unsafe attribute used without
  # unsafe"). This is the form a current flutter_rust_bridge crate uses too.
  cat > "${RUST_PROBE}/src/lib.rs" <<'RS'
#[unsafe(no_mangle)]
pub extern "C" fn aidlc_ffi_probe(a: i32, b: i32) -> i32 { a + b }
RS
  # -t arm64-v8a is the ABI; cargo-ndk maps it to aarch64-linux-android and points
  # the linker at ${ANDROID_NDK_HOME}. -o writes the per-ABI jniLibs tree.
  (cd "${RUST_PROBE}" && cargo ndk -t arm64-v8a -o ./jniLibs build --release)
  # Glob rather than hardcode the name: the cdylib is lib<crate>.so and the crate
  # name is the probe directory's basename, so pin the ABI dir, not the filename.
  SO=$(echo "${RUST_PROBE}/jniLibs/arm64-v8a/"*.so)
  test -f "${SO}" || { echo "FATAL: cargo ndk produced no arm64 .so under jniLibs/arm64-v8a" >&2; exit 1; }
  file "${SO}" | grep -qE 'ELF 64-bit.*(ARM aarch64|aarch64)' \
    || { echo "FATAL: FFI .so is not an aarch64 ELF: $(file "${SO}")" >&2; exit 1; }
  echo "rust-ffi: $(file "${SO}")"
  rm -rf "${RUST_PROBE}"
fi

# ── Provenance ──────────────────────────────────────────────────────────────
# Written alongside the base image's /etc/aidlc-worker-ami.json rather than into
# it: this is a variant layer, and an operator reading the instance should be able
# to see both what the base was and what was added on top.
cat > /etc/aidlc-worker-flutter.json <<PROVENANCE
{
  "flutter": "${FLUTTER_VERSION}",
  "flutterArchiveSha256": "${FLUTTER_SHA256}",
  # Read from the SDK's own version file, NOT \`dart --version\`. Every flutter and
  # dart invocation as root prepends a multi-line "you appear to be running as root"
  # warning, and parsing a field out of that merged stream put the word "running"
  # in this file — with an embedded newline that made the JSON unparseable.
  "dart": "$(cat "${FLUTTER_ROOT}/bin/cache/dart-sdk/version")",
  "java": "$(javac -version 2>&1 | awk '{print $2}')",
  "javaHome": "${JAVA_HOME}",
  "androidSdkRoot": "${ANDROID_SDK_ROOT}",
  "androidCmdlineToolsBuild": "${ANDROID_CMDLINE_BUILD}",
  "androidPlatform": "${ANDROID_PLATFORM}",
  "androidBuildTools": "${ANDROID_BUILD_TOOLS}",
  "androidNdk": "${ANDROID_NDK_VERSION:-none}",
  "rust": "$(rustc --version 2>/dev/null | awk '{print $2}')",
  "cargoNdk": "${CARGO_NDK_VERSION}",
  "frbCodegen": "${FRB_CODEGEN_VERSION}",
  "rustAndroidTargets": "${RUST_ANDROID_TARGETS}",
  "gradleCacheWarmed": ${FLUTTER_VERIFY_BUILD},
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
PROVENANCE

# dnf and pip caches go; the Flutter, pub and Gradle caches STAY — see the note on
# the probe build above.
dnf clean all
rm -rf /var/cache/dnf /root/.npm /tmp/sdk-licenses.log /tmp/flutter-licenses.log
echo "[aidlc] flutter/android layer complete"
