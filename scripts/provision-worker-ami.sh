#!/usr/bin/env bash
# Provision a worker AMI. Runs AS ROOT ON THE BUILDER INSTANCE, then you snapshot
# it with CreateImage.
#
# Everything the worker needs lives in the image: the C++ toolchain, Node, the
# agent CLIs, the CloudWatch agent, and the runner itself. user-data at launch only
# writes configuration — the environment file and the log-shipping config, both of
# which depend on the environment being launched — and starts the services, so a
# stage is never waiting on a download before it can begin.
#
# Base: Fedora Cloud (dnf). Fedora because the toolchain versions are the point —
# measured on 45-Prerelease: clang 23, cmake 4.3, libstdc++ 16, glibc 2.44, all
# from the distro with no third-party repos.
#
# Usage: provision-worker-ami.sh [repo-dir]
set -euxo pipefail

# cloud-init runs user-data with no HOME, and several third-party installers
# (npm, and some CLI installers) dereference it unconditionally. Set it first.
export HOME=${HOME:-/root}

REPO=${1:-/opt/aidlc-dev}
RUNNER_ROOT=/opt/aidlc-runner
DOCKERFILE="${REPO}/lambda/agentcore/Dockerfile"

# ── Toolchain ───────────────────────────────────────────────────────────────
# This AMI is the one-stop-shop for ANYTHING C++, so the toolchain is deliberately
# broad rather than minimal, and every group below is here because something a
# stage plausibly runs needs it and `install_weak_deps=False` means nothing arrives
# by accident:
#
#   compilers/std lib  clang + libc++ (so C++23 library features are not capped by
#                      the distro libstdc++ vintage) AND gcc-c++, because "any C++"
#                      means both front ends, not a house preference.
#   build drivers      make (autotools/hand-written Makefiles), cmake, ninja, and
#                      the autotools chain itself — autoconf/automake/libtool/m4,
#                      which were ABSENT before and break every `autoreconf`/
#                      libtoolized vcpkg port with "autoconf: command not found".
#                      bazel is handled separately below (no Fedora package).
#   parser generators  bison/flex — a surprising number of C++ projects generate a
#                      lexer/parser at build time.
#   sanitizer runtimes lib{a,ub,t,l}san are the GCC-side ASan/UBSan/TSan/LSan
#                      runtimes; compiler-rt is the clang side (and its coverage +
#                      sanitizer libs). clang ships MSan headers but MSan needs an
#                      instrumented libc++, which is out of scope — the other three
#                      work with stock libs.
#   coverage           llvm (llvm-cov, llvm-profdata for clang source-based
#                      coverage) + lcov/gcov side for gcc --coverage.
#   profilers          perf (see the kernel section for why it works here),
#                      valgrind (callgrind/massif/memcheck), gperf (GNU perfect
#                      hash generator) AND gperftools (google-perftools: tcmalloc,
#                      the CPU/heap profiler and pprof) — the two unrelated tools
#                      people both call "gperf".
#   eBPF / tracing     bpftrace, bcc-tools, bpftool, libbpf — the lock-contention
#                      and dynamic-tracing path. Rely on kernel BTF (present, see
#                      below), so no kernel-devel version-matching dance.
#   debug/inspect      gdb, strace, ltrace, elfutils, binutils.
dnf -y install --setopt=install_weak_deps=False \
  clang clang-tools-extra clang-analyzer lld llvm compiler-rt libcxx libcxx-devel libcxxabi-devel \
  gcc-c++ libstdc++-devel libstdc++-static glibc-static \
  libasan libubsan libtsan liblsan \
  cmake ninja-build make \
  autoconf automake libtool m4 \
  bison flex patch \
  valgrind gperf gperftools gperftools-devel \
  lcov \
  perf bpftrace bcc-tools bpftool libbpf libbpf-devel \
  gdb strace ltrace elfutils binutils ccache \
  git curl unzip tar xz jq python3 \
  perl-core zip pkgconf-pkg-config \
  kernel-headers \
  gnupg2

