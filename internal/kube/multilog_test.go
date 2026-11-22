package kube

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// logCluster serves fixed log lines (with timestamps) for any pod.
func logCluster(t *testing.T, lines map[string][]string) *Cluster {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(r.URL.Path, "/") // /api/v1/namespaces/<ns>/pods/<pod>/log
		if len(parts) < 7 || parts[len(parts)-1] != "log" {
			http.NotFound(w, r)
			return
		}
		for _, l := range lines[parts[6]] {
			fmt.Fprintln(w, l)
		}
	}))
	t.Cleanup(srv.Close)
	cs, err := kubernetes.NewForConfig(&rest.Config{Host: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	return &Cluster{Client: cs}
}

func TestMultiLogsMergesSourcesByTimestamp(t *testing.T) {
	ts := func(sec int) string { return time.Date(2026, 1, 1, 10, 0, sec, 0, time.UTC).Format(time.RFC3339Nano) }
	a := logCluster(t, map[string][]string{"web": {ts(1) + " w1", ts(3) + " w3", ts(5) + " w5"}})
	b := logCluster(t, map[string][]string{"api": {ts(2) + " a2", ts(4) + " a4"}})

	var mu sync.Mutex
	pods := map[int]string{}
	var got []string
	m := NewMultiLogs(context.Background(), MultiOptions{NoFollow: true}, func(e MultiEvent) error {
		mu.Lock()
		defer mu.Unlock()
		switch e.Type {
		case "source":
			pods[e.Source.ID] = e.Source.Pod
		case "lines":
			for _, l := range e.Lines {
				got = append(got, pods[l.S]+":"+l.M)
			}
		}
		return nil
	})
	if !m.Add(LogSource{Cluster: a, CtxID: "a/ctx", Namespace: "default", Pod: "web", Container: "app"}) ||
		!m.Add(LogSource{Cluster: b, CtxID: "b/ctx", Namespace: "payments", Pod: "api", Container: "app"}) {
		t.Fatal("sources rejected")
	}
	if m.Add(LogSource{Cluster: a, CtxID: "a/ctx", Namespace: "default", Pod: "web", Container: "app"}) {
		t.Fatal("duplicate source accepted")
	}
	m.Seal()
	done := make(chan struct{})
	go func() { m.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("non-following view did not finish")
	}
	want := "web:w1 api:a2 web:w3 api:a4 web:w5"
	if s := strings.Join(got, " "); s != want {
		t.Fatalf("merged = %q, want %q", s, want)
	}
}
