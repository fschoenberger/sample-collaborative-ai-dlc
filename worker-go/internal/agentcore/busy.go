package agentcore

import "sync/atomic"

// Health values reported by GET /ping.
const (
	Healthy     = "Healthy"
	HealthyBusy = "HealthyBusy"
)

// A BusyTracker counts stages in flight so /ping can answer HealthyBusy, which
// is what keeps the AgentCore runtime session alive while a stage runs for many
// minutes. The worker loop holds it for a whole job rather than per request.
//
// The zero value is ready to use. A nil *BusyTracker is a working no-op, for
// callers that already hold the tracker at a wider scope.
type BusyTracker struct{ inFlight atomic.Int64 }

func (b *BusyTracker) Enter() {
	if b == nil {
		return
	}
	b.inFlight.Add(1)
}

func (b *BusyTracker) Leave() {
	if b == nil {
		return
	}
	// Clamped at zero: an unbalanced Leave must not make a busy tracker report
	// idle once the count goes negative.
	for {
		n := b.inFlight.Load()
		if n <= 0 {
			return
		}
		if b.inFlight.CompareAndSwap(n, n-1) {
			return
		}
	}
}

func (b *BusyTracker) Status() string {
	if b == nil || b.inFlight.Load() <= 0 {
		return Healthy
	}
	return HealthyBusy
}
