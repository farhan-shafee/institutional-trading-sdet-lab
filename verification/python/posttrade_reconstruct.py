"""Independent immutable post-trade history/event reconstruction. No application imports."""
from collections import defaultdict
from decimal import Decimal, localcontext, ROUND_HALF_EVEN
from fractions import Fraction
from datetime import date, datetime, timedelta
import json,sys
from posttrade_assessment import assess,digest,money
from fifo import IDS,VERSIONS

def reconstruct(r):
    assert set(r)=={'version','kind','scope','source','assessment','history','events','report_id'}
    assert r['version']==1 and r['kind']=='OWNED_POSTTRADE_REPORT_V1' and r['scope']=='LOCAL_SYNTHETIC_ONLY'
    assert digest({k:v for k,v in r.items() if k!='report_id'})==r['report_id']
    s=r['source'];a=r['assessment'];history=r['history'];events=r['events']
    assert a['status']=='AVAILABLE' and s['coverage']=={'complete':True,'reasons':[]}
    assert len(history)==len(s['roots'])==s['raw_execution_count']<=8
    assert int(s['posttrade_command_seq'])<=97 and len(events)<=161
    roots={x['execution_id']:x for x in s['roots']}
    assert len(roots)==len(history)
    expected={1:[('FUNDING',None,None,0,Fraction(0),10000000000,Fraction(0))]}
    processing=[];adjustments=[];failed_total=0
    def leg(kind,root,econ_cash=0,econ_par=Fraction(0),cash=0,par=Fraction(0)):
        return (kind,root['execution_id'],root['definition_version'],econ_cash,econ_par,cash,par)
    for h in history:
        x=h['original_execution'];root=roots[x['execution_id']]
        for left,right in [('execution_id','execution_id'),('raw_command_seq','command_seq'),('instrument_id','instrument_id'),('definition_version','definition_version'),('side','side'),('par_amount','par_amount'),('quoted_settlement_date','value_date'),('original_clean_price','original_clean_price'),('original_consideration_cents','original_consideration_cents'),('raw_recorded_at','raw_recorded_at')]:
            if left=='raw_recorded_at':
                actual=datetime.fromisoformat(x[left].replace('Z','+00:00'));original=datetime.fromisoformat(root[right].replace('Z','+00:00'))
                assert actual.utcoffset()==original.utcoffset()==timedelta(0) and actual==original
            else:assert x[left]==root[right],(left,x[left],root[right])
        assert root['registered'] and h['registered'] and len(h['revisions']) in (1,2,3)
        assert root['definition_version']==VERSIONS[root['instrument_id']]
        sign=1 if root['side']=='BUY' else -1
        par=sign*Fraction(root['par_amount'])
        revisions=h['revisions'];assert [v['revision'] for v in revisions]==list(range(len(revisions)))
        assert revisions[0]['clean_price']==x['original_clean_price']
        assert revisions[0]['consideration_cents']==x['original_consideration_cents']
        assert root['registration_seq']==revisions[0]['posttrade_command_seq']
        for i,v in enumerate(revisions):
            seq=int(v['posttrade_command_seq']);assert seq not in expected
            cash=-sign*int(v['consideration_cents'])
            if i==0: expected[seq]=[leg('REGISTERED',root,cash,par)]
            else:
                prior=-sign*int(revisions[i-1]['consideration_cents'])
                expected[seq]=[leg('COMPENSATE',root,-prior,-par),leg('REPLACEMENT',root,cash,par)]
                adjustments.append(seq)
        current=revisions[-1]
        assert root['current_revision']==current['revision'] and root['active_clean_price']==current['clean_price'] and root['active_consideration_cents']==current['consideration_cents']
        assert root['busted']==(h['bust'] is not None)
        if h['bust']:
            b=h['bust'];seq=int(b['posttrade_command_seq']);assert seq not in expected and b['revision']==current['revision']
            expected[seq]=[leg('BUST',root,sign*int(current['consideration_cents']),-par)]
            adjustments.append(seq)
        outcomes=h['settlement_outcomes'];assert len(outcomes)<=8
        assert sum(o['outcome']=='FAILED' for o in outcomes)<=2
        failed_total+=sum(o['outcome']=='FAILED' for o in outcomes)
        by_revision=defaultdict(list)
        for o in outcomes:
            seq=int(o['posttrade_command_seq']);assert seq not in expected
            assert o['revision']<=current['revision']
            processing.append((seq,o['processing_date']))
            day=date.fromisoformat(o['processing_date'])
            assert day.weekday()<5 and root['value_date']<=o['processing_date']<s['window']['end']
            by_revision[o['revision']].append(o)
            cents=-sign*int(revisions[o['revision']]['consideration_cents'])
            if o['outcome']=='FAILED':
                expected[seq]=[leg('SETTLEMENT_FAILED',root)]
                assert o['reason'] in ('INSUFFICIENT_CASH','INSUFFICIENT_SECURITIES')
            else:
                reverse=o['outcome']=='REVERSED';direction=-1 if reverse else 1
                expected[seq]=[leg('CASH_REVERSED' if reverse else 'CASH_POSTED',root,cash=direction*cents),leg('SECURITY_REVERSED' if reverse else 'SECURITY_POSTED',root,par=direction*par)]
                assert o['reason'] is None
        for revision,rows in by_revision.items():
            settled=[o for o in rows if o['outcome']=='SETTLED'];reversed_rows=[o for o in rows if o['outcome']=='REVERSED']
            assert len(settled)<=1 and len(reversed_rows)<=1
            if reversed_rows:
                assert settled and int(reversed_rows[0]['posttrade_command_seq'])>int(settled[0]['posttrade_command_seq'])
                assert reversed_rows[0]['posting_id']==settled[0]['outcome_id']
            if revision<current['revision'] or root['busted']:
                assert not settled or reversed_rows
        current_outcomes=by_revision.get(current['revision'],[])
        state='VOIDED' if root['busted'] else current_outcomes[-1]['outcome'] if current_outcomes else 'PENDING'
        assert root['settlement_state']==state
    assert sorted(expected)==list(range(1,int(s['posttrade_command_seq'])+1))
    assert int(s['last_adjustment_seq'])==max(adjustments,default=0)
    assert len(events)==sum(len(v) for v in expected.values())
    assert [(int(e['command_seq']),e['event_index']) for e in events]==[(seq,i) for seq in sorted(expected) for i in range(len(expected[seq]))]
    cash=0;securities={i:Fraction(0) for i in IDS};economic_cash=0;economic_par={i:Fraction(0) for i in IDS}
    for e in events:
        want=expected[int(e['command_seq'])][e['event_index']]
        got=(e['event_type'],e['execution_id'],e['definition_version'],int(e['economic_cash_cents']),Fraction(e['economic_par_change']),int(e['available_cash_cents']),Fraction(e['available_par_change']))
        assert got==want,(got,want)
        assert int(e['counterparty_cash_cents'])==-int(e['available_cash_cents'])
        assert Fraction(e['counterparty_par_change'])==-Fraction(e['available_par_change'])
        cash+=int(e['available_cash_cents']);economic_cash+=int(e['economic_cash_cents'])
        if e['execution_id']:
            instrument=roots[e['execution_id']]['instrument_id']
            securities[instrument]+=Fraction(e['available_par_change'])
            economic_par[instrument]+=Fraction(e['economic_par_change'])
        assert cash>=0 and all(v>=0 for v in securities.values())
    assert cash==int(s['available_cash_cents'])
    assert securities=={v['instrument_id']:Fraction(v['available_par']) for v in s['available_securities']}
    active=[root for root in roots.values() if not root['busted']]
    assert economic_cash==sum((-1 if x['side']=='BUY' else 1)*int(x['active_consideration_cents']) for x in active)
    assert economic_par=={i:sum(((1 if x['side']=='BUY' else -1)*Fraction(x['par_amount']) for x in active if x['instrument_id']==i),Fraction(0)) for i in IDS}
    ordered_dates=[d for _,d in sorted(processing)]
    assert ordered_dates==sorted(ordered_dates)
    assert s['processing_date_watermark']==(ordered_dates[-1] if ordered_dates else None)
    oracle=assess({'source':s,'fixture_id':a['curve']['fixture_id'],'as_of_date':a['as_of_date']})
    assert a['source']['source_id']==oracle['source_id'] and a['assessment_id']==oracle['assessment_id'] and a['curve']['snapshot_id']==oracle['curve_snapshot_id']
    assert a['pnl']==oracle['pnl']
    def risk(actual,reference):
        assert actual['pv_usd']==money(Decimal(reference['pv']))
        pairs=[(actual['parallel_dv01_usd'],reference['parallel'])]
        pairs+=list(zip(actual['key_rate_dv01_usd'],reference['keys']))
        pairs+=[(v,reference['stresses'][k]) for k,v in actual['stress_pnl_usd'].items()]
        for observed,wanted in pairs:
            assert abs(Decimal(observed)-Decimal(wanted))<=max(Decimal('.000001'),abs(Decimal(wanted))*Decimal('.00000001'))
    risk(a['risk']['total'],oracle['risk']['total'])
    for row in a['risk']['instruments']:
        risk(row,next(x for x in oracle['risk']['instruments'] if x['instrument_id']==row['instrument_id']))
    return len(events)

if __name__=='__main__':
    raw=sys.stdin.buffer.read(1048577)
    if len(raw)>1048576:raise ValueError('Bounded report input required')
    reports=json.loads(raw)
    if not isinstance(reports,list) or not 1<=len(reports)<=8:raise ValueError('Finite report count required')
    with localcontext() as context:
        context.prec=125;context.rounding=ROUND_HALF_EVEN
        checked=sum(reconstruct(r) for r in reports)
    print(json.dumps({'status':'passed','reports':len(reports),'financial_events_checked':checked},separators=(',',':')))
