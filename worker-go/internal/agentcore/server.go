package agentcore

// Bedrock AgentCore Runtime requires a container listening on 0.0.0.0:8080 that
// serves:
//
//	GET  /ping         → 200 {status, time_of_last_update}, where status is
//	                     HealthyBusy while a stage runs so the runtime keeps the
//	                     session alive (a stage can take many minutes).
//	POST /invocations  → run a command; JSON in, JSON out.
//
// The same session ID routes to the same microVM, so the git checkout from
// init-ws persists across run-stage invocations — that is how filesystem state
// survives between stages without our own pool or lease machinery.

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"
)

// Addr is the address the AgentCore runtime contract requires.
const Addr = "0.0.0.0:8080"

// NewServer wires the dispatcher into the runtime's HTTP contract.
func NewServer(d *Dispatcher) *http.Server {
	return &http.Server{
		Addr:    Addr,
		Handler: NewHandler(d),
		// A stage runs for many minutes inside POST /invocations, so there is no
		// write or overall timeout to impose here; the orchestrator's callback
		// heartbeat is what bounds a stage.
		ReadHeaderTimeout: 30 * time.Second,
	}
}

// NewHandler serves the runtime contract.
//
// Routes are matched on the exact request URI rather than through a ServeMux:
// the runtime calls these two paths and nothing else, and a mux would silently
// accept "/ping?x=1" and path variants the original answered with 404.
func NewHandler(d *Dispatcher) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.RequestURI == "/ping":
			writeJSON(w, 200, pingBody{
				Status: d.Busy.Status(),
				// Seconds, as the runtime's health contract expects.
				TimeOfLastUpdate: d.now().Unix(),
			})

		case r.Method == http.MethodPost && r.RequestURI == "/invocations":
			payload, err := readDocument(r.Body)
			if err != nil {
				writeJSON(w, 400, map[string]string{"error": err.Error()})
				return
			}
			response := d.Dispatch(r.Context(), payload)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(response.StatusCode)
			_, _ = w.Write(response.Body)

		default:
			writeJSON(w, 404, map[string]string{"error": "not found"})
		}
	})
}

type pingBody struct {
	Status           string `json:"status"`
	TimeOfLastUpdate int64  `json:"time_of_last_update"`
}

// readDocument parses the invocation body. An empty body is an empty document,
// which the dispatcher then rejects for carrying no command.
func readDocument(body io.Reader) (Document, error) {
	raw, err := io.ReadAll(body)
	if err != nil {
		return nil, err
	}
	if len(raw) == 0 {
		return Document{}, nil
	}
	var payload Document
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, errInvalidJSONBody
	}
	return payload, nil
}

var errInvalidJSONBody = errors.New("invalid JSON body")

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
