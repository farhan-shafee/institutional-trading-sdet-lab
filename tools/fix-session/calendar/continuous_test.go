// This file is compiled only as a test overlay against the pinned upstream
// package. It never forms part of the production peer.
package quickfix

import (
	"testing"
	"time"
)

func TestTradeFlowContinuousCalendarBoundary(t *testing.T) {
	settings := NewSessionSettings()
	factory := sessionFactory{}
	s, err := factory.newSession(SessionID{BeginString: "FIX.4.4", SenderCompID: "ATLAS", TargetCompID: "TRADEFLOW"}, NewMemoryStoreFactory(), settings, NewNullLogFactory(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.store.Close()
	if s.SessionTime != nil || s.ResetOnLogon || s.ResetOnLogout || s.ResetOnDisconnect {
		t.Fatal("CONTINUOUS_PROFILE")
	}
	before := time.Date(2026, 11, 7, 23, 59, 59, 999999999, time.UTC)
	after := time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC)
	s.store.SetCreationTime(before)
	for i := 0; i < 6; i++ {
		if err = s.store.IncrNextSenderMsgSeqNum(); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 8; i++ {
		if err = s.store.IncrNextTargetMsgSeqNum(); err != nil {
			t.Fatal(err)
		}
	}
	sm := stateMachine{State: latentState{}}
	for _, at := range []time.Time{before, after, after.Add(24 * time.Hour)} {
		sm.CheckSessionTime(s, at)
		if !sm.IsSessionTime() || s.store.NextSenderMsgSeqNum() != 7 || s.store.NextTargetMsgSeqNum() != 9 || !s.store.CreationTime().Equal(before) {
			t.Fatal("CALENDAR_RESET")
		}
	}
	t.Log("CALENDAR go=v0.9.12 sender=7 target=9 day_boundaries=2 production_edits=0")
}
