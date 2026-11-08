"""Independent owned-source FIFO/equity/risk reconstruction; no application imports."""
from decimal import Decimal, localcontext, ROUND_HALF_EVEN
from fractions import Fraction
from datetime import date
import hashlib,json,sys
from fifo import reconstruct, IDS, VERSIONS
from curves import RATES, OFFSETS, dec, rounded_fraction
from risk import unit_risk, SCENARIOS

def digest(value,sort=True):
    return hashlib.sha256(json.dumps(value,sort_keys=sort,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()

def money(value):
    number=value.quantize(Decimal('.01'),rounding=ROUND_HALF_EVEN)
    return '0.00' if number.is_zero() else format(number,'.2f')

def fraction(pair):
    return Fraction(int(pair[0]),int(pair[1]))

def assess(q):
    if set(q)!={'source','fixture_id','as_of_date'}:
        raise ValueError('Unexpected request')
    s=q['source'];asof=date.fromisoformat(q['as_of_date'])
    if not s['initialized'] or not s['coverage']['complete'] or len(s['roots'])>8:
        raise ValueError('Incomplete owned source')
    if not s['window']['start']<=q['as_of_date']<s['window']['end']:
        raise ValueError('Window')
    active=[]
    for root in s['roots']:
        if not root['registered'] or root['instrument_id'] not in IDS or root['definition_version']!=VERSIONS[root['instrument_id']]:
            raise ValueError('Unsupported/unregistered root')
        if not s['window']['start']<=root['value_date']<s['window']['end'] or date.fromisoformat(root['value_date']).weekday()>4:
            raise ValueError('All-root date/window')
        if root['busted']:
            continue
        if root['value_date']>q['as_of_date']:
            raise ValueError('Before value date')
        active.append(dict(execution_id=root['execution_id'],command_seq=root['command_seq'],instrument_id=root['instrument_id'],
            definition_version=root['definition_version'],side=root['side'],par_amount=root['par_amount'],
            consideration_cents=root['active_consideration_cents'],value_date=root['value_date'],revision=root['current_revision']))
    fifo=reconstruct(active)
    realized=fraction(fifo['realized'])
    positions={r['instrument_id']:fraction(r['signed_par']) for r in fifo['positions']}
    curve_id=digest(dict(version=1,model_version='DISCOUNT_LOG_LINEAR_ACT365F_V1',currency='USD',
        fixture_id=q['fixture_id'],as_of_date=q['as_of_date'],
        nodes=[dict(offset_days=n,zero_rate=format(Decimal(rate),'.12f')) for n,rate in zip(OFFSETS,RATES[q['fixture_id']])]),False)
    source_id=digest(s)
    identity=digest(dict(model='OWNED_PORTFOLIO_ASSESSMENT_V1',source_id=source_id,curve_snapshot_id=curve_id,
        risk='CURVE_DOLLAR_RISK_ACT365F_V1',fifo='FIFO_DIRTY_USD_V1',settlement='SYNTHETIC_GROSS_AGREED_DATE_WEEKDAYS_V1'))
    units={i:unit_risk(q['fixture_id'],i,q['as_of_date']) for i in IDS}
    risks=[]
    for instrument in IDS:
        factor=dec(positions.get(instrument,Fraction(0)))/100
        pv,parallel,keys,stresses=units[instrument]
        risks.append(dict(instrument_id=instrument,pv=pv*factor,parallel=parallel*factor,
            keys=[k*factor for k in keys],stresses={name:value*factor for name,value in stresses.items()}))
    pv=sum((r['pv'] for r in risks),Decimal(0))
    total=dict(pv=str(pv),parallel=str(sum((r['parallel'] for r in risks),Decimal(0))),
        keys=[str(sum((r['keys'][i] for r in risks),Decimal(0))) for i in range(4)],
        stresses={name:str(sum((r['stresses'][name] for r in risks),Decimal(0))) for name in SCENARIOS})
    unrealized=Decimal(0)
    lots=[]
    for lot in fifo['lots']:
        quantity=fraction(lot['remaining_par']);basis=fraction(lot['remaining_basis_or_proceeds_usd'])
        mark=units[lot['instrument_id']][0]*dec(quantity)/100
        unrealized+=(mark-dec(basis)) if lot['side']=='LONG' else (dec(basis)-mark)
        lots.append(dict(opening_execution_id=lot['opening_execution_id'],instrument_id=lot['instrument_id'],side=lot['side'],
            remaining_par=rounded_fraction(quantity),
            remaining_basis_or_proceeds_exact_usd=dict(numerator=str(basis.numerator),denominator=str(basis.denominator))))
    cash=Fraction(int(s['available_cash_cents']),100);opening=Fraction(int(s['opening_cash_cents']),100)
    unsettled=Fraction(0);expected_cash=opening;expected_par={i:Fraction(0) for i in IDS}
    for root in s['roots']:
        if root['busted']:
            continue
        direction=1 if root['side']=='BUY' else -1
        economic_cash=-direction*Fraction(int(root['active_consideration_cents']),100)
        if root['settlement_state']=='SETTLED':
            expected_cash+=economic_cash;expected_par[root['instrument_id']]+=direction*Fraction(root['par_amount'])
        else:
            unsettled+=economic_cash
    assert cash==expected_cash
    for account in s['available_securities']:
        assert Fraction(account['available_par'])==expected_par[account['instrument_id']]
    pnl=dec(realized)+unrealized;equity=dec(cash+unsettled)+pv
    assert abs(equity-dec(opening)-pnl)<Decimal('1e-100')
    rw=rounded_fraction(realized);uw=money(unrealized);pw=money(pnl)
    for r in risks:
        r['pv']=str(r['pv']);r['parallel']=str(r['parallel']);r['keys']=[str(n) for n in r['keys']]
        r['stresses']={name:str(value) for name,value in r['stresses'].items()}
    return dict(source_id=source_id,curve_snapshot_id=curve_id,assessment_id=identity,risk=dict(total=total,instruments=risks),
        pnl=dict(opening_cash_usd=rounded_fraction(opening),available_cash_usd=rounded_fraction(cash),
        signed_unsettled_cash_usd=rounded_fraction(unsettled),economic_security_mark_usd=money(pv),equity_usd=money(equity),
        realized_pnl_usd=rw,realized_pnl_exact_usd=dict(numerator=str(realized.numerator),denominator=str(realized.denominator)),
        unrealized_pnl_usd=uw,total_pnl_usd=pw,presentation_rounding_delta_usd=rounded_fraction(Fraction(pw)-Fraction(rw)-Fraction(uw)),
        available_securities=[dict(instrument_id=r['instrument_id'],available_par=rounded_fraction(Fraction(r['available_par']))) for r in s['available_securities']],
        lots=lots))

if __name__=='__main__':
    raw=sys.stdin.buffer.read(1048577)
    if len(raw)>1048576:
        raise ValueError('Input bound')
    requests=json.loads(raw)
    if not isinstance(requests,list) or not 1<=len(requests)<=64:
        raise ValueError('Finite request bound')
    with localcontext() as context:
        context.prec=125;context.rounding=ROUND_HALF_EVEN
        print(json.dumps([assess(q) for q in requests],separators=(',',':')))
