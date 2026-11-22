package kube

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"

	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"

	"podcave/internal/events"
	"podcave/internal/store"
)

type ContextInfo struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	SourceID   string `json:"sourceId"`
	SourceName string `json:"sourceName"`
	Cluster    string `json:"cluster"`
	Server     string `json:"server"`
	User       string `json:"user"`
	Namespace  string `json:"namespace"`
	AuthType   string `json:"authType"`
	LoginMode  string `json:"loginMode,omitempty"`
	Insecure   bool   `json:"insecure,omitempty"`
	Current    bool   `json:"current,omitempty"`
}

type SourceStatus struct {
	store.Source
	Contexts int    `json:"contexts"`
	Error    string `json:"error,omitempty"`
}

// Cluster is a ready-to-use client for one kubeconfig context.
type Cluster struct {
	Info    ContextInfo
	Rest    *rest.Config
	Client  kubernetes.Interface
	auth    *execAuth
	execCfg *clientcmdapi.ExecConfig
}

type loadedSource struct {
	src     store.Source
	modTime time.Time
	cfg     *clientcmdapi.Config
	err     error
	clients map[string]*Cluster
}

type Manager struct {
	st      *store.Store
	hub     *events.Hub
	version string

	Forwards *Forwards

	mu      sync.Mutex
	sources map[string]*loadedSource
	loginMu sync.Mutex
}

func NewManager(st *store.Store, hub *events.Hub, version string) *Manager {
	return &Manager{st: st, hub: hub, version: version, sources: map[string]*loadedSource{}, Forwards: NewForwards(hub)}
}

// ParseKubeconfig validates kubeconfig bytes and returns the context names.
func ParseKubeconfig(data []byte) ([]string, error) {
	ctxs, err := PreviewKubeconfig(data)
	if err != nil {
		return nil, err
	}
	names := make([]string, len(ctxs))
	for i, c := range ctxs {
		names[i] = c.Name
	}
	return names, nil
}

type ContextPreview struct {
	Name      string `json:"name"`
	Cluster   string `json:"cluster"`
	Server    string `json:"server"`
	Namespace string `json:"namespace,omitempty"`
}