# vcpkg. Pinned to a release tag so an AMI rebuild is reproducible; VCPKG_ROOT is
# exported system-wide so a stage's own build scripts find it without being told.
#
# NO FALLBACK. This used to be `clone --branch "$REF" || clone` with a default of
# 2026.08.15 — a tag that does not exist upstream — so every build silently took
# the fallback and shipped whatever the default branch happened to be that day.
# The image was fine and the comment above it was a lie: two AMIs built a day apart
# carried different vcpkg trees. An unresolvable ref is now a build failure, which
# is the only way a pin means anything.
VCPKG_REF=${VCPKG_REF:-2026.07.29}
if [ ! -d /opt/vcpkg ]; then
  if ! git clone --depth 1 --branch "${VCPKG_REF}" https://github.com/microsoft/vcpkg.git /opt/vcpkg; then
    echo "FATAL: vcpkg ref '${VCPKG_REF}' does not exist upstream." >&2
    echo "       Pick a real tag from https://github.com/microsoft/vcpkg/tags" >&2
    echo "       or override with VCPKG_REF=<tag>. Refusing to build an" >&2
    echo "       unpinned image." >&2
    exit 1
  fi
  /opt/vcpkg/bootstrap-vcpkg.sh -disableMetrics
fi
cat > /etc/profile.d/aidlc-toolchain.sh <<'PROFILE'
export VCPKG_ROOT=/opt/vcpkg
export PATH="${VCPKG_ROOT}:${PATH}"
PROFILE
chmod 0644 /etc/profile.d/aidlc-toolchain.sh

# ── vcpkg binary + asset cache (shared, on S3) ────────────────────────────────
# per-stage-ephemeral means every C++ stage starts on a FRESH instance with an
# empty build tree, so without a SHARED cache vcpkg recompiles everything — Qt,
# Boost, LLVM — on every single stage. A local cache is useless here because the
# instance is terminated when the stage ends; the cache must outlive the instance.
#
# vcpkg's own binary caching solves exactly this: it keys each built package by an
# ABI hash (source + triplet + dependency tree + compiler + flags) and, on a hit,
# unpacks the prebuilt archive instead of building. The `x-aws` backend stores those
# archives in S3 via the AWS CLI (present on this image), so the cache is shared
# across every worker and every intent.
#
# readwrite: a cold port builds once, anywhere in the fleet, and is a hit for every
# stage after. The bucket + the RW IAM policy on the instance role are provisioned
# out of band (the bucket and the collaborative-ai-dlc-vcpkg-cache-dev policy on the
# executor role); this only points vcpkg at them. A drop-in, not profile.d, because
# the RUNNER and every compiler it spawns must see it — see /etc/aidlc-runner.d in
# the launcher.
#
# Binary caching only. `x-aws` is a BINARY-cache backend; vcpkg asset caching
# (X_VCPKG_ASSET_SOURCES) speaks a different grammar with no S3 backend — it would
# need an x-script shim shelling out to `aws s3`, which is a separate change and not
# what saves the Qt rebuild. The binary cache is the win.
VCPKG_CACHE_BUCKET=${VCPKG_CACHE_BUCKET:-collaborative-ai-dlc-vcpkg-cache-dev-592872546055}
VCPKG_CACHE_REGION=${VCPKG_CACHE_REGION:-eu-central-1}
install -d /etc/aidlc-runner.d
cat > /etc/aidlc-runner.d/vcpkg-cache.sh <<CACHE
# Managed by provision-worker-ami.sh. Shared vcpkg binary cache on S3.
export AWS_DEFAULT_REGION=\${AWS_DEFAULT_REGION:-${VCPKG_CACHE_REGION}}
export VCPKG_BINARY_SOURCES="clear;x-aws,s3://${VCPKG_CACHE_BUCKET}/binaries/,readwrite"
CACHE
chmod 0644 /etc/aidlc-runner.d/vcpkg-cache.sh
# A symlink as well as the profile script and the launcher's PATH, because the
# three reach different processes: profile.d covers a login shell, the launcher
# covers the runner and everything it spawns, and this covers anything that got
# neither — a script with its own PATH, or a future unit that does not use the
# launcher. `vcpkg` must resolve for a stage told to use vcpkg and nothing else.
ln -sf /opt/vcpkg/vcpkg /usr/local/bin/vcpkg

