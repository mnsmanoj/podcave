package server

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"mime"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	launchTTL  = 10 * time.Minute
	csp        = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
	authHeader = "Authorization"
)

// tokens implements the launch-link -> session handshake.
// Launch tokens travel in the URL fragment (never sent over HTTP), are
// single-use and short-lived. Session tokens live only in the tab's
// sessionStorage and are sent as a bearer header, so there are no ambient
// credentials (cookies) that other sites or other localhost ports could ride on.
// Only SHA-256 hashes are kept in memory, which also makes lookups timing-safe.
type tokens struct {
	mu       sync.Mutex
	launch   map[[32]byte]time.Time
	sessions map[[32]byte]struct{}
}

func newTokens() *tokens {
	return &tokens{launch: map[[32]byte]time.Time{}, sessions: map[[32]byte]struct{}{}}
}

func randomToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func (t *tokens) NewLaunch() string {
	tok := randomToken()
	t.mu.Lock()
	defer t.mu.Unlock()
	now := time.Now()
	for k, exp := range t.launch {
		if now.After(exp) {
			delete(t.launch, k)
		}
	}
	t.launch[sha256.Sum256([]byte(tok))] = now.Add(launchTTL)
	return tok
}

func (t *tokens) Exchange(launch string) (string, bool) {
	if launch == "" {
		return "", false
	}
	h := sha256.Sum256([]byte(launch))
	t.mu.Lock()
	defer t.mu.Unlock()
	exp, ok := t.launch[h]
	if !ok {
		return "", false
	}
	delete(t.launch, h)
	if time.Now().After(exp) {
		return "", false
	}
	sess := randomToken()
	t.sessions[sha256.Sum256([]byte(sess))] = struct{}{}
	return sess, true
}

func (t *tokens) Valid(session string) bool {
	if session == "" {
		return false
	}
	h := sha256.Sum256([]byte(session))
	t.mu.Lock()
	defer t.mu.Unlock()
	_, ok := t.sessions[h]
	return ok
}

func bearer(r *http.Request) string {
	v := r.Header.Get(authHeader)
	if len(v) > 7 && strings.EqualFold(v[:7], "Bearer ") {
		return strings.TrimSpace(v[7:])
	}
	return ""
}

type guard struct {
	port   int
	tokens *tokens
}

func (g *guard) allowedHost(host string) bool {
	h, p, err := net.SplitHostPort(host)
	if err != nil || p != strconv.Itoa(g.port) {
		return false
	}
	return h == "127.0.0.1" || strings.EqualFold(h, "localhost")
}

func (g *guard) allowedOrigin(origin string) bool {
	for _, h := range []string{"127.0.0.1", "localhost"} {
		if strings.EqualFold(origin, "http://"+h+":"+strconv.Itoa(g.port)) {
			return true
		}
	}
	return false
}

func (g *guard) wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", csp)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), usb=(), payment=()")

		// Blocks DNS-rebinding: a hostile site resolving its own name to 127.0.0.1.
		if !g.allowedHost(r.Host) {
			http.Error(w, "invalid host", http.StatusMisdirectedRequest)
			return
		}
		if s := r.Header.Get("Sec-Fetch-Site"); s != "" && s != "same-origin" && s != "none" {
			http.Error(w, "cross-site request blocked", http.StatusForbidden)
			return
		}
		if o := r.Header.Get("Origin"); o != "" && !g.allowedOrigin(o) {
			http.Error(w, "cross-origin request blocked", http.StatusForbidden)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			h.Set("Cache-Control", "no-store")
			if r.Method != http.MethodGet && r.Method != http.MethodHead {
				mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
				if mt != "application/json" {
					writeJSON(w, http.StatusUnsupportedMediaType, apiError{Error: "content-type must be application/json"})
					return
				}
			}
			if r.URL.Path != "/api/session" && !g.tokens.Valid(bearer(r)) {
				writeJSON(w, http.StatusUnauthorized, apiError{Error: "session expired or missing", Code: "session"})
				return
			}
		} else if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		next.ServeHTTP(w, r)
	})
}
