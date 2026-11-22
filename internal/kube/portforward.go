package kube

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/tools/portforward"
	"k8s.io/client-go/transport/spdy"
	streamhttp "k8s.io/streaming/pkg/httpstream"

	"podcave/internal/events"
)

const (
	maxForwards      = 20
	forwardReadyWait = 30 * time.Second
	// Forwards only ever listen on loopback, like kubectl's default.
	forwardAddress = "127.0.0.1"
)

const (
	ForwardStarting = "starting"
	ForwardActive   = "active"
	ForwardFailed   = "failed"
)

type ForwardInfo struct {
	ID        string    `json:"id"`
	Ctx       string    `json:"ctx"`
	CtxName   string    `json:"ctxName"`
	Namespace string    `json:"namespace"`
	Pod       string    `json:"pod"`
	PodPort   int       `json:"podPort"`
	LocalPort int       `json:"localPort"`
	Address   string    `json:"address"`
	State     string    `json:"state"`
	Message   string    `json:"message,omitempty"`
	Started   time.Time `json:"started"`
}

type forwardEntry struct {
	info   ForwardInfo
	cancel context.CancelFunc
}

// Forwards tracks running port-forwards (kubectl port-forward pod/x local:remote).
type Forwards struct {
	hub   *events.Hub
	mu    sync.Mutex
	items map[string]*forwardEntry
}

func NewForwards(hub *events.Hub) *Forwards {
	return &Forwards{hub: hub, items: map[string]*forwardEntry{}}
}

func (f *Forwards) List() []ForwardInfo {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]ForwardInfo, 0, len(f.items))
	for _, e := range f.items {
		out = append(out, e.info)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Started.Before(out[j].Started) })
	return out
}

func (f *Forwards) changed() { f.hub.Publish(events.Event{Type: "forwards"}) }

// ValidatePorts checks a pod port (1-65535) and local port (0 = pick a free one).
func ValidatePorts(podPort, localPort int) error {
	if podPort < 1 || podPort > 65535 {
		return errors.New("pod port must be between 1 and 65535")
	}
	if localPort < 0 || localPort > 65535 {
		return errors.New("local port must be between 1 and 65535 (or empty to pick a free one)")
	}
	return nil
}

// Start opens a port-forward and returns once it is listening (or failed).
func (f *Forwards) Start(ctx context.Context, cl *Cluster, ns, pod string, podPort, localPort int) (ForwardInfo, error) {
	if err := ValidatePorts(podPort, localPort); err != nil {
		return ForwardInfo{}, err
	}
	f.mu.Lock()
	active := 0
	for _, e := range f.items {
		if e.info.State != ForwardFailed {
			active++
			if localPort != 0 && e.info.LocalPort == localPort {
				f.mu.Unlock()
				return ForwardInfo{}, fmt.Errorf("local port %d is already used by another forward (%s)", localPort, e.info.Pod)
			}
		}
	}
	f.mu.Unlock()
	if active >= maxForwards {
		return ForwardInfo{}, fmt.Errorf("at most %d port-forwards can run at once", maxForwards)
	}

	p, err := cl.Client.CoreV1().Pods(ns).Get(ctx, pod, metav1.GetOptions{})
	if err != nil {
		return ForwardInfo{}, err
	}
	if p.Status.Phase != corev1.PodRunning {
		return ForwardInfo{}, fmt.Errorf("pod is %s; it must be Running to port-forward", p.Status.Phase)
	}

	dialer, err := cl.portForwardDialer(ns, pod)
	if err != nil {
		return ForwardInfo{}, err
	}

	runCtx, cancel := context.WithCancel(context.Background())
	errLog := &lastLine{}
	ready := make(chan struct{})
	pf, err := portforward.NewOnAddressesForStreamingWithContext(runCtx, dialer, []string{forwardAddress},
		[]string{fmt.Sprintf("%d:%d", localPort, podPort)}, ready, io.Discard, errLog)
	if err != nil {
		cancel()
		return ForwardInfo{}, err
	}
	done := make(chan error, 1)
	go func() { done <- pf.ForwardPorts() }()

	select {
	case <-ready:
	case err := <-done:
		cancel()
		if err == nil {
			err = errors.New("port-forward stopped before it was ready")
		}
		return ForwardInfo{}, friendlyForwardErr(err, localPort)
	case <-time.After(forwardReadyWait):
		cancel()
		return ForwardInfo{}, errors.New("timed out waiting for the port-forward to start")
	case <-ctx.Done():
		cancel()
		return ForwardInfo{}, ctx.Err()
	}

	actual := localPort
	if ports, err := pf.GetPorts(); err == nil && len(ports) > 0 {
		actual = int(ports[0].Local)
	}
	info := ForwardInfo{
		ID: newID(), Ctx: cl.Info.ID, CtxName: cl.Info.Name, Namespace: ns, Pod: pod,
		PodPort: podPort, LocalPort: actual, Address: forwardAddress, State: ForwardActive, Started: time.Now().UTC(),
	}
	f.mu.Lock()
	f.items[info.ID] = &forwardEntry{info: info, cancel: cancel}
	f.mu.Unlock()
	f.changed()

	go func() {
		err := <-done
		f.mu.Lock()
		e, ok := f.items[info.ID]
		if ok && runCtx.Err() == nil {
			// Not stopped by the user: the pod went away or the connection dropped.
			msg := "connection to the pod was lost"
			if err != nil {
				msg = cleanErr(err)
			} else if l := errLog.get(); l != "" {
				msg = l
			}
			e.info.State, e.info.Message = ForwardFailed, msg
		}
		f.mu.Unlock()
		cancel()
		if ok {
			f.changed()
		}
	}()
	return info, nil
}