# ── Bazel (via Bazelisk) ──────────────────────────────────────────────────────
# There is no Fedora bazel package, and pinning bazel itself would be wrong anyway:
# a Bazel repo declares its own version in .bazelversion, and the launcher's job is
# to honour THAT. So we bake Bazelisk — the official launcher — pinned and
# checksum-verified like everything else, and let it fetch the project's exact
# Bazel on first build (NAT egress is available). Installed as BOTH `bazel` and
# `bazelisk`: build scripts and IDEs invoke `bazel`, and that must be the launcher.
BAZELISK_VERSION=${BAZELISK_VERSION:-1.29.0}
BAZELISK_SHA256=${BAZELISK_SHA256:-5a408715e932c0250d28bd84555f12edbf70117de42f9181691c736eacc4a992}
BAZELISK_ARCH=$([ "$(uname -m)" = "aarch64" ] && echo arm64 || echo amd64)
curl -fsSLo /tmp/bazelisk \
  "https://github.com/bazelbuild/bazelisk/releases/download/v${BAZELISK_VERSION}/bazelisk-linux-${BAZELISK_ARCH}"
# amd64 checksum only; an arm64 build must pass its own BAZELISK_SHA256.
if [ "${BAZELISK_ARCH}" = "amd64" ]; then
  echo "${BAZELISK_SHA256}  /tmp/bazelisk" | sha256sum -c -
fi
install -m 0755 /tmp/bazelisk /usr/local/bin/bazelisk
ln -sf /usr/local/bin/bazelisk /usr/local/bin/bazel
rm -f /tmp/bazelisk

# ── pprof (the profile viewer for gperftools AND perf output) ─────────────────
# gperftools ships the CPU/heap profiler RUNTIME (libprofiler, libtcmalloc) but no
# longer the viewer: upstream removed the old perl `pprof` after 2.16 and now points
# at github.com/google/pprof, a Go tool with no prebuilt release binary. So the only
# way to bake it is to build it — but a C++ image should not carry a permanent Go
# toolchain for one binary, so Go is installed, used, and removed, leaving a single
# static `pprof`. Pinned to an exact commit for reproducibility.
PPROF_COMMIT=${PPROF_COMMIT:-6331bc6350fe55a6fec2957299e0581dd7510e36}
dnf -y install --setopt=install_weak_deps=False golang
GOFLAGS=-mod=mod GOBIN=/usr/local/bin \
  go install "github.com/google/pprof@${PPROF_COMMIT}"
dnf -y remove golang || true
rm -rf /root/go /root/.cache/go-build
command -v pprof >/dev/null || { echo "FATAL: pprof build did not produce a binary" >&2; exit 1; }

# ── Kernel measurement policy ─────────────────────────────────────────────────
# perf and eBPF are useless to a build agent unless the KERNEL lets an unprivileged
# perf_event_open see kernel data and unless kernel pointers are readable. On a
# managed AgentCore microVM you cannot touch these at all — which is a core reason
# a C++ perf environment is EC2, not AgentCore: here the AMI IS the whole guest OS
# and a sysctl.d drop-in takes effect at boot.
#
#   perf_event_paranoid=-1  full access, including kernel/tracepoint events and the
#                           BPF-backed `perf lock contention`. The agent needs -1,
#                           not merely lowered, and this makes it the boot default so
#                           no stage has to set it (the runner is root and still can,
#                           but relying on that is a footgun).
#   kptr_restrict=0         perf/bpftrace symbolize kernel addresses; without this
#                           they resolve to 0 and stacks are unreadable.
#   yama.ptrace_scope=0     gdb/strace/valgrind attaching to a sibling process, and
#                           TSan/ASan helper attaches.
#   vm.mmap_rnd_bits=28     AddressSanitizer aborts on newer kernels whose default
#                           ASLR entropy (32) collides with its shadow layout
#                           ("Shadow memory range interleaves"). 28 is the documented
#                           fix and does not weaken anything a build box relies on.
#
# This is a deliberate, single-tenant, per-stage-ephemeral posture: the instance
# runs one stage and is terminated. Exposing kernel addresses to root on a throwaway
# box the agent already fully controls costs nothing; on a shared or long-lived host
# it would not be acceptable.
cat > /etc/sysctl.d/99-aidlc-perf.conf <<'SYSCTL'
kernel.perf_event_paranoid = -1
kernel.kptr_restrict = 0
kernel.yama.ptrace_scope = 0
vm.mmap_rnd_bits = 28
SYSCTL
chmod 0644 /etc/sysctl.d/99-aidlc-perf.conf
# Apply now too, so the verification block below runs under the real policy rather
# than the bake shell's inherited defaults.
sysctl -p /etc/sysctl.d/99-aidlc-perf.conf || true

