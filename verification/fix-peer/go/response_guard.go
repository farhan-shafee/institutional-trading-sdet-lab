package main

import (
	"sync"
	"time"
)

// responseGuard is an explicit bilateral-profile policy around the unchanged
// engine. It observes validated callbacks; it never validates or rewrites FIX.
type responseGuard struct {
	mu       sync.Mutex
	id       string
	deadline time.Time
	pending  bool
	timedOut bool
}

func newResponseGuard() *responseGuard { return &responseGuard{} }

func (g *responseGuard) request(now time.Time, id string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	valid := len(id) > 0 && len(id) <= 256
	for _, b := range []byte(id) {
		if b < 32 || b > 126 {
			valid = false
			break
		}
	}
	if !valid {
		if g.pending {
			g.deadline = now
		}
		return false
	}
	if g.pending {
		if id != g.id {
			g.deadline = now
			return false
		}
		return true
	}
	g.id = id
	g.deadline = now.Add(36 * time.Second)
	g.pending = true
	g.timedOut = false
	return true
}

func (g *responseGuard) acknowledge(now time.Time, id string, sendingTime time.Time) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.pending || g.timedOut || id != g.id || !now.Before(g.deadline) || sendingTime.IsZero() {
		return false
	}
	age := now.Sub(sendingTime)
	if age >= 120*time.Second || age <= -120*time.Second {
		return false
	}
	g.id = ""
	g.deadline = time.Time{}
	g.pending = false
	return true
}

func (g *responseGuard) expire(now time.Time) (string, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.pending || g.timedOut || now.Before(g.deadline) {
		return "", false
	}
	g.timedOut = true
	return g.id, true
}

func (g *responseGuard) reset() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.id = ""
	g.deadline = time.Time{}
	g.pending = false
	g.timedOut = false
}
