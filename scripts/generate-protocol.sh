#!/usr/bin/env sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

if ! command -v protoc >/dev/null 2>&1; then
  echo "protoc is required (tested with 31.1)." >&2
  exit 1
fi
if ! command -v protoc-gen-go >/dev/null 2>&1; then
  echo "protoc-gen-go is required: go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.36.10" >&2
  exit 1
fi

cd "$repository_root"
protoc \
  --proto_path=proto \
  --go_out=services/collector \
  --go_opt=module=github.com/msHamed1/node-flow/services/collector \
  proto/nodeflow/v1/telemetry.proto \
  proto/nodeflow/v1/topology.proto