// PreviewKubeconfig lists the contexts in a kubeconfig without saving anything.
func PreviewKubeconfig(data []byte) ([]ContextPreview, error) {
	cfg, err := clientcmd.Load(data)
	if err != nil {
		return nil, fmt.Errorf("not a valid kubeconfig: %w", err)
	}
	if len(cfg.Contexts) == 0 {
		return nil, errors.New("kubeconfig has no contexts")
	}
	out := make([]ContextPreview, 0, len(cfg.Contexts))
	for name, c := range cfg.Contexts {
		p := ContextPreview{Name: name, Cluster: c.Cluster, Namespace: c.Namespace}
		if cl := cfg.Clusters[c.Cluster]; cl != nil {
			p.Server = cl.Server
		}
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// refreshLocked syncs loaded sources with the store, reloading changed files.
func (m *Manager) refreshLocked() {
	seen := map[string]bool{}
	for _, src := range m.st.Sources() {
		seen[src.ID] = true
		ls := m.sources[src.ID]
		var mod time.Time
		if src.Kind == store.KindFile {
			mod = store.FileModTime(src.Path)
		}
		if ls != nil && ls.src == src && ls.modTime.Equal(mod) && ls.err == nil {
			continue
		}
		m.sources[src.ID] = m.load(src, mod)
	}
	for id := range m.sources {
		if !seen[id] {
			delete(m.sources, id)
		}
	}
}

func (m *Manager) load(src store.Source, mod time.Time) *loadedSource {
	ls := &loadedSource{src: src, modTime: mod, clients: map[string]*Cluster{}}
	data, err := m.st.Read(src)
	if err != nil {
		ls.err = err
		return ls
	}
	cfg, err := clientcmd.Load(data)
	if err != nil {
		ls.err = fmt.Errorf("not a valid kubeconfig: %w", err)
		return ls
	}
	if src.Kind == store.KindFile {
		// Relative cert/exec paths in a linked file are relative to that file, like kubectl.
		for _, c := range cfg.Clusters {
			c.LocationOfOrigin = src.Path
		}
		for _, a := range cfg.AuthInfos {
			a.LocationOfOrigin = src.Path
		}
		if err := clientcmd.ResolveLocalPaths(cfg); err != nil {
			ls.err = err
			return ls
		}
	}
	ls.cfg = cfg
	return ls
}

func (m *Manager) Contexts() ([]ContextInfo, []SourceStatus) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.refreshLocked()
	var out []ContextInfo
	var statuses []SourceStatus
	for _, src := range m.st.Sources() {
		ls := m.sources[src.ID]
		st := SourceStatus{Source: src}
		if ls == nil || ls.err != nil {
			if ls != nil {
				st.Error = ls.err.Error()
			}
			statuses = append(statuses, st)
			continue
		}
		names := make([]string, 0, len(ls.cfg.Contexts))
		for n := range ls.cfg.Contexts {
			names = append(names, n)
		}
		sort.Strings(names)
		st.Contexts = len(names)
		statuses = append(statuses, st)
		for _, n := range names {
			out = append(out, describeContext(src, ls.cfg, n))
		}
	}
	return out, statuses
}

func describeContext(src store.Source, cfg *clientcmdapi.Config, name string) ContextInfo {
	c := cfg.Contexts[name]
	info := ContextInfo{
		ID: src.ID + "/" + name, Name: name, SourceID: src.ID, SourceName: src.Name,
		Cluster: c.Cluster, User: c.AuthInfo, Namespace: c.Namespace, AuthType: "none", Current: cfg.CurrentContext == name,
	}
	if info.Namespace == "" {
		info.Namespace = "default"
	}
	if cl := cfg.Clusters[c.Cluster]; cl != nil {
		info.Server = cl.Server
		info.Insecure = cl.InsecureSkipTLSVerify
	}
	if a := cfg.AuthInfos[c.AuthInfo]; a != nil {
		switch {
		case a.Exec != nil:
			info.AuthType = "exec"
			if displayCommand(a.Exec.Command) == "kubelogin" {
				info.AuthType = "kubelogin"
			}
			info.LoginMode = loginMode(a.Exec)
		case a.AuthProvider != nil:
			info.AuthType = "auth-provider:" + a.AuthProvider.Name
		case a.Token != "" || a.TokenFile != "":
			info.AuthType = "token"
		case len(a.ClientCertificateData) > 0 || a.ClientCertificate != "":
			info.AuthType = "certificate"
		case a.Username != "":
			info.AuthType = "basic"
		}
	}
	return info
}

// Cluster returns (and caches) a client for the given context ID.
func (m *Manager) Cluster(ctxID string) (*Cluster, error) {
	srcID, name, ok := strings.Cut(ctxID, "/")
	if !ok {
		return nil, errors.New("invalid context id")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.refreshLocked()
	ls := m.sources[srcID]
	if ls == nil {
		return nil, errors.New("kubeconfig not found")
	}
	if ls.err != nil {
		return nil, ls.err
	}
	if cl := ls.clients[name]; cl != nil {
		return cl, nil
	}
	if _, ok := ls.cfg.Contexts[name]; !ok {
		return nil, errors.New("context not found")
	}
	cl, err := m.build(ls, name)
	if err != nil {
		return nil, err
	}
	ls.clients[name] = cl
	return cl, nil
}

func (m *Manager) build(ls *loadedSource, name string) (*Cluster, error) {
	info := describeContext(ls.src, ls.cfg, name)
	if strings.HasPrefix(info.AuthType, "auth-provider:azure") {
		return nil, errors.New(`this context uses the removed "azure" auth-provider; run "kubelogin convert-kubeconfig -l azurecli" on the kubeconfig and reload`)
	}
	cc := clientcmd.NewNonInteractiveClientConfig(*ls.cfg, name, &clientcmd.ConfigOverrides{}, nil)
	rc, err := cc.ClientConfig()
	if err != nil {
		return nil, err
	}
	rc.UserAgent = "pod-cave/" + m.version
	rc.QPS, rc.Burst = 50, 100
	cl := &Cluster{Info: info}
	if rc.ExecProvider != nil {
		execCfg := *rc.ExecProvider
		cl.execCfg = &execCfg
		ci := &clusterInfo{
			Server: rc.Host, TLSServerName: rc.TLSClientConfig.ServerName,
			InsecureSkipTLSVerify: rc.TLSClientConfig.Insecure, CertificateAuthorityData: rc.TLSClientConfig.CAData,
		}
		if len(ci.CertificateAuthorityData) == 0 && rc.TLSClientConfig.CAFile != "" {
			ci.CertificateAuthorityData, _ = os.ReadFile(rc.TLSClientConfig.CAFile)
		}
		cl.auth = newExecAuth(info.ID, execCfg, ci, m.hub)
		rc.ExecProvider = nil
		auth := cl.auth
		rc.WrapTransport = func(rt http.RoundTripper) http.RoundTripper {
			return &authRoundTripper{auth: auth, base: rt}
		}
	}
	cs, err := kubernetes.NewForConfig(rc)
	if err != nil {
		return nil, err
	}
	cl.Rest, cl.Client = rc, cs
	return cl, nil
}

// Login re-authenticates a context. method: "retry", "az-browser" or "az-devicecode".
// It runs asynchronously; progress is reported through the events hub.
func (m *Manager) Login(ctxID, method string) error {
	cl, err := m.Cluster(ctxID)
	if err != nil {
		return err
	}
	if cl.auth == nil {
		return errors.New("this context does not use a login plugin; nothing to re-authenticate")
	}
	switch method {
	case "retry":
		go m.retryToken(cl)
		return nil
	case "az-browser", "az-devicecode":
		az, err := exec.LookPath("az")
		if err != nil {
			return errors.New("Azure CLI (az) was not found on PATH")
		}
		if !m.loginMu.TryLock() {
			return errors.New("a login is already in progress")
		}
		args := []string{"login", "--only-show-errors", "--output", "none"}
		if method == "az-devicecode" {
			args = append(args, "--use-device-code")
		}
		if t := tenantID(cl.execCfg); t != "" {
			args = append(args, "--tenant", t)
		}
		go func() {
			defer m.loginMu.Unlock()
			m.runAzLogin(cl, az, args)
		}()
		return nil
	default:
		return errors.New("unknown login method")
	}
}

func (m *Manager) retryToken(cl *Cluster) {
	cl.auth.Invalidate("")
	ctx, cancel := context.WithTimeout(context.Background(), execTimeout)
	defer cancel()
	_, _ = cl.auth.Token(ctx)
}

func (m *Manager) runAzLogin(cl *Cluster, az string, args []string) {
	id := cl.Info.ID
	m.hub.PublishAuth(id, events.AuthPending, "Azure sign-in started. Complete it in the browser window that opened.", "", "")
	ctx, cancel := context.WithTimeout(context.Background(), execTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, az, args...)
	// Disable the interactive subscription picker; there is no console to answer it.
	cmd.Env = append(os.Environ(), "AZURE_CORE_LOGIN_EXPERIENCE_V2=off")
	hideWindow(cmd)
	var tail tailBuffer
	w := &lineWriter{fn: func(line string) {
		tail.add(line)
		if u, c, ok := parseDeviceCode(line); ok {
			m.hub.PublishAuth(id, events.AuthDeviceCode, "Sign in with Azure CLI", u, c)
		}
	}}
	cmd.Stdout, cmd.Stderr = w, w
	err := cmd.Run()
	w.flush()
	if err != nil {
		msg := "az login failed"
		if s := strings.TrimSpace(tail.String()); s != "" {
			msg += ": " + s
		}
		m.hub.PublishAuth(id, events.AuthNeedsLogin, msg, "", "")
		return
	}
	m.retryToken(cl)
}

type lineWriter struct {
	mu  sync.Mutex
	buf []byte
	fn  func(string)
}

func (w *lineWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.buf = append(w.buf, p...)
	for {
		i := strings.IndexByte(string(w.buf), '\n')
		if i < 0 {
			break
		}
		w.fn(strings.TrimRight(string(w.buf[:i]), "\r"))
		w.buf = w.buf[i+1:]
	}
	if len(w.buf) > 64<<10 {
		w.fn(string(w.buf))
		w.buf = nil
	}
	return len(p), nil
}

func (w *lineWriter) flush() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.buf) > 0 {
		w.fn(string(w.buf))
		w.buf = nil
	}
}

// IsAuthError reports whether err came from credential acquisition.
func IsAuthError(err error) bool {
	var ae *AuthError
	return errors.As(err, &ae)
}
