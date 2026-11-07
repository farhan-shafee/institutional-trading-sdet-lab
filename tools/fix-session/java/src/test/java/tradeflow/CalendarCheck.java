package tradeflow;

import java.lang.reflect.Method;
import java.time.Instant;
import java.util.Calendar;
import java.util.Date;
import java.util.TimeZone;
import quickfix.*;

/** Literal schedule boundary control; separate test process, never runtime wire. */
public final class CalendarCheck {
    public static void main(String[] args) throws Exception {
        SessionID id=new SessionID("FIX.4.4","TRADEFLOW","ATLAS");
        SessionSettings settings=new SessionSettings();
        settings.setString(id,"ConnectionType","initiator");
        settings.setString(id,"NonStopSession","Y");
        settings.setString(id,"UseDataDictionary","N");
        settings.setString(id,"HeartBtInt","30");
        settings.setString(id,"ResetOnLogon","N");
        settings.setString(id,"ResetOnLogout","N");
        settings.setString(id,"ResetOnDisconnect","N");
        long before=Instant.parse("2026-11-07T23:59:59.999Z").toEpochMilli();
        long after=Instant.parse("2026-11-08T00:00:00Z").toEpochMilli();
        MemoryStore store=new MemoryStore(){public Date getCreationTime(){return new Date(before);}};
        for(int i=0;i<6;i++)store.incrNextSenderMsgSeqNum();
        for(int i=0;i<8;i++)store.incrNextTargetMsgSeqNum();
        DefaultSessionSchedule schedule=new DefaultSessionSchedule(settings,id);
        Calendar first=Calendar.getInstance(TimeZone.getTimeZone("UTC"));first.setTimeInMillis(before);
        Calendar second=Calendar.getInstance(TimeZone.getTimeZone("UTC"));second.setTimeInMillis(after);
        if(!schedule.isNonStopSession()||!schedule.isSameSession(first,second))throw new AssertionError("CALENDAR_SCHEDULE");
        Session session=new DefaultSessionFactory(new SessionMain(),unused->store,new ScreenLogFactory(false,false,false)).create(id,settings);
        try {
            Method current=Session.class.getDeclaredMethod("isCurrentSession",long.class);current.setAccessible(true);
            for(long time:new long[]{before,after,after+86400000L}) {
                if(!Boolean.TRUE.equals(current.invoke(session,time)))throw new AssertionError("CALENDAR_RANGE");
                session.next();
                if(store.getNextSenderMsgSeqNum()!=7||store.getNextTargetMsgSeqNum()!=9)throw new AssertionError("CALENDAR_RESET");
            }
        } finally {session.close();}
        System.out.println("CALENDAR java=3.0.2 sender=7 target=9 day_boundaries=2 production_edits=0");
    }
}
