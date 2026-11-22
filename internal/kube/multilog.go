package kube

import (
	"context"
	"sort"
	"sync"
	"time"
)

const (
	// MaxLogSources caps how many containers one merged view streams at once.
	MaxLogSources = 10

	mergeInterval = 250 * time.Millisecond
	settleQuiet   = 300 * time.Millisecond
	settleMax     = 4 * time.Second
	mergeMaxHeld  = 60000
)

// LogSource is one container whose logs feed a merged view.
type LogSource struct {
	Cluster   *Cluster
	CtxID     string
	Namespace string
	Pod       string
	Container string
}

type SourceInfo struct {
	ID        int    `json:"id"`
	Ctx       string `json:"ctx"`
	Namespace string `json:"ns"`
	Pod       string `json:"pod"`
	Container string `json:"container"`
}

type TaggedLine struct {
	S int    `json:"s"`
	T string `json:"t,omitempty"`
	M string `json:"m"`
}

// MultiEvent is streamed to the UI as NDJSON.
//
//	source: a new container joined (Source set)
//	lines:  merged lines, each tagged with its source id
//	status: state change of one source (ID set)
//	info:   a note about the whole view, e.g. pods skipped because of the cap
type MultiEvent struct {
	Type    string       `json:"type"`
	ID      int          `json:"id"`
	Source  *SourceInfo  `json:"source,omitempty"`
	Lines   []TaggedLine `json:"lines,omitempty"`
	State   string       `json:"state,omitempty"`
	Message string       `json:"message,omitempty"`
}

type MultiOptions struct {
	TailLines int64
	SinceTime *time.Time
	NoFollow  bool
	Previous  bool
}

type heldLine struct {
	ts  time.Time
	seq uint64
	l   TaggedLine
}

// MultiLogs streams several containers (possibly from different clusters) and
// merges their lines by timestamp. Each source keeps the reconnect, dedupe and
// sign-in handling of StreamLogs; a failing cluster only affects its own sources.
type MultiLogs struct {
	ctx  context.Context
	opts MultiOptions
	emit func(MultiEvent) error

	mu         sync.Mutex
	keys       map[string]int
	held       []heldLine
	seq        uint64
	connecting int
	active     int
	sealed     bool
	settled    bool
	start      time.Time
	lastAdd    time.Time
	wg         sync.WaitGroup
	done       chan struct{}
}

func NewMultiLogs(ctx context.Context, opts MultiOptions, emit func(MultiEvent) error) *MultiLogs {
	m := &MultiLogs{ctx: ctx, opts: opts, emit: emit, keys: map[string]int{}, start: time.Now(), done: make(chan struct{})}
	go m.flusher()
	return m
}

// Active reports how many sources are still streaming.
func (m *MultiLogs) Active() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.active
}

// Has reports whether the container is already part of the view.
func (m *MultiLogs) Has(ctxID, ns, pod, container string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.keys[ctxID+"/"+ns+"/"+pod+"/"+container]
	return ok
}

// Add starts streaming a source. It returns false if the source is already
// present or MaxLogSources are streaming.
func (m *MultiLogs) Add(src LogSource) bool {
	key := src.CtxID + "/" + src.Namespace + "/" + src.Pod + "/" + src.Container
	m.mu.Lock()
	if _, ok := m.keys[key]; ok || m.active >= MaxLogSources || m.sealed {
		m.mu.Unlock()
		return false
	}
	id := len(m.keys)
	m.keys[key] = id
	m.active++
	m.connecting++
	m.wg.Add(1)
	m.mu.Unlock()

	info := &SourceInfo{ID: id, Ctx: src.CtxID, Namespace: src.Namespace, Pod: src.Pod, Container: src.Container}
	if err := m.emit(MultiEvent{Type: "source", ID: id, Source: info}); err != nil {
		m.finish(true)
		return false
	}
	go func() {
		connecting := true
		_ = src.Cluster.StreamLogs(m.ctx, LogOptions{
			Namespace: src.Namespace, Pod: src.Pod, Container: src.Container,
			TailLines: m.opts.TailLines, SinceTime: m.opts.SinceTime, NoFollow: m.opts.NoFollow, Previous: m.opts.Previous,
		}, func(e LogEvent) error {
			if e.Type == "lines" {
				m.hold(id, e.Lines)
				return m.ctx.Err()
			}
			if connecting && e.State != "connecting" {
				connecting = false
				m.mu.Lock()
				m.connecting--
				m.mu.Unlock()
			}
			return m.emit(MultiEvent{Type: "status", ID: id, State: e.State, Message: e.Message})
		})
		m.finish(connecting)
	}()
	return true
}

