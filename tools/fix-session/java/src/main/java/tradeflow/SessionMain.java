package tradeflow;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.time.*;
import java.time.format.*;
import java.time.temporal.ChronoField;
import java.util.*;
import java.util.concurrent.*;
import quickfix.*;

/** Opt-in, synthetic local initiator. No HTTP, database or financial application. */
public final class SessionMain implements Application {
    private volatile SessionID id;
    private static volatile LiveEvents selectedLiveOutput;
    private final ResponseGuard guard=new ResponseGuard();
    private volatile boolean invalidRequest;
    private static final DateTimeFormatter SENDING_TIME=new DateTimeFormatterBuilder().appendPattern("uuuuMMdd-HH:mm:ss").optionalStart().appendFraction(ChronoField.NANO_OF_SECOND,3,9,true).optionalEnd().toFormatter(Locale.ROOT).withResolverStyle(ResolverStyle.STRICT);
    private static final int[] FIELDS={35,34,49,56,43,52,122,112,7,16,36,123,141,11,41,37,17,150,39,44,38,14,151,6,32,31,54,55};
    private static void event(String kind,String payload){
        if(selectedLiveOutput!=null){selectedLiveOutput.emit(kind,payload);return;}
        synchronized(SessionMain.class){
            System.out.println("EVENT\t"+kind+"\t"+Base64.getEncoder().encodeToString(payload.getBytes(StandardCharsets.US_ASCII)));
            System.out.flush();
        }
    }
    private static String fields(Message message){
        StringBuilder out=new StringBuilder();
        for(int tag:FIELDS){
            FieldMap map=message.getHeader().isSetField(tag)?message.getHeader():message;
            if(map.isSetField(tag))try{out.append(tag).append('=').append(map.getString(tag)).append('\u0001');}catch(FieldNotFound ignored){}
        }
        return out.toString();
    }
    public void onCreate(SessionID session){id=session;event("CREATE","");}
    public void onLogon(SessionID session){guard.reset();event("LOGON","");}
    public void onLogout(SessionID session){guard.reset();event("LOGOUT","");}
    public void toAdmin(Message message,SessionID session){
        try{
            if("1".equals(message.getHeader().getString(35))){
                String requestID=message.getString(112);
                if(!guard.request(System.nanoTime(),requestID)){invalidRequest=true;event("ERROR","PROFILE_REQUEST");}
                else event("PROFILE_REQUEST","112="+requestID+"\u0001");
            }
        }catch(FieldNotFound error){invalidRequest=true;event("ERROR","PROFILE_REQUEST");}
        event("ADMIN_OUT",fields(message));
    }
    public void fromAdmin(Message message,SessionID session){
        event("ADMIN_IN",fields(message));
        try{
            if("0".equals(message.getHeader().getString(35))&&message.isSetField(112)){
                String requestID=message.getString(112);
                Instant sentAt=LocalDateTime.parse(message.getHeader().getString(52),SENDING_TIME).toInstant(ZoneOffset.UTC);
                if(guard.acknowledge(System.nanoTime(),Instant.now(),requestID,sentAt))event("PROFILE_ACK","112="+requestID+"\u0001");
            }
        }catch(FieldNotFound|DateTimeException ignored){}
    }
    public void toApp(Message message,SessionID session){event("APP_OUT",fields(message));}
    public void fromApp(Message message,SessionID session){
        if(selectedLiveOutput!=null){
            String raw=message.toRawString();
            if(raw==null){invalidRequest=true;event("ERROR","LIVE_RAW_REQUIRED");return;}
            event("LIVE_APP",raw);
        }else event("APP",fields(message));
    }

