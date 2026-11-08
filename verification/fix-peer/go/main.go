// The fictional peer runs a separately implemented session engine. It never applies trades.
package main

import (
	"bufio"
	"encoding/base64"
	"fmt"
	"os"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/quickfixgo/quickfix"
	filestore "github.com/quickfixgo/quickfix/store/file"
)

var outputMu sync.Mutex
var selectedLiveOutput *liveEvents
var selectedLiveFailure <-chan struct{}

func event(kind, payload string) {
	if selectedLiveOutput != nil {
		selectedLiveOutput.emit(kind, payload)
		return
	}
	outputMu.Lock()
	defer outputMu.Unlock()
	fmt.Printf("EVENT\t%s\t%s\n", kind, base64.StdEncoding.EncodeToString([]byte(payload)))
}

var observedTags = []quickfix.Tag{35, 34, 49, 56, 43, 52, 122, 112, 7, 16, 36, 123, 141, 11, 41, 37, 17, 150, 39, 44, 38, 14, 151, 6, 32, 31, 54, 55}

func fields(message *quickfix.Message) string {
	var out strings.Builder
	for _, tag := range observedTags {
		value, err := message.Header.GetString(tag)
		if err != nil {
			value, err = message.Body.GetString(tag)
		}
		if err == nil {
			fmt.Fprintf(&out, "%d=%s\x01", tag, value)
		}
	}
	return out.String()
}

const profileGuardName = "matching-testreq-v1"

type application struct {
	id           quickfix.SessionID
	guard        *responseGuard
	now          func() time.Time
	guardFailure chan struct{}
}

func newApplication() *application {
	return &application{guard: newResponseGuard(), now: time.Now, guardFailure: make(chan struct{}, 1)}
}
func (a *application) OnCreate(id quickfix.SessionID) { a.id = id; event("CREATE", "") }
func (a *application) OnLogon(id quickfix.SessionID)  { a.guard.reset(); event("LOGON", "") }
func (a *application) OnLogout(id quickfix.SessionID) { a.guard.reset(); event("LOGOUT", "") }
func (a *application) ToAdmin(m *quickfix.Message, id quickfix.SessionID) {
	msgType, _ := m.Header.GetString(35)
	if msgType == "1" {
		requestID, err := m.Body.GetString(112)
		if err != nil || !a.guard.request(a.now(), requestID) {
			event("ERROR", "PROFILE_REQUEST")
			select {
			case a.guardFailure <- struct{}{}:
			default:
			}
		} else {
			event("PROFILE_REQUEST", "112="+requestID+"\x01")
		}
	}
	event("ADMIN_OUT", fields(m))
}
func (a *application) FromAdmin(m *quickfix.Message, id quickfix.SessionID) quickfix.MessageRejectError {
	event("ADMIN_IN", fields(m))
	msgType, _ := m.Header.GetString(35)
	if msgType == "0" {
		requestID, idError := m.Body.GetString(112)
		sentAt, timeError := m.Header.GetTime(52)
		if idError == nil && timeError == nil && a.guard.acknowledge(a.now(), requestID, sentAt) {
			event("PROFILE_ACK", "112="+requestID+"\x01")
		}
	}
	return nil
}
func (a *application) ToApp(m *quickfix.Message, id quickfix.SessionID) error {
	event("APP_OUT", fields(m))
	return nil
}
func (a *application) FromApp(m *quickfix.Message, id quickfix.SessionID) quickfix.MessageRejectError {
	if selectedLiveOutput != nil {
		event("LIVE_APP", m.String())
	} else {
		event("APP", fields(m))
	}
	return nil
}

func commandMessage(encoded string) (*quickfix.Message, error) {
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(data) > 8192 {
		return nil, fmt.Errorf("COMMAND")
	}
	msg := quickfix.NewMessage()
	seen := map[int]bool{}
	for _, part := range strings.Split(string(data), "\x01") {
		if part == "" {
			continue
		}
		pair := strings.SplitN(part, "=", 2)
		if len(pair) != 2 || len(pair[0]) > 5 || len(pair[1]) < 1 || len(pair[1]) > 256 {
			return nil, fmt.Errorf("COMMAND")
		}
		tag, err := strconv.Atoi(pair[0])
		if err != nil || tag < 1 || seen[tag] || len(seen) >= 61 {
			return nil, fmt.Errorf("COMMAND")
		}
		for _, b := range []byte(pair[1]) {
			if b < 32 || b > 126 {
				return nil, fmt.Errorf("COMMAND")
			}
		}
		seen[tag] = true
		if tag == 35 {
			msg.Header.SetString(35, pair[1])
		} else {
			switch tag {
			case 8, 9, 10, 34, 43, 49, 52, 56, 122:
				return nil, fmt.Errorf("COMMAND")
			}
			msg.Body.SetString(quickfix.Tag(tag), pair[1])
		}
	}
	t, err := msg.Header.GetString(35)
	if err != nil {
		return nil, fmt.Errorf("COMMAND")
	}
	switch t {
	case "D", "8", "F", "9", "0", "1":
		return msg, nil
	}
	return nil, fmt.Errorf("COMMAND")
}

