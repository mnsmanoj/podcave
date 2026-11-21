// Package server exposes the Pod Cave UI and JSON API on 127.0.0.1 only.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/util/validation"

	"podcave/internal/events"
	"podcave/internal/kube"
	"podcave/internal/store"
)

const (
	maxBody       = 64 << 10
	maxImportBody = 3 << 20
	maxTailLines  = 50000
	maxReplicas   = 500
)

type Server struct {
	Version string
	Store   *store.Store
	Kube    *kube.Manager
	Hub     *events.Hub
	Web     fs.FS

	tokens   *tokens
	guard    *guard
	armed    atomic.Bool
	dialogMu sync.Mutex
	srv      *http.Server
	ln       net.Listener
}

// Listen binds to loopback only. port 0 picks a random free port.
func (s *Server) Listen(port int) error {
	ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return err
	}
	s.ln = ln
	s.tokens = newTokens()
	s.guard = &guard{port: ln.Addr().(*net.TCPAddr).Port, tokens: s.tokens}
	s.srv = &http.Server{
		Handler:           s.guard.wrap(s.routes()),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    32 << 10,
	}
	return nil
}

func (s *Server) Port() int { return s.guard.port }

// LaunchURL creates a fresh single-use sign-in link for the browser.
func (s *Server) LaunchURL() string {
	return "http://127.0.0.1:" + strconv.Itoa(s.guard.port) + "/#launch=" + s.tokens.NewLaunch()
}

func (s *Server) Serve() error { return s.srv.Serve(s.ln) }

func (s *Server) Shutdown(ctx context.Context) error { return s.srv.Shutdown(ctx) }

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/session", s.handleSession)
	mux.HandleFunc("GET /api/state", s.handleState)
	mux.HandleFunc("POST /api/mode", s.handleMode)
	mux.HandleFunc("GET /api/prefs", s.handleGetPrefs)
	mux.HandleFunc("PUT /api/prefs", s.handlePutPrefs)
	mux.HandleFunc("GET /api/events", s.handleEvents)

	mux.HandleFunc("GET /api/sources/suggest", s.handleSuggest)
	mux.HandleFunc("POST /api/sources/file", s.handleAddFile)
	mux.HandleFunc("POST /api/sources/import", s.handleImport)
	mux.HandleFunc("POST /api/sources/browse", s.handleBrowse)
	mux.HandleFunc("POST /api/sources/rename", s.handleRename)
	mux.HandleFunc("POST /api/sources/remove", s.handleRemove)
	mux.HandleFunc("GET /api/contexts", s.handleContexts)

	mux.HandleFunc("POST /api/auth/login", s.handleLogin)
	mux.HandleFunc("GET /api/namespaces", s.handleNamespaces)
	mux.HandleFunc("GET /api/pods/watch", s.handleWatchPods)
	mux.HandleFunc("GET /api/deployments/watch", s.handleWatchDeployments)
	mux.HandleFunc("GET /api/describe", s.handleDescribe)
	mux.HandleFunc("GET /api/yaml", s.handleYAML)
	mux.HandleFunc("GET /api/logs", s.handleLogs)

	mux.HandleFunc("POST /api/pods/delete", s.handleDeletePod)
	mux.HandleFunc("POST /api/deployments/restart", s.handleRestartDeployment)
	mux.HandleFunc("POST /api/deployments/scale", s.handleScaleDeployment)

	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusNotFound, apiError{Error: "not found"})
	})
	if s.Web != nil {
		mux.Handle("/", staticHandler(s.Web))
	}
	return mux
}

func staticHandler(web fs.FS) http.Handler {
	files := http.FileServerFS(web)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		files.ServeHTTP(w, r)
	})
}

