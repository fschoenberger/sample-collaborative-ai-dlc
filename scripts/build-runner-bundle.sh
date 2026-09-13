#!/usr/bin/env bash
# Build the EC2 worker runner bundle.
#
# The bundle is what makes an operator's AMI genuinely opaque: nothing of ours is
# baked into it. An instance boots the operator's image, user-data fetches this
# tarball from S3, verifies its digest, and starts the worker under systemd.
#
# It carries everything the worker needs and the AMI is not assumed to have:
#   - a Node runtime (two of the agent CLIs are npm globals)
#   - the agentcore + shared packages with production dependencies
#   - the agent CLIs, pinned to the SAME versions the container image pins
#
# Built at apply time on the deploying machine, mirroring how the AgentCore image
# is built (terraform-aws-modules docker-build during apply) rather than adding a
# second, different build system.
#
# Usage: build-runner-bundle.sh <out-dir> [platform] [arch]
#   platform: linux (only supported today)
#   arch:     x64 | arm64   (Node's naming, not EC2's)
set -euo pipefail

OUT_DIR=${1:?usage: build-runner-bundle.sh <out-dir> [platform] [arch]}
PLATFORM=${2:-linux}
ARCH=${3:-x64}

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DOCKERFILE="${REPO_ROOT}/lambda/agentcore/Dockerfile"

if [ "$PLATFORM" != "linux" ]; then
  echo "unsupported platform: $PLATFORM (the runner bundle is Linux-only today)" >&2
  exit 2
fi

# Versions are read OUT OF THE DOCKERFILE rather than duplicated here. A worker
# and the container must run the same CLI versions or a stage's behaviour would
# depend on where it happened to be placed.
pin() {
  local name=$1
  local value
  value=$(grep -E "^ARG ${name}=" "$DOCKERFILE" | head -1 | cut -d= -f2)
  if [ -z "$value" ]; then
    echo "could not read ${name} from ${DOCKERFILE}" >&2
    exit 3
  fi
  printf '%s' "$value"
}

NODE_VERSION=$(grep -oE 'node:[0-9]+\.[0-9]+\.[0-9]+' "$DOCKERFILE" | head -1 | cut -d: -f2)
KIRO_CLI_VERSION=$(pin KIRO_CLI_VERSION)
CLAUDE_CODE_VERSION=$(pin CLAUDE_CODE_VERSION)
OPENCODE_VERSION=$(pin OPENCODE_VERSION)
CODEX_VERSION=$(pin CODEX_VERSION)

if [ -z "$NODE_VERSION" ]; then
  echo "could not read the node version from ${DOCKERFILE}" >&2
  exit 3
fi

echo "runner bundle: platform=${PLATFORM} arch=${ARCH}"
echo "  node=${NODE_VERSION} claude=${CLAUDE_CODE_VERSION} opencode=${OPENCODE_VERSION} codex=${CODEX_VERSION} kiro=${KIRO_CLI_VERSION}"

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/bin" "$STAGE/app" "$STAGE/node" "$STAGE/cli"

# ── Node runtime, verified against the official SHASUMS ─────────────────────
NODE_TARBALL="node-v${NODE_VERSION}-${PLATFORM}-${ARCH}.tar.xz"
NODE_BASE="https://nodejs.org/dist/v${NODE_VERSION}"
curl -fsSLo "$STAGE/${NODE_TARBALL}" "${NODE_BASE}/${NODE_TARBALL}"
curl -fsSLo "$STAGE/SHASUMS256.txt" "${NODE_BASE}/SHASUMS256.txt"
(cd "$STAGE" && grep " ${NODE_TARBALL}\$" SHASUMS256.txt | sha256sum -c -)
tar -xJf "$STAGE/${NODE_TARBALL}" -C "$STAGE/node" --strip-components=1
rm -f "$STAGE/${NODE_TARBALL}" "$STAGE/SHASUMS256.txt"
NODE_BIN="$STAGE/node/bin/node"
"$NODE_BIN" --version | grep -qF "v${NODE_VERSION}"

# ── Application: the agentcore package and the shared helpers it imports ────
# Copied rather than npm-packed because agentcore imports ../shared directly, the
# same reason the image's build context is the whole lambda/ directory.
for pkg in agentcore shared; do
  mkdir -p "$STAGE/app/$pkg"
  tar -C "${REPO_ROOT}/lambda/$pkg" \
    --exclude=node_modules --exclude=test --exclude=.build --exclude='*.log' \
    -cf - . | tar -C "$STAGE/app/$pkg" -xf -
done

