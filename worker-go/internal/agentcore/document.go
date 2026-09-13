package agentcore

import "encoding/json"

// A Document is a JSON object whose members are kept raw.
//
// Invocation payloads carry per-command arguments that the dispatcher must pass
// through untouched while reading and setting a few envelope fields of its own.
// Decoding into a struct would drop the unknown members; decoding into
// map[string]any would lose number and precision fidelity on the way back out.
type Document map[string]json.RawMessage

// Clone returns a shallow copy. Members are immutable raw JSON, so callers can
// safely add or remove keys without disturbing the original.
func (d Document) Clone() Document {
	out := make(Document, len(d))
	for k, v := range d {
		out[k] = v
	}
	return out
}

// String decodes a string member, reporting whether it was present and a string.
func (d Document) String(key string) (string, bool) {
	raw, ok := d[key]
	if !ok {
		return "", false
	}
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return "", false
	}
	return s, true
}

// Set marshals v into the named member.
func (d Document) Set(key string, v any) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	d[key] = raw
	return nil
}

// SetRaw stores an already-encoded member.
func (d Document) SetRaw(key string, raw json.RawMessage) { d[key] = raw }
