package main

import (
	"encoding/base64"
	"io"
	"sync"
)

// The selected wrapper never makes an engine callback wait on its output pipe.
// Overflow/IO failure closes failed; the main command/guard loop owns shutdown.
type liveEvents struct {
	queue    chan string
	stopped  chan struct{}
	failed   chan struct{}
	stopOnce sync.Once
	failOnce sync.Once
}

func newLiveEvents(output io.Writer) *liveEvents {
	result := &liveEvents{queue: make(chan string, 16), stopped: make(chan struct{}), failed: make(chan struct{})}
	go func() {
		for {
			select {
			case <-result.stopped:
				return
			case line := <-result.queue:
				n, err := io.WriteString(output, line)
				if err != nil || n != len(line) {
					result.fail()
					return
				}
			}
		}
	}()
	return result
}

func (events *liveEvents) fail()  { events.failOnce.Do(func() { close(events.failed) }) }
func (events *liveEvents) close() { events.stopOnce.Do(func() { close(events.stopped) }) }
func (events *liveEvents) emit(kind, payload string) bool {
	select {
	case <-events.stopped:
		return false
	case <-events.failed:
		return false
	default:
	}
	if len(kind) < 1 || len(kind) > 32 || len(payload) > 8192 {
		events.fail()
		return false
	}
	for _, letter := range kind {
		if letter != '_' && (letter < 'A' || letter > 'Z') {
			events.fail()
			return false
		}
	}
	line := "EVENT\t" + kind + "\t" + base64.StdEncoding.EncodeToString([]byte(payload)) + "\n"
	select {
	case events.queue <- line:
		return true
	default:
		events.fail()
		return false
	}
}
