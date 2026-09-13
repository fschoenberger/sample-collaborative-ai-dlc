package worker

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// IMDSBase is the link-local instance metadata endpoint.
const IMDSBase = "http://169.254.169.254"

// IMDS reads an EC2 worker's identity from IMDSv2.
//
// A worker's identity is its own instance ID. That is why the launch template can
// be identical for every worker of a revision: no per-instance user-data and no
// tag lookup is needed for a worker to know who it is, which is what lets the
// template be pinned per revision.
//
// The zero value queries the real endpoint with http.DefaultClient.
type IMDS struct {
	Base   string
	Client *http.Client
}

func (m IMDS) base() string {
	if m.Base == "" {
		return IMDSBase
	}
	return m.Base
}

func (m IMDS) client() *http.Client {
	if m.Client == nil {
		return http.DefaultClient
	}
	return m.Client
}

// InstanceID fetches an IMDSv2 token and reads this instance's ID with it.
func (m IMDS) InstanceID(ctx context.Context) (string, error) {
	token, err := m.get(ctx, http.MethodPut, "/latest/api/token",
		"x-aws-ec2-metadata-token-ttl-seconds", "60", "token")
	if err != nil {
		return "", err
	}
	return m.get(ctx, http.MethodGet, "/latest/meta-data/instance-id",
		"x-aws-ec2-metadata-token", token, "instance-id")
}

func (m IMDS) get(ctx context.Context, method, path, header, value, what string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, method, m.base()+path, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set(header, value)

	response, err := m.client().Do(req)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()

	if response.StatusCode < 200 || response.StatusCode > 299 {
		return "", fmt.Errorf("IMDS %s request failed: %d", what, response.StatusCode)
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(body)), nil
}
