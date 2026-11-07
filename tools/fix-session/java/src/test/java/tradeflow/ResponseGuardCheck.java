package tradeflow;

import java.time.Instant;
import java.util.List;

/** Standard-library checks, executed explicitly during the locked image build. */
public final class ResponseGuardCheck {
    private static final Instant EPOCH=Instant.parse("2026-11-07T00:00:00Z");
    private static long nano(int seconds){return seconds*1_000_000_000L;}
    private static Instant wall(int seconds){return EPOCH.plusSeconds(seconds);}
    private static void require(boolean value,String reason){if(!value)throw new AssertionError(reason);}
    private static void ordinaryAndWrongID(){
        for(String id:List.of("","OTHER")){
            ResponseGuard guard=new ResponseGuard();require(guard.request(nano(0),"REQ"),"request");
            require(!guard.acknowledge(nano(1),wall(1),id,wall(1)),"nonmatching response");
            require("REQ".equals(guard.expire(nano(36))),"original timeout");
            require(guard.expire(nano(37))==null,"duplicate timeout");
        }
    }
    private static void justBefore(){
        ResponseGuard guard=new ResponseGuard();guard.request(nano(0),"REQ");
        require(guard.acknowledge(35_999_999_999L,EPOCH.plusNanos(35_999_999_999L),"REQ",wall(35)),"just before deadline");
        require(guard.expire(nano(36))==null,"answered timeout");
    }
    private static void atAndAfter(){
        for(int second:List.of(36,37)){
            ResponseGuard guard=new ResponseGuard();guard.request(nano(0),"REQ");
            require(!guard.acknowledge(nano(second),wall(second),"REQ",wall(second)),"late response");
            require("REQ".equals(guard.expire(nano(second))),"late expiry");
            require(!guard.acknowledge(nano(35),wall(35),"REQ",wall(35)),"revival");
        }
    }
    private static void repeated(){
        ResponseGuard guard=new ResponseGuard();guard.request(nano(0),"REQ");
        require(guard.request(nano(35),"REQ"),"same observation");
        require("REQ".equals(guard.expire(nano(36))),"deadline extension");
    }
    private static void competing(){
        ResponseGuard guard=new ResponseGuard();guard.request(nano(0),"REQ");
        require(!guard.request(nano(1),"OTHER"),"competing request");
        require("REQ".equals(guard.expire(nano(1))),"conflict closure");
    }
    private static void idBounds(){
        for(String id:List.of("","x".repeat(257),"A\u0001B","A\u00ffB"))
            require(!new ResponseGuard().request(nano(0),id),"invalid ID");
        require(new ResponseGuard().request(nano(0),"x".repeat(256)),"256-byte ID");
    }
    private static void freshness(){
        for(Instant sent:new Instant[]{wall(81),wall(321),null}){
            ResponseGuard guard=new ResponseGuard();guard.request(nano(200),"REQ");
            require(!guard.acknowledge(nano(201),wall(201),"REQ",sent),"stale/future response");
            require("REQ".equals(guard.expire(nano(236))),"freshness timeout");
        }
        ResponseGuard guard=new ResponseGuard();guard.request(nano(200),"REQ");
        require(guard.acknowledge(nano(201),wall(201),"REQ",wall(82)),"fresh response");
    }
    private static void reconnect(){
        ResponseGuard guard=new ResponseGuard();guard.request(nano(0),"REQ");guard.reset();
        require(guard.expire(nano(36))==null,"disconnected timer");
        require(!guard.acknowledge(nano(1),wall(1),"REQ",wall(1)),"manufactured ack");
        require(guard.request(nano(40),"NEW"),"new request");
        require("NEW".equals(guard.expire(nano(76))),"new deadline");
    }
    public static void main(String[] args){
        List<Runnable> checks=List.of(ResponseGuardCheck::ordinaryAndWrongID,ResponseGuardCheck::justBefore,ResponseGuardCheck::atAndAfter,ResponseGuardCheck::repeated,ResponseGuardCheck::competing,ResponseGuardCheck::idBounds,ResponseGuardCheck::freshness,ResponseGuardCheck::reconnect);
        require(checks.size()==8,"guard check discovery");
        for(Runnable check:checks)check.run();
        System.out.println("Java response guard: "+checks.size()+" checks passed");
    }
}
