package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"podcave/internal/events"
	"podcave/internal/kube"
)

func TestPortForwardRequiresOpsMode(t *testing.T) {
	hub := events.NewHub()
	s := &Server{Hub: hub, Kube: kube.NewManager(nil, hub, "test"), guard: &guard{port: 4321}}
	start := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/forwards/start",
			strings.NewReader(`{"ctx":"a/b","ns":"default","pod":"web","podPort":80,"localPort":8080}`))
		rec := httptest.NewRecorder()
		s.handleStartForward(rec, req)
		return rec
	}

	if rec := start(); rec.Code != http.StatusForbidden {
		t.Fatalf("Night Watch: got %d, want 403", rec.Code)
	}

	s.armed.Store(true)
	bad := httptest.NewRequest(http.MethodPost, "/api/forwards/start",
		strings.NewReader(`{"ctx":"a/b","ns":"default","pod":"web","podPort":70000,"localPort":8080}`))
	rec := httptest.NewRecorder()
	s.handleStartForward(rec, bad)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid pod port: got %d, want 400", rec.Code)
	}

	own := httptest.NewRequest(http.MethodPost, "/api/forwards/start",
		strings.NewReader(`{"ctx":"a/b","ns":"default","pod":"web","podPort":80,"localPort":4321}`))
	rec = httptest.NewRecorder()
	s.handleStartForward(rec, own)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("Pod Cave's own port: got %d, want 400", rec.Code)
	}
}
