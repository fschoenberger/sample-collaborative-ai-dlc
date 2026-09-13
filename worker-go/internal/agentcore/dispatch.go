// Package agentcore implements the AgentCore Runtime container contract: the
// invocation dispatcher, the /ping health tracker and the HTTP server.
//
// The dispatcher is pure of HTTP — handlers are injected — so it is unit-tested
// without a socket. The worker loop dispatches through the same code path the
// HTTP server uses, which is what stops placement on EC2 and placement in an
// AgentCore session from diverging.
package agentcore

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/aws-samples/sample-collaborative-ai-dlc/worker-go/internal/command"
)

// timeFormat matches JavaScript's Date#toISOString, which is what the
// orchestrator has always seen in the `at` field.
const timeFormat = "2006-01-02T15:04:05.000Z"

// A Binding names a credential provider and where it came from.
type Binding struct {
	Provider string `json:"provider"`
	Source   string `json:"source"`
	UserID   string `json:"userId,omitempty"`
}

// An Invocation is the credential context a command receives when it declares
// an auth mode: an environment clone holding only the selected provider's
// secret, and which bindings did and did not resolve.
type Invocation struct {
	Env                       map[string]string
	AvailableCLIs             []string
	CredentialBindings        []Binding
	ResolvedProviders         []string
	MissingProviders          []string
	MissingCredentialBindings []Binding
}

// A Handler runs one command. Its result is merged into the response body; an
// error becomes HTTP 500 carrying the error's message.
type Handler func(ctx context.Context, payload Document, inv Invocation) (any, error)

// Handlers maps the handler names in the command registry to implementations.
type Handlers map[string]Handler

// A PrepareFunc resolves agent credentials for a command that declares a mode.
type PrepareFunc func(ctx context.Context, payload Document, mode command.AuthMode) (Invocation, error)

// A Response is a dispatched invocation's HTTP result.
type Response struct {
	StatusCode int
	Body       json.RawMessage
}

// A Dispatcher routes parsed invocations to command handlers.
type Dispatcher struct {
	Handlers Handlers
	// Busy flips /ping to HealthyBusy for the invocation's duration. Nil when
	// the caller holds the tracker at a wider scope, as the worker loop does for
	// a whole job.
	Busy *BusyTracker
	// Prepare resolves credentials for commands declaring an auth mode. Nil
	// skips resolution, which would leave every authenticated stage
	// unauthenticated.
	Prepare PrepareFunc
	// Now defaults to time.Now.
	Now func() time.Time
}

func (d *Dispatcher) now() time.Time {
	if d.Now == nil {
		return time.Now()
	}
	return d.Now()
}

// Dispatch routes one parsed invocation to its handler.
func (d *Dispatcher) Dispatch(ctx context.Context, payload Document) Response {
	name, ok := payload.String("command")
	if !ok || name == "" {
		return errorResponse(400, `missing "command"`, "")
	}

	var handler Handler
	def, known := command.Lookup(name)
	if known {
		handler = d.Handlers[def.Handler]
	}
	if handler == nil {
		return errorResponse(400, fmt.Sprintf("unknown command %q", name), "")
	}

	d.Busy.Enter()
	defer d.Busy.Leave()

	var inv Invocation
	if d.Prepare != nil && def.AgentAuth != command.AuthNone {
		var err error
		if inv, err = d.Prepare(ctx, payload, def.AgentAuth); err != nil {
			return errorResponse(500, err.Error(), name)
		}
	}

	// The grant authorized the credentials that Prepare already redeemed; it is
	// not the handler's business and must not travel further.
	args := payload.Clone()
	delete(args, "agentCredentialGrant")

	result, err := handler(ctx, args, inv)
	if err != nil {
		return errorResponse(500, err.Error(), name)
	}

	body, err := responseBody(result, name, d.now())
	if err != nil {
		return errorResponse(500, err.Error(), name)
	}
	// Command-level failures are part of the application protocol and stay on
	// HTTP 200, so Bedrock AgentCore returns the JSON body to the orchestrator
	// instead of turning the response into an SDK transport exception.
	return Response{StatusCode: 200, Body: body}
}

// responseBody merges a handler's result with the routing fields the
// orchestrator reads back.
func responseBody(result any, name string, at time.Time) (json.RawMessage, error) {
	fields := Document{}
	if result != nil {
		raw, err := json.Marshal(result)
		if err != nil {
			return nil, err
		}
		if err := json.Unmarshal(raw, &fields); err != nil {
			return nil, fmt.Errorf("command result is not a JSON object: %w", err)
		}
	}
	if err := fields.Set("command", name); err != nil {
		return nil, err
	}
	if err := fields.Set("at", at.UTC().Format(timeFormat)); err != nil {
		return nil, err
	}
	return json.Marshal(fields)
}

func errorResponse(status int, message, name string) Response {
	body := struct {
		Error   string `json:"error"`
		Command string `json:"command,omitempty"`
	}{Error: message, Command: name}
	raw, err := json.Marshal(body)
	if err != nil {
		// A struct of two strings cannot fail to marshal.
		panic(err)
	}
	return Response{StatusCode: status, Body: raw}
}
