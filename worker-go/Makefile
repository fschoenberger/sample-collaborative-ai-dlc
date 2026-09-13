# Build and test the AI-DLC stage worker.
#
# GOPROXY is pinned here rather than in the global Go config so this module's
# fetch policy is explicit and does not leak into other projects on this
# machine. proxy.golang.org is unreachable from the corporate network, so
# modules are fetched from their origin; GOSUMDB stays on, so every module is
# still verified against the public checksum transparency log and the committed
# go.sum pins the hashes from then on.
export GOPROXY := direct
export GOSUMDB := sum.golang.org

# A static binary: the worker AMI and the AgentCore image must run it with no
# runtime library dependency beyond the kernel.
export CGO_ENABLED := 0

BIN     := aidlc-worker
DIST    := dist
PKG     := ./cmd/worker
VERSION := $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)

# The integration tests drive real containers through the Docker Engine API.
# Finch serves that API on its own socket, so point testcontainers at it unless
# the caller already chose an endpoint.
FINCH_SOCK := $(HOME)/.finch/lima/data/finch/sock/finch.sock
ifeq ($(origin DOCKER_HOST), undefined)
ifneq ($(wildcard $(FINCH_SOCK)),)
export DOCKER_HOST := unix://$(FINCH_SOCK)
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE := /var/run/docker.sock
endif
endif

.PHONY: all build build-all test test-unit test-integration vet fmt fmt-check tidy clean containers

all: fmt-check vet test build-all

build:
	go build -ldflags '$(LDFLAGS)' -o $(DIST)/$(BIN) $(PKG)

# Both architectures are required: the AgentCore runtime is ARM64, and the EC2
# worker fleet runs whichever instance family the environment's revision pins.
build-all: $(DIST)/$(BIN)-linux-arm64 $(DIST)/$(BIN)-linux-amd64

$(DIST)/$(BIN)-linux-arm64:
	GOOS=linux GOARCH=arm64 go build -ldflags '$(LDFLAGS)' -o $@ $(PKG)

$(DIST)/$(BIN)-linux-amd64:
	GOOS=linux GOARCH=amd64 go build -ldflags '$(LDFLAGS)' -o $@ $(PKG)

# Everything, including the container-backed suites.
test:
	go test ./... -race -timeout 20m

# Only the suites that need no container runtime.
test-unit:
	go test ./... -short -race -timeout 5m

test-integration:
	go test ./... -race -timeout 20m -run Integration

vet:
	go vet ./...

fmt:
	gofmt -s -w .

fmt-check:
	@out=$$(gofmt -s -l .); if [ -n "$$out" ]; then echo "gofmt -s needed:"; echo "$$out"; exit 1; fi

tidy:
	go mod tidy

clean:
	rm -rf $(DIST)

# Pre-pull the pinned test images so the first integration run does not race the
# container start timeouts.
containers:
	finch pull valkey/valkey:9.1-alpine
	finch pull amazon/dynamodb-local:2.5.2
	finch pull tinkerpop/gremlin-server:3.7.3