type apiError struct {
	Error       string `json:"error"`
	Code        string `json:"code,omitempty"`
	ClusterAuth bool   `json:"clusterAuth,omitempty"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func badRequest(w http.ResponseWriter, msg string) {
	writeJSON(w, http.StatusBadRequest, apiError{Error: msg})
}

// clusterError maps Kubernetes/auth errors to HTTP responses for the UI.
func clusterError(w http.ResponseWriter, err error) {
	e := apiError{Error: kube.CleanErr(err)}
	status := http.StatusBadGateway
	switch {
	case kube.IsAuthError(err), apierrors.IsUnauthorized(err):
		e.ClusterAuth, e.Code = true, "cluster-auth"
	case apierrors.IsForbidden(err):
		status, e.Code = http.StatusForbidden, "forbidden"
	case apierrors.IsNotFound(err):
		status, e.Code = http.StatusNotFound, "not-found"
	case apierrors.IsConflict(err), apierrors.IsInvalid(err), apierrors.IsBadRequest(err):
		status = http.StatusBadRequest
	case errors.Is(err, context.DeadlineExceeded):
		status, e.Error = http.StatusGatewayTimeout, "the cluster did not respond in time"
	}
	writeJSON(w, status, e)
}

func decode(w http.ResponseWriter, r *http.Request, limit int64, v any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		badRequest(w, "invalid request body")
		return false
	}
	return true
}

func (s *Server) handleSession(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Launch string `json:"launch"`
	}
	if !decode(w, r, maxBody, &req) {
		return
	}
	sess, ok := s.tokens.Exchange(req.Launch)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, apiError{Error: "this launch link was already used or has expired", Code: "launch"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"session": sess})
}

func (s *Server) handleState(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"version": s.Version, "armed": s.armed.Load(), "dataDir": s.Store.Dir()})
}

func (s *Server) handleMode(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Armed bool `json:"armed"`
	}
	if !decode(w, r, maxBody, &req) {
		return
	}
	s.armed.Store(req.Armed)
	s.Hub.Publish(events.Event{Type: "mode", State: strconv.FormatBool(req.Armed)})
	writeJSON(w, http.StatusOK, map[string]bool{"armed": req.Armed})
}

func (s *Server) handleGetPrefs(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_, _ = w.Write(s.Store.Prefs())
}

func (s *Server) handlePutPrefs(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, store.MaxPrefsBytes))
	if err != nil {
		badRequest(w, "preferences too large")
		return
	}
	if err := s.Store.SetPrefs(body); err != nil {
		badRequest(w, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleSuggest(w http.ResponseWriter, r *http.Request) {
	var cands []string
	if kc := os.Getenv("KUBECONFIG"); kc != "" {
		cands = append(cands, filepath.SplitList(kc)...)
	}
	if home, err := os.UserHomeDir(); err == nil {
		cands = append(cands, filepath.Join(home, ".kube", "config"))
	}
	added := map[string]bool{}
	for _, src := range s.Store.Sources() {
		if src.Kind == store.KindFile {
			added[strings.ToLower(src.Path)] = true
		}
	}
	out := []string{}
	seen := map[string]bool{}
	for _, c := range cands {
		c = filepath.Clean(c)
		key := strings.ToLower(c)
		if c == "." || seen[key] || added[key] || !filepath.IsAbs(c) {
			continue
		}
		seen[key] = true
		if fi, err := os.Stat(c); err == nil && fi.Mode().IsRegular() {
			out = append(out, c)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"paths": out})
}

func (s *Server) handleAddFile(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
		Path string `json:"path"`
	}
	if !decode(w, r, maxBody, &req) {
		return
	}
	path := filepath.Clean(strings.Trim(strings.TrimSpace(req.Path), `"`))
	data, err := store.ReadKubeconfigFile(path)
	if err != nil {
		badRequest(w, "cannot read file: "+err.Error())
		return
	}
	if _, err := kube.ParseKubeconfig(data); err != nil {
		badRequest(w, err.Error())
		return
	}
	src, err := s.Store.AddFile(req.Name, path)
	if err != nil {
		badRequest(w, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, src)
}

func (s *Server) handleImport(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name    string `json:"name"`
		Content string `json:"content"`
	}
	if !decode(w, r, maxImportBody, &req) {
		return
	}
	data := []byte(req.Content)
	if len(data) > store.MaxKubeconfigBytes {
		badRequest(w, "kubeconfig is larger than 1 MiB")
		return
	}
	if _, err := kube.ParseKubeconfig(data); err != nil {
		badRequest(w, err.Error())
		return
	}
	src, err := s.Store.AddImported(req.Name, data)
	if err != nil {
		badRequest(w, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, src)
}

func (s *Server) handleBrowse(w http.ResponseWriter, r *http.Request) {
	if !s.dialogMu.TryLock() {
		badRequest(w, "a file dialog is already open")
		return
	}
	defer s.dialogMu.Unlock()
	path, err := openFileDialog(r.Context())
	if err != nil {
		badRequest(w, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"path": path})
}

func (s *Server) handleRename(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if !decode(w, r, maxBody, &req) {
		return
	}
	if err := s.Store.Rename(req.ID, req.Name); err != nil {
		badRequest(w, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleRemove(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if !decode(w, r, maxBody, &req) {
		return
	}
	if err := s.Store.Remove(req.ID); err != nil {
		badRequest(w, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleContexts(w http.ResponseWriter, r *http.Request) {
	ctxs, sources := s.Kube.Contexts()
	if ctxs == nil {
		ctxs = []kube.ContextInfo{}
	}
	if sources == nil {
		sources = []kube.SourceStatus{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"contexts": ctxs, "sources": sources})
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Ctx    string `json:"ctx"`
		Method string `json:"method"`
	}
	if !decode(w, r, maxBody, &req) {
		return
	}
	if err := s.Kube.Login(req.Ctx, req.Method); err != nil {
		badRequest(w, err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]bool{"started": true})
}

// target validates the common ctx/ns/name query parameters.
type target struct {
	cl   *kube.Cluster
	ns   string
	name string
}

func (s *Server) resolve(w http.ResponseWriter, r *http.Request, needName bool) (*target, bool) {
	q := r.URL.Query()
	return s.resolveValues(w, q.Get("ctx"), q.Get("ns"), q.Get("name"), needName)
}

func (s *Server) resolveValues(w http.ResponseWriter, ctxID, ns, name string, needName bool) (*target, bool) {
	if ns != "" && len(validation.IsDNS1123Label(ns)) > 0 {
		badRequest(w, "invalid namespace name")
		return nil, false
	}
	if needName && len(validation.IsDNS1123Subdomain(name)) > 0 {
		badRequest(w, "invalid resource name")
		return nil, false
	}
	if needName && ns == "" {
		badRequest(w, "namespace is required")
		return nil, false
	}
	cl, err := s.Kube.Cluster(ctxID)
	if err != nil {
		badRequest(w, err.Error())
		return nil, false
	}
	return &target{cl: cl, ns: ns, name: name}, true
}

func (s *Server) handleNamespaces(w http.ResponseWriter, r *http.Request) {
	t, ok := s.resolve(w, r, false)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	ns, err := t.cl.Namespaces(ctx)
	if err != nil {
		clusterError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ns)
}

func (s *Server) handleWatchPods(w http.ResponseWriter, r *http.Request) {
	t, ok := s.resolve(w, r, false)
	if !ok {
		return
	}
	if t.ns == "" {
		badRequest(w, "namespace is required")
		return
	}
	sel := r.URL.Query().Get("selector")
	if sel != "" {
		parsed, err := labels.Parse(sel)
		if err != nil {
			badRequest(w, "invalid label selector")
			return
		}
		sel = parsed.String()
	}
	st := newStream(w, r)
	defer st.close()
	_ = t.cl.WatchPods(r.Context(), t.ns, sel, func(e kube.WatchEvent) error { return st.send(e) })
}

func (s *Server) handleWatchDeployments(w http.ResponseWriter, r *http.Request) {
	t, ok := s.resolve(w, r, false)
	if !ok {
		return
	}
	if t.ns == "" {
		badRequest(w, "namespace is required")
		return
	}
	st := newStream(w, r)
	defer st.close()
	_ = t.cl.WatchDeployments(r.Context(), t.ns, func(e kube.WatchEvent) error { return st.send(e) })
}

func kindParam(w http.ResponseWriter, r *http.Request) (string, bool) {
	k := r.URL.Query().Get("kind")
	if k != "pod" && k != "deployment" {
		badRequest(w, "kind must be pod or deployment")
		return "", false
	}
	return k, true
}

func (s *Server) handleDescribe(w http.ResponseWriter, r *http.Request) {
	kind, ok := kindParam(w, r)
	if !ok {
		return
	}
	t, ok := s.resolve(w, r, true)
	if !ok {
		return
	}
	out, err := t.cl.Describe(kind, t.ns, t.name)
	if err != nil {
		clusterError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"text": out})
}

func (s *Server) handleYAML(w http.ResponseWriter, r *http.Request) {
	kind, ok := kindParam(w, r)
	if !ok {
		return
	}
	t, ok := s.resolve(w, r, true)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	out, err := t.cl.YAML(ctx, kind, t.ns, t.name)
	if err != nil {
		clusterError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"text": out})
}

func (s *Server) handleLogs(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	t, ok := s.resolveValues(w, q.Get("ctx"), q.Get("ns"), q.Get("pod"), true)
	if !ok {
		return
	}
	container := q.Get("container")
	if container != "" && len(validation.IsDNS1123Label(container)) > 0 {
		badRequest(w, "invalid container name")
		return
	}
	tail, err := strconv.ParseInt(q.Get("tail"), 10, 64)
	if err != nil || tail <= 0 || tail > maxTailLines {
		tail = maxTailLines
	}
	st := newStream(w, r)
	defer st.close()
	_ = t.cl.StreamLogs(r.Context(), kube.LogOptions{
		Namespace: t.ns, Pod: t.name, Container: container, TailLines: tail, Previous: q.Get("previous") == "true",
	}, func(e kube.LogEvent) error { return st.send(e) })
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	ch, snap, cancel := s.Hub.Subscribe()
	defer cancel()
	st := newStream(w, r)
	defer st.close()
	if err := st.send(events.Event{Type: "mode", State: strconv.FormatBool(s.armed.Load()), Time: time.Now()}); err != nil {
		return
	}
	for _, e := range snap {
		if err := st.send(e); err != nil {
			return
		}
	}
	for {
		select {
		case <-r.Context().Done():
			return
		case e := <-ch:
			if err := st.send(e); err != nil {
				return
			}
		}
	}
}

type actionReq struct {
	Ctx      string `json:"ctx"`
	NS       string `json:"ns"`
	Name     string `json:"name"`
	Confirm  string `json:"confirm"`
	Replicas *int32 `json:"replicas,omitempty"`
}

// action enforces Night Watch (read-only) and typed-name confirmation
// server-side, so a UI bug can never trigger a write by accident.
func (s *Server) action(w http.ResponseWriter, r *http.Request, fn func(ctx context.Context, t *target, req actionReq) error) {
	var req actionReq
	if !decode(w, r, maxBody, &req) {
		return
	}
	if !s.armed.Load() {
		writeJSON(w, http.StatusForbidden, apiError{Error: "Night Watch is on (read-only). Disable it to use the Utility Belt.", Code: "read-only"})
		return
	}
	if req.Confirm != req.Name {
		badRequest(w, "confirmation does not match the resource name")
		return
	}
	t, ok := s.resolveValues(w, req.Ctx, req.NS, req.Name, true)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	if err := fn(ctx, t, req); err != nil {
		clusterError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleDeletePod(w http.ResponseWriter, r *http.Request) {
	s.action(w, r, func(ctx context.Context, t *target, _ actionReq) error {
		return t.cl.DeletePod(ctx, t.ns, t.name)
	})
}

func (s *Server) handleRestartDeployment(w http.ResponseWriter, r *http.Request) {
	s.action(w, r, func(ctx context.Context, t *target, _ actionReq) error {
		return t.cl.RestartDeployment(ctx, t.ns, t.name)
	})
}

func (s *Server) handleScaleDeployment(w http.ResponseWriter, r *http.Request) {
	s.action(w, r, func(ctx context.Context, t *target, req actionReq) error {
		if req.Replicas == nil || *req.Replicas < 0 || *req.Replicas > maxReplicas {
			return apierrors.NewBadRequest("replicas must be between 0 and 500")
		}
		return t.cl.ScaleDeployment(ctx, t.ns, t.name, *req.Replicas)
	})
}

// stream writes NDJSON with periodic pings so dead connections are detected.
type stream struct {
	mu   sync.Mutex
	w    http.ResponseWriter
	rc   *http.ResponseController
	enc  *json.Encoder
	stop chan struct{}
	err  error
}

func newStream(w http.ResponseWriter, r *http.Request) *stream {
	w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	st := &stream{w: w, rc: http.NewResponseController(w), enc: json.NewEncoder(w), stop: make(chan struct{})}
	_ = st.rc.SetReadDeadline(time.Time{})
	_ = st.rc.Flush()
	go func() {
		t := time.NewTicker(20 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-st.stop:
				return
			case <-r.Context().Done():
				return
			case <-t.C:
				_ = st.send(map[string]string{"type": "ping"})
			}
		}
	}()
	return st
}

func (st *stream) send(v any) error {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.err != nil {
		return st.err
	}
	_ = st.rc.SetWriteDeadline(time.Now().Add(30 * time.Second))
	if err := st.enc.Encode(v); err != nil {
		st.err = err
		return err
	}
	if err := st.rc.Flush(); err != nil {
		st.err = err
		return err
	}
	return nil
}

func (st *stream) close() { close(st.stop) }
