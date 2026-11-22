package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPreviewListsClustersWithoutSaving(t *testing.T) {
	s := &Server{}
	kc := "apiVersion: v1\nkind: Config\nclusters:\n- name: c1\n  cluster: {server: 'https://hhr.example:443'}\ncontexts:\n- name: zeta\n  context: {cluster: c1, user: u}\n- name: hhr\n  context: {cluster: c1, user: u, namespace: web}\nusers:\n- name: u\n  user: {token: x}\n"
	body, _ := json.Marshal(map[string]string{"content": kc})
	rec := httptest.NewRecorder()
	s.handlePreview(rec, httptest.NewRequest(http.MethodPost, "/api/sources/preview", strings.NewReader(string(body))))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	var got struct {
		Contexts []struct{ Name, Server, Namespace string }
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if len(got.Contexts) != 2 || got.Contexts[0].Name != "hhr" || got.Contexts[0].Server != "https://hhr.example:443" || got.Contexts[0].Namespace != "web" {
		t.Fatalf("unexpected preview: %+v", got.Contexts)
	}

	rec = httptest.NewRecorder()
	s.handlePreview(rec, httptest.NewRequest(http.MethodPost, "/api/sources/preview", strings.NewReader(`{"path":"relative/config"}`)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("relative path: got %d, want 400", rec.Code)
	}
}
