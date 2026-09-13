#!/usr/bin/env bash
# Provision a worker AMI. Runs AS ROOT ON THE BUILDER INSTANCE, then you snapshot
# it with CreateImage.
#
# Everything the worker needs lives in the image: the C++ toolchain, Node, the
# agent CLIs, and the runner itself. user-data at launch only writes the
# environment file and starts the service, so a stage is never waiting on a
# download before it can begin.
#
# Base: Fedora Cloud (dnf). Fedora because the toolchain versions are the point —
# measured on 45-Prerelease: clang 23, cmake 4.3, libstdc++ 16, glibc 2.44, all
# from the distro with no third-party repos.
#
# Usage: provision-worker-ami.sh [repo-dir]
set -euxo pipefail

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
  perl-core zip pkgconf-pkg-config

# vcpkg. Pinned to a tag so an AMI rebuild is reproducible; VCPKG_ROOT is exported
# system-wide so a stage's own build scripts find it without being told.
VCPKG_REF=${VCPKG_REF:-2026.08.15}
if [ ! -d /opt/vcpkg ]; then
  git clone --depth 1 --branch "${VCPKG_REF}" https://github.com/microsoft/vcpkg.git /opt/vcpkg \
    || git clone --depth 1 https://github.com/microsoft/vcpkg.git /opt/vcpkg
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
pin() { grep -E "^ARG $1=" "$DOCKERFILE" | head -1 | cut -d= -f2; }
CLAUDE_CODE_VERSION=$(pin CLAUDE_CODE_VERSION)
CODEX_VERSION=$(pin CODEX_VERSION)
OPENCODE_VERSION=$(pin OPENCODE_VERSION)
KIRO_CLI_VERSION=$(pin KIRO_CLI_VERSION)

npm install -g --no-audit --no-fund \
  "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}"
claude --version | grep -qF "${CLAUDE_CODE_VERSION}"
codex --version | grep -qF "${CODEX_VERSION}"

OPENCODE_ARCH=$([ "$ARCH" = "x64" ] && echo x64 || echo arm64)
install -d /opt/opencode/bin
curl -fsSLo /tmp/opencode.tar.gz \
  "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-${OPENCODE_ARCH}.tar.gz"
tar -xzf /tmp/opencode.tar.gz -C /opt/opencode/bin
chmod +x /opt/opencode/bin/opencode
ln -sf /opt/opencode/bin/opencode /usr/local/bin/opencode
rm -f /tmp/opencode.tar.gz
opencode --version | grep -qF "${OPENCODE_VERSION}"

KIRO_ARCH=$([ "$ARCH" = "x64" ] && echo x86_64 || echo aarch64)
curl -fsSLo /tmp/kiro.zip \
  "https://prod.download.cli.kiro.dev/stable/${KIRO_CLI_VERSION}/kirocli-${KIRO_ARCH}-linux-musl.zip"
unzip -q /tmp/kiro.zip -d /tmp/kiro-cli
KIRO_CLI_SKIP_SETUP=1 /tmp/kiro-cli/kirocli/install.sh
install -d /opt/kiro
cp -a /root/.local/bin /opt/kiro/bin
ln -sf /opt/kiro/bin/kiro-cli /usr/local/bin/kiro-cli
rm -rf /tmp/kiro.zip /tmp/kiro-cli /root/.local

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
(cd "${RUNNER_ROOT}/app/agentcore" && npm install --omit=dev --no-audit --no-fund)

install -d "${RUNNER_ROOT}/bin"
cat > "${RUNNER_ROOT}/bin/aidlc-runner" <<LAUNCHER
#!/usr/bin/env bash
set -euo pipefail
export PATH="${RUNNER_ROOT}/node/bin:/usr/local/bin:\${PATH}"
export VCPKG_ROOT=/opt/vcpkg
export V2_WORKSPACE_DIR="\${V2_WORKSPACE_DIR:-/mnt/workspace}"
mkdir -p "\${V2_WORKSPACE_DIR}"
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
EnvironmentFile=/etc/aidlc-runner.env
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
  "codex": "${CODEX_VERSION}",
  "opencode": "${OPENCODE_VERSION}",
  "kiroCli": "${KIRO_CLI_VERSION}",
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
PROVENANCE

dnf clean all
rm -rf /var/cache/dnf /root/.npm /tmp/*

echo "=== worker AMI provisioned ==="
cat /etc/aidlc-worker-ami.json
