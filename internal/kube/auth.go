package kube

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"

	"podcave/internal/events"
)

const (
	execTimeout   = 10 * time.Minute
	refreshMargin = 2 * time.Minute
	maxStdout     = 1 << 20
)

// AuthError marks failures to obtain credentials so the UI can raise the Cave Signal.
type AuthError struct {
	Msg        string
	NeedsLogin bool
}

func (e *AuthError) Error() string { return e.Msg }

type clusterInfo struct {
	Server                   string `json:"server"`
	TLSServerName            string `json:"tls-server-name,omitempty"`
	InsecureSkipTLSVerify    bool   `json:"insecure-skip-tls-verify,omitempty"`
	CertificateAuthorityData []byte `json:"certificate-authority-data,omitempty"`
	ProxyURL                 string `json:"proxy-url,omitempty"`
}

type execCredential struct {
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`
	Spec       struct {
		Cluster     *clusterInfo `json:"cluster,omitempty"`
		Interactive bool         `json:"interactive"`
	} `json:"spec"`
	Status *struct {
		Token                 string     `json:"token"`
		ExpirationTimestamp   *time.Time `json:"expirationTimestamp,omitempty"`
		ClientCertificateData string     `json:"clientCertificateData,omitempty"`
	} `json:"status,omitempty"`
}

// execAuth replaces client-go's exec plugin runner so that plugin prompts
// (e.g. kubelogin device codes) can be surfaced in the UI instead of a hidden console.
type execAuth struct {
	ctxID   string
	cfg     clientcmdapi.ExecConfig
	cluster *clusterInfo
	hub     *events.Hub

	mu       sync.Mutex
	token    string
	expiry   time.Time
	inflight *tokenCall
}

type tokenCall struct {
	done  chan struct{}
	token string
	err   error
}

func newExecAuth(ctxID string, cfg clientcmdapi.ExecConfig, cluster *clusterInfo, hub *events.Hub) *execAuth {
	if !cfg.ProvideClusterInfo {
		cluster = nil
	}
	return &execAuth{ctxID: ctxID, cfg: cfg, cluster: cluster, hub: hub}
}

func (a *execAuth) Token(ctx context.Context) (string, error) {
	a.mu.Lock()
	if a.token != "" && (a.expiry.IsZero() || time.Until(a.expiry) > refreshMargin) {
		t := a.token
		a.mu.Unlock()
		return t, nil
	}
	call := a.inflight
	if call == nil {
		call = &tokenCall{done: make(chan struct{})}
		a.inflight = call
		go a.refresh(call)
	}
	a.mu.Unlock()
	select {
	case <-call.done:
		return call.token, call.err
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

// Invalidate drops the cached token if it is still the one that was rejected.
func (a *execAuth) Invalidate(rejected string) {
	a.mu.Lock()
	if rejected == "" || a.token == rejected {
		a.token = ""
		a.expiry = time.Time{}
	}
	a.mu.Unlock()
}

func (a *execAuth) refresh(call *tokenCall) {
	tok, exp, err := a.run()
	a.mu.Lock()
	if err == nil {
		a.token, a.expiry = tok, exp
	}
	a.inflight = nil
	a.mu.Unlock()
	call.token, call.err = tok, err
	close(call.done)
	if err == nil {
		a.hub.PublishAuth(a.ctxID, events.AuthOK, "", "", "")
	}
}

var (
	urlRe  = regexp.MustCompile(`https://[^\s"'<>]+`)
	codeRe = regexp.MustCompile(`(?i)enter the code\s+([A-Z0-9-]{4,20})`)
)

// parseDeviceCode extracts the verification URL and user code from a
// device-code prompt such as the ones printed by kubelogin and az login.
func parseDeviceCode(line string) (url, code string, ok bool) {
	m := codeRe.FindStringSubmatch(line)
	if m == nil {
		return "", "", false
	}
	u := urlRe.FindString(line)
	return strings.TrimRight(u, ".,;)"), strings.ToUpper(m[1]), true
}

func (a *execAuth) run() (string, time.Time, error) {
	ctx, cancel := context.WithTimeout(context.Background(), execTimeout)
	defer cancel()

	info := execCredential{APIVersion: a.cfg.APIVersion, Kind: "ExecCredential"}
	info.Spec.Cluster = a.cluster
	infoJSON, _ := json.Marshal(info)

	cmd := exec.CommandContext(ctx, a.cfg.Command, a.cfg.Args...)
	cmd.Env = os.Environ()
	for _, e := range a.cfg.Env {
		cmd.Env = append(cmd.Env, e.Name+"="+e.Value)
	}
	cmd.Env = append(cmd.Env, "KUBERNETES_EXEC_INFO="+string(infoJSON))
	hideWindow(cmd)

	var stdout limitedBuffer
	stdout.limit = maxStdout
	cmd.Stdout = &stdout
	stderrR, stderrW := io.Pipe()
	cmd.Stderr = stderrW

	var stderrTail tailBuffer
	var sawPrompt atomic.Bool
	stderrDone := make(chan struct{})
	go func() {
		defer close(stderrDone)
		sc := bufio.NewScanner(stderrR)
		sc.Buffer(make([]byte, 64<<10), 64<<10)
		for sc.Scan() {
			line := sc.Text()
			stderrTail.add(line)
			if u, c, ok := parseDeviceCode(line); ok {
				sawPrompt.Store(true)
				a.hub.PublishAuth(a.ctxID, events.AuthDeviceCode, "Sign in to continue: "+displayCommand(a.cfg.Command), u, c)
			}
		}
		_, _ = io.Copy(io.Discard, stderrR)
	}()

	// Only announce "waiting" if no device-code prompt is on screen; never hide the code.
	slow := time.AfterFunc(3*time.Second, func() {
		if !sawPrompt.Load() {
			a.hub.PublishAuth(a.ctxID, events.AuthPending, "Waiting for "+displayCommand(a.cfg.Command)+" to provide a token…", "", "")
		}
	})
	err := cmd.Start()
	if err == nil {
		err = cmd.Wait()
	}
	slow.Stop()
	stderrW.Close()
	<-stderrDone

	if err != nil {
		return "", time.Time{}, a.fail(err, stderrTail.String())
	}
	var cred execCredential
	if err := json.Unmarshal(stdout.Bytes(), &cred); err != nil || cred.Status == nil {
		return "", time.Time{}, a.fail(errors.New("credential plugin returned invalid output"), stderrTail.String())
	}
	if cred.Status.Token == "" {
		if cred.Status.ClientCertificateData != "" {
			return "", time.Time{}, a.fail(errors.New("credential plugins that return client certificates are not supported"), "")
		}
		return "", time.Time{}, a.fail(errors.New("credential plugin returned an empty token"), stderrTail.String())
	}
	var exp time.Time
	if cred.Status.ExpirationTimestamp != nil {
		exp = *cred.Status.ExpirationTimestamp
	}
	return cred.Status.Token, exp, nil
}

