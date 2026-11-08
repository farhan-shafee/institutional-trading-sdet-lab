"""Independent finite original-profile quote/cash oracle (Decimal125 + Fraction)."""
from datetime import date
from decimal import Decimal, localcontext, ROUND_FLOOR, ROUND_CEILING
from fractions import Fraction
import json, sys

DATES = ('2025-01-15','2025-02-28','2028-02-29','2030-01-15','2030-07-14','2031-01-14')
PARS = ('0.01','1.25','1.75','1000000000.00')

def accrual(profile, value_date):
    d = date.fromisoformat(value_date)
    if d < date(d.year,1,15):
        before, after = date(d.year-1,7,15), date(d.year,1,15)
    elif d < date(d.year,7,15):
        before, after = date(d.year,1,15), date(d.year,7,15)
    else:
        before, after = date(d.year,7,15), date(d.year+1,1,15)
    if profile == 'phase1-ust-1':
        elapsed, period = (d-before).days, (after-before).days
    else:
        elapsed = 360*(d.year-before.year)+30*(d.month-before.month)+d.day-before.day
        period = 180
    count = 1 + ((2031-after.year)*12+1-after.month)//6
    return elapsed, period, count

def boundaries(profile, value_date):
    elapsed, period, count = accrual(profile, value_date)
    with localcontext() as context:
        context.prec = 125
        times = [Decimal(i)+Decimal(period-elapsed)/Decimal(period) for i in range(count)]
        cash = [Decimal(2)]*(count-1)+[Decimal(102)]
        prices = []
        for y in (Decimal(1), Decimal('-0.1')):
            base = 1+y/2
            prices.append(sum((c/base**t for c,t in zip(cash,times)),Decimal(0))-Decimal(2)*elapsed/period)
        return tuple(prices)

def result(profile, value_date, par, quote):
    elapsed, period, _ = accrual(profile, value_date)
    cash = Fraction(par)*(Fraction(quote)+Fraction(2*elapsed,period))
    q, r = divmod(cash.numerator,cash.denominator)
    cents = q + int(2*r>cash.denominator or (2*r==cash.denominator and q%2==1))
    low, high = boundaries(profile,value_date)
    with localcontext() as context:
        context.prec=125
        valid = low-Decimal('0.00000000005') <= Decimal(quote) <= high+Decimal('0.00000000005')
    return dict(profile=profile,value_date=value_date,par=par,quote=quote,
                elapsed=elapsed,period=period,cents=str(cents),valid=valid)

def main():
    request = json.loads(sys.stdin.buffer.read(1048577))
    if request != {'generate': True}:
        raise ValueError('Expected the finite generated fixture request.')
    cases = []
    for profile in ('phase1-ust-1','phase1-corp-1'):
        for value_date in DATES:
            for par in PARS:
                for quote in ('5.000000000000','100.000000000000','102.000000000000'):
                    cases.append(result(profile,value_date,par,quote))
            low, high = boundaries(profile,value_date)
            with localcontext() as context:
                context.prec=125
                for boundary, rounding, offsets in (
                    (low,ROUND_FLOOR,(-51,-50,-49)),
                    (high,ROUND_CEILING,(49,50,51)),
                ):
                    scaled = (boundary*10**12).to_integral_value(rounding=rounding)
                    for offset in offsets:
                        quote = format((scaled+offset)/10**12,'.12f')
                        cases.append(result(profile,value_date,'100.00',quote))
    if len(cases)!=216:
        raise AssertionError('Finite fixture coverage drift.')
    print(json.dumps(cases,separators=(',',':')))

if __name__ == '__main__':
    main()
