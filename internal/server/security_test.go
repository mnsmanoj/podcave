package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestLaunchTokenIsSingleUse(t *testing.T) {
	tk := newTokens()
	launch := tk.NewLaunch()
	sess, ok := tk.Exchange(launch)
	if !ok || sess == "" || !tk.Valid(sess) {
		t.Fatal("first exchange should yield a valid session")
	}
	if _, ok := tk.Exchange(launch); ok {
		t.Fatal("launch token must not be reusable")
	}
	if tk.Valid(launch) {
		t.Fatal("launch token must not work as a session")
	}
	if _, ok := tk.Exchange("guess"); ok {
		t.Fatal("unknown launch token accepted")
	}
}

func TestGuard(t *testing.T) {
	tk := newTokens()
	sess, _ := tk.Exchange(tk.NewLaunch())
	g := &guard{port: 4321, tokens: tk}
	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusTeapot) })
	h := g.wrap(ok)

	cases := []struct {
		name   string
		method string
		path   string
		host   string
		hdr    map[string]string
		want   int
	}{
		{"static ok", "GET", "/", "127.0.0.1:4321", nil, http.StatusTeapot},
		{"dns rebinding host", "GET", "/", "evil.example:4321", nil, http.StatusMisdirectedRequest},
		{"wrong port host", "GET", "/", "127.0.0.1:9999", nil, http.StatusMisdirectedRequest},
		{"api without session", "GET", "/api/contexts", "127.0.0.1:4321", nil, http.StatusUnauthorized},
		{"api with session", "GET", "/api/contexts", "127.0.0.1:4321", map[string]string{"Authorization": "Bearer " + sess}, http.StatusTeapot},
		{"api bad session", "GET", "/api/contexts", "localhost:4321", map[string]string{"Authorization": "Bearer nope"}, http.StatusUnauthorized},
		{"cross-site fetch", "GET", "/api/contexts", "127.0.0.1:4321", map[string]string{"Authorization": "Bearer " + sess, "Sec-Fetch-Site": "cross-site"}, http.StatusForbidden},
		{"foreign origin", "POST", "/api/mode", "127.0.0.1:4321", map[string]string{"Authorization": "Bearer " + sess, "Origin": "https://evil.example", "Content-Type": "application/json"}, http.StatusForbidden},
		{"form post blocked", "POST", "/api/mode", "127.0.0.1:4321", map[string]string{"Authorization": "Bearer " + sess, "Content-Type": "text/plain"}, http.StatusUnsupportedMediaType},
		{"json post ok", "POST", "/api/mode", "127.0.0.1:4321", map[string]string{"Authorization": "Bearer " + sess, "Origin": "http://127.0.0.1:4321", "Content-Type": "application/json"}, http.StatusTeapot},
		{"session exchange needs no bearer", "POST", "/api/session", "127.0.0.1:4321", map[string]string{"Content-Type": "application/json"}, http.StatusTeapot},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := httptest.NewRequest(c.method, c.path, strings.NewReader("{}"))
			req.Host = c.host
			for k, v := range c.hdr {
				req.Header.Set(k, v)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != c.want {
				t.Fatalf("got %d, want %d", rec.Code, c.want)
			}
			if rec.Header().Get("Content-Security-Policy") == "" {
				t.Fatal("missing CSP header")
			}
		})
	}
}
