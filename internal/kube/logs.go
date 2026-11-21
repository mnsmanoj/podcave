package kube

import (
	"bufio"
	"context"
	"errors"
	"io"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

const (
	maxLineBytes  = 16 << 10
	batchInterval = 100 * time.Millisecond
	batchMax      = 1000
)

type LogLine struct {
	T string `json:"t,omitempty"`
	M string `json:"m"`
}

type LogEvent struct {
	Type    string    `json:"type"` // lines | status
	Lines   []LogLine `json:"lines,omitempty"`
	State   string    `json:"state,omitempty"` // connecting | live | reconnecting | waiting | auth | ended | error
	Message string    `json:"message,omitempty"`
}

type LogOptions struct {
	Namespace, Pod, Container string
	TailLines                 int64
	Previous                  bool
}

// dedupe drops lines already delivered when a follow stream is resumed with
// sinceTime (which the API server truncates to whole seconds).
type dedupe struct {
	last    time.Time
	nAtLast int
	replay  bool
	skip    int
}

func (d *dedupe) reconnect() {
	d.replay = true
	d.skip = d.nAtLast
}

func (d *dedupe) accept(ts time.Time) bool {
	if ts.IsZero() {
		return !d.replay
	}
	if d.replay {
		if ts.Before(d.last) {
			return false
		}
		if ts.Equal(d.last) && d.skip > 0 {
			d.skip--
			return false
		}
		d.replay = false
	}
	switch {
	case ts.Equal(d.last):
		d.nAtLast++
	case ts.After(d.last):
		d.last, d.nAtLast = ts, 1
	}
	return true
}

func splitTimestamp(line string) (time.Time, string, string) {
	ts, rest, ok := strings.Cut(line, " ")
	if !ok {
		ts, rest = line, ""
	}
	t, err := time.Parse(time.RFC3339Nano, ts)
	if err != nil {
		return time.Time{}, "", line
	}
	return t, ts, rest
}

// StreamLogs follows container logs until ctx is cancelled, the container is
// gone, or emit fails. Disconnects (API server timeouts, token expiry, network
// blips) are retried and resumed from the last timestamp without duplicates.
func (c *Cluster) StreamLogs(ctx context.Context, o LogOptions, emit func(LogEvent) error) error {
	var dd dedupe
	connected := false
	backoff := time.Second
	status := func(state, msg string) error { return emit(LogEvent{Type: "status", State: state, Message: msg}) }
	wait := func(d time.Duration) bool {
		select {
		case <-ctx.Done():
			return false
		case <-time.After(d):
			return true
		}
	}

	if err := status("connecting", ""); err != nil {
		return err
	}
	for ctx.Err() == nil {
		opts := &corev1.PodLogOptions{Container: o.Container, Follow: !o.Previous, Timestamps: true, Previous: o.Previous}
		if dd.last.IsZero() {
			if o.TailLines > 0 {
				opts.TailLines = &o.TailLines
			}
		} else {
			since := metav1.NewTime(dd.last.Truncate(time.Second))
			opts.SinceTime = &since
			dd.reconnect()
		}
		stream, err := c.Client.CoreV1().Pods(o.Namespace).GetLogs(o.Pod, opts).Stream(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			switch {
			case apierrors.IsNotFound(err):
				return status("ended", cleanErr(err))
			case o.Previous:
				return status("error", cleanErr(err))
			case IsAuthError(err) || apierrors.IsUnauthorized(err):
				err = status("auth", cleanErr(err))
			case apierrors.IsForbidden(err):
				return status("error", cleanErr(err))
			case apierrors.IsBadRequest(err):
				// e.g. "container is waiting to start: ContainerCreating"
				err = status("waiting", cleanErr(err))
			default:
				err = status("reconnecting", cleanErr(err))
			}
			if err != nil {
				return err
			}
			if !wait(backoff) {
				return nil
			}
			if backoff < 15*time.Second {
				backoff *= 2
			}
			continue
		}
		state := "live"
		if connected {
			state = "live-resumed"
		}
		if err := status(state, ""); err != nil {
			stream.Close()
			return err
		}
		connected = true
		backoff = time.Second
		readErr := c.pump(ctx, stream, &dd, emit)
		stream.Close()
		if ctx.Err() != nil {
			return nil
		}
		var ee *emitError
		if errors.As(readErr, &ee) {
			return ee.err
		}
		if o.Previous {
			return status("ended", "End of previous container logs")
		}
		if done, msg := c.containerFinished(ctx, o); done {
			return status("ended", msg)
		}
		if err := status("reconnecting", "Log stream closed; resuming…"); err != nil {
			return err
		}
		if !wait(time.Second) {
			return nil
		}
	}
	return nil
}

type emitError struct{ err error }

func (e *emitError) Error() string { return e.err.Error() }

func (c *Cluster) pump(ctx context.Context, r io.Reader, dd *dedupe, emit func(LogEvent) error) error {
	lines := make(chan LogLine, 4096)
	readErr := make(chan error, 1)
	go func() {
		defer close(lines)
		br := bufio.NewReaderSize(r, 64<<10)
		for {
			raw, err := readLine(br)
			if raw != "" || err == nil {
				t, ts, msg := splitTimestamp(raw)
				if dd.accept(t) {
					select {
					case lines <- LogLine{T: ts, M: msg}:
					case <-ctx.Done():
						readErr <- ctx.Err()
						return
					}
				}
			}
			if err != nil {
				readErr <- err
				return
			}
		}
	}()

	tick := time.NewTicker(batchInterval)
	defer tick.Stop()
	batch := make([]LogLine, 0, batchMax)
	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		err := emit(LogEvent{Type: "lines", Lines: batch})
		batch = make([]LogLine, 0, batchMax)
		if err != nil {
			return &emitError{err}
		}
		return nil
	}
	for {
		select {
		case l, ok := <-lines:
			if !ok {
				if err := flush(); err != nil {
					return err
				}
				return <-readErr
			}
			batch = append(batch, l)
			if len(batch) >= batchMax {
				if err := flush(); err != nil {
					return err
				}
			}
		case <-tick.C:
			if err := flush(); err != nil {
				return err
			}
		}
	}
}

// readLine reads one line, truncating very long lines instead of buffering them.
func readLine(br *bufio.Reader) (string, error) {
	var sb strings.Builder
	truncated := false
	for {
		chunk, isPrefix, err := br.ReadLine()
		if !truncated {
			room := maxLineBytes - sb.Len()
			if len(chunk) > room {
				sb.Write(chunk[:room])
				truncated = true
			} else {
				sb.Write(chunk)
			}
		}
		if err != nil {
			return sb.String(), err
		}
		if !isPrefix {
			break
		}
	}
	if truncated {
		sb.WriteString(" …[line truncated by Pod Cave]")
	}
	return sb.String(), nil
}

func (c *Cluster) containerFinished(ctx context.Context, o LogOptions) (bool, string) {
	p, err := c.Client.CoreV1().Pods(o.Namespace).Get(ctx, o.Pod, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return true, "Pod was deleted"
	}
	if err != nil {
		return false, ""
	}
	if p.Status.Phase == corev1.PodSucceeded || p.Status.Phase == corev1.PodFailed {
		return true, "Pod finished (" + string(p.Status.Phase) + ")"
	}
	return false, ""
}
