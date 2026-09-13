// Package command is the single source of truth for AgentCore invocation
// routing and authentication.
//
// Engine-only commands keep AuthNone so they remain available during
// credential-store outages. CLI-consuming commands select the binding strategy
// the invocation-scoped auth resolver must use.
package command

// AuthMode selects the credential binding strategy for an invocation.
type AuthMode string

const (
	AuthNone         AuthMode = ""
	AuthExecution    AuthMode = "execution"
	AuthCapabilities AuthMode = "capabilities"
	AuthCompose      AuthMode = "compose"
	AuthDiscussion   AuthMode = "discussion"
)

// AuthModes are the real modes, in declaration order. These double as the
// agent-credential grant purposes.
var AuthModes = []AuthMode{AuthExecution, AuthCapabilities, AuthCompose, AuthDiscussion}

// Definition routes one command to its handler and declares whether the
// invocation needs agent credentials resolved first.
type Definition struct {
	Handler   string
	AgentAuth AuthMode
}

var definitions = map[string]Definition{
	"init-ws":                    {Handler: "initWs"},
	"run-stage":                  {Handler: "runStage", AgentAuth: AuthExecution},
	"run-stage-start":            {Handler: "runStageStart", AgentAuth: AuthExecution},
	"promote-units":              {Handler: "promoteUnits"},
	"derive-artifacts":           {Handler: "deriveArtifacts", AgentAuth: AuthExecution},
	"create-workflow-checkpoint": {Handler: "createWorkflowCheckpoint"},
	"record-pr":                  {Handler: "recordPr"},
	"record-unit-pr":             {Handler: "recordUnitPr"},
	"init-lane":                  {Handler: "initLane"},
	"merge-lane":                 {Handler: "mergeLane"},
	"reconcile-lane":             {Handler: "reconcileLane"},
	"refresh-intent":             {Handler: "refreshIntent"},
	"resolve-conflict":           {Handler: "resolveConflict", AgentAuth: AuthExecution},
	"discussion-assist-start":    {Handler: "discussionAssistStart", AgentAuth: AuthDiscussion},
	"compose-plan-start":         {Handler: "composePlanStart", AgentAuth: AuthCompose},
	"quorum-edit-plan-start":     {Handler: "quorumEditPlanStart", AgentAuth: AuthExecution},
	"quorum-edit-apply-start":    {Handler: "quorumEditApplyStart", AgentAuth: AuthExecution},
	"repair-structure":           {Handler: "repairStructure", AgentAuth: AuthExecution},
	"inspect":                    {Handler: "inspect"},
	"capabilities":               {Handler: "capabilities", AgentAuth: AuthCapabilities},
	"managed-runtime-check":      {Handler: "managedRuntimeCheck"},
	"verify-mcp":                 {Handler: "verifyMcp"},
}

// Lookup returns the definition for name. The second result is false for an
// unknown command, which callers treat as a version skew between the
// orchestrator and this image rather than something to run blind.
func Lookup(name string) (Definition, bool) {
	def, ok := definitions[name]
	return def, ok
}

// Names returns every registered command name. Order is unspecified.
func Names() []string {
	names := make([]string, 0, len(definitions))
	for name := range definitions {
		names = append(names, name)
	}
	return names
}