# ── Node ────────────────────────────────────────────────────────────────────
# Read from the Dockerfile so a worker and the container run the same runtime.
NODE_VERSION=$(grep -oE 'node:[0-9]+\.[0-9]+\.[0-9]+' "$DOCKERFILE" | head -1 | cut -d: -f2)
ARCH=$([ "$(uname -m)" = "aarch64" ] && echo arm64 || echo x64)
# The tarball must keep its published NAME: `sha256sum -c` resolves the filename
# listed in SHASUMS256.txt relative to the cwd, so renaming it fails the check.
NODE_TARBALL="node-v${NODE_VERSION}-linux-${ARCH}.tar.xz"
curl -fsSLo "/tmp/${NODE_TARBALL}" "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}"
curl -fsSLo /tmp/SHASUMS256.txt "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
(cd /tmp && grep " ${NODE_TARBALL}\$" SHASUMS256.txt | sha256sum -c -)
install -d "${RUNNER_ROOT}/node"
tar -xJf "/tmp/${NODE_TARBALL}" -C "${RUNNER_ROOT}/node" --strip-components=1
rm -f "/tmp/${NODE_TARBALL}" /tmp/SHASUMS256.txt
export PATH="${RUNNER_ROOT}/node/bin:${PATH}"
node --version | grep -qF "v${NODE_VERSION}"

# ── Agent CLIs ──────────────────────────────────────────────────────────────
# Versions read from the Dockerfile for the same reason as Node: a stage must not
# behave differently depending on where it was placed.
# Claude Code and OpenCode only. discoverInstalledClis finds what is on PATH and
# selectCli picks from what is available, so this is a complete worker; an AMI
# that also wants Codex or Kiro is the operator's call to make.
pin() { grep -E "^ARG $1=" "$DOCKERFILE" | head -1 | cut -d= -f2; }
CLAUDE_CODE_VERSION=$(pin CLAUDE_CODE_VERSION)
OPENCODE_VERSION=$(pin OPENCODE_VERSION)

npm install -g --no-audit --no-fund "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"
claude --version | grep -qF "${CLAUDE_CODE_VERSION}"

OPENCODE_ARCH=$([ "$ARCH" = "x64" ] && echo x64 || echo arm64)
install -d /opt/opencode/bin
curl -fsSLo /tmp/opencode.tar.gz \
  "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-${OPENCODE_ARCH}.tar.gz"
tar -xzf /tmp/opencode.tar.gz -C /opt/opencode/bin
chmod +x /opt/opencode/bin/opencode
ln -sf /opt/opencode/bin/opencode /usr/local/bin/opencode
rm -f /tmp/opencode.tar.gz
opencode --version | grep -qF "${OPENCODE_VERSION}"

# Bun, for the deterministic CODE sensors (they shell out to bunx eslint / tsc).
curl -fsSL https://bun.sh/install | BUN_INSTALL=/opt/bun bash
ln -sf /opt/bun/bin/bun /usr/local/bin/bun
ln -sf /opt/bun/bin/bunx /usr/local/bin/bunx

# ── The runner ──────────────────────────────────────────────────────────────
# The agentcore package plus the shared helpers it imports, with production deps.
install -d "${RUNNER_ROOT}/app"
for pkg in agentcore shared; do
  install -d "${RUNNER_ROOT}/app/${pkg}"
  tar -C "${REPO}/lambda/${pkg}" --exclude=node_modules --exclude=test --exclude=.build \
    -cf - . | tar -C "${RUNNER_ROOT}/app/${pkg}" -xf -
done
# Install at app/ level, NOT inside app/agentcore. Node resolves a bare import
# from the IMPORTING file upwards, and app/shared/valkey/client.js imports
# iovalkey — with node_modules only under app/agentcore, that resolution walks
# past app/shared, past app/, and fails with ERR_MODULE_NOT_FOUND. One
# node_modules at app/ is a parent of both packages, so both resolve.
cp "${REPO}/lambda/agentcore/package.json" "${RUNNER_ROOT}/app/package.json"
(cd "${RUNNER_ROOT}/app" && npm install --omit=dev --no-audit --no-fund)

