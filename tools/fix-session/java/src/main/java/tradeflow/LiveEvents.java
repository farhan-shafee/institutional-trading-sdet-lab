package tradeflow;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.concurrent.ArrayBlockingQueue;

/** Selected wrapper output: callbacks queue or fail, never wait for the pipe. */
final class LiveEvents implements AutoCloseable {
    private final ArrayBlockingQueue<byte[]> queue=new ArrayBlockingQueue<>(16);
    private final Thread writer;
    private volatile boolean stopped;
    private volatile boolean failed;
    LiveEvents(OutputStream output){
        writer=new Thread(()->{
            try{
                while(!stopped){
                    byte[] line=queue.take();output.write(line);output.flush();
                    if(output instanceof PrintStream stream&&stream.checkError()){failed=true;return;}
                }
            }catch(InterruptedException error){if(!stopped)failed=true;Thread.currentThread().interrupt();}
            catch(IOException error){if(!stopped)failed=true;}
        },"selected-live-events");
        writer.setDaemon(true);writer.start();
    }
    boolean emit(String kind,String payload){
        if(stopped||failed)return false;
        if(kind==null||payload==null||!kind.matches("[A-Z_]{1,32}")||payload.length()>8192){failed=true;return false;}
        for(int i=0;i<payload.length();i++){
            char value=payload.charAt(i);
            if(value>126||(value<32&&value!=1)){failed=true;return false;}
        }
        String line="EVENT\t"+kind+"\t"+Base64.getEncoder().encodeToString(payload.getBytes(StandardCharsets.US_ASCII))+"\n";
        if(!queue.offer(line.getBytes(StandardCharsets.US_ASCII))){failed=true;return false;}
        return true;
    }
    boolean failed(){return failed;}
    public void close(){stopped=true;writer.interrupt();}
}
