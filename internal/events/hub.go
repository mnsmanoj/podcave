// Package events is a tiny in-process pub/sub used to push auth prompts
// (device codes, re-login needed) to every open UI tab.
package events

import (
	"sync"
	"time"
)

type Event struct {
	Type    string    `json:"type"`
	Ctx     string    `json:"ctx,omitempty"`
	State   string    `json:"state,omitempty"`
	Message string    `json:"message,omitempty"`
	URL     string    `json:"url,omitempty"`
	Code    string    `json:"code,omitempty"`
	Time    time.Time `json:"time"`
}

const (
	AuthOK         = "ok"
	AuthPending    = "pending"
	AuthDeviceCode = "device-code"
	AuthNeedsLogin = "needs-login"
	AuthError      = "error"
)

type Hub struct {
	mu   sync.Mutex
	subs map[chan Event]struct{}
	auth map[string]Event
}

func NewHub() *Hub {
	return &Hub{subs: map[chan Event]struct{}{}, auth: map[string]Event{}}
}

// PublishAuth records the latest auth state for a context and broadcasts it.
func (h *Hub) PublishAuth(ctx, state, msg, url, code string) {
	e := Event{Type: "auth", Ctx: ctx, State: state, Message: msg, URL: url, Code: code, Time: time.Now()}
	h.mu.Lock()
	prev, had := h.auth[ctx]
	if had && prev.State == state && prev.Message == msg && prev.Code == code {
		h.mu.Unlock()
		return
	}
	if state == AuthOK {
		delete(h.auth, ctx)
	} else {
		h.auth[ctx] = e
	}
	h.broadcastLocked(e)
	h.mu.Unlock()
}

func (h *Hub) Publish(e Event) {
	e.Time = time.Now()
	h.mu.Lock()
	h.broadcastLocked(e)
	h.mu.Unlock()
}

func (h *Hub) broadcastLocked(e Event) {
	for ch := range h.subs {
		select {
		case ch <- e:
		default: // slow subscriber; drop rather than block auth flows
		}
	}
}

// Subscribe returns a channel of future events plus the current non-OK auth states.
func (h *Hub) Subscribe() (<-chan Event, []Event, func()) {
	ch := make(chan Event, 64)
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	snap := make([]Event, 0, len(h.auth))
	for _, e := range h.auth {
		snap = append(snap, e)
	}
	h.mu.Unlock()
	return ch, snap, func() {
		h.mu.Lock()
		delete(h.subs, ch)
		h.mu.Unlock()
	}
}
