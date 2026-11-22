package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"podcave/internal/events"
	"podcave/internal/kube"
	"podcave/internal/store"
)

func TestWriteActionsNeedOpsModeAndYes(t *testing.T) {
	hub := events.NewHub()
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{Hub: hub, Kube: kube.NewManager(st, hub, "test"), guard: &guard{port: 4321}}
	del := func(confirm string) *httptest.ResponseRecorder {
		body := `{"ctx":"a/b","ns":"default","name":"web-1","confirm":"` + confirm + `"}`
		rec := httptest.NewRecorder()
		s.handleDeletePod(rec, httptest.NewRequest(http.MethodPost, "/api/pods/delete", strings.NewReader(body)))
		return rec
	}

	if rec := del("yes"); rec.Code != http.StatusForbidden {
		t.Fatalf("Night Watch: got %d, want 403", rec.Code)
	}
	s.armed.Store(true)
	for _, c := range []string{"", "web-1", "y", "yess"} {
		if rec := del(c); rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `type \"yes\"`) {
			t.Fatalf("confirm %q: got %d %s, want the yes prompt", c, rec.Code, rec.Body)
		}
	}
	// "Yes" in any case passes the confirmation and reaches cluster lookup (unknown here).
	if rec := del(" Yes "); strings.Contains(rec.Body.String(), `type \"yes\"`) {
		t.Fatalf("confirm \"Yes\" was rejected: %s", rec.Body)
	}
}