type commandInput struct {
	line string
	err  error
}

func readCommands(out chan<- commandInput) {
	defer close(out)
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), 12000)
	for scanner.Scan() {
		out <- commandInput{line: scanner.Text()}
	}
	if scanner.Err() != nil {
		out <- commandInput{err: fmt.Errorf("COMMAND_BOUND")}
	}
}

func run() error {
	if len(os.Args) != 2 {
		return fmt.Errorf("CONFIG")
	}
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return fmt.Errorf("BUILD_METADATA")
	}
	engine := ""
	for _, dependency := range info.Deps {
		if dependency.Path == "github.com/quickfixgo/quickfix" && dependency.Replace == nil {
			engine = dependency.Version
		}
	}
	if engine != "v0.9.12" || runtime.Version() != "go1.27.3" {
		return fmt.Errorf("BUILD_METADATA")
	}
	event("VERSION", "engine="+engine+"\x01toolchain="+runtime.Version()+"\x01profile_guard="+profileGuardName+"\x01")
	file, err := os.Open(os.Args[1])
	if err != nil {
		return err
	}
	defer file.Close()
	settings, err := quickfix.ParseSettings(file)
	if err != nil {
		return err
	}
	sessions := settings.SessionSettings()
	if len(sessions) != 1 {
		return fmt.Errorf("CONFIG")
	}
	selectedLive := false
	for id, cfg := range sessions {
		if cfg.HasSetting("TradeFlowIngressProfile") {
			value, err := cfg.Setting("TradeFlowIngressProfile")
			if err != nil || value != "live-fix-ingress-v1" {
				return fmt.Errorf("CONFIG")
			}
			selectedLive = true
		}
		if id.BeginString != "FIX.4.4" || id.SenderCompID != "ATLAS" || id.TargetCompID != "TRADEFLOW" {
			return fmt.Errorf("CONFIG")
		}
		required := map[string]string{"SocketAcceptHost": "127.0.0.1", "SocketAcceptPort": "19876", "ResetOnLogon": "N", "ResetOnLogout": "N", "ResetOnDisconnect": "N", "RefreshOnLogon": "Y", "PersistMessages": "Y", "FileStoreSync": "Y", "UseDataDictionary": "Y", "CheckLatency": "Y", "MaxLatency": "120", "TradeFlowResponseGuard": profileGuardName}
		for key, value := range required {
			got, e := cfg.Setting(key)
			if e != nil || got != value {
				return fmt.Errorf("CONFIG")
			}
		}
		// In this pinned Go engine, absent time bounds mean no session schedule.
		for _, key := range []string{"StartTime", "EndTime", "StartDay", "EndDay", "Weekdays", "ResetSeqTime", "NonStopSession"} {
			if cfg.HasSetting(key) {
				return fmt.Errorf("CONFIG")
			}
		}
	}
	if selectedLive {
		selectedLiveOutput = newLiveEvents(os.Stdout)
		selectedLiveFailure = selectedLiveOutput.failed
		defer selectedLiveOutput.close()
		event("LIVE_PROFILE", "profile=live-fix-ingress-v1\x01")
	}
	app := newApplication()
	acceptor, err := quickfix.NewAcceptor(app, filestore.NewStoreFactory(settings), settings, quickfix.NewNullLogFactory())
	if err != nil {
		return err
	}
	if err = acceptor.Start(); err != nil {
		return err
	}
	var stop sync.Once
	finish := func() { stop.Do(func() { acceptor.Stop() }) }
	defer finish()
	event("READY", "")
	input := make(chan commandInput, 1)
	go readCommands(input)
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case item, ok := <-input:
			if !ok {
				return nil
			}
			if item.err != nil {
				return item.err
			}
			parts := strings.SplitN(item.line, "\t", 2)
			switch parts[0] {
			case "SEND":
				if len(parts) != 2 {
					return fmt.Errorf("COMMAND")
				}
				m, e := commandMessage(parts[1])
				if e != nil {
					return e
				}
				if e = quickfix.SendToTarget(m, app.id); e != nil {
					return e
				}
				event("SENT", "")
			case "STATE":
				sender, e := quickfix.GetExpectedSenderNum(app.id)
				if e != nil {
					return e
				}
				target, e := quickfix.GetExpectedTargetNum(app.id)
				if e != nil {
					return e
				}
				event("STATE", fmt.Sprintf("sender=%d\x01target=%d\x01", sender, target))
			case "LOGOUT":
				finish()
			case "STOP":
				finish()
				event("STOPPED", "")
				return nil
			default:
				return fmt.Errorf("COMMAND")
			}
		case <-ticker.C:
			if requestID, expired := app.guard.expire(app.now()); expired {
				event("PROFILE_TIMEOUT", "112="+requestID+"\x01")
				finish()
			}
		case <-selectedLiveFailure:
			return fmt.Errorf("LIVE_OUTPUT")
		case <-app.guardFailure:
			return fmt.Errorf("PROFILE_REQUEST")
		}
	}
}
func main() {
	if run() != nil {
		event("ERROR", "RUNTIME_COMMAND_OR_STARTUP")
		os.Exit(2)
	}
}
