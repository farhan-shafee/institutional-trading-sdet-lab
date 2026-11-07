package main

import (
	"strings"
	"testing"
	"time"
)

var guardEpoch = time.Date(2026, time.November, 7, 0, 0, 0, 0, time.UTC)

func moment(seconds int) time.Time { return guardEpoch.Add(time.Duration(seconds) * time.Second) }

func TestOrdinaryAndWrongIDCannotAnswerPendingRequest(t *testing.T) {
	for _, id := range []string{"", "OTHER"} {
		t.Run("id="+id, func(t *testing.T) {
			guard := newResponseGuard()
			if !guard.request(moment(0), "REQ") {
				t.Fatal("request refused")
			}
			if guard.acknowledge(moment(1), id, moment(1)) {
				t.Fatal("nonmatching response cleared pending request")
			}
			got, expired := guard.expire(moment(36))
			if got != "REQ" || !expired {
				t.Fatalf("want original request timeout, got %q %v", got, expired)
			}
			if _, again := guard.expire(moment(37)); again {
				t.Fatal("timeout emitted twice")
			}
		})
	}
}

func TestCorrectResponseJustBeforeDeadlineClearsPendingRequest(t *testing.T) {
	guard := newResponseGuard()
	guard.request(moment(0), "REQ")
	before := time.Date(2026, time.November, 7, 0, 0, 35, 999999999, time.UTC)
	if !guard.acknowledge(before, "REQ", before) {
		t.Fatal("fresh response before deadline rejected")
	}
	if _, expired := guard.expire(moment(36)); expired {
		t.Fatal("answered request timed out")
	}
}

func TestResponseAtOrAfterDeadlineCannotReviveRequest(t *testing.T) {
	for _, second := range []int{36, 37} {
		guard := newResponseGuard()
		guard.request(moment(0), "REQ")
		if guard.acknowledge(moment(second), "REQ", moment(second)) {
			t.Fatal("late response cleared pending request")
		}
		if _, expired := guard.expire(moment(second)); !expired {
			t.Fatal("late response concealed expiry")
		}
		if guard.acknowledge(moment(35), "REQ", moment(35)) {
			t.Fatal("old callback revived already expired request")
		}
	}
}

func TestRepeatedRequestDoesNotMoveOriginalDeadline(t *testing.T) {
	guard := newResponseGuard()
	guard.request(moment(0), "REQ")
	if !guard.request(moment(35), "REQ") {
		t.Fatal("same request observation refused")
	}
	id, expired := guard.expire(moment(36))
	if id != "REQ" || !expired {
		t.Fatal("repeated request extended original deadline")
	}
}

func TestCompetingRequestFailsClosedWithoutReplacingOriginal(t *testing.T) {
	guard := newResponseGuard()
	guard.request(moment(0), "REQ")
	if guard.request(moment(1), "OTHER") {
		t.Fatal("parallel request admitted")
	}
	id, expired := guard.expire(moment(1))
	if id != "REQ" || !expired {
		t.Fatal("conflict did not force bounded closure of original request")
	}
}

func TestInvalidRequestIDsAreRefused(t *testing.T) {
	for _, id := range []string{"", strings.Repeat("x", 257), "A\x01B", "A\xffB"} {
		if newResponseGuard().request(moment(0), id) {
			t.Fatal("invalid request ID accepted")
		}
	}
	if !newResponseGuard().request(moment(0), strings.Repeat("x", 256)) {
		t.Fatal("bounded request ID refused")
	}
}

func TestStaleAndFutureSendingTimeCannotClearEvenAcceptedCallback(t *testing.T) {
	for _, sent := range []time.Time{moment(81), moment(321), time.Time{}} {
		guard := newResponseGuard()
		guard.request(moment(200), "REQ")
		if guard.acknowledge(moment(201), "REQ", sent) {
			t.Fatal("timestamp at freshness boundary cleared pending request")
		}
		if _, expired := guard.expire(moment(236)); !expired {
			t.Fatal("stale/future callback concealed timeout")
		}
	}
	guard := newResponseGuard()
	guard.request(moment(200), "REQ")
	if !guard.acknowledge(moment(201), "REQ", moment(82)) {
		t.Fatal("fresh accepted response refused")
	}
}

func TestConnectionResetClearsPendingWithoutCreatingReceipt(t *testing.T) {
	guard := newResponseGuard()
	guard.request(moment(0), "REQ")
	guard.reset()
	if _, expired := guard.expire(moment(36)); expired {
		t.Fatal("disconnected connection retained a timer")
	}
	if guard.acknowledge(moment(1), "REQ", moment(1)) {
		t.Fatal("reset manufactured an acknowledgment")
	}
	if !guard.request(moment(40), "NEW") {
		t.Fatal("new connection cannot track request")
	}
	if id, expired := guard.expire(moment(76)); !expired || id != "NEW" {
		t.Fatal("new connection deadline incorrect")
	}
}
