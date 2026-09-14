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
# Latest clang/cmake straight from Fedora, plus libc++ so C++23 library features
# are not capped by the distro's libstdc++ vintage.
dnf -y install --setopt=install_weak_deps=False \
  clang clang-tools-extra lld libcxx libcxx-devel libcxxabi-devel \
  cmake ninja-build \
  git curl unzip tar xz jq python3 \
  gcc-c++ libstdc++-devel \
  perl-core zip pkgconf-pkg-config \
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
export PATH="${RUNNER_ROOT}/node/bin:/usr/local/bin:\${PATH}"
export VCPKG_ROOT=/opt/vcpkg
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

# ── Provenance ──────────────────────────────────────────────────────────────
# What the verification step and the operator both read back.
cat > /etc/aidlc-worker-ami.json <<PROVENANCE
{
  "clang": "$(clang --version | head -1)",
  "cmake": "$(cmake --version | head -1)",
  "vcpkg": "$(git -C /opt/vcpkg rev-parse HEAD)",
  "node": "$(node --version)",
  "claudeCode": "${CLAUDE_CODE_VERSION}",
  "opencode": "${OPENCODE_VERSION}",
  "cloudwatchAgent": "${CWAGENT_VERSION}",
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
PROVENANCE

dnf clean all
rm -rf /var/cache/dnf /root/.npm /tmp/*

echo "=== worker AMI provisioned ==="
cat /etc/aidlc-worker-ami.json
