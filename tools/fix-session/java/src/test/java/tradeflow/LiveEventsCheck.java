package tradeflow;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

/** Wrapper controls only. Actual engine callback proof belongs to the live gate. */
public final class LiveEventsCheck {
    private static void require(boolean value,String message){if(!value)throw new AssertionError(message);}
    public static void main(String[] args) throws Exception {
        ByteArrayOutputStream captured=new ByteArrayOutputStream();
        LiveEvents events=new LiveEvents(captured);
        String payload="35=8\u000159=1\u000160=20261107-12:00:00.000\u0001";
        require(events.emit("LIVE_APP",payload),"callback was not queued");
        long deadline=System.nanoTime()+250_000_000L;
        while(captured.size()==0&&System.nanoTime()<deadline)Thread.onSpinWait();
        String want="EVENT\tLIVE_APP\t"+Base64.getEncoder().encodeToString(payload.getBytes(StandardCharsets.US_ASCII))+"\n";
        require(captured.toString(StandardCharsets.US_ASCII).equals(want),"callback payload changed");
        events.close();require(!events.emit("LIVE_APP","later"),"stopped output admitted callback");

        try(PipedInputStream input=new PipedInputStream(1);PipedOutputStream output=new PipedOutputStream(input)){
            output.write(1);
            LiveEvents full=new LiveEvents(output);
            long started=System.nanoTime();
            for(int i=0;i<64;i++)full.emit("LIVE_APP","x".repeat(8192));
            full.close();
            require(System.nanoTime()-started<250_000_000L,"full pipe blocked callback/stop");
            require(full.failed(),"overflow failure was not retained");
        }
        LiveEvents oversized=new LiveEvents(new ByteArrayOutputStream());
        require(!oversized.emit("LIVE_APP","x".repeat(8193)),"oversize callback admitted");
        require(oversized.failed(),"oversize failure was not retained");oversized.close();
        System.out.println("JAVA_LIVE_EVENTS_OK");
    }
}
