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

 "github.com/quickfixgo/quickfix"
 filestore "github.com/quickfixgo/quickfix/store/file"
)

var outputMu sync.Mutex
func event(kind, payload string) {
 outputMu.Lock(); defer outputMu.Unlock()
 fmt.Printf("EVENT\t%s\t%s\n", kind, base64.StdEncoding.EncodeToString([]byte(payload)))
}
var observedTags=[]quickfix.Tag{35,34,49,56,43,52,122,112,7,16,36,123,141,11,41,37,17,150,39,44,38,14,151,6,32,31,54,55}
func fields(message *quickfix.Message) string {
 var out strings.Builder
 for _,tag:=range observedTags {
  value,err:=message.Header.GetString(tag)
  if err!=nil {value,err=message.Body.GetString(tag)}
  if err==nil {fmt.Fprintf(&out,"%d=%s\x01",tag,value)}
 }
 return out.String()
}
type application struct {id quickfix.SessionID}
func(a *application) OnCreate(id quickfix.SessionID){a.id=id;event("CREATE","")}
func(a *application) OnLogon(id quickfix.SessionID){event("LOGON","")}
func(a *application) OnLogout(id quickfix.SessionID){event("LOGOUT","")}
func(a *application) ToAdmin(m *quickfix.Message,id quickfix.SessionID){event("ADMIN_OUT",fields(m))}
func(a *application) FromAdmin(m *quickfix.Message,id quickfix.SessionID) quickfix.MessageRejectError {event("ADMIN_IN",fields(m));return nil}
func(a *application) ToApp(m *quickfix.Message,id quickfix.SessionID) error {event("APP_OUT",fields(m));return nil}
func(a *application) FromApp(m *quickfix.Message,id quickfix.SessionID) quickfix.MessageRejectError {event("APP",fields(m));return nil}

func commandMessage(encoded string)(*quickfix.Message,error){
 data,err:=base64.StdEncoding.DecodeString(encoded)
 if err!=nil||len(data)>8192{return nil,fmt.Errorf("COMMAND")}
 msg:=quickfix.NewMessage();seen:=map[int]bool{}
 for _,part:=range strings.Split(string(data),"\x01") {
  if part=="" {continue}
  pair:=strings.SplitN(part,"=",2)
  if len(pair)!=2||len(pair[0])>5||len(pair[1])<1||len(pair[1])>256{return nil,fmt.Errorf("COMMAND")}
  tag,err:=strconv.Atoi(pair[0]);if err!=nil||tag<1||seen[tag]||len(seen)>=61{return nil,fmt.Errorf("COMMAND")}
  for _,b:=range []byte(pair[1]){if b<32||b>126{return nil,fmt.Errorf("COMMAND")}}
  seen[tag]=true
  if tag==35 {msg.Header.SetString(35,pair[1])} else {
   switch tag {case 8,9,10,34,43,49,52,56,122:return nil,fmt.Errorf("COMMAND")}
   msg.Body.SetString(quickfix.Tag(tag),pair[1])
  }
 }
 t,err:=msg.Header.GetString(35);if err!=nil{return nil,fmt.Errorf("COMMAND")}
 switch t {case "D","8","F","9","0","1":return msg,nil}
 return nil,fmt.Errorf("COMMAND")
}
func run() error {
 if len(os.Args)!=2{return fmt.Errorf("CONFIG")}
 info,ok:=debug.ReadBuildInfo();if !ok{return fmt.Errorf("BUILD_METADATA")}
 engine:=""
 for _,dependency:=range info.Deps {if dependency.Path=="github.com/quickfixgo/quickfix"&&dependency.Replace==nil{engine=dependency.Version}}
 if engine!="v0.9.12"||runtime.Version()!="go1.27.3" {return fmt.Errorf("BUILD_METADATA")}
 event("VERSION","engine="+engine+"\x01toolchain="+runtime.Version()+"\x01")
 file,err:=os.Open(os.Args[1]);if err!=nil{return err};defer file.Close()
 settings,err:=quickfix.ParseSettings(file);if err!=nil{return err}
 sessions:=settings.SessionSettings();if len(sessions)!=1{return fmt.Errorf("CONFIG")}
 for id,cfg:=range sessions {
  if id.BeginString!="FIX.4.4"||id.SenderCompID!="ATLAS"||id.TargetCompID!="TRADEFLOW"{return fmt.Errorf("CONFIG")}
  required:=map[string]string{"SocketAcceptHost":"127.0.0.1","SocketAcceptPort":"19876","ResetOnLogon":"N","ResetOnLogout":"N","ResetOnDisconnect":"N","RefreshOnLogon":"Y","PersistMessages":"Y","FileStoreSync":"Y","UseDataDictionary":"Y"}
  for key,value:=range required {got,e:=cfg.Setting(key);if e!=nil||got!=value{return fmt.Errorf("CONFIG")}}
  // In this pinned Go engine, absent time bounds mean no session schedule.
  for _,key:=range []string{"StartTime","EndTime","StartDay","EndDay","Weekdays","ResetSeqTime","NonStopSession"}{if cfg.HasSetting(key){return fmt.Errorf("CONFIG")}}
 }
 app:=&application{}
 acceptor,err:=quickfix.NewAcceptor(app,filestore.NewStoreFactory(settings),settings,quickfix.NewNullLogFactory())
 if err!=nil{return err}
 if err=acceptor.Start();err!=nil{return err}
 var stop sync.Once
 finish:=func(){stop.Do(func(){acceptor.Stop()})}
 defer finish()
 event("READY","")
 scanner:=bufio.NewScanner(os.Stdin);scanner.Buffer(make([]byte,4096),12000)
 for scanner.Scan(){
  parts:=strings.SplitN(scanner.Text(),"\t",2)
  switch parts[0]{
  case "SEND":
   if len(parts)!=2{return fmt.Errorf("COMMAND")}
   m,e:=commandMessage(parts[1]);if e!=nil{return e};if e=quickfix.SendToTarget(m,app.id);e!=nil{return e};event("SENT","")
  case "STATE":
   sender,e:=quickfix.GetExpectedSenderNum(app.id);if e!=nil{return e};target,e:=quickfix.GetExpectedTargetNum(app.id);if e!=nil{return e}
   event("STATE",fmt.Sprintf("sender=%d\x01target=%d\x01",sender,target))
  case "LOGOUT":finish()
  case "STOP":finish();event("STOPPED","");return nil
  default:return fmt.Errorf("COMMAND")
  }
 }
 return scanner.Err()
}
func main(){if run()!=nil{event("ERROR","RUNTIME_COMMAND_OR_STARTUP");os.Exit(2)}}