// Stop closes a forward (or dismisses a failed one).
func (f *Forwards) Stop(id string) error {
	f.mu.Lock()
	e, ok := f.items[id]
	if ok {
		delete(f.items, id)
	}
	f.mu.Unlock()
	if !ok {
		return errors.New("port-forward not found")
	}
	e.cancel()
	f.changed()
	return nil
}

// StopAll closes every forward (used when leaving Ops Mode and on shutdown).
func (f *Forwards) StopAll() int {
	f.mu.Lock()
	items := f.items
	f.items = map[string]*forwardEntry{}
	f.mu.Unlock()
	for _, e := range items {
		e.cancel()
	}
	if len(items) > 0 {
		f.changed()
	}
	return len(items)
}

// portForwardDialer mirrors kubectl: try WebSockets first, fall back to SPDY.
// Both transports apply the cluster's WrapTransport, so kubelogin auth is reused.
// The *ForStreaming variants are required: the WebSocket transport reports
// upgrade failures with k8s.io/streaming types, which the fallback check must match.
func (c *Cluster) portForwardDialer(ns, pod string) (streamhttp.Dialer, error) {
	u := c.Client.CoreV1().RESTClient().Post().Resource("pods").Namespace(ns).Name(pod).SubResource("portforward").URL()
	transport, upgrader, err := spdy.RoundTripperFor(c.Rest)
	if err != nil {
		return nil, err
	}
	spdyDialer := spdy.NewDialerForStreaming(upgrader, &http.Client{Transport: transport}, http.MethodPost, u)
	wsDialer, err := portforward.NewSPDYOverWebsocketDialerForStreaming(u, c.Rest)
	if err != nil {
		return spdyDialer, nil
	}
	return portforward.NewFallbackDialerForStreaming(wsDialer, spdyDialer, func(err error) bool {
		return streamhttp.IsUpgradeFailure(err) || streamhttp.IsHTTPSProxyError(err)
	}), nil
}

func friendlyForwardErr(err error, localPort int) error {
	msg := cleanErr(err)
	if strings.Contains(msg, "unable to listen on any of the requested ports") && localPort != 0 {
		return fmt.Errorf("local port %d is already in use on this computer; choose another or leave it empty", localPort)
	}
	return errors.New(msg)
}

// lastLine keeps the last error line written by the port-forwarder.
type lastLine struct {
	mu sync.Mutex
	s  string
}

func (l *lastLine) Write(p []byte) (int, error) {
	if s := strings.TrimSpace(string(p)); s != "" {
		l.mu.Lock()
		if len(s) > 400 {
			s = s[:400] + "…"
		}
		l.s = s
		l.mu.Unlock()
	}
	return len(p), nil
}

func (l *lastLine) get() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.s
}

func newID() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
