package main

import (
	"bufio"
	"encoding/base64"
	"os"
	"strings"
	"testing"
	"time"
)

// Wrapper output controls only. Real native FromApp provenance is a later gate.
func TestLiveEventsPreservesTheEntireCallbackPayload(t *testing.T) {
	read, write, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer read.Close()
	defer write.Close()
	events := newLiveEvents(write)
	defer events.close()
	payload := "35=8\x0159=1\x0160=20261107-12:00:00.000\x01"
	if !events.emit("LIVE_APP", payload) {
		t.Fatal("callback was not queued")
	}
	line, err := bufio.NewReader(read).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	want := "EVENT\tLIVE_APP\t" + base64.StdEncoding.EncodeToString([]byte(payload)) + "\n"
	if line != want {
		t.Fatalf("callback payload changed: %q", line)
	}
}

func TestLiveEventsFullPipeDoesNotBlockCallbackOrStop(t *testing.T) {
	read, write, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer read.Close()
	defer write.Close()
	events := newLiveEvents(write)
	defer events.close()
	finished := make(chan struct{})
	go func() {
		for i := 0; i < 64; i++ {
			events.emit("LIVE_APP", strings.Repeat("x", 8192))
		}
		events.close()
		close(finished)
	}()
	select {
	case <-finished:
	case <-time.After(250 * time.Millisecond):
		t.Fatal("full pipe blocked callback/shutdown")
	}
	select {
	case <-events.failed:
	default:
		t.Fatal("output overflow was not retained as failure")
	}
	if events.emit("LIVE_APP", "later") {
		t.Fatal("stopped output admitted another callback")
	}
}

func TestLiveEventsRejectsOversizeCallbackAndBrokenPipe(t *testing.T) {
	for _, oversize := range []bool{true, false} {
		read, write, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		events := newLiveEvents(write)
		if oversize {
			if events.emit("LIVE_APP", strings.Repeat("x", 8193)) {
				t.Fatal("oversize callback admitted")
			}
		} else {
			read.Close()
			events.emit("LIVE_APP", "x")
		}
		select {
		case <-events.failed:
		case <-time.After(250 * time.Millisecond):
			t.Fatal("output failure was not retained")
		}
		events.close()
		read.Close()
		write.Close()
	}
}