func (a *execAuth) fail(err error, stderr string) error {
	msg := err.Error()
	var execErr *exec.Error
	if errors.As(err, &execErr) {
		msg = fmt.Sprintf("%q was not found on PATH", a.cfg.Command)
		if a.cfg.InstallHint != "" {
			msg += ". " + strings.TrimSpace(a.cfg.InstallHint)
		}
	}
	if s := strings.TrimSpace(stderr); s != "" {
		msg += ": " + s
	}
	if len(msg) > 800 {
		msg = msg[:800] + "…"
	}
	needs := looksLikeLoginNeeded(stderr)
	state := events.AuthError
	if needs {
		state = events.AuthNeedsLogin
	}
	a.hub.PublishAuth(a.ctxID, state, msg, "", "")
	return &AuthError{Msg: msg, NeedsLogin: needs}
}

func looksLikeLoginNeeded(s string) bool {
	s = strings.ToLower(s)
	for _, k := range []string{"az login", "aadsts", "interaction_required", "refresh token", "expired", "re-authenticate", "reauthenticate", "not logged in", "please login", "please run"} {
		if strings.Contains(s, k) {
			return true
		}
	}
	return false
}

func displayCommand(cmd string) string {
	return strings.TrimSuffix(filepath.Base(cmd), ".exe")
}

// LoginMode reports the kubelogin --login mode (azurecli, devicecode, interactive, ...), if any.
func loginMode(cfg *clientcmdapi.ExecConfig) string {
	if cfg == nil {
		return ""
	}
	for i, arg := range cfg.Args {
		switch {
		case (arg == "--login" || arg == "-l") && i+1 < len(cfg.Args):
			return cfg.Args[i+1]
		case strings.HasPrefix(arg, "--login="):
			return strings.TrimPrefix(arg, "--login=")
		}
	}
	for _, e := range cfg.Env {
		if e.Name == "AAD_LOGIN_METHOD" {
			return e.Value
		}
	}
	if displayCommand(cfg.Command) == "kubelogin" {
		return "devicecode"
	}
	return ""
}

var tenantRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.-]{0,99}$`)

func tenantID(cfg *clientcmdapi.ExecConfig) string {
	if cfg == nil {
		return ""
	}
	for i, arg := range cfg.Args {
		var v string
		switch {
		case (arg == "--tenant-id" || arg == "-t") && i+1 < len(cfg.Args):
			v = cfg.Args[i+1]
		case strings.HasPrefix(arg, "--tenant-id="):
			v = strings.TrimPrefix(arg, "--tenant-id=")
		}
		if v != "" && tenantRe.MatchString(v) {
			return v
		}
	}
	return ""
}

// authRoundTripper injects the exec-plugin bearer token and retries once with
// a fresh token when the API server answers 401 (expired/revoked token).
type authRoundTripper struct {
	auth *execAuth
	base http.RoundTripper
}

func (t *authRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	tok, err := t.auth.Token(req.Context())
	if err != nil {
		return nil, err
	}
	r := req.Clone(req.Context())
	r.Header.Set("Authorization", "Bearer "+tok)
	resp, err := t.base.RoundTrip(r)
	if err != nil || resp.StatusCode != http.StatusUnauthorized {
		return resp, err
	}
	if req.Body != nil && req.GetBody == nil {
		return resp, nil
	}
	t.auth.Invalidate(tok)
	fresh, ferr := t.auth.Token(req.Context())
	if ferr != nil || fresh == tok {
		return resp, nil
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	resp.Body.Close()
	r2 := req.Clone(req.Context())
	if req.GetBody != nil {
		body, err := req.GetBody()
		if err != nil {
			return nil, err
		}
		r2.Body = body
	}
	r2.Header.Set("Authorization", "Bearer "+fresh)
	return t.base.RoundTrip(r2)
}

type limitedBuffer struct {
	bytes.Buffer
	limit int
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if b.Len()+len(p) > b.limit {
		return 0, errors.New("credential plugin output too large")
	}
	return b.Buffer.Write(p)
}

type tailBuffer struct {
	mu    sync.Mutex
	lines []string
}

func (t *tailBuffer) add(l string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.lines = append(t.lines, l)
	if len(t.lines) > 15 {
		t.lines = t.lines[len(t.lines)-15:]
	}
}

func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return strings.Join(t.lines, "\n")
}
