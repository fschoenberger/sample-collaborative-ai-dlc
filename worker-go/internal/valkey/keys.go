// Package valkey holds the scheduler's Valkey key layout, connection and fleet
// registry.
//
// CLUSTER MODE IS NOT OPTIONAL. ElastiCache Serverless for Valkey is always
// cluster-mode-enabled behind a single endpoint, so any command touching more
// than one key — MULTI, Lua, ZADD+HSET pairs — fails with CROSSSLOT unless the
// keys hash to the same slot. Slots are computed over the substring inside the
// first "{...}" if one is present, so every key here carries a hash tag naming
// the entity it belongs to.
//
// The three tag families and what they guarantee can be done atomically:
//
//	{w:<workerID>}  worker meta + that worker's addressed stream
//	                → claiming, lease renewal and addressed dispatch are atomic.
//	{e:<envID>}     the environment's unassigned queue + its idle set + counters
//	                → enqueue, capacity checks and idle bookkeeping are atomic.
//	{j:<jobID>}     job meta
//	                → a job's own fields are atomic.
//
// What is deliberately NOT atomic, because it spans tags: moving a worker
// between the idle set ({e:…}) and its own state ({w:…}). Those are separate
// commands, and a crash between them leaves the registry briefly wrong. That is
// tolerable precisely because Valkey is not the system of record here — the
// durable orchestrator owns attempt lifecycle, EC2 owns instance truth via
// DescribeInstances by tag, and the reconciler rebuilds from both. Never add a
// Lua script that assumes those two are consistent.
package valkey

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/aws-samples/sample-collaborative-ai-dlc/worker-go/internal/errcode"
)

// ConsumerGroup is the one consumer group per environment queue. Workers join
// it as consumers named by their own worker ID, which is what makes the
// pending-entries list a map of "which worker owes which job" — and therefore
// what makes XAUTOCLAIM a lease expiry rather than a guess.
const ConsumerGroup = "workers"

// TagPrefixes are the three tag families every scheduler key lives under, so a
// namespace sweep (ops tooling, a dev reset) can enumerate them without
// touching anything else that might share the cluster.
var TagPrefixes = []string{"{w:", "{e:", "{j:"}

// ErrInvalidKeySegment is returned when an ID cannot form a Valkey key segment.
// IDs come from AWS (instance IDs, session IDs) and our own generators, but they
// also reach here from operator-authored environment IDs. A "{" or "}" in a tag
// would silently repartition the keyspace, so anything unexpected is rejected
// rather than built into a key that half-works.
var ErrInvalidKeySegment = errcode.New("INVALID_KEY_SEGMENT", "invalid Valkey key segment")

var keySegment = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

// Validated key segments. Parsing at the edge is what keeps the key builders
// free of error returns — an ID that exists is already known to be usable.
type (
	WorkerID      string
	EnvironmentID string
	JobID         string
)

func parseSegment(value, label string) error {
	if !keySegment.MatchString(value) {
		return fmt.Errorf("%w: invalid %s for a Valkey key: %q", ErrInvalidKeySegment, label, value)
	}
	return nil
}

func ParseWorkerID(s string) (WorkerID, error) {
	return WorkerID(s), parseSegment(s, "workerId")
}

func ParseEnvironmentID(s string) (EnvironmentID, error) {
	return EnvironmentID(s), parseSegment(s, "environmentId")
}

func ParseJobID(s string) (JobID, error) {
	return JobID(s), parseSegment(s, "jobId")
}

// Worker-scoped keys.

func (id WorkerID) Tag() string       { return "{w:" + string(id) + "}" }
func (id WorkerID) MetaKey() string   { return id.Tag() + ":meta" }
func (id WorkerID) StreamKey() string { return id.Tag() + ":stream" }

// Environment-scoped keys.

func (id EnvironmentID) Tag() string        { return "{e:" + string(id) + "}" }
func (id EnvironmentID) QueueKey() string   { return id.Tag() + ":queue" }
func (id EnvironmentID) IdleKey() string    { return id.Tag() + ":idle" }
func (id EnvironmentID) WorkersKey() string { return id.Tag() + ":workers" }

// Job-scoped keys.

func (id JobID) Tag() string     { return "{j:" + string(id) + "}" }
func (id JobID) MetaKey() string { return id.Tag() + ":meta" }

// HashTag reports the tag a key routes on, or "" when it carries none.
//
// Two keys with the same tag always land in the same slot, which makes this the
// exact test for whether a multi-key command is legal on a cluster — no CRC16
// needed. Used by the key tests to prove co-location statically, since a
// single-node test server cannot reject a cross-slot pipeline.
func HashTag(key string) string {
	open := strings.Index(key, "{")
	if open < 0 {
		return ""
	}
	end := strings.Index(key[open+1:], "}")
	if end < 1 {
		return ""
	}
	return key[open+1 : open+1+end]
}
