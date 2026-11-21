package kube

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"

	"podcave/internal/events"
)

// TestMain lets the test binary double as a fake credential plugin.
func TestMain(m *testing.M) {
	if os.Getenv("PODCAVE_FAKE_PLUGIN") == "1" {
		fmt.Fprintln(os.Stderr, "To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code CAVE42 to authenticate.")
		time.Sleep(3500 * time.Millisecond)
		fmt.Print(`{"apiVersion":"client.authentication.k8s.io/v1beta1","kind":"ExecCredential","status":{"token":"tok-123"}}`)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestExecAuthKeepsDeviceCodeVisible(t *testing.T) {
	hub := events.NewHub()
	ch, _, cancel := hub.Subscribe()
	defer cancel()
	a := newExecAuth("ctx1", clientcmdapi.ExecConfig{
		Command:    os.Args[0],
		APIVersion: "client.authentication.k8s.io/v1beta1",
		Env:        []clientcmdapi.ExecEnvVar{{Name: "PODCAVE_FAKE_PLUGIN", Value: "1"}},
	}, nil, hub)

	tok, err := a.Token(context.Background())
	if err != nil || tok != "tok-123" {
		t.Fatalf("token = %q, err = %v", tok, err)
	}
	var states []string
	for len(ch) > 0 {
		e := <-ch
		states = append(states, e.State)
		if e.State == events.AuthDeviceCode && e.Code != "CAVE42" {
			t.Fatalf("device code = %q", e.Code)
		}
	}
	want := []string{events.AuthDeviceCode, events.AuthOK}
	if fmt.Sprint(states) != fmt.Sprint(want) {
		t.Fatalf("auth events = %v, want %v (a pending event must not hide the device code)", states, want)
	}
}

func TestDedupeResumesWithoutGapsOrDuplicates(t *testing.T) {
	base := time.Date(2026, 1, 1, 10, 0, 5, 0, time.UTC)
	at := func(ms int) time.Time { return base.Add(time.Duration(ms) * time.Millisecond) }
	var d dedupe
	for _, ts := range []time.Time{at(100), at(200), at(200)} {
		if !d.accept(ts) {
			t.Fatal("first stream lines must be accepted")
		}
	}
	// Resume with sinceTime truncated to 10:00:05 -> server replays everything since then.
	d.reconnect()
	replay := []struct {
		ts   time.Time
		want bool
	}{
		{at(100), false}, // already seen, older
		{at(200), false}, // already seen (1st at .200)
		{at(200), false}, // already seen (2nd at .200)
		{at(200), true},  // new 3rd line at .200
		{at(300), true},  // new
	}
	for i, r := range replay {
		if got := d.accept(r.ts); got != r.want {
			t.Fatalf("replay line %d: got %v, want %v", i, got, r.want)
		}
	}
}

func TestSplitTimestamp(t *testing.T) {
	ts, raw, msg := splitTimestamp("2026-01-01T10:00:05.123456789Z hello world")
	if ts.IsZero() || raw != "2026-01-01T10:00:05.123456789Z" || msg != "hello world" {
		t.Fatalf("unexpected split: %v %q %q", ts, raw, msg)
	}
	if ts, _, msg := splitTimestamp("no timestamp here"); !ts.IsZero() || msg != "no timestamp here" {
		t.Fatal("lines without timestamps must pass through unchanged")
	}
}

func TestParseDeviceCode(t *testing.T) {
	u, c, ok := parseDeviceCode("To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code ABCD12345 to authenticate.")
	if !ok || u != "https://microsoft.com/devicelogin" || c != "ABCD12345" {
		t.Fatalf("got %q %q %v", u, c, ok)
	}
	if _, _, ok := parseDeviceCode("Acquiring token..."); ok {
		t.Fatal("non-prompt line parsed as device code")
	}
}

func TestLoginModeAndTenant(t *testing.T) {
	cfg := &clientcmdapi.ExecConfig{Command: "kubelogin", Args: []string{"get-token", "--login", "azurecli", "--server-id", "6dae42f8", "--tenant-id", "72f988bf-86f1-41af-91ab-2d7cd011db47"}}
	if m := loginMode(cfg); m != "azurecli" {
		t.Fatalf("login mode = %q", m)
	}
	if tid := tenantID(cfg); tid != "72f988bf-86f1-41af-91ab-2d7cd011db47" {
		t.Fatalf("tenant = %q", tid)
	}
	bad := &clientcmdapi.ExecConfig{Command: "kubelogin", Args: []string{"--tenant-id", "x; rm -rf /"}}
	if tid := tenantID(bad); tid != "" {
		t.Fatalf("unsafe tenant accepted: %q", tid)
	}
}

func TestPodStatus(t *testing.T) {
	crash := &corev1.Pod{
		Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "app"}}},
		Status: corev1.PodStatus{Phase: corev1.PodRunning, ContainerStatuses: []corev1.ContainerStatus{{
			Name: "app", RestartCount: 7, State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff"}},
		}}},
	}
	if s, ready, total, restarts := podStatus(crash); s != "CrashLoopBackOff" || ready != 0 || total != 1 || restarts != 7 {
		t.Fatalf("crashloop: %s %d/%d %d", s, ready, total, restarts)
	}
	running := &corev1.Pod{
		Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "a"}, {Name: "b"}}},
		Status: corev1.PodStatus{Phase: corev1.PodRunning, ContainerStatuses: []corev1.ContainerStatus{
			{Name: "a", Ready: true, State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}},
			{Name: "b", Ready: true, State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}},
		}},
	}
	if s, ready, _, _ := podStatus(running); s != "Running" || ready != 2 {
		t.Fatalf("running: %s %d", s, ready)
	}
}