# Production dependencies only. `npm ci` needs a lockfile, and the workspace one
# lives at the repo root, so install from a copy of the manifest instead.
cp "${REPO_ROOT}/package-lock.json" "$STAGE/app/package-lock.json" 2>/dev/null || true
(
  cd "$STAGE/app/agentcore"
  PATH="$STAGE/node/bin:$PATH" npm install --omit=dev --no-audit --no-fund --loglevel=error
)

# ── Agent CLIs, pinned to the container's versions ──────────────────────────
export PATH="$STAGE/node/bin:$PATH"
CLI_PREFIX="$STAGE/cli/npm"
mkdir -p "$CLI_PREFIX"
npm install --prefix "$CLI_PREFIX" --no-audit --no-fund --loglevel=error \
  "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}"

# OpenCode ships a per-arch tarball. NOTE the name is `-x64`, not `-amd64`.
OPENCODE_ARCH=$([ "$ARCH" = "x64" ] && echo x64 || echo arm64)
curl -fsSLo "$STAGE/opencode.tar.gz" \
  "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-${PLATFORM}-${OPENCODE_ARCH}.tar.gz"
mkdir -p "$STAGE/cli/opencode"
tar -xzf "$STAGE/opencode.tar.gz" -C "$STAGE/cli/opencode"
chmod +x "$STAGE/cli/opencode/opencode"
rm -f "$STAGE/opencode.tar.gz"

# Kiro ships a musl zip per architecture.
KIRO_ARCH=$([ "$ARCH" = "x64" ] && echo x86_64 || echo aarch64)
curl -fsSLo "$STAGE/kiro.zip" \
  "https://prod.download.cli.kiro.dev/stable/${KIRO_CLI_VERSION}/kirocli-${KIRO_ARCH}-linux-musl.zip"
mkdir -p "$STAGE/cli/kiro"
unzip -q "$STAGE/kiro.zip" -d "$STAGE/cli/kiro"
rm -f "$STAGE/kiro.zip"

# ── Launcher ────────────────────────────────────────────────────────────────
# systemd starts this. Every path is relative to the install root so the bundle
# can be extracted anywhere without a rebuild.
cat > "$STAGE/bin/aidlc-runner" <<'LAUNCHER'
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="${ROOT}/node/bin:${ROOT}/cli/npm/bin:${ROOT}/cli/opencode:${ROOT}/cli/kiro/kirocli:${PATH}"
export NODE_PATH="${ROOT}/app/agentcore/node_modules"
# The workspace the stage checks out into. run-stage self-heals an empty one by
# re-cloning, so a fresh instance needs no seeding.
export V2_WORKSPACE_DIR="${V2_WORKSPACE_DIR:-/mnt/workspace}"
mkdir -p "${V2_WORKSPACE_DIR}"
exec "${ROOT}/node/bin/node" "${ROOT}/app/agentcore/worker.js"
LAUNCHER
chmod +x "$STAGE/bin/aidlc-runner"

# The unit reads its environment from a file that user-data writes, so the bundle
# itself is identical for every environment and can be digest-pinned.
cat > "$STAGE/aidlc-runner.service" <<'UNIT'
[Unit]
Description=AI-DLC stage worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/aidlc-runner.env
ExecStart=/opt/aidlc-runner/bin/aidlc-runner
Restart=on-failure
RestartSec=5
# A worker that cannot reach Valkey or the scheduler is useless; give up rather
# than restart forever and look healthy to nobody.
StartLimitBurst=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

cat > "$STAGE/BUNDLE-INFO" <<INFO
platform=${PLATFORM}
arch=${ARCH}
node=${NODE_VERSION}
claude-code=${CLAUDE_CODE_VERSION}
codex=${CODEX_VERSION}
opencode=${OPENCODE_VERSION}
kiro-cli=${KIRO_CLI_VERSION}
INFO

# ── Emit a reproducible tarball + its digest ─────────────────────────────────
mkdir -p "$OUT_DIR"
BUNDLE="${OUT_DIR}/runner-${PLATFORM}-${ARCH}.tar.gz"
# Sorted names and a fixed mtime keep the digest stable across rebuilds of
# identical content, so terraform does not replace the object on every apply.
tar --sort=name --mtime='UTC 2020-01-01' --owner=0 --group=0 --numeric-owner \
  -czf "$BUNDLE" -C "$STAGE" .
sha256sum "$BUNDLE" | cut -d' ' -f1 > "${BUNDLE}.sha256"

echo "wrote ${BUNDLE}"
echo "sha256 $(cat "${BUNDLE}.sha256")"
