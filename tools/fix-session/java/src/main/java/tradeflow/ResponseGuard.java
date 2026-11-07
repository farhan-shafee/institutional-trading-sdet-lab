package tradeflow;

import java.time.Duration;
import java.time.Instant;

/** Explicit profile policy around the unchanged engine, with no wire rewriting. */
final class ResponseGuard {
    static final String NAME="matching-testreq-v1";
    private static final long RESPONSE_NANOS=36_000_000_000L;
    private static final Duration MAX_AGE=Duration.ofSeconds(120);
    private String id;
    private long started;
    private boolean pending;
    private boolean timedOut;

    synchronized boolean request(long now,String requestID){
        boolean valid=requestID!=null&&!requestID.isEmpty()&&requestID.length()<=256;
        if(valid)for(int i=0;i<requestID.length();i++)
            if(requestID.charAt(i)<32||requestID.charAt(i)>126){valid=false;break;}
        if(!valid){if(pending)started=now-RESPONSE_NANOS;return false;}
        if(pending){
            if(!id.equals(requestID)){started=now-RESPONSE_NANOS;return false;}
            return true;
        }
        id=requestID;started=now;pending=true;timedOut=false;return true;
    }

    synchronized boolean acknowledge(long now,Instant wallNow,String responseID,Instant sentAt){
        long elapsed=now-started;
        if(!pending||timedOut||!id.equals(responseID)||elapsed<0||elapsed>=RESPONSE_NANOS||wallNow==null||sentAt==null)return false;
        Duration age=Duration.between(sentAt,wallNow);
        if(age.compareTo(MAX_AGE)>=0||age.compareTo(MAX_AGE.negated())<=0)return false;
        id=null;started=0;pending=false;return true;
    }

    synchronized String expire(long now){
        if(!pending||timedOut||now-started<RESPONSE_NANOS)return null;
        timedOut=true;return id;
    }

    synchronized void reset(){id=null;started=0;pending=false;timedOut=false;}
}