    private static final class QuietLog implements Log {
        public void clear(){}
        public void onIncoming(String value){}
        public void onOutgoing(String value){}
        public void onEvent(String value){}
        public void onErrorEvent(String value){event("ENGINE_ERROR","");}
    }
    private static final class QuietFactory implements LogFactory {
        public Log create(SessionID session){return new QuietLog();}
    }
    private static void require(SessionSettings settings,SessionID id,String key,String expected) throws ConfigError {
        if(!settings.getString(id,key).equals(expected))throw new ConfigError("LOCAL_PROFILE_REQUIRED");
    }
    private static Message commandMessage(String encoded){
        byte[] bytes=Base64.getDecoder().decode(encoded);
        if(bytes.length>8192)throw new IllegalArgumentException();
        String payload=new String(bytes,StandardCharsets.US_ASCII);
        Message message=new Message();
        Set<Integer> seen=new HashSet<>();
        for(String part:payload.split("\u0001")){
            int sep=part.indexOf('=');
            if(sep<1||!part.substring(0,sep).matches("[1-9][0-9]{0,4}"))throw new IllegalArgumentException();
            int tag=Integer.parseInt(part.substring(0,sep));String value=part.substring(sep+1);
            if(!value.matches("[\\x20-\\x7e]{1,256}")||!seen.add(tag)||seen.size()>61)throw new IllegalArgumentException();
            if(tag==35)message.getHeader().setString(tag,value);
            else {
                if(Set.of(8,9,10,34,43,49,52,56,122).contains(tag))throw new IllegalArgumentException();
                message.setString(tag,value);
            }
        }
        try{if(!Set.of("D","8","F","9","0","1").contains(message.getHeader().getString(35)))throw new IllegalArgumentException();}
        catch(FieldNotFound error){throw new IllegalArgumentException();}
        return message;
    }
    private record InputCommand(String line,boolean eof,boolean invalid){}
    private static void readCommands(BlockingQueue<InputCommand> output){
        try{
            BufferedReader input=new BufferedReader(new InputStreamReader(System.in,StandardCharsets.US_ASCII));
            for(;;){
                StringBuilder line=new StringBuilder();int next;
                while((next=input.read())!=-1&&next!='\n'){
                    if(line.length()>=12000){output.put(new InputCommand("",false,true));return;}
                    line.append((char)next);
                }
                if(next==-1&&line.isEmpty()){output.put(new InputCommand("",true,false));return;}
                if(!line.isEmpty()&&line.charAt(line.length()-1)=='\r')line.setLength(line.length()-1);
                output.put(new InputCommand(line.toString(),false,false));
                if(next==-1){output.put(new InputCommand("",true,false));return;}
            }
        }catch(IOException error){
            try{output.put(new InputCommand("",false,true));}catch(InterruptedException interrupted){Thread.currentThread().interrupt();}
        }catch(InterruptedException interrupted){Thread.currentThread().interrupt();}
    }
    private static void run(String[] args) throws Exception {
            if(args.length!=1)throw new IllegalArgumentException();
            Properties metadata=new Properties();
            try(InputStream manifest=Session.class.getResourceAsStream("/META-INF/maven/org.quickfixj/quickfixj-core/pom.properties")){
                if(manifest==null)throw new IllegalArgumentException();
                metadata.load(manifest);
            }
            String engine=metadata.getProperty("version");
            if(!"3.0.2".equals(engine))throw new IllegalArgumentException();
            event("VERSION","engine="+engine+"\u0001toolchain="+Runtime.version()+"\u0001profile_guard="+ResponseGuard.NAME+"\u0001");
            SessionSettings settings=new SessionSettings(args[0]);
            Iterator<SessionID> ids=settings.sectionIterator();
            if(!ids.hasNext())throw new ConfigError("ONE_SESSION_REQUIRED");
            SessionID sessionID=ids.next();if(ids.hasNext())throw new ConfigError("ONE_SESSION_REQUIRED");
            require(settings,sessionID,"ConnectionType","initiator");
            require(settings,sessionID,"BeginString","FIX.4.4");
            require(settings,sessionID,"SenderCompID","TRADEFLOW");require(settings,sessionID,"TargetCompID","ATLAS");
            require(settings,sessionID,"SocketConnectHost","127.0.0.1");require(settings,sessionID,"SocketConnectPort","19875");
            require(settings,sessionID,"HeartBtInt","30");require(settings,sessionID,"NonStopSession","Y");
            for(String key:List.of("ResetOnLogon","ResetOnLogout","ResetOnDisconnect","ResetOnError"))require(settings,sessionID,key,"N");
            require(settings,sessionID,"FileStoreSync","Y");require(settings,sessionID,"PersistMessages","Y");
            require(settings,sessionID,"UseDataDictionary","Y");require(settings,sessionID,"ValidateChecksum","Y");
            require(settings,sessionID,"CheckLatency","Y");require(settings,sessionID,"MaxLatency","120");
            require(settings,sessionID,"TradeFlowResponseGuard",ResponseGuard.NAME);
            if(settings.isSetting(sessionID,"TradeFlowIngressProfile")){
                require(settings,sessionID,"TradeFlowIngressProfile","live-fix-ingress-v1");
                selectedLiveOutput=new LiveEvents(System.out);event("LIVE_PROFILE","profile=live-fix-ingress-v1\u0001");
            }
            SessionMain app=new SessionMain();
            SocketInitiator initiator=new SocketInitiator(app,new FileStoreFactory(settings),settings,new QuietFactory(),new DefaultMessageFactory());
            try{
                initiator.start();event("READY","");
                BlockingQueue<InputCommand> input=new ArrayBlockingQueue<>(1);
                Thread reader=new Thread(()->readCommands(input),"synthetic-command-input");reader.setDaemon(true);reader.start();
                boolean timedOut=false;
                for(;;){
                    if(app.invalidRequest||(selectedLiveOutput!=null&&selectedLiveOutput.failed()))throw new IllegalArgumentException();
                    String expired=app.guard.expire(System.nanoTime());
                    if(!timedOut&&expired!=null){event("PROFILE_TIMEOUT","112="+expired+"\u0001");initiator.stop(true);timedOut=true;}
                    InputCommand command=input.poll(10,TimeUnit.MILLISECONDS);
                    if(command==null)continue;
                    if(command.invalid())throw new IllegalArgumentException();
                    if(command.eof())return;
                    String[] parts=command.line().split("\t",2);
                    Session session=Session.lookupSession(app.id);
                    switch(parts[0]){
                        case "SEND" -> {if(parts.length!=2||!Session.sendToTarget(commandMessage(parts[1]),app.id))throw new IllegalArgumentException();event("SENT","");}
                        case "STATE" -> event("STATE","sender="+session.getExpectedSenderNum()+"\u0001target="+session.getExpectedTargetNum()+"\u0001");
                        case "LOGOUT" -> session.logout("SYNTHETIC_STOP");
                        case "STOP" -> {initiator.stop(true);event("STOPPED","");return;}
                        default -> throw new IllegalArgumentException();
                    }
                }
            }finally{initiator.stop(true);if(selectedLiveOutput!=null)selectedLiveOutput.close();}
    }
    public static void main(String[] args){
        try{run(args);}catch(Exception error){event("ERROR","RUNTIME_COMMAND_OR_STARTUP");System.exit(2);}
    }
}