// Info sends a note about the whole view.
func (m *MultiLogs) Info(msg string) error {
	return m.emit(MultiEvent{Type: "info", ID: -1, Message: msg})
}

// Seal marks that no more sources will be added. A non-following view ends
// once it is sealed and every source has finished.
func (m *MultiLogs) Seal() {
	m.mu.Lock()
	m.sealed = true
	m.mu.Unlock()
}

// Wait blocks until every source has finished and the last lines are sent.
// Call it after Seal.
func (m *MultiLogs) Wait() {
	m.wg.Wait()
	<-m.done
}

func (m *MultiLogs) finish(stillConnecting bool) {
	m.mu.Lock()
	m.active--
	if stillConnecting {
		m.connecting--
	}
	m.mu.Unlock()
	m.wg.Done()
}

func (m *MultiLogs) hold(id int, lines []LogLine) {
	now := time.Now()
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, l := range lines {
		ts, err := time.Parse(time.RFC3339Nano, l.T)
		if err != nil {
			ts = now
		}
		m.seq++
		m.held = append(m.held, heldLine{ts: ts, seq: m.seq, l: TaggedLine{S: id, T: l.T, M: l.M}})
	}
	m.lastAdd = now
}

// flusher emits held lines sorted by timestamp. Until the initial backlog of
// every source has arrived ("settled") it keeps holding, so the first screen
// interleaves all pods correctly; after that it flushes every mergeInterval.
func (m *MultiLogs) flusher() {
	defer close(m.done)
	t := time.NewTicker(mergeInterval)
	defer t.Stop()
	for {
		select {
		case <-m.ctx.Done():
			return
		case <-t.C:
		}
		m.mu.Lock()
		finished := m.sealed && m.active == 0
		if !m.settled {
			now := time.Now()
			switch {
			case m.opts.NoFollow:
				m.settled = finished || len(m.held) >= mergeMaxHeld
			default:
				quiet := m.lastAdd.IsZero() || now.Sub(m.lastAdd) >= settleQuiet
				m.settled = (m.connecting == 0 && quiet && (m.sealed || len(m.keys) > 0)) || now.Sub(m.start) >= settleMax || len(m.held) >= mergeMaxHeld
			}
		}
		var out []heldLine
		if m.settled || finished {
			out, m.held = m.held, nil
		}
		m.mu.Unlock()

		if len(out) > 0 {
			sort.Slice(out, func(i, j int) bool {
				if !out[i].ts.Equal(out[j].ts) {
					return out[i].ts.Before(out[j].ts)
				}
				return out[i].seq < out[j].seq
			})
			for start := 0; start < len(out); start += batchMax {
				end := min(start+batchMax, len(out))
				batch := make([]TaggedLine, end-start)
				for i, h := range out[start:end] {
					batch[i] = h.l
				}
				if err := m.emit(MultiEvent{Type: "lines", ID: -1, Lines: batch}); err != nil {
					return
				}
			}
		}
		if finished && m.opts.NoFollow {
			m.mu.Lock()
			empty := len(m.held) == 0
			m.mu.Unlock()
			if empty {
				return
			}
		}
	}
}