install -d "${RUNNER_ROOT}/bin"
cat > "${RUNNER_ROOT}/bin/aidlc-runner" <<LAUNCHER
#!/usr/bin/env bash
set -euo pipefail
# /opt/vcpkg AND /opt/bun/bin on PATH, not just VCPKG_ROOT.
#
# systemd hands a service its own minimal PATH — no /etc/profile, so
# /etc/profile.d/aidlc-toolchain.sh never runs and none of the toolchain's own
# directories are on it. Every process the agent spawns inherits THIS PATH, so
# with only VCPKG_ROOT exported a stage could open the vcpkg tree but could not
# run \`vcpkg install\`: the binary lives at /opt/vcpkg/vcpkg and nothing linked
# it. An interactive SSM shell DID have it (that is the profile.d script), which
# is exactly why this looked fine when checked by hand.
export PATH="${RUNNER_ROOT}/node/bin:/opt/vcpkg:/opt/bun/bin:/usr/local/bin:\${PATH}"
export VCPKG_ROOT=/opt/vcpkg

# Toolchain drop-ins, for the same reason the PATH above is set here: a variant
# image adds tools this script has never heard of, and they need environment, not
# just a symlink — ANDROID_SDK_ROOT and JAVA_HOME are read by gradle, not resolved
# from PATH. A drop-in reaches the runner AND every process it spawns; profile.d
# reaches neither (no /etc/profile under systemd) and /etc/aidlc-runner.env belongs
# to user-data, which is written per LAUNCH and cannot know what the AMI contains.
if [ -d /etc/aidlc-runner.d ]; then
  # \`|| continue\`, not \`&& source\`: an unmatched glob leaves the literal pattern in
  # \$dropin, the test fails, and under \`set -e\` a failing last command in the loop
  # body would take the whole launcher down before the runner ever started.
  for dropin in /etc/aidlc-runner.d/*.sh; do
    [ -r "\$dropin" ] || continue
    . "\$dropin"
  done
fi

export V2_WORKSPACE_DIR="\${V2_WORKSPACE_DIR:-/mnt/workspace}"
mkdir -p "\${V2_WORKSPACE_DIR}"

# The log goes to a FILE as well as the journal, because per-stage-ephemeral
# terminates this instance the moment its stage ends and the journal dies with it —
# leaving every failure unexplainable after the fact. The CloudWatch agent tails
# this file; user-data points it here.
#
# tee, deliberately, and NOT StandardOutput=append: in the unit. systemd can send a
# stream to the journal or to a file, not to both, and an operator who has an SSM
# shell on a live worker reaches for \`journalctl -u aidlc-runner\` first. tee's own
# stdout IS the journal, so both readers keep working.
#
# No rotation: an instance under per-stage-ephemeral lives for one stage against a
# 100 GiB root volume, so the file cannot outgrow the disk before the disk is gone.
LOG_DIR="\${LOGS_DIRECTORY:-/var/log/aidlc}"
mkdir -p "\${LOG_DIR}"
exec > >(tee -a "\${LOG_DIR}/runner.log") 2>&1

exec "${RUNNER_ROOT}/node/bin/node" "${RUNNER_ROOT}/app/agentcore/worker.js"
LAUNCHER
chmod +x "${RUNNER_ROOT}/bin/aidlc-runner"

# Installed but NOT enabled: user-data enables it after writing the environment
# file, so a worker never starts half-configured and registers itself as ready.
cat > /etc/systemd/system/aidlc-runner.service <<UNIT
[Unit]
Description=AI-DLC stage worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# HOME, because systemd starts a service with NO \$HOME and git refuses to run
# without one: "fatal: \$HOME not set". That killed the first real stage placed on
# an instance — the worker registered, claimed the job and opened its callback
# heartbeat, then every git invocation died, surfacing as
# workspace_restore_failed: could not re-clone. git also needs it to find
# ~/.gitconfig and the credential helper the engine writes.
Environment=HOME=/root
EnvironmentFile=/etc/aidlc-runner.env
# /var/log/aidlc, created by systemd on every start so the launcher's tee always
# has somewhere to write. Declared here rather than mkdir'd in the AMI because a
# directory baked into an image is one \`rm -rf /var/log/*\` away from being gone,
# and then the CloudWatch agent tails a file nobody writes.
LogsDirectory=aidlc
LogsDirectoryMode=0755
ExecStart=${RUNNER_ROOT}/bin/aidlc-runner
Restart=on-failure
RestartSec=5
StartLimitBurst=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

# The SSM agent, so an operator can get a shell on a stuck build host with no
# inbound path and no SSH key — the same way the dev host itself is reached.
dnf -y install "https://s3.${AWS_REGION:-eu-central-1}.amazonaws.com/amazon-ssm-${AWS_REGION:-eu-central-1}/latest/linux_${ARCH/x64/amd64}/amazon-ssm-agent.rpm" || \
  dnf -y install amazon-ssm-agent || true
systemctl enable amazon-ssm-agent || true

# ── Log shipping ────────────────────────────────────────────────────────────
# The Amazon CloudWatch agent, so a stage's log outlives the instance that wrote
# it. Under per-stage-ephemeral the worker is terminated when its stage ends, and
# until now the runner's journal — the only account of what the stage actually did —
# was destroyed with it. A 14-minute hang that ended in
# `stage_callback_failed: Callback timed out on heartbeat` could not be explained
# at all, because the evidence no longer existed.
#
# The agent reads FILES, not journald: there is no journald input on Linux, and the
# pattern AWS documents for a systemd service is exactly this one — have the service
# write to a file and let the agent upload it. That is what the launcher's tee is
# for. Installed but NOT configured or enabled here: the log group and stream carry
# the environment id, which only exists at launch, so user-data writes the config
# and starts the agent (see renderUserData in lambda/environments/ec2-launch-template.js).
#
# Pinned and signature-verified, like every other download in this script. There is
# no published .sha256 for the RPM — only a detached GPG signature — so the check is
# gpg against the vendor key rather than sha256sum.
CWAGENT_VERSION=${CWAGENT_VERSION:-1.300072.0b1766}
CWAGENT_BASE=https://amazoncloudwatch-agent.s3.amazonaws.com
CWAGENT_URL="${CWAGENT_BASE}/redhat/${ARCH/x64/amd64}/${CWAGENT_VERSION}/amazon-cloudwatch-agent.rpm"
curl -fsSLo /tmp/amazon-cloudwatch-agent.rpm "${CWAGENT_URL}"
curl -fsSLo /tmp/amazon-cloudwatch-agent.rpm.sig "${CWAGENT_URL}.sig"
curl -fsSLo /tmp/amazon-cloudwatch-agent.gpg "${CWAGENT_BASE}/assets/amazon-cloudwatch-agent.gpg"
gpg --import /tmp/amazon-cloudwatch-agent.gpg
gpg --verify /tmp/amazon-cloudwatch-agent.rpm.sig /tmp/amazon-cloudwatch-agent.rpm
dnf -y install /tmp/amazon-cloudwatch-agent.rpm
rm -f /tmp/amazon-cloudwatch-agent.rpm /tmp/amazon-cloudwatch-agent.rpm.sig /tmp/amazon-cloudwatch-agent.gpg
# Assert the binary user-data guards on is actually where it expects it.
test -x /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl

# SELinux permissive: this is a build host that executes agent-driven compilers
# and writes freely under the workspace. Enforcing would fight the workload
# without protecting anything an operator relies on here.
sed -i 's/^SELINUX=enforcing/SELINUX=permissive/' /etc/selinux/config || true

# ── Verification ──────────────────────────────────────────────────────────────
# Prove the toolchain rather than trust that dnf placed it. Every tool this AMI
# advertises is asserted present, and the two capabilities that are easy to ship
# broken — sanitizers and kernel measurement — are actually exercised. A failure
# here fails the bake, which is the whole point: finding it now costs minutes,
# finding it from a stage costs an intent.
for bin in gcc g++ clang clang++ make cmake ninja \
           autoconf automake libtool m4 bison flex \
           bazel bazelisk vcpkg \
           gdb strace ltrace valgrind ccache \
           perf bpftrace bpftool \
           llvm-cov llvm-profdata lcov gcov gperf pprof; do
  command -v "$bin" >/dev/null || { echo "FATAL: $bin missing from image" >&2; exit 1; }
done

# BTF is what makes CO-RE eBPF (perf lock contention, modern bcc/bpftrace) work
# without kernel-devel. If it is gone the eBPF story is a lie, so assert it.
test -r /sys/kernel/btf/vmlinux || { echo "FATAL: no kernel BTF; eBPF tools will not work" >&2; exit 1; }

# gperftools is a runtime, not a binary: assert the profiler/tcmalloc libs the
# linker will actually look for, since `command -v` cannot see them.
ldconfig -p | grep -q 'libprofiler\.so' || { echo "FATAL: gperftools libprofiler missing" >&2; exit 1; }
ldconfig -p | grep -q 'libtcmalloc\.so' || { echo "FATAL: gperftools libtcmalloc missing" >&2; exit 1; }

# ASan actually links and runs under the baked ASLR policy. This is the exact thing
# vm.mmap_rnd_bits=28 exists to fix: without it an instrumented binary aborts at
# startup with "Shadow memory range interleaves" before main. The program is CLEAN
# on purpose — a clean exit proves the runtime initialized under this kernel; using
# a leaking program here would make LeakSanitizer's correct non-zero exit look like
# a toolchain failure, which is exactly the false alarm this comment prevents.
cat > /tmp/asan_check.cpp <<'CPP'
#include <vector>
int main() { std::vector<int> v(4, 1); return v[0] - 1; }
CPP
g++ -fsanitize=address,undefined,leak -O0 -g /tmp/asan_check.cpp -o /tmp/asan_check
/tmp/asan_check || { echo "FATAL: ASan/UBSan/LSan binary did not initialize under this kernel" >&2; exit 1; }

# TSan links too (its runtime is a separate lib and a common missing piece).
echo 'int main(){return 0;}' > /tmp/tsan_check.cpp
g++ -fsanitize=thread -O0 /tmp/tsan_check.cpp -o /tmp/tsan_check && /tmp/tsan_check

# clang source-based coverage round-trips (instrument -> run -> merge -> report).
clang++ -fprofile-instr-generate -fcoverage-mapping /tmp/tsan_check.cpp -o /tmp/cov_check
LLVM_PROFILE_FILE=/tmp/cov.profraw /tmp/cov_check
llvm-profdata merge -sparse /tmp/cov.profraw -o /tmp/cov.profdata
llvm-cov report /tmp/cov_check -instr-profile=/tmp/cov.profdata >/dev/null

# perf and eBPF actually function under the baked sysctls. perf_event_paranoid must
# read back -1, a hardware-counter stat must produce a number, and the BPF-backed
# lock-contention path must attach — the three things a metal-vs-virtual instance
# usually differs on, verified here on whatever this bake runs on.
test "$(cat /proc/sys/kernel/perf_event_paranoid)" = "-1" \
  || { echo "FATAL: perf_event_paranoid did not apply" >&2; exit 1; }
perf stat -e cycles,instructions -- sleep 0.1 2>&1 | grep -qE 'cycles|instructions' \
  || { echo "FATAL: perf hardware counters unavailable" >&2; exit 1; }
perf lock contention -b -- sleep 0.3 >/dev/null 2>&1 \
  || echo "WARNING: perf lock contention (eBPF) did not run during bake; verify on the target instance type" >&2
rm -f /tmp/asan_check* /tmp/tsan_check* /tmp/cov_check /tmp/cov.prof* /tmp/asan_check.cpp /tmp/tsan_check.cpp

# ── Provenance ──────────────────────────────────────────────────────────────
# What the verification step and the operator both read back.
cat > /etc/aidlc-worker-ami.json <<PROVENANCE
{
  "clang": "$(clang --version | head -1)",
  "gcc": "$(gcc -dumpfullversion 2>/dev/null || gcc --version | head -1)",
  "cmake": "$(cmake --version | head -1)",
  "bazelisk": "${BAZELISK_VERSION}",
  "vcpkg": "$(git -C /opt/vcpkg rev-parse HEAD)",
  "perf": "$(perf --version 2>/dev/null | head -1)",
  "bpftrace": "$(bpftrace --version 2>/dev/null | head -1)",
  "gdb": "$(gdb --version 2>/dev/null | head -1)",
  "valgrind": "$(valgrind --version 2>/dev/null)",
  "node": "$(node --version)",
  "claudeCode": "${CLAUDE_CODE_VERSION}",
  "opencode": "${OPENCODE_VERSION}",
  "cloudwatchAgent": "${CWAGENT_VERSION}",
  "kernel": "$(uname -r)",
  "perfEventParanoid": "$(cat /proc/sys/kernel/perf_event_paranoid)",
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
PROVENANCE

dnf clean all
rm -rf /var/cache/dnf /root/.npm /tmp/*

echo "=== worker AMI provisioned ==="
cat /etc/aidlc-worker-ami.json
